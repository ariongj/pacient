import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  deathRecordAmendments,
  deathRecords,
  patients,
  type DeathCause,
  type Patient,
} from '../../db/schema.js';
import { kosovoDate } from '../identity/identity.service.js';

/* ------------------------------------------------------------------ vocabularies -------- */

export const PLACES_OF_DEATH = [
  'HOSPITAL',
  'EMERGENCY_DEPARTMENT',
  'HOME',
  'NURSING_HOME',
  'EN_ROUTE',
  'OTHER',
] as const;
export const MANNERS_OF_DEATH = [
  'NATURAL',
  'ACCIDENT',
  'INTENTIONAL_SELF_HARM',
  'ASSAULT',
  'PENDING_INVESTIGATION',
  'UNDETERMINED',
] as const;
export const AUTOPSY_STATUSES = ['NONE', 'REQUESTED', 'PENDING', 'PERFORMED'] as const;
export const PREGNANCY_STATUSES = [
  'NOT_PREGNANT',
  'PREGNANT',
  'WITHIN_42_DAYS',
  'DAYS_43_TO_1_YEAR',
  'UNKNOWN',
] as const;
/** Manners of death that must be reported to the prosecutor / forensic medicine. */
export const FORENSIC_MANNERS: ReadonlySet<string> = new Set([
  'ACCIDENT',
  'INTENTIONAL_SELF_HARM',
  'ASSAULT',
  'PENDING_INVESTIGATION',
]);
export const PART_ONE_LINES = ['a', 'b', 'c', 'd'] as const;

/* ------------------------------------------------------------------ input ---------------- */

export const Icd10 = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,2})?$/, 'Use an ICD-10 code, e.g. I21.9');

const CauseInput = z.object({
  line: z.enum(['a', 'b', 'c', 'd', 'II']),
  text: z.string().trim().min(2).max(300),
  icd10: Icd10.nullable().optional(),
  interval: z.string().trim().max(50).nullable().optional(),
});

const PerinatalInput = z
  .object({
    birthWeightGrams: z.number().int().min(100).max(7000).nullable().optional(),
    gestationWeeks: z.number().int().min(16).max(45).nullable().optional(),
    multiplePregnancy: z.boolean().nullable().optional(),
    stillbirth: z.boolean().nullable().optional(),
    hoursSurvived: z
      .number()
      .int()
      .min(0)
      .max(24 * 365)
      .nullable()
      .optional(),
    maternalConditions: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

/** Fields of a death record a doctor writes (drafts) and that amendments may change. */
export const DeathFields = z.object({
  diedAt: z.coerce.date(),
  placeOfDeath: z.enum(PLACES_OF_DEATH),
  placeDetail: z.string().trim().max(200).nullable().optional(),
  admissionId: z.string().uuid().nullable().optional(),
  causes: z.array(CauseInput).min(1).max(10),
  underlyingCauseIcd10: Icd10,
  mannerOfDeath: z.enum(MANNERS_OF_DEATH),
  autopsy: z.enum(AUTOPSY_STATUSES).default('NONE'),
  pregnancyStatus: z.enum(PREGNANCY_STATUSES).nullable().optional(),
  perinatal: PerinatalInput.nullable().optional(),
  reportedToForensics: z.boolean().default(false),
});
export type DeathFieldsInput = z.infer<typeof DeathFields>;

/** Fields an amendment may change (identity, facility and certifier never change). */
export const AMENDABLE_FIELDS = [
  'diedAt',
  'placeOfDeath',
  'placeDetail',
  'causes',
  'underlyingCauseIcd10',
  'mannerOfDeath',
  'autopsy',
  'pregnancyStatus',
  'perinatal',
  'reportedToForensics',
] as const;
export type AmendableField = (typeof AMENDABLE_FIELDS)[number];

export function normaliseCauses(causes: z.infer<typeof CauseInput>[]): DeathCause[] {
  const order = ['a', 'b', 'c', 'd', 'II'];
  return [...causes]
    .sort((x, y) => order.indexOf(x.line) - order.indexOf(y.line))
    .map((c) => ({
      line: c.line,
      text: c.text,
      icd10: c.icd10 ?? null,
      interval: c.interval?.trim() ? c.interval.trim() : null,
    }));
}

/* ------------------------------------------------------------------ checks --------------- */

/** Blocking problems: the certificate cannot be signed until they are fixed. */
export interface DeathProblem {
  code: string;
  message: string;
  field?: string;
}
/** Warnings the certifying doctor must acknowledge before signing. */
export interface DeathWarning {
  code: string;
  message: string;
}

/** Modes of dying – not acceptable as the only cause of death (WHO MCCD guidance). */
const MODE_OF_DYING = [
  /^I46/, // cardiac arrest
  /^I49\.0/, // ventricular fibrillation
  /^J96/, // respiratory failure
  /^R09\.2/, // respiratory arrest
  /^R57/, // shock
  /^R99/, // ill-defined / unknown cause
  /^I50\.9/, // heart failure, unspecified
  /^R68\.8/, // multi-organ failure (unspecified)
  /^K72\.9/, // hepatic failure, unspecified
  /^N19/, // kidney failure, unspecified
];
const MODE_WORDS =
  /\b(cardiac arrest|cardiorespiratory arrest|respiratory (failure|arrest)|heart failure|multi[- ]?organ failure|asystole|shock|ndalim kardiak|ndalim i zemrës|insuficiencë respiratore|srčani zastoj|zastoj srca|respiratorna insuficijencija)\b/i;

const code3 = (icd: string) => icd.slice(0, 3);
const ageYears = (dob: string, at: Date) => {
  const d = new Date(`${dob}T00:00:00Z`);
  let a = at.getUTCFullYear() - d.getUTCFullYear();
  const m = at.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) a--;
  return a;
};
const ageDays = (dob: string, at: Date) =>
  Math.floor((at.getTime() - new Date(`${dob}T00:00:00Z`).getTime()) / 86_400_000);

export interface DeathValues {
  diedAt: Date;
  placeOfDeath: string;
  placeDetail: string | null;
  causes: DeathCause[];
  underlyingCauseIcd10: string;
  mannerOfDeath: string;
  autopsy: string;
  pregnancyStatus: string | null;
  perinatal: Record<string, unknown> | null;
  reportedToForensics: boolean;
}

/**
 * Checks a death record against the WHO certification rules. Problems block signing; warnings
 * must be acknowledged by the certifying doctor.
 */
export function checkDeath(
  v: DeathValues,
  patient: Pick<Patient, 'dateOfBirth' | 'sex'>,
  now = new Date(),
): { problems: DeathProblem[]; warnings: DeathWarning[] } {
  const problems: DeathProblem[] = [];
  const warnings: DeathWarning[] = [];
  const partOne = v.causes.filter((c) => c.line !== 'II');

  if (v.diedAt.getTime() > now.getTime() + 5 * 60_000) {
    problems.push({
      code: 'DIED_IN_FUTURE',
      field: 'diedAt',
      message: 'The time of death cannot be in the future',
    });
  }
  if (v.diedAt.getTime() < new Date(`${patient.dateOfBirth}T00:00:00Z`).getTime() - 86_400_000) {
    problems.push({
      code: 'DIED_BEFORE_BIRTH',
      field: 'diedAt',
      message: 'The time of death is before the date of birth',
    });
  }
  // Part I: line a is required and lines are filled from the top without gaps.
  const lines = partOne.map((c) => c.line);
  if (!lines.includes('a')) {
    problems.push({
      code: 'PART_ONE_LINE_A',
      field: 'causes',
      message: 'Part I line (a) – the immediate cause – is required',
    });
  }
  const filled = PART_ONE_LINES.map((l) => lines.includes(l));
  const lastFilled = filled.lastIndexOf(true);
  if (filled.slice(0, lastFilled).some((f) => !f)) {
    problems.push({
      code: 'PART_ONE_GAP',
      field: 'causes',
      message: 'Fill Part I from line (a) downwards without leaving gaps',
    });
  }
  if (new Set(lines).size !== lines.length) {
    problems.push({
      code: 'PART_ONE_DUPLICATE_LINE',
      field: 'causes',
      message: 'Each Part I line can be used once',
    });
  }
  if (partOne.some((c) => !c.icd10)) {
    problems.push({
      code: 'PART_ONE_CODE',
      field: 'causes',
      message: 'Give an ICD-10 code for every Part I line',
    });
  }

  // Pregnancy status for women of reproductive age; perinatal data for infants.
  const age = ageYears(patient.dateOfBirth, v.diedAt);
  if (patient.sex === 'FEMALE' && age >= 10 && age <= 54 && !v.pregnancyStatus) {
    problems.push({
      code: 'PREGNANCY_STATUS_REQUIRED',
      field: 'pregnancyStatus',
      message: 'State whether the woman was pregnant or recently pregnant (ages 10–54)',
    });
  }
  const days = ageDays(patient.dateOfBirth, v.diedAt);
  if (days < 365) {
    const p = (v.perinatal ?? {}) as { birthWeightGrams?: unknown; gestationWeeks?: unknown };
    if (p.birthWeightGrams == null || p.gestationWeeks == null) {
      problems.push({
        code: 'PERINATAL_REQUIRED',
        field: 'perinatal',
        message: 'For a death in the first year of life give the birth weight and gestation',
      });
    }
  }
  if (FORENSIC_MANNERS.has(v.mannerOfDeath) && !v.reportedToForensics) {
    problems.push({
      code: 'FORENSIC_REPORT_REQUIRED',
      field: 'reportedToForensics',
      message:
        'Deaths from external causes or under investigation must be reported to the prosecutor and forensic medicine',
    });
  }

  // Underlying cause: normally the condition on the lowest completed Part I line.
  const lowest = [...partOne]
    .filter((c) => c.line !== 'II')
    .sort(
      (x, y) => PART_ONE_LINES.indexOf(y.line as 'a') - PART_ONE_LINES.indexOf(x.line as 'a'),
    )[0];
  const underlying = v.underlyingCauseIcd10;
  const external = /^[V-Y]/.test(underlying);
  if (lowest?.icd10 && code3(lowest.icd10) !== code3(underlying) && !external) {
    warnings.push({
      code: 'UNDERLYING_NOT_LOWEST_LINE',
      message:
        'The underlying cause is normally the condition on the lowest completed line of Part I',
    });
  }
  if (/^R/.test(underlying)) {
    warnings.push({
      code: 'ILL_DEFINED_UNDERLYING',
      message:
        'An ill-defined condition (R00–R99) is given as the underlying cause – mortality statistics need a specific disease',
    });
  }
  if (
    partOne.length === 1 &&
    partOne[0] &&
    ((partOne[0].icd10 && MODE_OF_DYING.some((re) => re.test(partOne[0]!.icd10!))) ||
      MODE_WORDS.test(partOne[0].text))
  ) {
    warnings.push({
      code: 'MODE_OF_DYING_ONLY',
      message:
        'Part I gives only a mode of dying (e.g. cardiac arrest, respiratory failure) – add the disease that led to it',
    });
  }
  if (FORENSIC_MANNERS.has(v.mannerOfDeath) && v.mannerOfDeath !== 'PENDING_INVESTIGATION') {
    if (!external) {
      warnings.push({
        code: 'EXTERNAL_CAUSE_EXPECTED',
        message:
          'For injuries and poisonings the underlying cause is the external cause (ICD-10 V01–Y98)',
      });
    }
  } else if (external && v.mannerOfDeath === 'NATURAL') {
    warnings.push({
      code: 'NATURAL_WITH_EXTERNAL_CAUSE',
      message: 'An external cause of death is coded, but the manner of death is natural',
    });
  }
  return { problems, warnings };
}

/* ------------------------------------------------------------------ amendments ----------- */

type DeathRow = typeof deathRecords.$inferSelect;
type AmendmentRow = typeof deathRecordAmendments.$inferSelect;

/** Values as signed, with all amendments applied in order. */
export function effectiveValues(row: DeathRow, amendments: AmendmentRow[]): DeathValues {
  const v: DeathValues = {
    diedAt: row.diedAt,
    placeOfDeath: row.placeOfDeath,
    placeDetail: row.placeDetail,
    causes: row.causes,
    underlyingCauseIcd10: row.underlyingCauseIcd10,
    mannerOfDeath: row.mannerOfDeath,
    autopsy: row.autopsy,
    pregnancyStatus: row.pregnancyStatus,
    perinatal: row.perinatal ?? null,
    reportedToForensics: row.reportedToForensics,
  };
  const sorted = [...amendments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const a of sorted) {
    for (const [field, change] of Object.entries(a.changes)) {
      if (!(AMENDABLE_FIELDS as readonly string[]).includes(field)) continue;
      const next = change[1];
      (v as unknown as Record<string, unknown>)[field] =
        field === 'diedAt' ? new Date(String(next)) : next;
    }
  }
  return v;
}

export async function amendmentsFor(recordIds: string[], executor: Executor = db) {
  if (!recordIds.length) return new Map<string, AmendmentRow[]>();
  const rows = await executor
    .select()
    .from(deathRecordAmendments)
    .where(inArray(deathRecordAmendments.deathRecordId, recordIds))
    .orderBy(asc(deathRecordAmendments.createdAt));
  const map = new Map<string, AmendmentRow[]>();
  for (const r of rows) map.set(r.deathRecordId, [...(map.get(r.deathRecordId) ?? []), r]);
  return map;
}

/* ------------------------------------------------------------------ numbering ------------ */

/** Next certificate number for the year, e.g. VD-2026-000123 (serialised by an advisory lock). */
export async function nextCertificateNumber(tx: Executor, at = new Date()): Promise<string> {
  const year = kosovoDate(at).slice(0, 4);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`death_certificate_${year}`}))`);
  const prefix = `VD-${year}-`;
  const [row] = await tx
    .select({
      max: sql<string | null>`max(${deathRecords.certificateNumber})`,
    })
    .from(deathRecords)
    .where(sql`${deathRecords.certificateNumber} LIKE ${`${prefix}%`}`);
  const last = row?.max ? Number(row.max.slice(prefix.length)) : 0;
  return `${prefix}${String(last + 1).padStart(6, '0')}`;
}

/* ------------------------------------------------------------------ statistics ----------- */

/** ICD-10 chapters by 3-character code range (for mortality by cause group). */
export const ICD10_CHAPTERS: { chapter: string; from: string; to: string; label: string }[] = [
  { chapter: 'I', from: 'A00', to: 'B99', label: 'Infectious and parasitic diseases' },
  { chapter: 'II', from: 'C00', to: 'D48', label: 'Neoplasms' },
  { chapter: 'III', from: 'D50', to: 'D89', label: 'Blood and immune disorders' },
  { chapter: 'IV', from: 'E00', to: 'E90', label: 'Endocrine, nutritional and metabolic' },
  { chapter: 'V', from: 'F00', to: 'F99', label: 'Mental and behavioural disorders' },
  { chapter: 'VI', from: 'G00', to: 'G99', label: 'Diseases of the nervous system' },
  { chapter: 'VII', from: 'H00', to: 'H59', label: 'Diseases of the eye' },
  { chapter: 'VIII', from: 'H60', to: 'H95', label: 'Diseases of the ear' },
  { chapter: 'IX', from: 'I00', to: 'I99', label: 'Diseases of the circulatory system' },
  { chapter: 'X', from: 'J00', to: 'J99', label: 'Diseases of the respiratory system' },
  { chapter: 'XI', from: 'K00', to: 'K93', label: 'Diseases of the digestive system' },
  { chapter: 'XII', from: 'L00', to: 'L99', label: 'Diseases of the skin' },
  { chapter: 'XIII', from: 'M00', to: 'M99', label: 'Musculoskeletal diseases' },
  { chapter: 'XIV', from: 'N00', to: 'N99', label: 'Diseases of the genitourinary system' },
  { chapter: 'XV', from: 'O00', to: 'O99', label: 'Pregnancy, childbirth and the puerperium' },
  { chapter: 'XVI', from: 'P00', to: 'P96', label: 'Perinatal conditions' },
  { chapter: 'XVII', from: 'Q00', to: 'Q99', label: 'Congenital anomalies' },
  { chapter: 'XVIII', from: 'R00', to: 'R99', label: 'Ill-defined causes' },
  { chapter: 'XIX', from: 'S00', to: 'T98', label: 'Injury and poisoning' },
  { chapter: 'XX', from: 'V01', to: 'Y98', label: 'External causes' },
  { chapter: 'XXII', from: 'U00', to: 'U85', label: 'Codes for special purposes' },
];

export function chapterOf(icd: string) {
  const c = code3(icd.toUpperCase());
  return ICD10_CHAPTERS.find((ch) => c >= ch.from && c <= ch.to) ?? null;
}

export const AGE_BANDS: { band: string; from: number; to: number }[] = [
  { band: '<1', from: 0, to: 0 },
  { band: '1–4', from: 1, to: 4 },
  { band: '5–14', from: 5, to: 14 },
  { band: '15–44', from: 15, to: 44 },
  { band: '45–64', from: 45, to: 64 },
  { band: '65–74', from: 65, to: 74 },
  { band: '75–84', from: 75, to: 84 },
  { band: '85+', from: 85, to: 200 },
];

export interface DeathForStats extends DeathValues {
  facilityId: string;
  dateOfBirth: string;
  sex: string;
  admissionId: string | null;
}

/** Signed death certificates (amendments applied) for statistics; no identifiers. */
export async function deathsForStats(opts: {
  from: Date;
  to: Date;
  facilityId?: string;
}): Promise<DeathForStats[]> {
  const rows = await db
    .select({
      record: deathRecords,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
    })
    .from(deathRecords)
    .innerJoin(patients, eq(patients.id, deathRecords.patientId))
    .where(
      and(
        eq(deathRecords.status, 'SIGNED'),
        opts.facilityId ? eq(deathRecords.facilityId, opts.facilityId) : undefined,
        // Amendments may move the time of death; filter precisely after applying them.
        sql`${deathRecords.diedAt} >= ${new Date(opts.from.getTime() - 366 * 86_400_000)}`,
        sql`${deathRecords.diedAt} < ${new Date(opts.to.getTime() + 366 * 86_400_000)}`,
      ),
    );
  const amendments = await amendmentsFor(rows.map((r) => r.record.id));
  return rows
    .map((r) => ({
      ...effectiveValues(r.record, amendments.get(r.record.id) ?? []),
      facilityId: r.record.facilityId,
      admissionId: r.record.admissionId,
      dateOfBirth: r.dateOfBirth,
      sex: r.sex,
    }))
    .filter((d) => d.diedAt >= opts.from && d.diedAt < opts.to);
}

/**
 * Small-cell protection for one group of counts. Counts from 1 to threshold − 1 are hidden, and
 * when exactly one hidden count could be worked out from the published total (the residual of
 * cells that are not listed, e.g. an unknown manner, counts as a cell), the smallest other count is
 * hidden as well – or the total, when there is none. The residual is derivable by subtraction, so
 * it is protected like a published cell.
 */
function protect(cells: number[], total: number, threshold: number) {
  const isSmall = (n: number) => n > 0 && n < threshold;
  const residual = Math.max(0, total - cells.reduce((a, b) => a + b, 0));
  const all = residual > 0 ? [...cells, residual] : [...cells];
  const hidden = all.map(isSmall);
  let totalHidden = isSmall(total);
  if (!totalHidden && hidden.filter(Boolean).length === 1) {
    const r = all.length - 1;
    let candidate = -1;
    // The unlisted residual is never published, so hiding it costs nothing: prefer it.
    if (residual > 0 && !hidden[r]) candidate = r;
    else {
      all.forEach((n, i) => {
        if (hidden[i] || n <= 0) return;
        if (candidate === -1 || n < all[candidate]!) candidate = i;
      });
    }
    if (candidate >= 0) hidden[candidate] = true;
    else totalHidden = true;
  }
  return {
    cells: cells.map((n, i) => (hidden[i] ? null : n)),
    total: totalHidden ? null : total,
  };
}

/** Whole calendar months (UTC) around the requested period, so periods cannot be differenced. */
export function wholeMonths(from: Date, to: Date) {
  const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const firstOfTo = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  const end =
    firstOfTo.getTime() === to.getTime()
      ? firstOfTo
      : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() + 1, 1));
  return { from: start, to: end };
}

export function buildMortalityStats(
  deaths: DeathForStats[],
  opts: { from: Date; to: Date; discharges: number; deceasedDischarges: number; threshold: number },
) {
  const th = opts.threshold;
  const n = deaths.length;
  const totalShown = n > 0 && n < th ? null : n;

  const months: string[] = [];
  for (
    let d = new Date(Date.UTC(opts.from.getUTCFullYear(), opts.from.getUTCMonth(), 1));
    d < opts.to;
    d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
  ) {
    months.push(d.toISOString().slice(0, 7));
  }
  const monthCounts = months.map(
    (month) => deaths.filter((x) => kosovoDate(x.diedAt).slice(0, 7) === month).length,
  );
  const monthCells = protect(monthCounts, n, th).cells;
  const byMonth = months.map((month, i) => ({ month, count: monthCells[i]! }));

  // Chapters: only chapters with enough deaths are listed by name; the others are pooled in
  // one row, so the table does not reveal that a rare cause occurred.
  const chapterCounts = new Map<string, number>();
  for (const x of deaths) {
    const ch = chapterOf(x.underlyingCauseIcd10)?.chapter ?? '?';
    chapterCounts.set(ch, (chapterCounts.get(ch) ?? 0) + 1);
  }
  const named = ICD10_CHAPTERS.filter((ch) => (chapterCounts.get(ch.chapter) ?? 0) >= th);
  const pooled = n - named.reduce((a, ch) => a + chapterCounts.get(ch.chapter)!, 0);
  const chapterCells = protect(
    [...named.map((ch) => chapterCounts.get(ch.chapter)!), pooled],
    n,
    th,
  ).cells;
  const byChapter: { chapter: string; range: string; label: string; count: number | null }[] =
    named.map((ch, i) => ({
      chapter: ch.chapter,
      range: `${ch.from}–${ch.to}`,
      label: ch.label,
      count: chapterCells[i]!,
    }));
  byChapter.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  if (pooled > 0) {
    byChapter.push({
      chapter: 'OTHER',
      range: '',
      label: 'Other chapters (each with fewer deaths)',
      count: chapterCells[named.length]!,
    });
  }

  const bandRows = AGE_BANDS.map((b) => {
    const inBand = deaths.filter((x) => {
      const a = ageYears(x.dateOfBirth, x.diedAt);
      return a >= b.from && a <= b.to;
    });
    return {
      band: b.band,
      male: inBand.filter((x) => x.sex === 'MALE').length,
      female: inBand.filter((x) => x.sex === 'FEMALE').length,
      total: inBand.length,
    };
  });
  const bandTotals = protect(
    bandRows.map((r) => r.total),
    n,
    th,
  ).cells;
  const byAgeBand = bandRows.map((r, i) => {
    const total = bandTotals[i]!;
    // A hidden band total hides its split too; otherwise the split is protected against it.
    if (total === null) return { band: r.band, male: null, female: null, total: null };
    const split = protect([r.male, r.female], r.total, th);
    return { band: r.band, male: split.cells[0]!, female: split.cells[1]!, total: split.total };
  });

  const mannerCounts = MANNERS_OF_DEATH.map(
    (m) => deaths.filter((x) => x.mannerOfDeath === m).length,
  );
  const mannerCells = protect(mannerCounts, n, th).cells;
  const byManner = MANNERS_OF_DEATH.map((m, i) => ({
    manner: m,
    count: mannerCells[i]!,
    raw: mannerCounts[i]!,
  }))
    .filter((m) => m.raw !== 0)
    .map(({ manner, count }) => ({ manner, count }));

  const inHospital = deaths.filter(
    (x) => x.placeOfDeath === 'HOSPITAL' || x.placeOfDeath === 'EMERGENCY_DEPARTMENT',
  ).length;
  const inHospitalCells = protect([inHospital], n, th).cells;
  const deceasedShown =
    opts.deceasedDischarges > 0 && opts.deceasedDischarges < th ? null : opts.deceasedDischarges;
  return {
    from: opts.from.toISOString(),
    to: opts.to.toISOString(),
    suppressionThreshold: th,
    total: totalShown,
    byMonth,
    byChapter,
    byAgeBand,
    byManner,
    inHospital: {
      /** Certificates with place of death hospital or emergency department. */
      deaths: inHospitalCells[0]!,
      discharges: opts.discharges,
      /** Hospital stays that ended with the outcome "deceased". */
      deceasedDischarges: deceasedShown,
      /** In-hospital mortality: deceased discharges per 100 discharges (null when suppressed). */
      ratePer100:
        deceasedShown !== null && opts.discharges > 0
          ? Math.round((opts.deceasedDischarges / opts.discharges) * 1000) / 10
          : null,
    },
  };
}
