import { integer, pgTable, serial, text, timestamp, boolean, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { patientsTable } from "./patients";

export const appointmentsTable = pgTable("appointments", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  doctorStaffId: integer("doctor_staff_id"),
  doctorName: text("doctor_name").notNull(),
  chair: text("chair"),
  treatment: text("treatment").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("scheduled"),
  notes: text("notes"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  check("appointments_ends_after_starts", sql`${table.endsAt} > ${table.startsAt}`),
]);

export const insertAppointmentSchema = createInsertSchema(appointmentsTable).omit({
  id: true,
});
export type Appointment = typeof appointmentsTable.$inferSelect;