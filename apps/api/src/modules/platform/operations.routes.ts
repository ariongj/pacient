import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { opsHeartbeats, users } from '../../db/schema.js';
import { notFound, tooManyRequests, unauthorized } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { toLocale } from '../../i18n/index.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { enqueueEmail, MAX_ATTEMPTS } from '../email/outbox.js';
import { openOperatorAlerts, resolveOperatorAlert } from './alerts.js';

/**
 * Operations for the operator of the service: e-mail deliverability, alerts and the heartbeat of
 * jobs that run outside the API. (Worker status is part of the existing GET /monitoring/health.)
 *
 * `operationsAdminRouter` is mounted on /admin/platform (authenticated, ADMIN only):
 *   POST /admin/platform/test-email – one message to the caller's own address, 1 per minute,
 *        audited platform.test_email_sent.
 *   GET  /admin/platform/email-failures – the last 50 failed or retrying outbox rows: masked
 *        recipient (a***@domain), template, attempts, last error, dates; never subject or body.
 *   GET  /admin/platform/alerts – open operator alerts (AdminHome).
 *
 * `opsRouter` is mounted on /ops without user authentication:
 *   POST /ops/heartbeat/backup – with the OPS_HEARTBEAT_TOKEN from the environment (constant-time
 *        comparison), called by deploy/backup.sh after a successful backup.
 */
export const operationsAdminRouter = Router();
export const opsRouter = Router();

/* ------------------------------------------------------------------ e-mail ------------------ */

/**
 * An address shown to the operator as "a***@domain": enough to tell a typo in the domain or a
 * mailbox that no longer exists from a refusing mail server, without listing who receives mail
 * (patients among them).
 */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return '***';
  return `${address[0]}***@${address.slice(at + 1)}`;
}

/** A mail server's error with the addresses in it masked and long numbers removed. */
export function maskErrorText(text: string | null): string | null {
  if (!text) return text;
  return text
    .replace(/[^\s@'"<>(),;:]+@[^\s@'"<>(),;:]+/g, (m) => maskEmail(m))
    .replace(/\d{8,}/g, '…');
}

/** One test message per administrator and minute: enough to check, not enough to spam. */
const TEST_EMAIL_EVERY_SECONDS = 60;

/**
 * Queues a test message to the caller's own address (never to an address typed in: the endpoint
 * cannot be used to send mail to others), in the transaction that audits it.
 */
operationsAdminRouter.post('/test-email', async (req, res) => {
  const ctx = requireAuth(req);
  const [me] = await db
    .select({ email: users.email, fullName: users.fullName, locale: users.locale })
    .from(users)
    .where(eq(users.id, ctx.userId));
  if (!me) throw notFound();
  await db.transaction(async (tx) => {
    // Two clicks at once must not both pass the check below.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`test-email:${ctx.userId}`}))`);
    const { rows } = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM email_outbox
       WHERE user_id = ${ctx.userId} AND template = 'test_email'
         AND created_at > now() - make_interval(secs => ${TEST_EMAIL_EVERY_SECONDS})`);
    if ((rows[0]?.n ?? 0) > 0) {
      throw tooManyRequests('One test e-mail per minute. Wait a moment and try again.');
    }
    await enqueueEmail(tx, {
      to: me.email,
      userId: ctx.userId,
      template: 'test_email',
      locale: toLocale(me.locale),
      name: me.fullName,
    });
    await audit(
      {
        action: AuditAction.PLATFORM_TEST_EMAIL_SENT,
        actor: ctx,
        resourceType: 'user',
        resourceId: ctx.userId,
        meta: requestMeta(req),
      },
      tx,
    );
  });
  res.status(202).json({
    to: me.email,
    // Production without SMTP_URL keeps messages in the outbox: say so instead of waiting.
    deliveryConfigured: env.EMAIL_TRANSPORT !== 'held',
  });
});

type FailureRow = {
  id: string;
  to_email: string;
  template: string;
  status: 'PENDING' | 'SENDING' | 'FAILED';
  attempts: number;
  last_error: string | null;
  created_at: Date;
  next_attempt_at: Date;
};

/**
 * Messages that were given up and messages being retried after a failure, newest first. The
 * subject and body are never read (they are sealed, and erased once a message is given up); the
 * recipient is masked and so is any address in the error.
 */
operationsAdminRouter.get('/email-failures', async (_req, res) => {
  const [{ rows }, summary] = await Promise.all([
    db.execute<FailureRow>(sql`
      SELECT id, to_email, template, status, attempts, last_error, created_at, next_attempt_at
        FROM email_outbox
       WHERE status = 'FAILED'
          OR (status IN ('PENDING', 'SENDING') AND attempts > 0 AND last_error IS NOT NULL)
       ORDER BY created_at DESC, id
       LIMIT 50`),
    db.execute<{ failed: number; retrying: number }>(sql`
      SELECT
        (SELECT count(*)::int FROM email_outbox WHERE status = 'FAILED'
            AND next_attempt_at > now() - interval '24 hours') AS failed,
        (SELECT count(*)::int FROM email_outbox WHERE status IN ('PENDING', 'SENDING')
            AND attempts > 0 AND last_error IS NOT NULL) AS retrying`),
  ]);
  res.json({
    failedLast24h: summary.rows[0]?.failed ?? 0,
    retrying: summary.rows[0]?.retrying ?? 0,
    maxAttempts: MAX_ATTEMPTS,
    items: rows.map((r) => {
      const failed = r.status === 'FAILED';
      const next = new Date(r.next_attempt_at);
      return {
        id: r.id,
        recipient: maskEmail(r.to_email),
        template: r.template,
        status: failed ? ('FAILED' as const) : ('RETRYING' as const),
        attempts: r.attempts,
        lastError: maskErrorText(r.last_error),
        createdAt: new Date(r.created_at),
        // The last attempt of a message given up; the next one of a message being retried.
        failedAt: failed ? next : null,
        nextAttemptAt: failed ? null : next,
      };
    }),
  });
});

/* ------------------------------------------------------------------ alerts ------------------ */

/** Open operator alerts for the platform overview. */
operationsAdminRouter.get('/alerts', async (_req, res) => {
  res.json({ items: await openOperatorAlerts() });
});

/* ------------------------------------------------------------------ heartbeats -------------- */

function bearerMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7).trim() : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** What the backup script may report: sizes and durations, nothing else. */
const BackupHeartbeat = z
  .object({
    sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    durationSeconds: z
      .number()
      .min(0)
      .max(7 * 86_400)
      .optional(),
  })
  .strict();

/**
 * deploy/backup.sh reports a successful backup. Off (404) until OPS_HEARTBEAT_TOKEN is set; the
 * token is compared in constant time. An open 'backup.stale' alert is resolved at once.
 */
opsRouter.post('/heartbeat/backup', async (req, res) => {
  const token = env.OPS_HEARTBEAT_TOKEN;
  if (!token) throw notFound('Heartbeats are switched off on this server (OPS_HEARTBEAT_TOKEN)');
  if (!bearerMatches(req.get('authorization'), token)) {
    logger.warn({ ip: req.ip }, 'Backup heartbeat with a wrong token');
    throw unauthorized('Wrong heartbeat token');
  }
  const body = parse(BackupHeartbeat, req.body ?? {});
  const detail = Object.keys(body).length ? body : null;
  const now = new Date();
  await db
    .insert(opsHeartbeats)
    .values({ name: 'backup', lastOkAt: now, detail })
    .onConflictDoUpdate({ target: opsHeartbeats.name, set: { lastOkAt: now, detail } });
  await resolveOperatorAlert('backup.stale');
  res.json({ name: 'backup', lastOkAt: now });
});
