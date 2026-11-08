import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { isTest, sepsisScreeningEnabled } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  admissions,
  beds,
  careUnits,
  earlyWarningScores,
  edVisits,
  sepsisScreens,
  unitStaff,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/**
 * Sepsis screening and the Sepsis Six bundle, following the UK Sepsis Trust screening tools and
 * NICE NG51. ILLUSTRATIVE: the prompt thresholds, red and amber flags and the one-hour bundle must
 * be replaced by the deploying organisation's adopted sepsis protocol before clinical use.
 *
 * - A raised early warning score (NEWS2 ≥ 5 or any single parameter scoring 3; PEWS MEDIUM or
 *   HIGH for children) of an inpatient or emergency patient prompts a screen (PENDING).
 * - The screen asks whether this could be an infection and which flags are present. Infection +
 *   any red flag → RED_FLAG and the Sepsis Six clock starts; infection + amber flags only →
 *   SEPSIS_SUSPECTED (senior review; the clock starts with the first bundle step); otherwise
 *   NOT_SEPSIS.
 * - Sepsis Six within one hour: oxygen, blood cultures, IV antibiotics, IV fluids, lactate, urine
 *   output. A bundle still incomplete after 60 minutes is escalated once to the doctors.
 */

type ScreenRow = typeof sepsisScreens.$inferSelect;
type ScoreRow = typeof earlyWarningScores.$inferSelect;

export const NEWS2_PROMPT_SCORE = 5;
/** At most one prompt per patient in this window (and never while one is still pending). */
export const PROMPT_DEDUPE_MS = 6 * 60 * 60_000;
export const BUNDLE_TARGET_MINUTES = 60;
/** A prompt nobody has answered is escalated after this long. */
export const PENDING_ESCALATE_MINUTES = 60;
/** Screens are "open" on the board for this long after they were raised. */
export const OPEN_WINDOW_HOURS = 24;

export const SEPSIS_STEPS = [
  'oxygen',
  'cultures',
  'antibiotics',
  'fluids',
  'lactate',
  'urineOutput',
] as const;
export type SepsisStep = (typeof SEPSIS_STEPS)[number];

/** Red flags (high risk of severe illness or death from sepsis). */
export const RED_FLAGS = [
  'SYSTOLIC_LE_90',
  'HR_GE_130',
  'RR_GE_25',
  'NEEDS_OXYGEN',
  'NEW_CONFUSION',
  'NON_BLANCHING_RASH',
  'NO_URINE_18H',
  'LACTATE_GE_2',
  'RECENT_CHEMOTHERAPY',
] as const;
/** Amber flags (moderate to high risk). */
export const AMBER_FLAGS = [
  'SYSTOLIC_91_100',
  'HR_91_130',
  'RR_21_24',
  'TEMPERATURE_LT_36',
  'NO_URINE_12_18H',
  'ALTERED_BEHAVIOUR',
  'IMMUNOSUPPRESSED',
  'RECENT_SURGERY_OR_TRAUMA',
  'WOUND_INFECTION_SIGNS',
  'RIGORS',
] as const;
export type SepsisFlag = (typeof RED_FLAGS)[number] | (typeof AMBER_FLAGS)[number];
export const ALL_FLAGS: readonly SepsisFlag[] = [...RED_FLAGS, ...AMBER_FLAGS];

export const SUSPECTED_SOURCES = [
  'RESPIRATORY',
  'URINARY',
  'ABDOMINAL',
  'SKIN_SOFT_TISSUE',
  'LINE_OR_DEVICE',
  'SURGICAL_SITE',
  'CENTRAL_NERVOUS_SYSTEM',
  'UNKNOWN',
] as const;

export type ScreenOutcome = 'NOT_SEPSIS' | 'SEPSIS_SUSPECTED' | 'RED_FLAG';

/** The outcome follows from the answers – never taken from the client. */
export function outcomeFor(suspectedInfection: boolean, flags: readonly string[]): ScreenOutcome {
  if (!suspectedInfection) return 'NOT_SEPSIS';
  if (flags.some((f) => (RED_FLAGS as readonly string[]).includes(f))) return 'RED_FLAG';
  if (flags.some((f) => (AMBER_FLAGS as readonly string[]).includes(f))) return 'SEPSIS_SUSPECTED';
  return 'NOT_SEPSIS';
}

/** Does an early warning score call for a sepsis screen? */
export function scorePromptsScreen(score: {
  scale: string;
  score: number;
  risk: string;
  components: unknown;
}): boolean {
  if (score.scale === 'PEWS') return score.risk === 'MEDIUM' || score.risk === 'HIGH';
  const singleThree = Boolean((score.components as { singleThree?: boolean } | null)?.singleThree);
  return score.score >= NEWS2_PROMPT_SCORE || singleThree;
}

/** Flags suggested from the latest observations (the clinician confirms them). */
export function suggestedFlags(v: {
  systolic: number | null;
  heartRate: number | null;
  respiratoryRate: number | null;
  oxygenSaturation: number | null;
  onSupplementalOxygen: boolean | null;
  consciousness: string | null;
  temperatureC: string | number | null;
}): SepsisFlag[] {
  const flags: SepsisFlag[] = [];
  if (v.systolic != null) {
    if (v.systolic <= 90) flags.push('SYSTOLIC_LE_90');
    else if (v.systolic <= 100) flags.push('SYSTOLIC_91_100');
  }
  if (v.heartRate != null) {
    if (v.heartRate >= 130) flags.push('HR_GE_130');
    else if (v.heartRate >= 91) flags.push('HR_91_130');
  }
  if (v.respiratoryRate != null) {
    if (v.respiratoryRate >= 25) flags.push('RR_GE_25');
    else if (v.respiratoryRate >= 21) flags.push('RR_21_24');
  }
  if (v.onSupplementalOxygen === true) flags.push('NEEDS_OXYGEN');
  if (v.consciousness && v.consciousness !== 'A') flags.push('NEW_CONFUSION');
  if (v.temperatureC != null && Number(v.temperatureC) < 36) flags.push('TEMPERATURE_LT_36');
  return flags;
}

/* --------------------------------------------------------------------- context ------------ */

export interface ScreenContext {
  facilityId: string;
  admissionId: string | null;
  edVisitId: string | null;
  unitId: string;
  unitName: string;
  bedLabel: string | null;
  /** Attending doctor (inpatient) or assigned doctor (emergency). */
  doctorId: string | null;
}

/** Where the patient is now: a current hospital stay, else an open emergency attendance. */
export async function currentContext(
  patientId: string,
  executor: Executor = db,
): Promise<ScreenContext | null> {
  const [stay] = await executor
    .select({
      admissionId: admissions.id,
      facilityId: admissions.facilityId,
      unitId: admissions.unitId,
      unitName: careUnits.name,
      bedLabel: beds.label,
      doctorId: admissions.attendingDoctorId,
    })
    .from(admissions)
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .leftJoin(beds, eq(beds.id, admissions.bedId))
    .where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'ADMITTED')))
    .limit(1);
  if (stay) return { ...stay, edVisitId: null };
  const [visit] = await executor
    .select({
      edVisitId: edVisits.id,
      facilityId: edVisits.facilityId,
      unitId: edVisits.unitId,
      unitName: careUnits.name,
      doctorId: edVisits.assignedDoctorId,
    })
    .from(edVisits)
    .innerJoin(careUnits, eq(careUnits.id, edVisits.unitId))
    .where(
      and(eq(edVisits.patientId, patientId), inArray(edVisits.status, ['WAITING', 'IN_TREATMENT'])),
    )
    .orderBy(desc(edVisits.arrivedAt))
    .limit(1);
  if (visit) return { ...visit, admissionId: null, bedLabel: null };
  return null;
}

async function staffOfUnit(unitId: string, role: 'NURSE' | 'DOCTOR', executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(unitStaff)
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(and(eq(unitStaff.unitId, unitId), eq(users.role, role), eq(users.isActive, true)));
  return rows.map((r) => r.id);
}

/** Context of an existing screen (unit and bed for notification titles). */
async function contextOfScreen(s: ScreenRow): Promise<ScreenContext | null> {
  if (s.admissionId) {
    const [a] = await db
      .select({
        unitId: admissions.unitId,
        unitName: careUnits.name,
        bedLabel: beds.label,
        doctorId: admissions.attendingDoctorId,
      })
      .from(admissions)
      .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
      .leftJoin(beds, eq(beds.id, admissions.bedId))
      .where(eq(admissions.id, s.admissionId));
    if (a) return { ...a, facilityId: s.facilityId, admissionId: s.admissionId, edVisitId: null };
  }
  if (s.edVisitId) {
    const [e] = await db
      .select({
        unitId: edVisits.unitId,
        unitName: careUnits.name,
        doctorId: edVisits.assignedDoctorId,
      })
      .from(edVisits)
      .innerJoin(careUnits, eq(careUnits.id, edVisits.unitId))
      .where(eq(edVisits.id, s.edVisitId));
    if (e)
      return {
        ...e,
        bedLabel: null,
        facilityId: s.facilityId,
        admissionId: null,
        edVisitId: s.edVisitId,
      };
  }
  return null;
}

/* --------------------------------------------------------------------- prompt ------------- */

let failPromptForTests = false;
/** Tests only: make the prompt throw, to prove scoring never depends on it. */
export function setSepsisPromptFailureForTests(fail: boolean) {
  failPromptForTests = fail;
}

/**
 * Called after an early warning score is stored. Creates a PENDING screen when the score calls for
 * one and the patient is an inpatient or in the emergency department, and tells the nurses of the
 * unit and the responsible doctor. Titles name the unit and bed, never the patient.
 */
export async function promptSepsisScreen(score: ScoreRow, now = new Date()) {
  if (failPromptForTests) throw new Error('Sepsis prompt failure (test)');
  if (!sepsisScreeningEnabled) return null;
  if (!scorePromptsScreen(score)) return null;
  const created = await db.transaction(async (tx) => {
    // One prompt at a time per patient, even when several scores arrive together.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'sepsis:' + score.patientId}))`);
    const c = await currentContext(score.patientId, tx);
    if (!c) return null;
    const since = new Date(now.getTime() - PROMPT_DEDUPE_MS);
    const [recent] = await tx
      .select({ id: sepsisScreens.id })
      .from(sepsisScreens)
      .where(
        and(
          eq(sepsisScreens.patientId, score.patientId),
          sql`(${sepsisScreens.status} = 'PENDING' OR ${sepsisScreens.createdAt} > ${since})`,
        ),
      )
      .limit(1);
    if (recent) return null;
    const [row] = await tx
      .insert(sepsisScreens)
      .values({
        patientId: score.patientId,
        facilityId: c.facilityId,
        admissionId: c.admissionId,
        edVisitId: c.edVisitId,
        earlyWarningScoreId: score.id,
        trigger: 'PROMPTED',
        status: 'PENDING',
        createdAt: now,
      })
      .returning();
    const nurses = await staffOfUnit(c.unitId, 'NURSE', tx);
    const doctors = c.doctorId ? [c.doctorId] : await staffOfUnit(c.unitId, 'DOCTOR', tx);
    await notifyUsers(
      [...nurses, ...doctors],
      {
        type: 'sepsis.prompt',
        title: c.bedLabel
          ? 'Sepsis screen needed – {unit}, bed {bed}'
          : 'Sepsis screen needed – {unit}',
        vars: { unit: c.unitName, bed: c.bedLabel },
        link: `/sepsis?screen=${row!.id}`,
        important: true,
      },
      tx,
    );
    await audit(
      {
        action: AuditAction.SEPSIS_SCREENED,
        actor: null,
        resourceType: 'sepsis_screen',
        resourceId: row!.id,
        patientId: score.patientId,
        metadata: { kind: 'prompt', scale: score.scale, score: score.score, risk: score.risk },
      },
      tx,
    );
    return row!;
  });
  return created;
}

/* --------------------------------------------------------------------- bundle -------------- */

export const isStep = (s: string): s is SepsisStep =>
  (SEPSIS_STEPS as readonly string[]).includes(s);

export function stepsDone(bundle: Record<string, string>): SepsisStep[] {
  return SEPSIS_STEPS.filter((s) => Boolean(bundle[s]));
}

/** Minutes from the start of the bundle to the last step (null until complete). */
export function minutesToComplete(s: Pick<ScreenRow, 'bundleStartedAt' | 'bundleCompletedAt'>) {
  if (!s.bundleStartedAt || !s.bundleCompletedAt) return null;
  return Math.round((s.bundleCompletedAt.getTime() - s.bundleStartedAt.getTime()) / 60_000);
}

/** Presentation of a screen (bundle steps with times and who; escalation marker separate). */
export function presentBundle(bundle: Record<string, string>) {
  return SEPSIS_STEPS.map((step) => ({
    step,
    at: bundle[step] ?? null,
    byId: bundle[`${step}By`] ?? null,
  }));
}

/* --------------------------------------------------------------------- worker -------------- */

/**
 * Escalates, once each: a red-flag bundle still incomplete 60 minutes after it started, and a prompt
 * nobody has answered within 60 minutes. The claim is a single conditional UPDATE (the marker
 * `escalatedAt` in the bundle), so several API instances never notify twice.
 */
export async function escalateOverdueOnce(now = new Date()) {
  const bundleCutoff = new Date(now.getTime() - BUNDLE_TARGET_MINUTES * 60_000);
  const pendingCutoff = new Date(now.getTime() - PENDING_ESCALATE_MINUTES * 60_000);
  const oldest = new Date(now.getTime() - OPEN_WINDOW_HOURS * 3_600_000);
  const claimed = await db
    .update(sepsisScreens)
    .set({
      bundle: sql`${sepsisScreens.bundle} || jsonb_build_object('escalatedAt', ${now.toISOString()}::text)`,
    })
    .where(
      and(
        sql`NOT (${sepsisScreens.bundle} ? 'escalatedAt')`,
        gt(sepsisScreens.createdAt, oldest),
        sql`(
          (${sepsisScreens.bundleStartedAt} IS NOT NULL AND ${sepsisScreens.bundleCompletedAt} IS NULL
             AND ${sepsisScreens.bundleStartedAt} <= ${bundleCutoff})
          OR (${sepsisScreens.status} = 'PENDING' AND ${sepsisScreens.createdAt} <= ${pendingCutoff})
        )`,
      ),
    )
    .returning();
  let sent = 0;
  for (const s of claimed) {
    const c = await contextOfScreen(s);
    if (!c) continue;
    const unitDoctors = await staffOfUnit(c.unitId, 'DOCTOR');
    const recipients = [c.doctorId, ...unitDoctors];
    const bundleOverdue = Boolean(s.bundleStartedAt);
    await notifyUsers(recipients, {
      type: 'sepsis.escalation',
      title: bundleOverdue
        ? c.bedLabel
          ? 'Sepsis Six not complete after one hour – {unit}, bed {bed}'
          : 'Sepsis Six not complete after one hour – {unit}'
        : c.bedLabel
          ? 'Sepsis screen not done after one hour – {unit}, bed {bed}'
          : 'Sepsis screen not done after one hour – {unit}',
      vars: { unit: c.unitName, bed: c.bedLabel },
      link: `/sepsis?screen=${s.id}`,
      important: true,
    });
    await audit({
      action: AuditAction.SEPSIS_BUNDLE_UPDATED,
      actor: null,
      resourceType: 'sepsis_screen',
      resourceId: s.id,
      patientId: s.patientId,
      metadata: {
        kind: bundleOverdue ? 'bundle_overdue' : 'screen_overdue',
        recipients: new Set(recipients.filter(Boolean)).size,
      },
    });
    sent++;
  }
  return sent;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

async function runSafely() {
  if (running) return;
  running = true;
  try {
    await escalateOverdueOnce();
  } catch (err) {
    logger.error({ err }, 'Sepsis escalation failed');
  } finally {
    running = false;
  }
}

/** Every minute: escalate overdue bundles and unanswered prompts (never in tests). */
export function startSepsisWorker() {
  if (isTest || timer || !sepsisScreeningEnabled) return;
  timer = setInterval(runSafely, 60_000);
  timer.unref();
}

export function stopSepsisWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Latest observations for pre-filling a screen. */
export async function latestVitals(patientId: string) {
  const [v] = await db
    .select()
    .from(vitalSigns)
    .where(eq(vitalSigns.patientId, patientId))
    .orderBy(desc(vitalSigns.recordedAt))
    .limit(1);
  return v ?? null;
}
