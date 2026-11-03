CREATE TABLE "partner_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"organisation" varchar(200) NOT NULL,
	"scopes" text[] NOT NULL,
	"api_key_hash" varchar(128) NOT NULL,
	"api_key_prefix" varchar(20) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"allowed_ips" text[],
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "partner_clients" ADD CONSTRAINT "partner_clients_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_clients_key_uq" ON "partner_clients" USING btree ("api_key_hash");--> statement-breakpoint
ALTER TABLE "partner_clients" ADD CONSTRAINT "partner_clients_scopes_ck" CHECK (
  cardinality("scopes") > 0
  AND "scopes" <@ ARRAY['fhir.patient.read', 'stats.read', 'directory.read', 'births.notify']::text[]);
--> statement-breakpoint
ALTER TABLE "partner_clients" ADD CONSTRAINT "partner_clients_revoked_ck" CHECK ("revoked_at" IS NULL OR NOT "is_active");
