import { Router } from 'express';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { antenatalVisits, careAssignments, patients, pregnancies } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  auditRecordView,
  getPatientOrThrow,
  resolveAndAuditRead,
  resolveClinicalReadAccess,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  addDays,
  ageOn,
  AGE_FACTORS,
  CONTACT_WEEKS,
  daysBetween,
  decodeRiskFactors,
  EDD_DISCREPANCY_DAYS,
  eddFromLmp,
  encodeRiskFactors,
  gestationDays,
  HIGH_RISK_FACTORS,
  KEY_TESTS,
  kosovoDay,
  MAX_AGE,
  MIN_AGE,
  NEAR_EDD_DAYS,
  OUTCOMES,
  POST_TERM_DAYS,
  PRESENTATIONS,
  riskLevelFor,
  RISK_FACTORS,
  URINE_PROTEIN,
  visitAlerts,
  withAgeFactors,
  type RiskFactor,
} from './definitions.js';
import {
  maternityIndicators,
  ongoingWithVisits,
  pregnancyView,
  suppress,
} from './maternity.service.js';

/**
 * Antenatal care: booking a pregnancy (dating, gravida/para, risk factors), antenatal visits with
 * alerts, the WHO contact schedule and key tests, closing the pregnancy (deliveries are closed by
 * birth registration), worklists for the care team, dashboards for directors and the Ministry, and
 * the mother's own view in the portal (no clinician notes).
 */
export const maternityRouter = Router();
maternityRouter.use(authenticate);

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');
const Id = z.object({ id: z.string().uuid() });
const PatientParam = z.object({ patientId: z.string().uuid() });
const RiskFactorEnum = z.enum(RISK_FACTORS);

/* ------------------------------------------------------------------------ definitions -- */

maternityRouter.get('/definitions', (_req, res) => {
  res.json({
    riskFactors: RISK_FACTORS.map((code) => ({
      code,
      highRisk: HIGH_RISK_FACTORS.has(code),
      automatic: AGE_FACTORS.includes(code),
    })),
    outcomes: OUTCOMES,
    presentations: PRESENTATIONS,
    urineProtein: URINE_PROTEIN,
    contactWeeks: CONTACT_WEEKS,
    keyTests: KEY_TESTS.map((k) => ({
      code: k.code,
      label: k.label,
      fromWeek: Math.floor(k.fromDay / 7),
      dueByWeek: Math.floor(k.dueByDay / 7),
    })),
    rules: {
      eddDiscrepancyDays: EDD_DISCREPANCY_DAYS,
      postTermDays: POST_TERM_DAYS,
      nearEddDays: NEAR_EDD_DAYS,
    },
    disclaimer:
      'Risk mapping, alert thresholds and test windows are illustrative until confirmed by the national maternity guideline.',
  });
});

/* -------------------------------------------------------------------------- dating -- */

interface Dating {
  eddDate: string;
  eddMethod: 'LMP' | 'ULTRASOUND';
  lmpDate: string | null;
  warnings: { code: 'EDD_DISCREPANCY'; days: number }[];
}

function dating(lmpDate: string | undefined | null, scanEdd: string | undefined | null): Dating {
  if (!lmpDate && !scanEdd)
    throw badRequest('Enter the last menstrual period or the scan due date');
  const today = kosovoDay(new Date());
  if (lmpDate && lmpDate > today)
    throw badRequest('The last menstrual period cannot be in the future');
  const lmpEdd = lmpDate ? eddFromLmp(lmpDate) : null;
  const eddDate = scanEdd ?? lmpEdd!;
  const warnings: Dating['warnings'] = [];
  if (lmpEdd && scanEdd) {
    const days = Math.abs(daysBetween(lmpEdd, scanEdd));
    if (days > EDD_DISCREPANCY_DAYS) warnings.push({ code: 'EDD_DISCREPANCY', days });
  }
  const ga = gestationDays(eddDate, today);
  if (ga < 0 || ga > 44 * 7) {
    throw badRequest('The due date does not fit an ongoing pregnancy (0–44 weeks today)');
  }
  return { eddDate, eddMethod: scanEdd ? 'ULTRASOUND' : 'LMP', lmpDate: lmpDate ?? null, warnings };
}

const Obstetric = z
  .object({
    gravida: z.coerce.number().int().min(1).max(30),
    para: z.coerce.number().int().min(0).max(29),
  })
  .refine((v) => v.para < v.gravida, {
    message: 'Para must be lower than gravida (this pregnancy counts in gravida)',
    path: ['para'],
  });

const BookInput = z
  .object({
    lmpDate: DateString.optional().nullable(),
    scanEdd: DateString.optional().nullable(),
    gravida: z.coerce.number().int().min(1).max(30),
    para: z.coerce.number().int().min(0).max(29),
    riskFactors: z.array(RiskFactorEnum).max(RISK_FACTORS.length).default([]),
    otherRiskNote: z.string().trim().max(200).optional().nullable(),
  })
  .refine((v) => v.para < v.gravida, {
    message: 'Para must be lower than gravida (this pregnancy counts in gravida)',
    path: ['para'],
  })
  .refine((v) => !v.riskFactors.includes('OTHER') || Boolean(v.otherRiskNote), {
    message: 'Describe the other risk factor',
    path: ['otherRiskNote'],
  });

async function assertCanBook(patientId: string) {
  const patient = await getPatientOrThrow(patientId);
  if (patient.deceasedAt) throw conflict('The patient has died');
  if (patient.sex !== 'FEMALE')
    throw badRequest('A pregnancy can only be booked for a female patient');
  const age = ageOn(patient.dateOfBirth, kosovoDay(new Date()));
  if (age < MIN_AGE || age > MAX_AGE) {
    throw badRequest('A pregnancy can be booked for patients aged 10–55');
  }
  return { patient, age };
}

const isUniqueViolation = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';

maternityRouter.post(
  '/patients/:patientId/pregnancies',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const input = parse(BookInput, req.body);
    const meta = requestMeta(req);
    await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.careTeam);
    if (!ctx.facilityId) throw forbidden();
    const { age } = await assertCanBook(patientId);
    const d = dating(input.lmpDate, input.scanEdd);
    const codes = withAgeFactors(input.riskFactors as RiskFactor[], age);
    const [ongoing] = await db
      .select({ id: pregnancies.id })
      .from(pregnancies)
      .where(and(eq(pregnancies.patientId, patientId), eq(pregnancies.status, 'ONGOING')));
    if (ongoing) throw conflict('The patient already has an ongoing pregnancy');
    let row;
    try {
      row = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(pregnancies)
          .values({
            patientId,
            facilityId: ctx.facilityId!,
            lmpDate: d.lmpDate,
            eddDate: d.eddDate,
            eddMethod: d.eddMethod,
            gravida: input.gravida,
            para: input.para,
            riskFactors: encodeRiskFactors(codes, input.otherRiskNote),
            riskLevel: riskLevelFor(codes),
            bookedById: ctx.userId,
          })
          .returning();
        await audit(
          {
            action: AuditAction.PREGNANCY_BOOKED,
            actor: ctx,
            resourceType: 'pregnancy',
            resourceId: created!.id,
            patientId,
            meta,
            metadata: { eddMethod: d.eddMethod, riskLevel: created!.riskLevel },
          },
          tx,
        );
        return created!;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('The patient already has an ongoing pregnancy');
      throw e;
    }
    const [view] = (await pregnancyView(patientId, { includeNotes: true })).filter(
      (p) => p.id === row.id,
    );
    res.status(201).json({ pregnancy: view, warnings: d.warnings });
  },
);

/* ----------------------------------------------------------------------- chart view -- */

maternityRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'pregnancy');
  const patient = await getPatientOrThrow(patientId);
  const items = await pregnancyView(patientId, { includeNotes: true });
  const age = ageOn(patient.dateOfBirth, kosovoDay(new Date()));
  res.json({
    items,
    canBook:
      patient.sex === 'FEMALE' &&
      !patient.deceasedAt &&
      age >= MIN_AGE &&
      age <= MAX_AGE &&
      !items.some((p) => p.status === 'ONGOING'),
    canEdit: WRITERS.careTeam.includes(ctx.role),
  });
});

/* ------------------------------------------------------------ update / visits / close -- */

async function loadForWrite(ctx: AuthContext, id: string, meta: ReturnType<typeof requestMeta>) {
  const [p] = await db.select().from(pregnancies).where(eq(pregnancies.id, id));
  if (!p) throw notFound('Pregnancy not found');
  await assertClinicalWriteAccess(ctx, p.patientId, meta, WRITERS.careTeam);
  return p;
}

const UpdateInput = z
  .object({
    dating: z
      .object({
        lmpDate: DateString.optional().nullable(),
        scanEdd: DateString.optional().nullable(),
      })
      .optional(),
    gravida: z.coerce.number().int().min(1).max(30).optional(),
    para: z.coerce.number().int().min(0).max(29).optional(),
    riskFactors: z.array(RiskFactorEnum).max(RISK_FACTORS.length).optional(),
    otherRiskNote: z.string().trim().max(200).optional().nullable(),
    reason: z.string().trim().max(300).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'reason'), 'Nothing to change');

maternityRouter.patch('/pregnancies/:id', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(Id, req.params);
  const input = parse(UpdateInput, req.body);
  const meta = requestMeta(req);
  const p = await loadForWrite(ctx, id, meta);
  if (p.status !== 'ONGOING') throw conflict('Only an ongoing pregnancy can be changed');
  const patient = await getPatientOrThrow(p.patientId);
  const changes: Partial<typeof pregnancies.$inferInsert> = {};
  const changed: string[] = [];
  let warnings: Dating['warnings'] = [];
  if (input.dating) {
    const d = dating(input.dating.lmpDate, input.dating.scanEdd);
    warnings = d.warnings;
    Object.assign(changes, { lmpDate: d.lmpDate, eddDate: d.eddDate, eddMethod: d.eddMethod });
    changed.push('dating');
  }
  const gravida = input.gravida ?? p.gravida;
  const para = input.para ?? p.para;
  parse(Obstetric, { gravida, para });
  if (input.gravida !== undefined || input.para !== undefined) {
    Object.assign(changes, { gravida, para });
    changed.push('gravidaPara');
  }
  if (input.riskFactors !== undefined || input.otherRiskNote !== undefined) {
    const current = decodeRiskFactors(p.riskFactors);
    const codes = withAgeFactors(
      (input.riskFactors ?? current.codes) as RiskFactor[],
      ageOn(patient.dateOfBirth, kosovoDay(p.createdAt)),
    );
    const note = input.otherRiskNote !== undefined ? input.otherRiskNote : current.otherNote;
    if (codes.includes('OTHER') && !note) throw badRequest('Describe the other risk factor');
    Object.assign(changes, {
      riskFactors: encodeRiskFactors(codes, codes.includes('OTHER') ? note : null),
      riskLevel: riskLevelFor(codes),
    });
    changed.push('riskFactors');
  }
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(pregnancies)
      .set(changes)
      .where(and(eq(pregnancies.id, id), eq(pregnancies.status, 'ONGOING')))
      .returning({ id: pregnancies.id });
    if (!updated) throw conflict('Only an ongoing pregnancy can be changed');
    await audit(
      {
        action: AuditAction.PREGNANCY_UPDATED,
        actor: ctx,
        resourceType: 'pregnancy',
        resourceId: id,
        patientId: p.patientId,
        meta,
        metadata: { changed, reason: input.reason ?? null },
      },
      tx,
    );
  });
  const [view] = (await pregnancyView(p.patientId, { includeNotes: true })).filter(
    (x) => x.id === id,
  );
  res.json({ pregnancy: view, warnings });
});

const optionalInt = (min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).optional().nullable();

const VisitInput = z
  .object({
    visitAt: z.coerce
      .date()
      .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'The visit cannot be in the future')
      .optional(),
    systolic: optionalInt(50, 260),
    diastolic: optionalInt(30, 160),
    weightKg: z.coerce.number().min(25).max(250).optional().nullable(),
    fundalHeightCm: z.coerce.number().min(5).max(60).optional().nullable(),
    fetalHeartRate: optionalInt(50, 240),
    presentation: z.enum(PRESENTATIONS).optional().nullable(),
    urineProtein: z.enum(URINE_PROTEIN).optional().nullable(),
    oedema: z.boolean().optional().nullable(),
    fetalMovements: z.boolean().optional().nullable(),
    notes: z.string().trim().max(2000).optional().nullable(),
    nextVisitDate: DateString.optional().nullable(),
  })
  .refine(
    (v) =>
      v.systolic === undefined ||
      v.systolic === null ||
      (v.diastolic !== undefined && v.diastolic !== null),
    { message: 'Enter both systolic and diastolic pressure', path: ['diastolic'] },
  );

maternityRouter.post(
  '/pregnancies/:id/visits',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(Id, req.params);
    const input = parse(VisitInput, req.body);
    const meta = requestMeta(req);
    const p = await loadForWrite(ctx, id, meta);
    if (p.status !== 'ONGOING') throw conflict('Visits can only be added to an ongoing pregnancy');
    const visitAt = input.visitAt ?? new Date();
    const visitDay = kosovoDay(visitAt);
    const ga = gestationDays(p.eddDate, visitDay);
    if (ga < 0 || ga > 45 * 7) {
      throw badRequest('The visit date does not fall within this pregnancy');
    }
    if (input.nextVisitDate) {
      if (input.nextVisitDate <= visitDay) {
        throw badRequest('The next visit must be after this visit');
      }
      if (input.nextVisitDate > addDays(p.eddDate, POST_TERM_DAYS + 7)) {
        throw badRequest('The next visit is too far after the due date');
      }
    }
    const values = {
      pregnancyId: id,
      patientId: p.patientId,
      facilityId: ctx.facilityId,
      visitAt,
      gestationDays: ga,
      systolic: input.systolic ?? null,
      diastolic: input.diastolic ?? null,
      weightKg:
        input.weightKg !== undefined && input.weightKg !== null ? String(input.weightKg) : null,
      fundalHeightCm:
        input.fundalHeightCm !== undefined && input.fundalHeightCm !== null
          ? String(input.fundalHeightCm)
          : null,
      fetalHeartRate: input.fetalHeartRate ?? null,
      presentation: input.presentation ?? null,
      urineProtein: input.urineProtein ?? null,
      oedema: input.oedema ?? null,
      fetalMovements: input.fetalMovements ?? null,
      notes: input.notes ?? null,
      nextVisitDate: input.nextVisitDate ?? null,
      recordedById: ctx.userId,
    };
    const alerts = visitAlerts(values);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(antenatalVisits).values(values).returning();
      await audit(
        {
          action: AuditAction.ANTENATAL_VISIT_RECORDED,
          actor: ctx,
          resourceType: 'antenatal_visit',
          resourceId: created!.id,
          patientId: p.patientId,
          meta,
          metadata: { pregnancyId: id, gestationDays: ga, alerts: alerts.map((a) => a.code) },
        },
        tx,
      );
      return created!;
    });
    res.status(201).json({ ...row, alerts });
  },
);

const CloseInput = z.object({
  outcome: z.enum(OUTCOMES),
  endedAt: z.coerce
    .date()
    .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'The date cannot be in the future')
    .optional(),
  note: z.string().trim().max(500).optional().nullable(),
});

maternityRouter.post('/pregnancies/:id/close', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(Id, req.params);
  const input = parse(CloseInput, req.body);
  const meta = requestMeta(req);
  const p = await loadForWrite(ctx, id, meta);
  if (p.status !== 'ONGOING') throw conflict('The pregnancy is already closed');
  const endedAt = input.endedAt ?? new Date();
  if (gestationDays(p.eddDate, kosovoDay(endedAt)) < 0) {
    throw badRequest('The date is before the start of this pregnancy');
  }
  if (input.outcome === 'TRANSFERRED_OUT' && !input.note) {
    throw badRequest('Say where the care was transferred to');
  }
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(pregnancies)
      .set({ status: input.outcome, endedAt, outcomeNote: input.note ?? null })
      .where(and(eq(pregnancies.id, id), eq(pregnancies.status, 'ONGOING')))
      .returning({ id: pregnancies.id });
    if (!updated) throw conflict('The pregnancy is already closed');
    await audit(
      {
        action: AuditAction.PREGNANCY_UPDATED,
        actor: ctx,
        resourceType: 'pregnancy',
        resourceId: id,
        patientId: p.patientId,
        meta,
        metadata: { changed: ['outcome'], outcome: input.outcome },
      },
      tx,
    );
  });
  const [view] = (await pregnancyView(p.patientId, { includeNotes: true })).filter(
    (x) => x.id === id,
  );
  res.json({ pregnancy: view });
});

/* ------------------------------------------------------------------------ worklist -- */

const FILTERS = ['ALL', 'HIGH_RISK', 'OVERDUE_CONTACT', 'NEAR_EDD', 'POST_TERM', 'ALERTS'] as const;
const WorklistQuery = PaginationSchema.extend({
  filter: z.enum(FILTERS).default('ALL'),
  q: z.string().trim().max(100).optional(),
});

/** Ongoing pregnancies at my facility of patients in my care (care-team membership). */
maternityRouter.get('/worklist', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(WorklistQuery, req.query);
  if (!ctx.facilityId) throw forbidden();
  const inCare = sql`EXISTS (SELECT 1 FROM ${careAssignments} ca
    WHERE ca.patient_id = ${pregnancies.patientId} AND ca.doctor_id = ${ctx.userId}
      AND ca.ended_at IS NULL)`;
  const rows = await ongoingWithVisits(and(eq(pregnancies.facilityId, ctx.facilityId), inCare));
  const people = rows.length
    ? await db
        .select({
          id: patients.id,
          firstName: patients.firstName,
          lastName: patients.lastName,
          nationalId: patients.nationalId,
          dateOfBirth: patients.dateOfBirth,
          phone: patients.phone,
        })
        .from(patients)
        .where(
          and(
            inArray(
              patients.id,
              rows.map((r) => r.pregnancy.patientId),
            ),
            isNull(patients.mergedIntoId),
          ),
        )
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const test = (f: (typeof FILTERS)[number], r: (typeof rows)[number]) => {
    switch (f) {
      case 'HIGH_RISK':
        return r.pregnancy.riskLevel === 'HIGH';
      case 'OVERDUE_CONTACT':
        return r.overdueContact;
      case 'NEAR_EDD':
        return r.flags.nearEdd && !r.flags.postTerm;
      case 'POST_TERM':
        return r.flags.postTerm;
      case 'ALERTS':
        return r.alerts.some((a) => a.severity !== 'INFO');
      default:
        return true;
    }
  };
  const matches = (r: (typeof rows)[number]) => test(q.filter, r);
  const needle = q.q?.toLowerCase();
  const all = rows
    .filter((r) => byId.has(r.pregnancy.patientId))
    .filter((r) => {
      if (!needle) return true;
      const p = byId.get(r.pregnancy.patientId)!;
      return (
        `${p.firstName} ${p.lastName}`.toLowerCase().includes(needle) ||
        p.nationalId.startsWith(needle)
      );
    });
  const counts = Object.fromEntries(FILTERS.map((f) => [f, all.filter((r) => test(f, r)).length]));
  const list = all.filter(matches);
  const start = (q.page - 1) * q.pageSize;
  res.json({
    ...paginated(
      list.slice(start, start + q.pageSize).map((r) => {
        const risk = decodeRiskFactors(r.pregnancy.riskFactors);
        return {
          id: r.pregnancy.id,
          patient: byId.get(r.pregnancy.patientId)!,
          eddDate: r.pregnancy.eddDate,
          gestation: r.flags.gestation,
          gestationDays: r.flags.gestationDays,
          riskLevel: r.pregnancy.riskLevel,
          riskFactors: risk.codes,
          postTerm: r.flags.postTerm,
          nearEdd: r.flags.nearEdd,
          overdueContact: r.overdueContact,
          visitCount: r.visitCount,
          lastVisitAt: r.lastVisitAt,
          nextVisitDate: r.nextVisitDate,
          alerts: r.alerts,
        };
      }),
      list.length,
      q,
    ),
    counts,
  });
});

/* ----------------------------------------------------------------------- dashboards -- */

maternityRouter.get('/dashboard', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  if (ctx.role === 'DIRECTOR' && !ctx.facilityId) throw forbidden();
  const facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId : null;
  const rows = await ongoingWithVisits(
    facilityId ? eq(pregnancies.facilityId, facilityId) : undefined,
  );
  const count = (f: (r: (typeof rows)[number]) => boolean) => {
    const n = rows.filter(f).length;
    return facilityId ? n : suppress(n);
  };
  const [total] = await maternityIndicators({ facilityId, byMunicipality: false });
  res.json({
    scope: facilityId ? 'FACILITY' : 'NATIONAL',
    threshold: SMALL_CELL_THRESHOLD,
    ongoing: {
      total: count(() => true),
      highRisk: count((r) => r.pregnancy.riskLevel === 'HIGH'),
      overdueContact: count((r) => r.overdueContact),
      nearEdd: count((r) => r.flags.nearEdd && !r.flags.postTerm),
      postTerm: count((r) => r.flags.postTerm),
      alerts: count((r) => r.alerts.some((a) => a.severity !== 'INFO')),
    },
    indicators: total ?? null,
    byMunicipality: facilityId
      ? []
      : await maternityIndicators({ facilityId: null, byMunicipality: true }),
    disclaimer:
      'Aggregate figures only. Counts below the threshold are suppressed. Indicators cover pregnancies booked in the last 12 months.',
  });
});

/* -------------------------------------------------------------------------- portal -- */

/** The mother's own pregnancy record (or a guardian with full access to a minor's record). */
maternityRouter.get('/mine', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.patientId) throw forbidden();
  const meta = requestMeta(req);
  const basis = await resolveClinicalReadAccess(ctx, ctx.patientId, meta);
  await auditRecordView(ctx, ctx.patientId, basis, 'pregnancy', meta);
  const items = await pregnancyView(ctx.patientId, { includeNotes: false });
  res.json({
    items: items.map((p) => ({
      ...p,
      // The mother sees her checks and results, not the internal worklist flags.
      riskFactors: undefined,
      otherRiskNote: undefined,
      bookedBy: undefined,
    })),
  });
});
