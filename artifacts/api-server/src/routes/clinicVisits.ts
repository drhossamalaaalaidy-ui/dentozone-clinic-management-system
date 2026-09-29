import { Router, type IRouter } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  appointmentsTable,
  auditLogTable,
  db,
  patientsTable,
  staffTable,
  visitDiagnosesTable,
  visitProceduresTable,
  visitsTable,
} from "@workspace/db";
import {
  AddVisitDiagnosisBody,
  AddVisitDiagnosisParams,
  AddVisitDiagnosisResponse,
  AddVisitProcedureBody,
  AddVisitProcedureParams,
  AddVisitProcedureResponse,
  CreatePatientVisitBody,
  CreatePatientVisitParams,
  CreatePatientVisitResponse,
  GetVisitParams,
  GetVisitResponse,
  ListPatientVisitsParams,
  ListPatientVisitsResponse,
  UpdateVisitBody,
  UpdateVisitParams,
  UpdateVisitResponse,
} from "@workspace/api-zod";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";

const router: IRouter = Router();
const reader = allowRoles("owner", "manager", "dentist", "assistant");
const writer = allowRoles("owner", "dentist");

function auditValues(actor: ReturnType<typeof currentStaff>, action: string, entityType: string, id: number, summary: string) {
  return {
    actorStaffId: actor.id,
    actorName: actor.name,
    action,
    entityType,
    entityId: id,
    summary,
  };
}

function validToothCode(toothCode: string | null | undefined): boolean {
  if (toothCode == null) return true;
  return /^(1[1-8]|2[1-8]|3[1-8]|4[1-8]|5[1-5]|6[1-5]|7[1-5]|8[1-5])$/.test(toothCode);
}

function isAppointmentUniqueConflict(error: unknown): boolean {
  let current: unknown = error;
  const visited = new Set<unknown>();
  let hasUniqueCode = false;
  let hasAppointmentConstraint = false;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const candidate = current as { code?: unknown; constraint?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "23505") hasUniqueCode = true;
    if (
      candidate.constraint === "visits_appointment_id_unique"
      || (typeof candidate.message === "string" && candidate.message.includes("visits_appointment_id_unique"))
    ) hasAppointmentConstraint = true;
    current = candidate.cause;
  }
  return hasUniqueCode && hasAppointmentConstraint;
}

async function visitDto(visitId: number) {
  const [visit] = await db.select().from(visitsTable).where(eq(visitsTable.id, visitId));
  if (!visit) return null;
  const [[patient], [doctor], diagnoses, procedures] = await Promise.all([
    db.select({ fullName: patientsTable.fullName }).from(patientsTable)
      .where(eq(patientsTable.id, visit.patientId)),
    db.select({ name: staffTable.name }).from(staffTable)
      .where(eq(staffTable.id, visit.doctorStaffId)),
    db.select({
      id: visitDiagnosesTable.id,
      visitId: visitDiagnosesTable.visitId,
      label: visitDiagnosesTable.label,
      code: visitDiagnosesTable.code,
      toothCode: visitDiagnosesTable.toothCode,
      notes: visitDiagnosesTable.notes,
      recordedAt: visitDiagnosesTable.recordedAt,
      recordedByName: staffTable.name,
    }).from(visitDiagnosesTable)
      .innerJoin(staffTable, eq(staffTable.id, visitDiagnosesTable.recordedByStaffId))
      .where(eq(visitDiagnosesTable.visitId, visitId))
      .orderBy(asc(visitDiagnosesTable.recordedAt), asc(visitDiagnosesTable.id)),
    db.select({
      id: visitProceduresTable.id,
      visitId: visitProceduresTable.visitId,
      label: visitProceduresTable.label,
      toothCode: visitProceduresTable.toothCode,
      notes: visitProceduresTable.notes,
      recordedAt: visitProceduresTable.recordedAt,
      recordedByName: staffTable.name,
    }).from(visitProceduresTable)
      .innerJoin(staffTable, eq(staffTable.id, visitProceduresTable.recordedByStaffId))
      .where(eq(visitProceduresTable.visitId, visitId))
      .orderBy(asc(visitProceduresTable.recordedAt), asc(visitProceduresTable.id)),
  ]);
  if (!patient || !doctor) return null;
  return {
    id: visit.id,
    patientId: visit.patientId,
    patientName: patient.fullName,
    appointmentId: visit.appointmentId,
    doctorStaffId: visit.doctorStaffId,
    doctorName: doctor.name,
    status: visit.status,
    complaint: visit.complaint,
    notes: visit.notes,
    occurredAt: visit.occurredAt.toISOString(),
    createdAt: visit.createdAt.toISOString(),
    updatedAt: visit.updatedAt.toISOString(),
    isDemo: visit.isDemo,
    diagnoses: diagnoses.map((diagnosis) => ({
      ...diagnosis,
      recordedAt: diagnosis.recordedAt.toISOString(),
    })),
    procedures: procedures.map((procedure) => ({
      ...procedure,
      recordedAt: procedure.recordedAt.toISOString(),
    })),
  };
}

router.get("/patients/:patientId/visits", reader, async (req, res): Promise<void> => {
  const params = ListPatientVisitsParams.safeParse(req.params);
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
  const rows = await db.select({ id: visitsTable.id }).from(visitsTable)
    .where(eq(visitsTable.patientId, params.data.patientId))
    .orderBy(asc(visitsTable.occurredAt), asc(visitsTable.id));
  const result = (await Promise.all(rows.map(({ id }) => visitDto(id)))
    .then((visits) => visits.filter((visit) => visit !== null)));
  res.json(ListPatientVisitsResponse.parse(result));
});

router.post("/patients/:patientId/visits", writer, async (req, res): Promise<void> => {
  const params = CreatePatientVisitParams.safeParse(req.params);
  const parsed = CreatePatientVisitBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: params.success ? parsed.error?.message ?? "Invalid request body" : params.error.message,
    });
    return;
  }
  const actor = currentStaff(res);
  try {
    const outcome = await db.transaction(async (tx) => {
      const [patient] = await tx.select().from(patientsTable)
        .where(eq(patientsTable.id, params.data.patientId));
      if (!patient || patient.status === "archived") return { error: "patient_not_found" as const };

      let doctorStaffId = actor.id;
      if (parsed.data.appointmentId !== undefined) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(723125803)`);
        const [appointment] = await tx.select().from(appointmentsTable)
          .where(eq(appointmentsTable.id, parsed.data.appointmentId));
        if (!appointment || appointment.patientId !== patient.id) {
          return { error: "appointment_not_found" as const };
        }
        if (["cancelled", "canceled", "no_show", "no-show"].includes(appointment.status)) {
          return { error: "appointment_unavailable" as const };
        }
        if (appointment.doctorStaffId !== null) {
          if (actor.id !== appointment.doctorStaffId) {
            return { error: "wrong_clinician" as const };
          }
          const [appointmentDoctor] = await tx.select().from(staffTable)
            .where(and(
              eq(staffTable.id, appointment.doctorStaffId),
              eq(staffTable.status, "active"),
            ));
          if (!appointmentDoctor || !["owner", "dentist"].includes(appointmentDoctor.role)) {
            return { error: "doctor_unavailable" as const };
          }
          doctorStaffId = appointmentDoctor.id;
        }
        const [existingVisit] = await tx.select({ id: visitsTable.id }).from(visitsTable)
          .where(eq(visitsTable.appointmentId, appointment.id));
        if (existingVisit) return { error: "appointment_already_has_visit" as const };
      }
      const now = new Date();
      const [visit] = await tx.insert(visitsTable).values({
        patientId: patient.id,
        appointmentId: parsed.data.appointmentId ?? null,
        doctorStaffId,
        complaint: parsed.data.complaint ?? null,
        notes: parsed.data.notes ?? null,
        occurredAt: now,
        isDemo: patient.isDemo,
      }).returning();
      await tx.insert(auditLogTable).values(auditValues(
        actor, "create", "visit", visit.id, `Visit ${visit.id} recorded for patient ${patient.id}`,
      ));
      return { visitId: visit.id };
    });
    if ("error" in outcome) {
      const errors: Record<string, [number, string]> = {
        patient_not_found: [404, "Patient not found"],
        appointment_not_found: [404, "Appointment not found for this patient"],
        appointment_unavailable: [409, "Cancelled or no-show appointments cannot have visits"],
        doctor_unavailable: [409, "The appointment doctor is not active"],
        wrong_clinician: [403, "Only the assigned appointment doctor can record this visit"],
        appointment_already_has_visit: [409, "This appointment already has a visit"],
      };
      const [status, message] = errors[outcome.error ?? ""] ?? [409, "Unable to record visit"];
      res.status(status).json({ error: message });
      return;
    }
    const result = await visitDto(outcome.visitId);
    res.status(201).json(CreatePatientVisitResponse.parse(result));
  } catch (error) {
    if (!isAppointmentUniqueConflict(error)) throw error;
    res.status(409).json({ error: "This appointment already has a visit" });
  }
});

router.get("/visits/:visitId", reader, async (req, res): Promise<void> => {
  const params = GetVisitParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const result = await visitDto(params.data.visitId);
  if (!result) {
    res.status(404).json({ error: "Visit not found" });
    return;
  }
  res.json(GetVisitResponse.parse(result));
});

router.patch("/visits/:visitId", writer, async (req, res): Promise<void> => {
  const params = UpdateVisitParams.safeParse(req.params);
  const parsed = UpdateVisitBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: params.success ? parsed.error?.message ?? "Invalid request body" : params.error.message,
    });
    return;
  }
  if (!Object.keys(parsed.data).length) {
    res.status(400).json({ error: "No changes provided" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM visits WHERE id = ${params.data.visitId} FOR UPDATE`);
    const [existing] = await tx.select().from(visitsTable)
      .where(eq(visitsTable.id, params.data.visitId));
    if (!existing) return { error: "not_found" as const };
    if (existing.status === "completed") return { error: "completed" as const };
    const [visit] = await tx.update(visitsTable).set({
      ...(parsed.data.complaint !== undefined ? { complaint: parsed.data.complaint } : {}),
      ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      updatedAt: new Date(),
    }).where(eq(visitsTable.id, existing.id)).returning();
    await tx.insert(auditLogTable).values(auditValues(
      actor, "update", "visit", visit.id, `Visit ${visit.id} updated`,
    ));
    return { visitId: visit.id };
  });
  if ("error" in outcome) {
    res.status(outcome.error === "not_found" ? 404 : 409).json({
      error: outcome.error === "not_found" ? "Visit not found" : "Completed visits are immutable",
    });
    return;
  }
  res.json(UpdateVisitResponse.parse(await visitDto(outcome.visitId)));
});

router.post("/visits/:visitId/diagnoses", writer, async (req, res): Promise<void> => {
  const params = AddVisitDiagnosisParams.safeParse(req.params);
  const parsed = AddVisitDiagnosisBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: params.success ? parsed.error?.message ?? "Invalid request body" : params.error.message,
    });
    return;
  }
  const input = parsed.data;
  if (!input.label.trim() || !validToothCode(input.toothCode)) {
    res.status(400).json({ error: !input.label.trim() ? "Diagnosis label cannot be empty" : "Invalid FDI tooth code" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM visits WHERE id = ${params.data.visitId} FOR UPDATE`);
    const [visit] = await tx.select().from(visitsTable).where(eq(visitsTable.id, params.data.visitId));
    if (!visit) return { error: "not_found" as const };
    if (visit.status !== "draft") return { error: "completed" as const };
    const [diagnosis] = await tx.insert(visitDiagnosesTable).values({
      visitId: visit.id,
      label: input.label.trim(),
      code: input.code ?? null,
      toothCode: input.toothCode ?? null,
      notes: input.notes ?? null,
      recordedByStaffId: actor.id,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(
      actor, "create", "visit_diagnosis", diagnosis.id, `Diagnosis added to visit ${visit.id}`,
    ));
    return { diagnosisId: diagnosis.id, visitId: visit.id };
  });
  if ("error" in outcome) {
    res.status(outcome.error === "not_found" ? 404 : 409).json({
      error: outcome.error === "not_found" ? "Visit not found" : "Diagnoses can only be added to draft visits",
    });
    return;
  }
  const [diagnosis] = await db.select().from(visitDiagnosesTable)
    .where(eq(visitDiagnosesTable.id, outcome.diagnosisId));
  const [recordedBy] = await db.select({ name: staffTable.name }).from(staffTable)
    .where(eq(staffTable.id, diagnosis.recordedByStaffId));
  res.status(201).json(AddVisitDiagnosisResponse.parse({
    id: diagnosis.id,
    visitId: diagnosis.visitId,
    label: diagnosis.label,
    code: diagnosis.code,
    toothCode: diagnosis.toothCode,
    notes: diagnosis.notes,
    recordedAt: diagnosis.recordedAt.toISOString(),
    recordedByName: recordedBy.name,
  }));
});

router.post("/visits/:visitId/procedures", writer, async (req, res): Promise<void> => {
  const params = AddVisitProcedureParams.safeParse(req.params);
  const parsed = AddVisitProcedureBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({
      error: params.success ? parsed.error?.message ?? "Invalid request body" : params.error.message,
    });
    return;
  }
  const input = parsed.data;
  if (!input.label.trim() || !validToothCode(input.toothCode)) {
    res.status(400).json({ error: !input.label.trim() ? "Procedure label cannot be empty" : "Invalid FDI tooth code" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM visits WHERE id = ${params.data.visitId} FOR UPDATE`);
    const [visit] = await tx.select().from(visitsTable).where(eq(visitsTable.id, params.data.visitId));
    if (!visit) return { error: "not_found" as const };
    if (visit.status !== "draft") return { error: "completed" as const };
    const [procedure] = await tx.insert(visitProceduresTable).values({
      visitId: visit.id,
      label: input.label.trim(),
      toothCode: input.toothCode ?? null,
      notes: input.notes ?? null,
      recordedByStaffId: actor.id,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(
      actor, "create", "visit_procedure", procedure.id, `Procedure added to visit ${visit.id}`,
    ));
    return { procedureId: procedure.id };
  });
  if ("error" in outcome) {
    res.status(outcome.error === "not_found" ? 404 : 409).json({
      error: outcome.error === "not_found" ? "Visit not found" : "Procedures can only be added to draft visits",
    });
    return;
  }
  const [procedure] = await db.select().from(visitProceduresTable)
    .where(eq(visitProceduresTable.id, outcome.procedureId));
  const [recordedBy] = await db.select({ name: staffTable.name }).from(staffTable)
    .where(eq(staffTable.id, procedure.recordedByStaffId));
  res.status(201).json(AddVisitProcedureResponse.parse({
    id: procedure.id,
    visitId: procedure.visitId,
    label: procedure.label,
    toothCode: procedure.toothCode,
    notes: procedure.notes,
    recordedAt: procedure.recordedAt.toISOString(),
    recordedByName: recordedBy.name,
  }));
});

export default router;