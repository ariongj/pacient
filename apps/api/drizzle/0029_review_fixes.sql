ALTER TYPE "public"."email_status" ADD VALUE 'CANCELLED';--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "attachment_locale" varchar(2);--> statement-breakpoint
ALTER TABLE "operator_request_messages" ADD COLUMN "from_operator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "worker_runs_failed_idx" ON "worker_runs" USING btree ("worker","started_at" DESC NULLS LAST) WHERE "worker_runs"."ok" = false;
--> statement-breakpoint
-- Existing messages: written by the operator when their author is an administrator now (the best
-- that can be known for them; every new message records it when it is written). The messages are
-- append-only, so the guard is set aside for this one backfill only.
ALTER TABLE "operator_request_messages" DISABLE TRIGGER operator_request_messages_append_only;
--> statement-breakpoint
-- (role compared as text: on a new database the value ADMIN is added in the same transaction.)
UPDATE "operator_request_messages" m SET "from_operator" = true
  FROM "users" u WHERE u.id = m.author_id AND u.role::text = 'ADMIN';
--> statement-breakpoint
ALTER TABLE "operator_request_messages" ENABLE TRIGGER operator_request_messages_append_only;
--> statement-breakpoint
-- A payment is recorded as received and may be reversed later – never inserted already
-- reversed, which would let a settled invoice reopen without a payment ever having counted.
CREATE OR REPLACE FUNCTION invoice_payments_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reversed_at IS NOT NULL OR NEW.reversed_by_id IS NOT NULL OR NEW.reversal_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a payment is recorded first and reversed afterwards'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
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
DROP TRIGGER invoice_payments_guard ON "invoice_payments";
--> statement-breakpoint
CREATE TRIGGER invoice_payments_guard
  BEFORE INSERT OR UPDATE OR DELETE ON "invoice_payments"
  FOR EACH ROW EXECUTE FUNCTION invoice_payments_guard();
