import { Router, type IRouter } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  appointmentsTable, auditLogTable, db, patientsTable, reminderPreferencesTable,
  reminderTemplatesTable, remindersTable, type Staff,
} from "@workspace/db";
import {
  CreateAppointmentReminderDraftBody, CreateAppointmentReminderDraftParams,
  CreateAppointmentReminderDraftResponse, CreateReminderTemplateBody,
  CreateReminderTemplateResponse, GetPatientReminderPreferencesParams,
  GetPatientReminderPreferencesResponse, ListReminderTemplatesResponse,
  ListRemindersQueryParams, ListRemindersResponse, MarkReminderSentParams,
  MarkReminderSentResponse, SetPatientReminderPreferencesBody,
  SetPatientReminderPreferencesParams, SetPatientReminderPreferencesResponse,
  UpdateReminderTemplateBody, UpdateReminderTemplateParams, UpdateReminderTemplateResponse,
} from "@workspace/api-zod";
import { allowRoles, currentStaff } from "../middlewares/clinicStaff";
import { invalidatesReminderDrafts } from "../lib/reminderConsent";

const router: IRouter = Router();
const outreach = allowRoles("owner", "manager", "reception", "dentist");
const templateEditors = allowRoles("owner", "manager");
const APPOINTMENT_LOCK_KEY = 723125803;
const CHANNELS = ["whatsapp", "sms", "email"] as const;
const PLACEHOLDERS = ["patient_name", "date", "time", "doctor"] as const;

function onlyKeys(value: unknown, allowed: string[]): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

function auditValues(actor: Staff, action: string, entityType: string, entityId: number, summary: string) {
  return {
    actorStaffId: actor.id,
    actorName: actor.name,
    action,
    entityType,
    entityId,
    summary,
  };
}

function preferenceDto(preferences: typeof reminderPreferencesTable.$inferSelect) {
  return {
    patientId: preferences.patientId,
    optIn: preferences.optIn,
    channel: preferences.channel,
    consentRecordedAt: preferences.consentRecordedAt,
    updatedAt: preferences.updatedAt,
    isDemo: preferences.isDemo,
  };
}

function templateDto(template: typeof reminderTemplatesTable.$inferSelect) {
  return {
    id: template.id,
    title: template.title,
    bodyEn: template.bodyEn,
    bodyAr: template.bodyAr,
    channel: template.channel,
    active: template.active,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    isDemo: template.isDemo,
  };
}

function reminderDto(reminder: typeof remindersTable.$inferSelect) {
  return {
    id: reminder.id,
    patientId: reminder.patientId,
    appointmentId: reminder.appointmentId,
    templateId: reminder.templateId,
    renderedMessage: reminder.renderedMessage,
    channel: reminder.channel,
    status: reminder.status,
    createdByStaffId: reminder.createdByStaffId,
    createdAt: reminder.createdAt,
    sentByStaffId: reminder.sentByStaffId,
    sentAt: reminder.sentAt,
    isDemo: reminder.isDemo,
  };
}

function validTemplateText(value: string): boolean {
  if (!value.trim() || value.length > 4000) return false;
  const placeholders: string[] = value.match(/\{[^{}]*\}/g) ?? [];
  if (placeholders.some((placeholder) => !(PLACEHOLDERS as readonly string[])
    .includes(placeholder.slice(1, -1)))) return false;
  return value.replace(/\{[^{}]*\}/g, "").includes("{") === false
    && value.replace(/\{[^{}]*\}/g, "").includes("}") === false;
}

function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function renderTemplate(body: string, values: Record<typeof PLACEHOLDERS[number], string>): string {
  return body.replace(/\{(patient_name|date|time|doctor)\}/g, (_match, key: string) =>
    safeText(values[key as keyof typeof values]));
}

function hasUsableContact(
  channel: string,
  patient: { phone: string; whatsapp: string | null; email: string | null },
): boolean {
  if (channel === "whatsapp") return Boolean((patient.whatsapp || patient.phone).trim());
  if (channel === "sms") return Boolean(patient.phone.trim());
  if (channel === "email") return Boolean(patient.email?.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patient.email.trim()));
  return false;
}

function formatAppointment(instant: Date, locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "Africa/Cairo" }).format(instant);
}

router.get("/patients/:patientId/reminder-preferences", outreach, async (req, res): Promise<void> => {
  const params = GetPatientReminderPreferencesParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [preferences] = await db.select().from(reminderPreferencesTable)
    .where(eq(reminderPreferencesTable.patientId, params.data.patientId));
  if (!preferences) {
    res.status(404).json({ error: "Reminder preferences have not been recorded" });
    return;
  }
  res.json(GetPatientReminderPreferencesResponse.parse(preferenceDto(preferences)));
});

router.put("/patients/:patientId/reminder-preferences", outreach, async (req, res): Promise<void> => {
  const params = SetPatientReminderPreferencesParams.safeParse(req.params);
  const body = req.body as Record<string, unknown> | null;
  if (!params.success || !onlyKeys(body, ["optIn", "channel", "consentRecordedAt"])) {
    res.status(400).json({ error: "Invalid reminder preferences request" });
    return;
  }
  const parsed = SetPatientReminderPreferencesBody.safeParse(body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const actor = currentStaff(res);
  const consentTime = parsed.data.optIn
    ? parsed.data.consentRecordedAt ?? new Date()
    : new Date();
  if (consentTime.getTime() > Date.now()) {
    res.status(400).json({ error: "Consent time cannot be in the future" });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [patient] = await tx.select({
      id: patientsTable.id,
      isDemo: patientsTable.isDemo,
    }).from(patientsTable).where(eq(patientsTable.id, params.data.patientId)).for("update");
    if (!patient) return { error: "patient" as const };
    const [existing] = await tx.select().from(reminderPreferencesTable)
      .where(eq(reminderPreferencesTable.patientId, patient.id)).for("update");
    const values = {
      patientId: patient.id,
      optIn: parsed.data.optIn,
      channel: parsed.data.channel,
      consentRecordedAt: consentTime,
      updatedAt: new Date(),
      isDemo: patient.isDemo,
    };
    const [preferences] = existing
      ? await tx.update(reminderPreferencesTable).set(values)
        .where(eq(reminderPreferencesTable.id, existing.id)).returning()
      : await tx.insert(reminderPreferencesTable).values(values).returning();
    await tx.insert(auditLogTable).values(auditValues(
      actor, "update", "reminder_preferences", patient.id,
      `Reminder preferences ${parsed.data.optIn ? "opted in" : "opted out"} for patient ${patient.id}`,
    ));
    if (invalidatesReminderDrafts(existing, parsed.data)) {
      const drafts = await tx.select().from(remindersTable).where(and(
        eq(remindersTable.patientId, patient.id),
        eq(remindersTable.status, "draft"),
      )).for("update");
      for (const draft of drafts) {
        await tx.update(remindersTable).set({ status: "cancelled" })
          .where(eq(remindersTable.id, draft.id));
        await tx.insert(auditLogTable).values(auditValues(
          actor, "cancel", "reminder", draft.id, `Reminder ${draft.id} cancelled after consent withdrawal or channel change`,
        ));
      }
    }
    return { preferences };
  });
  if ("error" in result) {
    res.status(404).json({ error: "Patient not found" });
    return;
  }
  res.json(SetPatientReminderPreferencesResponse.parse(preferenceDto(result.preferences)));
});

router.get("/reminder-templates", outreach, async (_req, res): Promise<void> => {
  const rows = await db.select().from(reminderTemplatesTable)
    .orderBy(asc(reminderTemplatesTable.title), asc(reminderTemplatesTable.id));
  res.json(ListReminderTemplatesResponse.parse(rows.map(templateDto)));
});

router.post("/reminder-templates", templateEditors, async (req, res): Promise<void> => {
  if (!onlyKeys(req.body, ["title", "bodyEn", "bodyAr", "channel", "active"])) {
    res.status(400).json({ error: "Invalid reminder template request" });
    return;
  }
  const parsed = CreateReminderTemplateBody.safeParse(req.body);
  if (!parsed.success || !validTemplateText(parsed.data.bodyEn) || !validTemplateText(parsed.data.bodyAr)
    || !parsed.data.title.trim() || parsed.data.title.length > 160) {
    res.status(400).json({ error: parsed.success ? "Template title and bilingual content are invalid" : parsed.error.message });
    return;
  }
  const actor = currentStaff(res);
  const template = await db.transaction(async (tx) => {
    const [created] = await tx.insert(reminderTemplatesTable).values({
      title: parsed.data.title.trim(),
      bodyEn: parsed.data.bodyEn,
      bodyAr: parsed.data.bodyAr,
      channel: parsed.data.channel,
      active: parsed.data.active,
      createdByStaffId: actor.id,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(
      actor, "create", "reminder_template", created.id, `Reminder template ${created.id} created`,
    ));
    return created;
  });
  res.status(201).json(CreateReminderTemplateResponse.parse(templateDto(template)));
});

router.patch("/reminder-templates/:templateId", templateEditors, async (req, res): Promise<void> => {
  const params = UpdateReminderTemplateParams.safeParse(req.params);
  const body = req.body as Record<string, unknown> | null;
  if (!params.success || !onlyKeys(body, ["title", "bodyEn", "bodyAr", "channel", "active"])) {
    res.status(400).json({ error: "Invalid reminder template update" });
    return;
  }
  const parsed = UpdateReminderTemplateBody.safeParse(body);
  if (!parsed.success || !Object.keys(parsed.data).length
    || (parsed.data.title !== undefined && (!parsed.data.title.trim() || parsed.data.title.length > 160))
    || (parsed.data.bodyEn !== undefined && !validTemplateText(parsed.data.bodyEn))
    || (parsed.data.bodyAr !== undefined && !validTemplateText(parsed.data.bodyAr))) {
    res.status(400).json({ error: parsed.success ? "Template update is empty or invalid" : parsed.error.message });
    return;
  }
  const actor = currentStaff(res);
  const template = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(reminderTemplatesTable)
      .where(eq(reminderTemplatesTable.id, params.data.templateId)).for("update");
    if (!existing) return null;
    const [updated] = await tx.update(reminderTemplatesTable).set({
      ...parsed.data,
      ...(parsed.data.title !== undefined ? { title: parsed.data.title.trim() } : {}),
    }).where(eq(reminderTemplatesTable.id, existing.id)).returning();
    await tx.insert(auditLogTable).values(auditValues(
      actor, "update", "reminder_template", updated.id, `Reminder template ${updated.id} updated`,
    ));
    return updated;
  });
  if (!template) {
    res.status(404).json({ error: "Reminder template not found" });
    return;
  }
  res.json(UpdateReminderTemplateResponse.parse(templateDto(template)));
});

router.post("/appointments/:appointmentId/reminders", outreach, async (req, res): Promise<void> => {
  const params = CreateAppointmentReminderDraftParams.safeParse(req.params);
  if (!params.success || !onlyKeys(req.body, ["templateId"])) {
    res.status(400).json({ error: "Invalid reminder draft request" });
    return;
  }
  const parsed = CreateAppointmentReminderDraftBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const actor = currentStaff(res);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${APPOINTMENT_LOCK_KEY})`);
    const [appointment] = await tx.select().from(appointmentsTable)
      .where(eq(appointmentsTable.id, params.data.appointmentId)).for("update");
    if (!appointment) return { error: "appointment" as const };
    if (appointment.status === "cancelled" || appointment.status === "completed"
      || appointment.status === "no_show" || appointment.startsAt <= new Date()) {
      return { error: "inactive_appointment" as const };
    }
    const [patient] = await tx.select({
      id: patientsTable.id,
      fullName: patientsTable.fullName,
      phone: patientsTable.phone,
      whatsapp: patientsTable.whatsapp,
      email: patientsTable.email,
      isDemo: patientsTable.isDemo,
    }).from(patientsTable).where(and(
      eq(patientsTable.id, appointment.patientId),
      eq(patientsTable.status, "active"),
    )).for("update");
    if (!patient) return { error: "patient" as const };
    const [preferences] = await tx.select().from(reminderPreferencesTable)
      .where(eq(reminderPreferencesTable.patientId, patient.id)).for("update");
    if (!preferences?.optIn) return { error: "consent" as const };
    const [template] = await tx.select().from(reminderTemplatesTable)
      .where(eq(reminderTemplatesTable.id, parsed.data.templateId)).for("update");
    if (!template || !template.active || template.channel !== preferences.channel) {
      return { error: "template" as const };
    }
    if (!hasUsableContact(template.channel, patient)) return { error: "contact" as const };
    const locale = req.acceptsLanguages("ar") ? "ar-EG" : "en";
    const body = locale.startsWith("ar") ? template.bodyAr : template.bodyEn;
    if (!validTemplateText(body)) return { error: "template" as const };
    const renderedMessage = renderTemplate(body, {
      patient_name: patient.fullName,
      date: formatAppointment(appointment.startsAt, locale, { year: "numeric", month: "long", day: "numeric" }),
      time: formatAppointment(appointment.startsAt, locale, { hour: "numeric", minute: "2-digit" }),
      doctor: appointment.doctorName,
    });
    const [created] = await tx.insert(remindersTable).values({
      patientId: patient.id,
      appointmentId: appointment.id,
      templateId: template.id,
      renderedMessage,
      channel: template.channel,
      status: "draft",
      createdByStaffId: actor.id,
      isDemo: patient.isDemo || appointment.isDemo || template.isDemo,
    }).returning();
    await tx.insert(auditLogTable).values(auditValues(
      actor, "create", "reminder", created.id, `Reminder draft ${created.id} created`,
    ));
    return { reminder: created };
  });
  if ("error" in result) {
    const errors = {
      appointment: [404, "Appointment not found"],
      inactive_appointment: [409, "Only active future appointments can receive reminder drafts"],
      patient: [404, "Active patient not found"],
      consent: [409, "Explicit reminder opt-in is required"],
      template: [409, "An active template matching the consent channel is required"],
      contact: [409, "The patient has no usable contact for the selected channel"],
    } as const;
    const [status, message] = errors[result.error as keyof typeof errors];
    res.status(status).json({ error: message });
    return;
  }
  res.status(201).json(CreateAppointmentReminderDraftResponse.parse(reminderDto(result.reminder)));
});

router.get("/reminders", outreach, async (req, res): Promise<void> => {
  const parsed = ListRemindersQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const filters = [];
  if (parsed.data.patientId !== undefined) filters.push(eq(remindersTable.patientId, parsed.data.patientId));
  if (parsed.data.appointmentId !== undefined) filters.push(eq(remindersTable.appointmentId, parsed.data.appointmentId));
  if (parsed.data.status !== undefined) filters.push(eq(remindersTable.status, parsed.data.status));
  const rows = await db.select().from(remindersTable).where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(remindersTable.createdAt), asc(remindersTable.id));
  res.json(ListRemindersResponse.parse(rows.map(reminderDto)));
});

router.post("/reminders/:reminderId/mark-sent", outreach, async (req, res): Promise<void> => {
  const params = MarkReminderSentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const actor = currentStaff(res);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${APPOINTMENT_LOCK_KEY})`);
    const [initial] = await tx.select().from(remindersTable)
      .where(eq(remindersTable.id, params.data.reminderId));
    if (!initial) return { error: "not_found" as const };
    const [patient] = await tx.select({ id: patientsTable.id, status: patientsTable.status }).from(patientsTable)
      .where(eq(patientsTable.id, initial.patientId)).for("update");
    if (!patient || patient.status !== "active") return { error: "blocked" as const };
    const [preferences] = await tx.select().from(reminderPreferencesTable)
      .where(eq(reminderPreferencesTable.patientId, patient.id)).for("update");
    const [appointment] = await tx.select().from(appointmentsTable)
      .where(eq(appointmentsTable.id, initial.appointmentId)).for("update");
    const [reminder] = await tx.select().from(remindersTable)
      .where(eq(remindersTable.id, initial.id)).for("update");
    if (!reminder) return { error: "not_found" as const };
    if (reminder.status !== "draft") return { error: "not_draft" as const };
    if (!appointment || ["cancelled", "completed", "no_show"].includes(appointment.status)
      || appointment.startsAt <= new Date() || !preferences?.optIn
      || preferences.channel !== reminder.channel) {
      return { error: "blocked" as const };
    }
    const sentAt = new Date();
    const [updated] = await tx.update(remindersTable).set({
      status: "staff_confirmed_sent",
      sentByStaffId: actor.id,
      sentAt,
    }).where(eq(remindersTable.id, reminder.id)).returning();
    await tx.insert(auditLogTable).values(auditValues(
      actor, "staff_confirmed_sent", "reminder", updated.id,
      `Staff ${actor.id} confirmed manual sending of reminder ${updated.id}; delivery is not provider-verified`,
    ));
    return { reminder: updated };
  });
  if ("error" in result) {
    const errors = {
      not_found: [404, "Reminder not found"],
      not_draft: [409, "Only draft reminders can be marked as manually sent"],
      blocked: [409, "Consent withdrawal or appointment cancellation blocks sending this draft"],
    } as const;
    const [status, message] = errors[result.error as keyof typeof errors];
    res.status(status).json({ error: message });
    return;
  }
  res.json(MarkReminderSentResponse.parse(reminderDto(result.reminder)));
});

export default router;