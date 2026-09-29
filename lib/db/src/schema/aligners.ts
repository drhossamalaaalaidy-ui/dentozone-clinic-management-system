import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { orthodonticCasesTable } from "./operations";
import { patientsTable } from "./patients";
import { staffTable } from "./staff";
import { visitsTable } from "./clinical";

export const alignerCoursesTable = pgTable("aligner_courses", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  caseId: integer("case_id").notNull().references(() => orthodonticCasesTable.id),
  title: text("title").notNull(),
  createdByStaffId: integer("created_by_staff_id").notNull().references(() => staffTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  unique("aligner_courses_case_id_unique").on(table.caseId),
  index("aligner_courses_patient_id_idx").on(table.patientId),
  check("aligner_courses_title_nonempty", sql`length(trim(${table.title})) > 0`),
]);
export const insertAlignerCourseSchema = createInsertSchema(alignerCoursesTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertAlignerCourse = z.infer<typeof insertAlignerCourseSchema>;
export type AlignerCourse = typeof alignerCoursesTable.$inferSelect;

export const alignerTraysTable = pgTable("aligner_trays", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => alignerCoursesTable.id),
  sequence: integer("sequence").notNull(),
  plannedDate: date("planned_date", { mode: "string" }),
  deliveredDate: date("delivered_date", { mode: "string" }),
  status: text("status").notNull().default("planned"),
  wearNotes: text("wear_notes"),
  visitId: integer("visit_id").references(() => visitsTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  unique("aligner_trays_course_sequence_unique").on(table.courseId, table.sequence),
  index("aligner_trays_course_id_idx").on(table.courseId),
  check("aligner_trays_sequence_positive", sql`${table.sequence} > 0`),
  check("aligner_trays_status_valid", sql`${table.status} IN ('planned', 'delivered', 'wearing', 'completed', 'paused')`),
  check("aligner_trays_dates_ordered", sql`${table.plannedDate} IS NULL OR ${table.deliveredDate} IS NULL OR ${table.deliveredDate} >= ${table.plannedDate}`),
]);
export const insertAlignerTraySchema = createInsertSchema(alignerTraysTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertAlignerTray = z.infer<typeof insertAlignerTraySchema>;
export type AlignerTray = typeof alignerTraysTable.$inferSelect;