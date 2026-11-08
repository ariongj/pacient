import { z } from 'zod';

/**
 * Remote monitoring: what patients can measure at home, the plausible range of each value (anything
 * outside is rejected as a typing or device error) and the default alert limits a doctor starts
 * from when enrolling a patient.
 *
 * ILLUSTRATIVE – the default limits follow common practice (e.g. home blood pressure ≥ 160/100 needs
 * review, ≥ 180/120 is urgent; hypoglycaemia below 4 mmol/L, severe below 3) but must be confirmed
 * by the national clinical guidelines and are always adjustable per patient.
 */

export const READING_KINDS = [
  'BLOOD_PRESSURE',
  'GLUCOSE',
  'WEIGHT',
  'SPO2',
  'HEART_RATE',
  'TEMPERATURE',
  'PEAK_FLOW',
] as const;
export type ReadingKind = (typeof READING_KINDS)[number];

export const GLUCOSE_CONTEXTS = [
  'FASTING',
  'BEFORE_MEAL',
  'AFTER_MEAL',
  'BEDTIME',
  'RANDOM',
] as const;

const num = (min: number, max: number, label: string) =>
  z.coerce
    .number({ error: `${label} must be a number` })
    .min(min, `${label} looks wrong (lowest accepted: ${min})`)
    .max(max, `${label} looks wrong (highest accepted: ${max})`);

/** Plausible values per kind (impossible values are refused, not flagged). */
export const VALUE_SCHEMAS = {
  BLOOD_PRESSURE: z
    .object({
      systolic: num(50, 260, 'Systolic pressure').pipe(z.number().int()),
      diastolic: num(30, 160, 'Diastolic pressure').pipe(z.number().int()),
      pulse: num(25, 250, 'Pulse').pipe(z.number().int()).optional(),
    })
    .strict()
    .refine((v) => v.systolic > v.diastolic, {
      message: 'The systolic (upper) value must be higher than the diastolic (lower) value',
      path: ['diastolic'],
    }),
  GLUCOSE: z
    .object({
      value: num(0.5, 40, 'Blood glucose'),
      context: z.enum(GLUCOSE_CONTEXTS).default('RANDOM'),
    })
    .strict(),
  WEIGHT: z.object({ value: num(1, 400, 'Weight') }).strict(),
  SPO2: z
    .object({
      value: num(50, 100, 'Oxygen saturation').pipe(z.number().int()),
      pulse: num(25, 250, 'Pulse').pipe(z.number().int()).optional(),
    })
    .strict(),
  HEART_RATE: z.object({ value: num(25, 250, 'Pulse').pipe(z.number().int()) }).strict(),
  TEMPERATURE: z.object({ value: num(30, 44, 'Temperature') }).strict(),
  PEAK_FLOW: z.object({ value: num(50, 900, 'Peak flow').pipe(z.number().int()) }).strict(),
} satisfies Record<ReadingKind, z.ZodType>;

export const UNITS: Record<ReadingKind, string> = {
  BLOOD_PRESSURE: 'mmHg',
  GLUCOSE: 'mmol/L',
  WEIGHT: 'kg',
  SPO2: '%',
  HEART_RATE: '/min',
  TEMPERATURE: '°C',
  PEAK_FLOW: 'L/min',
};

/** Alert limits. "High"/"Low" limits flag OUT_OF_RANGE, "Urgent" limits flag URGENT. */
export const THRESHOLD_KEYS = [
  'systolicHigh',
  'diastolicHigh',
  'systolicLow',
  'systolicUrgentHigh',
  'diastolicUrgentHigh',
  'systolicUrgentLow',
  'glucoseLow',
  'glucoseUrgentLow',
  'glucoseHigh',
  'glucoseUrgentHigh',
  'weightGainKg3Days',
  'spo2Low',
  'spo2UrgentLow',
  'heartRateLow',
  'heartRateHigh',
  'heartRateUrgentLow',
  'heartRateUrgentHigh',
  'temperatureHigh',
  'temperatureUrgentHigh',
  'temperatureLow',
  'peakFlowLow',
  'peakFlowUrgentLow',
  /** Plan setting, not a value limit: days without any reading before the patient counts as silent. */
  'silentAfterDays',
] as const;
export type ThresholdKey = (typeof THRESHOLD_KEYS)[number];
export type Thresholds = Partial<Record<ThresholdKey, number>>;

/** Which limits belong to which kind (shown and validated per kind). */
export const KIND_THRESHOLDS: Record<ReadingKind, ThresholdKey[]> = {
  BLOOD_PRESSURE: [
    'systolicHigh',
    'diastolicHigh',
    'systolicLow',
    'systolicUrgentHigh',
    'diastolicUrgentHigh',
    'systolicUrgentLow',
  ],
  GLUCOSE: ['glucoseLow', 'glucoseUrgentLow', 'glucoseHigh', 'glucoseUrgentHigh'],
  WEIGHT: ['weightGainKg3Days'],
  SPO2: ['spo2Low', 'spo2UrgentLow'],
  HEART_RATE: ['heartRateLow', 'heartRateHigh', 'heartRateUrgentLow', 'heartRateUrgentHigh'],
  TEMPERATURE: ['temperatureHigh', 'temperatureUrgentHigh', 'temperatureLow'],
  PEAK_FLOW: ['peakFlowLow', 'peakFlowUrgentLow'],
};

/**
 * Default limits (illustrative). Peak flow has none: it depends on the person's own best value, so
 * the doctor sets it in the plan.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  systolicHigh: 160,
  diastolicHigh: 100,
  systolicLow: 90,
  systolicUrgentHigh: 180,
  diastolicUrgentHigh: 120,
  systolicUrgentLow: 80,
  glucoseLow: 4,
  glucoseUrgentLow: 3,
  glucoseHigh: 15,
  glucoseUrgentHigh: 20,
  weightGainKg3Days: 2,
  spo2Low: 94,
  spo2UrgentLow: 90,
  heartRateLow: 50,
  heartRateHigh: 110,
  heartRateUrgentLow: 40,
  heartRateUrgentHigh: 130,
  temperatureHigh: 38,
  temperatureUrgentHigh: 40,
  temperatureLow: 35.5,
  silentAfterDays: 3,
};

/** Plausible bounds for each limit (a doctor can tighten or loosen within these). */
const THRESHOLD_BOUNDS: Record<ThresholdKey, [number, number]> = {
  systolicHigh: [100, 220],
  diastolicHigh: [60, 140],
  systolicLow: [60, 130],
  systolicUrgentHigh: [120, 250],
  diastolicUrgentHigh: [70, 160],
  systolicUrgentLow: [50, 120],
  glucoseLow: [2, 10],
  glucoseUrgentLow: [1.5, 8],
  glucoseHigh: [6, 30],
  glucoseUrgentHigh: [8, 35],
  weightGainKg3Days: [0.5, 10],
  spo2Low: [80, 99],
  spo2UrgentLow: [70, 98],
  heartRateLow: [30, 90],
  heartRateHigh: [70, 180],
  heartRateUrgentLow: [25, 80],
  heartRateUrgentHigh: [80, 220],
  temperatureHigh: [37, 40],
  temperatureUrgentHigh: [38, 42],
  temperatureLow: [33, 36.5],
  peakFlowLow: [50, 800],
  peakFlowUrgentLow: [50, 800],
  silentAfterDays: [1, 30],
};

/** Pairs that must be ordered: [less severe, more severe, "higher" means the urgent one is higher]. */
const ORDERED: [ThresholdKey, ThresholdKey, 'up' | 'down'][] = [
  ['systolicHigh', 'systolicUrgentHigh', 'up'],
  ['diastolicHigh', 'diastolicUrgentHigh', 'up'],
  ['systolicLow', 'systolicUrgentLow', 'down'],
  ['glucoseLow', 'glucoseUrgentLow', 'down'],
  ['glucoseHigh', 'glucoseUrgentHigh', 'up'],
  ['spo2Low', 'spo2UrgentLow', 'down'],
  ['heartRateLow', 'heartRateUrgentLow', 'down'],
  ['heartRateHigh', 'heartRateUrgentHigh', 'up'],
  ['temperatureHigh', 'temperatureUrgentHigh', 'up'],
  ['peakFlowLow', 'peakFlowUrgentLow', 'down'],
];

export const ThresholdsSchema = z
  .record(z.string(), z.coerce.number())
  .superRefine((t, ctx) => {
    for (const [key, value] of Object.entries(t)) {
      const bounds = THRESHOLD_BOUNDS[key as ThresholdKey];
      if (!bounds) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'Unknown limit' });
        continue;
      }
      if (!Number.isFinite(value) || value < bounds[0] || value > bounds[1]) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `The limit must be between ${bounds[0]} and ${bounds[1]}`,
        });
      }
    }
    for (const [mild, severe, dir] of ORDERED) {
      const a = t[mild];
      const b = t[severe];
      if (a === undefined || b === undefined) continue;
      if (dir === 'up' ? b < a : b > a) {
        ctx.addIssue({
          code: 'custom',
          path: [severe],
          message: 'The urgent limit must be beyond the review limit',
        });
      }
    }
  })
  .transform((t) => t as Thresholds);

/** The limits that apply to a plan: defaults for its kinds, overridden by the plan's own values. */
export function planThresholds(kinds: readonly string[], own: Thresholds | null | undefined) {
  const out: Thresholds = { silentAfterDays: own?.silentAfterDays ?? 3 };
  for (const kind of kinds) {
    for (const key of KIND_THRESHOLDS[kind as ReadingKind] ?? []) {
      const v = own?.[key] ?? DEFAULT_THRESHOLDS[key];
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}

export type Flag = 'NORMAL' | 'OUT_OF_RANGE' | 'URGENT';

/** Why a reading was flagged (codes; the web app shows a sentence for each). */
export type FlagReason =
  | 'BP_HIGH'
  | 'BP_LOW'
  | 'BP_URGENT_HIGH'
  | 'BP_URGENT_LOW'
  | 'GLUCOSE_LOW'
  | 'GLUCOSE_URGENT_LOW'
  | 'GLUCOSE_HIGH'
  | 'GLUCOSE_URGENT_HIGH'
  | 'WEIGHT_GAIN'
  | 'SPO2_LOW'
  | 'SPO2_URGENT_LOW'
  | 'HEART_RATE_LOW'
  | 'HEART_RATE_HIGH'
  | 'HEART_RATE_URGENT'
  | 'TEMPERATURE_HIGH'
  | 'TEMPERATURE_URGENT_HIGH'
  | 'TEMPERATURE_LOW'
  | 'PEAK_FLOW_LOW'
  | 'PEAK_FLOW_URGENT_LOW';

export interface Evaluation {
  flag: Flag;
  reasons: FlagReason[];
}

const ge = (v: number | undefined, limit: number | undefined) =>
  v !== undefined && limit !== undefined && v >= limit;
const le = (v: number | undefined, limit: number | undefined) =>
  v !== undefined && limit !== undefined && v <= limit;
const lt = (v: number | undefined, limit: number | undefined) =>
  v !== undefined && limit !== undefined && v < limit;
const gt = (v: number | undefined, limit: number | undefined) =>
  v !== undefined && limit !== undefined && v > limit;

/**
 * Flags a reading against the limits. Without a plan (`urgentOnly`), only the default URGENT limits
 * apply: a reading is never flagged for review unless it is clearly dangerous.
 *
 * `previousWeights` are the person's weights in the 72 hours before this one (for heart failure:
 * a gain of ≥ 2 kg in 3 days is a warning sign of fluid retention).
 */
export function evaluateReading(
  kind: ReadingKind,
  values: Record<string, unknown>,
  limits: Thresholds,
  opts: { urgentOnly?: boolean; previousWeights?: number[] } = {},
): Evaluation {
  const urgent: FlagReason[] = [];
  const review: FlagReason[] = [];
  const v = (k: string) => (typeof values[k] === 'number' ? (values[k] as number) : undefined);
  const L = limits;
  switch (kind) {
    case 'BLOOD_PRESSURE': {
      const s = v('systolic');
      const d = v('diastolic');
      if (ge(s, L.systolicUrgentHigh) || ge(d, L.diastolicUrgentHigh))
        urgent.push('BP_URGENT_HIGH');
      else if (ge(s, L.systolicHigh) || ge(d, L.diastolicHigh)) review.push('BP_HIGH');
      if (lt(s, L.systolicUrgentLow)) urgent.push('BP_URGENT_LOW');
      else if (le(s, L.systolicLow)) review.push('BP_LOW');
      break;
    }
    case 'GLUCOSE': {
      const g = v('value');
      if (lt(g, L.glucoseUrgentLow)) urgent.push('GLUCOSE_URGENT_LOW');
      else if (lt(g, L.glucoseLow)) review.push('GLUCOSE_LOW');
      if (gt(g, L.glucoseUrgentHigh)) urgent.push('GLUCOSE_URGENT_HIGH');
      else if (gt(g, L.glucoseHigh)) review.push('GLUCOSE_HIGH');
      break;
    }
    case 'WEIGHT': {
      const w = v('value');
      const before = opts.previousWeights ?? [];
      if (w !== undefined && before.length && L.weightGainKg3Days !== undefined) {
        if (w - Math.min(...before) >= L.weightGainKg3Days - 1e-9) review.push('WEIGHT_GAIN');
      }
      break;
    }
    case 'SPO2': {
      const o = v('value');
      if (lt(o, L.spo2UrgentLow)) urgent.push('SPO2_URGENT_LOW');
      else if (lt(o, L.spo2Low)) review.push('SPO2_LOW');
      break;
    }
    case 'HEART_RATE': {
      const p = v('value');
      if (lt(p, L.heartRateUrgentLow) || gt(p, L.heartRateUrgentHigh)) {
        urgent.push('HEART_RATE_URGENT');
      } else if (lt(p, L.heartRateLow)) review.push('HEART_RATE_LOW');
      else if (gt(p, L.heartRateHigh)) review.push('HEART_RATE_HIGH');
      break;
    }
    case 'TEMPERATURE': {
      const t = v('value');
      if (ge(t, L.temperatureUrgentHigh)) urgent.push('TEMPERATURE_URGENT_HIGH');
      else if (ge(t, L.temperatureHigh)) review.push('TEMPERATURE_HIGH');
      if (lt(t, L.temperatureLow)) review.push('TEMPERATURE_LOW');
      break;
    }
    case 'PEAK_FLOW': {
      const f = v('value');
      if (lt(f, L.peakFlowUrgentLow)) urgent.push('PEAK_FLOW_URGENT_LOW');
      else if (lt(f, L.peakFlowLow)) review.push('PEAK_FLOW_LOW');
      break;
    }
  }
  if (urgent.length) return { flag: 'URGENT', reasons: [...urgent, ...review] };
  if (opts.urgentOnly) return { flag: 'NORMAL', reasons: [] };
  if (review.length) return { flag: 'OUT_OF_RANGE', reasons: review };
  return { flag: 'NORMAL', reasons: [] };
}

/** Kinds suggested for patients of each disease register. */
export const REGISTER_SUGGESTIONS: Record<string, ReadingKind[]> = {
  HYPERTENSION: ['BLOOD_PRESSURE'],
  DIABETES: ['GLUCOSE', 'BLOOD_PRESSURE'],
  HEART_FAILURE: ['WEIGHT', 'BLOOD_PRESSURE', 'HEART_RATE'],
  COPD: ['SPO2', 'HEART_RATE', 'TEMPERATURE'],
};

/** Readings are accepted for the last week only, and never in the future (5 minutes clock skew). */
export const MAX_BACKDATE_DAYS = 7;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** Short display of a reading's values, e.g. "152/94 mmHg", "7.2 mmol/L (fasting)". */
export function displayValue(kind: string, values: Record<string, unknown>): string {
  const n = (k: string) => (typeof values[k] === 'number' ? String(values[k]) : '?');
  switch (kind) {
    case 'BLOOD_PRESSURE':
      return `${n('systolic')}/${n('diastolic')} mmHg`;
    default:
      return `${n('value')} ${UNITS[kind as ReadingKind] ?? ''}`.trim();
  }
}
