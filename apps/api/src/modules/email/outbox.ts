import { and, eq, sql } from 'drizzle-orm';
import { env, isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import { emailOutbox } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { open, seal } from '../../lib/secret-box.js';
import { render, type EmailTemplate } from './templates.js';
import { getTransport } from './transport.js';

/**
 * Transactional outbox for email.
 *
 *  - `enqueueEmail` writes inside the caller's transaction: the email exists if and only if the change
 *    that caused it committed.
 *  - The worker claims due messages with `FOR UPDATE SKIP LOCKED`, so several API instances can run
 *    it concurrently without sending duplicates; a crashed send is re-claimed after a lease timeout.
 *  - Failures are retried with exponential backoff, then marked FAILED.
 *  - Subject and bodies are encrypted at rest and erased once the message is delivered or abandoned.
 */
export const MAX_ATTEMPTS = 6;
const LEASE_MINUTES = 5;
const BATCH = 20;

export async function enqueueEmail(
  executor: Executor,
  message: { to: string; userId?: string | null } & EmailTemplate,
) {
  const { to, userId, ...template } = message;
  const rendered = render(template);
  await executor.insert(emailOutbox).values({
    userId: userId ?? null,
    toEmail: to,
    template: template.template,
    subjectSealed: seal(rendered.subject),
    textSealed: seal(rendered.text),
    htmlSealed: seal(rendered.html),
  });
}

/** Delivers due messages once. Returns the number delivered. */
export async function processOutboxOnce(): Promise<number> {
  const claimed = await db.execute<{
    id: string;
    to_email: string;
    subject_sealed: string;
    text_sealed: string;
    html_sealed: string;
    attempts: number;
  }>(sql`
    UPDATE email_outbox SET status = 'SENDING', attempts = attempts + 1, next_attempt_at = now()
    WHERE id IN (
      SELECT id FROM email_outbox
      WHERE (status = 'PENDING' AND next_attempt_at <= now())
         OR (status = 'SENDING' AND next_attempt_at < now() - make_interval(mins => ${LEASE_MINUTES}))
      ORDER BY created_at
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, to_email, subject_sealed, text_sealed, html_sealed, attempts`);

  let delivered = 0;
  for (const row of claimed.rows) {
    try {
      await getTransport().send({
        to: row.to_email,
        subject: open(row.subject_sealed),
        text: open(row.text_sealed),
        html: open(row.html_sealed),
      });
      await db
        .update(emailOutbox)
        .set({
          status: 'SENT',
          sentAt: new Date(),
          lastError: null,
          subjectSealed: null,
          textSealed: null,
          htmlSealed: null,
        })
        .where(eq(emailOutbox.id, row.id));
      delivered++;
    } catch (err) {
      const giveUp = row.attempts >= MAX_ATTEMPTS;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      logger.warn({ id: row.id, attempts: row.attempts, err: message }, 'Email delivery failed');
      await db
        .update(emailOutbox)
        .set(
          giveUp
            ? {
                status: 'FAILED',
                lastError: message,
                subjectSealed: null,
                textSealed: null,
                htmlSealed: null,
              }
            : {
                status: 'PENDING',
                lastError: message,
                // 1, 2, 4, 8, 16 minutes …
                nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** (row.attempts - 1)),
              },
        )
        .where(and(eq(emailOutbox.id, row.id), eq(emailOutbox.status, 'SENDING')));
    }
  }
  return delivered;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startEmailWorker(intervalMs = 5_000) {
  if (timer || isTest || env.EMAIL_WORKER !== 'true') return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    processOutboxOnce()
      .catch((err: unknown) => logger.error({ err }, 'Email worker error'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  logger.info({ transport: env.EMAIL_TRANSPORT }, 'Email worker started');
}

export function stopEmailWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Delivery health for operations dashboards (no message content). */
export async function outboxHealth() {
  const result = await db.execute<{ status: string; count: number; oldest: string | null }>(sql`
    SELECT status, count(*)::int AS count, min(created_at) AS oldest FROM email_outbox
    WHERE created_at > now() - interval '7 days' GROUP BY status`);
  return Object.fromEntries(
    result.rows.map((r) => [r.status, { count: r.count, oldest: r.oldest }]),
  );
}
