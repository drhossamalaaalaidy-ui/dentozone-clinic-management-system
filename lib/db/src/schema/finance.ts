import { boolean, check, date, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { patientsTable } from "./patients";

export const suppliersTable = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  isDemo: boolean("is_demo").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  totalCents: integer("total_cents").notNull(),
  paidCents: integer("paid_cents").notNull().default(0),
  status: text("status").notNull().default("unpaid"),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  dueDate: date("due_date", { mode: "string" }),
  notes: text("notes"),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  check("invoice_total_positive", sql`${table.totalCents} > 0`),
  check("invoice_paid_valid", sql`${table.paidCents} >= 0 AND ${table.paidCents} <= ${table.totalCents}`),
]);

export const invoiceItemsTable = pgTable("invoice_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoicesTable.id),
  description: text("description").notNull(),
  quantity: integer("quantity").notNull(),
  unitPriceCents: integer("unit_price_cents").notNull(),
  totalCents: integer("total_cents").notNull(),
}, (table) => [
  check("invoice_item_quantity_positive", sql`${table.quantity} > 0`),
  check("invoice_item_price_nonnegative", sql`${table.unitPriceCents} >= 0 AND ${table.totalCents} >= 0`),
]);

export const installmentsTable = pgTable("installments", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoicesTable.id),
  dueDate: date("due_date", { mode: "string" }).notNull(),
  amountCents: integer("amount_cents").notNull(),
  paidCents: integer("paid_cents").notNull().default(0),
}, (table) => [
  check("installment_amount_positive", sql`${table.amountCents} > 0`),
  check("installment_paid_valid", sql`${table.paidCents} >= 0 AND ${table.paidCents} <= ${table.amountCents}`),
]);

export const paymentsTable = pgTable("payments", {
  id: serial("id").primaryKey(),
  patientId: integer("patient_id").notNull().references(() => patientsTable.id),
  invoiceId: integer("invoice_id").references(() => invoicesTable.id),
  installmentId: integer("installment_id").references(() => installmentsTable.id),
  amountCents: integer("amount_cents").notNull(),
  method: text("method").notNull(),
  reference: text("reference"),
  notes: text("notes"),
  paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  check("payment_amount_positive", sql`${table.amountCents} > 0`),
]);

export const expensesTable = pgTable("expenses", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  supplier: text("supplier"),
  supplierId: integer("supplier_id").references(() => suppliersTable.id),
  amountCents: integer("amount_cents").notNull(),
  notes: text("notes"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  isDemo: boolean("is_demo").notNull().default(false),
}, (table) => [
  check("expense_amount_positive", sql`${table.amountCents} > 0`),
]);

export const insertSupplierSchema = createInsertSchema(suppliersTable).omit({ id: true, createdAt: true });
export type Supplier = typeof suppliersTable.$inferSelect;
export type InsertSupplier = z.infer<typeof insertSupplierSchema>;
export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({ id: true, issuedAt: true });
export type Invoice = typeof invoicesTable.$inferSelect;
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({ id: true, paidAt: true });
export type Payment = typeof paymentsTable.$inferSelect;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export const insertExpenseSchema = createInsertSchema(expensesTable).omit({ id: true, occurredAt: true });
export type Expense = typeof expensesTable.$inferSelect;
export type InsertExpense = z.infer<typeof insertExpenseSchema>;