import { eq, sql, type SQL } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db } from '../../db/client.js';
import { retentionPolicies } from '../../db/schema.js';
import type { AuthContext } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';

/**
 * Retention of OPERATIONAL data (Law No. 06/L-082 on Protection of Personal Data, art. 4 –
 * storage limitation). Clinical records are NOT handled here: they are kept for the period the
 * health-records legislation requires and are never purged by this job. The audit trail is
 * append-only and is never purged either (archive it instead – see docs/PRIVACY.md).
 *
 * Every category below is a fixed, reviewed SQL statement; the Ministry can change how many days
 * are kept and switch a category off, never what it deletes. Rows linked to a patient under an
 * active legal hold are always skipped.
 */
export type RetentionAction = 'PURGE' | 'ANONYMISE';

export interface RetentionCategory {
  category: string;
  /** English description (translated in the web app). */
  description: string;
  action: RetentionAction;
  defaultDays: number;
  legalBasis: string;
  /** WHERE clause selecting expired rows, for a given cut-off. */
  where: (cutoff: Date) => SQL;
  table: string;
  /** SET clause for ANONYMISE. */
  set?: SQL;
}

/** Patient-user link: rows of users whose patient record is under an active legal hold. */
const userOnHold = (col: SQL) => sql`EXISTS (
  SELECT 1 FROM patients hp JOIN legal_holds lh ON lh.patient_id = hp.id AND lh.released_at IS NULL
  WHERE hp.user_id = ${col})`;
const patientOnHold = (col: SQL) =>
  sql`EXISTS (SELECT 1 FROM legal_holds lh WHERE lh.patient_id = ${col} AND lh.released_at IS NULL)`;

const BASIS_OPERATIONAL =
  'Storage limitation (Law No. 06/L-082, art. 4): operational data is kept only as long as needed for the service.';

export const RETENTION_CATEGORIES: RetentionCategory[] = [
  {
    category: 'EMAIL_OUTBOX',
    description:
      'Delivered or failed email records (message bodies are already erased after sending)',
    action: 'PURGE',
    defaultDays: 90,
    legalBasis: BASIS_OPERATIONAL,
    table: 'email_outbox',
    where: (c) =>
      sql`status IN ('SENT', 'FAILED') AND created_at < ${c} AND NOT ${userOnHold(sql`email_outbox.user_id`)}`,
  },
  {
    category: 'SMS_OUTBOX',
    description: 'Delivered or failed SMS records (message texts are already erased after sending)',
    action: 'PURGE',
    defaultDays: 90,
    legalBasis: BASIS_OPERATIONAL,
    table: 'sms_outbox',
    where: (c) =>
      sql`status IN ('SENT', 'FAILED') AND created_at < ${c} AND NOT ${userOnHold(sql`sms_outbox.user_id`)}`,
  },
  {
    category: 'NOTIFICATIONS_READ',
    description: 'In-app notifications that were read',
    action: 'PURGE',
    defaultDays: 365,
    legalBasis: BASIS_OPERATIONAL,
    table: 'notifications',
    where: (c) =>
      sql`read_at IS NOT NULL AND read_at < ${c} AND NOT ${userOnHold(sql`notifications.user_id`)}`,
  },
  {
    category: 'REFRESH_TOKENS',
    description: 'Expired sign-in sessions',
    action: 'PURGE',
    defaultDays: 30,
    legalBasis: BASIS_OPERATIONAL,
    table: 'refresh_tokens',
    where: (c) => sql`expires_at < ${c} AND NOT ${userOnHold(sql`refresh_tokens.user_id`)}`,
  },
  {
    category: 'AUTH_CHALLENGES',
    description: 'Expired passkey challenges',
    action: 'PURGE',
    defaultDays: 1,
    legalBasis: BASIS_OPERATIONAL,
    table: 'auth_challenges',
    where: (c) => sql`expires_at < ${c}`,
  },
  {
    category: 'PHONE_VERIFICATIONS',
    description: 'Mobile number verification codes',
    action: 'PURGE',
    defaultDays: 30,
    legalBasis: BASIS_OPERATIONAL,
    table: 'phone_verifications',
    where: (c) => sql`created_at < ${c}`,
  },
  {
    category: 'KNOWN_DEVICES',
    description: 'Devices not used to sign in for a long time',
    action: 'PURGE',
    defaultDays: 730,
    legalBasis: BASIS_OPERATIONAL,
    table: 'known_devices',
    where: (c) => sql`last_seen_at < ${c} AND NOT ${userOnHold(sql`known_devices.user_id`)}`,
  },
  {
    category: 'VIDEO_SESSIONS',
    description: 'Technical records of ended video visits (the appointment and audit trail remain)',
    action: 'PURGE',
    defaultDays: 365,
    legalBasis: BASIS_OPERATIONAL,
    table: 'video_sessions',
    where: (c) => sql`status = 'ENDED' AND created_at < ${c} AND NOT EXISTS (
      SELECT 1 FROM appointments va WHERE va.id = video_sessions.appointment_id
        AND ${patientOnHold(sql`va.patient_id`)})`,
  },
  {
    category: 'INTEGRATION_RAW_MESSAGES',
    description:
      'Raw laboratory messages (the filed results remain; messages held for review are kept)',
    action: 'ANONYMISE',
    defaultDays: 730,
    legalBasis:
      'Data minimisation (Law No. 06/L-082, art. 4): the original message is no longer needed once its results are filed and reviewed.',
    table: 'integration_messages',
    set: sql`raw_sealed = NULL`,
    where: (c) => sql`raw_sealed IS NOT NULL AND status <> 'NEEDS_REVIEW' AND received_at < ${c}
      AND (patient_id IS NULL OR NOT ${patientOnHold(sql`integration_messages.patient_id`)})`,
  },
];

export const categoryByName = (name: string) =>
  RETENTION_CATEGORIES.find((c) => c.category === name);

/** Inserts missing policies with their defaults (idempotent; never overwrites Ministry edits). */
export async function ensureRetentionPolicies() {
  await db
    .insert(retentionPolicies)
    .values(
      RETENTION_CATEGORIES.map((c) => ({
        category: c.category,
        retainDays: c.defaultDays,
        action: c.action,
        legalBasis: c.legalBasis,
      })),
    )
    .onConflictDoNothing();
}

export interface RetentionRunResult {
  dryRun: boolean;
  ranAt: string;
  categories: { category: string; action: RetentionAction; retainDays: number; count: number }[];
  total: number;
}

/** Runs every active policy (or, with dryRun, only counts what would be affected). */
export async function runRetentionOnce(
  now = new Date(),
  opts: {
    dryRun?: boolean;
    actor?: Pick<AuthContext, 'userId' | 'role' | 'facilityId'> | null;
  } = {},
): Promise<RetentionRunResult> {
  await ensureRetentionPolicies();
  const policies = await db.select().from(retentionPolicies);
  const out: RetentionRunResult['categories'] = [];
  for (const p of policies) {
    const cat = categoryByName(p.category);
    if (!cat || !p.isActive) continue;
    const cutoff = new Date(now.getTime() - p.retainDays * 86_400_000);
    const table = sql.identifier(cat.table);
    let count: number;
    if (opts.dryRun) {
      const r = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${table} WHERE ${cat.where(cutoff)}`,
      );
      count = r.rows[0]?.n ?? 0;
    } else {
      const r =
        cat.action === 'ANONYMISE' && cat.set
          ? await db.execute(sql`UPDATE ${table} SET ${cat.set} WHERE ${cat.where(cutoff)}`)
          : await db.execute(sql`DELETE FROM ${table} WHERE ${cat.where(cutoff)}`);
      count = r.rowCount ?? 0;
      await db
        .update(retentionPolicies)
        .set({ lastRunAt: now, lastRunCount: count })
        .where(eq(retentionPolicies.id, p.id));
    }
    out.push({ category: p.category, action: cat.action, retainDays: p.retainDays, count });
  }
  const total = out.reduce((a, c) => a + c.count, 0);
  if (!opts.dryRun) {
    await audit({
      action: AuditAction.RETENTION_RUN,
      actor: opts.actor ?? null,
      resourceType: 'retention',
      metadata: { counts: Object.fromEntries(out.map((c) => [c.category, c.count])), total },
    });
  }
  return { dryRun: Boolean(opts.dryRun), ranAt: now.toISOString(), categories: out, total };
}

/* ------------------------------------------------------------------ nightly worker */

const RUN_HOUR_LOCAL = 2; // 02:00–02:59 Kosovo time
let timer: ReturnType<typeof setInterval> | null = null;
let lastRunDay: string | null = null;

const localParts = (d: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
};

/** Checks every 15 minutes and runs once per night between 02:00 and 03:00 local time. */
export function startRetentionWorker() {
  if (isTest || timer) return;
  timer = setInterval(() => {
    const { day, hour } = localParts(new Date());
    if (hour !== RUN_HOUR_LOCAL || lastRunDay === day) return;
    lastRunDay = day;
    runRetentionOnce()
      .then((r) => logger.info({ total: r.total }, 'Retention run completed'))
      .catch((err: unknown) => logger.error({ err }, 'Retention run failed'));
  }, 15 * 60_000);
  timer.unref();
}

export function stopRetentionWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
