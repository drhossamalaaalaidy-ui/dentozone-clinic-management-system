import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import {
  db, auditLogTable, patientsTable, prescriptionAmendmentsTable, prescriptionsTable,
  staffTable, visitsTable,
} from "@workspace/db";
import { z } from "zod";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";

const router: IRouter = Router();
const clinicalRead = allowRoles("owner", "manager", "dentist", "assistant");
const clinicalWrite = allowRoles("owner", "dentist");
const positiveId = z.coerce.number().int().positive();

const medicationFieldsSchema = z.object({
  medication: z.string().trim().min(1).max(200),
  dose: z.string().trim().min(1).max(120),
  route: z.string().trim().min(1).max(80),
  frequency: z.string().trim().min(1).max(120),
  duration: z.string().trim().min(1).max(120),
  instructions: z.string().trim().max(2000),
});
const prescriptionInput = medicationFieldsSchema.extend({
  patientId: positiveId,
  visitId: positiveId.optional(),
  authorDentistStaffId: positiveId.optional(),
  issuedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) =>
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value),
});
const correctionInput = z.object({
  amendmentType: z.literal("correction"),
  reason: z.string().trim().min(3).max(1000),
  replacement: medicationFieldsSchema,
});
const voidInput = z.object({
  amendmentType: z.literal("void"),
  reason: z.string().trim().min(3).max(1000),
});

type PrescriptionFields = z.infer<typeof medicationFieldsSchema>;

async function prescriptionDto(id: number) {
  const [record] = await db.select({
    id: prescriptionsTable.id,
    patientId: prescriptionsTable.patientId,
    patientName: patientsTable.fullName,
    visitId: prescriptionsTable.visitId,
    authorDentistStaffId: prescriptionsTable.authorDentistStaffId,
    authorDentistName: staffTable.name,
    createdByStaffId: prescriptionsTable.createdByStaffId,
    medication: prescriptionsTable.medication,
    dose: prescriptionsTable.dose,
    route: prescriptionsTable.route,
    frequency: prescriptionsTable.frequency,
    duration: prescriptionsTable.duration,
    instructions: prescriptionsTable.instructions,
    issuedDate: prescriptionsTable.issuedDate,
    createdAt: prescriptionsTable.createdAt,
    isDemo: prescriptionsTable.isDemo,
  }).from(prescriptionsTable)
    .innerJoin(patientsTable, eq(patientsTable.id, prescriptionsTable.patientId))
    .innerJoin(staffTable, eq(staffTable.id, prescriptionsTable.authorDentistStaffId))
    .where(eq(prescriptionsTable.id, id));
  if (!record) return null;
  const amendments = await db.select({
    id: prescriptionAmendmentsTable.id,
    amendmentType: prescriptionAmendmentsTable.amendmentType,
    reason: prescriptionAmendmentsTable.reason,
    amendedByStaffId: prescriptionAmendmentsTable.amendedByStaffId,
    amendedByName: staffTable.name,
    createdAt: prescriptionAmendmentsTable.createdAt,
    replacement: prescriptionAmendmentsTable.replacement,
  }).from(prescriptionAmendmentsTable)
    .innerJoin(staffTable, eq(staffTable.id, prescriptionAmendmentsTable.amendedByStaffId))
    .where(eq(prescriptionAmendmentsTable.prescriptionId, id))
    .orderBy(asc(prescriptionAmendmentsTable.id));

  const correction = [...amendments].reverse().find((amendment) =>
    amendment.amendmentType === "correction");
  const status = amendments.some((amendment) => amendment.amendmentType === "void")
    ? "void"
    : correction ? "corrected" : "issued";
  const original: PrescriptionFields = {
    medication: record.medication,
    dose: record.dose,
    route: record.route,
    frequency: record.frequency,
    duration: record.duration,
    instructions: record.instructions,
  };
  return {
    ...record,
    ...((status !== "void" && correction?.replacement) || {}),
    original,
    status,
    amendments,
    createdAt: record.createdAt.toISOString(),
  };
}

router.get("/patients/:patientId/prescriptions", clinicalRead, async (req, res): Promise<void> => {
  const patientId = positiveId.safeParse(req.params.patientId);
  if (!patientId.success) {
    res.status(400).json({ error: "Invalid patient id" });
    return;
  }
  const [patient] = await db.select({ id: patientsTable.id }).from(patientsTable)
    .where(eq(patientsTable.id, patientId.data));
  if (!patient) {
    res.status(404).json({ error: "Patient not found" });
    return;
  }
  const records = await db.select({ id: prescriptionsTable.id }).from(prescriptionsTable)
    .where(eq(prescriptionsTable.patientId, patient.id)).orderBy(asc(prescriptionsTable.id));
  res.json(await Promise.all(records.map((record) => prescriptionDto(record.id))));
});

router.post("/patients/:patientId/prescriptions", clinicalWrite, async (req, res): Promise<void> => {
  const patientId = positiveId.safeParse(req.params.patientId);
  const parsed = prescriptionInput.safeParse({ ...req.body, patientId: req.params.patientId });
  if (!patientId.success || !parsed.success) {
    res.status(400).json({ error: parsed.success ? "Invalid patient id" : parsed.error.message });
    return;
  }
  const actor = currentStaff(res);
  const created = await db.transaction(async (tx) => {
    const [patient] = await tx.select().from(patientsTable)
      .where(eq(patientsTable.id, patientId.data));
    if (!patient) return { error: "patient" as const };
    if (patient.status !== "active") return { error: "inactive" as const };

    if (parsed.data.visitId) {
      const [visit] = await tx.select({ id: visitsTable.id })
        .from(visitsTable).where(and(
          eq(visitsTable.id, parsed.data.visitId),
          eq(visitsTable.patientId, patient.id),
        ));
      if (!visit) return { error: "visit" as const };
    }

    const authorId = actor.role === "dentist"
      ? actor.id
      : parsed.data.authorDentistStaffId;
    if (!authorId || (actor.role === "dentist" && parsed.data.authorDentistStaffId
      && parsed.data.authorDentistStaffId !== actor.id)) {
      return { error: "author" as const };
    }
    const [author] = await tx.select({ id: staffTable.id }).from(staffTable)
      .where(and(
        eq(staffTable.id, authorId),
        eq(staffTable.role, "dentist"),
        eq(staffTable.status, "active"),
      ));
    if (!author) return { error: "author" as const };

    const [prescription] = await tx.insert(prescriptionsTable).values({
      patientId: patient.id,
      visitId: parsed.data.visitId ?? null,
      authorDentistStaffId: author.id,
      createdByStaffId: actor.id,
      medication: parsed.data.medication,
      dose: parsed.data.dose,
      route: parsed.data.route,
      frequency: parsed.data.frequency,
      duration: parsed.data.duration,
      instructions: parsed.data.instructions,
      issuedDate: parsed.data.issuedDate,
      isDemo: patient.isDemo,
    }).returning();
    await tx.insert(auditLogTable).values({
      actorStaffId: actor.id,
      actorName: actor.name,
      action: "create",
      entityType: "prescription",
      entityId: prescription.id,
      summary: `Prescription ${prescription.id} issued for patient ${patient.id}`,
    });
    return { id: prescription.id };
  });
  if ("error" in created) {
    switch (created.error) {
      case "patient":
        res.status(404).json({ error: "Patient not found" });
        break;
      case "inactive":
        res.status(409).json({ error: "Patient is inactive" });
        break;
      case "visit":
        res.status(404).json({ error: "Visit not found for this patient" });
        break;
      case "author":
        res.status(400).json({ error: "An active dentist author is required" });
        break;
    }
    return;
  }
  res.status(201).json(await prescriptionDto(created.id));
});

router.get("/prescriptions/:prescriptionId", clinicalRead, async (req, res): Promise<void> => {
  const id = positiveId.safeParse(req.params.prescriptionId);
  if (!id.success) {
    res.status(400).json({ error: "Invalid prescription id" });
    return;
  }
  const prescription = await prescriptionDto(id.data);
  if (!prescription) {
    res.status(404).json({ error: "Prescription not found" });
    return;
  }
  res.json(prescription);
});

router.post("/prescriptions/:prescriptionId/amendments", clinicalWrite, async (req, res): Promise<void> => {
  const id = positiveId.safeParse(req.params.prescriptionId);
  const parsed = req.body?.amendmentType === "void"
    ? voidInput.safeParse(req.body)
    : correctionInput.safeParse(req.body);
  if (!id.success || !parsed.success) {
    res.status(400).json({ error: parsed.success ? "Invalid prescription id" : parsed.error.message });
    return;
  }
  const actor = currentStaff(res);
  const amendment = await db.transaction(async (tx) => {
    const [record] = await tx.select().from(prescriptionsTable)
      .for("update")
      .where(eq(prescriptionsTable.id, id.data));
    if (!record) return { error: "missing" as const };
    const [previousVoid] = await tx.select({ id: prescriptionAmendmentsTable.id })
      .from(prescriptionAmendmentsTable).where(and(
        eq(prescriptionAmendmentsTable.prescriptionId, id.data),
        eq(prescriptionAmendmentsTable.amendmentType, "void"),
      ));
    if (previousVoid) return { error: "void" as const };
    const [added] = await tx.insert(prescriptionAmendmentsTable).values({
      prescriptionId: id.data,
      amendedByStaffId: actor.id,
      amendmentType: parsed.data.amendmentType,
      reason: parsed.data.reason,
      replacement: parsed.data.amendmentType === "correction" ? parsed.data.replacement : null,
    }).returning();
    await tx.insert(auditLogTable).values({
      actorStaffId: actor.id,
      actorName: actor.name,
      action: parsed.data.amendmentType,
      entityType: "prescription",
      entityId: id.data,
      summary: `Prescription ${id.data} ${parsed.data.amendmentType} amendment ${added.id} recorded`,
    });
    return { id: added.id };
  });
  if ("error" in amendment) {
    res.status(amendment.error === "missing" ? 404 : 409).json({
      error: amendment.error === "missing" ? "Prescription not found" : "A void prescription cannot be amended",
    });
    return;
  }
  res.status(201).json(await prescriptionDto(id.data));
});

export default router;