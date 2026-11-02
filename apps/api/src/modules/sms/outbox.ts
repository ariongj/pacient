import { eq, sql, and } from 'drizzle-orm';
import { env, isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import { smsOutbox } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { open, seal } from '../../lib/secret-box.js';
import { getSmsTransport } from './transport.js';

/**
 * SMS outbox: same guarantees as email (enqueued in the caller's transaction, SKIP LOCKED workers,
 * retries with backoff, body encrypted at rest and erased after delivery). Non-urgent messages are
 * held during quiet hours. Bodies are short and never contain clinical information.
 */
export const SMS_MAX_ATTEMPTS = 5;
const LEASE_MINUTES = 5;
const BATCH = 20;
/** Keep messages to one SMS segment where possible. */
export const SMS_MAX_LENGTH = 160;

function localHour(d: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: env.SMS_TIMEZONE,
    }).format(d),
  );
}

export function inQuietHours(d: Date, window = env.SMS_QUIET_HOURS): boolean {
  if (!window) return false;
  const [start, end] = window.split('-').map(Number) as [number, number];
  const h = localHour(d);
  return start > end ? h >= start || h < end : h >= start && h < end;
}

/** The next moment outside quiet hours (15-minute resolution; avoids manual time-zone maths). */
export function nextSendTime(from = new Date(), window = env.SMS_QUIET_HOURS): Date {
  const t = new Date(from);
  for (let i = 0; i < 96 && inQuietHours(t, window); i++) t.setTime(t.getTime() + 15 * 60_000);
  return t;
}

export async function enqueueSms(
  executor: Executor,
  message: { to: string; userId?: string | null; template: string; body: string; urgent?: boolean },
) {
  const body =
    message.body.length > SMS_MAX_LENGTH
      ? `${message.body.slice(0, SMS_MAX_LENGTH - 1)}…`
      : message.body;
  await executor.insert(smsOutbox).values({
    userId: message.userId ?? null,
    toPhone: message.to,
    template: message.template,
    bodySealed: seal(body),
    nextAttemptAt: message.urgent ? new Date() : nextSendTime(),
  });
}

export async function processSmsOnce(): Promise<number> {
  const claimed = await db.execute<{
    id: string;
    to_phone: string;
    body_sealed: string;
    attempts: number;
  }>(sql`
    UPDATE sms_outbox SET status = 'SENDING', attempts = attempts + 1, next_attempt_at = now()
    WHERE id IN (
      SELECT id FROM sms_outbox
      WHERE (status = 'PENDING' AND next_attempt_at <= now())
         OR (status = 'SENDING' AND next_attempt_at < now() - make_interval(mins => ${LEASE_MINUTES}))
      ORDER BY created_at
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, to_phone, body_sealed, attempts`);
  let delivered = 0;
  for (const row of claimed.rows) {
    try {
      const providerMessageId = await getSmsTransport().send({
        to: row.to_phone,
        body: open(row.body_sealed),
      });
      await db
        .update(smsOutbox)
        .set({
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId,
          lastError: null,
          bodySealed: null,
        })
        .where(eq(smsOutbox.id, row.id));
      delivered++;
    } catch (err) {
      const giveUp = row.attempts >= SMS_MAX_ATTEMPTS;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      logger.warn({ id: row.id, attempts: row.attempts, err: message }, 'SMS delivery failed');
      await db
        .update(smsOutbox)
        .set(
          giveUp
            ? { status: 'FAILED', lastError: message, bodySealed: null }
            : {
                status: 'PENDING',
                lastError: message,
                nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** (row.attempts - 1)),
              },
        )
        .where(and(eq(smsOutbox.id, row.id), eq(smsOutbox.status, 'SENDING')));
    }
  }
  return delivered;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startSmsWorker(intervalMs = 5_000) {
  if (timer || isTest || env.SMS_WORKER !== 'true') return;
  if (env.SMS_PROVIDER === 'held') {
    logger.warn('SMS provider is not configured: SMS notifications are queued but not delivered');
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    processSmsOnce()
      .catch((err: unknown) => logger.error({ err }, 'SMS worker error'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  logger.info({ provider: env.SMS_PROVIDER }, 'SMS worker started');
}

export function stopSmsWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function smsHealth() {
  const result = await db.execute<{ status: string; count: number; oldest: string | null }>(sql`
    SELECT status, count(*)::int AS count, min(created_at) AS oldest FROM sms_outbox
    WHERE created_at > now() - interval '7 days' GROUP BY status`);
  return Object.fromEntries(
    result.rows.map((r) => [r.status, { count: r.count, oldest: r.oldest }]),
  );
}
