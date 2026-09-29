import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLogTable, db, patientDocumentsTable, patientsTable, visitsTable,
  type PatientDocument,
} from "@workspace/db";
import {
  CompletePatientDocumentUploadBody, CompletePatientDocumentUploadParams,
  CompletePatientDocumentUploadResponse, DownloadPatientDocumentParams,
  ListPatientDocumentsParams, ListPatientDocumentsResponse,
  RequestPatientDocumentUploadBody, RequestPatientDocumentUploadParams,
  RequestPatientDocumentUploadResponse, UpdatePatientDocumentStatusBody,
  UpdatePatientDocumentStatusParams, UpdatePatientDocumentStatusResponse,
} from "@workspace/api-zod";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";
import { getPrivateUploadUrl, newPrivateDocumentKey, newSealedDocumentKey, promotePrivateUpload, sendPrivateDocument } from "../lib/privateDocuments";

const router: IRouter = Router();
const reader = allowRoles("owner", "manager", "dentist", "assistant");
const writer = allowRoles("owner", "dentist");
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const safeBody = (body: unknown, keys: string[]) =>
  body !== null && typeof body === "object" && !Array.isArray(body)
  && Object.keys(body).every((key) => keys.includes(key));

function dto(row: PatientDocument) {
  return {
    ...row,
    signedAt: row.signedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function audit(actor: ReturnType<typeof currentStaff>, action: string, id: number, summary: string) {
  return {
    actorStaffId: actor.id, actorName: actor.name,
    action, entityType: "patient_document", entityId: id, summary,
  };
}

router.get("/patients/:patientId/documents", reader, async (req, res): Promise<void> => {
  const params = ListPatientDocumentsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid patient ID" }); return; }
  const [patient] = await db.select({ id: patientsTable.id }).from(patientsTable)
    .where(eq(patientsTable.id, params.data.patientId));
  if (!patient) { res.status(404).json({ error: "Patient not found" }); return; }
  const docs = await db.select().from(patientDocumentsTable)
    .where(eq(patientDocumentsTable.patientId, patient.id))
    .orderBy(sql`${patientDocumentsTable.createdAt} DESC, ${patientDocumentsTable.id} DESC`);
  res.json(ListPatientDocumentsResponse.parse(docs.map(dto)));
});

router.post("/patients/:patientId/documents/upload-request", writer, async (req, res): Promise<void> => {
  const params = RequestPatientDocumentUploadParams.safeParse(req.params);
  const parsed = RequestPatientDocumentUploadBody.safeParse(req.body);
  if (!params.success || !parsed.success || !safeBody(req.body, ["visitId", "kind", "filename", "contentType", "sizeBytes", "signedAt"])) {
    res.status(400).json({ error: "Invalid document metadata" });
    return;
  }
  const input = parsed.data;
  const filename = input.filename.trim();
  if (!filename || filename === "." || filename === ".." || /[/\\\0]/.test(filename)
    || input.sizeBytes > MAX_FILE_BYTES || !Number.isSafeInteger(input.sizeBytes)
    || (input.signedAt && input.kind !== "consent")) {
    res.status(400).json({ error: "Invalid filename, document size, or consent date" });
    return;
  }
  const signedAt = input.signedAt ? new Date(input.signedAt) : null;
  if (signedAt && (!Number.isFinite(signedAt.getTime()) || signedAt > new Date())) {
    res.status(400).json({ error: "Consent date must not be in the future" });
    return;
  }
  const [patient] = await db.select().from(patientsTable).where(eq(patientsTable.id, params.data.patientId));
  if (!patient || patient.status === "archived") {
    res.status(404).json({ error: "Active patient not found" });
    return;
  }
  if (input.visitId) {
    const [visit] = await db.select({ patientId: visitsTable.patientId }).from(visitsTable)
      .where(eq(visitsTable.id, input.visitId));
    if (!visit || visit.patientId !== patient.id) {
      res.status(400).json({ error: "Visit does not belong to this patient" });
      return;
    }
  }
  const objectKey = newPrivateDocumentKey();
  const uploadURL = await getPrivateUploadUrl(objectKey);
  const actor = currentStaff(res);
  const document = await db.transaction(async (tx) => {
    const [saved] = await tx.insert(patientDocumentsTable).values({
      patientId: patient.id,
      visitId: input.visitId ?? null,
      kind: input.kind,
      filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      signedAt,
      objectKey,
      createdByStaffId: actor.id,
      isDemo: patient.isDemo,
    }).returning();
    await tx.insert(auditLogTable).values(audit(actor, "create", saved.id,
      `Document upload requested for patient ${patient.id}`));
    return saved;
  });
  res.status(201).json(RequestPatientDocumentUploadResponse.parse({ uploadURL, document: dto(document) }));
});

router.post("/patients/:patientId/documents/:documentId/complete", writer, async (req, res): Promise<void> => {
  const params = CompletePatientDocumentUploadParams.safeParse(req.params);
  const parsed = CompletePatientDocumentUploadBody.safeParse(req.body ?? {});
  if (!params.success || !parsed.success || !safeBody(req.body ?? {}, ["checksumSha256"])) {
    res.status(400).json({ error: "Invalid document completion request" });
    return;
  }
  const [document] = await db.select().from(patientDocumentsTable).where(and(
    eq(patientDocumentsTable.id, params.data.documentId),
    eq(patientDocumentsTable.patientId, params.data.patientId),
  ));
  if (!document) { res.status(404).json({ error: "Document not found" }); return; }
  if (document.status !== "pending") {
    res.status(409).json({ error: "Only pending uploads can be completed" });
    return;
  }
  const sealedKey = newSealedDocumentKey();
  if (!await promotePrivateUpload(document.objectKey, sealedKey, document.sizeBytes, document.contentType, parsed.data.checksumSha256)) {
    res.status(409).json({ error: "Uploaded bytes are missing or do not match the document metadata" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(patientDocumentsTable)
      .where(eq(patientDocumentsTable.id, document.id)).for("update");
    if (current.status !== "pending") return null;
    const [saved] = await tx.update(patientDocumentsTable)
      .set({ status: "active", objectKey: sealedKey, updatedByStaffId: actor.id, updatedAt: new Date() })
      .where(eq(patientDocumentsTable.id, current.id)).returning();
    await tx.insert(auditLogTable).values(audit(actor, "complete", saved.id,
      `Document ${saved.id} upload verified`));
    return saved;
  });
  if (!outcome) { res.status(409).json({ error: "Document was already completed" }); return; }
  res.json(CompletePatientDocumentUploadResponse.parse(dto(outcome)));
});

router.get("/patients/:patientId/documents/:documentId/file", reader, async (req, res): Promise<void> => {
  const params = DownloadPatientDocumentParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid document ID" }); return; }
  const [document] = await db.select().from(patientDocumentsTable).where(and(
    eq(patientDocumentsTable.id, params.data.documentId),
    eq(patientDocumentsTable.patientId, params.data.patientId),
    eq(patientDocumentsTable.status, "active"),
  ));
  if (!document) { res.status(404).json({ error: "Document unavailable" }); return; }
  await sendPrivateDocument(document.objectKey, document.filename, document.contentType, res);
});

router.patch("/patients/:patientId/documents/:documentId", writer, async (req, res): Promise<void> => {
  const params = UpdatePatientDocumentStatusParams.safeParse(req.params);
  const parsed = UpdatePatientDocumentStatusBody.safeParse(req.body);
  if (!params.success || !parsed.success || !safeBody(req.body, ["status"])) {
    res.status(400).json({ error: "Invalid document update" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(patientDocumentsTable).where(and(
      eq(patientDocumentsTable.id, params.data.documentId),
      eq(patientDocumentsTable.patientId, params.data.patientId),
    )).for("update");
    if (!current) return { error: "not_found" as const };
    const validTransition = (current.status === "active" && parsed.data.status === "withdrawn")
      || (current.status === "withdrawn" && parsed.data.status === "active");
    if (!validTransition) {
      return { error: "invalid_transition" as const };
    }
    const [saved] = await tx.update(patientDocumentsTable)
      .set({ status: parsed.data.status, updatedByStaffId: actor.id, updatedAt: new Date() })
      .where(eq(patientDocumentsTable.id, current.id)).returning();
    const action = saved.status === "withdrawn" ? "withdraw" : "restore";
    const summary = saved.status === "withdrawn"
      ? `Document ${saved.id} withdrawn; original file retained privately for the audit record`
      : `Document ${saved.id} restored; original private file retained without re-upload`;
    await tx.insert(auditLogTable).values(audit(actor, action, saved.id, summary));
    return { document: saved };
  });
  if ("error" in outcome) {
    res.status(outcome.error === "not_found" ? 404 : 409).json({
      error: outcome.error === "not_found" ? "Document not found" : "Only active documents can be withdrawn and only withdrawn documents can be restored",
    });
    return;
  }
  res.json(UpdatePatientDocumentStatusResponse.parse(dto(outcome.document)));
});

export default router;