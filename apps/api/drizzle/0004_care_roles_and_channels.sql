CREATE TYPE "public"."administration_status" AS ENUM('GIVEN', 'WITHHELD', 'REFUSED', 'OMITTED');--> statement-breakpoint
CREATE TYPE "public"."channel_scope" AS ENUM('FACILITY', 'NATIONAL');--> statement-breakpoint
CREATE TYPE "public"."pharmacy_status" AS ENUM('PENDING', 'VERIFIED', 'RETURNED', 'DISPENSED');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('ROUTINE', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('OPEN', 'DONE', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."appointment_status" ADD VALUE 'CHECKED_IN';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'NURSE';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'PHARMACIST';--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'RECEPTION';--> statement-breakpoint
CREATE TABLE "care_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"created_by_id" uuid NOT NULL,
	"assigned_to_id" uuid,
	"assigned_role" "role" NOT NULL,
	"title" varchar(200) NOT NULL,
	"details" text,
	"priority" "task_priority" DEFAULT 'ROUTINE' NOT NULL,
	"due_at" timestamp with time zone,
	"status" "task_status" DEFAULT 'OPEN' NOT NULL,
	"completed_by_id" uuid,
	"completed_at" timestamp with time zone,
	"completion_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"is_urgent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_reads" (
	"channel_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "channel_scope" NOT NULL,
	"facility_id" uuid,
	"name" varchar(80) NOT NULL,
	"description" varchar(300),
	"allowed_roles" "role"[] NOT NULL,
	"created_by_id" uuid,
	"is_archived" boolean DEFAULT false NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medication_administrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prescription_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"administered_by_id" uuid NOT NULL,
	"status" "administration_status" NOT NULL,
	"dose_given" varchar(100),
	"reason" varchar(500),
	"notes" text,
	"administered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "pharmacy_status" "pharmacy_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "verified_by_id" uuid;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "pharmacist_note" text;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "dispensed_by_id" uuid;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "dispensed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD COLUMN "dispensed_quantity" varchar(100);--> statement-breakpoint
ALTER TABLE "care_tasks" ADD CONSTRAINT "care_tasks_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_tasks" ADD CONSTRAINT "care_tasks_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_tasks" ADD CONSTRAINT "care_tasks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_tasks" ADD CONSTRAINT "care_tasks_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "care_tasks" ADD CONSTRAINT "care_tasks_completed_by_id_users_id_fk" FOREIGN KEY ("completed_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reads" ADD CONSTRAINT "channel_reads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_reads" ADD CONSTRAINT "channel_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_administered_by_id_users_id_fk" FOREIGN KEY ("administered_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "care_tasks_facility_idx" ON "care_tasks" USING btree ("facility_id","status","due_at");--> statement-breakpoint
CREATE INDEX "care_tasks_patient_idx" ON "care_tasks" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "channel_messages_channel_idx" ON "channel_messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_reads_pk" ON "channel_reads" USING btree ("channel_id","user_id");--> statement-breakpoint
CREATE INDEX "channels_facility_idx" ON "channels" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "medication_administrations_patient_idx" ON "medication_administrations" USING btree ("patient_id","administered_at");--> statement-breakpoint
CREATE INDEX "medication_administrations_rx_idx" ON "medication_administrations" USING btree ("prescription_id");--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_dispensed_by_id_users_id_fk" FOREIGN KEY ("dispensed_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prescriptions_pharmacy_idx" ON "prescriptions" USING btree ("pharmacy_status","created_at");--> statement-breakpoint
-- Facility staff roles need a facility; national and patient accounts must not have one.
-- Compared as text: new enum values cannot be referenced in the transaction that adds them.
ALTER TABLE "users" DROP CONSTRAINT "users_role_facility_ck";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_facility_ck" CHECK (
  ("role"::text IN ('DIRECTOR', 'DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION') AND "facility_id" IS NOT NULL)
  OR ("role"::text IN ('MINISTRY', 'PATIENT') AND "facility_id" IS NULL)
);
--> statement-breakpoint
-- Prescriptions written before the pharmacy workflow existed are treated as already dispensed.
UPDATE "prescriptions" SET "pharmacy_status" = 'DISPENSED', "dispensed_at" = "created_at";
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_scope_facility_ck" CHECK (
  ("scope" = 'NATIONAL' AND "facility_id" IS NULL) OR ("scope" = 'FACILITY' AND "facility_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "medication_administrations" ADD CONSTRAINT "medication_administrations_reason_ck" CHECK (
  "status" = 'GIVEN' OR length(trim(coalesce("reason", ''))) >= 3
);
--> statement-breakpoint
CREATE TRIGGER medication_administrations_append_only
  BEFORE UPDATE OR DELETE ON "medication_administrations"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
