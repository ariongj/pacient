import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  antimicrobialApprovals,
  careUnits,
  medicationCatalog,
  notifications,
  unitStaff,
  users,
} from '../../db/schema.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import {
  CULTURE_TEST,
  matchRestrictedAgent,
  NEGATIVE_VALUE,
  REVIEW_AFTER_HOURS,
  type RestrictedAgent,
} from './definitions.js';

/* ------------------------------------------------------------------ the stewardship team -- */

/** Is the user a member of an infection control unit at this facility? */
export async function isInfectionControl(
  userId: string,
  facilityId: string | null,
  executor: Executor = db,
): Promise<boolean> {
  if (!facilityId) return false;
  const [row] = await executor
    .select({ id: unitStaff.id })
    .from(unitStaff)
    .innerJoin(careUnits, eq(careUnits.id, unitStaff.unitId))
    .where(
      and(
        eq(unitStaff.userId, userId),
        eq(careUnits.facilityId, facilityId),
        eq(careUnits.isActive, true),
        sql`${careUnits.type}::text = 'INFECTION_CONTROL'`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Infection control unit members of a facility (active accounts). */
export async function infectionControlStaff(facilityId: string, executor: Executor = db) {
  const rows = await executor
    .selectDistinct({ id: users.id })
    .from(unitStaff)
    .innerJoin(careUnits, eq(careUnits.id, unitStaff.unitId))
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        eq(careUnits.isActive, true),
        sql`${careUnits.type}::text = 'INFECTION_CONTROL'`,
        eq(users.isActive, true),
      ),
    );
  return rows.map((r) => r.id);
}

/** Who decides restricted-antibiotic requests: infection control staff and the hospital pharmacists. */
export async function stewardshipTeam(facilityId: string, executor: Executor = db) {
  const pharmacists = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'PHARMACIST'), eq(users.isActive, true)),
    );
  return [
    ...new Set([
      ...(await infectionControlStaff(facilityId, executor)),
      ...pharmacists.map((p) => p.id),
    ]),
  ];
}

export async function isStewardshipTeam(ctx: AuthContext): Promise<boolean> {
  if (!ctx.facilityId) return false;
  if (ctx.role === 'PHARMACIST') return true;
  return (
    (ctx.role === 'DOCTOR' || ctx.role === 'NURSE') &&
    isInfectionControl(ctx.userId, ctx.facilityId)
  );
}

/* ------------------------------------------------------------- restricted antibiotics -- */

/** The extra block the prescriber completes for a restricted antibiotic. */
export const AntimicrobialRequestSchema = z.object({
  indication: z.string().trim().min(3, 'Give the indication').max(300),
  justification: z
    .string()
    .trim()
    .min(10, 'Give the culture result or why empirical treatment is needed')
    .max(2000),
});
export type AntimicrobialRequest = z.infer<typeof AntimicrobialRequestSchema>;

/** The restricted agent a prescription is for (by catalogue ATC code and ingredients, or by name). */
export async function restrictedAgentFor(input: {
  medication: string;
  catalogItemId?: string | null;
  route?: string | null;
}): Promise<RestrictedAgent | null> {
  let atcCode: string | null = null;
  let ingredients: string[] | null = null;
  if (input.catalogItemId) {
    const [item] = await db
      .select({ atcCode: medicationCatalog.atcCode, ingredients: medicationCatalog.ingredients })
      .from(medicationCatalog)
      .where(eq(medicationCatalog.id, input.catalogItemId));
    atcCode = item?.atcCode ?? null;
    ingredients = item?.ingredients ?? null;
  }
  return matchRestrictedAgent({
    medication: input.medication,
    route: input.route,
    atcCode,
    ingredients,
  });
}

/**
 * Records the approval request for a restricted antibiotic in the prescribing transaction. The
 * prescription is already saved: treatment is never delayed by the approval.
 */
export async function requestApproval(
  tx: Executor,
  opts: {
    ctx: AuthContext;
    meta?: RequestMeta;
    prescriptionId: string;
    patientId: string;
    agent: RestrictedAgent;
    request: AntimicrobialRequest;
    now?: Date;
  },
) {
  const now = opts.now ?? new Date();
  const facilityId = opts.ctx.facilityId!;
  const [row] = await tx
    .insert(antimicrobialApprovals)
    .values({
      prescriptionId: opts.prescriptionId,
      patientId: opts.patientId,
      facilityId,
      indication: opts.request.indication,
      justification: opts.request.justification,
      requestedById: opts.ctx.userId,
      reviewDueAt: new Date(now.getTime() + REVIEW_AFTER_HOURS * 3_600_000),
      createdAt: now,
    })
    .returning();
  await audit(
    {
      action: AuditAction.ANTIMICROBIAL_REQUESTED,
      actor: opts.ctx,
      resourceType: 'antimicrobial_approval',
      resourceId: row!.id,
      patientId: opts.patientId,
      meta: opts.meta,
      metadata: { agent: opts.agent.code, prescriptionId: opts.prescriptionId },
    },
    tx,
  );
  const team = (await stewardshipTeam(facilityId, tx)).filter((id) => id !== opts.ctx.userId);
  await notifyUsers(
    team,
    {
      type: 'stewardship',
      title: 'A restricted antibiotic needs approval',
      link: `/infection?tab=stewardship&request=${row!.id}`,
    },
    tx,
  );
  return row!;
}

/* ---------------------------------------------------------------------- surveillance -- */

export interface RateRow {
  key: string;
  label: string;
  month: string;
  patientDays: number;
  confirmed: number;
  suspected: number;
  deviceRelated: number;
}

/**
 * Patient-days and HAI counts per month, grouped by ward (one facility) or by facility (national).
 * Patient-days are counted for the admission's current ward (transfers are not split).
 */
export async function haiRates(opts: {
  facilityId: string | null;
  from: Date;
  to?: Date;
  groupBy: 'unit' | 'facility';
}): Promise<RateRow[]> {
  const to = opts.to ?? new Date();
  const key = opts.groupBy === 'unit' ? sql.raw('a.unit_id') : sql.raw('a.facility_id');
  const hkey = opts.groupBy === 'unit' ? sql.raw('h.unit_id') : sql.raw('h.facility_id');
  const facilityFilter = opts.facilityId ? sql`AND a.facility_id = ${opts.facilityId}` : sql``;
  const hFacilityFilter = opts.facilityId ? sql`AND h.facility_id = ${opts.facilityId}` : sql``;
  const result = await db.execute<{
    key: string;
    month: string;
    patient_days: string | null;
    confirmed: number;
    suspected: number;
    device_related: number;
  }>(sql`
    WITH months AS (
      SELECT generate_series(date_trunc('month', ${opts.from}::timestamptz),
                             date_trunc('month', ${to}::timestamptz), interval '1 month') AS m
    ),
    pd AS (
      SELECT ${key} AS key, m.m,
        sum(extract(epoch FROM least(coalesce(a.discharged_at, ${to}::timestamptz), m.m + interval '1 month', ${to}::timestamptz)
                              - greatest(a.admitted_at, m.m)) / 86400) AS days
      FROM admissions a JOIN months m
        ON a.admitted_at < m.m + interval '1 month' AND coalesce(a.discharged_at, ${to}::timestamptz) > m.m
      WHERE a.admitted_at < ${to}::timestamptz ${facilityFilter}
      GROUP BY 1, 2
    ),
    hai AS (
      SELECT ${hkey} AS key, date_trunc('month', h.onset_at) AS m,
        count(*) FILTER (WHERE h.status = 'CONFIRMED')::int AS confirmed,
        count(*) FILTER (WHERE h.status = 'SUSPECTED')::int AS suspected,
        count(*) FILTER (WHERE h.status = 'CONFIRMED' AND h.device_related)::int AS device_related
      FROM hai_events h
      WHERE h.onset_at >= date_trunc('month', ${opts.from}::timestamptz) AND h.onset_at < ${to}::timestamptz
        ${hFacilityFilter}
      GROUP BY 1, 2
    )
    SELECT coalesce(pd.key, hai.key)::text AS key, to_char(coalesce(pd.m, hai.m), 'YYYY-MM') AS month,
      pd.days::text AS patient_days, coalesce(hai.confirmed, 0) AS confirmed,
      coalesce(hai.suspected, 0) AS suspected, coalesce(hai.device_related, 0) AS device_related
    FROM pd FULL JOIN hai ON hai.key = pd.key AND hai.m = pd.m
    WHERE coalesce(pd.key, hai.key) IS NOT NULL
    ORDER BY 2, 1`);
  const keys = [...new Set(result.rows.map((r) => r.key))];
  const labels = new Map<string, string>();
  if (keys.length) {
    const table = opts.groupBy === 'unit' ? sql`care_units` : sql`facilities`;
    const names = await db.execute<{ id: string; name: string }>(
      sql`SELECT id::text, name FROM ${table} WHERE id::text IN ${sql`(${sql.join(
        keys.map((k) => sql`${k}`),
        sql`, `,
      )})`}`,
    );
    for (const n of names.rows) labels.set(n.id, n.name);
  }
  return result.rows.map((r) => ({
    key: r.key,
    label: labels.get(r.key) ?? '—',
    month: r.month,
    patientDays: Math.round(Number(r.patient_days ?? 0)),
    confirmed: r.confirmed,
    suspected: r.suspected,
    deviceRelated: r.device_related,
  }));
}

/** Infections per 1,000 patient-days (one decimal), null without patient-days. */
export const per1000 = (count: number, patientDays: number) =>
  patientDays > 0 ? Math.round((count / patientDays) * 10_000) / 10 : null;

/* ----------------------------------------------------------------- possible HAI flags -- */

export interface Suggestion {
  labResultId: string;
  patientId: string;
  firstName: string;
  lastName: string;
  testName: string;
  value: string;
  collectedAt: Date;
  admissionId: string;
  admittedAt: Date;
  unitId: string;
  unitName: string;
  hoursAfterAdmission: number;
}

/** Positive cultures taken > 48 h after admission with no HAI recorded nearby (see definitions). */
export async function possibleHai(facilityId: string, now = new Date()): Promise<Suggestion[]> {
  const result = await db.execute<{
    lab_result_id: string;
    patient_id: string;
    first_name: string;
    last_name: string;
    test_name: string;
    value: string;
    collected_at: Date;
    admission_id: string;
    admitted_at: Date;
    unit_id: string;
    unit_name: string;
  }>(sql`
    SELECT lr.id AS lab_result_id, lr.patient_id, p.first_name, p.last_name, lr.test_name, lr.value,
      lr.collected_at, a.id AS admission_id, a.admitted_at, a.unit_id, cu.name AS unit_name
    FROM lab_results lr
    JOIN admissions a ON a.patient_id = lr.patient_id AND a.facility_id = ${facilityId}
      AND lr.collected_at > a.admitted_at + interval '48 hours'
      AND lr.collected_at <= coalesce(a.discharged_at, ${now}::timestamptz)
    JOIN patients p ON p.id = lr.patient_id
    JOIN care_units cu ON cu.id = a.unit_id
    WHERE lr.collected_at > ${now}::timestamptz - interval '30 days'
      AND lr.superseded_by_id IS NULL
      AND lr.test_name ~* ${CULTURE_TEST}
      AND lr.value !~* ${NEGATIVE_VALUE}
      AND length(trim(lr.value)) > 0
      AND NOT EXISTS (
        SELECT 1 FROM hai_events h WHERE h.patient_id = lr.patient_id
          AND h.onset_at BETWEEN lr.collected_at - interval '7 days' AND lr.collected_at + interval '7 days')
    ORDER BY lr.collected_at DESC
    LIMIT 200`);
  return result.rows.map((r) => ({
    labResultId: r.lab_result_id,
    patientId: r.patient_id,
    firstName: r.first_name,
    lastName: r.last_name,
    testName: r.test_name,
    value: r.value,
    collectedAt: new Date(r.collected_at),
    admissionId: r.admission_id,
    admittedAt: new Date(r.admitted_at),
    unitId: r.unit_id,
    unitName: r.unit_name,
    hoursAfterAdmission: Math.floor(
      (new Date(r.collected_at).getTime() - new Date(r.admitted_at).getTime()) / 3_600_000,
    ),
  }));
}

/* ---------------------------------------------------------------------------- worker -- */

async function alreadyNotified(link: string) {
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.link, link))
    .limit(1);
  return Boolean(row);
}

/**
 * Hourly: tells infection control staff about possible HAIs (once per culture result) and the
 * prescriber about overdue 72-hour antibiotic reviews (once per request). No patient names or
 * results in the notifications.
 */
export async function runInfectionWorkerOnce(now = new Date()) {
  let suggestions = 0;
  let reviews = 0;
  const units = await db
    .selectDistinct({ facilityId: careUnits.facilityId })
    .from(careUnits)
    .where(and(eq(careUnits.isActive, true), sql`${careUnits.type}::text = 'INFECTION_CONTROL'`));
  for (const { facilityId } of units) {
    const staff = await infectionControlStaff(facilityId);
    if (!staff.length) continue;
    for (const s of await possibleHai(facilityId, now)) {
      const link = `/infection?tab=surveillance&suggestion=${s.labResultId}`;
      if (await alreadyNotified(link)) continue;
      await notifyUsers(staff, {
        type: 'infection',
        title: 'Possible healthcare-associated infection to review – {unit}',
        vars: { unit: s.unitName },
        link,
      });
      suggestions++;
    }
  }
  const overdue = await db.execute<{ id: string; patient_id: string; requested_by_id: string }>(sql`
    SELECT aa.id, aa.patient_id, aa.requested_by_id FROM antimicrobial_approvals aa
    JOIN prescriptions rx ON rx.id = aa.prescription_id AND rx.status = 'ACTIVE'
    WHERE aa.status <> 'DECLINED' AND aa.reviewed_at IS NULL AND aa.review_due_at < ${now}::timestamptz`);
  for (const o of overdue.rows) {
    const link = `/doctor/patients/${o.patient_id}?tab=infection&review=${o.id}`;
    if (await alreadyNotified(link)) continue;
    await notifyUsers([o.requested_by_id], {
      type: 'stewardship',
      title: 'Antibiotic review overdue (72 hours)',
      link,
    });
    reviews++;
  }
  return { suggestions, reviews };
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

function runSafely() {
  runInfectionWorkerOnce().then(
    (r) => (r.suggestions || r.reviews) && logger.info(r, 'Infection prevention reminders sent'),
    (err: unknown) => logger.error({ err }, 'Infection prevention worker failed'),
  );
}

/** Hourly (first run four minutes after start). Not started in tests. */
export function startInfectionWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 4 * 60_000);
  first.unref();
  timer = setInterval(runSafely, 60 * 60_000);
  timer.unref();
}

export function stopInfectionWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}
