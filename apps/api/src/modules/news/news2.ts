/**
 * National Early Warning Score 2 (Royal College of Physicians, 2017).
 *
 * Pure functions – no database access – so every chart boundary is unit-tested. A parameter that
 * was not measured scores nothing and marks the set as incomplete; the aggregate is then a lower
 * bound and the UI says so.
 */
export type Acvpu = 'A' | 'C' | 'V' | 'P' | 'U';
export type Spo2Scale = 1 | 2;
export type News2Risk = 'LOW' | 'LOW_MEDIUM' | 'MEDIUM' | 'HIGH';

export interface News2Input {
  respiratoryRate?: number | null;
  oxygenSaturation?: number | null;
  onSupplementalOxygen?: boolean | null;
  systolic?: number | null;
  heartRate?: number | null;
  consciousness?: Acvpu | string | null;
  temperatureC?: number | string | null;
}

export const NEWS2_PARAMETERS = [
  'respiration',
  'spo2',
  'air',
  'systolic',
  'pulse',
  'consciousness',
  'temperature',
] as const;
export type News2Parameter = (typeof NEWS2_PARAMETERS)[number];

export interface News2Result {
  score: number;
  risk: News2Risk;
  /** Points per parameter; null when the parameter was not measured. */
  points: Record<News2Parameter, number | null>;
  /** True when any single parameter scored 3 ("red score"). */
  singleThree: boolean;
  complete: boolean;
  missing: News2Parameter[];
  spo2Scale: Spo2Scale;
}

const has = (v: unknown): v is number | string => v !== null && v !== undefined && v !== '';

export function respirationPoints(rr: number): number {
  if (rr <= 8) return 3;
  if (rr <= 11) return 1;
  if (rr <= 20) return 0;
  if (rr <= 24) return 2;
  return 3;
}

/** SpO2 scale 1 – for most patients. */
export function spo2Scale1Points(spo2: number): number {
  if (spo2 <= 91) return 3;
  if (spo2 <= 93) return 2;
  if (spo2 <= 95) return 1;
  return 0;
}

/**
 * SpO2 scale 2 – only for patients with documented hypercapnic respiratory failure and a
 * prescribed target of 88–92 %. High saturations score only when the patient is on oxygen.
 */
export function spo2Scale2Points(spo2: number, onOxygen: boolean): number {
  if (spo2 <= 83) return 3;
  if (spo2 <= 85) return 2;
  if (spo2 <= 87) return 1;
  if (spo2 <= 92) return 0;
  if (!onOxygen) return 0;
  if (spo2 <= 94) return 1;
  if (spo2 <= 96) return 2;
  return 3;
}

export function systolicPoints(sbp: number): number {
  if (sbp <= 90) return 3;
  if (sbp <= 100) return 2;
  if (sbp <= 110) return 1;
  if (sbp <= 219) return 0;
  return 3;
}

export function pulsePoints(hr: number): number {
  if (hr <= 40) return 3;
  if (hr <= 50) return 1;
  if (hr <= 90) return 0;
  if (hr <= 110) return 1;
  if (hr <= 130) return 2;
  return 3;
}

/** Any new confusion, response to voice or pain only, or unresponsive scores 3. */
export function consciousnessPoints(level: string): number {
  return level === 'A' ? 0 : 3;
}

export function temperaturePoints(t: number): number {
  // Compare at one decimal, as recorded on the chart.
  const v = Math.round(t * 10) / 10;
  if (v <= 35.0) return 3;
  if (v <= 36.0) return 1;
  if (v <= 38.0) return 0;
  if (v <= 39.0) return 1;
  return 2;
}

export function riskFor(score: number, singleThree: boolean): News2Risk {
  if (score >= 7) return 'HIGH';
  if (score >= 5) return 'MEDIUM';
  if (singleThree) return 'LOW_MEDIUM';
  return 'LOW';
}

export function scoreNews2(v: News2Input, scale: Spo2Scale = 1): News2Result {
  const onOxygen = v.onSupplementalOxygen === true;
  const points: Record<News2Parameter, number | null> = {
    respiration: has(v.respiratoryRate) ? respirationPoints(Number(v.respiratoryRate)) : null,
    spo2: has(v.oxygenSaturation)
      ? scale === 2
        ? spo2Scale2Points(Number(v.oxygenSaturation), onOxygen)
        : spo2Scale1Points(Number(v.oxygenSaturation))
      : null,
    air: v.onSupplementalOxygen === true ? 2 : v.onSupplementalOxygen === false ? 0 : null,
    systolic: has(v.systolic) ? systolicPoints(Number(v.systolic)) : null,
    pulse: has(v.heartRate) ? pulsePoints(Number(v.heartRate)) : null,
    consciousness: has(v.consciousness) ? consciousnessPoints(String(v.consciousness)) : null,
    temperature: has(v.temperatureC) ? temperaturePoints(Number(v.temperatureC)) : null,
  };
  const missing = NEWS2_PARAMETERS.filter((p) => points[p] === null);
  const values = Object.values(points).filter((p): p is number => p !== null);
  const score = values.reduce((a, b) => a + b, 0);
  const singleThree = values.some((p) => p === 3);
  return {
    score,
    risk: riskFor(score, singleThree),
    points,
    singleThree,
    complete: missing.length === 0,
    missing,
    spo2Scale: scale,
  };
}

/** True when the set contains at least one NEWS2 parameter (otherwise it is not scored). */
export function hasNewsParameters(v: News2Input): boolean {
  return (
    has(v.respiratoryRate) ||
    has(v.oxygenSaturation) ||
    v.onSupplementalOxygen === true ||
    v.onSupplementalOxygen === false ||
    has(v.systolic) ||
    has(v.heartRate) ||
    has(v.consciousness) ||
    has(v.temperatureC)
  );
}

/**
 * Minimum frequency of observations (RCP NEWS2 chart): 0 → 12-hourly, 1–4 → 4–6-hourly (we use
 * 4 h), a single 3 or 5–6 → hourly, ≥ 7 → continuous monitoring (we expect a set every 15 min).
 */
export function observationIntervalMinutes(score: number, risk: News2Risk): number {
  if (risk === 'HIGH') return 15;
  if (risk === 'MEDIUM' || risk === 'LOW_MEDIUM') return 60;
  if (score === 0) return 12 * 60;
  return 4 * 60;
}

export const RISK_RANK: Record<News2Risk, number> = { LOW: 0, LOW_MEDIUM: 1, MEDIUM: 2, HIGH: 3 };
