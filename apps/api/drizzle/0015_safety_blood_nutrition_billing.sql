CREATE TYPE "public"."blood_product" AS ENUM('RED_CELLS', 'PLASMA', 'PLATELETS', 'CRYOPRECIPITATE', 'WHOLE_BLOOD');--> statement-breakpoint
CREATE TYPE "public"."blood_unit_status" AS ENUM('AVAILABLE', 'RESERVED', 'ISSUED', 'TRANSFUSED', 'RETURNED', 'DISCARDED');--> statement-breakpoint
CREATE TYPE "public"."charge_status" AS ENUM('OPEN', 'CLAIMED', 'PAID', 'REJECTED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('DRAFT', 'SUBMITTED', 'ACCEPTED', 'PARTIALLY_PAID', 'PAID', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."diet_type" AS ENUM('NORMAL', 'NIL_BY_MOUTH', 'CLEAR_FLUIDS', 'FULL_FLUIDS', 'SOFT', 'PUREED', 'DIABETIC', 'LOW_SALT', 'RENAL', 'LOW_FAT', 'HIGH_PROTEIN', 'GLUTEN_FREE', 'VEGETARIAN', 'ENTERAL_TUBE');--> statement-breakpoint
CREATE TYPE "public"."interaction_severity" AS ENUM('CONTRAINDICATED', 'MAJOR', 'MODERATE', 'MINOR');--> statement-breakpoint
CREATE TYPE "public"."transfusion_request_status" AS ENUM('REQUESTED', 'SAMPLE_RECEIVED', 'CROSSMATCHED', 'ISSUED', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."care_unit_type" ADD VALUE 'BLOOD_BANK';--> statement-breakpoint
ALTER TYPE "public"."care_unit_type" ADD VALUE 'NUTRITION';--> statement-breakpoint
CREATE TABLE "billable_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(30) NOT NULL,
	"name" varchar(200) NOT NULL,
	"category" varchar(40) NOT NULL,
	"price_cents" integer NOT NULL,
	"copay_cents" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blood_group_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"abo" varchar(2) NOT NULL,
	"rh_d" varchar(3) NOT NULL,
	"antibody_screen" varchar(20) DEFAULT 'NEGATIVE' NOT NULL,
	"antibodies" varchar(200),
	"tested_by_id" uuid NOT NULL,
	"tested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blood_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"unit_number" varchar(30) NOT NULL,
	"product" "blood_product" NOT NULL,
	"abo" varchar(2) NOT NULL,
	"rh_d" varchar(3) NOT NULL,
	"volume_ml" integer NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "blood_unit_status" DEFAULT 'AVAILABLE' NOT NULL,
	"reserved_for_request_id" uuid,
	"discard_reason" varchar(300),
	"received_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "case_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"disease_id" uuid NOT NULL,
	"diagnosis_id" uuid,
	"facility_id" uuid NOT NULL,
	"classification" varchar(12) DEFAULT 'SUSPECTED' NOT NULL,
	"status" varchar(12) DEFAULT 'DRAFT' NOT NULL,
	"onset_date" date,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reported_by_id" uuid,
	"submitted_at" timestamp with time zone,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" varchar(1000),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"source_type" varchar(30) NOT NULL,
	"source_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"total_cents" integer NOT NULL,
	"copay_cents" integer DEFAULT 0 NOT NULL,
	"insurer_cents" integer NOT NULL,
	"status" charge_status DEFAULT 'OPEN' NOT NULL,
	"claim_id" uuid,
	"service_date" date NOT NULL,
	"created_by_id" uuid,
	"void_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"insurer" varchar(60) NOT NULL,
	"reference" varchar(40) NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"status" "claim_status" DEFAULT 'DRAFT' NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"submitted_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"response_note" varchar(1000),
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diet_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"diet_type" "diet_type" NOT NULL,
	"restrictions" text[],
	"fluid_limit_ml" integer,
	"notes" varchar(500),
	"reason" varchar(300),
	"surgical_case_id" uuid,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"ordered_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drug_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingredient_a" varchar(100) NOT NULL,
	"ingredient_b" varchar(100) NOT NULL,
	"severity" "interaction_severity" NOT NULL,
	"effect" varchar(500) NOT NULL,
	"management" varchar(500) NOT NULL,
	"source" varchar(200),
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "early_warning_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"vital_sign_id" uuid NOT NULL,
	"admission_id" uuid,
	"score" integer NOT NULL,
	"risk" varchar(12) NOT NULL,
	"components" jsonb NOT NULL,
	"complete" boolean NOT NULL,
	"escalated_at" timestamp with time zone,
	"acknowledged_by_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_coverages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"insurer" varchar(60) NOT NULL,
	"policy_number" varchar(60),
	"status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
	"exemption" varchar(40),
	"valid_from" date NOT NULL,
	"valid_until" date,
	"verified_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifiable_diseases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(30) NOT NULL,
	"name" varchar(200) NOT NULL,
	"icd10_prefixes" text[] NOT NULL,
	"urgency" varchar(10) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nutrition_screenings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid,
	"tool" varchar(20) NOT NULL,
	"score" integer NOT NULL,
	"risk" varchar(10) NOT NULL,
	"answers" jsonb NOT NULL,
	"screened_by_id" uuid NOT NULL,
	"screened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"receipt_number" varchar(30) NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" varchar(10) NOT NULL,
	"charge_ids" uuid[] NOT NULL,
	"received_by_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prescription_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" varchar(20) NOT NULL,
	"severity" "interaction_severity" NOT NULL,
	"message" varchar(1000) NOT NULL,
	"details" jsonb,
	"override_reason" varchar(500),
	"overridden_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfusion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"admission_id" uuid,
	"surgical_case_id" uuid,
	"product" "blood_product" NOT NULL,
	"units" integer NOT NULL,
	"urgency" varchar(20) NOT NULL,
	"indication" varchar(1000) NOT NULL,
	"haemoglobin_g_l" integer,
	"status" "transfusion_request_status" DEFAULT 'REQUESTED' NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"sample_received_at" timestamp with time zone,
	"crossmatched_by_id" uuid,
	"crossmatched_at" timestamp with time zone,
	"cancel_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transfusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"issued_by_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_by_id" uuid,
	"second_checker_id" uuid,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"observations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reaction" boolean DEFAULT false NOT NULL,
	"reaction_type" varchar(60),
	"reaction_severity" varchar(20),
	"reaction_details" varchar(2000),
	"status" varchar(20) DEFAULT 'ISSUED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "video_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"appointment_id" uuid NOT NULL,
	"status" varchar(10) DEFAULT 'WAITING' NOT NULL,
	"doctor_joined_at" timestamp with time zone,
	"patient_joined_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "mode" varchar(10) DEFAULT 'IN_PERSON' NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_catalog" ADD COLUMN "ingredients" text[];--> statement-breakpoint
ALTER TABLE "vital_signs" ADD COLUMN "consciousness" varchar(1);--> statement-breakpoint
ALTER TABLE "vital_signs" ADD COLUMN "on_supplemental_oxygen" boolean;--> statement-breakpoint
ALTER TABLE "vital_signs" ADD COLUMN "pain_score" integer;--> statement-breakpoint
ALTER TABLE "blood_group_tests" ADD CONSTRAINT "blood_group_tests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_group_tests" ADD CONSTRAINT "blood_group_tests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_group_tests" ADD CONSTRAINT "blood_group_tests_tested_by_id_users_id_fk" FOREIGN KEY ("tested_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_units" ADD CONSTRAINT "blood_units_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_units" ADD CONSTRAINT "blood_units_received_by_id_users_id_fk" FOREIGN KEY ("received_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_reports" ADD CONSTRAINT "case_reports_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_reports" ADD CONSTRAINT "case_reports_disease_id_notifiable_diseases_id_fk" FOREIGN KEY ("disease_id") REFERENCES "public"."notifiable_diseases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_reports" ADD CONSTRAINT "case_reports_diagnosis_id_diagnoses_id_fk" FOREIGN KEY ("diagnosis_id") REFERENCES "public"."diagnoses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_reports" ADD CONSTRAINT "case_reports_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_reports" ADD CONSTRAINT "case_reports_reported_by_id_users_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_reports" ADD CONSTRAINT "case_reports_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_service_id_billable_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."billable_services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_orders" ADD CONSTRAINT "diet_orders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_orders" ADD CONSTRAINT "diet_orders_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_orders" ADD CONSTRAINT "diet_orders_surgical_case_id_surgical_cases_id_fk" FOREIGN KEY ("surgical_case_id") REFERENCES "public"."surgical_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diet_orders" ADD CONSTRAINT "diet_orders_ordered_by_id_users_id_fk" FOREIGN KEY ("ordered_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_warning_scores" ADD CONSTRAINT "early_warning_scores_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_warning_scores" ADD CONSTRAINT "early_warning_scores_vital_sign_id_vital_signs_id_fk" FOREIGN KEY ("vital_sign_id") REFERENCES "public"."vital_signs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_warning_scores" ADD CONSTRAINT "early_warning_scores_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "early_warning_scores" ADD CONSTRAINT "early_warning_scores_acknowledged_by_id_users_id_fk" FOREIGN KEY ("acknowledged_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_coverages" ADD CONSTRAINT "insurance_coverages_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_coverages" ADD CONSTRAINT "insurance_coverages_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrition_screenings" ADD CONSTRAINT "nutrition_screenings_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrition_screenings" ADD CONSTRAINT "nutrition_screenings_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nutrition_screenings" ADD CONSTRAINT "nutrition_screenings_screened_by_id_users_id_fk" FOREIGN KEY ("screened_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_received_by_id_users_id_fk" FOREIGN KEY ("received_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_alerts" ADD CONSTRAINT "prescription_alerts_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_alerts" ADD CONSTRAINT "prescription_alerts_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescription_alerts" ADD CONSTRAINT "prescription_alerts_overridden_by_id_users_id_fk" FOREIGN KEY ("overridden_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusion_requests" ADD CONSTRAINT "transfusion_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusion_requests" ADD CONSTRAINT "transfusion_requests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusion_requests" ADD CONSTRAINT "transfusion_requests_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusion_requests" ADD CONSTRAINT "transfusion_requests_surgical_case_id_surgical_cases_id_fk" FOREIGN KEY ("surgical_case_id") REFERENCES "public"."surgical_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusion_requests" ADD CONSTRAINT "transfusion_requests_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusion_requests" ADD CONSTRAINT "transfusion_requests_crossmatched_by_id_users_id_fk" FOREIGN KEY ("crossmatched_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_request_id_transfusion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."transfusion_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_unit_id_blood_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."blood_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_issued_by_id_users_id_fk" FOREIGN KEY ("issued_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_checked_by_id_users_id_fk" FOREIGN KEY ("checked_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_second_checker_id_users_id_fk" FOREIGN KEY ("second_checker_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "video_sessions" ADD CONSTRAINT "video_sessions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billable_services_code_uq" ON "billable_services" USING btree ("code");--> statement-breakpoint
CREATE INDEX "blood_group_tests_patient_idx" ON "blood_group_tests" USING btree ("patient_id","tested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "blood_units_number_uq" ON "blood_units" USING btree ("unit_number");--> statement-breakpoint
CREATE INDEX "blood_units_stock_idx" ON "blood_units" USING btree ("facility_id","product","status","expires_at");--> statement-breakpoint
CREATE INDEX "case_reports_disease_idx" ON "case_reports" USING btree ("disease_id","created_at");--> statement-breakpoint
CREATE INDEX "case_reports_facility_idx" ON "case_reports" USING btree ("facility_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "case_reports_diagnosis_uq" ON "case_reports" USING btree ("diagnosis_id");--> statement-breakpoint
CREATE INDEX "charges_patient_idx" ON "charges" USING btree ("patient_id","service_date");--> statement-breakpoint
CREATE INDEX "charges_facility_status_idx" ON "charges" USING btree ("facility_id","status","service_date");--> statement-breakpoint
CREATE UNIQUE INDEX "charges_source_uq" ON "charges" USING btree ("source_type","source_id","service_id") WHERE "charges"."source_id" IS NOT NULL AND "charges"."status" <> 'VOID';--> statement-breakpoint
CREATE UNIQUE INDEX "claims_reference_uq" ON "claims" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "diet_orders_admission_idx" ON "diet_orders" USING btree ("admission_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drug_interactions_pair_uq" ON "drug_interactions" USING btree ("ingredient_a","ingredient_b");--> statement-breakpoint
CREATE UNIQUE INDEX "early_warning_scores_vitals_uq" ON "early_warning_scores" USING btree ("vital_sign_id");--> statement-breakpoint
CREATE INDEX "early_warning_scores_patient_idx" ON "early_warning_scores" USING btree ("patient_id","computed_at");--> statement-breakpoint
CREATE INDEX "insurance_coverages_patient_idx" ON "insurance_coverages" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifiable_diseases_code_uq" ON "notifiable_diseases" USING btree ("code");--> statement-breakpoint
CREATE INDEX "nutrition_screenings_patient_idx" ON "nutrition_screenings" USING btree ("patient_id","screened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_receipt_uq" ON "payments" USING btree ("receipt_number");--> statement-breakpoint
CREATE INDEX "prescription_alerts_rx_idx" ON "prescription_alerts" USING btree ("prescription_id");--> statement-breakpoint
CREATE INDEX "transfusion_requests_patient_idx" ON "transfusion_requests" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "transfusion_requests_queue_idx" ON "transfusion_requests" USING btree ("facility_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "transfusions_unit_uq" ON "transfusions" USING btree ("unit_id");--> statement-breakpoint
CREATE INDEX "transfusions_patient_idx" ON "transfusions" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "video_sessions_appointment_uq" ON "video_sessions" USING btree ("appointment_id");--> statement-breakpoint
ALTER TABLE "vital_signs" ADD CONSTRAINT "vital_signs_acvpu_ck" CHECK ("consciousness" IS NULL OR "consciousness" IN ('A', 'C', 'V', 'P', 'U'));
--> statement-breakpoint
ALTER TABLE "vital_signs" ADD CONSTRAINT "vital_signs_pain_ck" CHECK ("pain_score" IS NULL OR "pain_score" BETWEEN 0 AND 10);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_mode_ck" CHECK ("mode" IN ('IN_PERSON', 'VIDEO'));
--> statement-breakpoint
ALTER TABLE "drug_interactions" ADD CONSTRAINT "drug_interactions_order_ck" CHECK ("ingredient_a" < "ingredient_b");
--> statement-breakpoint
ALTER TABLE "prescription_alerts" ADD CONSTRAINT "prescription_alerts_kind_ck" CHECK ("kind" IN ('INTERACTION', 'ALLERGY', 'DUPLICATE', 'DOSE', 'RENAL', 'PREGNANCY', 'AGE'));
--> statement-breakpoint
ALTER TABLE "blood_group_tests" ADD CONSTRAINT "blood_group_tests_values_ck" CHECK ("abo" IN ('O', 'A', 'B', 'AB') AND "rh_d" IN ('POS', 'NEG'));
--> statement-breakpoint
ALTER TABLE "blood_units" ADD CONSTRAINT "blood_units_values_ck" CHECK ("abo" IN ('O', 'A', 'B', 'AB') AND "rh_d" IN ('POS', 'NEG') AND "volume_ml" > 0 AND "expires_at" > "collected_at");
--> statement-breakpoint
ALTER TABLE "transfusion_requests" ADD CONSTRAINT "transfusion_requests_values_ck" CHECK ("units" BETWEEN 1 AND 20 AND "urgency" IN ('ROUTINE', 'URGENT', 'EMERGENCY'));
--> statement-breakpoint
ALTER TABLE "transfusions" ADD CONSTRAINT "transfusions_checkers_ck" CHECK ("second_checker_id" IS NULL OR "second_checker_id" <> "checked_by_id");
--> statement-breakpoint
ALTER TABLE "nutrition_screenings" ADD CONSTRAINT "nutrition_screenings_values_ck" CHECK ("tool" IN ('NRS2002', 'MUST', 'STRONGKIDS') AND "risk" IN ('LOW', 'MEDIUM', 'HIGH') AND "score" >= 0);
--> statement-breakpoint
ALTER TABLE "insurance_coverages" ADD CONSTRAINT "insurance_coverages_status_ck" CHECK ("status" IN ('ACTIVE', 'SUSPENDED', 'ENDED'));
--> statement-breakpoint
ALTER TABLE "billable_services" ADD CONSTRAINT "billable_services_values_ck" CHECK ("price_cents" >= 0 AND "copay_cents" >= 0 AND "copay_cents" <= "price_cents");
--> statement-breakpoint
ALTER TABLE "charges" ADD CONSTRAINT "charges_values_ck" CHECK ("quantity" >= 1 AND "total_cents" >= 0 AND "copay_cents" >= 0 AND "insurer_cents" >= 0 AND "copay_cents" + "insurer_cents" = "total_cents");
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_values_ck" CHECK ("amount_cents" > 0 AND "method" IN ('CASH', 'CARD', 'TRANSFER'));
--> statement-breakpoint
ALTER TABLE "early_warning_scores" ADD CONSTRAINT "early_warning_scores_risk_ck" CHECK ("risk" IN ('LOW', 'LOW_MEDIUM', 'MEDIUM', 'HIGH') AND "score" BETWEEN 0 AND 20);
--> statement-breakpoint
ALTER TABLE "notifiable_diseases" ADD CONSTRAINT "notifiable_diseases_urgency_ck" CHECK ("urgency" IN ('IMMEDIATE', 'WEEKLY'));
--> statement-breakpoint
ALTER TABLE "case_reports" ADD CONSTRAINT "case_reports_values_ck" CHECK ("classification" IN ('SUSPECTED', 'PROBABLE', 'CONFIRMED', 'DISCARDED') AND "status" IN ('DRAFT', 'SUBMITTED', 'REVIEWED'));
--> statement-breakpoint
ALTER TABLE "video_sessions" ADD CONSTRAINT "video_sessions_status_ck" CHECK ("status" IN ('WAITING', 'ACTIVE', 'ENDED'));
--> statement-breakpoint
ALTER TABLE "partner_clients" DROP CONSTRAINT "partner_clients_scopes_ck";
--> statement-breakpoint
ALTER TABLE "partner_clients" ADD CONSTRAINT "partner_clients_scopes_ck" CHECK (
  cardinality("scopes") > 0
  AND "scopes" <@ ARRAY['fhir.patient.read', 'stats.read', 'directory.read', 'births.notify', 'claims.read', 'surveillance.read']::text[]);
--> statement-breakpoint
-- Transfusion records, issued units and paid claims are part of the legal record.
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
