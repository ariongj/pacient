import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  admissions,
  beds,
  careUnits,
  earlyWarningScores,
  patients,
  unitStaff,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { publish } from '../../lib/events.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { activeCoverDoctorsFor } from '../cover/cover.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import {
  hasNewsParameters,
  RISK_RANK,
  scoreNews2,
  type News2Result,
  type News2Risk,
  type Spo2Scale,
} from './news2.js';
import { ageInMonths, scorePews, type PewsResult } from './pews.js';
import { promptSepsisScreen } from '../sepsis/sepsis.service.js';

/** NEWS2 for adults, PEWS for children under 18 at the time of the observation. */
export type EarlyWarningScale = 'NEWS2' | 'PEWS';

/** How far back the worker looks for unscored vital signs. */
const SCAN_WINDOW_DAYS = 7;
/** A still-elevated, unacknowledged score is escalated again after this long. */
export const REESCALATE_AFTER_MS = 60 * 60_000;

type ScoreRow = typeof earlyWarningScores.$inferSelect;

/** SpO2 scale in use for a patient: carried forward on the latest NEWS2 score (default scale 1). */
export async function spo2ScaleFor(patientId: string, executor: Executor = db): Promise<Spo2Scale> {
  const [latest] = await executor
    .select({ components: earlyWarningScores.components })
    .from(earlyWarningScores)
    .where(and(eq(earlyWarningScores.patientId, patientId), eq(earlyWarningScores.scale, 'NEWS2')))
    .orderBy(desc(earlyWarningScores.computedAt))
    .limit(1);
  return (latest?.components as { spo2Scale?: number } | undefined)?.spo2Scale === 2 ? 2 : 1;
}

export function componentsOf(
  result: News2Result | PewsResult,
  extra: Record<string, unknown> = {},
) {
  if ('ageBand' in result) {
    return {
      ...result.points,
      ...result.extraPoints,
      scale: 'PEWS',
      singleThree: result.singleThree,
      missing: result.missing,
      ageBand: result.ageBand,
      ageMonths: result.ageMonths,
      notRecorded: result.notRecorded,
      ...extra,
    };
  }
  return {
    ...result.points,
    scale: 'NEWS2',
    singleThree: result.singleThree,
    missing: result.missing,
    spo2Scale: result.spo2Scale,
    ...extra,
  };
}

/** Pregnancy keeps NEWS2: a maternity score (MEWS) is out of scope. */
function resultFor(
  v: typeof vitalSigns.$inferSelect,
  scale: Spo2Scale,
  dateOfBirth: string | null,
): { scale: EarlyWarningScale; result: News2Result | PewsResult } {
  const input = {
    respiratoryRate: v.respiratoryRate,
    oxygenSaturation: v.oxygenSaturation,
    onSupplementalOxygen: v.onSupplementalOxygen,
    systolic: v.systolic,
    heartRate: v.heartRate,
    consciousness: v.consciousness,
    temperatureC: v.temperatureC,
    capillaryRefillSeconds: v.capillaryRefillSeconds,
    respiratoryEffort: v.respiratoryEffort,
  };
  if (dateOfBirth) {
    const months = ageInMonths(dateOfBirth, v.recordedAt);
    if (months < 18 * 12) return { scale: 'PEWS', result: scorePews(input, months) };
  }
  return { scale: 'NEWS2', result: scoreNews2(input, scale) };
}

async function dateOfBirthOf(patientId: string) {
  const [p] = await db
    .select({ dateOfBirth: patients.dateOfBirth })
    .from(patients)
    .where(eq(patients.id, patientId));
  return p?.dateOfBirth ?? null;
}

/**
 * Scores one set of vital signs (idempotent: the unique vital_sign_id makes a second call a
 * no-op) and escalates when the patient is an inpatient. Returns the stored score, or null when the
 * set has no NEWS2 parameter.
 */
export async function scoreVitalSign(vitalSignId: string, now = new Date()) {
  const [v] = await db.select().from(vitalSigns).where(eq(vitalSigns.id, vitalSignId));
  if (!v || !hasNewsParameters(v)) return null;
  const spo2 = await spo2ScaleFor(v.patientId);
  const { scale, result } = resultFor(v, spo2, await dateOfBirthOf(v.patientId));
  const [admission] = await db
    .select({ id: admissions.id })
    .from(admissions)
    .where(and(eq(admissions.patientId, v.patientId), eq(admissions.status, 'ADMITTED')))
    .limit(1);
  const [inserted] = await db
    .insert(earlyWarningScores)
    .values({
      patientId: v.patientId,
      vitalSignId: v.id,
      admissionId: admission?.id ?? null,
      scale,
      score: result.score,
      risk: result.risk,
      components: componentsOf(result),
      complete: result.complete,
      computedAt: v.recordedAt,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    const [existing] = await db
      .select()
      .from(earlyWarningScores)
      .where(eq(earlyWarningScores.vitalSignId, vitalSignId));
    return existing ?? null;
  }
  if (inserted.admissionId) await maybeEscalateNew(inserted, now);
  // A raised score may prompt a sepsis screen; a failure there never affects scoring.
  await promptSepsisScreen(inserted, now).catch((err: unknown) =>
    logger.error({ err, scoreId: inserted.id }, 'Sepsis prompt failed'),
  );
  return inserted;
}

/** Scores every recent vital-signs row without a score (e.g. recorded by the ED triage). */
export async function scoreNewVitalsOnce(now = new Date()) {
  const since = new Date(now.getTime() - SCAN_WINDOW_DAYS * 86_400_000);
  const rows = await db.execute<{ id: string }>(sql`
    SELECT v.id FROM vital_signs v
    LEFT JOIN early_warning_scores s ON s.vital_sign_id = v.id
    WHERE s.id IS NULL AND v.recorded_at > ${since}
      AND (v.respiratory_rate IS NOT NULL OR v.oxygen_saturation IS NOT NULL
        OR v.on_supplemental_oxygen IS NOT NULL OR v.systolic IS NOT NULL
        OR v.heart_rate IS NOT NULL OR v.consciousness IS NOT NULL OR v.temperature_c IS NOT NULL)
    ORDER BY v.recorded_at
    LIMIT 500`);
  let scored = 0;
  for (const r of rows.rows) {
    try {
      if (await scoreVitalSign(r.id, now)) scored++;
    } catch (err) {
      logger.error({ err, vitalSignId: r.id }, 'NEWS2 scoring failed');
    }
  }
  const reescalated = await reescalateOnce(now);
  return { scored, reescalated };
}

interface EscalationContext {
  admissionId: string;
  patientId: string;
  unitId: string;
  unitName: string;
  bedLabel: string | null;
  attendingDoctorId: string;
}

async function contextFor(admissionId: string): Promise<EscalationContext | null> {
  const [row] = await db
    .select({
      admissionId: admissions.id,
      patientId: admissions.patientId,
      unitId: admissions.unitId,
      unitName: careUnits.name,
      bedLabel: beds.label,
      attendingDoctorId: admissions.attendingDoctorId,
      status: admissions.status,
    })
    .from(admissions)
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .leftJoin(beds, eq(beds.id, admissions.bedId))
    .where(eq(admissions.id, admissionId));
  if (!row || row.status !== 'ADMITTED') return null;
  return row;
}

async function unitStaffIds(unitId: string, role: 'NURSE' | 'DOCTOR') {
  const rows = await db
    .select({ id: users.id })
    .from(unitStaff)
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(and(eq(unitStaff.unitId, unitId), eq(users.role, role), eq(users.isActive, true)));
  return rows.map((r) => r.id);
}

/** Who is told about a score, by risk (NEWS2 clinical response). */
export async function recipientsFor(risk: News2Risk, c: EscalationContext): Promise<string[]> {
  const nurses = await unitStaffIds(c.unitId, 'NURSE');
  if (risk === 'LOW_MEDIUM') return nurses;
  if (risk === 'MEDIUM') return [c.attendingDoctorId, ...nurses];
  if (risk === 'HIGH') {
    const doctors = await unitStaffIds(c.unitId, 'DOCTOR');
    const cover = await activeCoverDoctorsFor([c.attendingDoctorId]);
    return [c.attendingDoctorId, ...doctors, ...cover.map((x) => x.coverDoctorId)];
  }
  return [];
}

const PEWS_TITLES: Record<Exclude<News2Risk, 'LOW'>, { bed: string; noBed: string }> = {
  LOW_MEDIUM: {
    bed: 'PEWS: one observation scored 3 – {unit}, bed {bed}',
    noBed: 'PEWS: one observation scored 3 – {unit}',
  },
  MEDIUM: {
    bed: 'PEWS {score}: urgent review needed – {unit}, bed {bed}',
    noBed: 'PEWS {score}: urgent review needed – {unit}',
  },
  HIGH: {
    bed: 'PEWS {score}: emergency assessment – {unit}, bed {bed}',
    noBed: 'PEWS {score}: emergency assessment – {unit}',
  },
};

const TITLES: Record<Exclude<News2Risk, 'LOW'>, { bed: string; noBed: string }> = {
  LOW_MEDIUM: {
    bed: 'NEWS2: one observation scored 3 – {unit}, bed {bed}',
    noBed: 'NEWS2: one observation scored 3 – {unit}',
  },
  MEDIUM: {
    bed: 'NEWS2 {score}: urgent review needed – {unit}, bed {bed}',
    noBed: 'NEWS2 {score}: urgent review needed – {unit}',
  },
  HIGH: {
    bed: 'NEWS2 {score}: emergency assessment – {unit}, bed {bed}',
    noBed: 'NEWS2 {score}: emergency assessment – {unit}',
  },
};

/**
 * Sends the escalation for a score. Notification titles name the ward and bed, not the patient:
 * they may also go out by email or SMS, which must never carry identifiable health information.
 */
async function sendEscalation(score: ScoreRow, c: EscalationContext, kind: 'initial' | 'repeat') {
  if (score.risk === 'LOW') return 0;
  const risk = score.risk as Exclude<News2Risk, 'LOW'>;
  const recipients = [...new Set(await recipientsFor(risk, c))];
  if (!recipients.length) return 0;
  const titles = score.scale === 'PEWS' ? PEWS_TITLES : TITLES;
  const template = c.bedLabel ? titles[risk].bed : titles[risk].noBed;
  await notifyUsers(recipients, {
    type: 'news.escalation',
    title: template,
    vars: { score: score.score, unit: c.unitName, bed: c.bedLabel },
    wrap: kind === 'repeat' ? [{ text: '{title} (still not acknowledged)' }] : undefined,
    link: '/wards/early-warning',
    important: risk === 'HIGH',
  });
  await publish(recipients, { type: 'news.alert', ref: c.unitId });
  await audit({
    action: AuditAction.EARLY_WARNING_ESCALATED,
    actor: null,
    resourceType: 'early_warning_score',
    resourceId: score.id,
    patientId: c.patientId,
    metadata: { scale: score.scale, score: score.score, risk, kind, recipients: recipients.length },
  });
  return recipients.length;
}

/**
 * Escalates a newly stored score when the risk is elevated and either nothing was escalated for
 * this stay yet, the risk is higher than at the last escalation, or the patient had improved since
 * (a new episode). Repeated identical scores are left to the hourly re-escalation.
 */
async function maybeEscalateNew(score: ScoreRow, now: Date) {
  if (score.risk === 'LOW' || !score.admissionId) return;
  const c = await contextFor(score.admissionId);
  if (!c) return;
  const [lastEscalated] = await db
    .select()
    .from(earlyWarningScores)
    .where(
      and(
        eq(earlyWarningScores.admissionId, score.admissionId),
        isNotNull(earlyWarningScores.escalatedAt),
      ),
    )
    .orderBy(desc(earlyWarningScores.escalatedAt))
    .limit(1);
  const [previous] = await db
    .select({ risk: earlyWarningScores.risk })
    .from(earlyWarningScores)
    .where(
      and(
        eq(earlyWarningScores.admissionId, score.admissionId),
        sql`${earlyWarningScores.computedAt} < ${score.computedAt}`,
      ),
    )
    .orderBy(desc(earlyWarningScores.computedAt))
    .limit(1);
  const rank = RISK_RANK[score.risk as News2Risk];
  const shouldEscalate =
    !lastEscalated ||
    rank > RISK_RANK[lastEscalated.risk as News2Risk] ||
    (previous && RISK_RANK[previous.risk as News2Risk] < rank);
  if (!shouldEscalate) return;
  // Claim the escalation so parallel workers never notify twice.
  const [claimed] = await db
    .update(earlyWarningScores)
    .set({ escalatedAt: now })
    .where(and(eq(earlyWarningScores.id, score.id), isNull(earlyWarningScores.escalatedAt)))
    .returning();
  if (claimed) await sendEscalation(claimed, c, 'initial');
}

/**
 * Hourly re-escalation: the latest score of a current inpatient is still MEDIUM or HIGH, nobody has
 * acknowledged it, and the last escalation for the stay is more than an hour old.
 */
export async function reescalateOnce(now = new Date()) {
  const cutoff = new Date(now.getTime() - REESCALATE_AFTER_MS);
  const latest = await db.execute<{ id: string; admission_id: string }>(sql`
    SELECT DISTINCT ON (s.admission_id) s.id, s.admission_id
    FROM early_warning_scores s
    JOIN admissions a ON a.id = s.admission_id AND a.status = 'ADMITTED'
    ORDER BY s.admission_id, s.computed_at DESC`);
  let count = 0;
  for (const row of latest.rows) {
    const [s] = await db.select().from(earlyWarningScores).where(eq(earlyWarningScores.id, row.id));
    if (!s || (s.risk !== 'MEDIUM' && s.risk !== 'HIGH') || s.acknowledgedAt) continue;
    const [lastEsc] = await db
      .select({ at: sql<Date>`max(${earlyWarningScores.escalatedAt})` })
      .from(earlyWarningScores)
      .where(eq(earlyWarningScores.admissionId, row.admission_id));
    const lastAt = lastEsc?.at ? new Date(lastEsc.at) : null;
    if (lastAt && lastAt > cutoff) continue;
    const [claimed] = await db
      .update(earlyWarningScores)
      .set({ escalatedAt: now })
      .where(
        and(
          eq(earlyWarningScores.id, s.id),
          isNull(earlyWarningScores.acknowledgedAt),
          sql`(${earlyWarningScores.escalatedAt} IS NULL OR ${earlyWarningScores.escalatedAt} <= ${cutoff})`,
        ),
      )
      .returning();
    if (!claimed) continue;
    const c = await contextFor(row.admission_id);
    if (c && (await sendEscalation(claimed, c, lastAt ? 'repeat' : 'initial'))) count++;
  }
  return count;
}

/** Acknowledges a score and every earlier unacknowledged score of the same stay. */
export async function acknowledgeScore(score: ScoreRow, userId: string, now = new Date()) {
  const scope = score.admissionId
    ? eq(earlyWarningScores.admissionId, score.admissionId)
    : eq(earlyWarningScores.patientId, score.patientId);
  return db
    .update(earlyWarningScores)
    .set({ acknowledgedAt: now, acknowledgedById: userId })
    .where(
      and(
        scope,
        isNull(earlyWarningScores.acknowledgedAt),
        lte(earlyWarningScores.computedAt, score.computedAt),
      ),
    )
    .returning({ id: earlyWarningScores.id });
}

/** Re-scores the latest observations of a patient with a different SpO2 scale. */
export async function setSpo2Scale(patientId: string, scale: Spo2Scale, setById: string) {
  const [latest] = await db
    .select()
    .from(earlyWarningScores)
    .where(eq(earlyWarningScores.patientId, patientId))
    .orderBy(desc(earlyWarningScores.computedAt))
    .limit(1);
  if (!latest) return null;
  // The SpO2 scale is a NEWS2 concept; children are scored with PEWS.
  if (latest.scale === 'PEWS') return latest;
  const [v] = await db.select().from(vitalSigns).where(eq(vitalSigns.id, latest.vitalSignId));
  if (!v) return null;
  const result = scoreNews2(
    {
      respiratoryRate: v.respiratoryRate,
      oxygenSaturation: v.oxygenSaturation,
      onSupplementalOxygen: v.onSupplementalOxygen,
      systolic: v.systolic,
      heartRate: v.heartRate,
      consciousness: v.consciousness,
      temperatureC: v.temperatureC,
    },
    scale,
  );
  const [updated] = await db
    .update(earlyWarningScores)
    .set({
      score: result.score,
      risk: result.risk,
      complete: result.complete,
      components: componentsOf(result, { spo2ScaleSetBy: setById }),
    })
    .where(eq(earlyWarningScores.id, latest.id))
    .returning();
  return updated ?? null;
}

/** Latest scores of the given admissions (up to 3 each, newest first). */
export async function recentScoresByAdmission(admissionIds: string[]) {
  if (!admissionIds.length) return new Map<string, ScoreRow[]>();
  const rows = await db
    .select()
    .from(earlyWarningScores)
    .where(inArray(earlyWarningScores.admissionId, admissionIds))
    .orderBy(desc(earlyWarningScores.computedAt));
  const map = new Map<string, ScoreRow[]>();
  for (const r of rows) {
    const list = map.get(r.admissionId!) ?? [];
    if (list.length < 3) list.push(r);
    map.set(r.admissionId!, list);
  }
  return map;
}

let timer: ReturnType<typeof setInterval> | undefined;

/** Scores new vital signs and re-escalates every minute (not in tests). */
export function startNewsWorker() {
  if (isTest || timer) return;
  timer = setInterval(() => {
    scoreNewVitalsOnce().catch((err: unknown) => logger.error({ err }, 'NEWS2 worker error'));
  }, 60_000);
  timer.unref();
}

export function stopNewsWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
