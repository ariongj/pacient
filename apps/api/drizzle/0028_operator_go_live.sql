CREATE TYPE "public"."operator_request_category" AS ENUM('BILLING', 'ACCOUNT', 'TECHNICAL', 'DATA_PROTECTION', 'SECURITY_INCIDENT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."operator_request_priority" AS ENUM('NORMAL', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."operator_request_status" AS ENUM('OPEN', 'WAITING_CUSTOMER', 'RESOLVED');--> statement-breakpoint
ALTER TYPE "public"."legal_document_kind" ADD VALUE 'SERVICE_AGREEMENT';--> statement-breakpoint
ALTER TYPE "public"."legal_document_kind" ADD VALUE 'DPA';--> statement-breakpoint
CREATE TABLE "billing_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid,
	"credit_note_id" uuid,
	"kind" varchar(10) NOT NULL,
	"recipient" varchar(254) NOT NULL,
	"email_outbox_id" uuid NOT NULL,
	"queued_by_id" uuid,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_deliveries_document_ck" CHECK (num_nonnulls("billing_deliveries"."invoice_id", "billing_deliveries"."credit_note_id") = 1),
	CONSTRAINT "billing_deliveries_kind_ck" CHECK ("billing_deliveries"."kind" IN ('ISSUED', 'REMINDER', 'RESEND'))
);
--> statement-breakpoint
CREATE TABLE "credit_note_counters" (
	"year" integer PRIMARY KEY NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(30) NOT NULL,
	"year" integer NOT NULL,
	"seq" integer NOT NULL,
	"invoice_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"reason" varchar(500) NOT NULL,
	"net_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"vat_rate_bp" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"issuer" jsonb NOT NULL,
	"customer" jsonb NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid,
	CONSTRAINT "credit_notes_amounts_ck" CHECK ("credit_notes"."net_cents" >= 0 AND "credit_notes"."tax_cents" >= 0 AND "credit_notes"."total_cents" = "credit_notes"."net_cents" + "credit_notes"."tax_cents" AND "credit_notes"."total_cents" > 0),
	CONSTRAINT "credit_notes_vat_ck" CHECK ("credit_notes"."vat_rate_bp" BETWEEN 0 AND 5000)
);
--> statement-breakpoint
CREATE TABLE "facility_billing_profiles" (
	"facility_id" uuid PRIMARY KEY NOT NULL,
	"legal_name" varchar(200) NOT NULL,
	"business_number" varchar(40),
	"fiscal_number" varchar(40),
	"vat_number" varchar(40),
	"billing_address" varchar(500),
	"billing_emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"contact_name" varchar(200),
	"customer_reference" varchar(120),
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_billing_profiles_emails_ck" CHECK (cardinality("facility_billing_profiles"."billing_emails") <= 3 AND array_position("facility_billing_profiles"."billing_emails", NULL) IS NULL AND coalesce(length("facility_billing_profiles"."billing_emails"[1]), 1) BETWEEN 1 AND 254 AND coalesce(length("facility_billing_profiles"."billing_emails"[2]), 1) BETWEEN 1 AND 254 AND coalesce(length("facility_billing_profiles"."billing_emails"[3]), 1) BETWEEN 1 AND 254),
	CONSTRAINT "facility_billing_profiles_name_ck" CHECK (length(trim("facility_billing_profiles"."legal_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "invoice_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"method" varchar(40) NOT NULL,
	"reference" varchar(120),
	"recorded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by_id" uuid,
	"reversal_reason" varchar(500),
	CONSTRAINT "invoice_payments_amount_ck" CHECK ("invoice_payments"."amount_cents" > 0),
	CONSTRAINT "invoice_payments_method_ck" CHECK ("invoice_payments"."method" IN ('BANK_TRANSFER', 'CASH', 'CARD', 'OTHER')),
	CONSTRAINT "invoice_payments_reversal_ck" CHECK (("invoice_payments"."reversed_at" IS NULL) = ("invoice_payments"."reversed_by_id" IS NULL) AND ("invoice_payments"."reversed_at" IS NULL) = ("invoice_payments"."reversal_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "operator_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"condition_key" varchar(120) NOT NULL,
	"severity" varchar(10) NOT NULL,
	"message" varchar(500) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_notified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "operator_alerts_severity_ck" CHECK ("operator_alerts"."severity" IN ('WARNING', 'CRITICAL'))
);
--> statement-breakpoint
CREATE TABLE "operator_request_counters" (
	"year" integer PRIMARY KEY NOT NULL,
	"last" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_request_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_request_messages_body_ck" CHECK (length(trim("operator_request_messages"."body")) > 0 AND length("operator_request_messages"."body") <= 4000)
);
--> statement-breakpoint
CREATE TABLE "operator_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(20) NOT NULL,
	"facility_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"category" "operator_request_category" NOT NULL,
	"subject" varchar(200) NOT NULL,
	"status" "operator_request_status" DEFAULT 'OPEN' NOT NULL,
	"priority" "operator_request_priority" DEFAULT 'NORMAL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_response_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "operator_requests_subject_ck" CHECK (length(trim("operator_requests"."subject")) > 0),
	CONSTRAINT "operator_requests_resolved_ck" CHECK (("operator_requests"."status" = 'RESOLVED') = ("operator_requests"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ops_heartbeats" (
	"name" varchar(60) PRIMARY KEY NOT NULL,
	"last_ok_at" timestamp with time zone NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "organization_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" "legal_document_kind" NOT NULL,
	"version" varchar(20) NOT NULL,
	"accepted_by_id" uuid NOT NULL,
	"signer_name" varchar(200) NOT NULL,
	"signer_title" varchar(200) NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(300),
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_acceptances_kind_ck" CHECK ("organization_acceptances"."kind"::text IN ('SERVICE_AGREEMENT', 'DPA')),
	CONSTRAINT "organization_acceptances_signer_ck" CHECK (length(trim("organization_acceptances"."signer_name")) > 0 AND length(trim("organization_acceptances"."signer_title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "worker_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"worker" varchar(60) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"summary" jsonb,
	"error" varchar(500)
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "attachment_kind" varchar(20);--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "attachment_id" uuid;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "support_hours" varchar(120);--> statement-breakpoint
ALTER TABLE "billing_deliveries" ADD CONSTRAINT "billing_deliveries_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_deliveries" ADD CONSTRAINT "billing_deliveries_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_deliveries" ADD CONSTRAINT "billing_deliveries_email_outbox_id_email_outbox_id_fk" FOREIGN KEY ("email_outbox_id") REFERENCES "public"."email_outbox"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_deliveries" ADD CONSTRAINT "billing_deliveries_queued_by_id_users_id_fk" FOREIGN KEY ("queued_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_billing_profiles" ADD CONSTRAINT "facility_billing_profiles_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_billing_profiles" ADD CONSTRAINT "facility_billing_profiles_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_reversed_by_id_users_id_fk" FOREIGN KEY ("reversed_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_request_messages" ADD CONSTRAINT "operator_request_messages_request_id_operator_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."operator_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_request_messages" ADD CONSTRAINT "operator_request_messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_requests" ADD CONSTRAINT "operator_requests_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_requests" ADD CONSTRAINT "operator_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_acceptances" ADD CONSTRAINT "organization_acceptances_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_acceptances" ADD CONSTRAINT "organization_acceptances_document_id_legal_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."legal_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_acceptances" ADD CONSTRAINT "organization_acceptances_accepted_by_id_users_id_fk" FOREIGN KEY ("accepted_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_deliveries_invoice_idx" ON "billing_deliveries" USING btree ("invoice_id","queued_at");--> statement-breakpoint
CREATE INDEX "billing_deliveries_credit_note_idx" ON "billing_deliveries" USING btree ("credit_note_id","queued_at");--> statement-breakpoint
CREATE INDEX "billing_deliveries_outbox_idx" ON "billing_deliveries" USING btree ("email_outbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_number_uq" ON "credit_notes" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_year_seq_uq" ON "credit_notes" USING btree ("year","seq");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "credit_notes_facility_idx" ON "credit_notes" USING btree ("facility_id","issued_at");--> statement-breakpoint
CREATE INDEX "invoice_payments_invoice_idx" ON "invoice_payments" USING btree ("invoice_id","paid_at");--> statement-breakpoint
CREATE INDEX "invoice_payments_paid_idx" ON "invoice_payments" USING btree ("paid_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_alerts_condition_uq" ON "operator_alerts" USING btree ("condition_key");--> statement-breakpoint
CREATE INDEX "operator_alerts_open_idx" ON "operator_alerts" USING btree ("resolved_at","last_seen_at");--> statement-breakpoint
CREATE INDEX "operator_request_messages_request_idx" ON "operator_request_messages" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_requests_reference_uq" ON "operator_requests" USING btree ("reference");--> statement-breakpoint
CREATE INDEX "operator_requests_status_idx" ON "operator_requests" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "operator_requests_facility_idx" ON "operator_requests" USING btree ("facility_id","created_at");--> statement-breakpoint
CREATE INDEX "operator_requests_requester_idx" ON "operator_requests" USING btree ("requester_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_acceptances_document_uq" ON "organization_acceptances" USING btree ("facility_id","document_id");--> statement-breakpoint
CREATE INDEX "organization_acceptances_kind_idx" ON "organization_acceptances" USING btree ("kind","version");--> statement-breakpoint
CREATE INDEX "worker_runs_worker_idx" ON "worker_runs" USING btree ("worker","started_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_attachment_ck" CHECK (("email_outbox"."attachment_kind" IS NULL) = ("email_outbox"."attachment_id" IS NULL) AND ("email_outbox"."attachment_kind" IS NULL OR "email_outbox"."attachment_kind" IN ('invoice', 'credit_note')));--> statement-breakpoint
-- A recorded payment is never edited or deleted: a mistake is reversed, once, by setting the three
-- reversal columns (the CHECK keeps them together).
CREATE OR REPLACE FUNCTION invoice_payments_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments cannot be deleted; reverse them instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.reversed_at IS NOT NULL
     OR (NEW.id, NEW.invoice_id, NEW.amount_cents, NEW.paid_at, NEW.method, NEW.reference,
         NEW.recorded_by_id, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.invoice_id, OLD.amount_cents, OLD.paid_at, OLD.method, OLD.reference,
         OLD.recorded_by_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a recorded payment cannot be changed; reverse it instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER invoice_payments_guard
  BEFORE UPDATE OR DELETE ON "invoice_payments"
  FOR EACH ROW EXECUTE FUNCTION invoice_payments_guard();
--> statement-breakpoint
-- An issued credit note is fixed like an issued invoice; a mistake is corrected by another one.
CREATE OR REPLACE FUNCTION credit_notes_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'an issued credit note cannot be changed or deleted'
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER credit_notes_guard
  BEFORE UPDATE OR DELETE ON "credit_notes"
  FOR EACH ROW EXECUTE FUNCTION credit_notes_guard();
--> statement-breakpoint
-- Deliveries of billing documents, facilities' acceptances of agreements and the messages of
-- operator requests are append-only.
CREATE TRIGGER billing_deliveries_append_only
  BEFORE UPDATE OR DELETE ON "billing_deliveries"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
CREATE TRIGGER organization_acceptances_append_only
  BEFORE UPDATE OR DELETE ON "organization_acceptances"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
CREATE TRIGGER operator_request_messages_append_only
  BEFORE UPDATE OR DELETE ON "operator_request_messages"
  FOR EACH ROW EXECUTE FUNCTION block_mutation();
--> statement-breakpoint
-- An issued invoice keeps its number, period, amounts and the issuer/customer details. An open
-- invoice changes, once, to settled (PAID, with the details of the settling payment) or to void.
-- New: a settled invoice opens again – with the payment details cleared – only when one of its
-- payments is reversed in the same transaction (the reversal sets reversed_at to now(), the
-- transaction's clock). Nothing else changes a paid or void invoice. Never deleted.
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
  IF OLD.status = 'PAID' AND NEW.status = 'OPEN'
     AND NEW.paid_at IS NULL AND NEW.payment_method IS NULL AND NEW.payment_reference IS NULL
     AND (NEW.voided_at, NEW.void_reason) IS NOT DISTINCT FROM (OLD.voided_at, OLD.void_reason)
     AND EXISTS (SELECT 1 FROM invoice_payments
                  WHERE invoice_id = NEW.id AND reversed_at = now()) THEN
    RETURN NEW;
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
-- Payments get rows of their own: one per invoice paid so far, for its total, from the payment
-- details on the invoice, recorded by whoever recorded it in the subscription history. Invoices
-- with nothing to pay (issued as paid) have no payment.
INSERT INTO "invoice_payments"
  ("invoice_id", "amount_cents", "paid_at", "method", "reference", "recorded_by_id", "created_at")
SELECT i."id",
       i."total_cents",
       coalesce(i."paid_at", i."updated_at"),
       CASE WHEN i."payment_method" IN ('BANK_TRANSFER', 'CASH', 'CARD', 'OTHER')
            THEN i."payment_method" ELSE 'OTHER' END,
       i."payment_reference",
       e."actor_id",
       coalesce(e."created_at", i."paid_at", i."updated_at")
  FROM "invoices" i
  LEFT JOIN LATERAL (
    SELECT se."actor_id", se."created_at"
      FROM "subscription_events" se
     WHERE se."type" = 'PAYMENT_RECORDED' AND se."data"->>'invoiceId' = i."id"::text
     ORDER BY se."created_at" DESC
     LIMIT 1
  ) e ON true
 WHERE i."status" = 'PAID' AND i."total_cents" > 0;
