CREATE TABLE "advance_directives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" varchar(22) NOT NULL,
	"status" varchar(8) DEFAULT 'ACTIVE' NOT NULL,
	"summary" text NOT NULL,
	"discussed_with" varchar(300),
	"proxy_name" varchar(200),
	"proxy_phone" varchar(40),
	"document_id" uuid,
	"review_date" date,
	"facility_id" uuid,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" uuid,
	"revoke_reason" varchar(500)
);
--> statement-breakpoint
CREATE TABLE "antenatal_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pregnancy_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid,
	"visit_at" timestamp with time zone NOT NULL,
	"gestation_days" smallint NOT NULL,
	"systolic" smallint,
	"diastolic" smallint,
	"weight_kg" numeric(5, 1),
	"fundal_height_cm" numeric(4, 1),
	"fetal_heart_rate" smallint,
	"presentation" varchar(12),
	"urine_protein" varchar(8),
	"oedema" boolean,
	"fetal_movements" boolean,
	"notes" text,
	"next_visit_date" date,
	"recorded_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "community_dispensings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"partner_client_id" uuid NOT NULL,
	"pharmacy_name" varchar(200) NOT NULL,
	"pharmacist_name" varchar(200) NOT NULL,
	"pharmacist_licence" varchar(60),
	"supply_number" smallint NOT NULL,
	"product_name" varchar(200) NOT NULL,
	"quantity" varchar(100) NOT NULL,
	"reverses_id" uuid,
	"reason" varchar(300),
	"dispensed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "complaints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(30) NOT NULL,
	"facility_id" uuid NOT NULL,
	"patient_id" uuid,
	"submitted_by_user_id" uuid,
	"channel" varchar(10) NOT NULL,
	"category" varchar(20) NOT NULL,
	"description" text NOT NULL,
	"desired_outcome" text,
	"status" varchar(14) DEFAULT 'RECEIVED' NOT NULL,
	"assigned_to_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"acknowledge_due_at" timestamp with time zone NOT NULL,
	"response_due_at" timestamp with time zone NOT NULL,
	"response" text,
	"responded_at" timestamp with time zone,
	"responded_by_id" uuid,
	"outcome" varchar(14),
	"escalated_at" timestamp with time zone,
	"escalation_reason" text,
	"ministry_decision" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"unit_id" uuid,
	"setting" varchar(12) NOT NULL,
	"dedupe_key" varchar(64) NOT NULL,
	"overall" smallint NOT NULL,
	"scores" jsonb,
	"would_recommend" boolean,
	"comment" text,
	"month" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organ_donation_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"decision" varchar(12) NOT NULL,
	"organs" text[],
	"family_informed" boolean,
	"faith_or_belief_note" varchar(300),
	"recorded_via" varchar(10) NOT NULL,
	"recorded_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pregnancies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"lmp_date" date,
	"edd_date" date NOT NULL,
	"edd_method" varchar(12) NOT NULL,
	"gravida" smallint NOT NULL,
	"para" smallint NOT NULL,
	"risk_level" varchar(6) DEFAULT 'LOW' NOT NULL,
	"risk_factors" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" varchar(16) DEFAULT 'ONGOING' NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome_note" varchar(500),
	"birth_id" uuid,
	"booked_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "professional_licences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"licence_number" varchar(40) NOT NULL,
	"holder_name" varchar(200) NOT NULL,
	"profession" varchar(12) NOT NULL,
	"specialty" varchar(120),
	"issued_by" varchar(200) NOT NULL,
	"issued_on" date NOT NULL,
	"valid_until" date NOT NULL,
	"status" varchar(10) DEFAULT 'ACTIVE' NOT NULL,
	"status_reason" varchar(500),
	"cpd_credits" smallint DEFAULT 0 NOT NULL,
	"user_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screening_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"programme" varchar(12) NOT NULL,
	"facility_id" uuid NOT NULL,
	"status" varchar(12) DEFAULT 'INVITED' NOT NULL,
	"invited_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"due_date" date NOT NULL,
	"booked_for" timestamp with time zone,
	"screened_at" timestamp with time zone,
	"test_type" varchar(20),
	"result" varchar(12),
	"result_detail" varchar(300),
	"resulted_at" timestamp with time zone,
	"referral_id" uuid,
	"next_due_date" date,
	"recorded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "screening_opt_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"programme" varchar(12) NOT NULL,
	"reason" varchar(300),
	"recorded_via" varchar(10) NOT NULL,
	"recorded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "death_records_patient_uq";--> statement-breakpoint
ALTER TABLE "death_records" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "death_records" ADD COLUMN "withdrawn_by_id" uuid;--> statement-breakpoint
ALTER TABLE "death_records" ADD COLUMN "withdraw_reason" varchar(500);--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "e_prescription_code" varchar(16);--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "repeats_allowed" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "community_valid_until" date;--> statement-breakpoint
ALTER TABLE "advance_directives" ADD CONSTRAINT "advance_directives_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_directives" ADD CONSTRAINT "advance_directives_document_id_patient_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."patient_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_directives" ADD CONSTRAINT "advance_directives_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_directives" ADD CONSTRAINT "advance_directives_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advance_directives" ADD CONSTRAINT "advance_directives_revoked_by_id_users_id_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "antenatal_visits" ADD CONSTRAINT "antenatal_visits_pregnancy_id_pregnancies_id_fk" FOREIGN KEY ("pregnancy_id") REFERENCES "public"."pregnancies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "antenatal_visits" ADD CONSTRAINT "antenatal_visits_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "antenatal_visits" ADD CONSTRAINT "antenatal_visits_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "antenatal_visits" ADD CONSTRAINT "antenatal_visits_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_dispensings" ADD CONSTRAINT "community_dispensings_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_dispensings" ADD CONSTRAINT "community_dispensings_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_dispensings" ADD CONSTRAINT "community_dispensings_partner_client_id_partner_clients_id_fk" FOREIGN KEY ("partner_client_id") REFERENCES "public"."partner_clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_dispensings" ADD CONSTRAINT "community_dispensings_reverses_id_community_dispensings_id_fk" FOREIGN KEY ("reverses_id") REFERENCES "public"."community_dispensings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_responded_by_id_users_id_fk" FOREIGN KEY ("responded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_unit_id_care_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."care_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organ_donation_decisions" ADD CONSTRAINT "organ_donation_decisions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organ_donation_decisions" ADD CONSTRAINT "organ_donation_decisions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancies" ADD CONSTRAINT "pregnancies_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancies" ADD CONSTRAINT "pregnancies_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancies" ADD CONSTRAINT "pregnancies_birth_id_births_id_fk" FOREIGN KEY ("birth_id") REFERENCES "public"."births"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pregnancies" ADD CONSTRAINT "pregnancies_booked_by_id_users_id_fk" FOREIGN KEY ("booked_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_licences" ADD CONSTRAINT "professional_licences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_licences" ADD CONSTRAINT "professional_licences_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_episodes" ADD CONSTRAINT "screening_episodes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_episodes" ADD CONSTRAINT "screening_episodes_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_episodes" ADD CONSTRAINT "screening_episodes_referral_id_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_episodes" ADD CONSTRAINT "screening_episodes_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_opt_outs" ADD CONSTRAINT "screening_opt_outs_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "screening_opt_outs" ADD CONSTRAINT "screening_opt_outs_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "advance_directives_patient_idx" ON "advance_directives" USING btree ("patient_id","status");--> statement-breakpoint
CREATE INDEX "antenatal_visits_pregnancy_idx" ON "antenatal_visits" USING btree ("pregnancy_id","visit_at");--> statement-breakpoint
CREATE INDEX "community_dispensings_prescription_idx" ON "community_dispensings" USING btree ("prescription_id","dispensed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "community_dispensings_reverses_uq" ON "community_dispensings" USING btree ("reverses_id");--> statement-breakpoint
CREATE UNIQUE INDEX "complaints_reference_uq" ON "complaints" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "complaints_facility_idx" ON "complaints" USING btree ("facility_id","status","response_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_responses_dedupe_uq" ON "feedback_responses" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "feedback_responses_facility_idx" ON "feedback_responses" USING btree ("facility_id","month");--> statement-breakpoint
CREATE INDEX "organ_donation_decisions_patient_idx" ON "organ_donation_decisions" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pregnancies_ongoing_uq" ON "pregnancies" USING btree ("patient_id") WHERE "pregnancies"."status" = 'ONGOING';--> statement-breakpoint
CREATE INDEX "pregnancies_facility_idx" ON "pregnancies" USING btree ("facility_id","status","edd_date");--> statement-breakpoint
CREATE UNIQUE INDEX "professional_licences_number_uq" ON "professional_licences" USING btree ("licence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "professional_licences_user_uq" ON "professional_licences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "professional_licences_valid_idx" ON "professional_licences" USING btree ("status","valid_until");--> statement-breakpoint
CREATE INDEX "screening_episodes_patient_idx" ON "screening_episodes" USING btree ("patient_id","programme");--> statement-breakpoint
CREATE INDEX "screening_episodes_facility_idx" ON "screening_episodes" USING btree ("facility_id","programme","status");--> statement-breakpoint
CREATE UNIQUE INDEX "screening_opt_outs_active_uq" ON "screening_opt_outs" USING btree ("patient_id","programme") WHERE "screening_opt_outs"."withdrawn_at" IS NULL;--> statement-breakpoint
ALTER TABLE "death_records" ADD CONSTRAINT "death_records_withdrawn_by_id_users_id_fk" FOREIGN KEY ("withdrawn_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prescriptions_e_code_uq" ON "prescriptions" USING btree ("e_prescription_code");--> statement-breakpoint
CREATE UNIQUE INDEX "death_records_patient_uq" ON "death_records" USING btree ("patient_id") WHERE "death_records"."status" <> 'WITHDRAWN';--> statement-breakpoint
ALTER TABLE "pregnancies" ADD CONSTRAINT "pregnancies_status_ck" CHECK ("status" IN ('ONGOING', 'DELIVERED', 'MISCARRIAGE', 'TERMINATION', 'ECTOPIC', 'TRANSFERRED_OUT'));
--> statement-breakpoint
ALTER TABLE "pregnancies" ADD CONSTRAINT "pregnancies_values_ck" CHECK ("edd_method" IN ('LMP', 'ULTRASOUND') AND "risk_level" IN ('LOW', 'HIGH') AND "gravida" BETWEEN 1 AND 30 AND "para" BETWEEN 0 AND 30 AND "para" < "gravida");
--> statement-breakpoint
ALTER TABLE "antenatal_visits" ADD CONSTRAINT "antenatal_visits_values_ck" CHECK ("gestation_days" BETWEEN 0 AND 315 AND ("presentation" IS NULL OR "presentation" IN ('CEPHALIC', 'BREECH', 'TRANSVERSE', 'UNKNOWN')) AND ("urine_protein" IS NULL OR "urine_protein" IN ('NEGATIVE', 'TRACE', '1+', '2+', '3+')));
--> statement-breakpoint
ALTER TABLE "screening_episodes" ADD CONSTRAINT "screening_episodes_values_ck" CHECK ("programme" IN ('CERVICAL', 'BREAST', 'COLORECTAL') AND "status" IN ('INVITED', 'BOOKED', 'SCREENED', 'RESULTED', 'REFERRED', 'DECLINED', 'NOT_ELIGIBLE', 'CLOSED') AND ("result" IS NULL OR "result" IN ('NORMAL', 'ABNORMAL', 'INADEQUATE')));
--> statement-breakpoint
ALTER TABLE "screening_opt_outs" ADD CONSTRAINT "screening_opt_outs_values_ck" CHECK ("programme" IN ('CERVICAL', 'BREAST', 'COLORECTAL') AND "recorded_via" IN ('PORTAL', 'IN_PERSON'));
--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_repeats_ck" CHECK ("repeats_allowed" BETWEEN 0 AND 12);
--> statement-breakpoint
CREATE TRIGGER community_dispensings_append_only BEFORE UPDATE OR DELETE ON "community_dispensings"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
ALTER TABLE "professional_licences" ADD CONSTRAINT "professional_licences_values_ck" CHECK ("profession" IN ('PHYSICIAN', 'NURSE', 'MIDWIFE', 'PHARMACIST', 'DENTIST') AND "status" IN ('ACTIVE', 'SUSPENDED', 'REVOKED') AND "valid_until" >= "issued_on" AND "cpd_credits" >= 0);
--> statement-breakpoint
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_values_ck" CHECK ("channel" IN ('PORTAL', 'IN_PERSON', 'PHONE', 'LETTER') AND "category" IN ('CARE_QUALITY', 'COMMUNICATION', 'WAITING_TIME', 'STAFF_ATTITUDE', 'BILLING', 'PRIVACY', 'FACILITIES', 'OTHER') AND "status" IN ('RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESPONDED', 'CLOSED', 'ESCALATED') AND ("outcome" IS NULL OR "outcome" IN ('UPHELD', 'PARTLY_UPHELD', 'NOT_UPHELD', 'WITHDRAWN')));
--> statement-breakpoint
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_values_ck" CHECK ("overall" BETWEEN 1 AND 5 AND "setting" IN ('OUTPATIENT', 'INPATIENT', 'EMERGENCY', 'VIDEO'));
--> statement-breakpoint
ALTER TABLE "organ_donation_decisions" ADD CONSTRAINT "organ_donation_decisions_values_ck" CHECK ("decision" IN ('DONOR', 'DONOR_SOME', 'NOT_DONOR') AND "recorded_via" IN ('PORTAL', 'IN_PERSON') AND ("decision" <> 'DONOR_SOME' OR cardinality("organs") > 0));
--> statement-breakpoint
CREATE TRIGGER organ_donation_decisions_append_only BEFORE UPDATE OR DELETE ON "organ_donation_decisions"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
ALTER TABLE "advance_directives" ADD CONSTRAINT "advance_directives_values_ck" CHECK ("kind" IN ('DNACPR', 'TREATMENT_ESCALATION', 'ADVANCE_REFUSAL', 'HEALTHCARE_PROXY') AND "status" IN ('ACTIVE', 'REVOKED') AND ("status" <> 'REVOKED' OR ("revoked_at" IS NOT NULL AND "revoke_reason" IS NOT NULL)));
--> statement-breakpoint
-- Directives are never edited: only revocation may change a row.
CREATE OR REPLACE FUNCTION advance_directives_protect() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'advance_directives cannot be deleted (revoke instead)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'REVOKED'
    OR to_jsonb(NEW) - ARRAY['status', 'revoked_at', 'revoked_by_id', 'revoke_reason']
       IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status', 'revoked_at', 'revoked_by_id', 'revoke_reason'] THEN
    RAISE EXCEPTION 'An advance directive is immutable (revoke it and record a new one)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER advance_directives_protect BEFORE UPDATE OR DELETE ON "advance_directives"
  FOR EACH ROW EXECUTE FUNCTION advance_directives_protect();
--> statement-breakpoint
-- Death certificates: the Ministry may withdraw a signed certificate (e.g. certified for the wrong
-- person). Withdrawal changes only the status and withdrawal columns; a withdrawn record is final.
ALTER TABLE "death_records" DROP CONSTRAINT "death_records_status_ck";
--> statement-breakpoint
ALTER TABLE "death_records" ADD CONSTRAINT "death_records_status_ck" CHECK ("status" IN ('DRAFT', 'SIGNED', 'WITHDRAWN') AND ("status" <> 'WITHDRAWN' OR ("withdrawn_at" IS NOT NULL AND "withdrawn_by_id" IS NOT NULL AND "withdraw_reason" IS NOT NULL AND "signed_at" IS NOT NULL)));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION death_records_protect_signed() RETURNS trigger AS $$
DECLARE
  withdrawal_columns text[] := ARRAY['status', 'withdrawn_at', 'withdrawn_by_id', 'withdraw_reason', 'updated_at'];
  registry_columns text[] := ARRAY['civil_registry_acknowledged_at', 'civil_registry_reference', 'updated_at'];
BEGIN
  IF TG_OP = 'UPDATE' AND is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'A signed death certificate cannot be deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'WITHDRAWN' THEN
    RAISE EXCEPTION 'A withdrawn death certificate is final' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'SIGNED' THEN
    IF NEW.status = 'WITHDRAWN'
       AND to_jsonb(NEW) - withdrawal_columns IS NOT DISTINCT FROM to_jsonb(OLD) - withdrawal_columns THEN
      RETURN NEW;
    END IF;
    IF to_jsonb(NEW) - registry_columns IS DISTINCT FROM to_jsonb(OLD) - registry_columns THEN
      RAISE EXCEPTION 'A signed death certificate is immutable (record an amendment)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
ALTER TABLE "partner_clients" DROP CONSTRAINT "partner_clients_scopes_ck";
--> statement-breakpoint
ALTER TABLE "partner_clients" ADD CONSTRAINT "partner_clients_scopes_ck" CHECK (
  cardinality("scopes") > 0
  AND "scopes" <@ ARRAY['fhir.patient.read', 'stats.read', 'directory.read', 'births.notify', 'claims.read', 'surveillance.read', 'deaths.read', 'prescriptions.dispense']::text[]);
