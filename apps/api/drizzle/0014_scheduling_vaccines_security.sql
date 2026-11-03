CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"purpose" varchar(20) NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "availability_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" varchar(200),
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doctor_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"weekday" integer NOT NULL,
	"start_time" varchar(5) NOT NULL,
	"end_time" varchar(5) NOT NULL,
	"slot_minutes" integer DEFAULT 20 NOT NULL,
	"portal_bookable" boolean DEFAULT true NOT NULL,
	"valid_from" date,
	"valid_until" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "immunization_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"schedule_item_id" uuid NOT NULL,
	"kind" varchar(10) NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "known_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_hash" varchar(64) NOT NULL,
	"label" varchar(200) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vaccine_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(40) NOT NULL,
	"vaccine" varchar(200) NOT NULL,
	"dose_number" integer NOT NULL,
	"recommended_age_days" integer NOT NULL,
	"overdue_age_days" integer NOT NULL,
	"description" varchar(500),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webauthn_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" text[],
	"device_name" varchar(100) NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "booked_via" varchar(10) DEFAULT 'STAFF' NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "immunizations" ADD COLUMN "schedule_item_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_doctor_id_users_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_availability" ADD CONSTRAINT "doctor_availability_doctor_id_users_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_availability" ADD CONSTRAINT "doctor_availability_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunization_reminders" ADD CONSTRAINT "immunization_reminders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "immunization_reminders" ADD CONSTRAINT "immunization_reminders_schedule_item_id_vaccine_schedule_id_fk" FOREIGN KEY ("schedule_item_id") REFERENCES "public"."vaccine_schedule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "known_devices" ADD CONSTRAINT "known_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_challenges_expiry_idx" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "availability_exceptions_doctor_idx" ON "availability_exceptions" USING btree ("doctor_id","starts_at");--> statement-breakpoint
CREATE INDEX "doctor_availability_doctor_idx" ON "doctor_availability" USING btree ("doctor_id","weekday");--> statement-breakpoint
CREATE UNIQUE INDEX "immunization_reminders_uq" ON "immunization_reminders" USING btree ("patient_id","schedule_item_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "known_devices_uq" ON "known_devices" USING btree ("user_id","device_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "vaccine_schedule_code_uq" ON "vaccine_schedule" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "webauthn_credentials_id_uq" ON "webauthn_credentials" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "webauthn_credentials_user_idx" ON "webauthn_credentials" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "immunizations" ADD CONSTRAINT "immunizations_schedule_item_id_vaccine_schedule_id_fk" FOREIGN KEY ("schedule_item_id") REFERENCES "public"."vaccine_schedule"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_booked_via_ck" CHECK ("booked_via" IN ('STAFF', 'PORTAL'));
--> statement-breakpoint
ALTER TABLE "doctor_availability" ADD CONSTRAINT "doctor_availability_values_ck" CHECK (
  "weekday" BETWEEN 0 AND 6
  AND "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "end_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  AND "start_time" < "end_time"
  AND "slot_minutes" BETWEEN 5 AND 240);
--> statement-breakpoint
ALTER TABLE "availability_exceptions" ADD CONSTRAINT "availability_exceptions_period_ck" CHECK ("ends_at" > "starts_at");
--> statement-breakpoint
ALTER TABLE "vaccine_schedule" ADD CONSTRAINT "vaccine_schedule_ages_ck" CHECK (
  "dose_number" >= 1 AND "recommended_age_days" >= 0 AND "overdue_age_days" >= "recommended_age_days");
--> statement-breakpoint
ALTER TABLE "immunization_reminders" ADD CONSTRAINT "immunization_reminders_kind_ck" CHECK ("kind" IN ('DUE', 'OVERDUE'));
--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_purpose_ck" CHECK ("purpose" IN ('REGISTER', 'AUTHENTICATE'));
