import { Router, type IRouter } from "express";
import { and, asc, eq, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import {
  db, appointmentsTable, auditLogTable, patientsTable, staffTable, visitsTable,
  type Staff,
} from "@workspace/db";
import {
  CancelAppointmentBody, CancelAppointmentParams, CancelAppointmentResponse,
  CreateAppointmentBody, CreateAppointmentResponse, GetAppointmentParams,
  GetAppointmentResponse, ListAppointmentDoctorsResponse, ListAppointmentsQueryParams,
  ListAppointmentsResponse, UpdateAppointmentBody, UpdateAppointmentParams,
  UpdateAppointmentResponse,
} from "@workspace/api-zod";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";

const router: IRouter = Router();
const appointmentReaders = allowRoles("owner", "manager", "reception", "dentist", "assistant");
const appointmentWriters = allowRoles("owner", "manager", "reception", "dentist");
const ACTIVE_APPOINTMENT_STATUSES = ["cancelled", "no_show"];
const LOCK_KEY = 723125803;
const MAX_RANGE_MS = 64 * 24 * 60 * 60 * 1000;

function auditValues(actor: Staff, action: string, appointmentId: number, summary: string) {
  return {
    actorStaffId: actor.id,
    actorName: actor.name,
    action,
    entityType: "appointment",
    entityId: appointmentId,
    summary,
  };
}

function validInstant(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , , offsetHour, offsetMinute] = match;
  const localDate = `${year}-${month}-${day}`;
  const localDateRoundTrip = new Date(`${localDate}T00:00:00.000Z`);
  if (!Number.isFinite(localDateRoundTrip.getTime())
    || localDateRoundTrip.toISOString().slice(0, 10) !== localDate
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (offsetHour !== undefined && Number(offsetHour) > 23)
    || (offsetMinute !== undefined && Number(offsetMinute) > 59)) {
    return false;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime());
}

function onlyKeys(value: unknown, allowed: string[]): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

function appointmentDto(appointment: typeof appointmentsTable.$inferSelect, patient: {
  id: number;
  fullName: string;
}) {
  return {
    id: appointment.id,
    patientId: appointment.patientId,
    patientName: patient.fullName,
    patientCode: `DZO-${String(patient.id).padStart(5, "0")}`,
    doctorStaffId: appointment.doctorStaffId,
    doctorName: appointment.doctorName,
    chair: appointment.chair,
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    status: appointment.status,
    treatment: appointment.treatment,
    notes: appointment.notes,
    cancelReason: appointment.cancelReason,
    cancelledAt: appointment.cancelledAt,
    isDemo: appointment.isDemo,
  };
}

async function getAppointmentDto(id: number) {
  const [row] = await db.select({
    appointment: appointmentsTable,
    patientId: patientsTable.id,
    patientName: patientsTable.fullName,
  }).from(appointmentsTable)
    .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(eq(appointmentsTable.id, id));
  if (!row) return null;
  return appointmentDto(row.appointment, { id: row.patientId, fullName: row.patientName });
}

function normalized(value: string | null): string {
  return value?.trim().toLocaleLowerCase() ?? "";
}

async function hasSchedulingConflict(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    appointmentId?: number;
    doctorStaffId: number;
    doctorName: string;
    chair: string | null;
    startsAt: Date;
    endsAt: Date;
  },
): Promise<boolean> {
  const conditions = [
    lt(appointmentsTable.startsAt, input.endsAt),
    sql`${appointmentsTable.endsAt} > ${input.startsAt}`,
    notInArray(appointmentsTable.status, ACTIVE_APPOINTMENT_STATUSES),
  ];
  if (input.appointmentId !== undefined) conditions.push(ne(appointmentsTable.id, input.appointmentId));
  const overlapping = await tx.select({
    doctorStaffId: appointmentsTable.doctorStaffId,
    doctorName: appointmentsTable.doctorName,
    chair: appointmentsTable.chair,
  }).from(appointmentsTable).where(and(...conditions));
  const doctorName = normalized(input.doctorName);
  const chair = normalized(input.chair);
  return overlapping.some((appointment) => {
    const sameDoctor = appointment.doctorStaffId === input.doctorStaffId
      || (appointment.doctorStaffId === null && normalized(appointment.doctorName) === doctorName);
    const sameChair = chair !== "" && normalized(appointment.chair) === chair;
    return sameDoctor || sameChair;
  });
}

router.get("/appointments/doctors", appointmentReaders, async (_req, res): Promise<void> => {
  const doctors = await db.select({
    id: staffTable.id,
    name: staffTable.name,
  }).from(staffTable).where(and(
    eq(staffTable.status, "active"),
    sql`${staffTable.role} IN ('owner', 'dentist')`,
  )).orderBy(asc(staffTable.name), asc(staffTable.id));
  res.json(ListAppointmentDoctorsResponse.parse(doctors));
});

router.get("/appointments", appointmentReaders, async (req, res): Promise<void> => {
  const query = req.query as Record<string, unknown>;
  const rawFrom = query.from;
  const rawTo = query.to;
  if (!validInstant(rawFrom) || !validInstant(rawTo)) {
    res.status(400).json({ error: "from and to must be valid ISO date-time instants" });
    return;
  }
  const parsed = ListAppointmentsQueryParams.safeParse({
    ...query,
    from: new Date(rawFrom),
    to: new Date(rawTo),
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const from = parsed.data.from;
  const to = parsed.data.to;
  if (to <= from || to.getTime() - from.getTime() > MAX_RANGE_MS) {
    res.status(400).json({ error: "Appointment range must be positive and no longer than 64 days" });
    return;
  }
  const filters = [
    lt(appointmentsTable.startsAt, to),
    sql`${appointmentsTable.endsAt} > ${from}`,
  ];
  if (parsed.data.doctorStaffId !== undefined) {
    const [doctor] = await db.select({ name: staffTable.name }).from(staffTable).where(and(
      eq(staffTable.id, parsed.data.doctorStaffId),
      eq(staffTable.status, "active"),
      sql`${staffTable.role} IN ('owner', 'dentist')`,
    ));
    filters.push(doctor
      ? or(
        eq(appointmentsTable.doctorStaffId, parsed.data.doctorStaffId),
        and(
          isNull(appointmentsTable.doctorStaffId),
          sql`lower(trim(${appointmentsTable.doctorName})) = lower(trim(${doctor.name}))`,
        ),
      )!
      : eq(appointmentsTable.doctorStaffId, parsed.data.doctorStaffId));
  }
  if (parsed.data.chair !== undefined) {
    filters.push(sql`lower(trim(coalesce(${appointmentsTable.chair}, ''))) = lower(trim(${parsed.data.chair}))`);
  }
  const rows = await db.select({
    appointment: appointmentsTable,
    patientId: patientsTable.id,
    patientName: patientsTable.fullName,
  }).from(appointmentsTable)
    .innerJoin(patientsTable, eq(appointmentsTable.patientId, patientsTable.id))
    .where(and(...filters))
    .orderBy(asc(appointmentsTable.startsAt), asc(appointmentsTable.id));
  res.json(ListAppointmentsResponse.parse(rows.map((row) => appointmentDto(
    row.appointment, { id: row.patientId, fullName: row.patientName },
  ))));
});

router.post("/appointments", appointmentWriters, async (req, res): Promise<void> => {
  if (!onlyKeys(req.body, ["patientId", "doctorStaffId", "startsAt", "endsAt", "treatment", "chair", "notes"])
    || !validInstant(req.body?.startsAt) || !validInstant(req.body?.endsAt)) {
    res.status(400).json({ error: "Invalid appointment request" });
    return;
  }
  const parsed = CreateAppointmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const input = parsed.data;
  const duration = input.endsAt.getTime() - input.startsAt.getTime();
  const treatment = input.treatment.trim();
  const chair = input.chair?.trim() || null;
  if (duration < 5 * 60_000 || duration > 8 * 60 * 60_000 || !treatment) {
    res.status(400).json({ error: "Appointments must last 5 minutes to 8 hours and include a treatment" });
    return;
  }
  const actor = currentStaff(res);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    const [patient] = await tx.select({ id: patientsTable.id, isDemo: patientsTable.isDemo }).from(patientsTable).where(and(
      eq(patientsTable.id, input.patientId),
      eq(patientsTable.status, "active"),
    ));
    if (!patient) return { error: "patient" as const };
    const [doctor] = await tx.select({
      id: staffTable.id,
      name: staffTable.name,
    }).from(staffTable).where(and(
      eq(staffTable.id, input.doctorStaffId),
      eq(staffTable.status, "active"),
      sql`${staffTable.role} IN ('owner', 'dentist')`,
    ));
    if (!doctor) return { error: "doctor" as const };
    if (await hasSchedulingConflict(tx, {
      doctorStaffId: doctor.id,
      doctorName: doctor.name,
      chair,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
    })) return { error: "conflict" as const };
    const [appointment] = await tx.insert(appointmentsTable).values({
      patientId: patient.id,
      doctorStaffId: doctor.id,
      doctorName: doctor.name,
      chair,
      treatment,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: "scheduled",
      notes: input.notes?.trim() || null,
      isDemo: patient.isDemo,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(
      actor, "create", appointment.id, `Appointment ${appointment.id} scheduled`,
    ));
    return { id: appointment.id };
  });
  if ("error" in result) {
    if (result.error === "conflict") {
      res.status(409).json({ error: "Appointment overlaps an existing doctor or chair booking" });
      return;
    }
    res.status(404).json({ error: result.error === "patient" ? "Active patient not found" : "Active appointment doctor not found" });
    return;
  }
  const dto = await getAppointmentDto(result.id);
  res.status(201).json(CreateAppointmentResponse.parse(dto));
});

router.get("/appointments/:appointmentId", appointmentReaders, async (req, res): Promise<void> => {
  const params = GetAppointmentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const dto = await getAppointmentDto(params.data.appointmentId);
  if (!dto) {
    res.status(404).json({ error: "Appointment not found" });
    return;
  }
  res.json(GetAppointmentResponse.parse(dto));
});

router.patch("/appointments/:appointmentId", appointmentWriters, async (req, res): Promise<void> => {
  const params = UpdateAppointmentParams.safeParse(req.params);
  const rawBody = req.body as Record<string, unknown> | null;
  const allowed = ["doctorStaffId", "startsAt", "endsAt", "chair", "treatment", "notes", "status"];
  if (!params.success || !rawBody || !onlyKeys(rawBody, allowed)
    || (rawBody.startsAt !== undefined && !validInstant(rawBody.startsAt))
    || (rawBody.endsAt !== undefined && !validInstant(rawBody.endsAt))) {
    res.status(400).json({ error: "Invalid appointment update" });
    return;
  }
  const parsed = UpdateAppointmentBody.safeParse(rawBody);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (!Object.keys(parsed.data).length || parsed.data.status === "cancelled"
    || parsed.data.doctorStaffId === null) {
    res.status(400).json({ error: "Appointment update is empty or contains an unsupported value" });
    return;
  }
  const changes = parsed.data;
  if (changes.treatment !== undefined && !changes.treatment.trim()) {
    res.status(400).json({ error: "Treatment cannot be empty" });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    const [existing] = await tx.select().from(appointmentsTable)
      .where(eq(appointmentsTable.id, params.data.appointmentId));
    if (!existing) return { error: "not_found" as const };
    if (existing.status === "cancelled" || existing.status === "completed") {
      return { error: "terminal" as const };
    }
    if (existing.doctorStaffId === null
      && changes.doctorStaffId === undefined
      && (changes.startsAt !== undefined || changes.endsAt !== undefined)) {
      return { error: "legacy_reschedule" as const };
    }
    if (changes.status === "no_show" && existing.status !== "no_show") {
      const [visit] = await tx.select({ id: visitsTable.id }).from(visitsTable)
        .where(eq(visitsTable.appointmentId, existing.id));
      if (visit) return { error: "visit_linked" as const };
    }
    const [patient] = await tx.select({ id: patientsTable.id }).from(patientsTable).where(and(
      eq(patientsTable.id, existing.patientId),
      eq(patientsTable.status, "active"),
    ));
    if (!patient) return { error: "patient" as const };
    let doctorId = existing.doctorStaffId;
    let doctorName = existing.doctorName;
    if (changes.doctorStaffId !== undefined) {
      if (changes.doctorStaffId === null) return { error: "doctor" as const };
      const [doctor] = await tx.select({
        id: staffTable.id,
        name: staffTable.name,
      }).from(staffTable).where(and(
        eq(staffTable.id, changes.doctorStaffId),
        eq(staffTable.status, "active"),
        sql`${staffTable.role} IN ('owner', 'dentist')`,
      ));
      if (!doctor) return { error: "doctor" as const };
      doctorId = doctor.id;
      doctorName = doctor.name;
    } else if (doctorId !== null) {
      const [doctor] = await tx.select({
        id: staffTable.id,
        name: staffTable.name,
      }).from(staffTable).where(and(
        eq(staffTable.id, doctorId),
        eq(staffTable.status, "active"),
        sql`${staffTable.role} IN ('owner', 'dentist')`,
      ));
      if (!doctor) return { error: "doctor" as const };
      doctorName = doctor.name;
    }
    const startsAt = changes.startsAt ?? existing.startsAt;
    const endsAt = changes.endsAt ?? existing.endsAt;
    const duration = endsAt.getTime() - startsAt.getTime();
    if (duration < 5 * 60_000 || duration > 8 * 60 * 60_000) {
      return { error: "duration" as const };
    }
    const chair = changes.chair === undefined
      ? existing.chair
      : changes.chair?.trim() || null;
    const status = changes.status ?? existing.status;
    if (status !== "no_show" && await hasSchedulingConflict(tx, {
      appointmentId: existing.id,
      doctorStaffId: doctorId ?? -1,
      doctorName,
      chair,
      startsAt,
      endsAt,
    })) return { error: "conflict" as const };
    const [appointment] = await tx.update(appointmentsTable).set({
      doctorStaffId: doctorId,
      doctorName,
      startsAt,
      endsAt,
      chair,
      ...(changes.treatment !== undefined ? { treatment: changes.treatment.trim() } : {}),
      ...(changes.notes !== undefined ? { notes: changes.notes?.trim() || null } : {}),
      status,
    }).where(eq(appointmentsTable.id, existing.id)).returning();
    await tx.insert(auditLogTable).values(auditValues(
      actor, "update", appointment.id, `Appointment ${appointment.id} updated`,
    ));
    return { id: appointment.id };
  });
  if ("error" in outcome) {
    if (outcome.error === "not_found") {
      res.status(404).json({ error: "Appointment not found" });
      return;
    }
    if (outcome.error === "conflict") {
      res.status(409).json({ error: "Appointment overlaps an existing doctor or chair booking" });
      return;
    }
    if (outcome.error === "terminal") {
      res.status(409).json({ error: "Cancelled or completed appointments cannot be edited" });
      return;
    }
    if (outcome.error === "legacy_reschedule") {
      res.status(400).json({ error: "Select an active doctor before rescheduling this legacy appointment" });
      return;
    }
    if (outcome.error === "visit_linked") {
      res.status(409).json({ error: "An appointment with a linked visit cannot be marked no_show" });
      return;
    }
    if (outcome.error === "duration") {
      res.status(400).json({ error: "Appointments must last 5 minutes to 8 hours" });
      return;
    }
    res.status(404).json({ error: outcome.error === "patient" ? "Active patient not found" : "Active appointment doctor not found" });
    return;
  }
  const dto = await getAppointmentDto(outcome.id);
  res.json(UpdateAppointmentResponse.parse(dto));
});

router.post("/appointments/:appointmentId/cancel", appointmentWriters, async (req, res): Promise<void> => {
  const params = CancelAppointmentParams.safeParse(req.params);
  if (!params.success || !onlyKeys(req.body, ["reason"])) {
    res.status(400).json({ error: "Invalid cancellation request" });
    return;
  }
  const parsed = CancelAppointmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const actor = currentStaff(res);
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    const [existing] = await tx.select().from(appointmentsTable)
      .where(eq(appointmentsTable.id, params.data.appointmentId));
    if (!existing) return { error: "not_found" as const };
    if (existing.status === "completed" || existing.status === "cancelled") {
      return { error: "not_cancellable" as const };
    }
    const [visit] = await tx.select({ id: visitsTable.id }).from(visitsTable)
      .where(eq(visitsTable.appointmentId, existing.id)).limit(1);
    if (visit) return { error: "has_visit" as const };
    const reason = parsed.data.reason?.trim() || null;
    const [appointment] = await tx.update(appointmentsTable).set({
      status: "cancelled",
      cancelledAt: new Date(),
      cancelReason: reason,
    }).where(eq(appointmentsTable.id, existing.id)).returning();
    await tx.insert(auditLogTable).values(auditValues(
      actor, "cancel", appointment.id, `Appointment ${appointment.id} cancelled`,
    ));
    return { id: appointment.id };
  });
  if ("error" in outcome) {
    res.status(outcome.error === "not_found" ? 404 : 409)
      .json({ error: outcome.error === "not_found" ? "Appointment not found"
        : outcome.error === "has_visit" ? "Appointments with a recorded visit cannot be cancelled"
          : "Completed or cancelled appointments cannot be cancelled" });
    return;
  }
  const dto = await getAppointmentDto(outcome.id);
  res.json(CancelAppointmentResponse.parse(dto));
});

export default router;