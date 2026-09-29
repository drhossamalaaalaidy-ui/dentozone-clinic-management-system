import { Router, type IRouter } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  alignerCoursesTable, alignerTraysTable, auditLogTable, db, orthodonticCasesTable,
  patientsTable, visitsTable,
} from "@workspace/db";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";

const router: IRouter = Router();
const clinicalRead = allowRoles("owner", "manager", "dentist", "assistant");
const clinicalWrite = allowRoles("owner", "dentist");
const idParams = z.object({ patientId: z.coerce.number().int().positive() });
const courseParams = idParams.extend({ courseId: z.coerce.number().int().positive() });
const trayParams = courseParams.extend({ trayId: z.coerce.number().int().positive() });
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value: string) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "Expected a real calendar date");
const statusSchema = z.enum(["planned", "delivered", "wearing", "completed", "paused"]);
const createCourseBody = z.object({
  caseId: z.number().int().positive(),
  title: z.string().trim().min(1).max(160),
}).strict();
const createTrayBody = z.object({
  sequence: z.number().int().positive(),
  plannedDate: dateString.nullable().optional(),
  deliveredDate: dateString.nullable().optional(),
  status: statusSchema.optional(),
  wearNotes: z.string().max(4000).nullable().optional(),
  visitId: z.number().int().positive().nullable().optional(),
}).strict();
const updateTrayBody = createTrayBody.partial().omit({ sequence: true }).refine(
  (body: Partial<Omit<z.infer<typeof createTrayBody>, "sequence">>) => Object.keys(body).length > 0,
);

type Actor = ReturnType<typeof currentStaff>;
function auditValues(actor: Actor, action: string, entityType: string, entityId: number, summary: string) {
  return {
    actorStaffId: actor.id,
    actorName: actor.name,
    action,
    entityType,
    entityId,
    summary,
  };
}

function validDates(plannedDate: string | null | undefined, deliveredDate: string | null | undefined): boolean {
  return !plannedDate || !deliveredDate || deliveredDate >= plannedDate;
}

async function courseDto(patientId: number, courseId: number) {
  const [course] = await db.select().from(alignerCoursesTable).where(and(
    eq(alignerCoursesTable.patientId, patientId),
    eq(alignerCoursesTable.id, courseId),
  ));
  if (!course) return null;
  const trays = await db.select().from(alignerTraysTable)
    .where(eq(alignerTraysTable.courseId, courseId))
    .orderBy(asc(alignerTraysTable.sequence));
  return { ...course, trays };
}

async function mayWriteCase(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], caseId: number, actor: Actor) {
  const [orthodonticCase] = await tx.select().from(orthodonticCasesTable)
    .where(eq(orthodonticCasesTable.id, caseId));
  if (!orthodonticCase) return { ok: false as const, error: "case_not_found" as const };
  if (actor.role !== "owner" && orthodonticCase.doctorStaffId !== actor.id) {
    return { ok: false as const, error: "forbidden" as const };
  }
  return { ok: true as const, orthodonticCase };
}

router.get("/patients/:patientId/aligner-courses", clinicalRead, async (req, res): Promise<void> => {
  const params = idParams.safeParse(req.params);
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
  const courses = await db.select({ id: alignerCoursesTable.id }).from(alignerCoursesTable)
    .where(eq(alignerCoursesTable.patientId, patient.id))
    .orderBy(desc(alignerCoursesTable.createdAt), desc(alignerCoursesTable.id));
  const result = await Promise.all(courses.map(({ id }) => courseDto(patient.id, id)));
  res.json(result.filter((course) => course !== null));
});

router.post("/patients/:patientId/aligner-courses", clinicalWrite, async (req, res): Promise<void> => {
  const params = idParams.safeParse(req.params);
  const body = createCourseBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: params.success ? (body.success ? "Invalid body" : body.error.message) : params.error.message });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [patient] = await tx.select().from(patientsTable)
      .where(eq(patientsTable.id, params.data.patientId));
    if (!patient) return { ok: false as const, error: "patient_not_found" as const };
    if (patient.status !== "active") return { ok: false as const, error: "inactive" as const };
    const ownership = await mayWriteCase(tx, body.data.caseId, actor);
    if (!ownership.ok) return ownership;
    if (ownership.orthodonticCase.patientId !== patient.id) {
      return { ok: false as const, error: "case_patient_mismatch" as const };
    }
    const [duplicate] = await tx.select({ id: alignerCoursesTable.id }).from(alignerCoursesTable)
      .where(eq(alignerCoursesTable.caseId, body.data.caseId));
    if (duplicate) return { ok: false as const, error: "course_exists" as const };
    const [course] = await tx.insert(alignerCoursesTable).values({
      patientId: patient.id,
      caseId: ownership.orthodonticCase.id,
      title: body.data.title,
      createdByStaffId: actor.id,
      isDemo: patient.isDemo,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "create", "aligner_course", course.id,
      `Aligner course ${course.id} created for patient ${patient.id}`));
    return { ok: true as const, courseId: course.id };
  });
  if (!outcome.ok) {
    const status = outcome.error === "patient_not_found" || outcome.error === "case_not_found" ? 404
      : outcome.error === "forbidden" ? 403 : outcome.error === "inactive" || outcome.error === "course_exists" ? 409 : 400;
    res.status(status).json({ error: outcome.error === "patient_not_found" ? "Patient not found"
      : outcome.error === "case_not_found" ? "Orthodontic case not found"
        : outcome.error === "forbidden" ? "Only the assigned dentist or an owner may write this aligner course"
          : outcome.error === "case_patient_mismatch" ? "Orthodontic case does not belong to this patient"
            : outcome.error === "course_exists" ? "An aligner course already exists for this orthodontic case"
              : "Patient is inactive" });
    return;
  }
  res.status(201).json(await courseDto(params.data.patientId, outcome.courseId));
});

router.get("/patients/:patientId/aligner-courses/:courseId", clinicalRead, async (req, res): Promise<void> => {
  const params = courseParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const course = await courseDto(params.data.patientId, params.data.courseId);
  if (!course) {
    res.status(404).json({ error: "Aligner course not found for this patient" });
    return;
  }
  res.json(course);
});

router.post("/patients/:patientId/aligner-courses/:courseId/trays", clinicalWrite, async (req, res): Promise<void> => {
  const params = courseParams.safeParse(req.params);
  const body = createTrayBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: params.success ? (body.success ? "Invalid body" : body.error.message) : params.error.message });
    return;
  }
  if (!validDates(body.data.plannedDate, body.data.deliveredDate)) {
    res.status(400).json({ error: "Delivered date cannot precede planned date" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [course] = await tx.select().from(alignerCoursesTable).where(and(
      eq(alignerCoursesTable.id, params.data.courseId),
      eq(alignerCoursesTable.patientId, params.data.patientId),
    )).for("update");
    if (!course) return { ok: false as const, error: "not_found" as const };
    const ownership = await mayWriteCase(tx, course.caseId, actor);
    if (!ownership.ok) return ownership;
    const [patient] = await tx.select().from(patientsTable).where(eq(patientsTable.id, course.patientId));
    if (!patient || patient.status !== "active") return { ok: false as const, error: "inactive" as const };
    if (body.data.visitId != null) {
      const [visit] = await tx.select({ id: visitsTable.id, patientId: visitsTable.patientId })
        .from(visitsTable).where(eq(visitsTable.id, body.data.visitId));
      if (!visit) return { ok: false as const, error: "visit_not_found" as const };
      if (visit.patientId !== patient.id) return { ok: false as const, error: "visit_mismatch" as const };
    }
    const [existing] = await tx.select({ id: alignerTraysTable.id }).from(alignerTraysTable)
      .where(and(eq(alignerTraysTable.courseId, course.id), eq(alignerTraysTable.sequence, body.data.sequence)));
    if (existing) return { ok: false as const, error: "sequence_exists" as const };
    const [tray] = await tx.insert(alignerTraysTable).values({
      courseId: course.id,
      sequence: body.data.sequence,
      plannedDate: body.data.plannedDate ?? null,
      deliveredDate: body.data.deliveredDate ?? null,
      status: body.data.status ?? "planned",
      wearNotes: body.data.wearNotes ?? null,
      visitId: body.data.visitId ?? null,
      isDemo: patient.isDemo,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "create", "aligner_tray", tray.id,
      `Aligner tray ${tray.sequence} added to course ${course.id}`));
    return { ok: true as const, tray };
  });
  if (!outcome.ok) {
    const status = outcome.error === "not_found" || outcome.error === "visit_not_found" ? 404
      : outcome.error === "forbidden" ? 403 : outcome.error === "inactive" || outcome.error === "sequence_exists" ? 409 : 400;
    res.status(status).json({ error: outcome.error === "not_found" ? "Aligner course not found for this patient"
      : outcome.error === "visit_not_found" ? "Visit not found"
        : outcome.error === "visit_mismatch" ? "Visit does not belong to this patient"
          : outcome.error === "forbidden" ? "Only the assigned dentist or an owner may update this course"
            : outcome.error === "sequence_exists" ? "Tray sequence already exists in this course"
              : "Patient is inactive" });
    return;
  }
  res.status(201).json(outcome.tray);
});

router.patch("/patients/:patientId/aligner-courses/:courseId/trays/:trayId", clinicalWrite, async (req, res): Promise<void> => {
  const params = trayParams.safeParse(req.params);
  const body = updateTrayBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: params.success ? (body.success ? "Invalid body" : body.error.message) : params.error.message });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    const [course] = await tx.select().from(alignerCoursesTable).where(and(
      eq(alignerCoursesTable.id, params.data.courseId),
      eq(alignerCoursesTable.patientId, params.data.patientId),
    ));
    if (!course) return { ok: false as const, error: "not_found" as const };
    const ownership = await mayWriteCase(tx, course.caseId, actor);
    if (!ownership.ok) return ownership;
    const [patient] = await tx.select().from(patientsTable).where(eq(patientsTable.id, course.patientId));
    if (!patient || patient.status !== "active") return { ok: false as const, error: "inactive" as const };
    const [tray] = await tx.select().from(alignerTraysTable).where(and(
      eq(alignerTraysTable.id, params.data.trayId),
      eq(alignerTraysTable.courseId, course.id),
    ));
    if (!tray) return { ok: false as const, error: "tray_not_found" as const };
    const plannedDate = body.data.plannedDate === undefined ? tray.plannedDate : body.data.plannedDate;
    const deliveredDate = body.data.deliveredDate === undefined ? tray.deliveredDate : body.data.deliveredDate;
    if (!validDates(plannedDate, deliveredDate)) return { ok: false as const, error: "invalid_dates" as const };
    if (body.data.visitId != null) {
      const [visit] = await tx.select({ id: visitsTable.id, patientId: visitsTable.patientId })
        .from(visitsTable).where(eq(visitsTable.id, body.data.visitId));
      if (!visit) return { ok: false as const, error: "visit_not_found" as const };
      if (visit.patientId !== patient.id) return { ok: false as const, error: "visit_mismatch" as const };
    }
    const [updated] = await tx.update(alignerTraysTable).set({
      ...(body.data.plannedDate !== undefined ? { plannedDate: body.data.plannedDate } : {}),
      ...(body.data.deliveredDate !== undefined ? { deliveredDate: body.data.deliveredDate } : {}),
      ...(body.data.status !== undefined ? { status: body.data.status } : {}),
      ...(body.data.wearNotes !== undefined ? { wearNotes: body.data.wearNotes } : {}),
      ...(body.data.visitId !== undefined ? { visitId: body.data.visitId } : {}),
      updatedAt: new Date(),
    }).where(eq(alignerTraysTable.id, tray.id)).returning();
    await tx.insert(auditLogTable).values(auditValues(actor, "update", "aligner_tray", updated.id,
      `Aligner tray ${updated.sequence} updated in course ${course.id}`));
    return { ok: true as const, tray: updated };
  });
  if (!outcome.ok) {
    const status = outcome.error === "not_found" || outcome.error === "tray_not_found"
      || outcome.error === "visit_not_found" ? 404 : outcome.error === "forbidden" ? 403
        : outcome.error === "inactive" || outcome.error === "invalid_dates" ? 409 : 400;
    res.status(status).json({ error: outcome.error === "not_found" ? "Aligner course not found for this patient"
      : outcome.error === "tray_not_found" ? "Tray not found in this course"
        : outcome.error === "visit_not_found" ? "Visit not found"
          : outcome.error === "visit_mismatch" ? "Visit does not belong to this patient"
            : outcome.error === "forbidden" ? "Only the assigned dentist or an owner may update this course"
              : outcome.error === "invalid_dates" ? "Delivered date cannot precede planned date"
                : "Patient is inactive" });
    return;
  }
  res.json(outcome.tray);
});

export default router;