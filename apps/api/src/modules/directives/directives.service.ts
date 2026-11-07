import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  advanceDirectives,
  edVisits,
  organDonationDecisions,
  patients,
  users,
} from '../../db/schema.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import { kosovoDate } from '../identity/identity.service.js';

/**
 * Organ donation registry and advance directives.
 *
 * Organ donation decisions are the person's own choice: only adults (18 or older) who are alive
 * record them, in the portal or in person with a member of staff (who is recorded). Every change is
 * a new row (append-only, trigger) and the latest row is the current decision. The decision is not
 * part of the routine chart: clinicians consult the register explicitly, for a stated purpose,
 * and every consultation is audited and visible to the person – the register is meant for
 * end-of-life care and transplant coordination, not for everyday treatment decisions. The
 * Ministry sees registry statistics only (small numbers suppressed), never individuals.
 *
 * Advance directives are shown prominently wherever the person is treated: DNACPR and treatment
 * escalation (ceiling of care) are clinical decisions taken by a doctor with the patient or those
 * close to them; an advance refusal records the patient's own documented refusal of a treatment;
 * a healthcare proxy is the person the patient wants consulted. Directives are never edited – they
 * are revoked with a reason and replaced (trigger).
 */

export const DONATION_DECISIONS = ['DONOR', 'DONOR_SOME', 'NOT_DONOR'] as const;
export type DonationDecision = (typeof DONATION_DECISIONS)[number];
export const ORGANS = [
  'KIDNEYS',
  'LIVER',
  'HEART',
  'LUNGS',
  'PANCREAS',
  'CORNEAS',
  'TISSUE',
] as const;
export const DIRECTIVE_KINDS = [
  'DNACPR',
  'TREATMENT_ESCALATION',
  'ADVANCE_REFUSAL',
  'HEALTHCARE_PROXY',
] as const;
export type DirectiveKind = (typeof DIRECTIVE_KINDS)[number];
/** Kinds of which only one may be active at a time (revoke the old one first). */
export const SINGLE_ACTIVE_KINDS: readonly DirectiveKind[] = [
  'DNACPR',
  'TREATMENT_ESCALATION',
  'HEALTHCARE_PROXY',
];
/** Kinds that limit treatment and are flagged on the chart and the emergency board. */
export const FLAG_KINDS: readonly DirectiveKind[] = ['DNACPR', 'TREATMENT_ESCALATION'];
/** Kinds the patient may withdraw themselves from the portal (their own choices). */
export const PATIENT_REVOCABLE_KINDS: readonly DirectiveKind[] = [
  'HEALTHCARE_PROXY',
  'ADVANCE_REFUSAL',
];
export const CHECK_PURPOSES = ['END_OF_LIFE_CARE', 'TRANSPLANT_COORDINATION'] as const;
export const ADULT_AGE = 18;

export const DonationInput = z
  .object({
    decision: z.enum(DONATION_DECISIONS),
    organs: z.array(z.enum(ORGANS)).max(ORGANS.length).optional().nullable(),
    familyInformed: z.boolean().optional().nullable(),
    faithOrBeliefNote: z.string().trim().max(300).optional().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === 'DONOR_SOME' && !v.organs?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['organs'],
        message: 'Choose the organs and tissues you want to donate',
      });
    }
  });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

export const DirectiveInput = z
  .object({
    kind: z.enum(DIRECTIVE_KINDS),
    summary: z.string().trim().min(5).max(2000),
    discussedWith: optionalText(300),
    proxyName: optionalText(200),
    proxyPhone: optionalText(40),
    documentId: z.string().uuid().optional().nullable(),
    reviewDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'HEALTHCARE_PROXY' && !v.proxyName) {
      ctx.addIssue({
        code: 'custom',
        path: ['proxyName'],
        message: 'Enter the name of the healthcare proxy',
      });
    }
    if ((v.kind === 'DNACPR' || v.kind === 'TREATMENT_ESCALATION') && !v.discussedWith) {
      ctx.addIssue({
        code: 'custom',
        path: ['discussedWith'],
        message: 'Record who the decision was discussed with (the patient, family or proxy)',
      });
    }
  });
export type DirectiveInputT = z.infer<typeof DirectiveInput>;

export function ageOn(dateOfBirth: string, day = kosovoDate(new Date())): number {
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = day.split('-').map(Number) as [number, number, number];
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

/** Why a person cannot register an organ donation decision (null when they can). */
export function donationIneligibility(p: {
  dateOfBirth: string;
  deceasedAt: Date | null;
}): 'MINOR' | 'DECEASED' | null {
  if (p.deceasedAt) return 'DECEASED';
  if (ageOn(p.dateOfBirth) < ADULT_AGE) return 'MINOR';
  return null;
}

const decisionColumns = {
  id: organDonationDecisions.id,
  decision: organDonationDecisions.decision,
  organs: organDonationDecisions.organs,
  familyInformed: organDonationDecisions.familyInformed,
  faithOrBeliefNote: organDonationDecisions.faithOrBeliefNote,
  recordedVia: organDonationDecisions.recordedVia,
  createdAt: organDonationDecisions.createdAt,
  recordedByName: users.fullName,
  recordedByRole: users.role,
};

/** All decisions of a person, newest first (the first is the current one). */
export async function donationHistory(patientId: string, executor: Executor = db) {
  return executor
    .select(decisionColumns)
    .from(organDonationDecisions)
    .innerJoin(users, eq(users.id, organDonationDecisions.recordedByUserId))
    .where(eq(organDonationDecisions.patientId, patientId))
    .orderBy(desc(organDonationDecisions.createdAt), desc(organDonationDecisions.id));
}

const directiveColumns = {
  id: advanceDirectives.id,
  kind: advanceDirectives.kind,
  status: advanceDirectives.status,
  summary: advanceDirectives.summary,
  discussedWith: advanceDirectives.discussedWith,
  proxyName: advanceDirectives.proxyName,
  proxyPhone: advanceDirectives.proxyPhone,
  documentId: advanceDirectives.documentId,
  reviewDate: advanceDirectives.reviewDate,
  facilityId: advanceDirectives.facilityId,
  createdAt: advanceDirectives.createdAt,
  createdById: advanceDirectives.createdById,
  createdByName: users.fullName,
  createdByRole: users.role,
  revokedAt: advanceDirectives.revokedAt,
  revokeReason: advanceDirectives.revokeReason,
};

/** Directives of a patient: active first, then revoked (newest first). */
export async function listDirectives(patientId: string, executor: Executor = db) {
  const rows = await executor
    .select(directiveColumns)
    .from(advanceDirectives)
    .innerJoin(users, eq(users.id, advanceDirectives.createdById))
    .where(eq(advanceDirectives.patientId, patientId))
    .orderBy(asc(advanceDirectives.status), desc(advanceDirectives.createdAt));
  const today = kosovoDate(new Date());
  return rows.map((r) => ({
    ...r,
    reviewDue: r.status === 'ACTIVE' && !!r.reviewDate && r.reviewDate <= today,
    /** Registered by the patient themselves in the portal (not by a clinician). */
    selfRegistered: r.createdByRole === 'PATIENT',
  }));
}
export type DirectiveRow = Awaited<ReturnType<typeof listDirectives>>[number];

/** Active treatment-limiting directives (DNACPR, ceiling of care) for a set of patients. */
export async function activeFlags(patientIds: string[], executor: Executor = db) {
  if (!patientIds.length) return new Map<string, FlagItem[]>();
  const rows = await executor
    .select({
      patientId: advanceDirectives.patientId,
      id: advanceDirectives.id,
      kind: advanceDirectives.kind,
      summary: advanceDirectives.summary,
      reviewDate: advanceDirectives.reviewDate,
      createdAt: advanceDirectives.createdAt,
    })
    .from(advanceDirectives)
    .where(
      and(
        inArray(advanceDirectives.patientId, patientIds),
        eq(advanceDirectives.status, 'ACTIVE'),
        inArray(advanceDirectives.kind, [...FLAG_KINDS]),
      ),
    )
    .orderBy(asc(advanceDirectives.kind));
  const today = kosovoDate(new Date());
  const out = new Map<string, FlagItem[]>();
  for (const r of rows) {
    const list = out.get(r.patientId) ?? [];
    list.push({
      id: r.id,
      kind: r.kind as DirectiveKind,
      summary: r.summary,
      reviewDate: r.reviewDate,
      reviewDue: !!r.reviewDate && r.reviewDate <= today,
    });
    out.set(r.patientId, list);
  }
  return out;
}
export interface FlagItem {
  id: string;
  kind: DirectiveKind;
  summary: string;
  reviewDate: string | null;
  reviewDue: boolean;
}

/** Patients currently in the emergency department of a unit (waiting or in treatment). */
export async function patientsInEd(unitId: string) {
  const rows = await db
    .select({ patientId: edVisits.patientId })
    .from(edVisits)
    .where(and(eq(edVisits.unitId, unitId), inArray(edVisits.status, ['WAITING', 'IN_TREATMENT'])));
  return [...new Set(rows.map((r) => r.patientId))];
}

/* ------------------------------------------------------------------ registry statistics -- */

const suppress = (n: number) => (n > 0 && n < SMALL_CELL_THRESHOLD ? null : n);
const AGE_BANDS: [string, number, number][] = [
  ['18–29', 18, 29],
  ['30–44', 30, 44],
  ['45–64', 45, 64],
  ['65+', 65, 200],
];

/**
 * National registry statistics: current decisions of living adults, by decision, municipality,
 * age band and sex, and decisions recorded per month. Counts of 1–4 are suppressed.
 */
export async function registryStats(today = kosovoDate(new Date())) {
  const current = await db.execute<{
    decision: string;
    municipality: string | null;
    sex: string;
    age: number;
  }>(sql`
    SELECT DISTINCT ON (d.patient_id) d.decision, p.municipality, p.sex::text AS sex,
      date_part('year', age(${today}::date, p.date_of_birth))::int AS age
    FROM organ_donation_decisions d
    JOIN patients p ON p.id = d.patient_id
    WHERE p.deceased_at IS NULL AND p.merged_into_id IS NULL
    ORDER BY d.patient_id, d.created_at DESC, d.id DESC`);
  const adults = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM patients
    WHERE deceased_at IS NULL AND merged_into_id IS NULL
      AND date_of_birth <= (${today}::date - interval '18 years')`);
  const rows = current.rows;
  const isDonor = (d: string) => d === 'DONOR' || d === 'DONOR_SOME';
  const registered = rows.length;
  const donors = rows.filter((r) => isDonor(r.decision)).length;

  const group = (keyOf: (r: (typeof rows)[number]) => string) => {
    const map = new Map<string, { registered: number; donors: number }>();
    for (const r of rows) {
      const k = keyOf(r);
      const g = map.get(k) ?? { registered: 0, donors: 0 };
      g.registered++;
      if (isDonor(r.decision)) g.donors++;
      map.set(k, g);
    }
    return [...map.entries()]
      .map(([key, g]) => {
        const hidden = g.registered < SMALL_CELL_THRESHOLD;
        return {
          key,
          registered: suppress(g.registered),
          donors: hidden ? null : suppress(g.donors),
          donorPct: hidden ? null : Math.round((g.donors / g.registered) * 1000) / 10,
          suppressed: hidden,
        };
      })
      .sort((a, b) => (b.registered ?? 0) - (a.registered ?? 0) || a.key.localeCompare(b.key));
  };

  const months = await db.execute<{ month: string; decision: string; n: number }>(sql`
    SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'Europe/Belgrade'), 'YYYY-MM-01') AS month,
      decision, count(*)::int AS n
    FROM organ_donation_decisions
    WHERE created_at >= (${today}::date - interval '12 months')
    GROUP BY 1, 2 ORDER BY 1`);
  const monthMap = new Map<string, Record<string, number | null>>();
  for (const m of months.rows) {
    const e = monthMap.get(m.month) ?? { DONOR: 0, DONOR_SOME: 0, NOT_DONOR: 0 };
    e[m.decision] = m.n;
    monthMap.set(m.month, e);
  }

  return {
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    adultPopulation: adults.rows[0]?.n ?? 0,
    registered: suppress(registered),
    donors: suppress(donors),
    byDecision: DONATION_DECISIONS.map((d) => ({
      decision: d,
      count: suppress(rows.filter((r) => r.decision === d).length),
    })),
    donorPctOfRegistered: registered ? Math.round((donors / registered) * 1000) / 10 : null,
    registeredPctOfAdults: adults.rows[0]?.n
      ? Math.round((registered / adults.rows[0].n) * 1000) / 10
      : null,
    byMunicipality: group((r) => r.municipality ?? '—'),
    byAgeBand: AGE_BANDS.map(([label, lo, hi]) => {
      const inBand = rows.filter((r) => r.age >= lo && r.age <= hi);
      const hidden = inBand.length < SMALL_CELL_THRESHOLD;
      const d = inBand.filter((r) => isDonor(r.decision)).length;
      return {
        key: label,
        registered: suppress(inBand.length),
        donors: hidden ? null : suppress(d),
        donorPct: hidden || !inBand.length ? null : Math.round((d / inBand.length) * 1000) / 10,
        suppressed: hidden,
      };
    }),
    bySex: group((r) => r.sex),
    byMonth: [...monthMap.entries()].map(([month, counts]) => ({
      month,
      DONOR: suppress(counts.DONOR ?? 0),
      DONOR_SOME: suppress(counts.DONOR_SOME ?? 0),
      NOT_DONOR: suppress(counts.NOT_DONOR ?? 0),
    })),
  };
}

/** Patient basics needed for the rules (age, deceased, merged). */
export async function patientBasics(patientId: string, executor: Executor = db) {
  const [p] = await executor
    .select({
      id: patients.id,
      dateOfBirth: patients.dateOfBirth,
      deceasedAt: patients.deceasedAt,
      mergedIntoId: patients.mergedIntoId,
      primaryFacilityId: patients.primaryFacilityId,
    })
    .from(patients)
    .where(eq(patients.id, patientId));
  return p ?? null;
}

/** Is there already an active directive of this kind? */
export async function activeOfKind(patientId: string, kind: DirectiveKind, executor: Executor) {
  const [row] = await executor
    .select({ id: advanceDirectives.id })
    .from(advanceDirectives)
    .where(
      and(
        eq(advanceDirectives.patientId, patientId),
        eq(advanceDirectives.kind, kind),
        eq(advanceDirectives.status, 'ACTIVE'),
        isNull(advanceDirectives.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
