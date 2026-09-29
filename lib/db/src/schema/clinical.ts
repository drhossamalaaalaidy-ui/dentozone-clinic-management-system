import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { appointmentsTable } from "./appointments";
import { patientsTable } from "./patients";
import { staffTable } from "./staff";

export const visitsTable = pgTable("visits", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  appointmentId: integer("appointment_id").references(() => appointmentsTable.id),
  doctorStaffId: integer("doctor_staff_id").notNull().references(() => staffTable.id),
  status: text("status").notNull().default("draft"),
  complaint: text("complaint"),
  notes: text("notes"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  unique("visits_appointment_id_unique").on(table.appointmentId),
  index("visits_patient_id_idx").on(table.patientId),
  check("visits_status_valid", sql`${table.status} IN ('draft', 'completed')`),
]);
export const insertVisitSchema = createInsertSchema(visitsTable).omit({ id: true });
export type InsertVisit = z.infer<typeof insertVisitSchema>;
export type Visit = typeof visitsTable.$inferSelect;

export const visitDiagnosesTable = pgTable("visit_diagnoses", {
  id: serial("id").primaryKey(),
  visitId: integer("visit_id").notNull().references(() => visitsTable.id),
  label: text("label").notNull(),
  code: text("code"),
  toothCode: text("tooth_code"),
  notes: text("notes"),
  recordedByStaffId: integer("recorded_by_staff_id").notNull().references(() => staffTable.id),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("visit_diagnoses_visit_id_idx").on(table.visitId),
]);
export const insertVisitDiagnosisSchema = createInsertSchema(visitDiagnosesTable).omit({ id: true });
export type InsertVisitDiagnosis = z.infer<typeof insertVisitDiagnosisSchema>;
export type VisitDiagnosis = typeof visitDiagnosesTable.$inferSelect;

export const visitProceduresTable = pgTable("visit_procedures", {
  id: serial("id").primaryKey(),
  visitId: integer("visit_id").notNull().references(() => visitsTable.id),
  label: text("label").notNull(),
  toothCode: text("tooth_code"),
  notes: text("notes"),
  recordedByStaffId: integer("recorded_by_staff_id").notNull().references(() => staffTable.id),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("visit_procedures_visit_id_idx").on(table.visitId),
]);
export const insertVisitProcedureSchema = createInsertSchema(visitProceduresTable).omit({ id: true });
export type InsertVisitProcedure = z.infer<typeof insertVisitProcedureSchema>;
export type VisitProcedure = typeof visitProceduresTable.$inferSelect;

export const odontogramEntriesTable = pgTable("odontogram_entries", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  dentition: text("dentition").notNull(),
  toothCode: text("tooth_code").notNull(),
  condition: text("condition").notNull(),
  surfaces: text("surfaces").array().notNull().default([]),
  notes: text("notes"),
  recordedByStaffId: integer("recorded_by_staff_id").notNull().references(() => staffTable.id),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("odontogram_entries_patient_id_idx").on(table.patientId),
  check("odontogram_dentition_valid", sql`${table.dentition} IN ('adult', 'child')`),
  check("odontogram_condition_valid", sql`${table.condition} IN ('healthy', 'caries', 'filled', 'crown', 'missing', 'root_canal', 'implant', 'extraction_needed', 'unerupted', 'other')`),
]);
export const insertOdontogramEntrySchema = createInsertSchema(odontogramEntriesTable).omit({ id: true });
export type InsertOdontogramEntry = z.infer<typeof insertOdontogramEntrySchema>;
export type OdontogramEntry = typeof odontogramEntriesTable.$inferSelect;

export const treatmentPlansTable = pgTable("treatment_plans", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  title: text("title").notNull(),
  goal: text("goal"),
  status: text("status").notNull().default("draft"),
  createdByStaffId: integer("created_by_staff_id").notNull().references(() => staffTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  index("treatment_plans_patient_id_idx").on(table.patientId),
  check("treatment_plans_status_valid", sql`${table.status} IN ('draft', 'active', 'completed', 'cancelled')`),
]);
export const insertTreatmentPlanSchema = createInsertSchema(treatmentPlansTable).omit({ id: true });
export type InsertTreatmentPlan = z.infer<typeof insertTreatmentPlanSchema>;
export type TreatmentPlan = typeof treatmentPlansTable.$inferSelect;

export const treatmentPlanItemsTable = pgTable("treatment_plan_items", {
  id: serial("id").primaryKey(),
  planId: integer("plan_id").notNull().references(() => treatmentPlansTable.id),
  description: text("description").notNull(),
  toothCode: text("tooth_code"),
  priority: integer("priority").notNull().default(2),
  status: text("status").notNull().default("pending"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("treatment_plan_items_plan_id_idx").on(table.planId),
  check("treatment_plan_items_priority_valid", sql`${table.priority} BETWEEN 1 AND 3`),
  check("treatment_plan_items_status_valid", sql`${table.status} IN ('pending', 'in_progress', 'completed')`),
]);
export const insertTreatmentPlanItemSchema = createInsertSchema(treatmentPlanItemsTable).omit({ id: true });
export type InsertTreatmentPlanItem = z.infer<typeof insertTreatmentPlanItemSchema>;
export type TreatmentPlanItem = typeof treatmentPlanItemsTable.$inferSelect;