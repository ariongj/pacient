CREATE TYPE "public"."consent_decision" AS ENUM('GRANTED', 'WITHDRAWN', 'REFUSED');--> statement-breakpoint
CREATE TYPE "public"."consent_method" AS ENUM('PORTAL', 'IN_PERSON', 'WRITTEN');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('CROSS_FACILITY_SHARING', 'RESEARCH', 'TREATMENT');--> statement-breakpoint
CREATE TYPE "public"."document_category" AS ENUM('REFERRAL_LETTER', 'DISCHARGE_SUMMARY', 'IMAGING_REPORT', 'LAB_REPORT', 'CONSENT_FORM', 'CLINICAL_PHOTO', 'PATIENT_PROVIDED', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('CURRENT', 'ENTERED_IN_ERROR');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('CLEAN', 'NOT_SCANNED');--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"type" "consent_type" NOT NULL,
	"decision" "consent_decision" NOT NULL,
	"method" "consent_method" NOT NULL,
	"procedure" varchar(200),
	"wording_version" varchar(20) NOT NULL,
	"note" varchar(1000),
	"document_id" uuid,
	"recorded_by_id" uuid NOT NULL,
	"on_behalf_guardianship_id" uuid,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cover_arrangements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"cover_doctor_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"note" varchar(300),
	"created_by_id" uuid NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_contents" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"content" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"category" "document_category" NOT NULL,
	"title" varchar(200) NOT NULL,
	"file_name" varchar(200) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"scan_status" "scan_status" DEFAULT 'NOT_SCANNED' NOT NULL,
	"source" varchar(10) DEFAULT 'STAFF' NOT NULL,
	"visible_to_patient" boolean DEFAULT false NOT NULL,
	"confidential_from_guardians" boolean DEFAULT false NOT NULL,
	"facility_id" uuid,
	"uploaded_by_id" uuid NOT NULL,
	"status" "document_status" DEFAULT 'CURRENT' NOT NULL,
	"error_reason" varchar(300),
	"marked_in_error_by_id" uuid,
	"marked_in_error_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "result_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_result_id" uuid NOT NULL,
	"level" integer NOT NULL,
	"notified_user_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_document_id_patient_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."patient_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_on_behalf_guardianship_id_guardianships_id_fk" FOREIGN KEY ("on_behalf_guardianship_id") REFERENCES "public"."guardianships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cover_arrangements" ADD CONSTRAINT "cover_arrangements_doctor_id_users_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cover_arrangements" ADD CONSTRAINT "cover_arrangements_cover_doctor_id_users_id_fk" FOREIGN KEY ("cover_doctor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cover_arrangements" ADD CONSTRAINT "cover_arrangements_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cover_arrangements" ADD CONSTRAINT "cover_arrangements_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_contents" ADD CONSTRAINT "document_contents_document_id_patient_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."patient_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_marked_in_error_by_id_users_id_fk" FOREIGN KEY ("marked_in_error_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_escalations" ADD CONSTRAINT "result_escalations_lab_result_id_lab_results_id_fk" FOREIGN KEY ("lab_result_id") REFERENCES "public"."lab_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_records_patient_idx" ON "consent_records" USING btree ("patient_id","type","created_at");--> statement-breakpoint
CREATE INDEX "cover_arrangements_doctor_idx" ON "cover_arrangements" USING btree ("doctor_id","ends_at");--> statement-breakpoint
CREATE INDEX "cover_arrangements_cover_idx" ON "cover_arrangements" USING btree ("cover_doctor_id","ends_at");--> statement-breakpoint
CREATE INDEX "patient_documents_patient_idx" ON "patient_documents" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "result_escalations_uq" ON "result_escalations" USING btree ("lab_result_id","level");--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_source_ck" CHECK ("source" IN ('STAFF', 'PATIENT'));
--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_size_ck" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760);
--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_error_reason_ck" CHECK ("status" = 'CURRENT' OR "error_reason" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_procedure_ck" CHECK (("type" = 'TREATMENT') = ("procedure" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "cover_arrangements" ADD CONSTRAINT "cover_arrangements_period_ck" CHECK ("ends_at" > "starts_at");
--> statement-breakpoint
ALTER TABLE "cover_arrangements" ADD CONSTRAINT "cover_arrangements_not_self_ck" CHECK ("doctor_id" <> "cover_doctor_id");
--> statement-breakpoint
-- Consent history is append-only, like the audit log.
CREATE OR REPLACE FUNCTION consent_records_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_records is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER consent_records_no_update BEFORE UPDATE OR DELETE ON "consent_records"
  FOR EACH ROW EXECUTE FUNCTION consent_records_immutable();
