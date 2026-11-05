/**
 * Structured dosing and dose-range checks (hazard H16). A prescription can carry a structured dose
 * (amount + unit, route, frequency code, duration, as needed); the engine converts it to an amount
 * of each active ingredient – using the catalogue strength for tablets, capsules, millilitres and
 * puffs – and compares single and daily doses with the Ministry's dose rules for the patient's age
 * group and route. Per-kilogram rules use the latest weight from vital signs.
 *
 * DEMO DOSE LIMITS – verify against a licensed reference before clinical use.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import { doseRules } from '../../db/schema.js';
import { tr, type Locale } from '../../i18n/index.js';
import type { EngineAlert } from './engine.js';
import { BLOCKING, type Severity } from './knowledge.js';

export const DOSE_DISCLAIMER = 'Demo dose limits – verify against a licensed reference';

export const DOSE_UNITS = [
  'mg',
  'g',
  'mcg',
  'ml',
  'IU',
  'units',
  'tablet',
  'capsule',
  'puff',
  'drop',
  'mg/kg',
] as const;
export type DoseUnit = (typeof DOSE_UNITS)[number];

/** Route codes as stored on prescriptions (the rules use the upper-case form). */
export const ROUTES = [
  'oral',
  'IV',
  'IM',
  'SC',
  'inhaled',
  'topical',
  'rectal',
  'sublingual',
  'nasal',
  'ophthalmic',
  'otic',
] as const;
export type RouteCode = (typeof ROUTES)[number];

export const FREQUENCY_CODES = [
  'QD',
  'BID',
  'TID',
  'QID',
  'Q4H',
  'Q6H',
  'Q8H',
  'Q12H',
  'QHS',
  'PRN',
  'STAT',
  'WEEKLY',
] as const;
export type FrequencyCode = (typeof FREQUENCY_CODES)[number];

export const AGE_GROUPS = ['ADULT', 'CHILD', 'NEONATE', 'ELDERLY'] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

/** Administrations per day for each frequency code (PRN uses the maximum doses in 24 hours). */
export const TIMES_PER_DAY: Record<Exclude<FrequencyCode, 'PRN'>, number> = {
  QD: 1,
  BID: 2,
  TID: 3,
  QID: 4,
  Q4H: 6,
  Q6H: 4,
  Q8H: 3,
  Q12H: 2,
  QHS: 1,
  STAT: 1,
  WEEKLY: 1 / 7,
};

/** A structured dose as the prescriber enters it. */
export interface StructuredDose {
  doseAmount: number;
  doseUnit: DoseUnit;
  frequencyCode: FrequencyCode;
  /** Required for PRN; optional cap for "as needed" with another frequency. */
  maxDosesPer24h?: number | null;
  durationDays?: number | null;
  asNeeded?: boolean | null;
  route?: string | null;
}

export const StructuredDoseSchema = z
  .object({
    doseAmount: z.coerce.number().positive().max(1_000_000),
    doseUnit: z.enum(DOSE_UNITS),
    frequencyCode: z.enum(FREQUENCY_CODES),
    maxDosesPer24h: z.coerce.number().int().min(1).max(24).optional().nullable(),
    durationDays: z.coerce.number().int().min(1).max(3650).optional().nullable(),
    asNeeded: z.boolean().optional().nullable(),
    route: z.string().trim().min(1).max(50).optional().nullable(),
  })
  .refine((d) => d.frequencyCode !== 'PRN' || Boolean(d.maxDosesPer24h), {
    message: 'Give the maximum number of doses in 24 hours for an as-needed prescription',
    path: ['maxDosesPer24h'],
  });

/* ------------------------------------------------------------------ routes, age ------------- */

const ROUTE_ALIASES: Record<string, string> = {
  PO: 'ORAL',
  'BY MOUTH': 'ORAL',
  'PER OS': 'ORAL',
  INTRAVENOUS: 'IV',
  'I.V.': 'IV',
  INTRAMUSCULAR: 'IM',
  'I.M.': 'IM',
  SUBCUTANEOUS: 'SC',
  SUBCUT: 'SC',
  'S.C.': 'SC',
  SQ: 'SC',
  INHALATION: 'INHALED',
  INH: 'INHALED',
  PR: 'RECTAL',
  SL: 'SUBLINGUAL',
  INTRANASAL: 'NASAL',
  EYE: 'OPHTHALMIC',
  EAR: 'OTIC',
};

/** Free-text or coded route → the upper-case code used by dose rules ("oral" → "ORAL"). */
export function normaliseRoute(route: string | null | undefined): string {
  const r = (route ?? '').trim().toUpperCase();
  if (!r) return 'ORAL';
  return ROUTE_ALIASES[r] ?? r;
}

/** Upper-case rule route → the code stored on prescriptions ("ORAL" → "oral"). */
export function routeCode(route: string | null | undefined): string {
  const n = normaliseRoute(route);
  return ROUTES.find((r) => r.toUpperCase() === n) ?? (route ?? 'oral').trim();
}

export function ageGroupOf(ageDays: number | null | undefined, ageYears: number | null): AgeGroup {
  if (ageDays !== null && ageDays !== undefined && ageDays < 28) return 'NEONATE';
  if (ageYears === null) return 'ADULT';
  if (ageYears < 18) return 'CHILD';
  if (ageYears >= 65) return 'ELDERLY';
  return 'ADULT';
}

/** Which rule groups apply, most specific first (children never exceed adult maximums). */
const FALLBACK: Record<AgeGroup, AgeGroup[]> = {
  NEONATE: ['NEONATE', 'CHILD', 'ADULT'],
  CHILD: ['CHILD', 'ADULT'],
  ELDERLY: ['ELDERLY', 'ADULT'],
  ADULT: ['ADULT'],
};

/* ------------------------------------------------------------------ strength ---------------- */

type Dim = 'mass' | 'units';
interface Quantity {
  value: number;
  dim: Dim;
}

/** Amount (mg or units) of each ingredient per tablet/capsule/puff ("unit") or per millilitre. */
export interface Strength {
  per: 'unit' | 'ml';
  amounts: Quantity[];
}

const MASS: Record<string, number> = { g: 1000, mg: 1, mcg: 0.001, µg: 0.001, ug: 0.001 };
const UNITS = new Set(['iu', 'u', 'unit', 'units', 'ie']);

function toQuantity(value: number, unit: string): Quantity | null {
  const u = unit.toLowerCase();
  if (MASS[u] !== undefined) return { value: value * MASS[u]!, dim: 'mass' };
  if (UNITS.has(u)) return { value, dim: 'units' };
  return null;
}

/**
 * Parses a catalogue strength: "500 mg" (per tablet), "875/125 mg", "10 mg/ml", "40 mg/0.4 ml",
 * "100 mcg/dose", "100 U/ml", "0.9 %" (g per 100 ml). Returns null when it cannot be read.
 */
export function parseStrength(strength: string | null | undefined): Strength | null {
  if (!strength) return null;
  const s = strength.trim().toLowerCase().replace(/,/g, '.').replace(/\s+/g, ' ');
  const pct = /^(\d+(?:\.\d+)?) ?%$/.exec(s);
  if (pct) return { per: 'ml', amounts: [{ value: Number(pct[1]) * 10, dim: 'mass' }] };
  const m =
    /^(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)*) ?(mg|g|mcg|µg|ug|iu|u|units?|ie)(?: ?\/ ?(\d+(?:\.\d+)?)? ?(ml|dose|puff|actuation|tablet|capsule))?$/.exec(
      s,
    );
  if (!m) return null;
  const perMl = m[4] === 'ml';
  const volume = perMl ? Number(m[3] ?? 1) : 1;
  if (!(volume > 0)) return null;
  const amounts: Quantity[] = [];
  for (const part of m[1]!.split('/')) {
    const q = toQuantity(Number(part) / volume, m[2]!);
    if (!q || !(q.value > 0)) return null;
    amounts.push(q);
  }
  return { per: perMl ? 'ml' : 'unit', amounts };
}

/* ------------------------------------------------------------------ dose → ingredients ------ */

export interface IngredientDose {
  ingredient: string;
  /** Amount per administration in mg (mass) or units. */
  single: number;
  dim: Dim;
}

export type NotComputedReason = 'NEEDS_WEIGHT' | 'NEEDS_STRENGTH' | 'UNIT_MISMATCH';

/**
 * Converts a structured dose into the amount of each ingredient per administration. A mass dose
 * of a combination product refers to its first ingredient ("875 mg" of 875/125 mg) and the others
 * follow the strength ratio.
 */
export function ingredientDoses(
  dose: Pick<StructuredDose, 'doseAmount' | 'doseUnit'>,
  ingredients: string[],
  strength: Strength | null,
  weightKg: number | null,
): { doses: IngredientDose[]; notComputed?: NotComputedReason } {
  if (!ingredients.length) return { doses: [] };
  const unit = dose.doseUnit;
  let first: Quantity | null = null;
  if (unit === 'mg' || unit === 'g' || unit === 'mcg') first = toQuantity(dose.doseAmount, unit);
  else if (unit === 'mg/kg') {
    if (!weightKg) return { doses: [], notComputed: 'NEEDS_WEIGHT' };
    first = { value: dose.doseAmount * weightKg, dim: 'mass' };
  } else if (unit === 'IU' || unit === 'units') first = { value: dose.doseAmount, dim: 'units' };

  if (first) {
    // Spread over the ingredients by the strength ratio when the strength lists all of them.
    if (ingredients.length > 1 && strength?.amounts.length === ingredients.length) {
      const base = strength.amounts[0]!;
      if (base.dim === first.dim) {
        return {
          doses: ingredients.map((ingredient, i) => ({
            ingredient,
            single: (first.value * strength.amounts[i]!.value) / base.value,
            dim: strength.amounts[i]!.dim,
          })),
        };
      }
    }
    return { doses: [{ ingredient: ingredients[0]!, single: first.value, dim: first.dim }] };
  }

  // Countable units and volumes need the catalogue strength.
  const per = unit === 'ml' ? 'ml' : unit === 'drop' ? null : 'unit';
  if (!strength || !per) return { doses: [], notComputed: 'NEEDS_STRENGTH' };
  if (strength.per !== per) return { doses: [], notComputed: 'UNIT_MISMATCH' };
  if (strength.amounts.length !== ingredients.length && strength.amounts.length !== 1) {
    return { doses: [], notComputed: 'NEEDS_STRENGTH' };
  }
  return {
    doses: strength.amounts.slice(0, ingredients.length).map((q, i) => ({
      ingredient: ingredients[i]!,
      single: q.value * dose.doseAmount,
      dim: q.dim,
    })),
  };
}

/** Administrations in 24 hours (PRN: the stated maximum; "as needed" never exceeds its cap). */
export function timesPerDay(
  dose: Pick<StructuredDose, 'frequencyCode' | 'maxDosesPer24h' | 'asNeeded'>,
): number {
  if (dose.frequencyCode === 'PRN') return dose.maxDosesPer24h ?? 1;
  const n = TIMES_PER_DAY[dose.frequencyCode];
  return dose.asNeeded && dose.maxDosesPer24h ? Math.min(n, dose.maxDosesPer24h) : n;
}

/* ------------------------------------------------------------------ rules cache ------------- */

export interface DoseRule {
  id: string;
  ingredient: string;
  route: string;
  ageGroup: AgeGroup;
  unit: string;
  perKg: boolean;
  maxSingleDose: number | null;
  maxDailyDose: number | null;
  absoluteMaxDaily: number | null;
  note: string | null;
}

let ruleCache: { at: number; rules: Map<string, DoseRule> } | null = null;

export function invalidateDoseRuleCache() {
  ruleCache = null;
}

const ruleKey = (ingredient: string, route: string, group: string) =>
  `${ingredient}|${route}|${group}`;
const num = (v: string | null) => (v === null ? null : Number(v));

export async function doseRuleIndex(executor: Executor = db): Promise<Map<string, DoseRule>> {
  if (ruleCache && Date.now() - ruleCache.at < 60_000) return ruleCache.rules;
  const rows = await executor.select().from(doseRules).where(eq(doseRules.isActive, true));
  const rules = new Map<string, DoseRule>();
  for (const r of rows) {
    rules.set(ruleKey(r.ingredient, normaliseRoute(r.route), r.ageGroup), {
      id: r.id,
      ingredient: r.ingredient,
      route: normaliseRoute(r.route),
      ageGroup: r.ageGroup as AgeGroup,
      unit: r.unit,
      perKg: r.perKg,
      maxSingleDose: num(r.maxSingleDose),
      maxDailyDose: num(r.maxDailyDose),
      absoluteMaxDaily: num(r.absoluteMaxDaily),
      note: r.note,
    });
  }
  ruleCache = { at: Date.now(), rules };
  return rules;
}

export function findRule(
  rules: Map<string, DoseRule>,
  ingredient: string,
  route: string,
  group: AgeGroup,
): DoseRule | null {
  for (const g of FALLBACK[group]) {
    const r = rules.get(ruleKey(ingredient, normaliseRoute(route), g));
    if (r) return r;
  }
  return null;
}

/** A rule's limit in mg (mass) or units, or null when the unit is not convertible. */
function ruleQuantity(rule: DoseRule, value: number | null): Quantity | null {
  if (value === null) return null;
  return toQuantity(value, rule.unit === 'IU' ? 'iu' : rule.unit);
}

/* ------------------------------------------------------------------ formatting -------------- */

const round = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 100) / 100);

/** "4 g", "1500 mg", "250 mcg", "20 IU" – avoids decimals where a larger unit would need them. */
export function formatQuantity(value: number, dim: Dim): string {
  if (dim === 'units') return `${round(value)} IU`;
  if (value >= 1000 && Number.isInteger(Math.round(value * 1000) / 1_000_000)) {
    return `${round(value / 1000)} g`;
  }
  if (value < 1) return `${round(value * 1000)} mcg`;
  return `${round(value)} mg`;
}

/* ------------------------------------------------------------------ evaluation -------------- */

export interface DosingPatient {
  ageYears: number | null;
  ageDays?: number | null;
  weightKg?: number | null;
  weightAt?: Date | null;
}

export interface IngredientCheck {
  ingredient: string;
  singleDose: string | null;
  dailyDose: string | null;
  ruleId: string | null;
  ruleAgeGroup: AgeGroup | null;
  maxSingle: string | null;
  maxDaily: string | null;
  note: string | null;
  checked: boolean;
}

export interface DoseSummary {
  ageGroup: AgeGroup;
  weightKg: number | null;
  weightRecordedAt: Date | null;
  timesPerDay: number | null;
  notComputed: NotComputedReason | null;
  ingredients: IngredientCheck[];
}

const DOSE_MANAGEMENT =
  'Check the dose against a licensed reference and correct it, or record why it is intended.';
const WEIGHT_MANAGEMENT = 'Record the patient’s weight in vital signs, then check the dose again.';

function doseAlert(
  key: string,
  severity: Severity,
  template: string,
  vars: Record<string, string | number>,
  management: string,
  details: Record<string, unknown>,
): EngineAlert {
  return {
    code: `DOSE:${key}`,
    kind: 'DOSE',
    severity,
    blocking: BLOCKING.includes(severity),
    template,
    vars,
    management,
    details,
  };
}

const OVER = (ratio: number): Severity => (ratio > 2 ? 'CONTRAINDICATED' : 'MAJOR');
const STALE_CHILD_WEIGHT_DAYS = 30;

/**
 * Pure dose-range evaluation of a structured dose for a patient. Returns DOSE alerts and a summary
 * (computed doses and applied rules) for the prescriber's preview.
 */
export function evaluateDose(
  patient: DosingPatient,
  candidate: { ingredients: string[]; strength?: string | null },
  dose: StructuredDose,
  rules: Map<string, DoseRule>,
  now = new Date(),
): { alerts: EngineAlert[]; summary: DoseSummary } {
  const group = ageGroupOf(patient.ageDays ?? null, patient.ageYears);
  const weight = patient.weightKg && patient.weightKg > 0 ? patient.weightKg : null;
  const route = normaliseRoute(dose.route);
  const alerts: EngineAlert[] = [];
  const times = timesPerDay(dose);
  const strength = parseStrength(candidate.strength);
  const { doses, notComputed } = ingredientDoses(dose, candidate.ingredients, strength, weight);
  const paediatric = group === 'CHILD' || group === 'NEONATE';
  const regular =
    !dose.asNeeded && !['PRN', 'STAT', 'WEEKLY'].includes(dose.frequencyCode) && times >= 1;
  const summary: DoseSummary = {
    ageGroup: group,
    weightKg: weight,
    weightRecordedAt: weight ? (patient.weightAt ?? null) : null,
    timesPerDay: times,
    notComputed: notComputed ?? null,
    ingredients: [],
  };

  let weightNeeded = notComputed === 'NEEDS_WEIGHT';
  const rulesUsed = new Map<string, DoseRule | null>();
  for (const ing of candidate.ingredients) {
    rulesUsed.set(ing, findRule(rules, ing, route, group));
  }

  for (const ing of candidate.ingredients) {
    const rule = rulesUsed.get(ing) ?? null;
    const d = doses.find((x) => x.ingredient === ing);
    const check: IngredientCheck = {
      ingredient: ing,
      singleDose: d ? formatQuantity(d.single, d.dim) : null,
      dailyDose: d ? formatQuantity(d.single * times, d.dim) : null,
      ruleId: rule?.id ?? null,
      ruleAgeGroup: rule?.ageGroup ?? null,
      maxSingle: null,
      maxDaily: null,
      note: rule?.note ?? null,
      checked: false,
    };
    summary.ingredients.push(check);
    if (!rule) continue;
    if (rule.perKg && !weight) weightNeeded = true;
    if (!d) continue;

    const factor = rule.perKg ? weight : 1;
    const single = ruleQuantity(rule, rule.maxSingleDose);
    const daily = ruleQuantity(rule, rule.maxDailyDose);
    const absolute = ruleQuantity(rule, rule.absoluteMaxDaily);
    const sameDim = (q: Quantity | null) => q && q.dim === d.dim;
    const limitSingle = factor && sameDim(single) ? single!.value * factor : null;
    let limitDaily = factor && sameDim(daily) ? daily!.value * factor : null;
    let dailyIsAbsolute = false;
    if (sameDim(absolute) && (limitDaily === null || absolute!.value < limitDaily)) {
      limitDaily = absolute!.value;
      dailyIsAbsolute = true;
    }
    if (limitSingle === null && limitDaily === null) continue;
    check.checked = true;
    check.maxSingle = limitSingle !== null ? formatQuantity(limitSingle, d.dim) : null;
    check.maxDaily = limitDaily !== null ? formatQuantity(limitDaily, d.dim) : null;

    const dailyAmount = d.single * times;
    const management = rule.note ?? DOSE_MANAGEMENT;
    const base = {
      ingredient: ing,
      ruleId: rule.id,
      ruleAgeGroup: rule.ageGroup,
      ageGroup: group,
      route,
      weightKg: weight,
      note: rule.note,
    };
    const perKgVars = (limit: number | null) =>
      rule.perKg && weight && limit !== null
        ? { limit: `${round(limit)} ${rule.unit}/kg`, weight: String(round(weight)) }
        : null;

    if (limitSingle !== null && d.single > limitSingle * 1.0001) {
      const pk = perKgVars(rule.maxSingleDose);
      alerts.push(
        doseAlert(
          `${ing}:single`,
          OVER(d.single / limitSingle),
          pk
            ? 'Single dose of {ingredient} is {dose}, above the maximum of {max} per dose ({limit} for {weight} kg).'
            : 'Single dose of {ingredient} is {dose}, above the maximum of {max} per dose.',
          {
            ingredient: ing,
            dose: formatQuantity(d.single, d.dim),
            max: formatQuantity(limitSingle, d.dim),
            ...pk,
          },
          management,
          { ...base, single: d.single, limit: limitSingle },
        ),
      );
    }
    if (limitDaily !== null && dailyAmount > limitDaily * 1.0001) {
      const pk = dailyIsAbsolute ? null : perKgVars(rule.maxDailyDose);
      alerts.push(
        doseAlert(
          `${ing}:daily`,
          OVER(dailyAmount / limitDaily),
          dailyIsAbsolute && rule.perKg
            ? 'Daily dose of {ingredient} is {dose} ({times} × {single}), above the absolute maximum of {max} per day.'
            : pk
              ? 'Daily dose of {ingredient} is {dose} ({times} × {single}), above the maximum of {max} per day ({limit} for {weight} kg).'
              : 'Daily dose of {ingredient} is {dose} ({times} × {single}), above the maximum of {max} per day.',
          {
            ingredient: ing,
            dose: formatQuantity(dailyAmount, d.dim),
            times: round(times),
            single: formatQuantity(d.single, d.dim),
            max: formatQuantity(limitDaily, d.dim),
            ...pk,
          },
          management,
          { ...base, daily: dailyAmount, limit: limitDaily, timesPerDay: times },
        ),
      );
    } else if (
      // Unusually low (a decimal or unit slip): under 10% of the daily maximum – and of the
      // single maximum, so low-dose regimens such as aspirin 100 mg do not alert.
      regular &&
      limitDaily !== null &&
      dailyAmount < limitDaily * 0.1 &&
      (limitSingle === null || d.single < limitSingle * 0.1)
    ) {
      alerts.push(
        doseAlert(
          `${ing}:low`,
          'MINOR',
          'Daily dose of {ingredient} is {dose}, less than 10% of the maximum of {max} per day – check for a decimal or unit error.',
          {
            ingredient: ing,
            dose: formatQuantity(dailyAmount, d.dim),
            max: formatQuantity(limitDaily, d.dim),
          },
          DOSE_MANAGEMENT,
          { ...base, daily: dailyAmount, limit: limitDaily },
        ),
      );
    }
  }

  if (weightNeeded) {
    alerts.push(
      doseAlert(
        'weight',
        'MAJOR',
        paediatric
          ? 'No weight recorded: weight is needed for paediatric dosing of {medication}.'
          : 'No weight recorded: the dose of {medication} depends on body weight.',
        { medication: candidate.ingredients.join(' + ') },
        WEIGHT_MANAGEMENT,
        { ageGroup: group },
      ),
    );
  } else if (
    paediatric &&
    weight &&
    patient.weightAt &&
    now.getTime() - patient.weightAt.getTime() > STALE_CHILD_WEIGHT_DAYS * 86_400_000 &&
    [...rulesUsed.values()].some((r) => r?.perKg)
  ) {
    alerts.push(
      doseAlert(
        'weight-date',
        'MINOR',
        'The last recorded weight ({weight} kg, {date}) may be out of date for a child.',
        { weight: String(round(weight)), date: patient.weightAt.toISOString() },
        WEIGHT_MANAGEMENT,
        { ageGroup: group, weightKg: weight },
      ),
    );
  }
  return { alerts, summary };
}

/* ------------------------------------------------------------------ dose text --------------- */

const FREQUENCY_TEXT: Record<FrequencyCode, string> = {
  QD: 'once a day',
  BID: 'twice a day',
  TID: 'three times a day',
  QID: 'four times a day',
  Q4H: 'every 4 hours',
  Q6H: 'every 6 hours',
  Q8H: 'every 8 hours',
  Q12H: 'every 12 hours',
  QHS: 'at bedtime',
  PRN: 'as needed, up to {n} times in 24 hours',
  STAT: 'once, immediately',
  WEEKLY: 'once a week',
};

const COUNT_UNITS: Partial<Record<DoseUnit, [string, string]>> = {
  tablet: ['{n} tablet', '{n} tablets'],
  capsule: ['{n} capsule', '{n} capsules'],
  puff: ['{n} puff', '{n} puffs'],
  drop: ['{n} drop', '{n} drops'],
  units: ['{n} unit', '{n} units'],
};

/** Decimal comma for Albanian and Serbian. */
export function localNumber(locale: Locale, n: number): string {
  const s = String(Math.round(n * 1000) / 1000);
  return locale === 'en' ? s : s.replace('.', ',');
}

/**
 * The free-text dosage and frequency generated from a structured dose, in the prescriber's
 * language: { dosage: "500 mg", frequency: "three times a day, for 5 days" }.
 */
export function doseText(
  locale: Locale,
  dose: StructuredDose,
  weightKg?: number | null,
): { dosage: string; frequency: string } {
  const n = localNumber(locale, dose.doseAmount);
  const count = COUNT_UNITS[dose.doseUnit];
  let dosage = count
    ? tr(locale, dose.doseAmount === 1 ? count[0] : count[1], { n })
    : `${n} ${dose.doseUnit === 'IU' ? tr(locale, 'IU') : dose.doseUnit}`;
  if (dose.doseUnit === 'mg/kg' && weightKg) {
    dosage += ` (${localNumber(locale, round(dose.doseAmount * weightKg))} mg)`;
  }
  let frequency = tr(locale, FREQUENCY_TEXT[dose.frequencyCode], {
    n: dose.maxDosesPer24h ?? '',
  });
  if (dose.asNeeded && dose.frequencyCode !== 'PRN') {
    frequency = tr(locale, '{frequency}, as needed', { frequency });
    if (dose.maxDosesPer24h) {
      frequency = tr(locale, '{frequency}, at most {n} doses in 24 hours', {
        frequency,
        n: dose.maxDosesPer24h,
      });
    }
  }
  if (dose.durationDays) {
    frequency = tr(
      locale,
      dose.durationDays === 1 ? '{frequency}, for 1 day' : '{frequency}, for {n} days',
      {
        frequency,
        n: dose.durationDays,
      },
    );
  }
  return { dosage: dosage.slice(0, 100), frequency: frequency.slice(0, 100) };
}

/** Parses a stored numeric value. */
export const toNumber = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === '' ? null : Number(v);
