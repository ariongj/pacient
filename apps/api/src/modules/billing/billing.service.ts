import { sql, type SQL } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { ensureTariff } from './tariff.js';

/**
 * Billing rules (demo – to be aligned with the Health Insurance Fund before real use):
 *  - A patient is insured on a service date when an ACTIVE coverage with an insurer other than
 *    NONE is valid on that date. FSSH charges go into monthly claims to the Fund.
 *  - Co-payment = the service's co-payment × quantity, capped at the total, unless the patient is
 *    exempt: a coverage exemption (CHILD, PENSIONER, CHRONIC, SOCIAL_ASSISTANCE, DISABILITY,
 *    VETERAN), automatically under 18 or 65 and over, or the care itself is exempt (life-threatening
 *    emergencies – triage levels 1–2 – and emergency operations).
 *  - Uninsured patients pay the full price; the insurer part is 0.
 */
export const INSURERS = ['FSSH', 'PRIVATE', 'NONE'] as const;
export const EXEMPTIONS = [
  'CHILD',
  'PENSIONER',
  'CHRONIC',
  'SOCIAL_ASSISTANCE',
  'DISABILITY',
  'VETERAN',
] as const;
export const COVERAGE_STATUSES = ['ACTIVE', 'SUSPENDED', 'ENDED'] as const;

const kosovoDate = (col: SQL) => sql`(${col} AT TIME ZONE 'Europe/Belgrade')::date`;

/** The coverage that applies to a patient on a date (latest valid active one), or null. */
export async function coverageOn(patientId: string, date: string, executor: Executor = db) {
  const result = await executor.execute<{
    id: string;
    insurer: string;
    exemption: string | null;
    policy_number: string | null;
  }>(sql`
    SELECT id, insurer, exemption, policy_number FROM insurance_coverages
    WHERE patient_id = ${patientId} AND status = 'ACTIVE' AND valid_from <= ${date}::date
      AND (valid_until IS NULL OR valid_until >= ${date}::date)
    ORDER BY created_at DESC LIMIT 1`);
  return result.rows[0] ?? null;
}

/** Age-based automatic exemption for a date of birth on a service date. */
export function automaticExemption(dateOfBirth: string, on: Date = new Date()): string | null {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const m = on.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < dob.getUTCDate())) age--;
  if (age < 18) return 'CHILD';
  if (age >= 65) return 'PENSIONER';
  return null;
}

interface SourceSpec {
  type: string;
  /** SELECT producing: patient_id, facility_id, code, fallback, source_id, quantity, service_date, copay_exempt */
  select: (filter: { facilityId?: string; since?: Date }) => SQL;
}

const facilityAnd = (col: string, facilityId?: string) =>
  facilityId ? sql`AND ${sql.raw(col)} = ${facilityId}` : sql``;
const sinceAnd = (col: string, since?: Date) =>
  since ? sql`AND ${sql.raw(col)} >= ${since.toISOString()}` : sql``;

/**
 * Where charges come from. Each source is idempotent through the unique index on
 * (source_type, source_id, service_id): re-running the capture never creates a second charge.
 * Bed days are charged once per stay at discharge (quantity = nights, at least 1), so a stay is
 * never charged twice and no charge has to be changed later.
 */
const SOURCES: SourceSpec[] = [
  {
    type: 'ENCOUNTER',
    select: ({ facilityId, since }) => sql`
      SELECT e.patient_id, e.facility_id,
        CASE WHEN e.type = 'TELEHEALTH' THEN 'CONS-TELE'
             WHEN d.specialty ILIKE '%famil%' THEN 'CONS-FM' ELSE 'CONS-SP' END AS code,
        'CONS-SP' AS fallback, e.id AS source_id, 1 AS quantity,
        ${kosovoDate(sql`e.started_at`)} AS service_date, false AS copay_exempt
      FROM encounters e JOIN users d ON d.id = e.doctor_id
      WHERE e.note_status = 'SIGNED' AND e.type <> 'INPATIENT' AND e.type <> 'EMERGENCY'
        ${facilityAnd('e.facility_id', facilityId)} ${sinceAnd('e.started_at', since)}`,
  },
  {
    type: 'ED_VISIT',
    select: ({ facilityId, since }) => sql`
      SELECT v.patient_id, v.facility_id, 'ED-L' || v.triage_level AS code, 'ED-L3' AS fallback,
        v.id AS source_id, 1 AS quantity, ${kosovoDate(sql`v.departed_at`)} AS service_date,
        v.triage_level <= 2 AS copay_exempt
      FROM ed_visits v
      WHERE v.status IN ('DISCHARGED', 'TRANSFERRED', 'ADMITTED') AND v.triage_level IS NOT NULL
        AND v.departed_at IS NOT NULL
        ${facilityAnd('v.facility_id', facilityId)} ${sinceAnd('v.departed_at', since)}`,
  },
  {
    type: 'LAB_ORDER',
    select: ({ facilityId, since }) => sql`
      SELECT o.patient_id, o.facility_id, 'LAB-' || o.test_code AS code, 'LAB-OTHER' AS fallback,
        o.id AS source_id, 1 AS quantity,
        ${kosovoDate(sql`coalesce(o.resulted_at, o.created_at)`)} AS service_date, false AS copay_exempt
      FROM lab_orders o
      WHERE o.status = 'RESULTED'
        ${facilityAnd('o.facility_id', facilityId)} ${sinceAnd('coalesce(o.resulted_at, o.created_at)', since)}`,
  },
  {
    type: 'IMAGING',
    select: ({ facilityId, since }) => sql`
      SELECT i.patient_id, i.facility_id, 'IMG-' || i.modality AS code, 'IMG-XRAY' AS fallback,
        i.id AS source_id, 1 AS quantity, ${kosovoDate(sql`i.reported_at`)} AS service_date,
        false AS copay_exempt
      FROM imaging_orders i
      WHERE i.status = 'REPORTED' AND i.reported_at IS NOT NULL
        ${facilityAnd('i.facility_id', facilityId)} ${sinceAnd('i.reported_at', since)}`,
  },
  {
    type: 'BED_DAY',
    select: ({ facilityId, since }) => sql`
      SELECT a.patient_id, a.facility_id,
        CASE WHEN u.type = 'ICU' THEN 'BED-ICU' ELSE 'BED-GENERAL' END AS code,
        'BED-GENERAL' AS fallback, a.id AS source_id,
        greatest(1, ${kosovoDate(sql`a.discharged_at`)} - ${kosovoDate(sql`a.admitted_at`)}) AS quantity,
        ${kosovoDate(sql`a.discharged_at`)} AS service_date, false AS copay_exempt
      FROM admissions a JOIN care_units u ON u.id = a.unit_id
      WHERE a.status = 'DISCHARGED' AND a.discharged_at IS NOT NULL AND a.source <> 'BIRTH'
        ${facilityAnd('a.facility_id', facilityId)} ${sinceAnd('a.discharged_at', since)}`,
  },
  {
    type: 'SURGERY',
    select: ({ facilityId, since }) => sql`
      SELECT c.patient_id, c.facility_id,
        CASE WHEN c.estimated_minutes < 60 THEN 'SURG-MINOR'
             WHEN c.estimated_minutes <= 120 THEN 'SURG-MEDIUM' ELSE 'SURG-MAJOR' END AS code,
        'SURG-MEDIUM' AS fallback, c.id AS source_id, 1 AS quantity,
        ${kosovoDate(sql`coalesce(c.out_of_theatre_at, c.note_signed_at, c.created_at)`)} AS service_date,
        c.priority = 'EMERGENCY' AS copay_exempt
      FROM surgical_cases c
      WHERE c.status = 'COMPLETED'
        ${facilityAnd('c.facility_id', facilityId)} ${sinceAnd('coalesce(c.out_of_theatre_at, c.created_at)', since)}`,
  },
  {
    type: 'DISPENSE',
    select: ({ facilityId, since }) => sql`
      SELECT r.patient_id, ph.facility_id, 'DISP-FEE' AS code, 'DISP-FEE' AS fallback,
        r.id AS source_id, 1 AS quantity, ${kosovoDate(sql`r.dispensed_at`)} AS service_date,
        false AS copay_exempt
      FROM prescriptions r JOIN users ph ON ph.id = r.dispensed_by_id
      WHERE r.pharmacy_status = 'DISPENSED' AND r.dispensed_at IS NOT NULL AND ph.facility_id IS NOT NULL
        ${facilityAnd('ph.facility_id', facilityId)} ${sinceAnd('r.dispensed_at', since)}`,
  },
];

export const SOURCE_TYPES = [...SOURCES.map((s) => s.type), 'MANUAL'] as const;

/** SQL computing the co-payment for a charge candidate `s` with service `b` and patient `p`. */
const copaySql = sql`
  CASE
    WHEN cov.id IS NULL OR cov.insurer = 'NONE' THEN b.price_cents * s.quantity
    WHEN s.copay_exempt OR cov.exemption IS NOT NULL
      OR date_part('year', age(s.service_date, p.date_of_birth)) < 18
      OR date_part('year', age(s.service_date, p.date_of_birth)) >= 65 THEN 0
    ELSE least(b.copay_cents * s.quantity, b.price_cents * s.quantity)
  END`;

/**
 * Creates the charges produced by care since `since` (all history when omitted), optionally for
 * one facility. Safe to run any number of times and on several API instances at once.
 * Returns the number of new charges per source type.
 */
export async function captureCharges(
  facilityId?: string,
  since?: Date,
  executor: Executor = db,
): Promise<Record<string, number>> {
  await ensureTariff(executor);
  const created: Record<string, number> = {};
  for (const source of SOURCES) {
    const result = await executor.execute<{ id: string }>(sql`
      INSERT INTO charges (patient_id, facility_id, service_id, source_type, source_id, quantity,
        total_cents, copay_cents, insurer_cents, service_date)
      SELECT s.patient_id, s.facility_id, b.id, ${source.type}, s.source_id, s.quantity,
        b.price_cents * s.quantity, ${copaySql}, b.price_cents * s.quantity - (${copaySql}),
        s.service_date
      FROM (${source.select({ facilityId, since })}) s
      JOIN patients p ON p.id = s.patient_id
      JOIN billable_services b ON b.code = coalesce(
        (SELECT x.code FROM billable_services x WHERE x.code = s.code AND x.is_active), s.fallback)
      LEFT JOIN LATERAL (
        SELECT c.id, c.insurer, c.exemption FROM insurance_coverages c
        WHERE c.patient_id = s.patient_id AND c.status = 'ACTIVE' AND c.valid_from <= s.service_date
          AND (c.valid_until IS NULL OR c.valid_until >= s.service_date)
        ORDER BY c.created_at DESC LIMIT 1
      ) cov ON TRUE
      WHERE p.merged_into_id IS NULL
      ON CONFLICT (source_type, source_id, service_id)
        WHERE source_id IS NOT NULL AND status <> 'VOID'
      DO NOTHING
      RETURNING id`);
    created[source.type] = result.rows.length;
  }
  return created;
}

/** Charge figures for a manual charge of `quantity` × service for a patient on a date. */
export async function priceFor(
  patientId: string,
  service: { priceCents: number; copayCents: number },
  quantity: number,
  serviceDate: string,
  dateOfBirth: string,
  executor: Executor = db,
) {
  const total = service.priceCents * quantity;
  const cov = await coverageOn(patientId, serviceDate, executor);
  if (!cov || cov.insurer === 'NONE') return { total, copay: total, insurer: 0 };
  const exempt =
    Boolean(cov.exemption) || automaticExemption(dateOfBirth, new Date(`${serviceDate}T12:00:00Z`));
  const copay = exempt ? 0 : Math.min(service.copayCents * quantity, total);
  return { total, copay, insurer: total - copay };
}

/** Next receipt number for a facility: <FACILITY CODE>-<YEAR>-<000001>, gap-free per year. */
export async function nextReceiptNumber(executor: Executor, facilityId: string, now = new Date()) {
  const year = now.getUTCFullYear();
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`receipt:${facilityId}:${year}`}))`);
  const result = await executor.execute<{ code: string; n: number }>(sql`
    SELECT f.code, (SELECT count(*)::int FROM payments p
      WHERE p.facility_id = f.id AND date_part('year', p.received_at) = ${year}) AS n
    FROM facilities f WHERE f.id = ${facilityId}`);
  const row = result.rows[0]!;
  return `${row.code}-${year}-${String(row.n + 1).padStart(6, '0')}`;
}

/* --------------------------------------------------------------------------- worker */

let timer: ReturnType<typeof setInterval> | null = null;

/** Captures charges every hour for the last 120 days of care (idempotent). */
export function startChargeCaptureWorker() {
  if (isTest || timer) return;
  const run = () =>
    captureCharges(undefined, new Date(Date.now() - 120 * 86_400_000))
      .then((r) => {
        const n = Object.values(r).reduce((a, b) => a + b, 0);
        if (n) logger.info({ created: r }, 'Charges captured');
      })
      .catch((err: unknown) => logger.error({ err }, 'Charge capture failed'));
  setTimeout(run, 30_000).unref();
  timer = setInterval(run, 3_600_000);
  timer.unref();
}

export function stopChargeCaptureWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
