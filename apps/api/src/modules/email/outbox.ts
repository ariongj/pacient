import { and, eq, sql } from 'drizzle-orm';
import { env, isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import { emailOutbox, users } from '../../db/schema.js';
import { toLocale } from '../../i18n/index.js';
import { logger } from '../../lib/logger.js';
import { open, seal } from '../../lib/secret-box.js';
import { render, type EmailTemplate } from './templates.js';
import { getTransport } from './transport.js';
import { getSettings } from '../platform/platform.service.js';
import { recordRun, registerWorker } from '../../lib/worker-runs.js';

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

/**
 * A billing document to attach when the message is sent. Only its kind and id are stored: the PDF
 * is rendered from the issued (immutable) document at that moment, so nothing PDF-shaped is kept.
 */
export interface OutboxAttachment {
  kind: 'invoice' | 'credit_note';
  id: string;
}

/** Queues a message in the caller's transaction; returns the id of its outbox row. */
export async function enqueueEmail(
  executor: Executor,
  message: { to: string; userId?: string | null; attachment?: OutboxAttachment } & EmailTemplate,
): Promise<string> {
  const { to, userId, attachment, ...template } = message;
  const rendered = render(template);
  const [row] = await executor
    .insert(emailOutbox)
    .values({
      userId: userId ?? null,
      toEmail: to,
      template: template.template,
      subjectSealed: seal(rendered.subject),
      textSealed: seal(rendered.text),
      htmlSealed: seal(rendered.html),
      attachmentKind: attachment?.kind ?? null,
      attachmentId: attachment?.id ?? null,
    })
    .returning({ id: emailOutbox.id });
  return row!.id;
}

/**
 * The PDF of a billing document, in the language of the account the message goes to (Albanian
 * for a billing address without an account). Loaded on demand: most messages carry nothing.
 */
async function attachmentOf(row: {
  attachment_kind: string;
  attachment_id: string;
  user_id: string | null;
}) {
  const { billingAttachment } = await import('../subscriptions/billing-documents.js');
  const [user] = row.user_id
    ? await db.select({ locale: users.locale }).from(users).where(eq(users.id, row.user_id))
    : [];
  return billingAttachment(
    row.attachment_kind === 'credit_note' ? 'credit_note' : 'invoice',
    row.attachment_id,
    toLocale(user?.locale),
  );
}

/** Delivers due messages once. Returns the number delivered. */
export async function processOutboxOnce(): Promise<number> {
  const claimed = await db.execute<{
    id: string;
    to_email: string;
    user_id: string | null;
    subject_sealed: string;
    text_sealed: string;
    html_sealed: string;
    attachment_kind: string | null;
    attachment_id: string | null;
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
    RETURNING id, to_email, user_id, subject_sealed, text_sealed, html_sealed, attachment_kind,
      attachment_id, attempts`);

  let delivered = 0;
  // Replies go to the operator's support address when it is set, not to the no-reply sender
  // (without it, if the settings cannot be read, the messages still go out).
  const replyTo = claimed.rows.length
    ? (await getSettings().catch(() => null))?.supportEmail?.trim() || undefined
    : undefined;
  for (const row of claimed.rows) {
    try {
      // A document that cannot be rendered fails the delivery like the mail server would:
      // retried, then marked FAILED – never sent without the document it announces.
      const attachments =
        row.attachment_kind && row.attachment_id
          ? [
              await attachmentOf({
                attachment_kind: row.attachment_kind,
                attachment_id: row.attachment_id,
                user_id: row.user_id,
              }),
            ]
          : undefined;
      await getTransport().send({
        to: row.to_email,
        replyTo,
        subject: open(row.subject_sealed),
        text: open(row.text_sealed),
        html: open(row.html_sealed),
        ...(attachments ? { attachments } : {}),
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
  if (env.EMAIL_TRANSPORT === 'held') {
    logger.warn(
      'SMTP_URL is not set: emails (activation, password reset, notifications) are queued but not delivered',
    );
    return;
  }
  registerWorker('email', intervalMs);
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void recordRun('email', processOutboxOnce).finally(() => {
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
