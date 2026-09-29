CREATE TABLE "finance_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"invoice_id" integer NOT NULL,
	"reason" text NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb NOT NULL,
	"actor_staff_id" integer,
	"actor_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finance_correction_entity_type_valid" CHECK ("finance_corrections"."entity_type" IN ('invoice', 'payment'))
);
--> statement-breakpoint
CREATE TABLE "laboratory_order_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"actor_staff_id" integer NOT NULL,
	"actor_name" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "laboratory_order_history_action_valid" CHECK ("laboratory_order_history"."action" IN ('create', 'update', 'cancel'))
);
--> statement-breakpoint
CREATE TABLE "laboratory_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"visit_id" integer,
	"lab_name" text NOT NULL,
	"supplier_id" integer,
	"case_type" text NOT NULL,
	"due_date" date,
	"status" text DEFAULT 'submitted' NOT NULL,
	"notes" text,
	"created_by_staff_id" integer NOT NULL,
	"updated_by_staff_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "laboratory_orders_lab_name_nonempty" CHECK (length(trim("laboratory_orders"."lab_name")) > 0),
	CONSTRAINT "laboratory_orders_case_type_valid" CHECK ("laboratory_orders"."case_type" IN ('crown', 'bridge', 'denture', 'implant', 'orthodontic', 'other')),
	CONSTRAINT "laboratory_orders_status_valid" CHECK ("laboratory_orders"."status" IN ('submitted', 'in_progress', 'ready', 'delivered', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "aligner_courses" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"case_id" integer NOT NULL,
	"title" text NOT NULL,
	"created_by_staff_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "aligner_courses_case_id_unique" UNIQUE("case_id"),
	CONSTRAINT "aligner_courses_title_nonempty" CHECK (length(trim("aligner_courses"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "aligner_trays" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"sequence" integer NOT NULL,
	"planned_date" date,
	"delivered_date" date,
	"status" text DEFAULT 'planned' NOT NULL,
	"wear_notes" text,
	"visit_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	CONSTRAINT "aligner_trays_course_sequence_unique" UNIQUE("course_id","sequence"),
	CONSTRAINT "aligner_trays_sequence_positive" CHECK ("aligner_trays"."sequence" > 0),
	CONSTRAINT "aligner_trays_status_valid" CHECK ("aligner_trays"."status" IN ('planned', 'delivered', 'wearing', 'completed', 'paused')),
	CONSTRAINT "aligner_trays_dates_ordered" CHECK ("aligner_trays"."planned_date" IS NULL OR "aligner_trays"."delivered_date" IS NULL OR "aligner_trays"."delivered_date" >= "aligner_trays"."planned_date")
);
--> statement-breakpoint
CREATE TABLE "prescription_amendments" (
	"id" serial PRIMARY KEY NOT NULL,
	"prescription_id" integer NOT NULL,
	"amended_by_staff_id" integer NOT NULL,
	"amendment_type" text NOT NULL,
	"reason" text NOT NULL,
	"replacement" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prescription_amendments_type_valid" CHECK ("prescription_amendments"."amendment_type" IN ('correction', 'void')),
	CONSTRAINT "prescription_amendments_replacement_valid" CHECK ((
    ("prescription_amendments"."amendment_type" = 'correction' AND "prescription_amendments"."replacement" IS NOT NULL)
    OR ("prescription_amendments"."amendment_type" = 'void' AND "prescription_amendments"."replacement" IS NULL)
  ))
);
--> statement-breakpoint
CREATE TABLE "clinical_prescriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"patient_id" integer NOT NULL,
	"visit_id" integer,
	"author_dentist_staff_id" integer NOT NULL,
	"created_by_staff_id" integer NOT NULL,
	"medication" text NOT NULL,
	"dose" text NOT NULL,
	"route" text NOT NULL,
	"frequency" text NOT NULL,
	"duration" text NOT NULL,
	"instructions" text NOT NULL,
	"issued_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketing_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"channel" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_campaigns_code_not_empty" CHECK (length(btrim("marketing_campaigns"."code")) > 0),
	CONSTRAINT "marketing_campaigns_channel_not_empty" CHECK (length(btrim("marketing_campaigns"."channel")) > 0),
	CONSTRAINT "marketing_campaigns_status_valid" CHECK ("marketing_campaigns"."status" in ('active', 'paused', 'ended', 'disabled')),
	CONSTRAINT "marketing_campaigns_dates_ordered" CHECK ("marketing_campaigns"."start_date" is null or "marketing_campaigns"."end_date" is null or "marketing_campaigns"."start_date" <= "marketing_campaigns"."end_date")
);
--> statement-breakpoint
ALTER TABLE "laboratory_order_history" ADD CONSTRAINT "laboratory_order_history_order_id_laboratory_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."laboratory_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_order_history" ADD CONSTRAINT "laboratory_order_history_actor_staff_id_clinic_staff_id_fk" FOREIGN KEY ("actor_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_orders" ADD CONSTRAINT "laboratory_orders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_orders" ADD CONSTRAINT "laboratory_orders_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_orders" ADD CONSTRAINT "laboratory_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_orders" ADD CONSTRAINT "laboratory_orders_created_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "laboratory_orders" ADD CONSTRAINT "laboratory_orders_updated_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("updated_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aligner_courses" ADD CONSTRAINT "aligner_courses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aligner_courses" ADD CONSTRAINT "aligner_courses_case_id_orthodontic_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."orthodontic_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aligner_courses" ADD CONSTRAINT "aligner_courses_created_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aligner_trays" ADD CONSTRAINT "aligner_trays_course_id_aligner_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."aligner_courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aligner_trays" ADD CONSTRAINT "aligner_trays_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_amendments" ADD CONSTRAINT "prescription_amendments_prescription_id_clinical_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."clinical_prescriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_amendments" ADD CONSTRAINT "prescription_amendments_amended_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("amended_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_prescriptions" ADD CONSTRAINT "clinical_prescriptions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_prescriptions" ADD CONSTRAINT "clinical_prescriptions_visit_id_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_prescriptions" ADD CONSTRAINT "clinical_prescriptions_author_dentist_staff_id_clinic_staff_id_fk" FOREIGN KEY ("author_dentist_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical_prescriptions" ADD CONSTRAINT "clinical_prescriptions_created_by_staff_id_clinic_staff_id_fk" FOREIGN KEY ("created_by_staff_id") REFERENCES "public"."clinic_staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finance_correction_entity_unique" ON "finance_corrections" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "laboratory_order_history_order_id_idx" ON "laboratory_order_history" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "laboratory_order_history_actor_staff_id_idx" ON "laboratory_order_history" USING btree ("actor_staff_id");--> statement-breakpoint
CREATE INDEX "laboratory_orders_patient_id_idx" ON "laboratory_orders" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "laboratory_orders_visit_id_idx" ON "laboratory_orders" USING btree ("visit_id");--> statement-breakpoint
CREATE INDEX "laboratory_orders_supplier_id_idx" ON "laboratory_orders" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "laboratory_orders_status_idx" ON "laboratory_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "laboratory_orders_due_date_idx" ON "laboratory_orders" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "aligner_courses_patient_id_idx" ON "aligner_courses" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "aligner_trays_course_id_idx" ON "aligner_trays" USING btree ("course_id");--> statement-breakpoint
CREATE INDEX "prescription_amendments_prescription_id_idx" ON "prescription_amendments" USING btree ("prescription_id");--> statement-breakpoint
CREATE INDEX "clinical_prescriptions_patient_id_idx" ON "clinical_prescriptions" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "clinical_prescriptions_visit_id_idx" ON "clinical_prescriptions" USING btree ("visit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_campaigns_code_normalized_unique" ON "marketing_campaigns" USING btree (upper(btrim("code")));