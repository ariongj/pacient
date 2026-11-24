ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_suspension_ck";--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "title_source" varchar(200);--> statement-breakpoint
ALTER TABLE "legal_documents" ADD COLUMN "body_source" text;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_source_ck" CHECK (("legal_documents"."title_source" IS NULL) = ("legal_documents"."body_source" IS NULL) AND ("legal_documents"."title_source" IS NULL OR "legal_documents"."published_at" IS NOT NULL));--> statement-breakpoint
-- A suspension without a recorded cause is treated as the administrator's (only reactivating
-- lifts it), as migration 0026 decided; from now on every suspension must say why.
UPDATE "subscriptions" SET "suspension_cause" = 'MANUAL'
  WHERE "status" = 'SUSPENDED' AND "suspension_cause" IS NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_suspension_ck" CHECK (("subscriptions"."status" = 'SUSPENDED') = ("subscriptions"."suspension_cause" IS NOT NULL) AND ("subscriptions"."suspension_cause" IS NULL OR "subscriptions"."suspension_cause" IN ('NON_PAYMENT', 'MANUAL')));
--> statement-breakpoint
-- A published terms of use or privacy notice is fixed, now including the text as written (with
-- its placeholders) that publishing keeps beside the filled-in text. Publishing itself sets both
-- in the same statement as published_at, while the row is still a draft.
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
          NEW.published_at, NEW.title_source, NEW.body_source)
         IS DISTINCT FROM
         (OLD.kind, OLD.version, OLD.locale, OLD.title, OLD.body, OLD.requires_acceptance,
          OLD.published_at, OLD.title_source, OLD.body_source) THEN
    RAISE EXCEPTION 'a published legal document cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
