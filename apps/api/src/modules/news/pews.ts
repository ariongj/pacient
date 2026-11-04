/**
 * Paediatric Early Warning Score (PEWS) for patients under 18.
 *
 * ILLUSTRATIVE – the deploying organisation must adopt its approved paediatric chart (for example
 * the UK National PEWS / System-wide Paediatric Observations Tracking charts) and replace these
 * thresholds before clinical use. The structure follows those bedside charts: each observation
 * scores 0 (normal) to 3 (severely abnormal) against an age-band specific range, the points are
 * added up, and any single 3 triggers an urgent bedside review.
 *
 * Age bands: INFANT 0–<1 y, TODDLER 1–<5 y, CHILD 5–<12 y, ADOLESCENT 12–<18 y.
 *
 * Respiratory rate (breaths/min)       score 0   1 (low | high)   2 (low | high)   3
 *   INFANT                              30–50    25–29 | 51–60    20–24 | 61–70    <20 or >70
 *   TODDLER                             20–40    16–19 | 41–50    12–15 | 51–60    <12 or >60
 *   CHILD                               15–30    12–14 | 31–40    10–11 | 41–50    <10 or >50
 *   ADOLESCENT                          12–25    10–11 | 26–30     8–9  | 31–40    <8  or >40
 * Heart rate (beats/min)
 *   INFANT                             110–160   100–109 | 161–170  90–99 | 171–180  <90 or >180
 *   TODDLER                             90–140    80–89 | 141–150  70–79 | 151–170  <70 or >170
 *   CHILD                               75–120    65–74 | 121–130  55–64 | 131–150  <55 or >150
 *   ADOLESCENT                          60–100    50–59 | 101–110  45–49 | 111–130  <45 or >130
 * Systolic blood pressure (mmHg)
 *   INFANT                              70–100    60–69 | 101–110  50–59 | >110     <50
 *   TODDLER                             80–110    70–79 | 111–120  60–69 | >120     <60
 *   CHILD                               90–120    80–89 | 121–130  70–79 | >130     <70
 *   ADOLESCENT                         100–130    90–99 | 131–140  80–89 | >140     <80
 * SpO2 (all ages): ≥95 % → 0, 92–94 → 1, 90–91 → 2, <90 → 3.
 * Supplemental oxygen: on oxygen → 2, room air → 0.
 * Consciousness (ACVPU): A → 0, new confusion or responds to voice → 2, responds to pain only or
 *   unresponsive → 3.
 * Temperature (°C): ≤35.0 → 3, 35.1–36.0 → 1, 36.1–37.9 → 0, 38.0–38.9 → 1, ≥39.0 → 2; an infant
 *   under 3 months with ≥38.0 → 3 (fever in a young infant is a red flag).
 * Capillary refill and respiratory effort are part of most paediatric charts but are not recorded
 * in Pacient yet; their absence is listed on every result.
 *
 * Risk (aggregate): 0–3 LOW (any single 3 → LOW_MEDIUM, urgent bedside review), 4–6 MEDIUM,
 * ≥7 HIGH.
 * Minimum observation frequency: score 0 → 4-hourly, 1–3 → 2-hourly, single 3 or MEDIUM → hourly,
 * HIGH → continuous monitoring (a set every 15 minutes).
 */
import type { Acvpu, News2Input, News2Parameter, News2Risk } from './news2.js';

export type PewsAgeBand = 'INFANT' | 'TODDLER' | 'CHILD' | 'ADOLESCENT';

export interface PewsResult {
  score: number;
  risk: News2Risk;
  points: Record<News2Parameter, number | null>;
  singleThree: boolean;
  complete: boolean;
  missing: News2Parameter[];
  ageBand: PewsAgeBand;
  ageMonths: number;
  /** Observations of the paediatric chart that Pacient does not record. */
  notRecorded: string[];
}

export const PEWS_PARAMETERS: News2Parameter[] = [
  'respiration',
  'spo2',
  'air',
  'systolic',
  'pulse',
  'consciousness',
  'temperature',
];

/** Range table: [normalLow, normalHigh, then the upper bounds of 1-low, 2-low and 1-high, 2-high]. */
interface Bands {
  /** Lowest value still scoring 0, 1 and 2 on the low side. */
  low: [number, number, number];
  /** Highest value scoring 0, 1 and 2 on the high side (above the last one scores 3). */
  high: [number, number, number];
}

const RR: Record<PewsAgeBand, Bands> = {
  INFANT: { low: [30, 25, 20], high: [50, 60, 70] },
  TODDLER: { low: [20, 16, 12], high: [40, 50, 60] },
  CHILD: { low: [15, 12, 10], high: [30, 40, 50] },
  ADOLESCENT: { low: [12, 10, 8], high: [25, 30, 40] },
};
const HR: Record<PewsAgeBand, Bands> = {
  INFANT: { low: [110, 100, 90], high: [160, 170, 180] },
  TODDLER: { low: [90, 80, 70], high: [140, 150, 170] },
  CHILD: { low: [75, 65, 55], high: [120, 130, 150] },
  ADOLESCENT: { low: [60, 50, 45], high: [100, 110, 130] },
};
/** Systolic: high values never score 3 (hypertension is not the deterioration signal here). */
const SBP: Record<PewsAgeBand, Bands> = {
  INFANT: { low: [70, 60, 50], high: [100, 110, Number.POSITIVE_INFINITY] },
  TODDLER: { low: [80, 70, 60], high: [110, 120, Number.POSITIVE_INFINITY] },
  CHILD: { low: [90, 80, 70], high: [120, 130, Number.POSITIVE_INFINITY] },
  ADOLESCENT: { low: [100, 90, 80], high: [130, 140, Number.POSITIVE_INFINITY] },
};

function bandPoints(value: number, b: Bands): number {
  const [n0, l1, l2] = b.low;
  const [h0, h1, h2] = b.high;
  if (value >= n0 && value <= h0) return 0;
  if (value < n0) {
    if (value >= l1) return 1;
    if (value >= l2) return 2;
    return 3;
  }
  if (value <= h1) return 1;
  if (value <= h2) return 2;
  return 3;
}

export function ageBandFor(ageMonths: number): PewsAgeBand {
  if (ageMonths < 12) return 'INFANT';
  if (ageMonths < 60) return 'TODDLER';
  if (ageMonths < 144) return 'CHILD';
  return 'ADOLESCENT';
}

/** Whole months between date of birth and the observation time. */
export function ageInMonths(dateOfBirth: string | Date, at: Date): number {
  const dob = typeof dateOfBirth === 'string' ? new Date(`${dateOfBirth}T00:00:00Z`) : dateOfBirth;
  let months =
    (at.getUTCFullYear() - dob.getUTCFullYear()) * 12 + at.getUTCMonth() - dob.getUTCMonth();
  if (at.getUTCDate() < dob.getUTCDate()) months--;
  return Math.max(0, months);
}

/** True when the patient is a child (under 18) at the time of the observation. */
export function isChild(dateOfBirth: string | Date, at: Date): boolean {
  return ageInMonths(dateOfBirth, at) < 18 * 12;
}

export const pewsRespirationPoints = (rr: number, band: PewsAgeBand) => bandPoints(rr, RR[band]);
export const pewsPulsePoints = (hr: number, band: PewsAgeBand) => bandPoints(hr, HR[band]);
export const pewsSystolicPoints = (sbp: number, band: PewsAgeBand) => bandPoints(sbp, SBP[band]);

export function pewsSpo2Points(spo2: number): number {
  if (spo2 >= 95) return 0;
  if (spo2 >= 92) return 1;
  if (spo2 >= 90) return 2;
  return 3;
}

export function pewsConsciousnessPoints(level: Acvpu | string): number {
  if (level === 'A') return 0;
  if (level === 'C' || level === 'V') return 2;
  return 3;
}

export function pewsTemperaturePoints(t: number, ageMonths: number): number {
  const v = Math.round(t * 10) / 10;
  if (v <= 35.0) return 3;
  if (v <= 36.0) return 1;
  if (v < 38.0) return 0;
  if (ageMonths < 3) return 3;
  if (v < 39.0) return 1;
  return 2;
}

export function pewsRiskFor(score: number, singleThree: boolean): News2Risk {
  if (score >= 7) return 'HIGH';
  if (score >= 4) return 'MEDIUM';
  if (singleThree) return 'LOW_MEDIUM';
  return 'LOW';
}

const has = (v: unknown): v is number | string => v !== null && v !== undefined && v !== '';

export function scorePews(v: News2Input, ageMonths: number): PewsResult {
  const band = ageBandFor(ageMonths);
  const points: Record<News2Parameter, number | null> = {
    respiration: has(v.respiratoryRate)
      ? pewsRespirationPoints(Number(v.respiratoryRate), band)
      : null,
    spo2: has(v.oxygenSaturation) ? pewsSpo2Points(Number(v.oxygenSaturation)) : null,
    air: v.onSupplementalOxygen === true ? 2 : v.onSupplementalOxygen === false ? 0 : null,
    systolic: has(v.systolic) ? pewsSystolicPoints(Number(v.systolic), band) : null,
    pulse: has(v.heartRate) ? pewsPulsePoints(Number(v.heartRate), band) : null,
    consciousness: has(v.consciousness) ? pewsConsciousnessPoints(String(v.consciousness)) : null,
    temperature: has(v.temperatureC)
      ? pewsTemperaturePoints(Number(v.temperatureC), ageMonths)
      : null,
  };
  const missing = PEWS_PARAMETERS.filter((p) => points[p] === null);
  const values = Object.values(points).filter((p): p is number => p !== null);
  const score = values.reduce((a, b) => a + b, 0);
  const singleThree = values.some((p) => p === 3);
  return {
    score,
    risk: pewsRiskFor(score, singleThree),
    points,
    singleThree,
    complete: missing.length === 0,
    missing,
    ageBand: band,
    ageMonths,
    notRecorded: ['capillaryRefill', 'respiratoryEffort'],
  };
}

/** Minimum observation interval for a PEWS result (see header). */
export function pewsObservationIntervalMinutes(score: number, risk: News2Risk): number {
  if (risk === 'HIGH') return 15;
  if (risk === 'MEDIUM' || risk === 'LOW_MEDIUM') return 60;
  if (score === 0) return 4 * 60;
  return 2 * 60;
}
