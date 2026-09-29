import { boolean, check, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { staffTable } from "./staff";
import { suppliersTable } from "./finance";

export const inventoryItemsTable = pgTable("inventory_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  sku: text("sku").notNull(),
  unit: text("unit").notNull(),
  quantityOnHand: integer("quantity_on_hand").notNull().default(0),
  reorderLevel: integer("reorder_level").notNull().default(0),
  unitCostCents: integer("unit_cost_cents"),
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  active: boolean("active").notNull().default(true),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  unique("inventory_sku_unique").on(table.sku),
  check("inventory_quantity_nonnegative", sql`${table.quantityOnHand} >= 0`),
  check("inventory_reorder_nonnegative", sql`${table.reorderLevel} >= 0`),
  check("inventory_cost_nonnegative", sql`${table.unitCostCents} IS NULL OR ${table.unitCostCents} >= 0`),
]);

export const stockMovementsTable = pgTable("stock_movements", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => inventoryItemsTable.id),
  delta: integer("delta").notNull(),
  reason: text("reason").notNull(),
  note: text("note"),
  staffId: integer("staff_id").references(() => staffTable.id),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("stock_movement_nonzero", sql`${table.delta} <> 0`),
]);

export const insertInventoryItemSchema = createInsertSchema(inventoryItemsTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InventoryItem = typeof inventoryItemsTable.$inferSelect;
export type InsertInventoryItem = z.infer<typeof insertInventoryItemSchema>;
export const insertStockMovementSchema = createInsertSchema(stockMovementsTable).omit({
  id: true, occurredAt: true,
});
export type StockMovement = typeof stockMovementsTable.$inferSelect;
export type InsertStockMovement = z.infer<typeof insertStockMovementSchema>;