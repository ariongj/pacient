/**
 * Cancer screening programmes.
 *
 * ILLUSTRATIVE – the age ranges, intervals and tests below follow common European practice
 * (Council Recommendation on cancer screening, 2022) and must be confirmed by the national cancer
 * control programme before the invitations are switched on:
 *   CERVICAL    women 25–64: cytology every 3 years from 25 to 49, HPV test (or cytology) every
 *               5 years from 50 to 64;
 *   BREAST      women 50–69: mammography every 2 years;
 *   COLORECTAL  women and men 50–74: faecal immunochemical test (FIT) every 2 years.
 * An inadequate sample is repeated after 3 months. An abnormal result leaves the routine programme
 * for follow-up (colposcopy, assessment clinic, colonoscopy) until the doctor closes it.
 */

export const PROGRAMME_CODES = ['CERVICAL', 'BREAST', 'COLORECTAL'] as const;
export type ProgrammeCode = (typeof PROGRAMME_CODES)[number];

export const TEST_TYPES = ['CYTOLOGY', 'HPV', 'MAMMOGRAPHY', 'FIT'] as const;
export type TestType = (typeof TEST_TYPES)[number];

export const RESULTS = ['NORMAL', 'ABNORMAL', 'INADEQUATE'] as const;
export type ScreeningResult = (typeof RESULTS)[number];

/** Episodes still in progress: a new invitation is not sent while one of these is open. */
export const OPEN_STATUSES = ['INVITED', 'BOOKED', 'SCREENED', 'REFERRED'] as const;

export interface IntervalBand {
  fromAge: number;
  toAge: number;
  months: number;
  test: TestType;
}

export interface Programme {
  code: ProgrammeCode;
  label: string;
  sex: 'FEMALE' | null;
  minAge: number;
  maxAge: number;
  bands: IntervalBand[];
  tests: TestType[];
  /** Typical follow-up after an abnormal result (shown to staff). */
  followUp: string;
}

export const PROGRAMMES: Record<ProgrammeCode, Programme> = {
  CERVICAL: {
    code: 'CERVICAL',
    label: 'Cervical screening',
    sex: 'FEMALE',
    minAge: 25,
    maxAge: 64,
    bands: [
      { fromAge: 25, toAge: 49, months: 36, test: 'CYTOLOGY' },
      { fromAge: 50, toAge: 64, months: 60, test: 'HPV' },
    ],
    tests: ['CYTOLOGY', 'HPV'],
    followUp: 'Colposcopy',
  },
  BREAST: {
    code: 'BREAST',
    label: 'Breast screening',
    sex: 'FEMALE',
    minAge: 50,
    maxAge: 69,
    bands: [{ fromAge: 50, toAge: 69, months: 24, test: 'MAMMOGRAPHY' }],
    tests: ['MAMMOGRAPHY'],
    followUp: 'Breast assessment clinic',
  },
  COLORECTAL: {
    code: 'COLORECTAL',
    label: 'Bowel screening',
    sex: null,
    minAge: 50,
    maxAge: 74,
    bands: [{ fromAge: 50, toAge: 74, months: 24, test: 'FIT' }],
    tests: ['FIT'],
    followUp: 'Colonoscopy',
  },
};

/** An inadequate sample is repeated after this many months. */
export const INADEQUATE_REPEAT_MONTHS = 3;
/** A second invitation (reminder) when nothing happened after this many days. */
export const REMINDER_AFTER_DAYS = 42;
/** An invitation not taken up after this many days counts as overdue on the worklist. */
export const INVITATION_OVERDUE_DAYS = 84;
/** An abnormal result without a recorded referral after this many days is flagged. */
export const FOLLOW_UP_SAFETY_NET_DAYS = 14;
/** Default number of new invitations per facility and day (spreads the load on clinics). */
export const DEFAULT_DAILY_CAP = 50;

export const DISCLAIMER =
  'Age ranges, intervals and tests are illustrative until confirmed by the national cancer control programme.';

/** Whole years between the date of birth and `at` (UTC calendar dates). */
export function ageOn(dateOfBirth: string, at: Date): number {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  let age = at.getUTCFullYear() - y;
  const month = at.getUTCMonth() + 1;
  if (month < m || (month === m && at.getUTCDate() < d)) age--;
  return age;
}

export function bandFor(code: ProgrammeCode, age: number): IntervalBand | null {
  return PROGRAMMES[code].bands.find((b) => age >= b.fromAge && age <= b.toAge) ?? null;
}

/** In the programme's population by sex and age (other exclusions are checked separately). */
export function inPopulation(
  code: ProgrammeCode,
  person: { sex: string; dateOfBirth: string },
  at: Date,
): boolean {
  const p = PROGRAMMES[code];
  if (p.sex && person.sex !== p.sex) return false;
  const age = ageOn(person.dateOfBirth, at);
  return age >= p.minAge && age <= p.maxAge;
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export function addMonths(date: Date, months: number): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * When the person is next due after a test on `screenedAt`: the routine interval for their age
 * at the test (NORMAL), or a repeat after 3 months (INADEQUATE). An ABNORMAL result has no
 * routine due date – follow-up decides. Returns null when the person will have left the
 * programme's age range by then (no further routine invitation).
 */
export function nextDueAfter(
  code: ProgrammeCode,
  person: { dateOfBirth: string },
  screenedAt: Date,
  result: ScreeningResult,
): string | null {
  if (result === 'ABNORMAL') return null;
  if (result === 'INADEQUATE') return isoDate(addMonths(screenedAt, INADEQUATE_REPEAT_MONTHS));
  const band = bandFor(code, ageOn(person.dateOfBirth, screenedAt));
  const months = band?.months ?? PROGRAMMES[code].bands.at(-1)!.months;
  const due = addMonths(screenedAt, months);
  return ageOn(person.dateOfBirth, due) > PROGRAMMES[code].maxAge ? null : isoDate(due);
}

/** The test offered at a given age (first band's test outside the bands). */
export function testFor(code: ProgrammeCode, age: number): TestType {
  return (bandFor(code, age) ?? PROGRAMMES[code].bands[0]!).test;
}
