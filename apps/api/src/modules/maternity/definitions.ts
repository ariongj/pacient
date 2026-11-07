/**
 * Antenatal care rules. ILLUSTRATIVE – the risk mapping, alert thresholds and test windows follow
 * common international practice (WHO 2016 antenatal care model, NICE NG201/NG133) and must be
 * confirmed by the national maternity guideline before clinical use.
 *
 * Dates are calendar days (YYYY-MM-DD). Gestational age is counted in days from the first day of
 * the last menstrual period (LMP): EDD = LMP + 280 days, so GA(date) = 280 − (EDD − date).
 */

export const DAY_MS = 86_400_000;
export const FULL_TERM_DAYS = 280;
/** Post-term: no outcome recorded 14 days after the EDD (42+0 weeks). */
export const POST_TERM_DAYS = 14;
/** Dating scan and LMP disagreeing by more than this many days is flagged (the scan is used). */
export const EDD_DISCREPANCY_DAYS = 7;
export const NEAR_EDD_DAYS = 14;
/** Booking is accepted between 10 and 55 years of age. */
export const MIN_AGE = 10;
export const MAX_AGE = 55;

export const RISK_FACTORS = [
  'AGE_UNDER_18',
  'AGE_OVER_40',
  'PREVIOUS_CAESAREAN',
  'PREVIOUS_PRE_ECLAMPSIA',
  'PREVIOUS_STILLBIRTH',
  'PREVIOUS_PRETERM',
  'MULTIPLE_PREGNANCY',
  'DIABETES',
  'GESTATIONAL_DIABETES',
  'HYPERTENSION',
  'BMI_OVER_35',
  'RH_NEGATIVE',
  'SMOKING',
  'ANAEMIA',
  'HIV',
  'HEPATITIS_B',
  'OTHER',
] as const;
export type RiskFactor = (typeof RISK_FACTORS)[number];

/** Computed from the date of birth – never entered by hand. */
export const AGE_FACTORS: RiskFactor[] = ['AGE_UNDER_18', 'AGE_OVER_40'];

/**
 * Factors that make the pregnancy HIGH risk (consultant-led care). Rh-negative, smoking, anaemia
 * and "other" need attention but do not by themselves change the level.
 */
export const HIGH_RISK_FACTORS: ReadonlySet<RiskFactor> = new Set<RiskFactor>([
  'AGE_UNDER_18',
  'AGE_OVER_40',
  'PREVIOUS_CAESAREAN',
  'PREVIOUS_PRE_ECLAMPSIA',
  'PREVIOUS_STILLBIRTH',
  'PREVIOUS_PRETERM',
  'MULTIPLE_PREGNANCY',
  'DIABETES',
  'GESTATIONAL_DIABETES',
  'HYPERTENSION',
  'BMI_OVER_35',
  'HIV',
  'HEPATITIS_B',
]);

export const OUTCOMES = [
  'DELIVERED',
  'MISCARRIAGE',
  'TERMINATION',
  'ECTOPIC',
  'TRANSFERRED_OUT',
] as const;
export type PregnancyOutcome = (typeof OUTCOMES)[number];

export const PRESENTATIONS = ['CEPHALIC', 'BREECH', 'TRANSVERSE', 'UNKNOWN'] as const;
export const URINE_PROTEIN = ['NEGATIVE', 'TRACE', '1+', '2+', '3+'] as const;

/* ---------------------------------------------------------------------------- dates -- */

export const toDay = (d: Date | string) =>
  typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => toDay(new Date(dayMs(d) + n * DAY_MS));
export const daysBetween = (from: string, to: string) =>
  Math.round((dayMs(to) - dayMs(from)) / DAY_MS);

/** Calendar date in Kosovo for a moment in time. */
export function kosovoDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export const eddFromLmp = (lmp: string) => addDays(lmp, FULL_TERM_DAYS);

/** Gestational age in days on a calendar date. */
export const gestationDays = (edd: string, on: string) =>
  FULL_TERM_DAYS - daysBetween(on, edd);

/** "24+3" (completed weeks + days). */
export function formatGestation(days: number): string {
  const d = Math.max(0, days);
  return `${Math.floor(d / 7)}+${d % 7}`;
}

export function ageOn(dateOfBirth: string, on: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [y, m, d] = on.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/* ---------------------------------------------------------------------- risk factors -- */

/** Stored form: codes, and "OTHER:<note>" for the free-text factor. */
export function encodeRiskFactors(codes: RiskFactor[], otherNote?: string | null): string[] {
  const set = [...new Set(codes)].filter((c) => c !== 'OTHER');
  set.sort((a, b) => RISK_FACTORS.indexOf(a) - RISK_FACTORS.indexOf(b));
  const out: string[] = set;
  if (codes.includes('OTHER') || otherNote) out.push(`OTHER:${(otherNote ?? '').trim()}`);
  return out;
}

export function decodeRiskFactors(stored: string[]): {
  codes: RiskFactor[];
  otherNote: string | null;
} {
  const codes: RiskFactor[] = [];
  let otherNote: string | null = null;
  for (const s of stored) {
    if (s.startsWith('OTHER')) {
      codes.push('OTHER');
      otherNote = s.slice(6) || null;
    } else if ((RISK_FACTORS as readonly string[]).includes(s)) codes.push(s as RiskFactor);
  }
  return { codes, otherNote };
}

/** Replaces the age factors with the ones that apply on the booking date. */
export function withAgeFactors(codes: RiskFactor[], age: number): RiskFactor[] {
  const rest = codes.filter((c) => !AGE_FACTORS.includes(c));
  if (age < 18) rest.push('AGE_UNDER_18');
  if (age >= 40) rest.push('AGE_OVER_40');
  return rest;
}

export const riskLevelFor = (codes: RiskFactor[]): 'LOW' | 'HIGH' =>
  codes.some((c) => HIGH_RISK_FACTORS.has(c)) ? 'HIGH' : 'LOW';

/* ------------------------------------------------------------------------- visit alerts -- */

export type AlertSeverity = 'SEVERE' | 'WARNING' | 'INFO';
export interface VisitAlert {
  code:
    | 'SEVERE_HYPERTENSION'
    | 'PRE_ECLAMPSIA_RISK'
    | 'HYPERTENSION'
    | 'FETAL_HEART_RATE'
    | 'REDUCED_FETAL_MOVEMENTS'
    | 'FUNDAL_HEIGHT'
    | 'MALPRESENTATION'
    | 'PRESENTATION_NOT_RECORDED';
  severity: AlertSeverity;
}

export interface VisitObservations {
  gestationDays: number;
  systolic?: number | null;
  diastolic?: number | null;
  urineProtein?: string | null;
  fetalHeartRate?: number | null;
  fetalMovements?: boolean | null;
  fundalHeightCm?: number | string | null;
  presentation?: string | null;
}

const proteinuria = (p?: string | null) => p === '1+' || p === '2+' || p === '3+';

/**
 * Alerts for a set of antenatal observations (shown, never blocking):
 * - BP ≥ 160/110 → severe hypertension (any gestation);
 * - from 20+0 weeks: BP ≥ 140/90 or proteinuria ≥ 1+ → pre-eclampsia warning
 *   (severe when both, or with severe hypertension); before 20 weeks raised BP → hypertension;
 * - fetal heart rate outside 110–160 bpm;
 * - reduced fetal movements from 24+0 weeks;
 * - from 24+0 weeks: symphysis–fundal height differs from the weeks of gestation by > 3 cm;
 * - from 36+0 weeks: breech/transverse presentation, or presentation not recorded.
 */
export function visitAlerts(v: VisitObservations): VisitAlert[] {
  const out: VisitAlert[] = [];
  const weeks = v.gestationDays / 7;
  const sys = v.systolic ?? null;
  const dia = v.diastolic ?? null;
  const severeBp = (sys !== null && sys >= 160) || (dia !== null && dia >= 110);
  const raisedBp = (sys !== null && sys >= 140) || (dia !== null && dia >= 90);
  if (severeBp) out.push({ code: 'SEVERE_HYPERTENSION', severity: 'SEVERE' });
  if (weeks >= 20 && (raisedBp || proteinuria(v.urineProtein))) {
    out.push({
      code: 'PRE_ECLAMPSIA_RISK',
      severity: severeBp || (raisedBp && proteinuria(v.urineProtein)) ? 'SEVERE' : 'WARNING',
    });
  } else if (raisedBp && !severeBp) {
    out.push({ code: 'HYPERTENSION', severity: 'WARNING' });
  }
  if (v.fetalHeartRate !== null && v.fetalHeartRate !== undefined) {
    if (v.fetalHeartRate < 110 || v.fetalHeartRate > 160) {
      out.push({ code: 'FETAL_HEART_RATE', severity: 'WARNING' });
    }
  }
  if (weeks >= 24 && v.fetalMovements === false) {
    out.push({ code: 'REDUCED_FETAL_MOVEMENTS', severity: 'WARNING' });
  }
  const sfh =
    v.fundalHeightCm === null || v.fundalHeightCm === undefined ? null : Number(v.fundalHeightCm);
  if (weeks >= 24 && sfh !== null && Math.abs(sfh - Math.floor(weeks)) > 3) {
    out.push({ code: 'FUNDAL_HEIGHT', severity: 'WARNING' });
  }
  if (weeks >= 36) {
    if (v.presentation === 'BREECH' || v.presentation === 'TRANSVERSE') {
      out.push({ code: 'MALPRESENTATION', severity: 'WARNING' });
    } else if (!v.presentation || v.presentation === 'UNKNOWN') {
      out.push({ code: 'PRESENTATION_NOT_RECORDED', severity: 'INFO' });
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- contact schedule -- */

/** WHO 2016: eight antenatal contacts, at these completed weeks. */
export const CONTACT_WEEKS = [12, 20, 26, 30, 34, 36, 38, 40] as const;

export type ContactState = 'DONE' | 'DUE' | 'OVERDUE' | 'UPCOMING' | 'NOT_APPLICABLE';
export interface ContactStatus {
  week: number;
  /** Window in gestational days [from, to). */
  fromDay: number;
  toDay: number;
  targetDate: string;
  state: ContactState;
  visitAt: string | null;
}

/** A contact counts as overdue a week after its target week without a visit in its window. */
export const CONTACT_GRACE_DAYS = 7;

/**
 * Each contact owns the gestational window between the midpoints to its neighbours (first from
 * 0, last to 42+0). A visit inside the window fulfils it. Windows that closed before the booking
 * are NOT_APPLICABLE (booked late, not missed by the service).
 */
export function contactSchedule(
  edd: string,
  bookingGestationDays: number,
  visits: { gestationDays: number; visitAt: string }[],
  todayGestationDays: number,
  ended: boolean,
): ContactStatus[] {
  return CONTACT_WEEKS.map((week, i) => {
    const prev = CONTACT_WEEKS[i - 1];
    const next = CONTACT_WEEKS[i + 1];
    const fromDay = prev === undefined ? 0 : Math.round(((prev + week) / 2) * 7);
    const toDay = next === undefined ? 42 * 7 : Math.round(((week + next) / 2) * 7);
    const visit = visits.find((v) => v.gestationDays >= fromDay && v.gestationDays < toDay);
    const targetDate = addDays(edd, week * 7 - FULL_TERM_DAYS);
    let state: ContactState;
    if (visit) state = 'DONE';
    else if (bookingGestationDays >= toDay) state = 'NOT_APPLICABLE';
    else if (ended) state = 'NOT_APPLICABLE';
    else if (todayGestationDays > week * 7 + CONTACT_GRACE_DAYS) state = 'OVERDUE';
    else if (todayGestationDays >= fromDay) state = 'DUE';
    else state = 'UPCOMING';
    return { week, fromDay, toDay, targetDate, state, visitAt: visit?.visitAt ?? null };
  });
}

/* --------------------------------------------------------------------------- key tests -- */

export type KeyTestSource =
  | { kind: 'LAB'; loinc: string[]; namePattern: string }
  | { kind: 'ULTRASOUND' };

export interface KeyTestDef {
  code: string;
  label: string;
  /** Gestational window in days in which the test should be done. */
  fromDay: number;
  /** Due by this gestational day (or two weeks after booking, whichever is later, for booking tests). */
  dueByDay: number;
  /** Booking tests: due by dueByDay or 14 days after booking, whichever is later. */
  atBooking: boolean;
  source: KeyTestSource;
}

/**
 * Key antenatal tests, matched against results already in the record (LOINC code or test name)
 * and ultrasound examinations. Simple by design: a matching result inside the window counts as
 * done; the result itself is not interpreted here.
 */
export const KEY_TESTS: KeyTestDef[] = [
  {
    code: 'BLOOD_GROUP',
    label: 'Blood group and antibody screen',
    fromDay: 0,
    dueByDay: 16 * 7,
    atBooking: true,
    source: {
      kind: 'LAB',
      loinc: ['882-1', '883-9', '10331-7', '34474-7', '890-4'],
      namePattern: 'blood group|grupi i gjakut|krvna grupa|abo|\\brh\\b|antibod',
    },
  },
  {
    code: 'HAEMOGLOBIN',
    label: 'Haemoglobin',
    fromDay: 0,
    dueByDay: 16 * 7,
    atBooking: true,
    source: {
      kind: 'LAB',
      loinc: ['718-7', '30313-1', '55782-7'],
      namePattern: 'h(a)?emoglobin|hemoglobin|\\bhgb\\b|\\bhb\\b',
    },
  },
  {
    code: 'HIV',
    label: 'HIV test',
    fromDay: 0,
    dueByDay: 16 * 7,
    atBooking: true,
    source: { kind: 'LAB', loinc: ['75622-1', '7917-8', '56888-1', '68961-2'], namePattern: '\\bhiv\\b' },
  },
  {
    code: 'SYPHILIS',
    label: 'Syphilis test',
    fromDay: 0,
    dueByDay: 16 * 7,
    atBooking: true,
    source: {
      kind: 'LAB',
      loinc: ['20507-0', '22587-0', '5292-8', '47238-1'],
      namePattern: 'syphilis|sifili|\\brpr\\b|\\bvdrl\\b|\\btpha\\b',
    },
  },
  {
    code: 'HEPATITIS_B',
    label: 'Hepatitis B (HBsAg)',
    fromDay: 0,
    dueByDay: 16 * 7,
    atBooking: true,
    source: {
      kind: 'LAB',
      loinc: ['5196-1', '5195-3', '58452-2'],
      namePattern: 'hbsag|hepatitis b|hepatiti b|hepatitis\\s*b',
    },
  },
  {
    code: 'ANOMALY_SCAN',
    label: 'Anomaly scan (18–22 weeks)',
    fromDay: 18 * 7,
    dueByDay: 22 * 7 + 6,
    atBooking: false,
    source: { kind: 'ULTRASOUND' },
  },
  {
    code: 'GLUCOSE_TOLERANCE',
    label: 'Glucose tolerance test (24–28 weeks)',
    fromDay: 24 * 7,
    dueByDay: 28 * 7 + 6,
    atBooking: false,
    source: {
      kind: 'LAB',
      loinc: ['20438-8', '1518-0', '1504-0', '20437-0'],
      namePattern: 'ogtt|glucose tolerance|toleranc.*gluko|toleranc.*glukoz|opterećenj',
    },
  },
];

export type KeyTestState = 'DONE' | 'DUE' | 'OVERDUE' | 'NOT_YET' | 'NOT_APPLICABLE';

export function keyTestState(
  def: KeyTestDef,
  doneOnDay: number | null,
  bookingGestationDays: number,
  todayGestationDays: number,
  ended: boolean,
): KeyTestState {
  if (doneOnDay !== null) return 'DONE';
  const dueBy = def.atBooking ? Math.max(def.dueByDay, bookingGestationDays + 14) : def.dueByDay;
  if (!def.atBooking && bookingGestationDays > def.dueByDay) return 'NOT_APPLICABLE';
  if (ended) return 'NOT_APPLICABLE';
  if (todayGestationDays < def.fromDay) return 'NOT_YET';
  if (todayGestationDays > dueBy) return 'OVERDUE';
  return 'DUE';
}
