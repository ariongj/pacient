CREATE TYPE "public"."billing_cycle" AS ENUM('MONTHLY', 'YEARLY');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('OPEN', 'PAID', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."legal_document_kind" AS ENUM('TERMS', 'PRIVACY');--> statement-breakpoint
CREATE TYPE "public"."subscription_event_type" AS ENUM('CREATED', 'TRIAL_STARTED', 'ACTIVATED', 'PLAN_CHANGED', 'SEATS_CHANGED', 'PRICE_CHANGED', 'CYCLE_CHANGED', 'RENEWED', 'INVOICE_ISSUED', 'PAYMENT_RECORDED', 'INVOICE_VOIDED', 'MARKED_PAST_DUE', 'SUSPENDED', 'REACTIVATED', 'CANCELLATION_SCHEDULED', 'CANCELLATION_WITHDRAWN', 'CANCELLED', 'EXPIRED', 'REMINDER_SENT', 'NOTE');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
ALTER TYPE "public"."role" ADD VALUE 'ADMIN';--> statement-breakpoint
CREATE TABLE "invoice_counters" (
	"year" integer PRIMARY KEY NOT NULL,
	"last" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(30) NOT NULL,
	"facility_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"description" varchar(300) NOT NULL,
	"net_cents" integer NOT NULL,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"status" "invoice_status" DEFAULT 'OPEN' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"payment_method" varchar(40),
	"payment_reference" varchar(120),
	"voided_at" timestamp with time zone,
	"void_reason" varchar(500),
	"issuer" jsonb NOT NULL,
	"customer" jsonb NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_amounts_ck" CHECK ("invoices"."net_cents" >= 0 AND "invoices"."tax_cents" >= 0 AND "invoices"."total_cents" = "invoices"."net_cents" + "invoices"."tax_cents")
);
--> statement-breakpoint
CREATE TABLE "legal_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "legal_document_kind" NOT NULL,
	"version" varchar(20) NOT NULL,
	"locale" varchar(5) NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(300),
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "legal_document_kind" NOT NULL,
	"version" varchar(20) NOT NULL,
	"locale" varchar(5) NOT NULL,
	"title" varchar(200) NOT NULL,
	"body" text NOT NULL,
	"requires_acceptance" boolean DEFAULT true NOT NULL,
	"published_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"operator_name" varchar(200) DEFAULT '' NOT NULL,
	"operator_address" varchar(500) DEFAULT '' NOT NULL,
	"operator_fiscal_number" varchar(40),
	"operator_vat_number" varchar(40),
	"operator_iban" varchar(40),
	"operator_bank" varchar(120),
	"support_email" varchar(254),
	"support_phone" varchar(40),
	"privacy_email" varchar(254),
	"invoice_prefix" varchar(10) DEFAULT 'PAC' NOT NULL,
	"payment_terms_days" integer DEFAULT 14 NOT NULL,
	"vat_rate_bp" integer DEFAULT 0 NOT NULL,
	"trial_days" integer DEFAULT 30 NOT NULL,
	"grace_days" integer DEFAULT 30 NOT NULL,
	"notice_text" varchar(300),
	"notice_tone" varchar(10) DEFAULT 'INFO' NOT NULL,
	"notice_until" timestamp with time zone,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_settings_single_ck" CHECK ("platform_settings"."id" = 1),
	CONSTRAINT "platform_settings_rules_ck" CHECK ("platform_settings"."payment_terms_days" BETWEEN 0 AND 120 AND "platform_settings"."vat_rate_bp" BETWEEN 0 AND 5000 AND "platform_settings"."trial_days" BETWEEN 0 AND 365 AND "platform_settings"."grace_days" BETWEEN 0 AND 365),
	CONSTRAINT "platform_settings_tone_ck" CHECK ("platform_settings"."notice_tone" IN ('INFO', 'WARNING'))
);
--> statement-breakpoint
CREATE TABLE "subscription_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"type" "subscription_event_type" NOT NULL,
	"from_status" "subscription_status",
	"to_status" "subscription_status",
	"from_plan_id" uuid,
	"to_plan_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" varchar(1000),
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(40) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" varchar(1000),
	"monthly_price_cents" integer NOT NULL,
	"yearly_price_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"seat_limit" integer,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plans_prices_ck" CHECK ("subscription_plans"."monthly_price_cents" >= 0 AND "subscription_plans"."yearly_price_cents" >= 0),
	CONSTRAINT "subscription_plans_seats_ck" CHECK ("subscription_plans"."seat_limit" IS NULL OR "subscription_plans"."seat_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "subscription_status" NOT NULL,
	"billing_cycle" "billing_cycle" DEFAULT 'MONTHLY' NOT NULL,
	"price_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"seats" integer,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"past_due_since" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"notes" varchar(2000),
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_price_ck" CHECK ("subscriptions"."price_cents" >= 0),
	CONSTRAINT "subscriptions_seats_ck" CHECK ("subscriptions"."seats" IS NULL OR "subscriptions"."seats" > 0),
	CONSTRAINT "subscriptions_period_ck" CHECK ("subscriptions"."current_period_end" > "subscriptions"."current_period_start")
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_from_plan_id_subscription_plans_id_fk" FOREIGN KEY ("from_plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_to_plan_id_subscription_plans_id_fk" FOREIGN KEY ("to_plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE INDEX "invoices_facility_idx" ON "invoices" USING btree ("facility_id","issued_at");--> statement-breakpoint
CREATE INDEX "invoices_status_due_idx" ON "invoices" USING btree ("status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_acceptances_user_version_uq" ON "legal_acceptances" USING btree ("user_id","kind","version");--> statement-breakpoint
CREATE INDEX "legal_acceptances_kind_version_idx" ON "legal_acceptances" USING btree ("kind","version");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_documents_version_uq" ON "legal_documents" USING btree ("kind","version","locale");--> statement-breakpoint
CREATE INDEX "legal_documents_published_idx" ON "legal_documents" USING btree ("kind","published_at");--> statement-breakpoint
CREATE INDEX "subscription_events_subscription_idx" ON "subscription_events" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE INDEX "subscription_events_facility_idx" ON "subscription_events" USING btree ("facility_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_plans_code_uq" ON "subscription_plans" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_facility_uq" ON "subscriptions" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "subscriptions_status_idx" ON "subscriptions" USING btree ("status","current_period_end");--> statement-breakpoint
-- The platform administrator has no facility, like the Ministry and patients.
-- (Compared as text: the new enum value cannot be used in the transaction that adds it.)
ALTER TABLE "users" DROP CONSTRAINT "users_role_facility_ck";
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_facility_ck" CHECK (
  ("role"::text IN ('DIRECTOR', 'DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'LAB_TECHNICIAN', 'IT_SUPPORT') AND "facility_id" IS NOT NULL)
  OR ("role"::text IN ('MINISTRY', 'PATIENT', 'ADMIN') AND "facility_id" IS NULL)
);
--> statement-breakpoint
-- Subscription history and legal acceptances are append-only.
CREATE TRIGGER subscription_events_append_only
  BEFORE UPDATE OR DELETE ON "subscription_events"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
CREATE TRIGGER legal_acceptances_append_only
  BEFORE UPDATE OR DELETE ON "legal_acceptances"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
-- An issued invoice keeps its number, period, amounts and the issuer/customer details. Only an
-- open invoice changes, once: to paid (payment details) or to void (reason). Never deleted.
CREATE OR REPLACE FUNCTION invoices_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoices cannot be deleted; void them instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.number, NEW.facility_id, NEW.subscription_id, NEW.period_start, NEW.period_end,
      NEW.description, NEW.net_cents, NEW.tax_rate_bp, NEW.tax_cents, NEW.total_cents,
      NEW.currency, NEW.issued_at, NEW.due_at, NEW.issuer, NEW.customer)
     IS DISTINCT FROM
     (OLD.number, OLD.facility_id, OLD.subscription_id, OLD.period_start, OLD.period_end,
      OLD.description, OLD.net_cents, OLD.tax_rate_bp, OLD.tax_cents, OLD.total_cents,
      OLD.currency, OLD.issued_at, OLD.due_at, OLD.issuer, OLD.customer) THEN
    RAISE EXCEPTION 'an issued invoice cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'OPEN'
     AND (NEW.status, NEW.paid_at, NEW.payment_method, NEW.payment_reference, NEW.voided_at,
          NEW.void_reason)
         IS DISTINCT FROM
         (OLD.status, OLD.paid_at, OLD.payment_method, OLD.payment_reference, OLD.voided_at,
          OLD.void_reason) THEN
    RAISE EXCEPTION 'a % invoice cannot be changed', lower(OLD.status::text)
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER invoices_guard
  BEFORE UPDATE OR DELETE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION invoices_guard();
--> statement-breakpoint
-- A published terms of use or privacy notice is fixed: a change is a new version.
CREATE OR REPLACE FUNCTION legal_documents_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'a published legal document cannot be deleted'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.published_at IS NOT NULL
     AND (NEW.kind, NEW.version, NEW.locale, NEW.title, NEW.body, NEW.requires_acceptance,
          NEW.published_at)
         IS DISTINCT FROM
         (OLD.kind, OLD.version, OLD.locale, OLD.title, OLD.body, OLD.requires_acceptance,
          OLD.published_at) THEN
    RAISE EXCEPTION 'a published legal document cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER legal_documents_guard
  BEFORE UPDATE OR DELETE ON "legal_documents"
  FOR EACH ROW EXECUTE FUNCTION legal_documents_guard();
--> statement-breakpoint
-- The settings row always exists; the administrator fills it in.
INSERT INTO "platform_settings" ("id") VALUES (1) ON CONFLICT DO NOTHING;
