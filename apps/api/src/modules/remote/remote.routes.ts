import { Router } from 'express';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  careAssignments,
  homeReadings,
  monitoringPlans,
  patients,
  registerEnrolments,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  auditRecordView,
  getPatientOrThrow,
  resolveAndAuditRead,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import {
  DEFAULT_THRESHOLDS,
  GLUCOSE_CONTEXTS,
  KIND_THRESHOLDS,
  MAX_BACKDATE_DAYS,
  MAX_CLOCK_SKEW_MS,
  planThresholds,
  READING_KINDS,
  REGISTER_SUGGESTIONS,
  ThresholdsSchema,
  UNITS,
  VALUE_SCHEMAS,
  type ReadingKind,
  type Thresholds,
} from './definitions.js';
import { activePlan, presentValues, readingsOf, submitReading } from './remote.service.js';

/**
 * Remote patient monitoring: doctors enrol patients with personal alert limits; patients (and
 * guardians with full access) enter home readings in the portal; flagged readings appear on the
 * care team's review list (urgent ones also notify the team at once); directors see aggregate
 * figures for their facility without names.
 *
 * Home readings are patient-entered and stay separate from the clinic's vital signs: they are not
 * measured by staff with calibrated equipment, so they are never copied into vital_signs (which
 * feed early-warning scores and clinical decisions as verified measurements).
 */
export const remoteMonitoringRouter = Router();
remoteMonitoringRouter.use(authenticate);

const DAY = 86_400_000;
const KindEnum = z.enum(READING_KINDS);
const PatientParam = z.object({ patientId: z.string().uuid() });
const IdParam = z.object({ id: z.string().uuid() });
const isUniqueViolation = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
};

/* -------------------------------------------------------------------------- definitions -- */

remoteMonitoringRouter.get('/definitions', (_req, res) => {
  res.json({
    kinds: READING_KINDS.map((kind) => ({
      kind,
      unit: UNITS[kind],
      thresholds: KIND_THRESHOLDS[kind].map((key) => ({
        key,
        default: DEFAULT_THRESHOLDS[key] ?? null,
      })),
    })),
    glucoseContexts: GLUCOSE_CONTEXTS,
    defaults: DEFAULT_THRESHOLDS,
    registerSuggestions: REGISTER_SUGGESTIONS,
    maxBackdateDays: MAX_BACKDATE_DAYS,
    disclaimer:
      'Default limits are illustrative until confirmed by the national clinical guidelines; set them for each patient.',
  });
});

/* ------------------------------------------------------------------------- plans (doctor) -- */

/** Active plans and register suggestions for one patient. */
async function suggestionFor(patientId: string) {
  const regs = await db
    .select({ register: registerEnrolments.register })
    .from(registerEnrolments)
    .where(
      and(
        eq(registerEnrolments.patientId, patientId),
        eq(registerEnrolments.status, 'ACTIVE'),
        inArray(registerEnrolments.register, Object.keys(REGISTER_SUGGESTIONS)),
      ),
    );
  if (!regs.length) return null;
  const kinds = [...new Set(regs.flatMap((r) => REGISTER_SUGGESTIONS[r.register] ?? []))];
  return { registers: regs.map((r) => r.register), kinds };
}

remoteMonitoringRouter.get(
  '/patients/:patientId',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'home_readings');
    const plans = await db
      .select({
        id: monitoringPlans.id,
        kinds: monitoringPlans.kinds,
        thresholds: monitoringPlans.thresholds,
        frequency: monitoringPlans.frequency,
        instructions: monitoringPlans.instructions,
        status: monitoringPlans.status,
        endedAt: monitoringPlans.endedAt,
        endReason: monitoringPlans.endReason,
        createdAt: monitoringPlans.createdAt,
        updatedAt: monitoringPlans.updatedAt,
        enrolledBy: users.fullName,
      })
      .from(monitoringPlans)
      .innerJoin(users, eq(users.id, monitoringPlans.enrolledById))
      .where(eq(monitoringPlans.patientId, patientId))
      .orderBy(desc(monitoringPlans.createdAt));
    const active = plans.find((p) => p.status === 'ACTIVE') ?? null;
    res.json({
      plan: active
        ? { ...active, limits: planThresholds(active.kinds, active.thresholds as Thresholds) }
        : null,
      history: plans.filter((p) => p.status !== 'ACTIVE'),
      readings: await readingsOf(patientId, 90),
      suggestion: active ? null : await suggestionFor(patientId),
      canEnrol: ctx.role === 'DOCTOR',
      canReview: WRITERS.careTeam.includes(ctx.role),
    });
  },
);

const PlanInput = z.object({
  kinds: z
    .array(KindEnum)
    .min(1, 'Choose at least one measurement')
    .max(READING_KINDS.length)
    .transform((k) => [...new Set(k)]),
  thresholds: ThresholdsSchema.optional(),
  frequency: z.string().trim().max(100).optional().nullable(),
  instructions: z.string().trim().max(2000).optional().nullable(),
});

/** Keeps only the limits that belong to the chosen kinds (plus the plan's silence setting). */
function limitsFor(kinds: ReadingKind[], own: Thresholds | undefined): Thresholds {
  const allowed = new Set<string>(['silentAfterDays', ...kinds.flatMap((k) => KIND_THRESHOLDS[k])]);
  const extra = Object.keys(own ?? {}).filter((k) => !allowed.has(k));
  if (extra.length) {
    throw badRequest('Some limits do not belong to the chosen measurements', { limits: extra });
  }
  return planThresholds(kinds, own);
}

remoteMonitoringRouter.post(
  '/patients/:patientId/plans',
  requireRole('DOCTOR'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const input = parse(PlanInput, req.body);
    const meta = requestMeta(req);
    await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.doctorOnly);
    const patient = await getPatientOrThrow(patientId);
    if (patient.deceasedAt) throw conflict('The patient is recorded as deceased');
    const thresholds = limitsFor(input.kinds, input.thresholds);
    const facilityId = ctx.facilityId ?? patient.primaryFacilityId;
    if (!facilityId) throw forbidden();
    try {
      const plan = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(monitoringPlans)
          .values({
            patientId,
            facilityId,
            enrolledById: ctx.userId,
            kinds: input.kinds,
            thresholds: thresholds as Record<string, number>,
            frequency: input.frequency || null,
            instructions: input.instructions || null,
          })
          .returning();
        await audit(
          {
            action: AuditAction.MONITORING_PLAN_CHANGED,
            actor: ctx,
            resourceType: 'monitoring_plan',
            resourceId: created!.id,
            patientId,
            meta,
            metadata: { change: 'ENROLLED', kinds: input.kinds },
          },
          tx,
        );
        await notifyPatient(
          patientId,
          {
            type: 'remote_plan',
            title: 'Your doctor has set up home monitoring for you',
            body: 'Please enter your home measurements in the portal as agreed with your doctor.',
            link: '/portal/readings',
          },
          tx,
        );
        return created!;
      });
      res.status(201).json(plan);
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('The patient already has an active monitoring plan');
      throw e;
    }
  },
);

async function loadPlan(id: string) {
  const [plan] = await db.select().from(monitoringPlans).where(eq(monitoringPlans.id, id));
  if (!plan) throw notFound('Monitoring plan not found');
  return plan;
}

const PlanUpdate = PlanInput.partial();

remoteMonitoringRouter.patch('/plans/:id', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(PlanUpdate, req.body);
  const plan = await loadPlan(id);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, plan.patientId, meta, WRITERS.doctorOnly);
  if (plan.status !== 'ACTIVE') throw conflict('This monitoring plan has ended');
  const kinds = (input.kinds ?? plan.kinds) as ReadingKind[];
  // Limits not sent keep their current values (when still relevant for the kinds).
  const thresholds = limitsFor(kinds, {
    ...pick(plan.thresholds as Thresholds, kinds),
    ...input.thresholds,
  });
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(monitoringPlans)
      .set({
        kinds,
        thresholds: thresholds as Record<string, number>,
        ...(input.frequency !== undefined ? { frequency: input.frequency || null } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions || null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(monitoringPlans.id, id), eq(monitoringPlans.status, 'ACTIVE')))
      .returning();
    if (!updated) throw conflict('This monitoring plan has ended');
    await audit(
      {
        action: AuditAction.MONITORING_PLAN_CHANGED,
        actor: ctx,
        resourceType: 'monitoring_plan',
        resourceId: id,
        patientId: plan.patientId,
        meta,
        metadata: { change: 'UPDATED', kinds, fields: Object.keys(input) },
      },
      tx,
    );
    return updated;
  });
  res.json(row);
});

/** The stored limits that still apply to `kinds`. */
function pick(own: Thresholds, kinds: ReadingKind[]): Thresholds {
  const allowed = new Set<string>(['silentAfterDays', ...kinds.flatMap((k) => KIND_THRESHOLDS[k])]);
  return Object.fromEntries(Object.entries(own ?? {}).filter(([k]) => allowed.has(k)));
}

const EndInput = z.object({ reason: z.string().trim().min(3).max(300) });

remoteMonitoringRouter.post('/plans/:id/end', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(EndInput, req.body);
  const plan = await loadPlan(id);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, plan.patientId, meta, WRITERS.doctorOnly);
  if (plan.status !== 'ACTIVE') throw conflict('This monitoring plan has already ended');
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(monitoringPlans)
      .set({ status: 'ENDED', endedAt: new Date(), endReason: reason, updatedAt: new Date() })
      .where(and(eq(monitoringPlans.id, id), eq(monitoringPlans.status, 'ACTIVE')))
      .returning();
    if (!updated) throw conflict('This monitoring plan has already ended');
    await audit(
      {
        action: AuditAction.MONITORING_PLAN_CHANGED,
        actor: ctx,
        resourceType: 'monitoring_plan',
        resourceId: id,
        patientId: plan.patientId,
        meta,
        metadata: { change: 'ENDED', reason },
      },
      tx,
    );
    await notifyPatient(
      plan.patientId,
      {
        type: 'remote_plan',
        title: 'Your home monitoring plan has ended',
        link: '/portal/readings',
      },
      tx,
    );
    return updated;
  });
  res.json(row);
});

/* -------------------------------------------------------------------------- portal (patient) -- */

function ownPatientId(ctx: AuthContext) {
  if (!ctx.patientId) throw forbidden('No patient record is linked to this account');
  return ctx.patientId;
}

remoteMonitoringRouter.get('/mine', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const patientId = ownPatientId(ctx);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'home_readings');
  const plan = await activePlan(patientId);
  const [doctor] = plan
    ? await db
        .select({ fullName: users.fullName })
        .from(users)
        .where(eq(users.id, plan.enrolledById))
    : [];
  res.json({
    plan: plan
      ? {
          id: plan.id,
          kinds: plan.kinds,
          limits: planThresholds(plan.kinds, plan.thresholds as Thresholds),
          frequency: plan.frequency,
          instructions: plan.instructions,
          createdAt: plan.createdAt,
          enrolledBy: doctor?.fullName ?? null,
        }
      : null,
    // Review notes are written for colleagues; the patient sees that a reading was looked at.
    readings: (await readingsOf(patientId, 90)).map(({ reviewNote: _n, reviewedBy, ...r }) => ({
      ...r,
      reviewedBy,
    })),
  });
});

const ReadingInput = z.object({
  kind: KindEnum,
  values: z.record(z.string(), z.unknown()),
  measuredAt: z.coerce.date().optional(),
  note: z.string().trim().max(300).optional().nullable(),
});

remoteMonitoringRouter.post('/mine/readings', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const patientId = ownPatientId(ctx);
  const input = parse(ReadingInput, req.body);
  const meta = requestMeta(req);
  // Self, or a guardian with full access (appointments-only guardians are refused here).
  await resolveAndAuditRead(ctx, patientId, meta, 'home_readings');
  const patient = await getPatientOrThrow(patientId);
  if (patient.deceasedAt) throw conflict('The patient is recorded as deceased');
  const values = parse(VALUE_SCHEMAS[input.kind], input.values) as Record<string, unknown>;
  const now = new Date();
  const measuredAt = input.measuredAt ?? now;
  if (Number.isNaN(measuredAt.getTime())) throw badRequest('Invalid measurement time');
  if (measuredAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS) {
    throw badRequest('The measurement time cannot be in the future');
  }
  if (measuredAt.getTime() < now.getTime() - MAX_BACKDATE_DAYS * DAY) {
    throw badRequest('Readings older than 7 days cannot be entered');
  }
  const { reading, evaluation, planned } = await submitReading(
    ctx,
    patientId,
    { kind: input.kind, values, measuredAt, note: input.note || null },
    meta,
    now,
  );
  const glucoseLow =
    input.kind === 'GLUCOSE' &&
    evaluation.reasons.some((r) => r.startsWith('GLUCOSE_') && r.endsWith('LOW'));
  res.status(201).json({
    reading: { ...reading, ...presentValues(reading.values) },
    flag: evaluation.flag,
    reasons: evaluation.reasons,
    planned,
    /**
     * What the portal tells the person straight away. URGENT: seek help now (112 or the doctor);
     * the care team has been notified too. The texts themselves live in the web app (sq/sr).
     */
    advice:
      evaluation.flag === 'URGENT'
        ? glucoseLow
          ? 'URGENT_LOW_GLUCOSE'
          : 'URGENT'
        : evaluation.flag === 'OUT_OF_RANGE'
          ? 'OUT_OF_RANGE'
          : null,
  });
});

/* -------------------------------------------------------------------------- review (team) -- */

const ReviewQuery = PaginationSchema.extend({
  flag: z.enum(['URGENT', 'OUT_OF_RANGE', 'ALL']).default('ALL'),
  kind: KindEnum.optional(),
});

/** Unreviewed flagged readings of patients in the caller's care, urgent first. */
remoteMonitoringRouter.get('/review', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ReviewQuery, req.query);
  const where = and(
    isNull(homeReadings.reviewedAt),
    q.flag === 'ALL'
      ? inArray(homeReadings.flag, ['URGENT', 'OUT_OF_RANGE'])
      : eq(homeReadings.flag, q.flag),
    q.kind ? eq(homeReadings.kind, q.kind) : undefined,
    isNull(patients.mergedIntoId),
  );
  const inCare = and(
    eq(careAssignments.patientId, homeReadings.patientId),
    eq(careAssignments.doctorId, ctx.userId),
    isNull(careAssignments.endedAt),
  );
  const rows = await db
    .select({
      id: homeReadings.id,
      kind: homeReadings.kind,
      values: homeReadings.values,
      measuredAt: homeReadings.measuredAt,
      note: homeReadings.note,
      flag: homeReadings.flag,
      createdAt: homeReadings.createdAt,
      planned: sql<boolean>`${homeReadings.planId} IS NOT NULL`,
      patient: {
        id: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
        nationalId: patients.nationalId,
        dateOfBirth: patients.dateOfBirth,
        phone: patients.phone,
      },
    })
    .from(homeReadings)
    .innerJoin(patients, eq(patients.id, homeReadings.patientId))
    .innerJoin(careAssignments, inCare)
    .where(where)
    .orderBy(
      sql`CASE WHEN ${homeReadings.flag} = 'URGENT' THEN 0 ELSE 1 END`,
      desc(homeReadings.measuredAt),
    )
    .limit(q.pageSize)
    .offset((q.page - 1) * q.pageSize);
  const counts = await db
    .select({ flag: homeReadings.flag, n: sql<number>`count(*)::int` })
    .from(homeReadings)
    .innerJoin(patients, eq(patients.id, homeReadings.patientId))
    .innerJoin(careAssignments, inCare)
    .where(
      and(
        isNull(homeReadings.reviewedAt),
        inArray(homeReadings.flag, ['URGENT', 'OUT_OF_RANGE']),
        isNull(patients.mergedIntoId),
      ),
    )
    .groupBy(homeReadings.flag);
  const urgent = counts.find((c) => c.flag === 'URGENT')?.n ?? 0;
  const outOfRange = counts.find((c) => c.flag === 'OUT_OF_RANGE')?.n ?? 0;
  const total =
    q.flag === 'ALL' && !q.kind
      ? urgent + outOfRange
      : (
          await db
            .select({ n: sql<number>`count(*)::int` })
            .from(homeReadings)
            .innerJoin(patients, eq(patients.id, homeReadings.patientId))
            .innerJoin(careAssignments, inCare)
            .where(where)
        )[0]!.n;
  // The list shows readings: each patient shown counts as a view of their home readings.
  const meta = requestMeta(req);
  for (const pid of new Set(rows.map((r) => r.patient.id))) {
    await auditRecordView(ctx, pid, 'CARE_TEAM', 'home_readings', meta);
  }
  res.json({
    ...paginated(
      rows.map((r) => ({ ...r, ...presentValues(r.values) })),
      total,
      q,
    ),
    counts: { urgent, outOfRange },
  });
});

/**
 * Patients with an active plan who have sent nothing for longer than the plan's `silentAfterDays`
 * (default 3 days; a new plan counts from its start).
 */
remoteMonitoringRouter.get('/silent', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const now = Date.now();
  const rows = await db
    .select({
      planId: monitoringPlans.id,
      kinds: monitoringPlans.kinds,
      frequency: monitoringPlans.frequency,
      thresholds: monitoringPlans.thresholds,
      planStartedAt: monitoringPlans.createdAt,
      lastReadingAt: sql<
        string | null
      >`(SELECT max(r.measured_at) FROM home_readings r WHERE r.patient_id = ${monitoringPlans.patientId})`,
      patient: {
        id: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
        nationalId: patients.nationalId,
        dateOfBirth: patients.dateOfBirth,
        phone: patients.phone,
      },
    })
    .from(monitoringPlans)
    .innerJoin(patients, eq(patients.id, monitoringPlans.patientId))
    .innerJoin(
      careAssignments,
      and(
        eq(careAssignments.patientId, monitoringPlans.patientId),
        eq(careAssignments.doctorId, ctx.userId),
        isNull(careAssignments.endedAt),
      ),
    )
    .where(
      and(
        eq(monitoringPlans.status, 'ACTIVE'),
        isNull(patients.mergedIntoId),
        isNull(patients.deceasedAt),
      ),
    )
    .limit(5000);
  const items = rows
    .map(({ thresholds, ...r }) => {
      const after =
        (thresholds as Thresholds).silentAfterDays ?? DEFAULT_THRESHOLDS.silentAfterDays!;
      const since = r.lastReadingAt ? new Date(r.lastReadingAt) : r.planStartedAt;
      const daysSilent = Math.floor((now - since.getTime()) / DAY);
      return {
        ...r,
        lastReadingAt: r.lastReadingAt ? new Date(r.lastReadingAt) : null,
        silentAfterDays: after,
        daysSilent,
      };
    })
    .filter((r) => r.daysSilent >= r.silentAfterDays)
    .sort((a, b) => b.daysSilent - a.daysSilent);
  res.json({ items, total: items.length });
});

/** Register patients in the caller's care who could benefit from home monitoring (no plan yet). */
remoteMonitoringRouter.get('/suggestions', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const rows = await db
    .select({
      register: registerEnrolments.register,
      patient: {
        id: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
        nationalId: patients.nationalId,
        dateOfBirth: patients.dateOfBirth,
      },
    })
    .from(registerEnrolments)
    .innerJoin(patients, eq(patients.id, registerEnrolments.patientId))
    .innerJoin(
      careAssignments,
      and(
        eq(careAssignments.patientId, patients.id),
        eq(careAssignments.doctorId, ctx.userId),
        isNull(careAssignments.endedAt),
      ),
    )
    .where(
      and(
        eq(registerEnrolments.status, 'ACTIVE'),
        inArray(registerEnrolments.register, Object.keys(REGISTER_SUGGESTIONS)),
        isNull(patients.mergedIntoId),
        isNull(patients.deceasedAt),
        sql`NOT EXISTS (SELECT 1 FROM monitoring_plans m WHERE m.patient_id = ${patients.id} AND m.status = 'ACTIVE')`,
      ),
    )
    .limit(5000);
  const byPatient = new Map<
    string,
    { patient: (typeof rows)[number]['patient']; registers: string[]; kinds: ReadingKind[] }
  >();
  for (const r of rows) {
    const entry = byPatient.get(r.patient.id) ?? { patient: r.patient, registers: [], kinds: [] };
    entry.registers.push(r.register);
    for (const k of REGISTER_SUGGESTIONS[r.register] ?? []) {
      if (!entry.kinds.includes(k)) entry.kinds.push(k);
    }
    byPatient.set(r.patient.id, entry);
  }
  const items = [...byPatient.values()].sort(
    (a, b) =>
      a.patient.lastName.localeCompare(b.patient.lastName) ||
      a.patient.firstName.localeCompare(b.patient.firstName),
  );
  res.json({ items, total: items.length });
});

const ReviewInput = z.object({ note: z.string().trim().max(500).optional().nullable() });

remoteMonitoringRouter.post(
  '/readings/:id/review',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const { note } = parse(ReviewInput, req.body ?? {});
    const [reading] = await db.select().from(homeReadings).where(eq(homeReadings.id, id));
    if (!reading) throw notFound('Reading not found');
    const meta = requestMeta(req);
    await assertClinicalWriteAccess(ctx, reading.patientId, meta, WRITERS.careTeam);
    if (reading.flag === 'NORMAL') throw conflict('Only flagged readings need a review');
    if (reading.reviewedAt) throw conflict('This reading has already been reviewed');
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(homeReadings)
        .set({ reviewedAt: new Date(), reviewedById: ctx.userId, reviewNote: note || null })
        .where(and(eq(homeReadings.id, id), isNull(homeReadings.reviewedAt)))
        .returning();
      if (!updated) throw conflict('This reading has already been reviewed');
      await audit(
        {
          action: AuditAction.READING_REVIEWED,
          actor: ctx,
          resourceType: 'home_reading',
          resourceId: id,
          patientId: reading.patientId,
          meta,
          metadata: { flag: reading.flag, kind: reading.kind, withNote: Boolean(note) },
        },
        tx,
      );
      return updated;
    });
    res.json({ ...row, ...presentValues(row.values) });
  },
);

/* ------------------------------------------------------------------------ director stats -- */

/**
 * Aggregate figures for the director's facility (plans registered there): counts only, no names
 * and no values. The review share measures the service (how fast flagged readings are looked at).
 */
remoteMonitoringRouter.get('/stats', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const facilityId = ctx.facilityId;
  const now = new Date();
  const since = new Date(now.getTime() - 8 * 7 * DAY);
  const [enrolled] = await db
    .select({
      patients: sql<number>`count(DISTINCT ${monitoringPlans.patientId})::int`,
    })
    .from(monitoringPlans)
    .where(and(eq(monitoringPlans.facilityId, facilityId), eq(monitoringPlans.status, 'ACTIVE')));
  const byKind = await db.execute<{ kind: string; n: number }>(sql`
    SELECT k AS kind, count(*)::int AS n
    FROM monitoring_plans m, unnest(m.kinds) AS k
    WHERE m.facility_id = ${facilityId} AND m.status = 'ACTIVE'
    GROUP BY k ORDER BY k`);
  const weekly = await db.execute<{ week: string; readings: number; flagged: number }>(sql`
    SELECT to_char(date_trunc('week', r.measured_at AT TIME ZONE 'Europe/Belgrade'), 'YYYY-MM-DD') AS week,
           count(*)::int AS readings,
           count(*) FILTER (WHERE r.flag <> 'NORMAL')::int AS flagged
    FROM home_readings r JOIN monitoring_plans m ON m.id = r.plan_id
    WHERE m.facility_id = ${facilityId} AND r.measured_at >= ${since}
    GROUP BY 1 ORDER BY 1`);
  const [review] = (
    await db.execute<{ flagged: number; within24h: number; pending: number; urgent: number }>(sql`
    SELECT count(*)::int AS flagged,
           count(*) FILTER (WHERE r.reviewed_at IS NOT NULL
                              AND r.reviewed_at <= r.created_at + interval '24 hours')::int AS within24h,
           count(*) FILTER (WHERE r.reviewed_at IS NULL)::int AS pending,
           count(*) FILTER (WHERE r.flag = 'URGENT')::int AS urgent
    FROM home_readings r JOIN monitoring_plans m ON m.id = r.plan_id
    WHERE m.facility_id = ${facilityId} AND r.flag <> 'NORMAL'
      AND r.created_at >= ${new Date(now.getTime() - 30 * DAY)}
      AND r.created_at <= ${new Date(now.getTime() - DAY)}`)
  ).rows;
  const flagged = review?.flagged ?? 0;
  res.json({
    enrolledPatients: enrolled?.patients ?? 0,
    byKind: byKind.rows,
    weekly: weekly.rows,
    review: {
      /** Readings flagged 1–30 days ago (so each has had its full 24 hours). */
      flagged,
      reviewedWithin24h: review?.within24h ?? 0,
      pct: flagged ? Math.round(((review?.within24h ?? 0) / flagged) * 1000) / 10 : null,
      stillPending: review?.pending ?? 0,
      urgent: review?.urgent ?? 0,
    },
    generatedAt: now,
  });
});
