import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { appointmentsTable } from "./appointments";
import { patientsTable } from "./patients";
import { staffTable } from "./staff";
import { visitsTable } from "./clinical";

export const patientDocumentsTable = pgTable("patient_documents", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  visitId: integer("visit_id").references(() => visitsTable.id),
  kind: text("kind").notNull(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  objectKey: text("object_key").notNull(),
  status: text("status").notNull().default("pending"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  createdByStaffId: integer("created_by_staff_id").notNull().references(() => staffTable.id),
  updatedByStaffId: integer("updated_by_staff_id").references(() => staffTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  index("patient_documents_patient_id_idx").on(table.patientId),
  index("patient_documents_visit_id_idx").on(table.visitId),
  index("patient_documents_status_idx").on(table.status),
  unique("patient_documents_object_key_unique").on(table.objectKey),
  check("patient_documents_kind_valid", sql`${table.kind} IN ('consent', 'form', 'photo', 'xray', 'other')`),
  check("patient_documents_content_type_valid", sql`${table.contentType} IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')`),
  check("patient_documents_size_positive", sql`${table.sizeBytes} > 0`),
  check("patient_documents_filename_safe", sql`length(${table.filename}) > 0 AND position('/' in ${table.filename}) = 0 AND position(chr(92) in ${table.filename}) = 0 AND ${table.filename} NOT IN ('.', '..')`),
  check("patient_documents_status_valid", sql`${table.status} IN ('pending', 'active', 'withdrawn')`),
]);
export const insertPatientDocumentSchema = createInsertSchema(patientDocumentsTable).omit({ id: true });
export type InsertPatientDocument = z.infer<typeof insertPatientDocumentSchema>;
export type PatientDocument = typeof patientDocumentsTable.$inferSelect;

export const orthodonticCasesTable = pgTable("orthodontic_cases", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  title: text("title").notNull(),
  goal: text("goal").notNull(),
  appliance: text("appliance").notNull(),
  doctorStaffId: integer("doctor_staff_id").notNull().references(() => staffTable.id),
  status: text("status").notNull().default("active"),
  nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  index("orthodontic_cases_patient_id_idx").on(table.patientId),
  index("orthodontic_cases_doctor_staff_id_idx").on(table.doctorStaffId),
  index("orthodontic_cases_status_idx").on(table.status),
  check("orthodontic_cases_status_valid", sql`${table.status} IN ('active', 'paused', 'completed')`),
]);
export const insertOrthodonticCaseSchema = createInsertSchema(orthodonticCasesTable).omit({ id: true });
export type InsertOrthodonticCase = z.infer<typeof insertOrthodonticCaseSchema>;
export type OrthodonticCase = typeof orthodonticCasesTable.$inferSelect;

export const orthodonticProgressTable = pgTable("orthodontic_progress", {
  id: serial("id").primaryKey(),
  caseId: integer("case_id").notNull().references(() => orthodonticCasesTable.id),
  note: text("note").notNull(),
  phase: text("phase").notNull(),
  visitId: integer("visit_id").references(() => visitsTable.id),
  nextReviewAt: timestamp("next_review_at", { withTimezone: true }),
  authorStaffId: integer("author_staff_id").notNull().references(() => staffTable.id),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  index("orthodontic_progress_case_id_idx").on(table.caseId),
  index("orthodontic_progress_visit_id_idx").on(table.visitId),
  index("orthodontic_progress_author_staff_id_idx").on(table.authorStaffId),
]);
export const insertOrthodonticProgressSchema = createInsertSchema(orthodonticProgressTable).omit({ id: true });
export type InsertOrthodonticProgress = z.infer<typeof insertOrthodonticProgressSchema>;
export type OrthodonticProgress = typeof orthodonticProgressTable.$inferSelect;

export const reminderPreferencesTable = pgTable("reminder_preferences", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  optIn: boolean("opt_in").notNull().default(false),
  channel: text("channel").notNull(),
  consentRecordedAt: timestamp("consent_recorded_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  unique("reminder_preferences_patient_id_unique").on(table.patientId),
  check("reminder_preferences_channel_valid", sql`${table.channel} IN ('whatsapp', 'sms', 'email')`),
]);
export const insertReminderPreferencesSchema = createInsertSchema(reminderPreferencesTable).omit({ id: true });
export type InsertReminderPreferences = z.infer<typeof insertReminderPreferencesSchema>;
export type ReminderPreferences = typeof reminderPreferencesTable.$inferSelect;

export const reminderTemplatesTable = pgTable("reminder_templates", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  bodyEn: text("body_en").notNull(),
  bodyAr: text("body_ar").notNull(),
  channel: text("channel").notNull(),
  active: boolean("active").notNull().default(true),
  createdByStaffId: integer("created_by_staff_id").notNull().references(() => staffTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  index("reminder_templates_active_idx").on(table.active),
  check("reminder_templates_channel_valid", sql`${table.channel} IN ('whatsapp', 'sms', 'email')`),
]);
export const insertReminderTemplateSchema = createInsertSchema(reminderTemplatesTable).omit({ id: true });
export type InsertReminderTemplate = z.infer<typeof insertReminderTemplateSchema>;
export type ReminderTemplate = typeof reminderTemplatesTable.$inferSelect;

export const remindersTable = pgTable("reminders", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  appointmentId: integer("appointment_id").notNull().references(() => appointmentsTable.id),
  templateId: integer("template_id").notNull().references(() => reminderTemplatesTable.id),
  renderedMessage: text("rendered_message").notNull(),
  channel: text("channel").notNull(),
  status: text("status").notNull().default("draft"),
  createdByStaffId: integer("created_by_staff_id").notNull().references(() => staffTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentByStaffId: integer("sent_by_staff_id").references(() => staffTable.id),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  index("reminders_patient_id_idx").on(table.patientId),
  index("reminders_appointment_id_idx").on(table.appointmentId),
  index("reminders_status_idx").on(table.status),
  index("reminders_created_at_idx").on(table.createdAt),
  check("reminders_channel_valid", sql`${table.channel} IN ('whatsapp', 'sms', 'email')`),
  check("reminders_status_valid", sql`${table.status} IN ('draft', 'staff_confirmed_sent', 'cancelled')`),
  check("reminders_sent_metadata_consistent", sql`(${table.status} = 'staff_confirmed_sent' AND ${table.sentByStaffId} IS NOT NULL AND ${table.sentAt} IS NOT NULL) OR (${table.status} <> 'staff_confirmed_sent' AND ${table.sentByStaffId} IS NULL AND ${table.sentAt} IS NULL)`),
]);
export const insertReminderSchema = createInsertSchema(remindersTable).omit({ id: true });
export type InsertReminder = z.infer<typeof insertReminderSchema>;
export type Reminder = typeof remindersTable.$inferSelect;