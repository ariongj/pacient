CREATE TYPE "public"."integration_kind" AS ENUM('LAB');--> statement-breakpoint
CREATE TYPE "public"."integration_message_status" AS ENUM('ACCEPTED', 'REJECTED', 'NEEDS_REVIEW', 'RESOLVED', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."lab_order_status" AS ENUM('ORDERED', 'RECEIVED', 'IN_PROGRESS', 'RESULTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."lab_priority" AS ENUM('ROUTINE', 'URGENT', 'STAT');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "public"."sms_preference" AS ENUM('IMPORTANT', 'OFF');--> statement-breakpoint
CREATE TABLE "integration_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"kind" "integration_kind" DEFAULT 'LAB' NOT NULL,
	"facility_id" uuid NOT NULL,
	"api_key_hash" varchar(64) NOT NULL,
	"api_key_prefix" varchar(12) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_id" uuid,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"message_type" varchar(20) NOT NULL,
	"control_id" varchar(64) NOT NULL,
	"status" "integration_message_status" NOT NULL,
	"error" varchar(1000),
	"patient_id" uuid,
	"order_id" uuid,
	"result_count" integer DEFAULT 0 NOT NULL,
	"raw_sealed" text,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" varchar(500),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lab_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"placer_order_number" varchar(30) NOT NULL,
	"patient_id" uuid NOT NULL,
	"encounter_id" uuid,
	"ordered_by_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"test_code" varchar(40) NOT NULL,
	"test_name" varchar(200) NOT NULL,
	"specimen" varchar(60),
	"priority" "lab_priority" DEFAULT 'ROUTINE' NOT NULL,
	"clinical_notes" text,
	"status" "lab_order_status" DEFAULT 'ORDERED' NOT NULL,
	"lab_client_id" uuid,
	"filler_order_number" varchar(60),
	"received_at" timestamp with time zone,
	"resulted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phone_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"phone" varchar(20) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sms_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"to_phone" varchar(20) NOT NULL,
	"template" varchar(60) NOT NULL,
	"body_sealed" text,
	"status" "email_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(500),
	"provider_message_id" varchar(100),
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "order_id" uuid;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "test_code" varchar(40);--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "source" varchar(10) DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "lab_results" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_notifications" "sms_preference" DEFAULT 'OFF' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_clients" ADD CONSTRAINT "integration_clients_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_clients" ADD CONSTRAINT "integration_clients_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_messages" ADD CONSTRAINT "integration_messages_client_id_integration_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."integration_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_messages" ADD CONSTRAINT "integration_messages_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_messages" ADD CONSTRAINT "integration_messages_order_id_lab_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."lab_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_messages" ADD CONSTRAINT "integration_messages_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_ordered_by_id_users_id_fk" FOREIGN KEY ("ordered_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lab_orders" ADD CONSTRAINT "lab_orders_lab_client_id_integration_clients_id_fk" FOREIGN KEY ("lab_client_id") REFERENCES "public"."integration_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_outbox" ADD CONSTRAINT "sms_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_clients_key_uq" ON "integration_clients" USING btree ("api_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_messages_control_uq" ON "integration_messages" USING btree ("client_id","direction","control_id");--> statement-breakpoint
CREATE INDEX "integration_messages_status_idx" ON "integration_messages" USING btree ("status","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lab_orders_placer_uq" ON "lab_orders" USING btree ("placer_order_number");--> statement-breakpoint
CREATE INDEX "lab_orders_facility_status_idx" ON "lab_orders" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "lab_orders_patient_idx" ON "lab_orders" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "phone_verifications_user_idx" ON "phone_verifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "sms_outbox_due_idx" ON "sms_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_order_id_lab_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."lab_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Phone numbers are stored in E.164 format (+ country code, digits only).
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164_ck" CHECK ("phone" IS NULL OR "phone" ~ '^\+[1-9][0-9]{6,14}$');
--> statement-breakpoint
ALTER TABLE "sms_outbox" ADD CONSTRAINT "sms_outbox_phone_e164_ck" CHECK ("to_phone" ~ '^\+[1-9][0-9]{6,14}$');
--> statement-breakpoint
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_source_ck" CHECK ("source" IN ('MANUAL', 'LIS'));
