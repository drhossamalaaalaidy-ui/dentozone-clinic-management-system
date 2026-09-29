import { check, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const financeCorrectionsTable = pgTable("finance_corrections", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  invoiceId: integer("invoice_id").notNull(),
  reason: text("reason").notNull(),
  beforeSnapshot: jsonb("before_snapshot").$type<Record<string, unknown>>().notNull(),
  afterSnapshot: jsonb("after_snapshot").$type<Record<string, unknown>>().notNull(),
  actorStaffId: integer("actor_staff_id"),
  actorName: text("actor_name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("finance_correction_entity_type_valid", sql`${table.entityType} IN ('invoice', 'payment')`),
  uniqueIndex("finance_correction_entity_unique").on(table.entityType, table.entityId),
]);

export type FinanceCorrection = typeof financeCorrectionsTable.$inferSelect;