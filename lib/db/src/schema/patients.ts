import { boolean, date, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const patientsTable = pgTable("patients", {
  id: serial("id").primaryKey(),
  fullName: text("full_name").notNull(),
  gender: text("gender").$type<"female" | "male" | "other" | "undisclosed">().notNull(),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  phone: text("phone").notNull(),
  whatsapp: text("whatsapp"),
  email: text("email"),
  address: text("address"),
  emergencyContact: text("emergency_contact"),
  occupation: text("occupation"),
  referralSource: text("referral_source"),
  status: text("status").$type<"active" | "inactive" | "archived">().notNull().default("active"),
  registrationDate: timestamp("registration_date", { withTimezone: true }).notNull().defaultNow(),
  allergies: text("allergies"),
  medications: text("medications"),
  medicalConditions: text("medical_conditions"),
  previousSurgeries: text("previous_surgeries"),
  diabetes: boolean("diabetes").notNull().default(false),
  hypertension: boolean("hypertension").notNull().default(false),
  heartDisease: boolean("heart_disease").notNull().default(false),
  bleedingDisorders: boolean("bleeding_disorders").notNull().default(false),
  pregnancy: boolean("pregnancy").notNull().default(false),
  smoking: boolean("smoking").notNull().default(false),
  previousDentalTreatment: text("previous_dental_treatment"),
  previousOrthodonticTreatment: text("previous_orthodontic_treatment"),
  oralHygiene: text("oral_hygiene"),
  dentalComplaints: text("dental_complaints"),
  previousDentist: text("previous_dentist"),
  notes: text("notes"),
  isDemo: boolean("is_demo").notNull().default(false),
});

export const insertPatientSchema = createInsertSchema(patientsTable).omit({
  id: true, registrationDate: true,
});
export type InsertPatient = z.infer<typeof insertPatientSchema>;
export type Patient = typeof patientsTable.$inferSelect;