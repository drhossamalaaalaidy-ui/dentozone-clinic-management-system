CREATE TABLE "clinic_staff" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_staff_clerk_user_id_unique" UNIQUE("clerk_user_id"),
	CONSTRAINT "clinic_staff_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" serial PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"gender" text NOT NULL,
	"date_of_birth" date,
	"phone" text NOT NULL,
	"whatsapp" text,
	"email" text,
	"address" text,
	"emergency_contact" text,
	"occupation" text,
	"referral_source" text,
	"status" text DEFAULT 'active' NOT NULL,
	"registration_date" timestamp with time zone DEFAULT now() NOT NULL,
	"allergies" text,
	"medications" text,
	"medical_conditions" text,
	"previous_surgeries" text,
	"diabetes" boolean DEFAULT false NOT NULL,
	"hypertension" boolean DEFAULT false NOT NULL,
	"heart_disease" boolean DEFAULT false NOT NULL,
	"bleeding_disorders" boolean DEFAULT false NOT NULL,
	"pregnancy" boolean DEFAULT false NOT NULL,
	"smoking" boolean DEFAULT false NOT NULL,
	"previous_dental_treatment" text,
	"previous_orthodontic_treatment" text,
	"oral_hygiene" text,
	"dental_complaints" text,
	"previous_dentist" text,
	"notes" text,
	"is_demo" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinic_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"clinic_name" text DEFAULT 'DentOzone' NOT NULL,
	"address" text DEFAULT 'New Cairo, Fifth Settlement, Egypt' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"whatsapp" text,
	"email" text,
	"currency" text DEFAULT 'EGP' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'Africa/Cairo' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinic_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"actor_staff_id" integer,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer,
	"summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"doctor_staff_id" integer,
	"doctor_name" text NOT NULL,
	"chair" text,
	"treatment" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"notes" text,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "appointments_ends_after_starts" CHECK ("appointments"."ends_at" > "appointments"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "odontogram_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"dentition" text NOT NULL,
	"tooth_code" text NOT NULL,
	"condition" text NOT NULL,
	"surfaces" text[] DEFAULT '{}' NOT NULL,
	"notes" text,
	"recorded_by_staff_id" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "odontogram_dentition_valid" CHECK ("odontogram_entries"."dentition" IN ('adult', 'child')),
	CONSTRAINT "odontogram_condition_valid" CHECK ("odontogram_entries"."condition" IN ('healthy', 'caries', 'filled', 'crown', 'missing', 'root_canal', 'implant', 'extraction_needed', 'unerupted', 'other'))
);
--> statement-breakpoint
CREATE TABLE "treatment_plan_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" integer NOT NULL,
	"description" text NOT NULL,
	"tooth_code" text,
	"priority" integer DEFAULT 2 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "treatment_plan_items_priority_valid" CHECK ("treatment_plan_items"."priority" BETWEEN 1 AND 3),
	CONSTRAINT "treatment_plan_items_status_valid" CHECK ("treatment_plan_items"."status" IN ('pending', 'in_progress', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "treatment_plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"title" text NOT NULL,
	"goal" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_staff_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "treatment_plans_status_valid" CHECK ("treatment_plans"."status" IN ('draft', 'active', 'completed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "visit_diagnoses" (
	"id" serial PRIMARY KEY NOT NULL,
	"visit_id" integer NOT NULL,
	"label" text NOT NULL,
	"code" text,
	"tooth_code" text,
	"notes" text,
	"recorded_by_staff_id" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visit_procedures" (
	"id" serial PRIMARY KEY NOT NULL,
	"visit_id" integer NOT NULL,
	"label" text NOT NULL,
	"tooth_code" text,
	"notes" text,
	"recorded_by_staff_id" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"appointment_id" integer,
	"doctor_staff_id" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"complaint" text,
	"notes" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "visits_appointment_id_unique" UNIQUE("appointment_id"),
	CONSTRAINT "visits_status_valid" CHECK ("visits"."status" IN ('draft', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"supplier" text,
	"supplier_id" integer,
	"amount_cents" integer NOT NULL,
	"notes" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "expense_amount_positive" CHECK ("expenses"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "installments" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"due_date" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "installment_amount_positive" CHECK ("installments"."amount_cents" > 0),
	CONSTRAINT "installment_paid_valid" CHECK ("installments"."paid_cents" >= 0 AND "installments"."paid_cents" <= "installments"."amount_cents")
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	CONSTRAINT "invoice_item_quantity_positive" CHECK ("invoice_items"."quantity" > 0),
	CONSTRAINT "invoice_item_price_nonnegative" CHECK ("invoice_items"."unit_price_cents" >= 0 AND "invoice_items"."total_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'unpaid' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_date" date,
	"notes" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "invoice_total_positive" CHECK ("invoices"."total_cents" > 0),
	CONSTRAINT "invoice_paid_valid" CHECK ("invoices"."paid_cents" >= 0 AND "invoices"."paid_cents" <= "invoices"."total_cents")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"invoice_id" integer,
	"installment_id" integer,
	"amount_cents" integer NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"notes" text,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "payment_amount_positive" CHECK ("payments"."amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sku" text NOT NULL,
	"unit" text NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"reorder_level" integer DEFAULT 0 NOT NULL,
	"unit_cost_cents" integer,
	"supplier_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_sku_unique" UNIQUE("sku"),
	CONSTRAINT "inventory_quantity_nonnegative" CHECK ("inventory_items"."quantity_on_hand" >= 0),
	CONSTRAINT "inventory_reorder_nonnegative" CHECK ("inventory_items"."reorder_level" >= 0),
	CONSTRAINT "inventory_cost_nonnegative" CHECK ("inventory_items"."unit_cost_cents" IS NULL OR "inventory_items"."unit_cost_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"staff_id" integer,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movement_nonzero" CHECK ("stock_movements"."delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "orthodontic_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"title" text NOT NULL,
	"goal" text NOT NULL,
	"appliance" text NOT NULL,
	"doctor_staff_id" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_review_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "orthodontic_cases_status_valid" CHECK ("orthodontic_cases"."status" IN ('active', 'paused', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "orthodontic_progress" (
	"id" serial PRIMARY KEY NOT NULL,
	"case_id" integer NOT NULL,
	"note" text NOT NULL,
	"phase" text NOT NULL,
	"visit_id" integer,
	"next_review_at" timestamp with time zone,
	"author_staff_id" integer NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"visit_id" integer,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"signed_at" timestamp with time zone,
	"created_by_staff_id" integer NOT NULL,
	"updated_by_staff_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "patient_documents_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "patient_documents_kind_valid" CHECK ("patient_documents"."kind" IN ('consent', 'form', 'photo', 'xray', 'other')),
	CONSTRAINT "patient_documents_content_type_valid" CHECK ("patient_documents"."content_type" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "patient_documents_size_positive" CHECK ("patient_documents"."size_bytes" > 0),
	CONSTRAINT "patient_documents_filename_safe" CHECK (length("patient_documents"."filename") > 0 AND position('/' in "patient_documents"."filename") = 0 AND position(chr(92) in "patient_documents"."filename") = 0 AND "patient_documents"."filename" NOT IN ('.', '..')),
	CONSTRAINT "patient_documents_status_valid" CHECK ("patient_documents"."status" IN ('pending', 'active', 'withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "reminder_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"opt_in" boolean DEFAULT false NOT NULL,
	"channel" text NOT NULL,
	"consent_recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "reminder_preferences_patient_id_unique" UNIQUE("patient_id"),
	CONSTRAINT "reminder_preferences_channel_valid" CHECK ("reminder_preferences"."channel" IN ('whatsapp', 'sms', 'email'))
);
--> statement-breakpoint
CREATE TABLE "reminder_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body_en" text NOT NULL,
	"body_ar" text NOT NULL,
	"channel" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_staff_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "reminder_templates_channel_valid" CHECK ("reminder_templates"."channel" IN ('whatsapp', 'sms', 'email'))
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"appointment_id" integer NOT NULL,
	"template_id" integer NOT NULL,
	"rendered_message" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_staff_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_by_staff_id" integer,
	"sent_at" timestamp with time zone,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "reminders_channel_valid" CHECK ("reminders"."channel" IN ('whatsapp', 'sms', 'email')),
	CONSTRAINT "reminders_status_valid" CHECK ("reminders"."status" IN ('draft', 'staff_confirmed_sent', 'cancelled')),
	CONSTRAINT "reminders_sent_metadata_consistent" CHECK (("reminders"."status" = 'staff_confirmed_sent' AND "reminders"."sent_by_staff_id" IS NOT NULL AND "reminders"."sent_at" IS NOT NULL) OR ("reminders"."status" <> 'staff_confirmed_sent' AND "reminders"."sent_by_staff_id" IS NULL AND "reminders"."sent_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odontogram_entries" ADD CONSTRAINT "odontogram_entries_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odontogram_entries" ADD CONSTRAINT "odontogram_entries_recorded_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("recorded_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_plan_id_treatment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."treatment_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_created_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_diagnoses" ADD CONSTRAINT "visit_diagnoses_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_diagnoses" ADD CONSTRAINT "visit_diagnoses_recorded_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("recorded_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_procedures" ADD CONSTRAINT "visit_procedures_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_procedures" ADD CONSTRAINT "visit_procedures_recorded_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("recorded_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visits" ADD CONSTRAINT "visits_doctor_staff_id_clinic_staff_id_fk" FOREIGN KEY ("doctor_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installments" ADD CONSTRAINT "installments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_installment_id_installments_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."installments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_inventory_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_staff_id_clinic_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orthodontic_cases" ADD CONSTRAINT "orthodontic_cases_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orthodontic_cases" ADD CONSTRAINT "orthodontic_cases_doctor_staff_id_clinic_staff_id_fk" FOREIGN KEY ("doctor_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orthodontic_progress" ADD CONSTRAINT "orthodontic_progress_case_id_orthodontic_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."orthodontic_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orthodontic_progress" ADD CONSTRAINT "orthodontic_progress_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orthodontic_progress" ADD CONSTRAINT "orthodontic_progress_author_staff_id_clinic_staff_id_fk" FOREIGN KEY ("author_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_created_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_updated_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("updated_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_preferences" ADD CONSTRAINT "reminder_preferences_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_templates" ADD CONSTRAINT "reminder_templates_created_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_template_id_reminder_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."reminder_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_created_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_sent_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("sent_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "odontogram_entries_patient_id_idx" ON "odontogram_entries" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "treatment_plan_items_plan_id_idx" ON "treatment_plan_items" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "treatment_plans_patient_id_idx" ON "treatment_plans" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "visit_diagnoses_visit_id_idx" ON "visit_diagnoses" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "visit_procedures_visit_id_idx" ON "visit_procedures" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "visits_patient_id_idx" ON "visits" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "orthodontic_cases_patient_id_idx" ON "orthodontic_cases" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "orthodontic_cases_doctor_staff_id_idx" ON "orthodontic_cases" USING btree ("doctor_staff_id");--> statement-breakpoint
CREATE INDEX "orthodontic_cases_status_idx" ON "orthodontic_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orthodontic_progress_case_id_idx" ON "orthodontic_progress" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "orthodontic_progress_visit_id_idx" ON "orthodontic_progress" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "orthodontic_progress_author_staff_id_idx" ON "orthodontic_progress" USING btree ("author_staff_id");--> statement-breakpoint
CREATE INDEX "patient_documents_patient_id_idx" ON "patient_documents" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "patient_documents_visit_id_idx" ON "patient_documents" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "patient_documents_status_idx" ON "patient_documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reminder_templates_active_idx" ON "reminder_templates" USING btree ("active");--> statement-breakpoint
CREATE INDEX "reminders_patient_id_idx" ON "reminders" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "reminders_appointment_id_idx" ON "reminders" USING btree ("appointment_id");--> statement-breakpoint
CREATE INDEX "reminders_status_idx" ON "reminders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "reminders_created_at_idx" ON "reminders" USING btree ("created_at");