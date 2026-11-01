CREATE TYPE "public"."allergy_assessment" AS ENUM('NOT_RECORDED', 'NO_KNOWN_ALLERGIES', 'ALLERGIES_RECORDED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."correction_status" AS ENUM('OPEN', 'ACCEPTED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."note_status" AS ENUM('DRAFT', 'SIGNED');--> statement-breakpoint
CREATE TYPE "public"."record_source" AS ENUM('CLINICIAN', 'PATIENT_REPORTED', 'IMPORTED');--> statement-breakpoint
CREATE TYPE "public"."result_status" AS ENUM('PRELIMINARY', 'FINAL', 'CORRECTED');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('UNCONFIRMED', 'CONFIRMED', 'REFUTED', 'ENTERED_IN_ERROR');--> statement-breakpoint
CREATE TABLE "correction_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"requested_by_id" uuid NOT NULL,
	"section" varchar(40) NOT NULL,
	"entry_id" uuid,
	"description" text NOT NULL,
	"status" "correction_status" DEFAULT 'OPEN' NOT NULL,
	"response" text,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "encounter_addenda" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"encounter_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"reason" varchar(300) NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allergies" ADD COLUMN "verification_status" "verification_status" DEFAULT 'UNCONFIRMED' NOT NULL;--> statement-breakpoint
ALTER TABLE "allergies" ADD COLUMN "source" "record_source" DEFAULT 'CLINICIAN' NOT NULL;--> statement-breakpoint
ALTER TABLE "encounters" ADD COLUMN "note_status" "note_status" DEFAULT 'DRAFT' NOT NULL;--> statement-breakpoint
ALTER TABLE "encounters" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "encounters" ADD COLUMN "signed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "encounters" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "status" "result_status" DEFAULT 'FINAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "acknowledged_by_id" uuid;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "released_by_id" uuid;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "allergy_assessment" "allergy_assessment" DEFAULT 'NOT_RECORDED' NOT NULL;--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "correction_requests" ADD CONSTRAINT "correction_requests_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_addenda" ADD CONSTRAINT "encounter_addenda_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_addenda" ADD CONSTRAINT "encounter_addenda_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounter_addenda" ADD CONSTRAINT "encounter_addenda_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "correction_requests_patient_idx" ON "correction_requests" USING btree ("patient_id","status");--> statement-breakpoint
CREATE INDEX "encounter_addenda_encounter_idx" ON "encounter_addenda" USING btree ("encounter_id");--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_signed_by_id_users_id_fk" FOREIGN KEY ("signed_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_acknowledged_by_id_users_id_fk" FOREIGN KEY ("acknowledged_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_released_by_id_users_id_fk" FOREIGN KEY ("released_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lab_results_unacknowledged_idx" ON "lab_results" USING btree ("ordered_by_id") WHERE "lab_results"."acknowledged_at" IS NULL;--> statement-breakpoint
-- Defence in depth: a signed note cannot be rewritten, even by a buggy or compromised app path.
CREATE OR REPLACE FUNCTION encounters_protect_signed() RETURNS trigger AS $$
BEGIN
  IF OLD.note_status = 'SIGNED' AND (
    NEW.note_status IS DISTINCT FROM OLD.note_status
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
    OR NEW.doctor_id IS DISTINCT FROM OLD.doctor_id
  ) THEN
    RAISE EXCEPTION 'Signed encounter notes are immutable; add an addendum instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER encounters_signed_immutable
  BEFORE UPDATE ON "encounters"
  FOR EACH ROW EXECUTE FUNCTION encounters_protect_signed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% is not permitted)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER encounter_addenda_append_only
  BEFORE UPDATE OR DELETE ON "encounter_addenda"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
