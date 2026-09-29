import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const clinicSettingsTable = pgTable("clinic_settings", {
  id: serial("id").primaryKey(),
  clinicName: text("clinic_name").notNull().default("DentOzone"),
  address: text("address").notNull().default("New Cairo, Fifth Settlement, Egypt"),
  phone: text("phone").notNull().default(""),
  whatsapp: text("whatsapp"),
  email: text("email"),
  currency: text("currency").notNull().default("EGP"),
  language: text("language").$type<"en" | "ar">().notNull().default("en"),
  timezone: text("timezone").notNull().default("Africa/Cairo"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertClinicSettingsSchema = createInsertSchema(clinicSettingsTable).omit({
  id: true, updatedAt: true,
});
export type ClinicSettings = typeof clinicSettingsTable.$inferSelect;