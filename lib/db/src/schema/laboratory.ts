import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { patientsTable } from "./patients";
import { staffTable } from "./staff";
import { suppliersTable } from "./finance";
import { visitsTable } from "./clinical";

export const laboratoryOrdersTable = pgTable("laboratory_orders", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  visitId: integer("visit_id").references(() => visitsTable.id),
  labName: text("lab_name").notNull(),
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  caseType: text("case_type").notNull(),
  dueDate: date("due_date", { mode: "string" }),
  status: text("status").notNull().default("submitted"),
  notes: text("notes"),
  createdByStaffId: integer("created_by_staff_id").notNull().references(() => staffTable.id),
  updatedByStaffId: integer("updated_by_staff_id").references(() => staffTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  index("laboratory_orders_patient_id_idx").on(table.patientId),
  index("laboratory_orders_visit_id_idx").on(table.visitId),
  index("laboratory_orders_supplier_id_idx").on(table.supplierId),
  index("laboratory_orders_status_idx").on(table.status),
  index("laboratory_orders_due_date_idx").on(table.dueDate),
  check("laboratory_orders_lab_name_nonempty", sql`length(trim(${table.labName})) > 0`),
  check("laboratory_orders_case_type_valid", sql`${table.caseType} IN ('crown', 'bridge', 'denture', 'implant', 'orthodontic', 'other')`),
  check("laboratory_orders_status_valid", sql`${table.status} IN ('submitted', 'in_progress', 'ready', 'delivered', 'cancelled')`),
]);
export const insertLaboratoryOrderSchema = createInsertSchema(laboratoryOrdersTable).omit({ id: true });
export type InsertLaboratoryOrder = z.infer<typeof insertLaboratoryOrderSchema>;
export type LaboratoryOrder = typeof laboratoryOrdersTable.$inferSelect;

export const laboratoryOrderHistoryTable = pgTable("laboratory_order_history", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().references(() => laboratoryOrdersTable.id),
  actorStaffId: integer("actor_staff_id").notNull().references(() => staffTable.id),
  actorName: text("actor_name").notNull(),
  action: text("action").notNull(),
  before: jsonb("before").$type<Record<string, unknown> | null>(),
  after: jsonb("after").$type<Record<string, unknown>>().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("laboratory_order_history_order_id_idx").on(table.orderId),
  index("laboratory_order_history_actor_staff_id_idx").on(table.actorStaffId),
  check("laboratory_order_history_action_valid", sql`${table.action} IN ('create', 'update', 'cancel')`),
]);
export const insertLaboratoryOrderHistorySchema = createInsertSchema(laboratoryOrderHistoryTable).omit({ id: true });
export type InsertLaboratoryOrderHistory = z.infer<typeof insertLaboratoryOrderHistorySchema>;
export type LaboratoryOrderHistory = typeof laboratoryOrderHistoryTable.$inferSelect;