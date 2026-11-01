-- Defence in depth: invariants enforced by the database, independent of application code.

-- Staff roles must belong to a facility; national and patient accounts must not.
ALTER TABLE "users" ADD CONSTRAINT "users_role_facility_ck" CHECK (
  ("role" IN ('DIRECTOR', 'DOCTOR') AND "facility_id" IS NOT NULL)
  OR ("role" IN ('MINISTRY', 'PATIENT') AND "facility_id" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "vital_signs" ADD CONSTRAINT "vital_signs_ranges_ck" CHECK (
  ("systolic" IS NULL OR "systolic" BETWEEN 40 AND 300)
  AND ("diastolic" IS NULL OR "diastolic" BETWEEN 20 AND 200)
  AND ("heart_rate" IS NULL OR "heart_rate" BETWEEN 20 AND 300)
  AND ("respiratory_rate" IS NULL OR "respiratory_rate" BETWEEN 4 AND 80)
  AND ("oxygen_saturation" IS NULL OR "oxygen_saturation" BETWEEN 30 AND 100)
  AND ("temperature_c" IS NULL OR "temperature_c" BETWEEN 25 AND 45)
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_duration_ck" CHECK ("duration_minutes" BETWEEN 5 AND 480);
--> statement-breakpoint
ALTER TABLE "emergency_access_grants" ADD CONSTRAINT "emergency_access_reason_ck" CHECK (length(trim("reason")) >= 10);
--> statement-breakpoint

-- The audit trail is append-only. Any attempt to modify or delete history is rejected.
CREATE OR REPLACE FUNCTION audit_logs_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% is not permitted)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation();
