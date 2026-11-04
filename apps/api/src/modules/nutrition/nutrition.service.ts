import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  admissions,
  allergies,
  beds,
  careUnits,
  dietOrders,
  nutritionScreenings,
  patients,
  surgicalCases,
  unitStaff,
} from '../../db/schema.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import type { AuthContext } from '../../lib/http.js';
import { localDate, localTime, zonedToUtc } from '../scheduling/time.js';

/* ------------------------------------------------------------------ constants */

/** Solids are stopped this many hours before a scheduled operation (fasting guideline). */
export const NPO_SOLIDS_HOURS = 6;
/** Clear fluids are allowed until this many hours before the operation. */
export const NPO_CLEAR_FLUIDS_HOURS = 2;
/** After the planned end of an operation that was never closed, stop assuming NPO. */
const NPO_GRACE_HOURS = 2;
/** A nutrition screening is expected within this many hours of admission. */
export const SCREENING_DUE_HOURS = 48;

export const MEALS = ['BREAKFAST', 'LUNCH', 'DINNER'] as const;
export type Meal = (typeof MEALS)[number];
/** Local (Europe/Belgrade) serving times. */
export const MEAL_TIMES: Record<Meal, string> = {
  BREAKFAST: '08:00',
  LUNCH: '12:30',
  DINNER: '18:30',
};

/* ------------------------------------------------------------------ food allergies */

/**
 * Food allergens recognised in the allergy list (English, Albanian and Serbian spellings). The
 * kitchen sees them as restrictions; other allergies (drugs, latex) are never shown to the kitchen.
 */
const FOOD_ALLERGENS: { tag: string; patterns: RegExp }[] = [
  { tag: 'peanuts', patterns: /peanut|kikirik/i },
  { tag: 'tree nuts', patterns: /\bnuts?\b|arra|lajthi|bajame|orah|ora[sš]|le[sš]nik|badem/i },
  { tag: 'gluten', patterns: /gluten|wheat|grur|p[sš]enic|c(o)?eliac|celijak|celiaki/i },
  { tag: 'milk', patterns: /milk|lactose|laktoz|dairy|qum[eë]sht|mleko|mlijeko/i },
  { tag: 'egg', patterns: /\beggs?\b|vez[eë]?|\bjaj[ae]\b|\bjaje\b/i },
  { tag: 'fish', patterns: /\bfish\b|peshk|\bribe?\b/i },
  { tag: 'shellfish', patterns: /shellfish|shrimp|crustacean|karkalec|[sš]kamp|\brakovi\b/i },
  { tag: 'soy', patterns: /\bsoy|\bsoja|soj[eë]/i },
  { tag: 'sesame', patterns: /sesame|susam/i },
];

export function foodAllergyTags(substances: string[]): string[] {
  const tags = new Set<string>();
  for (const s of substances) {
    for (const a of FOOD_ALLERGENS) if (a.patterns.test(s)) tags.add(a.tag);
  }
  return [...tags];
}

/** Food allergies per patient (active allergy entries only). */
export async function foodAllergiesFor(patientIds: string[], executor: Executor = db) {
  const out = new Map<string, string[]>();
  if (!patientIds.length) return out;
  const rows = await executor
    .select({ patientId: allergies.patientId, substance: allergies.substance })
    .from(allergies)
    .where(
      and(
        inArray(allergies.patientId, patientIds),
        inArray(allergies.verificationStatus, ['UNCONFIRMED', 'CONFIRMED']),
      ),
    );
  const grouped = new Map<string, string[]>();
  for (const r of rows)
    grouped.set(r.patientId, [...(grouped.get(r.patientId) ?? []), r.substance]);
  for (const [id, subs] of grouped) {
    const tags = foodAllergyTags(subs);
    if (tags.length) out.set(id, tags);
  }
  return out;
}

/* ------------------------------------------------------------------ screening */

export type ScreeningTool = 'NRS2002' | 'MUST' | 'STRONGKIDS';
export type Risk = 'LOW' | 'MEDIUM' | 'HIGH';

export interface Nrs2002Answers {
  /** Initial screening; if all four are false the patient is not at risk (rescreen weekly). */
  initial?: {
    bmiBelow20_5: boolean;
    weightLoss3Months: boolean;
    reducedIntakeLastWeek: boolean;
    severelyIll: boolean;
  };
  /** Impaired nutritional status 0–3. */
  nutritionalStatus: number;
  /** Severity of disease (stress metabolism) 0–3. */
  diseaseSeverity: number;
}
export interface StrongKidsAnswers {
  /** Subjective clinical assessment: poor nutritional status (1 point). */
  poorNutritionalStatus: boolean;
  /** Underlying illness with high risk of malnutrition or major surgery (2 points). */
  highRiskDisease: boolean;
  /** Excessive diarrhoea/vomiting, reduced intake, pre-existing intervention, pain (1 point). */
  intakeOrLosses: boolean;
  /** Weight loss or no weight gain (infants) in recent weeks/months (1 point). */
  weightLoss: boolean;
}
export interface MustAnswers {
  /** BMI score 0 (>20), 1 (18.5–20), 2 (<18.5). */
  bmiScore: number;
  /** Unplanned weight loss in 3–6 months: 0 (<5 %), 1 (5–10 %), 2 (>10 %). */
  weightLossScore: number;
  /** Acutely ill and no intake for >5 days (2 points). */
  acuteDisease: boolean;
}

const int03 = (v: unknown, max: number) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
    throw badRequest(`Each score must be a whole number between 0 and ${max}`);
  }
  return v;
};
const bool = (v: unknown) => {
  if (typeof v !== 'boolean') throw badRequest('Answer every question with yes or no');
  return v;
};

/** Computes score and risk server-side; answers are validated per tool. */
export function scoreScreening(
  tool: ScreeningTool,
  answers: Record<string, unknown>,
  ageYears: number,
): { score: number; risk: Risk; detail: Record<string, unknown> } {
  if (tool === 'STRONGKIDS') {
    if (ageYears >= 18) throw badRequest('STRONGkids is for children; use NRS-2002 for adults');
    const a = answers as unknown as StrongKidsAnswers;
    const score =
      (bool(a.poorNutritionalStatus) ? 1 : 0) +
      (bool(a.highRiskDisease) ? 2 : 0) +
      (bool(a.intakeOrLosses) ? 1 : 0) +
      (bool(a.weightLoss) ? 1 : 0);
    return { score, risk: score === 0 ? 'LOW' : score <= 3 ? 'MEDIUM' : 'HIGH', detail: {} };
  }
  if (ageYears < 18) throw badRequest('Use STRONGkids for children under 18');
  if (tool === 'MUST') {
    const a = answers as unknown as MustAnswers;
    const score =
      int03(a.bmiScore, 2) + int03(a.weightLossScore, 2) + (bool(a.acuteDisease) ? 2 : 0);
    return { score, risk: score === 0 ? 'LOW' : score === 1 ? 'MEDIUM' : 'HIGH', detail: {} };
  }
  const a = answers as unknown as Nrs2002Answers;
  if (a.initial) {
    const i = a.initial;
    const anyYes =
      bool(i.bmiBelow20_5) ||
      bool(i.weightLoss3Months) ||
      bool(i.reducedIntakeLastWeek) ||
      bool(i.severelyIll);
    if (!anyYes) return { score: 0, risk: 'LOW', detail: { initialNegative: true } };
  }
  const ageAdjustment = ageYears >= 70 ? 1 : 0;
  const score = int03(a.nutritionalStatus, 3) + int03(a.diseaseSeverity, 3) + ageAdjustment;
  return { score, risk: score >= 3 ? 'HIGH' : 'LOW', detail: { ageAdjustment } };
}

export function ageInYears(dateOfBirth: string, at = new Date()): number {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let a = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) a--;
  return a;
}

/* ------------------------------------------------------------------ nil by mouth */

export interface NpoStatus {
  /** SOLIDS: no food, clear fluids allowed; FULL: nothing by mouth. */
  level: 'SOLIDS' | 'FULL';
  surgicalCaseId: string;
  procedure: string;
  operationAt: string;
  solidsFrom: string;
  fluidsFrom: string;
  /** Local times "HH:MM" for display. */
  solidsFromLocal: string;
  fluidsFromLocal: string;
}

interface CaseRow {
  id: string;
  patientId: string;
  procedure: string;
  status: string;
  scheduledStart: Date | null;
  estimatedMinutes: number;
}

/** Upcoming or ongoing operations of these patients (SCHEDULED or IN_THEATRE). */
export async function activeCases(patientIds: string[], executor: Executor = db) {
  if (!patientIds.length) return [] as CaseRow[];
  return executor
    .select({
      id: surgicalCases.id,
      patientId: surgicalCases.patientId,
      procedure: surgicalCases.procedure,
      status: surgicalCases.status,
      scheduledStart: surgicalCases.scheduledStart,
      estimatedMinutes: surgicalCases.estimatedMinutes,
    })
    .from(surgicalCases)
    .where(
      and(
        inArray(surgicalCases.patientId, patientIds),
        inArray(surgicalCases.status, ['SCHEDULED', 'IN_THEATRE']),
      ),
    )
    .orderBy(asc(surgicalCases.scheduledStart));
}

/**
 * Nil-by-mouth status at `at` derived from a scheduled operation: solids stop 6 h before, clear
 * fluids 2 h before. An operation in theatre means nothing by mouth. Once the operation is
 * completed or cancelled the normal diet resumes automatically (the case is no longer active).
 * An explicit diet order linked to the operation replaces the computed rule.
 */
export function npoAt(
  cases: CaseRow[],
  at: Date,
  explicitCaseIds: Set<string> = new Set(),
): NpoStatus | null {
  for (const c of cases) {
    if (!c.scheduledStart || explicitCaseIds.has(c.id)) continue;
    const start = c.scheduledStart.getTime();
    const solidsFrom = new Date(start - NPO_SOLIDS_HOURS * 3_600_000);
    const fluidsFrom = new Date(start - NPO_CLEAR_FLUIDS_HOURS * 3_600_000);
    const until = start + (c.estimatedMinutes + NPO_GRACE_HOURS * 60) * 60_000;
    const t = at.getTime();
    const inTheatre = c.status === 'IN_THEATRE';
    if (!inTheatre && (t < solidsFrom.getTime() || t > until)) continue;
    return {
      level: inTheatre || t >= fluidsFrom.getTime() ? 'FULL' : 'SOLIDS',
      surgicalCaseId: c.id,
      procedure: c.procedure,
      operationAt: c.scheduledStart.toISOString(),
      solidsFrom: solidsFrom.toISOString(),
      fluidsFrom: fluidsFrom.toISOString(),
      solidsFromLocal: localTime(solidsFrom),
      fluidsFromLocal: localTime(fluidsFrom),
    };
  }
  return null;
}

/** The next operation that will require fasting (for "NPO from HH:MM" notices ahead of time). */
export function upcomingNpo(cases: CaseRow[], from: Date): NpoStatus | null {
  const now = npoAt(cases, from);
  if (now) return now;
  const next = cases.find((c) => c.scheduledStart && c.scheduledStart.getTime() > from.getTime());
  return next ? npoAt([next], new Date(next.scheduledStart!.getTime() - 1)) : null;
}

/* ------------------------------------------------------------------ diet orders */

export type DietOrderRow = typeof dietOrders.$inferSelect;

/** The diet order in force at `at` for each admission (latest start wins). */
export async function activeOrders(admissionIds: string[], at: Date, executor: Executor = db) {
  const out = new Map<string, DietOrderRow>();
  if (!admissionIds.length) return out;
  const rows = await executor
    .select()
    .from(dietOrders)
    .where(
      and(
        inArray(dietOrders.admissionId, admissionIds),
        lte(dietOrders.startsAt, at),
        or(isNull(dietOrders.endsAt), gt(dietOrders.endsAt, at)),
      ),
    )
    .orderBy(desc(dietOrders.startsAt), desc(dietOrders.createdAt));
  for (const r of rows) if (!out.has(r.admissionId)) out.set(r.admissionId, r);
  return out;
}

/* ------------------------------------------------------------------ access */

export async function unitIdsOf(userId: string, facilityId: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: careUnits.id, type: careUnits.type })
    .from(unitStaff)
    .innerJoin(careUnits, eq(careUnits.id, unitStaff.unitId))
    .where(
      and(
        eq(unitStaff.userId, userId),
        eq(careUnits.facilityId, facilityId),
        eq(careUnits.isActive, true),
      ),
    );
  return rows;
}

/**
 * Kitchen and ward lists: staff of the facility's NUTRITION unit (kitchen, dietitians), nurses
 * and doctors assigned to a ward, and doctors of the facility. Kitchen staff never get clinical
 * record access – these lists only carry what is needed to serve the right meal.
 */
export async function assertNutritionListAccess(ctx: AuthContext, unitId?: string) {
  if (!ctx.facilityId || !['NURSE', 'DOCTOR'].includes(ctx.role)) {
    throw forbidden('Only ward staff and the hospital kitchen can see meal lists');
  }
  const units = await unitIdsOf(ctx.userId, ctx.facilityId);
  const kitchen = units.some((u) => u.type === 'NUTRITION');
  if (kitchen) return { facilityId: ctx.facilityId, kitchen: true };
  if (unitId) {
    if (ctx.role === 'DOCTOR' || units.some((u) => u.id === unitId)) {
      return { facilityId: ctx.facilityId, kitchen: false };
    }
    throw forbidden('You are not assigned to this ward');
  }
  if (ctx.role === 'DOCTOR' || units.length) return { facilityId: ctx.facilityId, kitchen: false };
  throw forbidden('Only ward staff and the hospital kitchen can see meal lists');
}

/* ------------------------------------------------------------------ lists */

export interface PatientDietLine {
  admissionId: string;
  patientId: string;
  patientName: string;
  ageYears: number;
  unitId: string;
  unitName: string;
  bedLabel: string | null;
  dietType: string;
  hasOrder: boolean;
  restrictions: string[];
  foodAllergies: string[];
  fluidLimitMl: number | null;
  notes: string | null;
  npo: NpoStatus | null;
  temporaryIdentity: string | null;
}

/** Currently admitted patients at the facility (optionally one unit) with their diet at `at`. */
export async function dietLines(facilityId: string, at: Date, unitId?: string) {
  const rows = await db
    .select({
      admissionId: admissions.id,
      patientId: admissions.patientId,
      unitId: admissions.unitId,
      unitName: careUnits.name,
      bedLabel: beds.label,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dateOfBirth: patients.dateOfBirth,
      temporaryIdentity: patients.temporaryIdentity,
      admittedAt: admissions.admittedAt,
    })
    .from(admissions)
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .leftJoin(beds, eq(beds.id, admissions.bedId))
    .where(
      and(
        eq(admissions.facilityId, facilityId),
        eq(admissions.status, 'ADMITTED'),
        unitId ? eq(admissions.unitId, unitId) : undefined,
      ),
    )
    .orderBy(asc(careUnits.name), sql`${beds.label} NULLS LAST`, asc(patients.lastName));
  const admissionIds = rows.map((r) => r.admissionId);
  const patientIds = rows.map((r) => r.patientId);
  const [orders, allergyMap, cases] = await Promise.all([
    activeOrders(admissionIds, at),
    foodAllergiesFor(patientIds),
    activeCases(patientIds),
  ]);
  const casesByPatient = new Map<string, CaseRow[]>();
  for (const c of cases)
    casesByPatient.set(c.patientId, [...(casesByPatient.get(c.patientId) ?? []), c]);

  return rows.map((r): PatientDietLine & { admittedAt: Date } => {
    const order = orders.get(r.admissionId);
    const explicit = new Set(order?.surgicalCaseId ? [order.surgicalCaseId] : []);
    const npo = npoAt(casesByPatient.get(r.patientId) ?? [], at, explicit);
    return {
      admissionId: r.admissionId,
      patientId: r.patientId,
      patientName: `${r.firstName} ${r.lastName}`,
      ageYears: ageInYears(r.dateOfBirth, at),
      unitId: r.unitId,
      unitName: r.unitName,
      bedLabel: r.bedLabel,
      dietType: npo ? 'NIL_BY_MOUTH' : (order?.dietType ?? 'NORMAL'),
      hasOrder: Boolean(order),
      restrictions: order?.restrictions ?? [],
      foodAllergies: allergyMap.get(r.patientId) ?? [],
      fluidLimitMl: order?.fluidLimitMl ?? null,
      notes: order?.notes ?? null,
      npo,
      temporaryIdentity: r.temporaryIdentity,
      admittedAt: r.admittedAt,
    };
  });
}

/** Latest screening per patient. */
export async function latestScreenings(patientIds: string[], executor: Executor = db) {
  const out = new Map<string, typeof nutritionScreenings.$inferSelect>();
  if (!patientIds.length) return out;
  const rows = await executor
    .select()
    .from(nutritionScreenings)
    .where(inArray(nutritionScreenings.patientId, patientIds))
    .orderBy(desc(nutritionScreenings.screenedAt));
  for (const r of rows) if (!out.has(r.patientId)) out.set(r.patientId, r);
  return out;
}

/** Screening status of an admission: done since admission, due (<48 h) or overdue. */
export function screeningState(
  admittedAt: Date,
  latest: { screenedAt: Date } | undefined,
  now = new Date(),
): 'DONE' | 'DUE' | 'OVERDUE' {
  if (latest && latest.screenedAt.getTime() >= admittedAt.getTime()) return 'DONE';
  return now.getTime() - admittedAt.getTime() > SCREENING_DUE_HOURS * 3_600_000 ? 'OVERDUE' : 'DUE';
}

/** UTC instant of a meal on a local date. */
export function mealInstant(date: string, meal: Meal): Date {
  const at = zonedToUtc(date, MEAL_TIMES[meal]);
  if (!at) throw badRequest('Invalid date');
  return at;
}

export const todayLocal = () => localDate(new Date());
