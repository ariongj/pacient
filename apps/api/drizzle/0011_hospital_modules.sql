CREATE TYPE "public"."admission_source" AS ENUM('EMERGENCY', 'ELECTIVE', 'TRANSFER', 'BIRTH');--> statement-breakpoint
CREATE TYPE "public"."admission_status" AS ENUM('ADMITTED', 'DISCHARGED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."bed_status" AS ENUM('AVAILABLE', 'OCCUPIED', 'CLEANING', 'OUT_OF_SERVICE');--> statement-breakpoint
CREATE TYPE "public"."care_unit_type" AS ENUM('GENERAL_WARD', 'SURGICAL_WARD', 'ICU', 'MATERNITY', 'PAEDIATRIC', 'NEONATAL', 'EMERGENCY', 'RADIOLOGY');--> statement-breakpoint
CREATE TYPE "public"."delivery_type" AS ENUM('SPONTANEOUS_VAGINAL', 'ASSISTED_VAGINAL', 'CAESAREAN_ELECTIVE', 'CAESAREAN_EMERGENCY');--> statement-breakpoint
CREATE TYPE "public"."discharge_disposition" AS ENUM('HOME', 'TRANSFER', 'AGAINST_ADVICE', 'DECEASED', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."ed_arrival_mode" AS ENUM('WALK_IN', 'AMBULANCE', 'REFERRAL', 'POLICE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."ed_status" AS ENUM('WAITING', 'IN_TREATMENT', 'ADMITTED', 'DISCHARGED', 'TRANSFERRED', 'LEFT_WITHOUT_BEING_SEEN');--> statement-breakpoint
CREATE TYPE "public"."imaging_modality" AS ENUM('XRAY', 'CT', 'MRI', 'ULTRASOUND', 'MAMMOGRAPHY', 'FLUOROSCOPY');--> statement-breakpoint
CREATE TYPE "public"."imaging_status" AS ENUM('ORDERED', 'SCHEDULED', 'PERFORMED', 'REPORTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."temporary_identity" AS ENUM('NEWBORN', 'UNIDENTIFIED');--> statement-breakpoint
CREATE TABLE "admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"bed_id" uuid,
	"admitting_doctor_id" uuid NOT NULL,
	"attending_doctor_id" uuid NOT NULL,
	"source" "admission_source" NOT NULL,
	"reason" varchar(500) NOT NULL,
	"ed_visit_id" uuid,
	"status" "admission_status" DEFAULT 'ADMITTED' NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expected_discharge_at" timestamp with time zone,
	"discharged_at" timestamp with time zone,
	"discharged_by_id" uuid,
	"disposition" "discharge_disposition",
	"discharge_summary" text,
	"discharge_signed_at" timestamp with time zone,
	"released_to_patient_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bed_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admission_id" uuid NOT NULL,
	"from_unit_id" uuid,
	"from_bed_id" uuid,
	"to_unit_id" uuid NOT NULL,
	"to_bed_id" uuid,
	"reason" varchar(300),
	"moved_by_id" uuid NOT NULL,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"label" varchar(20) NOT NULL,
	"status" "bed_status" DEFAULT 'AVAILABLE' NOT NULL,
	"note" varchar(200),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "births" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mother_patient_id" uuid NOT NULL,
	"newborn_patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"mother_admission_id" uuid,
	"born_at" timestamp with time zone NOT NULL,
	"delivery_type" "delivery_type" NOT NULL,
	"gestational_weeks" integer NOT NULL,
	"gestational_days" integer DEFAULT 0 NOT NULL,
	"birth_weight_grams" integer NOT NULL,
	"length_cm" numeric(4, 1),
	"head_circumference_cm" numeric(4, 1),
	"apgar_1" integer NOT NULL,
	"apgar_5" integer NOT NULL,
	"apgar_10" integer,
	"birth_order" integer DEFAULT 1 NOT NULL,
	"attendant_id" uuid NOT NULL,
	"notes" varchar(2000),
	"civil_registered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "care_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"code" varchar(20) NOT NULL,
	"type" "care_unit_type" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ed_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"arrived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"arrival_mode" "ed_arrival_mode" NOT NULL,
	"chief_complaint" varchar(300) NOT NULL,
	"registered_by_id" uuid NOT NULL,
	"triage_level" integer,
	"triage_note" varchar(1000),
	"triaged_by_id" uuid,
	"triaged_at" timestamp with time zone,
	"assigned_doctor_id" uuid,
	"seen_at" timestamp with time zone,
	"status" "ed_status" DEFAULT 'WAITING' NOT NULL,
	"departed_at" timestamp with time zone,
	"disposition_note" varchar(1000),
	"admission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imaging_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accession_number" varchar(20) NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"encounter_id" uuid,
	"admission_id" uuid,
	"ed_visit_id" uuid,
	"ordered_by_id" uuid NOT NULL,
	"modality" "imaging_modality" NOT NULL,
	"body_part" varchar(120) NOT NULL,
	"clinical_question" varchar(1000) NOT NULL,
	"priority" "lab_priority" DEFAULT 'ROUTINE' NOT NULL,
	"safety_checks" jsonb,
	"status" "imaging_status" DEFAULT 'ORDERED' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"performed_at" timestamp with time zone,
	"performed_by_id" uuid,
	"findings" text,
	"impression" text,
	"critical" boolean DEFAULT false NOT NULL,
	"reported_by_id" uuid,
	"reported_at" timestamp with time zone,
	"acknowledged_by_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "unit_staff" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"unit_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"assigned_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "temporary_identity" "temporary_identity";--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "identity_note" varchar(300);--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "identity_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_unit_id_care_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."care_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_bed_id_beds_id_fk" FOREIGN KEY ("bed_id") REFERENCES "public"."beds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_admitting_doctor_id_users_id_fk" FOREIGN KEY ("admitting_doctor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_attending_doctor_id_users_id_fk" FOREIGN KEY ("attending_doctor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_discharged_by_id_users_id_fk" FOREIGN KEY ("discharged_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_movements" ADD CONSTRAINT "bed_movements_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_movements" ADD CONSTRAINT "bed_movements_from_unit_id_care_units_id_fk" FOREIGN KEY ("from_unit_id") REFERENCES "public"."care_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_movements" ADD CONSTRAINT "bed_movements_from_bed_id_beds_id_fk" FOREIGN KEY ("from_bed_id") REFERENCES "public"."beds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_movements" ADD CONSTRAINT "bed_movements_to_unit_id_care_units_id_fk" FOREIGN KEY ("to_unit_id") REFERENCES "public"."care_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_movements" ADD CONSTRAINT "bed_movements_to_bed_id_beds_id_fk" FOREIGN KEY ("to_bed_id") REFERENCES "public"."beds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bed_movements" ADD CONSTRAINT "bed_movements_moved_by_id_users_id_fk" FOREIGN KEY ("moved_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beds" ADD CONSTRAINT "beds_unit_id_care_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."care_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "births" ADD CONSTRAINT "births_mother_patient_id_patients_id_fk" FOREIGN KEY ("mother_patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "births" ADD CONSTRAINT "births_newborn_patient_id_patients_id_fk" FOREIGN KEY ("newborn_patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "births" ADD CONSTRAINT "births_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "births" ADD CONSTRAINT "births_mother_admission_id_admissions_id_fk" FOREIGN KEY ("mother_admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "births" ADD CONSTRAINT "births_attendant_id_users_id_fk" FOREIGN KEY ("attendant_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_units" ADD CONSTRAINT "care_units_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ed_visits" ADD CONSTRAINT "ed_visits_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ed_visits" ADD CONSTRAINT "ed_visits_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ed_visits" ADD CONSTRAINT "ed_visits_unit_id_care_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."care_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ed_visits" ADD CONSTRAINT "ed_visits_registered_by_id_users_id_fk" FOREIGN KEY ("registered_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ed_visits" ADD CONSTRAINT "ed_visits_triaged_by_id_users_id_fk" FOREIGN KEY ("triaged_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ed_visits" ADD CONSTRAINT "ed_visits_assigned_doctor_id_users_id_fk" FOREIGN KEY ("assigned_doctor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ed_visits" ADD CONSTRAINT "ed_visits_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD CONSTRAINT "imaging_orders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD CONSTRAINT "imaging_orders_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD CONSTRAINT "imaging_orders_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD CONSTRAINT "imaging_orders_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD CONSTRAINT "imaging_orders_ed_visit_id_ed_visits_id_fk" FOREIGN KEY ("ed_visit_id") REFERENCES "public"."ed_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD CONSTRAINT "imaging_orders_ordered_by_id_users_id_fk" FOREIGN KEY ("ordered_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD CONSTRAINT "imaging_orders_performed_by_id_users_id_fk" FOREIGN KEY ("performed_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD CONSTRAINT "imaging_orders_reported_by_id_users_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD CONSTRAINT "imaging_orders_acknowledged_by_id_users_id_fk" FOREIGN KEY ("acknowledged_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_staff" ADD CONSTRAINT "unit_staff_unit_id_care_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."care_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_staff" ADD CONSTRAINT "unit_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "unit_staff" ADD CONSTRAINT "unit_staff_assigned_by_id_users_id_fk" FOREIGN KEY ("assigned_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admissions_patient_idx" ON "admissions" USING btree ("patient_id","admitted_at");--> statement-breakpoint
CREATE INDEX "admissions_unit_status_idx" ON "admissions" USING btree ("unit_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_one_active_per_patient_uq" ON "admissions" USING btree ("patient_id") WHERE "admissions"."status" = 'ADMITTED';--> statement-breakpoint
CREATE UNIQUE INDEX "admissions_one_patient_per_bed_uq" ON "admissions" USING btree ("bed_id") WHERE "admissions"."status" = 'ADMITTED' AND "admissions"."bed_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "bed_movements_admission_idx" ON "bed_movements" USING btree ("admission_id","moved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "beds_label_uq" ON "beds" USING btree ("unit_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "births_newborn_uq" ON "births" USING btree ("newborn_patient_id");--> statement-breakpoint
CREATE INDEX "births_mother_idx" ON "births" USING btree ("mother_patient_id");--> statement-breakpoint
CREATE INDEX "births_facility_idx" ON "births" USING btree ("facility_id","born_at");--> statement-breakpoint
CREATE UNIQUE INDEX "care_units_code_uq" ON "care_units" USING btree ("facility_id","code");--> statement-breakpoint
CREATE INDEX "ed_visits_board_idx" ON "ed_visits" USING btree ("unit_id","status","arrived_at");--> statement-breakpoint
CREATE INDEX "ed_visits_patient_idx" ON "ed_visits" USING btree ("patient_id","arrived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ed_visits_one_active_per_patient_uq" ON "ed_visits" USING btree ("patient_id") WHERE "ed_visits"."status" IN ('WAITING', 'IN_TREATMENT');--> statement-breakpoint
CREATE UNIQUE INDEX "imaging_orders_accession_uq" ON "imaging_orders" USING btree ("accession_number");--> statement-breakpoint
CREATE INDEX "imaging_orders_worklist_idx" ON "imaging_orders" USING btree ("facility_id","status","created_at");--> statement-breakpoint
CREATE INDEX "imaging_orders_patient_idx" ON "imaging_orders" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "unit_staff_uq" ON "unit_staff" USING btree ("unit_id","user_id");--> statement-breakpoint
CREATE INDEX "unit_staff_user_idx" ON "unit_staff" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_ed_visit_id_ed_visits_id_fk" FOREIGN KEY ("ed_visit_id") REFERENCES "public"."ed_visits"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ed_visits" ADD CONSTRAINT "ed_visits_triage_level_ck" CHECK ("triage_level" IS NULL OR "triage_level" BETWEEN 1 AND 5);
--> statement-breakpoint
ALTER TABLE "births" ADD CONSTRAINT "births_values_ck" CHECK (
  "mother_patient_id" <> "newborn_patient_id"
  AND "gestational_weeks" BETWEEN 20 AND 45 AND "gestational_days" BETWEEN 0 AND 6
  AND "birth_weight_grams" BETWEEN 200 AND 7000
  AND "apgar_1" BETWEEN 0 AND 10 AND "apgar_5" BETWEEN 0 AND 10
  AND ("apgar_10" IS NULL OR "apgar_10" BETWEEN 0 AND 10)
  AND "birth_order" BETWEEN 1 AND 8);
--> statement-breakpoint
ALTER TABLE "admissions" ADD CONSTRAINT "admissions_discharge_ck" CHECK (
  ("status" = 'DISCHARGED') = ("discharged_at" IS NOT NULL)
  AND ("status" <> 'DISCHARGED' OR "disposition" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD CONSTRAINT "imaging_orders_report_ck" CHECK (
  "status" <> 'REPORTED' OR ("impression" IS NOT NULL AND "reported_at" IS NOT NULL));
--> statement-breakpoint
-- A signed discharge summary and a signed imaging report are part of the legal record.
CREATE OR REPLACE FUNCTION admissions_protect_signed_summary() RETURNS trigger AS $$
BEGIN
  IF is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF OLD.discharge_signed_at IS NOT NULL AND (
    NEW.discharge_summary IS DISTINCT FROM OLD.discharge_summary
    OR NEW.discharge_signed_at IS DISTINCT FROM OLD.discharge_signed_at
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
  ) THEN
    RAISE EXCEPTION 'A signed discharge summary is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER admissions_signed_summary_immutable BEFORE UPDATE ON "admissions"
  FOR EACH ROW EXECUTE FUNCTION admissions_protect_signed_summary();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION imaging_protect_report() RETURNS trigger AS $$
BEGIN
  IF is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'REPORTED' AND (
    NEW.findings IS DISTINCT FROM OLD.findings
    OR NEW.impression IS DISTINCT FROM OLD.impression
    OR NEW.reported_by_id IS DISTINCT FROM OLD.reported_by_id
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
  ) THEN
    RAISE EXCEPTION 'A signed imaging report is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER imaging_report_immutable BEFORE UPDATE ON "imaging_orders"
  FOR EACH ROW EXECUTE FUNCTION imaging_protect_report();
