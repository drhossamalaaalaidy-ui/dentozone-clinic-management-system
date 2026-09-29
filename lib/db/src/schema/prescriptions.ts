import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { patientsTable } from "./patients";
import { staffTable } from "./staff";
import { visitsTable } from "./clinical";

export const prescriptionsTable = pgTable("clinical_prescriptions", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  visitId: integer("visit_id").references(() => visitsTable.id),
  authorDentistStaffId: integer("author_dentist_staff_id").notNull().references(() => staffTable.id),
  createdByStaffId: integer("created_by_staff_id").notNull().references(() => staffTable.id),
  medication: text("medication").notNull(),
  dose: text("dose").notNull(),
  route: text("route").notNull(),
  frequency: text("frequency").notNull(),
  duration: text("duration").notNull(),
  instructions: text("instructions").notNull(),
  issuedDate: date("issued_date", { mode: "string" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  index("clinical_prescriptions_patient_id_idx").on(table.patientId),
  index("clinical_prescriptions_visit_id_idx").on(table.visitId),
]);

export const prescriptionAmendmentsTable = pgTable("prescription_amendments", {
  id: serial("id").primaryKey(),
  prescriptionId: integer("prescription_id").notNull().references(() => prescriptionsTable.id),
  amendedByStaffId: integer("amended_by_staff_id").notNull().references(() => staffTable.id),
  amendmentType: text("amendment_type").notNull(),
  reason: text("reason").notNull(),
  replacement: jsonb("replacement").$type<{
    medication: string;
    dose: string;
    route: string;
    frequency: string;
    duration: string;
    instructions: string;
  } | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("prescription_amendments_prescription_id_idx").on(table.prescriptionId),
  check("prescription_amendments_type_valid", sql`${table.amendmentType} IN ('correction', 'void')`),
  check("prescription_amendments_replacement_valid", sql`(
    (${table.amendmentType} = 'correction' AND ${table.replacement} IS NOT NULL)
    OR (${table.amendmentType} = 'void' AND ${table.replacement} IS NULL)
  )`),
]);

export const insertPrescriptionSchema = createInsertSchema(prescriptionsTable).omit({
  id: true, createdAt: true,
});
export const insertPrescriptionAmendmentSchema = createInsertSchema(prescriptionAmendmentsTable).omit({
  id: true, createdAt: true,
});
export type InsertPrescription = z.infer<typeof insertPrescriptionSchema>;
export type InsertPrescriptionAmendment = z.infer<typeof insertPrescriptionAmendmentSchema>;
export type Prescription = typeof prescriptionsTable.$inferSelect;
export type PrescriptionAmendment = typeof prescriptionAmendmentsTable.$inferSelect;