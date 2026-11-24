ALTER TABLE "subscriptions" ADD COLUMN "next_billing_cycle" "billing_cycle";--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "next_price_cents" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "plan_seat_limit" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "billing_anchor" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "suspension_cause" varchar(20);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_seat_limit_ck" CHECK ("subscriptions"."plan_seat_limit" IS NULL OR "subscriptions"."plan_seat_limit" > 0);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_next_cycle_ck" CHECK (("subscriptions"."next_billing_cycle" IS NULL) = ("subscriptions"."next_price_cents" IS NULL) AND ("subscriptions"."next_billing_cycle" IS NULL OR "subscriptions"."next_billing_cycle" <> "subscriptions"."billing_cycle") AND ("subscriptions"."next_price_cents" IS NULL OR "subscriptions"."next_price_cents" >= 0));--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_suspension_ck" CHECK ("subscriptions"."suspension_cause" IS NULL OR ("subscriptions"."suspension_cause" IN ('NON_PAYMENT', 'MANUAL') AND "subscriptions"."status" = 'SUSPENDED'));
--> statement-breakpoint
-- Running subscriptions keep the seat limit their plan has now: later edits of the plan no longer
-- change them (null stays "unlimited").
UPDATE "subscriptions" s SET "plan_seat_limit" = p."seat_limit"
  FROM "subscription_plans" p WHERE p."id" = s."plan_id";
--> statement-breakpoint
-- Renewals keep the day of the month (and the time of day) of the current period's start.
UPDATE "subscriptions" SET "billing_anchor" = "current_period_start";
--> statement-breakpoint
-- Why each suspended subscription is suspended: by the subscription worker (no actor) for
-- non-payment, otherwise by an administrator – then only reactivating lifts it.
UPDATE "subscriptions" s
  SET "suspension_cause" = CASE WHEN e."actor_id" IS NULL THEN 'NON_PAYMENT' ELSE 'MANUAL' END
  FROM (
    SELECT DISTINCT ON ("subscription_id") "subscription_id", "actor_id"
      FROM "subscription_events"
      WHERE "type" = 'SUSPENDED'
      ORDER BY "subscription_id", "created_at" DESC, "id" DESC
  ) e
  WHERE e."subscription_id" = s."id" AND s."status" = 'SUSPENDED';
--> statement-breakpoint
UPDATE "subscriptions" SET "suspension_cause" = 'MANUAL'
  WHERE "status" = 'SUSPENDED' AND "suspension_cause" IS NULL;