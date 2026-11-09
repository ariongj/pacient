ALTER TYPE "public"."role" ADD VALUE 'LAB_TECHNICIAN';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'IT_SUPPORT';--> statement-breakpoint
CREATE TABLE "access_review_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"decision" varchar(8),
	"note" varchar(500),
	"decided_by_id" uuid,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "access_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid,
	"period" varchar(7) NOT NULL,
	"status" varchar(10) DEFAULT 'OPEN' NOT NULL,
	"due_date" date NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "clinical_resource_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_name" varchar(64) NOT NULL,
	"resource_id" uuid NOT NULL,
	"patient_id" uuid,
	"version" integer NOT NULL,
	"operation" varchar(8) NOT NULL,
	"data" jsonb NOT NULL,
	"changed_fields" text[],
	"tx_id" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "code_system_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_system_id" uuid NOT NULL,
	"version" varchar(40) NOT NULL,
	"status" varchar(8) DEFAULT 'DRAFT' NOT NULL,
	"concept_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"imported_by_id" uuid,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by_id" uuid,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "code_systems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(40) NOT NULL,
	"name" varchar(200) NOT NULL,
	"url" varchar(300) NOT NULL,
	"publisher" varchar(200),
	"kind" varchar(8) NOT NULL,
	"facility_id" uuid,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "concept_map_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_version_id" uuid NOT NULL,
	"source_code" varchar(40) NOT NULL,
	"source_display" varchar(400),
	"target_code" varchar(40),
	"equivalence" varchar(12) NOT NULL,
	"comment" varchar(500)
);
--> statement-breakpoint
CREATE TABLE "concept_map_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"map_id" uuid NOT NULL,
	"version" varchar(40) NOT NULL,
	"status" varchar(8) DEFAULT 'DRAFT' NOT NULL,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"imported_by_id" uuid,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by_id" uuid,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "concept_maps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(60) NOT NULL,
	"name" varchar(200) NOT NULL,
	"url" varchar(300) NOT NULL,
	"source_system_id" uuid NOT NULL,
	"target_system_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "donation_test_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"donation_id" uuid NOT NULL,
	"hiv" varchar(10) NOT NULL,
	"hbv" varchar(10) NOT NULL,
	"hcv" varchar(10) NOT NULL,
	"syphilis" varchar(10) NOT NULL,
	"abo_group" varchar(3) NOT NULL,
	"rh_d" varchar(8) NOT NULL,
	"lab_reference" varchar(60),
	"tested_by_id" uuid NOT NULL,
	"tested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_specimen_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"event" varchar(16) NOT NULL,
	"reason" varchar(300),
	"specimen_barcode" varchar(40),
	"actor_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prom_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"assigned_by_id" uuid NOT NULL,
	"instrument" varchar(12) NOT NULL,
	"frequency" varchar(10) NOT NULL,
	"next_due_at" timestamp with time zone,
	"status" varchar(8) DEFAULT 'ACTIVE' NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prom_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"assignment_id" uuid,
	"instrument" varchar(12) NOT NULL,
	"answers" jsonb NOT NULL,
	"score" numeric(8, 3),
	"severity" varchar(20),
	"safety_flag" boolean DEFAULT false NOT NULL,
	"submitted_by_user_id" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" varchar(500)
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(20) NOT NULL,
	"facility_id" uuid,
	"requester_id" uuid,
	"subject_user_id" uuid,
	"kind" varchar(16) NOT NULL,
	"description" text NOT NULL,
	"status" varchar(18) DEFAULT 'OPEN' NOT NULL,
	"assigned_to_id" uuid,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "terminology_concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"code" varchar(40) NOT NULL,
	"display" varchar(400) NOT NULL,
	"display_sq" varchar(400),
	"display_sr" varchar(400),
	"parent_code" varchar(40),
	"active" boolean DEFAULT true NOT NULL,
	"properties" jsonb
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "tx_id" bigint;--> statement-breakpoint
-- Default only for new rows: existing audit entries are not rewritten (append-only table).
ALTER TABLE "audit_logs" ALTER COLUMN "tx_id" SET DEFAULT txid_current();--> statement-breakpoint
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_review_id_access_reviews_id_fk" FOREIGN KEY ("review_id") REFERENCES "public"."access_reviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_completed_by_id_users_id_fk" FOREIGN KEY ("completed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_system_versions" ADD CONSTRAINT "code_system_versions_code_system_id_code_systems_id_fk" FOREIGN KEY ("code_system_id") REFERENCES "public"."code_systems"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_system_versions" ADD CONSTRAINT "code_system_versions_imported_by_id_users_id_fk" FOREIGN KEY ("imported_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_system_versions" ADD CONSTRAINT "code_system_versions_activated_by_id_users_id_fk" FOREIGN KEY ("activated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_systems" ADD CONSTRAINT "code_systems_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map_entries" ADD CONSTRAINT "concept_map_entries_map_version_id_concept_map_versions_id_fk" FOREIGN KEY ("map_version_id") REFERENCES "public"."concept_map_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map_versions" ADD CONSTRAINT "concept_map_versions_map_id_concept_maps_id_fk" FOREIGN KEY ("map_id") REFERENCES "public"."concept_maps"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map_versions" ADD CONSTRAINT "concept_map_versions_imported_by_id_users_id_fk" FOREIGN KEY ("imported_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_map_versions" ADD CONSTRAINT "concept_map_versions_activated_by_id_users_id_fk" FOREIGN KEY ("activated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_maps" ADD CONSTRAINT "concept_maps_source_system_id_code_systems_id_fk" FOREIGN KEY ("source_system_id") REFERENCES "public"."code_systems"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concept_maps" ADD CONSTRAINT "concept_maps_target_system_id_code_systems_id_fk" FOREIGN KEY ("target_system_id") REFERENCES "public"."code_systems"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_test_results" ADD CONSTRAINT "donation_test_results_donation_id_blood_donations_id_fk" FOREIGN KEY ("donation_id") REFERENCES "public"."blood_donations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "donation_test_results" ADD CONSTRAINT "donation_test_results_tested_by_id_users_id_fk" FOREIGN KEY ("tested_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_specimen_events" ADD CONSTRAINT "lab_specimen_events_order_id_lab_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."lab_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_specimen_events" ADD CONSTRAINT "lab_specimen_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prom_assignments" ADD CONSTRAINT "prom_assignments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prom_assignments" ADD CONSTRAINT "prom_assignments_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prom_assignments" ADD CONSTRAINT "prom_assignments_assigned_by_id_users_id_fk" FOREIGN KEY ("assigned_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prom_responses" ADD CONSTRAINT "prom_responses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prom_responses" ADD CONSTRAINT "prom_responses_assignment_id_prom_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."prom_assignments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prom_responses" ADD CONSTRAINT "prom_responses_submitted_by_user_id_users_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prom_responses" ADD CONSTRAINT "prom_responses_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terminology_concepts" ADD CONSTRAINT "terminology_concepts_version_id_code_system_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."code_system_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_review_items_uq" ON "access_review_items" USING btree ("review_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "access_reviews_facility_period_uq" ON "access_reviews" USING btree ("facility_id","period") WHERE "access_reviews"."facility_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "access_reviews_ministry_period_uq" ON "access_reviews" USING btree ("period") WHERE "access_reviews"."facility_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "clinical_resource_versions_uq" ON "clinical_resource_versions" USING btree ("table_name","resource_id","version");--> statement-breakpoint
CREATE INDEX "clinical_resource_versions_patient_idx" ON "clinical_resource_versions" USING btree ("patient_id","recorded_at");--> statement-breakpoint
CREATE INDEX "clinical_resource_versions_tx_idx" ON "clinical_resource_versions" USING btree ("tx_id");--> statement-breakpoint
CREATE UNIQUE INDEX "code_system_versions_uq" ON "code_system_versions" USING btree ("code_system_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "code_system_versions_active_uq" ON "code_system_versions" USING btree ("code_system_id") WHERE "code_system_versions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "code_systems_code_uq" ON "code_systems" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "code_systems_url_uq" ON "code_systems" USING btree ("url");--> statement-breakpoint
CREATE INDEX "concept_map_entries_source_idx" ON "concept_map_entries" USING btree ("map_version_id","source_code");--> statement-breakpoint
CREATE UNIQUE INDEX "concept_map_entries_uq" ON "concept_map_entries" USING btree ("map_version_id","source_code","target_code");--> statement-breakpoint
CREATE UNIQUE INDEX "concept_map_versions_uq" ON "concept_map_versions" USING btree ("map_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "concept_map_versions_active_uq" ON "concept_map_versions" USING btree ("map_id") WHERE "concept_map_versions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE UNIQUE INDEX "concept_maps_code_uq" ON "concept_maps" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "concept_maps_url_uq" ON "concept_maps" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "donation_test_results_donation_uq" ON "donation_test_results" USING btree ("donation_id");--> statement-breakpoint
CREATE INDEX "lab_specimen_events_order_idx" ON "lab_specimen_events" USING btree ("order_id","occurred_at");--> statement-breakpoint
CREATE INDEX "prom_assignments_patient_idx" ON "prom_assignments" USING btree ("patient_id","status");--> statement-breakpoint
CREATE INDEX "prom_assignments_due_idx" ON "prom_assignments" USING btree ("status","next_due_at");--> statement-breakpoint
CREATE INDEX "prom_responses_patient_idx" ON "prom_responses" USING btree ("patient_id","instrument","submitted_at");--> statement-breakpoint
CREATE INDEX "prom_responses_review_idx" ON "prom_responses" USING btree ("safety_flag","reviewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_reference_uq" ON "support_tickets" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "support_tickets_facility_status_idx" ON "support_tickets" USING btree ("facility_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "terminology_concepts_uq" ON "terminology_concepts" USING btree ("version_id","code");--> statement-breakpoint
CREATE INDEX "terminology_concepts_display_idx" ON "terminology_concepts" USING btree ("version_id","display");--> statement-breakpoint
CREATE INDEX "audit_logs_tx_idx" ON "audit_logs" USING btree ("tx_id");
--> statement-breakpoint
ALTER TABLE "clinical_resource_versions" ADD CONSTRAINT "clinical_resource_versions_values_ck" CHECK ("operation" IN ('BASELINE', 'INSERT', 'UPDATE', 'DELETE') AND "version" > 0);
--> statement-breakpoint
-- Version history: every change of a versioned clinical table is copied here in the same
-- transaction. Updates that only touch updated_at are not versions.
CREATE OR REPLACE FUNCTION clinical_version_capture() RETURNS trigger AS $$
DECLARE
  rec jsonb;
  changed text[];
  next_version integer;
  rid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := to_jsonb(OLD); ELSE rec := to_jsonb(NEW); END IF;
  rid := (rec->>'id')::uuid;
  IF TG_OP = 'UPDATE' THEN
    SELECT array_agg(n.key ORDER BY n.key) INTO changed
      FROM jsonb_each(rec) n
      WHERE n.key <> 'updated_at' AND n.value IS DISTINCT FROM to_jsonb(OLD) -> n.key;
    IF changed IS NULL THEN RETURN NULL; END IF;
  END IF;
  SELECT coalesce(max(version), 0) + 1 INTO next_version
    FROM clinical_resource_versions WHERE table_name = TG_TABLE_NAME AND resource_id = rid;
  INSERT INTO clinical_resource_versions
    (table_name, resource_id, patient_id, version, operation, data, changed_fields, tx_id)
  VALUES
    (TG_TABLE_NAME, rid, NULLIF(rec->>'patient_id', '')::uuid, next_version, TG_OP, rec, changed,
     txid_current());
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
INSERT INTO "clinical_resource_versions" (table_name, resource_id, patient_id, version, operation, data, tx_id)
  SELECT 'allergies', r.id, r.patient_id, 1, 'BASELINE', to_jsonb(r), txid_current() FROM "allergies" r;
--> statement-breakpoint
CREATE TRIGGER allergies_version_capture AFTER INSERT OR UPDATE OR DELETE ON "allergies"
  FOR EACH ROW EXECUTE FUNCTION clinical_version_capture();
--> statement-breakpoint
INSERT INTO "clinical_resource_versions" (table_name, resource_id, patient_id, version, operation, data, tx_id)
  SELECT 'diagnoses', r.id, r.patient_id, 1, 'BASELINE', to_jsonb(r), txid_current() FROM "diagnoses" r;
--> statement-breakpoint
CREATE TRIGGER diagnoses_version_capture AFTER INSERT OR UPDATE OR DELETE ON "diagnoses"
  FOR EACH ROW EXECUTE FUNCTION clinical_version_capture();
--> statement-breakpoint
INSERT INTO "clinical_resource_versions" (table_name, resource_id, patient_id, version, operation, data, tx_id)
  SELECT 'prescriptions', r.id, r.patient_id, 1, 'BASELINE', to_jsonb(r), txid_current() FROM "prescriptions" r;
--> statement-breakpoint
CREATE TRIGGER prescriptions_version_capture AFTER INSERT OR UPDATE OR DELETE ON "prescriptions"
  FOR EACH ROW EXECUTE FUNCTION clinical_version_capture();
--> statement-breakpoint
INSERT INTO "clinical_resource_versions" (table_name, resource_id, patient_id, version, operation, data, tx_id)
  SELECT 'vital_signs', r.id, r.patient_id, 1, 'BASELINE', to_jsonb(r), txid_current() FROM "vital_signs" r;
--> statement-breakpoint
CREATE TRIGGER vital_signs_version_capture AFTER INSERT OR UPDATE OR DELETE ON "vital_signs"
  FOR EACH ROW EXECUTE FUNCTION clinical_version_capture();
--> statement-breakpoint
INSERT INTO "clinical_resource_versions" (table_name, resource_id, patient_id, version, operation, data, tx_id)
  SELECT 'lab_results', r.id, r.patient_id, 1, 'BASELINE', to_jsonb(r), txid_current() FROM "lab_results" r;
--> statement-breakpoint
CREATE TRIGGER lab_results_version_capture AFTER INSERT OR UPDATE OR DELETE ON "lab_results"
  FOR EACH ROW EXECUTE FUNCTION clinical_version_capture();
--> statement-breakpoint
INSERT INTO "clinical_resource_versions" (table_name, resource_id, patient_id, version, operation, data, tx_id)
  SELECT 'immunizations', r.id, r.patient_id, 1, 'BASELINE', to_jsonb(r), txid_current() FROM "immunizations" r;
--> statement-breakpoint
CREATE TRIGGER immunizations_version_capture AFTER INSERT OR UPDATE OR DELETE ON "immunizations"
  FOR EACH ROW EXECUTE FUNCTION clinical_version_capture();
--> statement-breakpoint
INSERT INTO "clinical_resource_versions" (table_name, resource_id, patient_id, version, operation, data, tx_id)
  SELECT 'encounters', r.id, r.patient_id, 1, 'BASELINE', to_jsonb(r), txid_current() FROM "encounters" r;
--> statement-breakpoint
CREATE TRIGGER encounters_version_capture AFTER INSERT OR UPDATE OR DELETE ON "encounters"
  FOR EACH ROW EXECUTE FUNCTION clinical_version_capture();
--> statement-breakpoint
CREATE TRIGGER clinical_resource_versions_append_only BEFORE UPDATE OR DELETE ON "clinical_resource_versions"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
CREATE TRIGGER lab_specimen_events_append_only BEFORE UPDATE OR DELETE ON "lab_specimen_events"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
CREATE TRIGGER donation_test_results_append_only BEFORE UPDATE OR DELETE ON "donation_test_results"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
ALTER TABLE "lab_specimen_events" ADD CONSTRAINT "lab_specimen_events_event_ck" CHECK ("event" IN ('COLLECTED', 'RECEIVED', 'REJECTED', 'RESULT_ENTERED', 'VALIDATED'));
--> statement-breakpoint
ALTER TABLE "donation_test_results" ADD CONSTRAINT "donation_test_results_values_ck" CHECK ("hiv" IN ('NEGATIVE', 'REACTIVE') AND "hbv" IN ('NEGATIVE', 'REACTIVE') AND "hcv" IN ('NEGATIVE', 'REACTIVE') AND "syphilis" IN ('NEGATIVE', 'REACTIVE') AND "abo_group" IN ('A', 'B', 'AB', 'O') AND "rh_d" IN ('POS', 'NEG'));
--> statement-breakpoint
ALTER TABLE "access_reviews" ADD CONSTRAINT "access_reviews_status_ck" CHECK ("status" IN ('OPEN', 'COMPLETED'));
--> statement-breakpoint
ALTER TABLE "access_review_items" ADD CONSTRAINT "access_review_items_decision_ck" CHECK ("decision" IS NULL OR "decision" IN ('KEEP', 'CHANGE', 'REVOKE'));
--> statement-breakpoint
ALTER TABLE "code_systems" ADD CONSTRAINT "code_systems_kind_ck" CHECK ("kind" IN ('EXTERNAL', 'LOCAL'));
--> statement-breakpoint
ALTER TABLE "code_system_versions" ADD CONSTRAINT "code_system_versions_status_ck" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'RETIRED'));
--> statement-breakpoint
ALTER TABLE "concept_map_versions" ADD CONSTRAINT "concept_map_versions_status_ck" CHECK ("status" IN ('DRAFT', 'ACTIVE', 'RETIRED'));
--> statement-breakpoint
ALTER TABLE "concept_map_entries" ADD CONSTRAINT "concept_map_entries_equivalence_ck" CHECK ("equivalence" IN ('EQUIVALENT', 'WIDER', 'NARROWER', 'RELATEDTO', 'UNMATCHED') AND (("equivalence" = 'UNMATCHED') = ("target_code" IS NULL)));
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_values_ck" CHECK ("kind" IN ('ACCOUNT_LOCKED', 'MFA_RESET', 'PASSWORD_RESET', 'ACCESS_CHANGE', 'DEVICE', 'OTHER') AND "status" IN ('OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'REJECTED'));
--> statement-breakpoint
ALTER TABLE "prom_assignments" ADD CONSTRAINT "prom_assignments_values_ck" CHECK ("frequency" IN ('ONCE', 'WEEKLY', 'MONTHLY', 'QUARTERLY') AND "status" IN ('ACTIVE', 'ENDED'));
--> statement-breakpoint
-- A submitted questionnaire is kept as answered; only the review may be added (and merges).
CREATE OR REPLACE FUNCTION prom_responses_protect() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prom_responses cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF to_jsonb(NEW) - ARRAY['reviewed_by_id', 'reviewed_at', 'review_note', 'assignment_id']
     IS DISTINCT FROM to_jsonb(OLD) - ARRAY['reviewed_by_id', 'reviewed_at', 'review_note', 'assignment_id'] THEN
    RAISE EXCEPTION 'A submitted questionnaire cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER prom_responses_protect BEFORE UPDATE OR DELETE ON "prom_responses"
  FOR EACH ROW EXECUTE FUNCTION prom_responses_protect();
