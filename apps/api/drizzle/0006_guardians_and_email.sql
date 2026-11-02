CREATE TYPE "public"."email_preference" AS ENUM('ALL', 'IMPORTANT', 'OFF');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('PENDING', 'SENDING', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."guardian_relationship" AS ENUM('PARENT', 'LEGAL_GUARDIAN', 'FOSTER_CARER', 'OTHER_AUTHORISED');--> statement-breakpoint
CREATE TYPE "public"."proxy_scope" AS ENUM('FULL', 'APPOINTMENTS');--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"to_email" varchar(254) NOT NULL,
	"template" varchar(60) NOT NULL,
	"subject_sealed" text,
	"text_sealed" text,
	"html_sealed" text,
	"status" "email_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(500),
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardianships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"guardian_user_id" uuid NOT NULL,
	"relationship" "guardian_relationship" NOT NULL,
	"scope" "proxy_scope" DEFAULT 'FULL' NOT NULL,
	"evidence" varchar(300) NOT NULL,
	"verified_by_id" uuid NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" uuid,
	"revoke_reason" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "encounters" ADD COLUMN "confidential_from_guardians" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_notifications" "email_preference" DEFAULT 'IMPORTANT' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_guardian_user_id_users_id_fk" FOREIGN KEY ("guardian_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_revoked_by_id_users_id_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_outbox_due_idx" ON "email_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "guardianships_guardian_idx" ON "guardianships" USING btree ("guardian_user_id");--> statement-breakpoint
CREATE INDEX "guardianships_patient_idx" ON "guardianships" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guardianships_active_uq" ON "guardianships" USING btree ("patient_id","guardian_user_id") WHERE "guardianships"."revoked_at" IS NULL;--> statement-breakpoint
-- Patients get every notification by email by default; staff only the important ones.
UPDATE "users" SET "email_notifications" = 'ALL' WHERE "role"::text = 'PATIENT';
--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_validity_ck" CHECK ("valid_until" > "valid_from");
--> statement-breakpoint
ALTER TABLE "guardianships" ADD CONSTRAINT "guardianships_evidence_ck" CHECK (length(trim("evidence")) >= 5);
