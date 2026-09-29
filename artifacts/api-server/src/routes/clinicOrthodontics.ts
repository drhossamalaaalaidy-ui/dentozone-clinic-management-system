import { Router, type IRouter } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  AddOrthodonticCaseProgressBody, AddOrthodonticCaseProgressParams, AddOrthodonticCaseProgressResponse,
  CreateOrthodonticCaseBody, CreateOrthodonticCaseParams, CreateOrthodonticCaseResponse,
  GetOrthodonticCaseParams, GetOrthodonticCaseResponse,
  ListPatientOrthodonticCasesParams, ListPatientOrthodonticCasesResponse,
  UpdateOrthodonticCaseBody, UpdateOrthodonticCaseParams, UpdateOrthodonticCaseResponse,
} from "@workspace/api-zod";
import {
  auditLogTable, db, orthodonticCasesTable, orthodonticProgressTable, patientsTable, staffTable, visitsTable,
} from "@workspace/db";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";

const router: IRouter = Router();
const clinicalRead = allowRoles("owner", "manager", "dentist", "assistant");
const clinicalWrite = allowRoles("owner", "dentist");

function auditValues(actor: ReturnType<typeof currentStaff>, action: string, entityId: number, summary: string) {
  return {
    actorStaffId: actor.id,
    actorName: actor.name,
    action,
    entityType: "orthodontic_case",
    entityId,
    summary,
  };
}

function hasOnlyKeys(value: unknown, keys: string[]): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

function validText(value: string): boolean {
  return value.trim().length > 0;
}

async function caseDto(caseId: number) {
  const [orthodonticCase] = await db.select().from(orthodonticCasesTable)
    .where(eq(orthodonticCasesTable.id, caseId));
  if (!orthodonticCase) return null;
  const progress = await db.select().from(orthodonticProgressTable)
    .where(eq(orthodonticProgressTable.caseId, caseId))
    .orderBy(asc(orthodonticProgressTable.recordedAt), asc(orthodonticProgressTable.id));
  return { ...orthodonticCase, progress };
}

router.get("/patients/:patientId/orthodontic-cases", clinicalRead, async (req, res): Promise<void> => {
  const params = ListPatientOrthodonticCasesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [patient] = await db.select({ id: patientsTable.id }).from(patientsTable)
    .where(eq(patientsTable.id, params.data.patientId));
  if (!patient) {
    res.status(404).json({ error: "Patient not found" });
    return;
  }
  const cases = await db.select().from(orthodonticCasesTable)
    .where(eq(orthodonticCasesTable.patientId, patient.id))
    .orderBy(desc(orthodonticCasesTable.createdAt), desc(orthodonticCasesTable.id));
  const progressRows = cases.length
    ? await db.select().from(orthodonticProgressTable)
      .where(inArray(orthodonticProgressTable.caseId, cases.map((item) => item.id)))
      .orderBy(asc(orthodonticProgressTable.recordedAt), asc(orthodonticProgressTable.id))
    : [];
  const progressByCase = new Map<number, typeof progressRows>();
  for (const entry of progressRows) {
    const entries = progressByCase.get(entry.caseId) ?? [];
    entries.push(entry);
    progressByCase.set(entry.caseId, entries);
  }
  res.json(ListPatientOrthodonticCasesResponse.parse(cases.map((item) => ({
    ...item,
    progress: progressByCase.get(item.id) ?? [],
  }))));
});

router.post("/patients/:patientId/orthodontic-cases", clinicalWrite, async (req, res): Promise<void> => {
  const params = CreateOrthodonticCaseParams.safeParse(req.params);
  const bodyKeys = ["title", "goal", "appliance", "doctorStaffId", "status", "nextReviewAt"];
  const parsed = hasOnlyKeys(req.body, bodyKeys) ? CreateOrthodonticCaseBody.safeParse(req.body) : null;
  if (!params.success || !parsed?.success) {
    res.status(400).json({ error: !params.success ? params.error.message
      : parsed && !parsed.success ? parsed.error.message : "Unexpected field in orthodontic case input" });
    return;
  }
  if (![parsed.data.title, parsed.data.goal, parsed.data.appliance].every(validText)) {
    res.status(400).json({ error: "Title, goal, and appliance must not be empty" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [patient] = await tx.select().from(patientsTable)
      .where(eq(patientsTable.id, params.data.patientId));
    if (!patient) return { error: "not_found" as const };
    if (patient.status !== "active") return { error: "inactive" as const };
    const [doctor] = await tx.select().from(staffTable).where(eq(staffTable.id, parsed.data.doctorStaffId));
    if (!doctor || doctor.status !== "active" || !["owner", "dentist"].includes(doctor.role)) {
      return { error: "invalid_doctor" as const };
    }
    const [created] = await tx.insert(orthodonticCasesTable).values({
      patientId: patient.id,
      title: parsed.data.title.trim(),
      goal: parsed.data.goal.trim(),
      appliance: parsed.data.appliance.trim(),
      doctorStaffId: doctor.id,
      status: parsed.data.status ?? "active",
      nextReviewAt: parsed.data.nextReviewAt ?? null,
      isDemo: patient.isDemo,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "create", created.id,
      `Orthodontic case ${created.id} created for patient ${patient.id}`));
    return { caseId: created.id };
  });
  if ("error" in outcome) {
    const status = outcome.error === "not_found" ? 404 : outcome.error === "invalid_doctor" ? 400 : 409;
    res.status(status).json({ error: outcome.error === "not_found" ? "Patient not found"
      : outcome.error === "invalid_doctor" ? "Assigned doctor must be an active owner or dentist"
        : "Patient is inactive" });
    return;
  }
  const dto = await caseDto(outcome.caseId);
  res.status(201).json(CreateOrthodonticCaseResponse.parse(dto));
});

router.get("/orthodontic-cases/:caseId", clinicalRead, async (req, res): Promise<void> => {
  const params = GetOrthodonticCaseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dto = await caseDto(params.data.caseId);
  if (!dto) {
    res.status(404).json({ error: "Orthodontic case not found" });
    return;
  }
  res.json(GetOrthodonticCaseResponse.parse(dto));
});

router.patch("/orthodontic-cases/:caseId", clinicalWrite, async (req, res): Promise<void> => {
  const params = UpdateOrthodonticCaseParams.safeParse(req.params);
  const bodyKeys = ["title", "goal", "appliance", "doctorStaffId", "status", "nextReviewAt"];
  const parsed = hasOnlyKeys(req.body, bodyKeys) ? UpdateOrthodonticCaseBody.safeParse(req.body) : null;
  if (!params.success || !parsed?.success) {
    res.status(400).json({ error: !params.success ? params.error.message
      : parsed && !parsed.success ? parsed.error.message : "Unexpected field in orthodontic case update" });
    return;
  }
  if (!Object.keys(parsed.data).length
    || (parsed.data.title !== undefined && !validText(parsed.data.title))
    || (parsed.data.goal !== undefined && !validText(parsed.data.goal))
    || (parsed.data.appliance !== undefined && !validText(parsed.data.appliance))) {
    res.status(400).json({ error: "Provide at least one change; text fields must not be empty" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(orthodonticCasesTable)
      .where(eq(orthodonticCasesTable.id, params.data.caseId))
      .for("update");
    if (!existing) return { error: "not_found" as const };
    if (actor.role !== "owner" && existing.doctorStaffId !== actor.id) return { error: "forbidden" as const };
    const [patient] = await tx.select().from(patientsTable)
      .where(eq(patientsTable.id, existing.patientId));
    if (!patient || patient.status !== "active") return { error: "inactive" as const };
    if (parsed.data.doctorStaffId !== undefined) {
      const [doctor] = await tx.select().from(staffTable)
        .where(eq(staffTable.id, parsed.data.doctorStaffId));
      if (!doctor || doctor.status !== "active" || !["owner", "dentist"].includes(doctor.role)) {
        return { error: "invalid_doctor" as const };
      }
    }
    const [updated] = await tx.update(orthodonticCasesTable).set({
      ...(parsed.data.title !== undefined ? { title: parsed.data.title.trim() } : {}),
      ...(parsed.data.goal !== undefined ? { goal: parsed.data.goal.trim() } : {}),
      ...(parsed.data.appliance !== undefined ? { appliance: parsed.data.appliance.trim() } : {}),
      ...(parsed.data.doctorStaffId !== undefined ? { doctorStaffId: parsed.data.doctorStaffId } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.nextReviewAt !== undefined ? { nextReviewAt: parsed.data.nextReviewAt } : {}),
      updatedAt: new Date(),
    }).where(eq(orthodonticCasesTable.id, existing.id)).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "update", updated.id,
      `Orthodontic case ${updated.id} updated`));
    return { caseId: updated.id };
  });
  if ("error" in outcome) {
    const status = outcome.error === "not_found" ? 404 : outcome.error === "forbidden" ? 403
      : outcome.error === "invalid_doctor" ? 400 : 409;
    res.status(status).json({ error: outcome.error === "not_found" ? "Orthodontic case not found"
      : outcome.error === "forbidden" ? "Only the assigned doctor or an owner may update this case"
        : outcome.error === "invalid_doctor" ? "Assigned doctor must be an active owner or dentist"
          : "Patient is inactive" });
    return;
  }
  const dto = await caseDto(outcome.caseId);
  res.json(UpdateOrthodonticCaseResponse.parse(dto));
});

router.post("/orthodontic-cases/:caseId/progress", clinicalWrite, async (req, res): Promise<void> => {
  const params = AddOrthodonticCaseProgressParams.safeParse(req.params);
  const bodyKeys = ["note", "phase", "visitId", "nextReviewAt"];
  const parsed = hasOnlyKeys(req.body, bodyKeys) ? AddOrthodonticCaseProgressBody.safeParse(req.body) : null;
  if (!params.success || !parsed?.success) {
    res.status(400).json({ error: !params.success ? params.error.message
      : parsed && !parsed.success ? parsed.error.message : "Unexpected field in orthodontic progress input" });
    return;
  }
  if (!validText(parsed.data.note) || !validText(parsed.data.phase)) {
    res.status(400).json({ error: "Progress note and phase must not be empty" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [orthodonticCase] = await tx.select().from(orthodonticCasesTable)
      .where(eq(orthodonticCasesTable.id, params.data.caseId))
      .for("update");
    if (!orthodonticCase) return { error: "not_found" as const };
    if (actor.role !== "owner" && orthodonticCase.doctorStaffId !== actor.id) return { error: "forbidden" as const };
    const [patient] = await tx.select().from(patientsTable)
      .where(eq(patientsTable.id, orthodonticCase.patientId));
    if (!patient || patient.status !== "active") return { error: "inactive" as const };
    if (parsed.data.visitId != null) {
      const [visit] = await tx.select({ id: visitsTable.id, patientId: visitsTable.patientId })
        .from(visitsTable).where(eq(visitsTable.id, parsed.data.visitId));
      if (!visit) return { error: "visit_not_found" as const };
      if (visit.patientId !== orthodonticCase.patientId) return { error: "visit_mismatch" as const };
    }
    const [entry] = await tx.insert(orthodonticProgressTable).values({
      caseId: orthodonticCase.id,
      note: parsed.data.note.trim(),
      phase: parsed.data.phase.trim(),
      visitId: parsed.data.visitId ?? null,
      nextReviewAt: parsed.data.nextReviewAt ?? null,
      authorStaffId: actor.id,
      isDemo: patient.isDemo,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "create", entry.id,
      `Orthodontic progress ${entry.id} recorded for case ${orthodonticCase.id}`));
    return { entry };
  });
  if ("error" in outcome) {
    const status = outcome.error === "not_found" || outcome.error === "visit_not_found" ? 404
      : outcome.error === "forbidden" ? 403 : 409;
    res.status(status).json({ error: outcome.error === "not_found" ? "Orthodontic case not found"
      : outcome.error === "visit_not_found" ? "Visit not found"
        : outcome.error === "forbidden" ? "Only the assigned doctor or an owner may record progress"
          : outcome.error === "visit_mismatch" ? "Visit does not belong to this patient"
            : "Patient is inactive" });
    return;
  }
  res.status(201).json(AddOrthodonticCaseProgressResponse.parse(outcome.entry));
});

export default router;