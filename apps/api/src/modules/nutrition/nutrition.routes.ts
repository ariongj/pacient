import { Router } from 'express';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  admissions,
  dietOrders,
  dietTypeEnum,
  nutritionScreenings,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  getPatientOrThrow,
  resolveClinicalReadAccess,
  WRITERS,
  resolveAndAuditRead,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { viewFor } from '../clinical/clinical.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import {
  activeCases,
  activeOrders,
  ageInYears,
  assertNutritionListAccess,
  dietLines,
  foodAllergiesFor,
  latestScreenings,
  MEAL_TIMES,
  mealInstant,
  MEALS,
  NPO_CLEAR_FLUIDS_HOURS,
  NPO_SOLIDS_HOURS,
  npoAt,
  SCREENING_DUE_HOURS,
  scoreScreening,
  screeningState,
  todayLocal,
  upcomingNpo,
} from './nutrition.service.js';

/**
 * Hospital nutrition: diet orders for inpatients, malnutrition screening, kitchen meal lists and
 * automatic nil-by-mouth before scheduled operations. Kitchen staff (staff of a NUTRITION unit)
 * only ever receive the lists – name, ward, bed, diet and food restrictions – never the record.
 */
export const nutritionRouter = Router();
nutritionRouter.use(authenticate);

const PatientParam = z.object({ patientId: z.string().uuid() });
const AdmissionParam = z.object({ admissionId: z.string().uuid() });
const Restriction = z.string().trim().min(1).max(60);

const DietInput = z
  .object({
    dietType: z.enum(dietTypeEnum.enumValues),
    restrictions: z.array(Restriction).max(20).optional(),
    fluidLimitMl: z.number().int().min(100).max(10000).optional().nullable(),
    notes: z.string().trim().max(500).optional().nullable(),
    reason: z.string().trim().max(300).optional().nullable(),
    surgicalCaseId: z.string().uuid().optional().nullable(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional().nullable(),
  })
  .refine((v) => !v.endsAt || !v.startsAt || v.endsAt > v.startsAt, {
    message: 'The end must be after the start',
    path: ['endsAt'],
  });

/* ------------------------------------------------------------------ diet orders */

nutritionRouter.post('/admissions/:admissionId/diet', async (req, res) => {
  const ctx = requireAuth(req);
  const { admissionId } = parse(AdmissionParam, req.params);
  const input = parse(DietInput, req.body);
  const [admission] = await db.select().from(admissions).where(eq(admissions.id, admissionId));
  if (!admission) throw notFound('Admission not found');
  await assertClinicalWriteAccess(ctx, admission.patientId, requestMeta(req), WRITERS.careTeam);
  if (admission.status !== 'ADMITTED') {
    throw conflict('Diet orders can only be given during a hospital stay');
  }
  const startsAt = input.startsAt ?? new Date();
  if (input.endsAt && input.endsAt <= startsAt) throw badRequest('The end must be after the start');

  const created = await db.transaction(async (tx) => {
    // The new order replaces whatever is in force from its start.
    await tx
      .update(dietOrders)
      .set({ endsAt: startsAt })
      .where(
        and(
          eq(dietOrders.admissionId, admissionId),
          or(isNull(dietOrders.endsAt), gt(dietOrders.endsAt, startsAt)),
        ),
      );
    const [row] = await tx
      .insert(dietOrders)
      .values({
        patientId: admission.patientId,
        admissionId,
        dietType: input.dietType,
        restrictions: input.restrictions?.length ? input.restrictions : null,
        fluidLimitMl: input.fluidLimitMl ?? null,
        notes: input.notes || null,
        reason: input.reason || null,
        surgicalCaseId: input.surgicalCaseId ?? null,
        startsAt,
        endsAt: input.endsAt ?? null,
        orderedById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.DIET_ORDERED,
        actor: ctx,
        resourceType: 'diet_order',
        resourceId: row!.id,
        patientId: admission.patientId,
        meta: requestMeta(req),
        metadata: { dietType: input.dietType, admissionId },
      },
      tx,
    );
    return row!;
  });
  res.status(201).json(created);
});

/** A patient's diet (current and history), food allergies, fasting status and screenings. */
nutritionRouter.get('/patients/:patientId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const basis = await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'nutrition');
  const view = viewFor(basis);
  const patient = await getPatientOrThrow(patientId);
  const now = new Date();

  const [admission] = await db
    .select({ id: admissions.id, admittedAt: admissions.admittedAt, unitId: admissions.unitId })
    .from(admissions)
    .where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'ADMITTED')));
  const history = await db
    .select({
      id: dietOrders.id,
      admissionId: dietOrders.admissionId,
      dietType: dietOrders.dietType,
      restrictions: dietOrders.restrictions,
      fluidLimitMl: dietOrders.fluidLimitMl,
      notes: dietOrders.notes,
      reason: dietOrders.reason,
      surgicalCaseId: dietOrders.surgicalCaseId,
      startsAt: dietOrders.startsAt,
      endsAt: dietOrders.endsAt,
      orderedBy: users.fullName,
    })
    .from(dietOrders)
    .innerJoin(users, eq(users.id, dietOrders.orderedById))
    .where(eq(dietOrders.patientId, patientId))
    .orderBy(desc(dietOrders.startsAt))
    .limit(50);
  const current = admission
    ? (await activeOrders([admission.id], now)).get(admission.id)
    : undefined;
  const cases = await activeCases([patientId]);
  const explicit = new Set(current?.surgicalCaseId ? [current.surgicalCaseId] : []);
  const npo = admission ? (npoAt(cases, now, explicit) ?? upcomingNpo(cases, now)) : null;
  const allergyMap = await foodAllergiesFor([patientId]);
  const screenings = view.patientView
    ? []
    : await db
        .select({
          id: nutritionScreenings.id,
          tool: nutritionScreenings.tool,
          score: nutritionScreenings.score,
          risk: nutritionScreenings.risk,
          answers: nutritionScreenings.answers,
          screenedAt: nutritionScreenings.screenedAt,
          screenedBy: users.fullName,
        })
        .from(nutritionScreenings)
        .innerJoin(users, eq(users.id, nutritionScreenings.screenedById))
        .where(eq(nutritionScreenings.patientId, patientId))
        .orderBy(desc(nutritionScreenings.screenedAt))
        .limit(20);

  res.json({
    admission: admission ?? null,
    current: current ? (history.find((h) => h.id === current.id) ?? null) : null,
    history: view.patientView ? history.map(({ notes: _n, reason: _r, ...h }) => h) : history,
    foodAllergies: allergyMap.get(patientId) ?? [],
    npo,
    screenings,
    screeningState:
      admission && !view.patientView
        ? screeningState(
            admission.admittedAt,
            screenings[0] && { screenedAt: screenings[0].screenedAt },
            now,
          )
        : null,
    ageYears: ageInYears(patient.dateOfBirth, now),
    recommendedTool: ageInYears(patient.dateOfBirth, now) < 18 ? 'STRONGKIDS' : 'NRS2002',
    rules: { npoSolidsHours: NPO_SOLIDS_HOURS, npoClearFluidsHours: NPO_CLEAR_FLUIDS_HOURS },
  });
});

/* ------------------------------------------------------------------ screening */

const ScreeningInput = z.object({
  tool: z.enum(['NRS2002', 'MUST', 'STRONGKIDS']),
  answers: z.record(z.string(), z.unknown()),
});

nutritionRouter.post('/patients/:patientId/screenings', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(ScreeningInput, req.body);
  await assertClinicalWriteAccess(ctx, patientId, requestMeta(req), WRITERS.careTeam);
  const patient = await getPatientOrThrow(patientId);
  const result = scoreScreening(input.tool, input.answers, ageInYears(patient.dateOfBirth));
  const [admission] = await db
    .select({ id: admissions.id, attendingDoctorId: admissions.attendingDoctorId })
    .from(admissions)
    .where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'ADMITTED')));

  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(nutritionScreenings)
      .values({
        patientId,
        admissionId: admission?.id ?? null,
        tool: input.tool,
        score: result.score,
        risk: result.risk,
        answers: { ...input.answers, ...result.detail },
        screenedById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.NUTRITION_SCREENED,
        actor: ctx,
        resourceType: 'nutrition_screening',
        resourceId: created!.id,
        patientId,
        meta: requestMeta(req),
        metadata: { tool: input.tool, score: result.score, risk: result.risk },
      },
      tx,
    );
    if (result.risk === 'HIGH' && admission && admission.attendingDoctorId !== ctx.userId) {
      await notifyUsers(
        [admission.attendingDoctorId],
        {
          type: 'nutrition.risk',
          title: 'Nutrition risk: dietitian review recommended',
          link: `/doctor/patients/${patientId}?tab=nutrition`,
          important: true,
        },
        tx,
      );
    }
    return created!;
  });
  res.status(201).json(row);
});

/* ------------------------------------------------------------------ kitchen and wards */

const KitchenQuery = z.object({
  meal: z.enum(MEALS).default('LUNCH'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  unitId: z.string().uuid().optional(),
});

/** The meal list: per ward and bed, the diet to serve, restrictions and fasting. */
nutritionRouter.get('/kitchen', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(KitchenQuery, req.query);
  const { facilityId } = await assertNutritionListAccess(ctx, q.unitId);
  const date = q.date ?? todayLocal();
  const at = mealInstant(date, q.meal);
  const lines = await dietLines(facilityId, at, q.unitId);

  const wards = new Map<string, { unitId: string; unitName: string; patients: unknown[] }>();
  const totals: Record<string, number> = {};
  for (const { admittedAt: _a, ...l } of lines) {
    const ward = wards.get(l.unitId) ?? { unitId: l.unitId, unitName: l.unitName, patients: [] };
    ward.patients.push(l);
    wards.set(l.unitId, ward);
    totals[l.dietType] = (totals[l.dietType] ?? 0) + 1;
  }
  res.json({
    date,
    meal: q.meal,
    mealTime: MEAL_TIMES[q.meal],
    servedAt: at.toISOString(),
    wards: [...wards.values()],
    totals,
    count: lines.length,
  });
});

/** Ward overview for ward staff: diet, fasting and screening status per patient. */
nutritionRouter.get('/wards/:unitId', async (req, res) => {
  const ctx = requireAuth(req);
  const { unitId } = parse(z.object({ unitId: z.string().uuid() }), req.params);
  const { facilityId } = await assertNutritionListAccess(ctx, unitId);
  const now = new Date();
  const lines = await dietLines(facilityId, now, unitId);
  const latest = await latestScreenings(lines.map((l) => l.patientId));
  const cases = await activeCases(lines.map((l) => l.patientId));
  res.json({
    items: lines.map(({ admittedAt, ...l }) => {
      const s = latest.get(l.patientId);
      const own = cases.filter((c) => c.patientId === l.patientId);
      return {
        ...l,
        npo: l.npo ?? upcomingNpo(own, now),
        admittedAt,
        screening: s
          ? { tool: s.tool, score: s.score, risk: s.risk, screenedAt: s.screenedAt }
          : null,
        screeningState: screeningState(admittedAt, s, now),
      };
    }),
  });
});

/** Admissions without a nutrition screening since admission (due within 48 hours). */
nutritionRouter.get('/screening-due', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(z.object({ unitId: z.string().uuid().optional() }), req.query);
  const { facilityId } = await assertNutritionListAccess(ctx, q.unitId);
  const now = new Date();
  const lines = await dietLines(facilityId, now, q.unitId);
  const latest = await latestScreenings(lines.map((l) => l.patientId));
  const items = lines
    .map((l) => ({
      ...l,
      screeningState: screeningState(l.admittedAt, latest.get(l.patientId), now),
    }))
    .filter((l) => l.screeningState !== 'DONE')
    .sort((a, b) => a.admittedAt.getTime() - b.admittedAt.getTime())
    .map((l) => ({
      admissionId: l.admissionId,
      patientId: l.patientId,
      patientName: l.patientName,
      ageYears: l.ageYears,
      unitName: l.unitName,
      bedLabel: l.bedLabel,
      admittedAt: l.admittedAt,
      dueBy: new Date(l.admittedAt.getTime() + SCREENING_DUE_HOURS * 3_600_000),
      screeningState: l.screeningState,
      recommendedTool: l.ageYears < 18 ? 'STRONGKIDS' : 'NRS2002',
    }));
  res.json({ items });
});
