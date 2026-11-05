CREATE TABLE "care_process_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"register" varchar(20) NOT NULL,
	"process" varchar(30) NOT NULL,
	"result" varchar(30) NOT NULL,
	"notes" varchar(500),
	"performed_at" timestamp with time zone NOT NULL,
	"recorded_by_id" uuid NOT NULL,
	"facility_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "death_record_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"death_record_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"changes" jsonb NOT NULL,
	"reason" varchar(500) NOT NULL,
	"amended_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "death_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"died_at" timestamp with time zone NOT NULL,
	"place_of_death" varchar(30) NOT NULL,
	"place_detail" varchar(200),
	"admission_id" uuid,
	"causes" jsonb NOT NULL,
	"underlying_cause_icd10" varchar(10) NOT NULL,
	"manner_of_death" varchar(30) NOT NULL,
	"autopsy" varchar(12) DEFAULT 'NONE' NOT NULL,
	"pregnancy_status" varchar(20),
	"perinatal" jsonb,
	"reported_to_forensics" boolean DEFAULT false NOT NULL,
	"status" varchar(10) DEFAULT 'DRAFT' NOT NULL,
	"certified_by_id" uuid NOT NULL,
	"signed_at" timestamp with time zone,
	"certificate_number" varchar(30),
	"civil_registry_acknowledged_at" timestamp with time zone,
	"civil_registry_reference" varchar(60),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"description" varchar(500) NOT NULL,
	"owner_id" uuid,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_reviewers" (
	"facility_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medical_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"issued_by_id" uuid NOT NULL,
	"encounter_id" uuid,
	"kind" varchar(30) NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"icd10_code" varchar(10),
	"diagnosis_on_certificate" boolean DEFAULT false NOT NULL,
	"outcome" varchar(30),
	"restrictions" varchar(500),
	"purpose" varchar(200),
	"remarks" text,
	"extends_certificate_id" uuid,
	"serial_number" varchar(30) NOT NULL,
	"verification_code" varchar(40) NOT NULL,
	"status" varchar(10) DEFAULT 'ISSUED' NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" uuid,
	"revoke_reason" varchar(300),
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "register_enrolments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"register" varchar(20) NOT NULL,
	"facility_id" uuid NOT NULL,
	"source" varchar(10) NOT NULL,
	"diagnosis_id" uuid,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enrolled_by_id" uuid,
	"status" varchar(10) DEFAULT 'ACTIVE' NOT NULL,
	"left_at" timestamp with time zone,
	"left_reason" varchar(200)
);
--> statement-breakpoint
CREATE TABLE "safety_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(30) NOT NULL,
	"facility_id" uuid NOT NULL,
	"reported_by_id" uuid,
	"reporter_role" "role" NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unit_id" uuid,
	"location" varchar(200),
	"category" varchar(20) NOT NULL,
	"harm" varchar(10) NOT NULL,
	"description" text NOT NULL,
	"immediate_action" text,
	"patient_id" uuid,
	"status" varchar(15) DEFAULT 'NEW' NOT NULL,
	"reviewer_id" uuid,
	"reviewed_harm" varchar(10),
	"contributing_factors" text[],
	"findings" text,
	"lessons" text,
	"hazard_ref" varchar(10),
	"patient_informed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waiting_list_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"specialty" varchar(40) NOT NULL,
	"kind" varchar(12) DEFAULT 'PROCEDURE' NOT NULL,
	"procedure_code" varchar(20),
	"procedure_name" varchar(200) NOT NULL,
	"priority" varchar(10) NOT NULL,
	"clinical_reason" text,
	"referral_id" uuid,
	"added_by_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"target_date" date NOT NULL,
	"status" varchar(10) DEFAULT 'WAITING' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"surgical_case_id" uuid,
	"appointment_id" uuid,
	"suspended_days" integer DEFAULT 0 NOT NULL,
	"suspended_since" timestamp with time zone,
	"removed_reason" varchar(30),
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waiting_list_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"actor_id" uuid,
	"event" varchar(30) NOT NULL,
	"details" jsonb,
	"reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "patient_documents" ADD COLUMN "storage_backend" varchar(10) DEFAULT 'DB' NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD COLUMN "storage_key" varchar(300);--> statement-breakpoint
ALTER TABLE "patient_documents" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD COLUMN "previous_version_id" uuid;--> statement-breakpoint
ALTER TABLE "patient_documents" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "deceased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vital_signs" ADD COLUMN "capillary_refill_seconds" numeric(3, 1);--> statement-breakpoint
ALTER TABLE "vital_signs" ADD COLUMN "respiratory_effort" varchar(10);--> statement-breakpoint
ALTER TABLE "care_process_records" ADD CONSTRAINT "care_process_records_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_process_records" ADD CONSTRAINT "care_process_records_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_process_records" ADD CONSTRAINT "care_process_records_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_record_amendments" ADD CONSTRAINT "death_record_amendments_death_record_id_death_records_id_fk" FOREIGN KEY ("death_record_id") REFERENCES "public"."death_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_record_amendments" ADD CONSTRAINT "death_record_amendments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_record_amendments" ADD CONSTRAINT "death_record_amendments_amended_by_id_users_id_fk" FOREIGN KEY ("amended_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_records" ADD CONSTRAINT "death_records_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_records" ADD CONSTRAINT "death_records_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_records" ADD CONSTRAINT "death_records_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "death_records" ADD CONSTRAINT "death_records_certified_by_id_users_id_fk" FOREIGN KEY ("certified_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_incident_id_safety_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."safety_incidents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_reviewers" ADD CONSTRAINT "incident_reviewers_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_reviewers" ADD CONSTRAINT "incident_reviewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_issued_by_id_users_id_fk" FOREIGN KEY ("issued_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_extends_certificate_id_medical_certificates_id_fk" FOREIGN KEY ("extends_certificate_id") REFERENCES "public"."medical_certificates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_revoked_by_id_users_id_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_enrolments" ADD CONSTRAINT "register_enrolments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_enrolments" ADD CONSTRAINT "register_enrolments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_enrolments" ADD CONSTRAINT "register_enrolments_diagnosis_id_diagnoses_id_fk" FOREIGN KEY ("diagnosis_id") REFERENCES "public"."diagnoses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "register_enrolments" ADD CONSTRAINT "register_enrolments_enrolled_by_id_users_id_fk" FOREIGN KEY ("enrolled_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_reported_by_id_users_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_unit_id_care_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."care_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_list_entries" ADD CONSTRAINT "waiting_list_entries_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_list_entries" ADD CONSTRAINT "waiting_list_entries_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_list_entries" ADD CONSTRAINT "waiting_list_entries_referral_id_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_list_entries" ADD CONSTRAINT "waiting_list_entries_added_by_id_users_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_list_entries" ADD CONSTRAINT "waiting_list_entries_surgical_case_id_surgical_cases_id_fk" FOREIGN KEY ("surgical_case_id") REFERENCES "public"."surgical_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_list_entries" ADD CONSTRAINT "waiting_list_entries_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_list_events" ADD CONSTRAINT "waiting_list_events_entry_id_waiting_list_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."waiting_list_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_list_events" ADD CONSTRAINT "waiting_list_events_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_list_events" ADD CONSTRAINT "waiting_list_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "care_process_records_patient_idx" ON "care_process_records" USING btree ("patient_id","register","process");--> statement-breakpoint
CREATE INDEX "death_record_amendments_record_idx" ON "death_record_amendments" USING btree ("death_record_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "death_records_patient_uq" ON "death_records" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "death_records_number_uq" ON "death_records" USING btree ("certificate_number");--> statement-breakpoint
CREATE INDEX "death_records_facility_idx" ON "death_records" USING btree ("facility_id","died_at");--> statement-breakpoint
CREATE INDEX "incident_actions_incident_idx" ON "incident_actions" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_reviewers_uq" ON "incident_reviewers" USING btree ("facility_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "medical_certificates_serial_uq" ON "medical_certificates" USING btree ("serial_number");--> statement-breakpoint
CREATE UNIQUE INDEX "medical_certificates_code_uq" ON "medical_certificates" USING btree ("verification_code");--> statement-breakpoint
CREATE INDEX "medical_certificates_patient_idx" ON "medical_certificates" USING btree ("patient_id","issued_at");--> statement-breakpoint
CREATE INDEX "medical_certificates_facility_idx" ON "medical_certificates" USING btree ("facility_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "register_enrolments_active_uq" ON "register_enrolments" USING btree ("patient_id","register") WHERE "register_enrolments"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "register_enrolments_facility_idx" ON "register_enrolments" USING btree ("facility_id","register","status");--> statement-breakpoint
CREATE UNIQUE INDEX "safety_incidents_reference_uq" ON "safety_incidents" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "safety_incidents_facility_idx" ON "safety_incidents" USING btree ("facility_id","status","reported_at");--> statement-breakpoint
CREATE INDEX "waiting_list_facility_idx" ON "waiting_list_entries" USING btree ("facility_id","specialty","status");--> statement-breakpoint
CREATE INDEX "waiting_list_patient_idx" ON "waiting_list_entries" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "waiting_list_events_entry_idx" ON "waiting_list_events" USING btree ("entry_id","created_at");--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_previous_version_id_patient_documents_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."patient_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_documents_previous_uq" ON "patient_documents" USING btree ("previous_version_id");--> statement-breakpoint
ALTER TABLE "death_records" ADD CONSTRAINT "death_records_status_ck" CHECK ("status" IN ('DRAFT', 'SIGNED'));
--> statement-breakpoint
ALTER TABLE "death_records" ADD CONSTRAINT "death_records_place_ck" CHECK ("place_of_death" IN ('HOSPITAL', 'EMERGENCY_DEPARTMENT', 'HOME', 'NURSING_HOME', 'EN_ROUTE', 'OTHER'));
--> statement-breakpoint
ALTER TABLE "death_records" ADD CONSTRAINT "death_records_manner_ck" CHECK ("manner_of_death" IN ('NATURAL', 'ACCIDENT', 'INTENTIONAL_SELF_HARM', 'ASSAULT', 'PENDING_INVESTIGATION', 'UNDETERMINED'));
--> statement-breakpoint
ALTER TABLE "death_records" ADD CONSTRAINT "death_records_autopsy_ck" CHECK ("autopsy" IN ('NONE', 'REQUESTED', 'PENDING', 'PERFORMED'));
--> statement-breakpoint
ALTER TABLE "death_records" ADD CONSTRAINT "death_records_signed_ck" CHECK ("status" <> 'SIGNED' OR ("signed_at" IS NOT NULL AND "certificate_number" IS NOT NULL));
--> statement-breakpoint
-- A signed death certificate is part of the legal record: only the civil registry acknowledgement
-- (and a patient merge) may change it afterwards; corrections are amendment rows.
CREATE OR REPLACE FUNCTION death_records_protect_signed() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'SIGNED' THEN
      RAISE EXCEPTION 'A signed death certificate cannot be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'SIGNED' AND (
    to_jsonb(NEW) - ARRAY['civil_registry_acknowledged_at', 'civil_registry_reference', 'updated_at']
      IS DISTINCT FROM
    to_jsonb(OLD) - ARRAY['civil_registry_acknowledged_at', 'civil_registry_reference', 'updated_at']
  ) THEN
    RAISE EXCEPTION 'A signed death certificate is immutable (record an amendment)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER death_records_protect BEFORE UPDATE OR DELETE ON "death_records"
  FOR EACH ROW EXECUTE FUNCTION death_records_protect_signed();
--> statement-breakpoint
CREATE TRIGGER death_record_amendments_append_only BEFORE UPDATE OR DELETE ON "death_record_amendments"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_kind_ck" CHECK ("kind" IN ('SICK_LEAVE', 'FITNESS_FOR_WORK', 'SCHOOL_ABSENCE', 'SPORTS_FITNESS', 'DRIVING_FITNESS', 'GENERAL'));
--> statement-breakpoint
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_status_ck" CHECK ("status" IN ('ISSUED', 'REVOKED'));
--> statement-breakpoint
ALTER TABLE "medical_certificates" ADD CONSTRAINT "medical_certificates_dates_ck" CHECK ("end_date" IS NULL OR "end_date" >= "start_date");
--> statement-breakpoint
-- Certificates are issued once: only revocation (status, revoked_*) may change a row.
CREATE OR REPLACE FUNCTION medical_certificates_protect() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'medical_certificates cannot be deleted (revoke instead)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'REVOKED'
    OR to_jsonb(NEW) - ARRAY['status', 'revoked_at', 'revoked_by_id', 'revoke_reason']
       IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status', 'revoked_at', 'revoked_by_id', 'revoke_reason'] THEN
    RAISE EXCEPTION 'An issued certificate is immutable (revoke it and issue a new one)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER medical_certificates_protect BEFORE UPDATE OR DELETE ON "medical_certificates"
  FOR EACH ROW EXECUTE FUNCTION medical_certificates_protect();
--> statement-breakpoint
ALTER TABLE "waiting_list_entries" ADD CONSTRAINT "waiting_list_status_ck" CHECK ("status" IN ('WAITING', 'SCHEDULED', 'SUSPENDED', 'COMPLETED', 'REMOVED'));
--> statement-breakpoint
ALTER TABLE "waiting_list_entries" ADD CONSTRAINT "waiting_list_priority_ck" CHECK ("priority" IN ('URGENT', 'PRIORITY', 'ROUTINE'));
--> statement-breakpoint
ALTER TABLE "waiting_list_entries" ADD CONSTRAINT "waiting_list_kind_ck" CHECK ("kind" IN ('PROCEDURE', 'OUTPATIENT'));
--> statement-breakpoint
ALTER TABLE "waiting_list_entries" ADD CONSTRAINT "waiting_list_suspended_ck" CHECK ("suspended_days" >= 0);
--> statement-breakpoint
CREATE TRIGGER waiting_list_events_append_only BEFORE UPDATE OR DELETE ON "waiting_list_events"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
ALTER TABLE "register_enrolments" ADD CONSTRAINT "register_enrolments_register_ck" CHECK ("register" IN ('DIABETES', 'HYPERTENSION', 'ASTHMA', 'COPD', 'CKD', 'HEART_FAILURE'));
--> statement-breakpoint
ALTER TABLE "register_enrolments" ADD CONSTRAINT "register_enrolments_status_ck" CHECK ("status" IN ('ACTIVE', 'LEFT'));
--> statement-breakpoint
ALTER TABLE "register_enrolments" ADD CONSTRAINT "register_enrolments_source_ck" CHECK ("source" IN ('DIAGNOSIS', 'MANUAL'));
--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_category_ck" CHECK ("category" IN ('MEDICATION', 'FALL', 'PRESSURE_INJURY', 'IDENTIFICATION', 'TRANSFUSION', 'DIAGNOSTIC', 'SURGICAL', 'INFECTION', 'EQUIPMENT', 'IT_SYSTEM', 'COMMUNICATION', 'VIOLENCE', 'OTHER'));
--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_harm_ck" CHECK ("harm" IN ('NEAR_MISS', 'NO_HARM', 'LOW', 'MODERATE', 'SEVERE', 'DEATH') AND ("reviewed_harm" IS NULL OR "reviewed_harm" IN ('NEAR_MISS', 'NO_HARM', 'LOW', 'MODERATE', 'SEVERE', 'DEATH')));
--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_status_ck" CHECK ("status" IN ('NEW', 'UNDER_REVIEW', 'ACTION_PLANNED', 'CLOSED'));
--> statement-breakpoint
ALTER TABLE "safety_incidents" ADD CONSTRAINT "safety_incidents_anonymous_ck" CHECK (NOT "anonymous" OR "reported_by_id" IS NULL);
--> statement-breakpoint
ALTER TABLE "vital_signs" ADD CONSTRAINT "vital_signs_respiratory_effort_ck" CHECK ("respiratory_effort" IS NULL OR "respiratory_effort" IN ('NONE', 'MILD', 'MODERATE', 'SEVERE'));
--> statement-breakpoint
ALTER TABLE "vital_signs" ADD CONSTRAINT "vital_signs_capillary_refill_ck" CHECK ("capillary_refill_seconds" IS NULL OR "capillary_refill_seconds" BETWEEN 0 AND 20);
--> statement-breakpoint
ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_storage_ck" CHECK ("storage_backend" IN ('DB', 'S3') AND ("storage_backend" = 'DB' OR "storage_key" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "partner_clients" DROP CONSTRAINT "partner_clients_scopes_ck";
--> statement-breakpoint
ALTER TABLE "partner_clients" ADD CONSTRAINT "partner_clients_scopes_ck" CHECK (
  cardinality("scopes") > 0
  AND "scopes" <@ ARRAY['fhir.patient.read', 'stats.read', 'directory.read', 'births.notify', 'claims.read', 'surveillance.read', 'deaths.read']::text[]);
