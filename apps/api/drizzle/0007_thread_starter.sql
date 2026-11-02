ALTER TABLE "message_threads" ADD COLUMN "started_by_id" uuid;--> statement-breakpoint
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing threads were started by whoever sent the first message.
UPDATE "message_threads" t SET "started_by_id" = (
  SELECT m.sender_id FROM "messages" m WHERE m.thread_id = t.id ORDER BY m.created_at LIMIT 1
);
