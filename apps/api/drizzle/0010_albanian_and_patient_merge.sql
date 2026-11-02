CREATE TABLE "patient_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"survivor_id" uuid NOT NULL,
	"merged_id" uuid NOT NULL,
	"facility_id" uuid,
	"reason" varchar(500) NOT NULL,
	"moved_rows" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	"merged_by_id" uuid NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unmerged_by_id" uuid,
	"unmerged_at" timestamp with time zone,
	"unmerge_reason" varchar(500)
);
--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" varchar(5) DEFAULT 'sq' NOT NULL;--> statement-breakpoint
ALTER TABLE "patient_merges" ADD CONSTRAINT "patient_merges_survivor_id_patients_id_fk" FOREIGN KEY ("survivor_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merges" ADD CONSTRAINT "patient_merges_merged_id_patients_id_fk" FOREIGN KEY ("merged_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merges" ADD CONSTRAINT "patient_merges_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merges" ADD CONSTRAINT "patient_merges_merged_by_id_users_id_fk" FOREIGN KEY ("merged_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_merges" ADD CONSTRAINT "patient_merges_unmerged_by_id_users_id_fk" FOREIGN KEY ("unmerged_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_merges_survivor_idx" ON "patient_merges" USING btree ("survivor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_merges_active_uq" ON "patient_merges" USING btree ("merged_id") WHERE "patient_merges"."unmerged_at" IS NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_merged_into_id_patients_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_locale_ck" CHECK ("locale" IN ('sq', 'en'));
--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_not_merged_into_self_ck" CHECK ("merged_into_id" IS NULL OR "merged_into_id" <> "id");
--> statement-breakpoint
ALTER TABLE "patient_merges" ADD CONSTRAINT "patient_merges_distinct_ck" CHECK ("survivor_id" <> "merged_id");
--> statement-breakpoint
-- A patient merge may re-point rows of protected tables to the surviving record, and nothing else:
-- the transaction must declare it (SET LOCAL pacient.patient_merge = 'on') and only patient_id
-- may change.
CREATE OR REPLACE FUNCTION is_patient_merge_update(old_row jsonb, new_row jsonb) RETURNS boolean AS $$
  SELECT coalesce(current_setting('pacient.patient_merge', true), '') = 'on'
     AND (old_row - 'patient_id') = (new_row - 'patient_id');
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION block_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only (% is not permitted)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION consent_records_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'consent_records is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION encounters_protect_signed() RETURNS trigger AS $$
BEGIN
  IF is_patient_merge_update(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
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
