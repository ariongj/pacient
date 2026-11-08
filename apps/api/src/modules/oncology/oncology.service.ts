import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { cancerCases, deathRecords, facilities, patients } from '../../db/schema.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import { amendmentsFor, effectiveValues } from '../deaths/deaths.service.js';
import { ageBand, AGE_BANDS, siteGroupOf, siteLabelOf, STAGES } from './definitions.js';

export type CancerCase = typeof cancerCases.$inferSelect;

/** Same patient, same site group, diagnosed within three months: probably the same tumour. */
export async function findPossibleDuplicate(
  patientId: string,
  topography: string,
  diagnosedOn: string,
  excludeId: string | null = null,
  executor: Executor = db,
) {
  const [row] = await executor
    .select({ id: cancerCases.id, diagnosedOn: cancerCases.diagnosedOn })
    .from(cancerCases)
    .where(
      and(
        eq(cancerCases.patientId, patientId),
        eq(cancerCases.status, 'ACTIVE'),
        sql`left(${cancerCases.topography}, 3) = ${siteGroupOf(topography)}`,
        sql`abs(${cancerCases.diagnosedOn} - ${diagnosedOn}::date) <= 92`,
        excludeId ? ne(cancerCases.id, excludeId) : undefined,
      ),
    )
    .limit(1);
  return row ?? null;
}

const isCancerCause = (icd10: string) => /^C(\d\d)/.test(icd10) && Number(icd10.slice(1, 3)) <= 97;

/**
 * Signed death certificates whose underlying cause is a cancer (C00–C97, after amendments) while
 * the person has no registered cancer: "death certificate only" candidates for the registry. A
 * doctor sees those certified by them or for patients in their care.
 */
export async function dcoCandidates(doctorId: string) {
  const rows = await db
    .select({
      record: deathRecords,
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      facilityName: facilities.name,
    })
    .from(deathRecords)
    .innerJoin(patients, eq(patients.id, deathRecords.patientId))
    .innerJoin(facilities, eq(facilities.id, deathRecords.facilityId))
    .where(
      and(
        eq(deathRecords.status, 'SIGNED'),
        isNull(patients.mergedIntoId),
        sql`(${deathRecords.certifiedById} = ${doctorId} OR EXISTS (
          SELECT 1 FROM care_assignments ca WHERE ca.patient_id = ${deathRecords.patientId}
            AND ca.doctor_id = ${doctorId} AND ca.ended_at IS NULL))`,
        sql`NOT EXISTS (SELECT 1 FROM ${cancerCases} cc WHERE cc.patient_id = ${deathRecords.patientId}
          AND cc.status <> 'WITHDRAWN')`,
      ),
    );
  const amendments = await amendmentsFor(rows.map((r) => r.record.id));
  return rows
    .map((r) => {
      const v = effectiveValues(r.record, amendments.get(r.record.id) ?? []);
      return {
        deathRecordId: r.record.id,
        patientId: r.record.patientId,
        certificateNumber: r.record.certificateNumber,
        diedAt: v.diedAt,
        underlyingCauseIcd10: v.underlyingCauseIcd10,
        facilityName: r.facilityName,
        patient: {
          firstName: r.firstName,
          lastName: r.lastName,
          nationalId: r.nationalId,
          dateOfBirth: r.dateOfBirth,
          sex: r.sex,
        },
      };
    })
    .filter((c) => isCancerCause(c.underlyingCauseIcd10))
    .sort((a, b) => new Date(b.diedAt).getTime() - new Date(a.diedAt).getTime());
}

/** Count of national DCO candidates (Ministry: a number only). */
export async function dcoCandidateCount() {
  const rows = await db
    .select({ record: deathRecords })
    .from(deathRecords)
    .where(
      and(
        eq(deathRecords.status, 'SIGNED'),
        sql`NOT EXISTS (SELECT 1 FROM ${cancerCases} cc WHERE cc.patient_id = ${deathRecords.patientId}
          AND cc.status <> 'WITHDRAWN')`,
      ),
    );
  const amendments = await amendmentsFor(rows.map((r) => r.record.id));
  return rows.filter((r) =>
    isCancerCause(
      effectiveValues(r.record, amendments.get(r.record.id) ?? []).underlyingCauseIcd10,
    ),
  ).length;
}

/* ------------------------------------------------------------------ statistics --------- */

/** Counts of 1–4 are hidden (null); zero is shown. */
const cell = (n: number) => (n > 0 && n < SMALL_CELL_THRESHOLD ? null : n);
const pct = (part: number, total: number) =>
  total >= SMALL_CELL_THRESHOLD ? Math.round((part / total) * 1000) / 10 : null;

function ageAt(dob: string, on: string) {
  const d = new Date(`${dob}T00:00:00Z`);
  const t = new Date(`${on}T00:00:00Z`);
  let a = t.getUTCFullYear() - d.getUTCFullYear();
  const m = t.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && t.getUTCDate() < d.getUTCDate())) a--;
  return a;
}

export interface StatsOptions {
  fromYear: number;
  toYear: number;
  /** Director: only cases registered at this facility. */
  facilityId?: string;
}

/**
 * Registry statistics from ACTIVE cases diagnosed in [fromYear, toYear]. Crude rates (Ministry
 * only) use the number of people registered in Pacient per municipality as the population – an
 * approximation until census population figures are loaded (see docs).
 */
export async function registryStats(opts: StatsOptions) {
  const rows = await db
    .select({
      topography: cancerCases.topography,
      diagnosedOn: cancerCases.diagnosedOn,
      basis: cancerCases.basisOfDiagnosis,
      stage: cancerCases.stage,
      sex: patients.sex,
      dateOfBirth: patients.dateOfBirth,
      municipality: patients.municipality,
    })
    .from(cancerCases)
    .innerJoin(patients, eq(patients.id, cancerCases.patientId))
    .where(
      and(
        eq(cancerCases.status, 'ACTIVE'),
        sql`extract(year from ${cancerCases.diagnosedOn}) BETWEEN ${opts.fromYear} AND ${opts.toYear}`,
        opts.facilityId ? eq(cancerCases.facilityId, opts.facilityId) : undefined,
      ),
    );
  const total = rows.length;
  const years = opts.toYear - opts.fromYear + 1;

  const bySite = new Map<string, { male: number; female: number; total: number }>();
  const byAge = new Map<string, { male: number; female: number }>();
  const byMunicipality = new Map<string, number>();
  const byYear = new Map<number, number>();
  const byStage = new Map<string, number>();
  let histology = 0;
  let microscopic = 0;
  let dco = 0;
  for (const r of rows) {
    const g = siteGroupOf(r.topography);
    const s = bySite.get(g) ?? { male: 0, female: 0, total: 0 };
    s.total++;
    if (r.sex === 'MALE') s.male++;
    else if (r.sex === 'FEMALE') s.female++;
    bySite.set(g, s);
    const band = ageBand(ageAt(r.dateOfBirth, r.diagnosedOn));
    const a = byAge.get(band) ?? { male: 0, female: 0 };
    if (r.sex === 'MALE') a.male++;
    else if (r.sex === 'FEMALE') a.female++;
    byAge.set(band, a);
    const mun = r.municipality ?? '—';
    byMunicipality.set(mun, (byMunicipality.get(mun) ?? 0) + 1);
    const y = Number(r.diagnosedOn.slice(0, 4));
    byYear.set(y, (byYear.get(y) ?? 0) + 1);
    const st = r.stage ?? 'UNKNOWN';
    byStage.set(st, (byStage.get(st) ?? 0) + 1);
    if (r.basis === 'HISTOLOGY') histology++;
    if (r.basis === 'HISTOLOGY' || r.basis === 'CYTOLOGY') microscopic++;
    if (r.basis === 'DEATH_CERTIFICATE_ONLY') dco++;
  }

  let population = new Map<string, number>();
  if (!opts.facilityId) {
    const pop = await db
      .select({ municipality: patients.municipality, n: sql<number>`count(*)::int` })
      .from(patients)
      .where(and(isNull(patients.mergedIntoId), isNull(patients.temporaryIdentity)))
      .groupBy(patients.municipality);
    population = new Map(pop.map((p) => [p.municipality ?? '—', Number(p.n)]));
  }
  const rate = (n: number, pop: number | undefined) =>
    !opts.facilityId && pop && n >= SMALL_CELL_THRESHOLD
      ? Math.round((n / years / pop) * 100_000 * 10) / 10
      : null;

  return {
    fromYear: opts.fromYear,
    toYear: opts.toYear,
    scope: opts.facilityId ? 'FACILITY' : 'NATIONAL',
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    total: cell(total),
    bySite: [...bySite]
      .map(([code, s]) => ({
        code,
        label: siteLabelOf(code),
        total: cell(s.total),
        // Secondary suppression: with the total shown, one hidden sex would follow from the other.
        ...(cell(s.male) === null || cell(s.female) === null
          ? { male: null, female: null }
          : { male: s.male, female: s.female }),
      }))
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0)),
    byAgeBand: AGE_BANDS.map((band) => {
      const a = byAge.get(band) ?? { male: 0, female: 0 };
      return { band, male: cell(a.male), female: cell(a.female) };
    }),
    byYear: Array.from({ length: years }, (_, i) => opts.fromYear + i).map((year) => ({
      year,
      count: cell(byYear.get(year) ?? 0),
    })),
    byStage: STAGES.map((stage) => ({ stage, count: cell(byStage.get(stage) ?? 0) })),
    byMunicipality: [...byMunicipality]
      .map(([municipality, n]) => ({
        municipality,
        count: cell(n),
        population: opts.facilityId ? null : (population.get(municipality) ?? null),
        /** Crude annual rate per 100,000 registered people. */
        ratePer100k: rate(n, population.get(municipality)),
      }))
      .sort((a, b) => (b.count ?? 0) - (a.count ?? 0)),
    quality: {
      histologicallyVerifiedPct: pct(histology, total),
      microscopicallyVerifiedPct: pct(microscopic, total),
      deathCertificateOnlyPct: pct(dco, total),
    },
  };
}

export async function patientCases(patientId: string) {
  return db
    .select()
    .from(cancerCases)
    .where(eq(cancerCases.patientId, patientId))
    .orderBy(sql`${cancerCases.diagnosedOn} DESC`);
}

export async function casesByIds(ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(cancerCases).where(inArray(cancerCases.id, ids));
}
