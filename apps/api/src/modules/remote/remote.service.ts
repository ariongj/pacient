import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import { careAssignments, homeReadings, monitoringPlans, users } from '../../db/schema.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import {
  DEFAULT_THRESHOLDS,
  evaluateReading,
  planThresholds,
  type FlagReason,
  type ReadingKind,
  type Thresholds,
} from './definitions.js';

const DAY = 86_400_000;

/**
 * The reasons a reading was flagged are kept with its values under this key (the table has no
 * column for them), so the review list shows why it was flagged even if the limits change later.
 */
export const REASONS_KEY = '_flags';

export async function activePlan(patientId: string, executor: Executor = db) {
  const [plan] = await executor
    .select()
    .from(monitoringPlans)
    .where(and(eq(monitoringPlans.patientId, patientId), eq(monitoringPlans.status, 'ACTIVE')));
  return plan ?? null;
}

/** Weights recorded in the 72 hours before a measurement (for the 3-day weight-gain warning). */
async function previousWeights(patientId: string, measuredAt: Date, executor: Executor) {
  const rows = await executor
    .select({ values: homeReadings.values })
    .from(homeReadings)
    .where(
      and(
        eq(homeReadings.patientId, patientId),
        eq(homeReadings.kind, 'WEIGHT'),
        gte(homeReadings.measuredAt, new Date(measuredAt.getTime() - 3 * DAY)),
        lt(homeReadings.measuredAt, measuredAt),
      ),
    );
  return rows
    .map((r) => (r.values as { value?: unknown }).value)
    .filter((v): v is number => typeof v === 'number');
}

/** Splits stored values from the stored flag reasons. */
export function presentValues(values: Record<string, unknown>) {
  const { [REASONS_KEY]: reasons, ...rest } = values;
  return { values: rest, reasons: (Array.isArray(reasons) ? reasons : []) as FlagReason[] };
}

export interface SubmitInput {
  kind: ReadingKind;
  values: Record<string, unknown>;
  measuredAt: Date;
  note?: string | null;
}

/**
 * Stores a home reading and flags it against the patient's plan. Kinds outside the plan (or without
 * any plan) are only flagged when clearly urgent by the default limits. URGENT readings notify the
 * care team (and the doctor who enrolled the patient) at once; OUT_OF_RANGE readings wait for the
 * review list and the daily digest.
 */
export async function submitReading(
  ctx: AuthContext,
  patientId: string,
  input: SubmitInput,
  meta: RequestMeta,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const plan = await activePlan(patientId, tx);
    const planned = plan ? plan.kinds.includes(input.kind) : false;
    const limits: Thresholds = planned
      ? planThresholds(plan!.kinds, plan!.thresholds)
      : { ...DEFAULT_THRESHOLDS };
    const evaluation = evaluateReading(input.kind, input.values, limits, {
      urgentOnly: !planned,
      previousWeights:
        input.kind === 'WEIGHT' ? await previousWeights(patientId, input.measuredAt, tx) : [],
    });
    const [row] = await tx
      .insert(homeReadings)
      .values({
        patientId,
        planId: plan?.id ?? null,
        kind: input.kind,
        values: { ...input.values, [REASONS_KEY]: evaluation.reasons },
        measuredAt: input.measuredAt,
        source: 'PORTAL',
        enteredByUserId: ctx.userId,
        note: input.note ?? null,
        flag: evaluation.flag,
        createdAt: now,
      })
      .returning();
    await audit(
      {
        action: AuditAction.READING_SUBMITTED,
        actor: ctx,
        resourceType: 'home_reading',
        resourceId: row!.id,
        patientId,
        meta,
        metadata: { kind: input.kind, flag: evaluation.flag, planned },
      },
      tx,
    );
    if (evaluation.flag === 'URGENT') {
      const team = await tx
        .select({ id: careAssignments.doctorId })
        .from(careAssignments)
        .innerJoin(users, eq(users.id, careAssignments.doctorId))
        .where(
          and(
            eq(careAssignments.patientId, patientId),
            isNull(careAssignments.endedAt),
            eq(users.isActive, true),
            inArray(users.role, ['DOCTOR', 'NURSE']),
          ),
        );
      await notifyUsers(
        [...team.map((m) => m.id), plan?.enrolledById],
        {
          type: 'remote_urgent',
          // No name or value in the title: it may be shown on a lock screen or in an email subject.
          title: 'Urgent home reading – please contact your patient today',
          link: `/remote-monitoring?reading=${row!.id}`,
          important: true,
        },
        tx,
      );
    }
    return { reading: row!, evaluation, planned };
  });
}

/* ------------------------------------------------------------------------- daily digest -- */

const DIGEST_TYPE = 'remote_digest';

/** Calendar day in Kosovo (the digest is once per doctor per local day). */
export function kosovoDay(at: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/**
 * One notification per doctor per day with the number of OUT_OF_RANGE readings of patients in their
 * care that nobody has reviewed yet (no names or values). Safe on several instances: each doctor is
 * handled under a transaction-scoped advisory lock and the day's notification is checked first.
 */
export async function runRemoteDigestsOnce(now = new Date()): Promise<number> {
  const pending = await db.execute<{ doctor_id: string; n: number }>(sql`
    SELECT ca.doctor_id, count(DISTINCT r.id)::int AS n
    FROM home_readings r
    JOIN care_assignments ca ON ca.patient_id = r.patient_id AND ca.ended_at IS NULL
    JOIN users u ON u.id = ca.doctor_id AND u.role = 'DOCTOR' AND u.is_active
    JOIN patients p ON p.id = r.patient_id AND p.merged_into_id IS NULL AND p.deceased_at IS NULL
    WHERE r.flag = 'OUT_OF_RANGE' AND r.reviewed_at IS NULL
      AND r.created_at >= ${new Date(now.getTime() - 14 * DAY)}
    GROUP BY ca.doctor_id`);
  const day = kosovoDay(now);
  const link = `/remote-monitoring?digest=${day}`;
  let sent = 0;
  for (const row of pending.rows) {
    if (!row.n) continue;
    const delivered = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`remote_digest:${row.doctor_id}`}))`,
      );
      const already = await tx.execute(sql`
        SELECT 1 FROM notifications
        WHERE user_id = ${row.doctor_id} AND type = ${DIGEST_TYPE} AND link = ${link} LIMIT 1`);
      if (already.rows.length) return false;
      await notifyUsers(
        [row.doctor_id],
        {
          type: DIGEST_TYPE,
          title: '{count} home readings outside the limits are waiting for your review',
          vars: { count: row.n },
          link,
        },
        tx,
      );
      return true;
    });
    if (delivered) sent++;
  }
  return sent;
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

function runSafely() {
  runRemoteDigestsOnce().then(
    (n) => n && logger.info({ digests: n }, 'Remote monitoring digests sent'),
    (err: unknown) => logger.error({ err }, 'Remote monitoring worker failed'),
  );
}

/**
 * Hourly (first run six minutes after start); each doctor gets at most one digest per local day,
 * so the first run of the day after readings arrive sends it. Not started in tests.
 */
export function startRemoteWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 6 * 60_000);
  first.unref();
  timer = setInterval(runSafely, 60 * 60_000);
  timer.unref();
}

export function stopRemoteWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}

/** Readings of a patient, newest first (for the chart and the portal). */
export async function readingsOf(patientId: string, days = 90, executor: Executor = db) {
  const rows = await executor
    .select({
      id: homeReadings.id,
      kind: homeReadings.kind,
      values: homeReadings.values,
      measuredAt: homeReadings.measuredAt,
      source: homeReadings.source,
      note: homeReadings.note,
      flag: homeReadings.flag,
      reviewedAt: homeReadings.reviewedAt,
      reviewNote: homeReadings.reviewNote,
      reviewedBy: users.fullName,
      createdAt: homeReadings.createdAt,
    })
    .from(homeReadings)
    .leftJoin(users, eq(users.id, homeReadings.reviewedById))
    .where(
      and(
        eq(homeReadings.patientId, patientId),
        gte(homeReadings.measuredAt, new Date(Date.now() - days * DAY)),
      ),
    )
    .orderBy(desc(homeReadings.measuredAt))
    .limit(1000);
  return rows.map((r) => ({ ...r, ...presentValues(r.values) }));
}
