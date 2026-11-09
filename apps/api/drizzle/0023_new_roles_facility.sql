-- Laboratory technicians and IT support belong to a facility like other facility staff.
ALTER TABLE "users" DROP CONSTRAINT "users_role_facility_ck";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_facility_ck" CHECK (
  ("role"::text IN ('DIRECTOR', 'DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'LAB_TECHNICIAN', 'IT_SUPPORT') AND "facility_id" IS NOT NULL)
  OR ("role"::text IN ('MINISTRY', 'PATIENT') AND "facility_id" IS NULL)
);
