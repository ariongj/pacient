ALTER TYPE "public"."care_unit_type" ADD VALUE 'DIALYSIS';--> statement-breakpoint
ALTER TYPE "public"."care_unit_type" ADD VALUE 'PSYCHIATRIC';--> statement-breakpoint
CREATE TABLE "blood_donations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"donor_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"attended_at" timestamp with time zone NOT NULL,
	"questionnaire" jsonb NOT NULL,
	"haemoglobin" numeric(4, 1),
	"systolic" smallint,
	"diastolic" smallint,
	"pulse" smallint,
	"weight_kg" numeric(5, 1),
	"outcome" varchar(10) NOT NULL,
	"deferral_reason" varchar(300),
	"volume_ml" integer,
	"blood_unit_id" uuid,
	"adverse_reaction" varchar(300),
	"recorded_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blood_donors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"abo" varchar(2),
	"rh_d" varchar(3),
	"status" varchar(22) DEFAULT 'ACTIVE' NOT NULL,
	"deferred_until" date,
	"deferral_reason" varchar(300),
	"first_donation_at" timestamp with time zone,
	"last_donation_at" timestamp with time zone,
	"donation_count" integer DEFAULT 0 NOT NULL,
	"contact_consent" boolean DEFAULT false NOT NULL,
	"registered_at_facility_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cancer_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"diagnosed_on" date NOT NULL,
	"icd10" varchar(10) NOT NULL,
	"topography" varchar(10) NOT NULL,
	"morphology" varchar(10) NOT NULL,
	"laterality" varchar(14) DEFAULT 'NOT_APPLICABLE' NOT NULL,
	"basis_of_diagnosis" varchar(24) NOT NULL,
	"tnm_t" varchar(6),
	"tnm_n" varchar(6),
	"tnm_m" varchar(6),
	"stage" varchar(8),
	"tnm_edition" varchar(10),
	"status" varchar(10) DEFAULT 'ACTIVE' NOT NULL,
	"registered_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dialysis_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"days" text[] NOT NULL,
	"shift" varchar(10) NOT NULL,
	"duration_minutes" smallint DEFAULT 240 NOT NULL,
	"target_weight_kg" numeric(5, 1),
	"vascular_access" varchar(20) NOT NULL,
	"status" varchar(8) DEFAULT 'ACTIVE' NOT NULL,
	"started_on" date NOT NULL,
	"ended_on" date,
	"end_reason" varchar(300),
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dialysis_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"unit_id" uuid NOT NULL,
	"schedule_id" uuid,
	"session_date" date NOT NULL,
	"status" varchar(12) DEFAULT 'PLANNED' NOT NULL,
	"machine" varchar(40),
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"pre_weight_kg" numeric(5, 1),
	"post_weight_kg" numeric(5, 1),
	"pre_systolic" smallint,
	"pre_diastolic" smallint,
	"post_systolic" smallint,
	"post_diastolic" smallint,
	"ultrafiltration_ml" integer,
	"blood_flow_ml_min" smallint,
	"pre_urea" numeric(5, 1),
	"post_urea" numeric(5, 1),
	"complications" text[] DEFAULT '{}'::text[] NOT NULL,
	"notes" text,
	"missed_reason" varchar(300),
	"nurse_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_readings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"plan_id" uuid,
	"kind" varchar(16) NOT NULL,
	"values" jsonb NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"source" varchar(8) DEFAULT 'PORTAL' NOT NULL,
	"entered_by_user_id" uuid,
	"note" varchar(300),
	"flag" varchar(12) DEFAULT 'NORMAL' NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_id" uuid,
	"review_note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "involuntary_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"grounds" text[] NOT NULL,
	"assessment" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"decided_by_id" uuid NOT NULL,
	"second_opinion_by_id" uuid,
	"second_opinion_at" timestamp with time zone,
	"second_opinion_confirms" boolean,
	"court_notified_at" timestamp with time zone,
	"court_reference" varchar(60),
	"court_decision_at" timestamp with time zone,
	"court_decision" varchar(10),
	"authorised_until" timestamp with time zone,
	"rights_explained_at" timestamp with time zone,
	"representative_name" varchar(200),
	"representative_notified_at" timestamp with time zone,
	"status" varchar(10) DEFAULT 'ACTIVE' NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mdt_case_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"cancer_case_id" uuid,
	"referred_by_id" uuid NOT NULL,
	"question" varchar(500) NOT NULL,
	"summary" text,
	"recommendation" varchar(14),
	"recommendation_text" text,
	"status" varchar(10) DEFAULT 'PENDING' NOT NULL,
	"decided_at" timestamp with time zone,
	"recorded_by_id" uuid,
	"patient_informed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mdt_meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"tumour_group" varchar(14) NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"chair_id" uuid NOT NULL,
	"status" varchar(10) DEFAULT 'PLANNED' NOT NULL,
	"attendees" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitoring_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"enrolled_by_id" uuid NOT NULL,
	"kinds" text[] NOT NULL,
	"thresholds" jsonb NOT NULL,
	"frequency" varchar(100),
	"instructions" text,
	"status" varchar(8) DEFAULT 'ACTIVE' NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restrictive_interventions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"admission_id" uuid,
	"facility_id" uuid NOT NULL,
	"kind" varchar(24) NOT NULL,
	"reason" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ordered_by_id" uuid NOT NULL,
	"observations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"injuries" varchar(300),
	"debrief_at" timestamp with time zone,
	"debrief_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blood_donations" ADD CONSTRAINT "blood_donations_donor_id_blood_donors_id_fk" FOREIGN KEY ("donor_id") REFERENCES "public"."blood_donors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_donations" ADD CONSTRAINT "blood_donations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_donations" ADD CONSTRAINT "blood_donations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_donations" ADD CONSTRAINT "blood_donations_blood_unit_id_blood_units_id_fk" FOREIGN KEY ("blood_unit_id") REFERENCES "public"."blood_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_donations" ADD CONSTRAINT "blood_donations_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_donors" ADD CONSTRAINT "blood_donors_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blood_donors" ADD CONSTRAINT "blood_donors_registered_at_facility_id_facilities_id_fk" FOREIGN KEY ("registered_at_facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancer_cases" ADD CONSTRAINT "cancer_cases_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancer_cases" ADD CONSTRAINT "cancer_cases_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancer_cases" ADD CONSTRAINT "cancer_cases_registered_by_id_users_id_fk" FOREIGN KEY ("registered_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialysis_schedules" ADD CONSTRAINT "dialysis_schedules_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialysis_schedules" ADD CONSTRAINT "dialysis_schedules_unit_id_care_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."care_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialysis_schedules" ADD CONSTRAINT "dialysis_schedules_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialysis_sessions" ADD CONSTRAINT "dialysis_sessions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialysis_sessions" ADD CONSTRAINT "dialysis_sessions_unit_id_care_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."care_units"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialysis_sessions" ADD CONSTRAINT "dialysis_sessions_schedule_id_dialysis_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."dialysis_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dialysis_sessions" ADD CONSTRAINT "dialysis_sessions_nurse_id_users_id_fk" FOREIGN KEY ("nurse_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_readings" ADD CONSTRAINT "home_readings_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_readings" ADD CONSTRAINT "home_readings_plan_id_monitoring_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."monitoring_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_readings" ADD CONSTRAINT "home_readings_entered_by_user_id_users_id_fk" FOREIGN KEY ("entered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_readings" ADD CONSTRAINT "home_readings_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "involuntary_admissions" ADD CONSTRAINT "involuntary_admissions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "involuntary_admissions" ADD CONSTRAINT "involuntary_admissions_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "involuntary_admissions" ADD CONSTRAINT "involuntary_admissions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "involuntary_admissions" ADD CONSTRAINT "involuntary_admissions_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "involuntary_admissions" ADD CONSTRAINT "involuntary_admissions_second_opinion_by_id_users_id_fk" FOREIGN KEY ("second_opinion_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdt_case_reviews" ADD CONSTRAINT "mdt_case_reviews_meeting_id_mdt_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."mdt_meetings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdt_case_reviews" ADD CONSTRAINT "mdt_case_reviews_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdt_case_reviews" ADD CONSTRAINT "mdt_case_reviews_cancer_case_id_cancer_cases_id_fk" FOREIGN KEY ("cancer_case_id") REFERENCES "public"."cancer_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdt_case_reviews" ADD CONSTRAINT "mdt_case_reviews_referred_by_id_users_id_fk" FOREIGN KEY ("referred_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdt_case_reviews" ADD CONSTRAINT "mdt_case_reviews_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdt_meetings" ADD CONSTRAINT "mdt_meetings_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mdt_meetings" ADD CONSTRAINT "mdt_meetings_chair_id_users_id_fk" FOREIGN KEY ("chair_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_plans" ADD CONSTRAINT "monitoring_plans_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_plans" ADD CONSTRAINT "monitoring_plans_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_plans" ADD CONSTRAINT "monitoring_plans_enrolled_by_id_users_id_fk" FOREIGN KEY ("enrolled_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restrictive_interventions" ADD CONSTRAINT "restrictive_interventions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restrictive_interventions" ADD CONSTRAINT "restrictive_interventions_admission_id_admissions_id_fk" FOREIGN KEY ("admission_id") REFERENCES "public"."admissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restrictive_interventions" ADD CONSTRAINT "restrictive_interventions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restrictive_interventions" ADD CONSTRAINT "restrictive_interventions_ordered_by_id_users_id_fk" FOREIGN KEY ("ordered_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blood_donations_donor_idx" ON "blood_donations" USING btree ("donor_id","attended_at");--> statement-breakpoint
CREATE UNIQUE INDEX "blood_donors_patient_uq" ON "blood_donors" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "cancer_cases_patient_idx" ON "cancer_cases" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "cancer_cases_diagnosed_idx" ON "cancer_cases" USING btree ("diagnosed_on","topography");--> statement-breakpoint
CREATE UNIQUE INDEX "dialysis_schedules_active_uq" ON "dialysis_schedules" USING btree ("patient_id") WHERE "dialysis_schedules"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "dialysis_schedules_unit_idx" ON "dialysis_schedules" USING btree ("unit_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "dialysis_sessions_patient_day_uq" ON "dialysis_sessions" USING btree ("patient_id","session_date");--> statement-breakpoint
CREATE INDEX "dialysis_sessions_unit_idx" ON "dialysis_sessions" USING btree ("unit_id","session_date");--> statement-breakpoint
CREATE INDEX "home_readings_patient_idx" ON "home_readings" USING btree ("patient_id","kind","measured_at");--> statement-breakpoint
CREATE INDEX "home_readings_flag_idx" ON "home_readings" USING btree ("flag","reviewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "involuntary_admissions_active_uq" ON "involuntary_admissions" USING btree ("patient_id") WHERE "involuntary_admissions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "involuntary_admissions_facility_idx" ON "involuntary_admissions" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "mdt_case_reviews_meeting_idx" ON "mdt_case_reviews" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "mdt_case_reviews_patient_idx" ON "mdt_case_reviews" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "mdt_meetings_facility_idx" ON "mdt_meetings" USING btree ("facility_id","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "monitoring_plans_active_uq" ON "monitoring_plans" USING btree ("patient_id") WHERE "monitoring_plans"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "restrictive_interventions_facility_idx" ON "restrictive_interventions" USING btree ("facility_id","started_at");--> statement-breakpoint
ALTER TABLE "monitoring_plans" ADD CONSTRAINT "monitoring_plans_values_ck" CHECK ("status" IN ('ACTIVE', 'ENDED') AND cardinality("kinds") > 0 AND "kinds" <@ ARRAY['BLOOD_PRESSURE', 'GLUCOSE', 'WEIGHT', 'SPO2', 'HEART_RATE', 'TEMPERATURE', 'PEAK_FLOW']::text[]);
--> statement-breakpoint
ALTER TABLE "home_readings" ADD CONSTRAINT "home_readings_values_ck" CHECK ("kind" IN ('BLOOD_PRESSURE', 'GLUCOSE', 'WEIGHT', 'SPO2', 'HEART_RATE', 'TEMPERATURE', 'PEAK_FLOW') AND "source" IN ('PORTAL', 'DEVICE') AND "flag" IN ('NORMAL', 'OUT_OF_RANGE', 'URGENT'));
--> statement-breakpoint
ALTER TABLE "cancer_cases" ADD CONSTRAINT "cancer_cases_values_ck" CHECK ("laterality" IN ('LEFT', 'RIGHT', 'BILATERAL', 'NOT_APPLICABLE', 'UNKNOWN') AND "basis_of_diagnosis" IN ('HISTOLOGY', 'CYTOLOGY', 'CLINICAL_INVESTIGATION', 'CLINICAL_ONLY', 'DEATH_CERTIFICATE_ONLY') AND "status" IN ('ACTIVE', 'DUPLICATE', 'WITHDRAWN') AND ("stage" IS NULL OR "stage" IN ('0', 'I', 'II', 'III', 'IV', 'UNKNOWN')) AND "topography" ~ '^C[0-9]{2}\.[0-9]$' AND "morphology" ~ '^[0-9]{4}/[0-3]$');
--> statement-breakpoint
ALTER TABLE "mdt_meetings" ADD CONSTRAINT "mdt_meetings_status_ck" CHECK ("status" IN ('PLANNED', 'HELD', 'CANCELLED'));
--> statement-breakpoint
ALTER TABLE "mdt_case_reviews" ADD CONSTRAINT "mdt_case_reviews_status_ck" CHECK ("status" IN ('PENDING', 'DISCUSSED', 'DEFERRED'));
--> statement-breakpoint
ALTER TABLE "dialysis_schedules" ADD CONSTRAINT "dialysis_schedules_values_ck" CHECK ("shift" IN ('MORNING', 'AFTERNOON', 'EVENING') AND "status" IN ('ACTIVE', 'ENDED') AND "vascular_access" IN ('FISTULA', 'GRAFT', 'TUNNELLED_CATHETER', 'TEMPORARY_CATHETER') AND cardinality("days") BETWEEN 1 AND 7 AND "days" <@ ARRAY['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']::text[] AND "duration_minutes" BETWEEN 60 AND 600);
--> statement-breakpoint
ALTER TABLE "dialysis_sessions" ADD CONSTRAINT "dialysis_sessions_status_ck" CHECK ("status" IN ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'MISSED', 'CANCELLED'));
--> statement-breakpoint
ALTER TABLE "involuntary_admissions" ADD CONSTRAINT "involuntary_admissions_values_ck" CHECK ("status" IN ('ACTIVE', 'ENDED', 'RELEASED') AND ("court_decision" IS NULL OR "court_decision" IN ('CONFIRMED', 'REJECTED')) AND cardinality("grounds") > 0 AND ("second_opinion_by_id" IS NULL OR "second_opinion_by_id" <> "decided_by_id"));
--> statement-breakpoint
ALTER TABLE "restrictive_interventions" ADD CONSTRAINT "restrictive_interventions_values_ck" CHECK ("kind" IN ('PHYSICAL_RESTRAINT', 'MECHANICAL_RESTRAINT', 'SECLUSION', 'RAPID_TRANQUILLISATION') AND ("ended_at" IS NULL OR "ended_at" >= "started_at"));
--> statement-breakpoint
ALTER TABLE "blood_donors" ADD CONSTRAINT "blood_donors_values_ck" CHECK ("status" IN ('ACTIVE', 'DEFERRED', 'PERMANENTLY_DEFERRED') AND ("abo" IS NULL OR "abo" IN ('A', 'B', 'AB', 'O')) AND ("rh_d" IS NULL OR "rh_d" IN ('POS', 'NEG')) AND "donation_count" >= 0);
--> statement-breakpoint
ALTER TABLE "blood_donations" ADD CONSTRAINT "blood_donations_values_ck" CHECK ("outcome" IN ('COMPLETED', 'DEFERRED', 'ABORTED') AND ("outcome" <> 'COMPLETED' OR "volume_ml" BETWEEN 100 AND 600));
--> statement-breakpoint
-- A donation record is kept as taken; only a later adverse reaction and the blood unit link may be
-- added (and patient merges).
CREATE OR REPLACE FUNCTION blood_donations_protect() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'blood_donations cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF to_jsonb(NEW) - ARRAY['adverse_reaction', 'blood_unit_id']
     IS DISTINCT FROM to_jsonb(OLD) - ARRAY['adverse_reaction', 'blood_unit_id'] THEN
    RAISE EXCEPTION 'A donation record cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER blood_donations_protect BEFORE UPDATE OR DELETE ON "blood_donations"
  FOR EACH ROW EXECUTE FUNCTION blood_donations_protect();
