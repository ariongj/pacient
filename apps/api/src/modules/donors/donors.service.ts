/**
 * Blood donors: eligibility rules, deferrals and the unit that results from a donation.
 *
 * ILLUSTRATIVE – the rules follow the spirit of EU Directive 2004/33/EC (donor eligibility) and must
 * be replaced by the national blood transfusion service's criteria before clinical use. Each rule
 * has a code, a message and how long the donor is deferred when it applies.
 *
 * Untested blood never reaches stock: the blood bank has no quarantine status, so the blood unit is
 * created only when the mandatory tests are recorded – released (AVAILABLE) when all markers are
 * negative, otherwise created as DISCARDED for traceability.
 */
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { bloodDonations, bloodDonors, bloodUnits, patients } from '../../db/schema.js';
import type { Abo, RhD } from '../bloodbank/bloodbank.service.js';

export const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ questionnaire -------- */

export interface Question {
  code: string;
  /** English source text (translated in the web app). */
  text: string;
  /** Answer that triggers the rule. */
  triggerOn: boolean;
  /** Days of deferral, or 'PERMANENT'. */
  defer: number | 'PERMANENT';
  /** Shown to women only. */
  womenOnly?: boolean;
}

export const QUESTIONS: Question[] = [
  { code: 'FEELING_WELL', text: 'Do you feel well today?', triggerOn: false, defer: 1 },
  {
    code: 'RECENT_ILLNESS',
    text: 'Have you had a fever or an infection in the last 2 weeks?',
    triggerOn: true,
    defer: 14,
  },
  {
    code: 'ANTIBIOTICS',
    text: 'Have you taken antibiotics in the last 7 days?',
    triggerOn: true,
    defer: 7,
  },
  {
    code: 'TATTOO_PIERCING',
    text: 'Have you had a tattoo, piercing or acupuncture in the last 4 months?',
    triggerOn: true,
    defer: 120,
  },
  {
    code: 'MALARIA_TRAVEL',
    text: 'Have you travelled to a malaria area in the last 6 months?',
    triggerOn: true,
    defer: 183,
  },
  {
    code: 'SURGERY',
    text: 'Have you had surgery or an endoscopy in the last 4 months?',
    triggerOn: true,
    defer: 120,
  },
  {
    code: 'PREGNANCY',
    text: 'Have you been pregnant or given birth in the last 6 months?',
    triggerOn: true,
    defer: 183,
    womenOnly: true,
  },
  {
    code: 'RISK_BEHAVIOUR',
    text: 'Have you had sexual contact with a new partner or a partner at risk of infection in the last 4 months?',
    triggerOn: true,
    defer: 120,
  },
  {
    code: 'INJECTED_DRUGS',
    text: 'Have you ever injected drugs not prescribed by a doctor?',
    triggerOn: true,
    defer: 'PERMANENT',
  },
  {
    code: 'KNOWN_INFECTION',
    text: 'Have you ever tested positive for HIV, hepatitis B or hepatitis C?',
    triggerOn: true,
    defer: 'PERMANENT',
  },
];

export type Answers = Record<string, boolean | undefined>;

/* ------------------------------------------------------------------ checks --------------- */

export interface DonorFacts {
  sex: 'MALE' | 'FEMALE' | string;
  dateOfBirth: string;
  status: string;
  deferredUntil: string | null;
  /** Completed (and aborted) whole-blood donations, newest first. */
  donationDates: Date[];
  /** Completed donations ever (for the first-donation age limit). */
  completedCount: number;
}

export interface Measurements {
  haemoglobin?: number | null;
  systolic?: number | null;
  diastolic?: number | null;
  pulse?: number | null;
  weightKg?: number | null;
}

export interface Problem {
  code: string;
  message: string;
  /** Days to defer, 'PERMANENT', or null for "not eligible" without a new deferral. */
  defer: number | 'PERMANENT' | null;
  /** Values for {placeholders} in the message. */
  vars?: Record<string, string | number>;
}

export const LIMITS = {
  minAge: 18,
  maxAge: 65,
  maxFirstDonationAge: 60,
  hbWomen: 125,
  hbMen: 135,
  systolic: [100, 180] as const,
  diastolic: [60, 100] as const,
  pulse: [50, 100] as const,
  minWeightKg: 50,
  intervalDaysMen: 84,
  intervalDaysWomen: 112,
  maxPerYearMen: 4,
  maxPerYearWomen: 3,
  volume: [405, 495] as const,
  /** Hb below the limit: check again in 30 days. */
  hbDeferDays: 30,
} as const;

export function ageOn(dateOfBirth: string, at: Date) {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const m = at.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

/** Age rules for registering a donor (first donation up to 60, donors up to 65). */
export function registrationProblem(
  p: { dateOfBirth: string },
  completedCount: number,
  now = new Date(),
): Problem | null {
  const age = ageOn(p.dateOfBirth, now);
  if (age < LIMITS.minAge)
    return { code: 'TOO_YOUNG', message: 'Donors must be at least 18 years old', defer: null };
  if (age > LIMITS.maxAge)
    return { code: 'TOO_OLD', message: 'Donors must be 65 or younger', defer: null };
  if (completedCount === 0 && age > LIMITS.maxFirstDonationAge) {
    return {
      code: 'FIRST_DONATION_AGE',
      message: 'A first donation is possible up to the age of 60',
      defer: null,
    };
  }
  return null;
}

/** Earliest date the donor may give whole blood again, from the interval and yearly limits. */
export function nextEligibleDate(facts: DonorFacts, now = new Date()): string {
  const women = facts.sex === 'FEMALE';
  let next = now;
  const last = facts.donationDates[0];
  if (last) {
    const byInterval = addDays(last, women ? LIMITS.intervalDaysWomen : LIMITS.intervalDaysMen);
    if (byInterval > next) next = byInterval;
  }
  const maxPerYear = women ? LIMITS.maxPerYearWomen : LIMITS.maxPerYearMen;
  // Dates are newest first. With the yearly maximum reached, the next donation may follow once
  // the maxPerYear-th most recent one has left the rolling 365-day window.
  const inYear = facts.donationDates.filter((d) => d > addDays(now, -365));
  if (inYear.length >= maxPerYear) {
    const oldest = inYear[maxPerYear - 1]!;
    const byYear = addDays(oldest, 365);
    if (byYear > next) next = byYear;
  }
  if (facts.status === 'DEFERRED' && facts.deferredUntil) {
    const until = new Date(`${facts.deferredUntil}T00:00:00Z`);
    if (until > next) next = until;
  }
  return isoDate(next);
}

/**
 * Everything that stops a donation today. An empty list means the donor may donate. Measurements
 * that were not taken yet are not judged (the live form shows the rest).
 */
export function evaluateEligibility(
  facts: DonorFacts,
  answers: Answers,
  m: Measurements,
  now = new Date(),
): Problem[] {
  const problems: Problem[] = [];
  const women = facts.sex === 'FEMALE';
  const age = ageOn(facts.dateOfBirth, now);

  if (facts.status === 'PERMANENTLY_DEFERRED') {
    problems.push({
      code: 'PERMANENTLY_DEFERRED',
      message: 'The donor is permanently deferred',
      defer: null,
    });
  } else if (
    facts.status === 'DEFERRED' &&
    facts.deferredUntil &&
    facts.deferredUntil > isoDate(now)
  ) {
    problems.push({
      code: 'DEFERRED',
      message: 'The donor is deferred until {date}',
      defer: null,
      vars: { date: facts.deferredUntil },
    });
  }
  const reg = registrationProblem(facts, facts.completedCount, now);
  if (reg) problems.push(reg);
  else if (age > LIMITS.maxAge) {
    problems.push({ code: 'TOO_OLD', message: 'Donors must be 65 or younger', defer: null });
  }

  const next = nextEligibleDate({ ...facts, status: 'ACTIVE', deferredUntil: null }, now);
  if (next > isoDate(now)) {
    problems.push({
      code: 'INTERVAL',
      message: 'Too soon after the last donation (next possible on {next})',
      defer: null,
      vars: { next },
    });
  }

  for (const q of QUESTIONS) {
    if (q.womenOnly && !women) continue;
    const a = answers[q.code];
    if (a === undefined) continue;
    if (a === q.triggerOn) {
      problems.push({ code: `Q_${q.code}`, message: q.text, defer: q.defer });
    }
  }

  if (m.haemoglobin != null) {
    const min = women ? LIMITS.hbWomen : LIMITS.hbMen;
    if (m.haemoglobin < min) {
      problems.push({
        code: 'HB_LOW',
        message: 'Haemoglobin below {min} g/L',
        defer: LIMITS.hbDeferDays,
        vars: { min },
      });
    }
  }
  if (m.systolic != null && (m.systolic < LIMITS.systolic[0] || m.systolic > LIMITS.systolic[1])) {
    problems.push({
      code: 'BP_SYSTOLIC',
      message: 'Systolic blood pressure outside 100–180',
      defer: 1,
    });
  }
  if (
    m.diastolic != null &&
    (m.diastolic < LIMITS.diastolic[0] || m.diastolic > LIMITS.diastolic[1])
  ) {
    problems.push({
      code: 'BP_DIASTOLIC',
      message: 'Diastolic blood pressure outside 60–100',
      defer: 1,
    });
  }
  if (m.pulse != null && (m.pulse < LIMITS.pulse[0] || m.pulse > LIMITS.pulse[1])) {
    problems.push({ code: 'PULSE', message: 'Pulse outside 50–100', defer: 1 });
  }
  if (m.weightKg != null && m.weightKg < LIMITS.minWeightKg) {
    problems.push({ code: 'WEIGHT', message: 'Weight below 50 kg', defer: null });
  }
  return problems;
}

/** The deferral that follows from the problems found: permanent wins, otherwise the longest. */
export function deferralFrom(problems: Problem[], now = new Date()) {
  if (problems.some((p) => p.defer === 'PERMANENT')) {
    return { status: 'PERMANENTLY_DEFERRED' as const, until: null };
  }
  const days = Math.max(0, ...problems.map((p) => (typeof p.defer === 'number' ? p.defer : 0)));
  if (!days) return null;
  return { status: 'DEFERRED' as const, until: isoDate(addDays(now, days)) };
}

/** Facts about a donor for the eligibility rules. */
export async function donorFacts(donorId: string, executor: Executor = db) {
  const [row] = await executor
    .select({ donor: bloodDonors, sex: patients.sex, dateOfBirth: patients.dateOfBirth })
    .from(bloodDonors)
    .innerJoin(patients, eq(patients.id, bloodDonors.patientId))
    .where(eq(bloodDonors.id, donorId));
  if (!row) return null;
  // Aborted collections count for the interval (blood was lost), not for the donation count.
  const visits = await executor
    .select({ attendedAt: bloodDonations.attendedAt, outcome: bloodDonations.outcome })
    .from(bloodDonations)
    .where(
      and(
        eq(bloodDonations.donorId, donorId),
        sql`${bloodDonations.outcome} IN ('COMPLETED', 'ABORTED')`,
      ),
    )
    .orderBy(desc(bloodDonations.attendedAt));
  const facts: DonorFacts = {
    sex: row.sex,
    dateOfBirth: row.dateOfBirth,
    status: row.donor.status,
    deferredUntil: row.donor.deferredUntil,
    donationDates: visits.map((v) => v.attendedAt),
    completedCount: visits.filter((v) => v.outcome === 'COMPLETED').length,
  };
  return { donor: row.donor, facts };
}

/* ------------------------------------------------------------------ units ---------------- */

/** Whole blood keeps 35 days (CPDA-1), as in the blood bank's stock. */
export const WHOLE_BLOOD_SHELF_DAYS = 35;

/** Next donation unit number, e.g. "KSD26-000123" (serialised per year by an advisory lock). */
export async function nextDonationUnitNumber(tx: Executor, at = new Date()) {
  const prefix = `KSD${String(at.getUTCFullYear() % 100).padStart(2, '0')}-`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`donation-units:${prefix}`}))`);
  const [row] = await tx
    .select({ n: count() })
    .from(bloodUnits)
    .where(sql`${bloodUnits.unitNumber} LIKE ${`${prefix}%`}`);
  // Count-based numbering never reuses a number: units are never deleted.
  return `${prefix}${String(Number(row?.n ?? 0) + 1).padStart(6, '0')}`;
}

export const MARKERS = ['hiv', 'hbv', 'hcv', 'syphilis'] as const;
export type Marker = (typeof MARKERS)[number];
export type MarkerResult = 'NEGATIVE' | 'REACTIVE';

export const MARKER_LABEL: Record<Marker, string> = {
  hiv: 'HIV',
  hbv: 'Hepatitis B',
  hcv: 'Hepatitis C',
  syphilis: 'Syphilis',
};

/** Donations in the last 12 months per facility and group (stock contribution). */
export async function releasedUnits(since: Date, facilityId?: string | null) {
  return db
    .select({ abo: bloodUnits.abo, rhD: bloodUnits.rhD, n: count() })
    .from(bloodDonations)
    .innerJoin(bloodUnits, eq(bloodUnits.id, bloodDonations.bloodUnitId))
    .where(
      and(
        gte(bloodDonations.attendedAt, since),
        sql`${bloodUnits.discardReason} IS DISTINCT FROM ${SCREENING_DISCARD}`,
        sql`${bloodUnits.discardReason} IS DISTINCT FROM ${EXPIRED_UNTESTED}`,
        facilityId ? eq(bloodDonations.facilityId, facilityId) : undefined,
      ),
    )
    .groupBy(bloodUnits.abo, bloodUnits.rhD);
}

/** Discard reason of units that did not pass donation screening (no marker named). */
export const SCREENING_DISCARD = 'Donation screening not passed – not for transfusion';
/** Discard reason of units whose shelf life ended before their tests were recorded. */
export const EXPIRED_UNTESTED = 'Expired before the tests were recorded';

export const groupLabel = (abo: Abo | string, rhD: RhD | string) =>
  `${abo}${rhD === 'POS' ? '+' : '−'}`;
