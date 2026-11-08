import { Router } from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { prescriptions, sepsisScreens, users } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { assertClinicalWriteAccess, resolveAndAuditRead, WRITERS } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  ALL_FLAGS,
  BUNDLE_TARGET_MINUTES,
  currentContext,
  latestVitals,
  OPEN_WINDOW_HOURS,
  outcomeFor,
  presentBundle,
  SEPSIS_STEPS,
  stepsDone,
  suggestedFlags,
  SUSPECTED_SOURCES,
  type SepsisFlag,
} from './sepsis.service.js';

/**
 * Sepsis screening and the Sepsis Six bundle (see sepsis.service.ts for the clinical rules). The
 * board and the chart are for the doctors and nurses responsible for the patient; directors see a
 * compliance dashboard without names.
 */
export const sepsisRouter = Router();
sepsisRouter.use(authenticate);

type ScreenRow = typeof sepsisScreens.$inferSelect;

const IdParam = z.object({ id: z.string().uuid() });
const PatientParam = z.object({ patientId: z.string().uuid() });

/** Not more than five minutes in the future (device clocks) and not before the given start. */
const pastTime = z.coerce
  .date()
  .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'The time cannot be in the future');

const ScreenInput = z.object({
  suspectedInfection: z.boolean(),
  suspectedSource: z.enum(SUSPECTED_SOURCES).optional().nullable(),
  flags: z
    .array(z.enum(ALL_FLAGS as unknown as [SepsisFlag, ...SepsisFlag[]]))
    .max(ALL_FLAGS.length)
    .default([])
    .refine((f) => new Set(f).size === f.length, 'Each flag only once'),
  notes: z.string().trim().max(2000).optional().nullable(),
  screenedAt: pastTime.optional(),
});

async function loadScreen(id: string) {
  const [row] = await db.select().from(sepsisScreens).where(eq(sepsisScreens.id, id));
  if (!row) throw notFound('Sepsis screen not found');
  return row;
}

async function namesOf(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.fullName })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function present(s: ScreenRow, names: Map<string, string>, now = new Date()) {
  const open =
    s.status === 'PENDING' ||
    ((s.status === 'RED_FLAG' || s.status === 'SEPSIS_SUSPECTED') && !s.bundleCompletedAt);
  const minutesSinceStart = s.bundleStartedAt
    ? Math.floor((now.getTime() - s.bundleStartedAt.getTime()) / 60_000)
    : null;
  return {
    id: s.id,
    patientId: s.patientId,
    admissionId: s.admissionId,
    edVisitId: s.edVisitId,
    trigger: s.trigger,
    status: s.status,
    suspectedSource: s.suspectedSource,
    flags: s.redFlags,
    screenedAt: s.screenedAt,
    screenedBy: s.screenedById ? (names.get(s.screenedById) ?? null) : null,
    steps: presentBundle(s.bundle).map((p) => ({
      step: p.step,
      at: p.at,
      by: p.byId ? (names.get(p.byId) ?? null) : null,
    })),
    stepsDone: stepsDone(s.bundle).length,
    antibioticPrescriptionId: s.bundle.antibioticsPrescriptionId ?? null,
    bundleStartedAt: s.bundleStartedAt,
    bundleCompletedAt: s.bundleCompletedAt,
    minutesSinceStart,
    overdue:
      Boolean(s.bundleStartedAt) &&
      !s.bundleCompletedAt &&
      (minutesSinceStart ?? 0) >= BUNDLE_TARGET_MINUTES,
    escalatedAt: s.bundle.escalatedAt ?? null,
    seniorReviewAt: s.seniorReviewAt,
    notes: s.notes,
    createdAt: s.createdAt,
    open,
  };
}

function userIdsOf(rows: ScreenRow[]) {
  return rows.flatMap((s) => [
    s.screenedById,
    ...SEPSIS_STEPS.map((step) => s.bundle[`${step}By`]),
  ]);
}

/* ------------------------------------------------------------------ board ----------------- */

const BoardQuery = z.object({
  status: z.enum(['OPEN', 'PENDING', 'RED_FLAG', 'SEPSIS_SUSPECTED']).default('OPEN'),
  unitId: z.string().uuid().optional(),
});

/**
 * Open screens at the caller's facility for the patients the caller is responsible for (staff of
 * the ward or emergency unit, the attending or assigned doctor, the care team): pending prompts and
 * bundles still running. Red flags first.
 */
sepsisRouter.get('/board', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const { status, unitId } = parse(BoardQuery, req.query);
  const oldest = new Date(Date.now() - OPEN_WINDOW_HOURS * 3_600_000);
  const rows = await db.execute<{
    id: string;
    first_name: string;
    last_name: string;
    date_of_birth: string;
    sex: string;
    temporary_identity: string | null;
    unit_id: string | null;
    unit_name: string | null;
    bed_label: string | null;
  }>(sql`
    SELECT s.id, p.first_name, p.last_name, p.date_of_birth, p.sex, p.temporary_identity,
      COALESCE(au.id, eu.id) AS unit_id, COALESCE(au.name, eu.name) AS unit_name, b.label AS bed_label
    FROM sepsis_screens s
    JOIN patients p ON p.id = s.patient_id
    LEFT JOIN admissions a ON a.id = s.admission_id
    LEFT JOIN care_units au ON au.id = a.unit_id
    LEFT JOIN beds b ON b.id = a.bed_id
    LEFT JOIN ed_visits e ON e.id = s.ed_visit_id
    LEFT JOIN care_units eu ON eu.id = e.unit_id
    WHERE s.facility_id = ${ctx.facilityId} AND s.created_at > ${oldest}
      AND (s.status = 'PENDING'
           OR (s.status IN ('RED_FLAG', 'SEPSIS_SUSPECTED') AND s.bundle_completed_at IS NULL))
      AND (${status} = 'OPEN' OR s.status = ${status})
      AND (${unitId ?? null}::uuid IS NULL OR COALESCE(a.unit_id, e.unit_id) = ${unitId ?? null}::uuid)
      AND (
        EXISTS (SELECT 1 FROM unit_staff us
                WHERE us.user_id = ${ctx.userId} AND us.unit_id = COALESCE(a.unit_id, e.unit_id))
        OR a.attending_doctor_id = ${ctx.userId}
        OR e.assigned_doctor_id = ${ctx.userId}
        OR EXISTS (SELECT 1 FROM care_assignments ca
                   WHERE ca.patient_id = s.patient_id AND ca.doctor_id = ${ctx.userId}
                     AND ca.ended_at IS NULL)
      )
    ORDER BY CASE s.status WHEN 'RED_FLAG' THEN 0 WHEN 'PENDING' THEN 1 ELSE 2 END, s.created_at
    LIMIT 200`);
  const ids = rows.rows.map((r) => r.id);
  const screens = ids.length
    ? await db.select().from(sepsisScreens).where(inArray(sepsisScreens.id, ids))
    : [];
  const byId = new Map(screens.map((s) => [s.id, s]));
  const names = await namesOf(userIdsOf(screens));
  const items = rows.rows.map((r) => ({
    ...present(byId.get(r.id)!, names),
    patient: {
      firstName: r.first_name,
      lastName: r.last_name,
      dateOfBirth: r.date_of_birth,
      sex: r.sex,
      temporaryIdentity: r.temporary_identity,
    },
    unitId: r.unit_id,
    unitName: r.unit_name,
    bedLabel: r.bed_label,
  }));
  res.json({
    items,
    counts: {
      PENDING: items.filter((i) => i.status === 'PENDING').length,
      RED_FLAG: items.filter((i) => i.status === 'RED_FLAG').length,
      SEPSIS_SUSPECTED: items.filter((i) => i.status === 'SEPSIS_SUSPECTED').length,
      overdue: items.filter((i) => i.overdue).length,
    },
    targetMinutes: BUNDLE_TARGET_MINUTES,
  });
});

/* ------------------------------------------------------------------ patient --------------- */

/** A patient's screens (newest first), the latest observations and suggested flags. */
sepsisRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'sepsis');
  const rows = await db
    .select()
    .from(sepsisScreens)
    .where(eq(sepsisScreens.patientId, patientId))
    .orderBy(desc(sepsisScreens.createdAt))
    .limit(50);
  const names = await namesOf(userIdsOf(rows));
  const vitals = await latestVitals(patientId);
  const location = await currentContext(patientId);
  res.json({
    items: rows.map((s) => present(s, names)),
    latestVitals: vitals && {
      recordedAt: vitals.recordedAt,
      systolic: vitals.systolic,
      heartRate: vitals.heartRate,
      respiratoryRate: vitals.respiratoryRate,
      oxygenSaturation: vitals.oxygenSaturation,
      onSupplementalOxygen: vitals.onSupplementalOxygen,
      consciousness: vitals.consciousness,
      temperatureC: vitals.temperatureC,
    },
    suggestedFlags: vitals ? suggestedFlags(vitals) : [],
    location: location && {
      unitName: location.unitName,
      bedLabel: location.bedLabel,
      setting: location.admissionId ? 'INPATIENT' : 'EMERGENCY',
    },
    targetMinutes: BUNDLE_TARGET_MINUTES,
  });
});

async function recordScreen(
  ctx: AuthContext,
  s: ScreenRow | null,
  patientId: string,
  input: z.infer<typeof ScreenInput>,
  meta: ReturnType<typeof requestMeta>,
) {
  const at = input.screenedAt ?? new Date();
  const status = outcomeFor(input.suspectedInfection, input.flags);
  const values = {
    status,
    suspectedSource: input.suspectedInfection ? (input.suspectedSource ?? 'UNKNOWN') : null,
    redFlags: input.flags,
    screenedAt: at,
    screenedById: ctx.userId,
    notes: input.notes ?? null,
    // A red flag starts the one-hour clock at the time of the screen.
    bundleStartedAt: status === 'RED_FLAG' ? at : null,
  };
  const row = await db.transaction(async (tx) => {
    let saved: ScreenRow;
    if (s) {
      const [updated] = await tx
        .update(sepsisScreens)
        .set(values)
        .where(and(eq(sepsisScreens.id, s.id), eq(sepsisScreens.status, 'PENDING')))
        .returning();
      if (!updated) throw conflict('This screen has already been answered');
      saved = updated;
    } else {
      const location = await currentContext(patientId, tx);
      const facilityId = location?.facilityId ?? ctx.facilityId;
      if (!facilityId) throw forbidden();
      const [created] = await tx
        .insert(sepsisScreens)
        .values({
          patientId,
          facilityId,
          admissionId: location?.admissionId ?? null,
          edVisitId: location?.edVisitId ?? null,
          trigger: 'MANUAL',
          ...values,
        })
        .returning();
      saved = created!;
    }
    await audit(
      {
        action: AuditAction.SEPSIS_SCREENED,
        actor: ctx,
        resourceType: 'sepsis_screen',
        resourceId: saved.id,
        patientId,
        meta,
        metadata: { kind: s ? 'answer' : 'manual', outcome: status, flags: input.flags.length },
      },
      tx,
    );
    return saved;
  });
  return row;
}

/** A screen started by a nurse or doctor without a prompt (e.g. on clinical concern). */
sepsisRouter.post(
  '/patients/:patientId/screens',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const meta = requestMeta(req);
    await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.careTeam);
    const input = parse(ScreenInput, req.body);
    const row = await recordScreen(ctx, null, patientId, input, meta);
    res.status(201).json(present(row, await namesOf(userIdsOf([row]))));
  },
);

/** Answer a prompt. */
sepsisRouter.post('/screens/:id/screen', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const s = await loadScreen(id);
  await assertClinicalWriteAccess(ctx, s.patientId, meta, WRITERS.careTeam);
  if (s.status !== 'PENDING') throw conflict('This screen has already been answered');
  const input = parse(ScreenInput, req.body);
  if (input.screenedAt && input.screenedAt < s.createdAt) {
    throw badRequest('The screen cannot be earlier than the prompt');
  }
  const row = await recordScreen(ctx, s, s.patientId, input, meta);
  res.json(present(row, await namesOf(userIdsOf([row]))));
});

const StepInput = z.object({
  step: z.enum(SEPSIS_STEPS),
  at: pastTime.optional(),
  /** Antibiotics only: the prescription of the antibiotic given. */
  prescriptionId: z.string().uuid().optional().nullable(),
});

/** Record one Sepsis Six step (time and who). */
sepsisRouter.post('/screens/:id/bundle', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const s = await loadScreen(id);
  await assertClinicalWriteAccess(ctx, s.patientId, meta, WRITERS.careTeam);
  const input = parse(StepInput, req.body);
  if (input.prescriptionId && input.step !== 'antibiotics') {
    throw badRequest('A prescription can only be linked to the antibiotics step');
  }
  if (input.prescriptionId) {
    const [rx] = await db
      .select({ patientId: prescriptions.patientId })
      .from(prescriptions)
      .where(eq(prescriptions.id, input.prescriptionId));
    if (!rx || rx.patientId !== s.patientId) {
      throw badRequest('The prescription is not this patient’s');
    }
  }
  const at = input.at ?? new Date();
  const earliest = s.screenedAt ?? s.createdAt;
  if (at.getTime() < earliest.getTime() - 6 * 3_600_000) {
    throw badRequest('The step is more than six hours before the screen');
  }
  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(sepsisScreens)
      .where(eq(sepsisScreens.id, id))
      .for('update');
    if (!locked) throw notFound('Sepsis screen not found');
    if (locked.status !== 'RED_FLAG' && locked.status !== 'SEPSIS_SUSPECTED') {
      throw conflict('The Sepsis Six bundle applies only when sepsis is suspected');
    }
    if (locked.bundle[input.step]) throw conflict('This step has already been recorded');
    const bundle: Record<string, string> = {
      ...locked.bundle,
      [input.step]: at.toISOString(),
      [`${input.step}By`]: ctx.userId,
      ...(input.prescriptionId ? { antibioticsPrescriptionId: input.prescriptionId } : {}),
    };
    const done = stepsDone(bundle);
    const startedAt = locked.bundleStartedAt ?? at;
    const completedAt =
      done.length === SEPSIS_STEPS.length
        ? new Date(Math.max(...SEPSIS_STEPS.map((step) => new Date(bundle[step]!).getTime())))
        : null;
    const [row] = await tx
      .update(sepsisScreens)
      .set({ bundle, bundleStartedAt: startedAt, bundleCompletedAt: completedAt })
      .where(eq(sepsisScreens.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.SEPSIS_BUNDLE_UPDATED,
        actor: ctx,
        resourceType: 'sepsis_screen',
        resourceId: id,
        patientId: s.patientId,
        meta,
        metadata: { step: input.step, stepsDone: done.length, complete: Boolean(completedAt) },
      },
      tx,
    );
    return row!;
  });
  res.json(present(updated, await namesOf(userIdsOf([updated]))));
});

/** A senior clinician reviewed the patient (doctor). */
sepsisRouter.post('/screens/:id/senior-review', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const s = await loadScreen(id);
  await assertClinicalWriteAccess(ctx, s.patientId, meta);
  const { at } = parse(z.object({ at: pastTime.optional() }), req.body ?? {});
  if (s.status === 'PENDING' || s.status === 'NOT_SEPSIS') {
    throw conflict('A senior review is recorded for suspected sepsis');
  }
  if (s.seniorReviewAt) throw conflict('The senior review has already been recorded');
  const [row] = await db
    .update(sepsisScreens)
    .set({ seniorReviewAt: at ?? new Date() })
    .where(eq(sepsisScreens.id, id))
    .returning();
  await audit({
    action: AuditAction.SEPSIS_BUNDLE_UPDATED,
    actor: ctx,
    resourceType: 'sepsis_screen',
    resourceId: id,
    patientId: s.patientId,
    meta,
    metadata: { step: 'seniorReview' },
  });
  res.json(present(row!, await namesOf(userIdsOf([row!]))));
});

/* ------------------------------------------------------------------ dashboard ------------- */

/**
 * Compliance at the director's facility, by month (last 12 months): screens, prompts, red flags,
 * the share of red flags with all six steps within an hour and the median time to antibiotics.
 * Counts are exact (own facility, no names); percentages and medians are withheld below the
 * small-cell threshold.
 */
sepsisRouter.get('/dashboard', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const since = new Date();
  since.setMonth(since.getMonth() - 11, 1);
  since.setHours(0, 0, 0, 0);
  const rows = await db.execute<{
    month: string | null;
    screens: number;
    prompted: number;
    red_flags: number;
    suspected: number;
    within_target: number;
    with_antibiotics: number;
    median_antibiotics: number | null;
  }>(sql`
    SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'Europe/Belgrade'), 'YYYY-MM') AS month,
      count(*) FILTER (WHERE status <> 'PENDING')::int AS screens,
      count(*) FILTER (WHERE trigger = 'PROMPTED')::int AS prompted,
      count(*) FILTER (WHERE status = 'RED_FLAG')::int AS red_flags,
      count(*) FILTER (WHERE status = 'SEPSIS_SUSPECTED')::int AS suspected,
      count(*) FILTER (WHERE status = 'RED_FLAG' AND bundle_completed_at IS NOT NULL
        AND bundle_completed_at - bundle_started_at <= ${`${BUNDLE_TARGET_MINUTES} minutes`}::interval)::int
        AS within_target,
      count(*) FILTER (WHERE status = 'RED_FLAG' AND bundle ? 'antibiotics'
        AND bundle_started_at IS NOT NULL)::int AS with_antibiotics,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY
        extract(epoch FROM ((bundle->>'antibiotics')::timestamptz - bundle_started_at)) / 60)
        FILTER (WHERE status = 'RED_FLAG' AND bundle ? 'antibiotics' AND bundle_started_at IS NOT NULL)
        AS median_antibiotics
    FROM sepsis_screens
    WHERE facility_id = ${ctx.facilityId} AND created_at >= ${since}
    GROUP BY ROLLUP (1)
    ORDER BY 1 NULLS LAST`);
  const shape = (r: (typeof rows.rows)[number]) => ({
    screens: r.screens,
    prompted: r.prompted,
    redFlags: r.red_flags,
    suspected: r.suspected,
    withinTargetPct:
      r.red_flags >= SMALL_CELL_THRESHOLD
        ? Math.round((100 * r.within_target) / r.red_flags)
        : null,
    medianMinutesToAntibiotics:
      r.with_antibiotics >= SMALL_CELL_THRESHOLD && r.median_antibiotics != null
        ? Math.round(Number(r.median_antibiotics))
        : null,
  });
  const total = rows.rows.find((r) => r.month === null);
  res.json({
    months: rows.rows.filter((r) => r.month !== null).map((r) => ({ month: r.month, ...shape(r) })),
    total: total
      ? shape(total)
      : shape({
          month: null,
          screens: 0,
          prompted: 0,
          red_flags: 0,
          suspected: 0,
          within_target: 0,
          with_antibiotics: 0,
          median_antibiotics: null,
        }),
    targetMinutes: BUNDLE_TARGET_MINUTES,
    smallCellThreshold: SMALL_CELL_THRESHOLD,
  });
});
