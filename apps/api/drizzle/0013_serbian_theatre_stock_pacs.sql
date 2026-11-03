CREATE TYPE "public"."anaesthesia_type" AS ENUM('GENERAL', 'SPINAL', 'EPIDURAL', 'REGIONAL_BLOCK', 'LOCAL', 'SEDATION');--> statement-breakpoint
CREATE TYPE "public"."laterality" AS ENUM('LEFT', 'RIGHT', 'BILATERAL', 'NOT_APPLICABLE');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_type" AS ENUM('RECEIPT', 'DISPENSE', 'ADJUSTMENT', 'EXPIRED', 'DAMAGED', 'TRANSFER_OUT', 'TRANSFER_IN', 'RETURN');--> statement-breakpoint
CREATE TYPE "public"."surgery_priority" AS ENUM('ELECTIVE', 'URGENT', 'EMERGENCY');--> statement-breakpoint
CREATE TYPE "public"."surgery_status" AS ENUM('REQUESTED', 'SCHEDULED', 'IN_THEATRE', 'COMPLETED', 'POSTPONED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."care_unit_type" ADD VALUE 'OPERATING_THEATRE';--> statement-breakpoint
CREATE TABLE "medication_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"atc_code" varchar(10),
	"form" varchar(60) NOT NULL,
	"strength" varchar(60),
	"unit" varchar(30) NOT NULL,
	"is_essential" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_number" varchar(60) NOT NULL,
	"expiry_date" date NOT NULL,
	"quantity" integer NOT NULL,
	"supplier" varchar(200),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"batch_id" uuid,
	"type" "stock_movement_type" NOT NULL,
	"quantity" integer NOT NULL,
	"prescription_id" uuid,
	"reason" varchar(500),
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"reorder_level" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "surgical_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"theatre_unit_id" uuid,
	"admission_id" uuid,
	"procedure" varchar(300) NOT NULL,
	"procedure_code" varchar(20),
	"laterality" "laterality" DEFAULT 'NOT_APPLICABLE' NOT NULL,
	"priority" "surgery_priority" DEFAULT 'ELECTIVE' NOT NULL,
	"indication" varchar(1000) NOT NULL,
	"primary_surgeon_id" uuid NOT NULL,
	"assistant_id" uuid,
	"anaesthetist_id" uuid,
	"anaesthesia_type" "anaesthesia_type",
	"scheduled_start" timestamp with time zone,
	"estimated_minutes" integer DEFAULT 60 NOT NULL,
	"status" "surgery_status" DEFAULT 'REQUESTED' NOT NULL,
	"consent_record_id" uuid,
	"checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"in_theatre_at" timestamp with time zone,
	"incision_at" timestamp with time zone,
	"closure_at" timestamp with time zone,
	"out_of_theatre_at" timestamp with time zone,
	"operation_note" text,
	"complications" varchar(2000),
	"estimated_blood_loss_ml" integer,
	"note_signed_by_id" uuid,
	"note_signed_at" timestamp with time zone,
	"cancel_reason" varchar(500),
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD COLUMN "study_instance_uid" varchar(128);--> statement-breakpoint
ALTER TABLE "imaging_orders" ADD COLUMN "images_available_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "catalog_item_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_item_id_medication_catalog_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."medication_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_medication_catalog_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."medication_catalog"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_batch_id_stock_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."stock_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_settings" ADD CONSTRAINT "stock_settings_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_settings" ADD CONSTRAINT "stock_settings_item_id_medication_catalog_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."medication_catalog"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surgical_cases" ADD CONSTRAINT "surgical_cases_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surgical_cases" ADD CONSTRAINT "surgical_cases_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surgical_cases" ADD CONSTRAINT "surgical_cases_theatre_unit_id_care_units_id_fk" FOREIGN KEY ("theatre_unit_id") REFERENCES "public"."care_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surgical_cases" ADD CONSTRAINT "surgical_cases_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surgical_cases" ADD CONSTRAINT "surgical_cases_primary_surgeon_id_users_id_fk" FOREIGN KEY ("primary_surgeon_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surgical_cases" ADD CONSTRAINT "surgical_cases_assistant_id_users_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surgical_cases" ADD CONSTRAINT "surgical_cases_anaesthetist_id_users_id_fk" FOREIGN KEY ("anaesthetist_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surgical_cases" ADD CONSTRAINT "surgical_cases_consent_record_id_consent_records_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surgical_cases" ADD CONSTRAINT "surgical_cases_note_signed_by_id_users_id_fk" FOREIGN KEY ("note_signed_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surgical_cases" ADD CONSTRAINT "surgical_cases_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "medication_catalog_uq" ON "medication_catalog" USING btree ("name","form","strength");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_batches_uq" ON "stock_batches" USING btree ("facility_id","item_id","batch_number");--> statement-breakpoint
CREATE INDEX "stock_batches_expiry_idx" ON "stock_batches" USING btree ("facility_id","expiry_date");--> statement-breakpoint
CREATE INDEX "stock_movements_item_idx" ON "stock_movements" USING btree ("facility_id","item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_settings_uq" ON "stock_settings" USING btree ("facility_id","item_id");--> statement-breakpoint
CREATE INDEX "surgical_cases_schedule_idx" ON "surgical_cases" USING btree ("facility_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "surgical_cases_patient_idx" ON "surgical_cases" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "surgical_cases_theatre_idx" ON "surgical_cases" USING btree ("theatre_unit_id","scheduled_start");--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_catalog_item_id_medication_catalog_id_fk" FOREIGN KEY ("catalog_item_id") REFERENCES "public"."medication_catalog"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_locale_ck";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_locale_ck" CHECK ("locale" IN ('sq', 'en', 'sr'));
--> statement-breakpoint
ALTER TABLE "stock_batches" ADD CONSTRAINT "stock_batches_quantity_ck" CHECK ("quantity" >= 0);
--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_ck" CHECK ("quantity" <> 0);
--> statement-breakpoint
ALTER TABLE "stock_settings" ADD CONSTRAINT "stock_settings_reorder_ck" CHECK ("reorder_level" >= 0);
--> statement-breakpoint
ALTER TABLE "surgical_cases" ADD CONSTRAINT "surgical_cases_values_ck" CHECK (
  "estimated_minutes" BETWEEN 5 AND 1440
  AND ("estimated_blood_loss_ml" IS NULL OR "estimated_blood_loss_ml" >= 0)
  AND ("status" <> 'SCHEDULED' OR ("scheduled_start" IS NOT NULL AND "theatre_unit_id" IS NOT NULL)));
--> statement-breakpoint
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON "stock_movements"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
-- A signed operation note is part of the legal record.
CREATE OR REPLACE FUNCTION surgical_cases_protect_note() RETURNS trigger AS $$
BEGIN
  IF is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF OLD.note_signed_at IS NOT NULL AND (
    NEW.operation_note IS DISTINCT FROM OLD.operation_note
    OR NEW.complications IS DISTINCT FROM OLD.complications
    OR NEW.note_signed_at IS DISTINCT FROM OLD.note_signed_at
    OR NEW.note_signed_by_id IS DISTINCT FROM OLD.note_signed_by_id
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
  ) THEN
    RAISE EXCEPTION 'A signed operation note is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER surgical_cases_note_immutable BEFORE UPDATE ON "surgical_cases"
  FOR EACH ROW EXECUTE FUNCTION surgical_cases_protect_note();
