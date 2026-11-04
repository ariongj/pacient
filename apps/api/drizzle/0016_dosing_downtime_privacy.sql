CREATE TABLE "data_subject_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid,
	"kind" varchar(15) NOT NULL,
	"status" varchar(12) DEFAULT 'RECEIVED' NOT NULL,
	"details" varchar(2000),
	"received_via" varchar(10) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"outcome" varchar(2000),
	"handled_by_id" uuid,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "dose_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingredient" varchar(100) NOT NULL,
	"route" varchar(20) DEFAULT 'ORAL' NOT NULL,
	"age_group" varchar(10) NOT NULL,
	"unit" varchar(10) DEFAULT 'mg' NOT NULL,
	"per_kg" boolean DEFAULT false NOT NULL,
	"max_single_dose" numeric(10, 3),
	"max_daily_dose" numeric(10, 3),
	"absolute_max_daily" numeric(10, 3),
	"note" varchar(300),
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "downtime_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"file_name" varchar(200) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size_bytes" integer NOT NULL,
	"patient_count" integer NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category" varchar(40) NOT NULL,
	"retain_days" integer NOT NULL,
	"action" varchar(10) NOT NULL,
	"legal_basis" varchar(300) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_count" integer,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "early_warning_scores" ADD COLUMN "scale" varchar(8) DEFAULT 'NEWS2' NOT NULL;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "downtime_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "downtime_note" varchar(300);--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD COLUMN "patient_scanned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD COLUMN "medication_scanned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD COLUMN "scan_override_reason" varchar(300);--> statement-breakpoint
ALTER TABLE "medication_catalog" ADD COLUMN "barcode" varchar(32);--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "dose_amount" numeric(10, 3);--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "dose_unit" varchar(20);--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "frequency_code" varchar(12);--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "duration_days" integer;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "as_needed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_handled_by_id_users_id_fk" FOREIGN KEY ("handled_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "downtime_exports" ADD CONSTRAINT "downtime_exports_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_released_by_id_users_id_fk" FOREIGN KEY ("released_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_subject_requests_status_idx" ON "data_subject_requests" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dose_rules_uq" ON "dose_rules" USING btree ("ingredient","route","age_group");--> statement-breakpoint
CREATE INDEX "downtime_exports_facility_idx" ON "downtime_exports" USING btree ("facility_id","generated_at");--> statement-breakpoint
CREATE INDEX "legal_holds_patient_idx" ON "legal_holds" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_policies_category_uq" ON "retention_policies" USING btree ("category");--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_structured_dose_ck" CHECK (
  ("dose_amount" IS NULL OR "dose_amount" > 0) AND ("duration_days" IS NULL OR "duration_days" BETWEEN 1 AND 3650));
--> statement-breakpoint
ALTER TABLE "dose_rules" ADD CONSTRAINT "dose_rules_values_ck" CHECK (
  "age_group" IN ('ADULT', 'CHILD', 'NEONATE', 'ELDERLY')
  AND ("max_single_dose" IS NULL OR "max_single_dose" > 0)
  AND ("max_daily_dose" IS NULL OR "max_daily_dose" > 0));
--> statement-breakpoint
CREATE UNIQUE INDEX "medication_catalog_barcode_uq" ON "medication_catalog" ("barcode") WHERE "barcode" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "early_warning_scores" ADD CONSTRAINT "early_warning_scores_scale_ck" CHECK ("scale" IN ('NEWS2', 'PEWS'));
--> statement-breakpoint
ALTER TABLE "early_warning_scores" DROP CONSTRAINT "early_warning_scores_risk_ck";
--> statement-breakpoint
ALTER TABLE "early_warning_scores" ADD CONSTRAINT "early_warning_scores_risk_ck" CHECK ("risk" IN ('LOW', 'LOW_MEDIUM', 'MEDIUM', 'HIGH') AND "score" BETWEEN 0 AND 26);
--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_values_ck" CHECK ("retain_days" >= 1 AND "action" IN ('PURGE', 'ANONYMISE'));
--> statement-breakpoint
ALTER TABLE "data_subject_requests" ADD CONSTRAINT "data_subject_requests_values_ck" CHECK (
  "kind" IN ('ACCESS', 'RECTIFICATION', 'RESTRICTION', 'ERASURE', 'OBJECTION', 'PORTABILITY')
  AND "status" IN ('RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED')
  AND "received_via" IN ('PORTAL', 'IN_PERSON', 'POST', 'EMAIL'));
