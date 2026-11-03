import { Router, type Request } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { badRequest } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';

/**
 * Purpose-specific aggregate reports (blueprint §7). Directors are restricted to their own
 * facility; the Ministry may filter by region or facility. All counts below the small-cell
 * threshold are suppressed, in the API response and in exports alike, and every export is audited.
 */
const Query = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    region: z.string().trim().max(100).optional(),
    facilityId: z.string().uuid().optional(),
  })
  .transform((q) => {
    const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : new Date();
    const from = q.from
      ? new Date(`${q.from}T00:00:00Z`)
      : new Date(to.getTime() - 90 * 86_400_000);
    return { ...q, from, to };
  })
  .refine((q) => q.from <= q.to, 'from must be before to')
  .refine(
    (q) => q.to.getTime() - q.from.getTime() <= 2 * 366 * 86_400_000,
    'Period may not exceed two years',
  );

type ReportQuery = z.infer<typeof Query>;
export const REPORT_NAMES = [
  'activity',
  'diagnoses',
  'medications',
  'pharmacy',
  'vaccinations',
  'referrals',
  'appointments',
  'workforce',
  'occupancy',
  'admissions',
  'emergency',
  'births',
  'imaging',
  'theatre',
] as const;
const ReportName = z.object({ report: z.enum(REPORT_NAMES) });

function scopeFor(ctx: AuthContext, q: ReportQuery) {
  if (ctx.role === 'DIRECTOR') return { facilityId: ctx.facilityId!, region: undefined };
  return { facilityId: q.facilityId, region: q.region };
}

function facilityFilter(alias: string, scope: { facilityId?: string; region?: string }): SQL {
  const parts: SQL[] = [sql`TRUE`];
  if (scope.facilityId) parts.push(sql`${sql.raw(alias)}.id = ${scope.facilityId}`);
  if (scope.region) parts.push(sql`${sql.raw(alias)}.region = ${scope.region}`);
  return sql.join(parts, sql` AND `);
}

const suppress = (n: number) => (n < SMALL_CELL_THRESHOLD ? null : n);

async function diagnosesReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const result = await db.execute<{
    region: string;
    icd10Code: string;
    description: string;
    patients: number;
  }>(sql`
    SELECT f.region, d.icd10_code AS "icd10Code", min(d.description) AS description,
      count(DISTINCT d.patient_id)::int AS patients
    FROM diagnoses d
    JOIN users u ON u.id = d.doctor_id
    JOIN facilities f ON f.id = u.facility_id
    WHERE d.diagnosed_at BETWEEN ${q.from.toISOString()} AND ${q.to.toISOString()}
      AND ${facilityFilter('f', scope)}
    GROUP BY f.region, d.icd10_code
    ORDER BY patients DESC, f.region, d.icd10_code
    LIMIT 500`);
  const rows = result.rows.map((r) => ({
    region: r.region,
    icd10Code: r.icd10Code,
    description: r.description,
    patients: suppress(r.patients),
    suppressed: r.patients < SMALL_CELL_THRESHOLD,
  }));
  return {
    columns: ['region', 'icd10Code', 'description', 'patients'],
    rows,
  };
}

async function activityReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const from = q.from.toISOString();
  const to = q.to.toISOString();
  const result = await db.execute<Record<string, string | number>>(sql`
    SELECT f.code, f.name, f.region,
      (SELECT count(*)::int FROM encounters e WHERE e.facility_id = f.id AND e.started_at BETWEEN ${from} AND ${to}) AS encounters,
      (SELECT count(DISTINCT e.patient_id)::int FROM encounters e WHERE e.facility_id = f.id AND e.started_at BETWEEN ${from} AND ${to}) AS "uniquePatients",
      (SELECT count(*)::int FROM appointments a WHERE a.facility_id = f.id AND a.status = 'COMPLETED' AND a.scheduled_at BETWEEN ${from} AND ${to}) AS "appointmentsCompleted",
      (SELECT count(*)::int FROM appointments a WHERE a.facility_id = f.id AND a.status = 'NO_SHOW' AND a.scheduled_at BETWEEN ${from} AND ${to}) AS "noShows",
      (SELECT count(*)::int FROM referrals r WHERE r.from_facility_id = f.id AND r.created_at BETWEEN ${from} AND ${to}) AS "referralsSent",
      (SELECT count(*)::int FROM referrals r WHERE r.to_facility_id = f.id AND r.created_at BETWEEN ${from} AND ${to}) AS "referralsReceived",
      (SELECT count(*)::int FROM immunizations i WHERE i.facility_id = f.id AND i.administered_at BETWEEN ${from} AND ${to}) AS vaccinations,
      (SELECT count(*)::int FROM emergency_access_grants g JOIN users u ON u.id = g.doctor_id
         WHERE u.facility_id = f.id AND g.created_at BETWEEN ${from} AND ${to}) AS "emergencyAccess"
    FROM facilities f
    WHERE ${facilityFilter('f', scope)}
    ORDER BY f.region, f.name`);
  return {
    columns: [
      'code',
      'name',
      'region',
      'encounters',
      'uniquePatients',
      'appointmentsCompleted',
      'noShows',
      'referralsSent',
      'referralsReceived',
      'vaccinations',
      'emergencyAccess',
    ],
    // Operational counts per facility are not about individuals, but patient counts still follow
    // the suppression rule.
    rows: result.rows.map((r) => ({ ...r, uniquePatients: suppress(Number(r.uniquePatients)) })),
  };
}

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);
const pct = (part: unknown, whole: unknown) =>
  num(whole) ? Math.round((num(part) / num(whole)) * 1000) / 10 : null;
const hours = (v: unknown) =>
  v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;

/** Most prescribed medicines by region (active ingredient = first word of the product name). */
async function medicationsReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const result = await db.execute<Row>(sql`
    SELECT f.region, initcap(split_part(lower(p.medication), ' ', 1)) AS medication,
      count(*)::int AS prescriptions, count(DISTINCT p.patient_id)::int AS patients
    FROM prescriptions p
    JOIN users u ON u.id = p.doctor_id
    JOIN facilities f ON f.id = u.facility_id
    WHERE p.created_at BETWEEN ${q.from.toISOString()} AND ${q.to.toISOString()}
      AND ${facilityFilter('f', scope)}
    GROUP BY 1, 2 ORDER BY prescriptions DESC, 1, 2 LIMIT 500`);
  return {
    columns: ['region', 'medication', 'prescriptions', 'patients'],
    rows: result.rows.map((r) => ({
      ...r,
      patients: suppress(num(r.patients)),
      suppressed: num(r.patients) < SMALL_CELL_THRESHOLD,
    })),
  };
}

/** Pharmacy performance: volumes, returns and turnaround per facility. */
async function pharmacyReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const result = await db.execute<Row>(sql`
    SELECT f.code, f.name, f.region,
      count(p.id)::int AS prescriptions,
      count(p.id) FILTER (WHERE p.pharmacy_status = 'PENDING')::int AS "awaitingVerification",
      count(p.id) FILTER (WHERE p.pharmacy_status IN ('VERIFIED', 'DISPENSED'))::int AS verified,
      count(p.id) FILTER (WHERE p.pharmacy_status = 'RETURNED')::int AS returned,
      count(p.id) FILTER (WHERE p.pharmacy_status = 'DISPENSED')::int AS dispensed,
      avg(extract(epoch FROM (p.verified_at - p.created_at)) / 3600)
        FILTER (WHERE p.verified_at IS NOT NULL AND p.pharmacy_status <> 'RETURNED') AS "avgHoursToVerify",
      avg(extract(epoch FROM (p.dispensed_at - p.created_at)) / 3600)
        FILTER (WHERE p.dispensed_at IS NOT NULL AND p.verified_at IS NOT NULL) AS "avgHoursToDispense"
    FROM facilities f
    LEFT JOIN users u ON u.facility_id = f.id AND u.role = 'DOCTOR'
    LEFT JOIN prescriptions p ON p.doctor_id = u.id AND p.created_at BETWEEN ${q.from.toISOString()} AND ${q.to.toISOString()}
    WHERE ${facilityFilter('f', scope)}
    GROUP BY f.id ORDER BY f.region, f.name`);
  return {
    columns: [
      'code',
      'name',
      'region',
      'prescriptions',
      'awaitingVerification',
      'verified',
      'returned',
      'returnRatePct',
      'dispensed',
      'avgHoursToVerify',
      'avgHoursToDispense',
    ],
    rows: result.rows.map((r) => ({
      ...r,
      returnRatePct: pct(r.returned, r.prescriptions),
      avgHoursToVerify: hours(r.avgHoursToVerify),
      avgHoursToDispense: hours(r.avgHoursToDispense),
    })),
  };
}

/** Vaccination doses and people vaccinated, by vaccine and region. */
async function vaccinationsReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const result = await db.execute<Row>(sql`
    SELECT f.region, i.vaccine, count(*)::int AS doses, count(DISTINCT i.patient_id)::int AS people
    FROM immunizations i JOIN facilities f ON f.id = i.facility_id
    WHERE i.administered_at BETWEEN ${q.from.toISOString()} AND ${q.to.toISOString()}
      AND ${facilityFilter('f', scope)}
    GROUP BY 1, 2 ORDER BY doses DESC, 1, 2 LIMIT 500`);
  return {
    columns: ['region', 'vaccine', 'doses', 'people'],
    rows: result.rows.map((r) => ({
      ...r,
      people: suppress(num(r.people)),
      suppressed: num(r.people) < SMALL_CELL_THRESHOLD,
    })),
  };
}

/** Referral flow by receiving facility, including response time and acceptance rate. */
async function referralsReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const result = await db.execute<Row>(sql`
    SELECT f.code, f.name, f.region,
      count(r.id)::int AS received,
      count(r.id) FILTER (WHERE r.priority = 'URGENT')::int AS urgent,
      count(r.id) FILTER (WHERE r.status = 'PENDING')::int AS pending,
      count(r.id) FILTER (WHERE r.status IN ('ACCEPTED', 'COMPLETED'))::int AS accepted,
      count(r.id) FILTER (WHERE r.status = 'DECLINED')::int AS declined,
      count(r.id) FILTER (WHERE r.status = 'COMPLETED')::int AS completed,
      avg(extract(epoch FROM (r.responded_at - r.created_at)) / 3600)
        FILTER (WHERE r.responded_at IS NOT NULL AND r.status <> 'CANCELLED') AS "avgHoursToRespond",
      (SELECT count(*)::int FROM referrals s WHERE s.from_facility_id = f.id
        AND s.created_at BETWEEN ${q.from.toISOString()} AND ${q.to.toISOString()}) AS sent
    FROM facilities f
    LEFT JOIN referrals r ON r.to_facility_id = f.id AND r.created_at BETWEEN ${q.from.toISOString()} AND ${q.to.toISOString()}
    WHERE ${facilityFilter('f', scope)}
    GROUP BY f.id ORDER BY f.region, f.name`);
  return {
    columns: [
      'code',
      'name',
      'region',
      'sent',
      'received',
      'urgent',
      'pending',
      'accepted',
      'declined',
      'completed',
      'acceptanceRatePct',
      'avgHoursToRespond',
    ],
    rows: result.rows.map((r) => ({
      ...r,
      acceptanceRatePct: pct(r.accepted, num(r.accepted) + num(r.declined)),
      avgHoursToRespond: hours(r.avgHoursToRespond),
    })),
  };
}

/** Appointment outcomes and no-show rates per facility. */
async function appointmentsReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const result = await db.execute<Row>(sql`
    SELECT f.code, f.name, f.region,
      count(a.id)::int AS booked,
      count(a.id) FILTER (WHERE a.status = 'COMPLETED')::int AS completed,
      count(a.id) FILTER (WHERE a.status = 'NO_SHOW')::int AS "noShows",
      count(a.id) FILTER (WHERE a.status = 'CANCELLED')::int AS cancelled,
      count(a.id) FILTER (WHERE a.status IN ('REQUESTED', 'CONFIRMED', 'CHECKED_IN'))::int AS open,
      avg(extract(epoch FROM (a.scheduled_at - a.created_at)) / 86400)
        FILTER (WHERE a.scheduled_at > a.created_at) AS "avgLeadDays"
    FROM facilities f
    LEFT JOIN appointments a ON a.facility_id = f.id AND a.scheduled_at BETWEEN ${q.from.toISOString()} AND ${q.to.toISOString()}
    WHERE ${facilityFilter('f', scope)}
    GROUP BY f.id ORDER BY f.region, f.name`);
  return {
    columns: [
      'code',
      'name',
      'region',
      'booked',
      'completed',
      'noShows',
      'noShowRatePct',
      'cancelled',
      'open',
      'avgLeadDays',
    ],
    rows: result.rows.map((r) => ({
      ...r,
      noShowRatePct: pct(r.noShows, num(r.completed) + num(r.noShows)),
      avgLeadDays: hours(r.avgLeadDays),
    })),
  };
}

/** Workforce and security posture per facility (point in time; the period does not apply). */
async function workforceReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const result = await db.execute<Row>(sql`
    SELECT f.code, f.name, f.region,
      count(u.id) FILTER (WHERE u.role = 'DIRECTOR')::int AS directors,
      count(u.id) FILTER (WHERE u.role = 'DOCTOR')::int AS doctors,
      count(u.id) FILTER (WHERE u.role = 'NURSE')::int AS nurses,
      count(u.id) FILTER (WHERE u.role = 'PHARMACIST')::int AS pharmacists,
      count(u.id) FILTER (WHERE u.role = 'RECEPTION')::int AS reception,
      count(u.id)::int AS "activeStaff",
      count(u.id) FILTER (WHERE u.mfa_enabled_at IS NOT NULL)::int AS "withTwoStep",
      count(u.id) FILTER (WHERE u.password_changed_at IS NULL)::int AS "pendingInvitations",
      (SELECT count(*)::int FROM patients p WHERE p.primary_facility_id = f.id) AS patients,
      (SELECT count(*)::int FROM care_tasks t WHERE t.facility_id = f.id AND t.status = 'OPEN' AND t.due_at < now()) AS "overdueCareTasks"
    FROM facilities f
    LEFT JOIN users u ON u.facility_id = f.id AND u.is_active
    WHERE ${facilityFilter('f', scope)}
    GROUP BY f.id ORDER BY f.region, f.name`);
  return {
    columns: [
      'code',
      'name',
      'region',
      'directors',
      'doctors',
      'nurses',
      'pharmacists',
      'reception',
      'activeStaff',
      'twoStepPct',
      'pendingInvitations',
      'patients',
      'patientsPerDoctor',
      'overdueCareTasks',
    ],
    rows: result.rows.map((r) => ({
      ...r,
      twoStepPct: pct(r.withTwoStep, r.activeStaff),
      patientsPerDoctor: num(r.doctors) ? Math.round(num(r.patients) / num(r.doctors)) : null,
    })),
  };
}

/* ------------------------------------------------------------------ hospital reports */

/** Bed occupancy per facility and unit type (point in time; the period does not apply). */
async function occupancyReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const result = await db.execute<Row>(sql`
    SELECT f.code, f.name, f.region, u.type AS "unitType",
      count(b.id)::int AS beds,
      count(b.id) FILTER (WHERE EXISTS (SELECT 1 FROM admissions a
        WHERE a.bed_id = b.id AND a.status = 'ADMITTED'))::int AS occupied,
      count(b.id) FILTER (WHERE b.status = 'AVAILABLE')::int AS available,
      count(b.id) FILTER (WHERE b.status = 'CLEANING')::int AS cleaning,
      count(b.id) FILTER (WHERE b.status = 'OUT_OF_SERVICE')::int AS "outOfService"
    FROM facilities f
    JOIN care_units u ON u.facility_id = f.id AND u.is_active
    JOIN beds b ON b.unit_id = u.id
    WHERE ${facilityFilter('f', scope)}
    GROUP BY f.id, u.type ORDER BY f.region, f.name, u.type`);
  return {
    columns: [
      'code',
      'name',
      'region',
      'unitType',
      'beds',
      'occupied',
      'available',
      'cleaning',
      'outOfService',
      'occupancyPct',
    ],
    // Bed counts are operational, not patient counts, and are not suppressed.
    rows: result.rows.map((r) => ({
      ...r,
      occupancyPct: pct(r.occupied, num(r.beds) - num(r.outOfService)),
    })),
  };
}

/** Admissions, discharges and average length of stay per facility and unit type. */
async function admissionsReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const from = q.from.toISOString();
  const to = q.to.toISOString();
  const result = await db.execute<Row>(sql`
    SELECT f.code, f.name, f.region, u.type AS "unitType",
      count(a.id) FILTER (WHERE a.admitted_at BETWEEN ${from} AND ${to})::int AS admissions,
      count(a.id) FILTER (WHERE a.status = 'DISCHARGED' AND a.discharged_at BETWEEN ${from} AND ${to})::int AS discharges,
      count(a.id) FILTER (WHERE a.disposition = 'DECEASED' AND a.discharged_at BETWEEN ${from} AND ${to})::int AS deaths,
      count(a.id) FILTER (WHERE a.source = 'EMERGENCY' AND a.admitted_at BETWEEN ${from} AND ${to})::int AS "fromEmergency",
      avg(extract(epoch FROM (a.discharged_at - a.admitted_at)) / 86400)
        FILTER (WHERE a.status = 'DISCHARGED' AND a.discharged_at BETWEEN ${from} AND ${to}) AS "avgLengthOfStayDays",
      count(a.id) FILTER (WHERE a.status = 'ADMITTED')::int AS "currentInpatients"
    FROM facilities f
    JOIN care_units u ON u.facility_id = f.id
    JOIN admissions a ON a.unit_id = u.id AND a.status <> 'CANCELLED'
    WHERE ${facilityFilter('f', scope)}
    GROUP BY f.id, u.type ORDER BY f.region, f.name, u.type`);
  return {
    columns: [
      'code',
      'name',
      'region',
      'unitType',
      'admissions',
      'discharges',
      'fromEmergency',
      'deaths',
      'avgLengthOfStayDays',
      'currentInpatients',
    ],
    rows: result.rows.map((r) => ({
      ...r,
      admissions: suppress(num(r.admissions)),
      discharges: suppress(num(r.discharges)),
      fromEmergency: suppress(num(r.fromEmergency)),
      deaths: suppress(num(r.deaths)),
      currentInpatients: suppress(num(r.currentInpatients)),
      avgLengthOfStayDays:
        num(r.discharges) < SMALL_CELL_THRESHOLD ? null : hours(r.avgLengthOfStayDays),
      suppressed: num(r.admissions) < SMALL_CELL_THRESHOLD,
    })),
  };
}

/** Five-level triage targets, in minutes from arrival to being seen. */
export const TRIAGE_TARGET_MINUTES: Record<number, number> = { 1: 0, 2: 10, 3: 60, 4: 120, 5: 240 };

/** Emergency department: attendances, waiting time to be seen by triage level, left unseen. */
async function emergencyReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const from = q.from.toISOString();
  const to = q.to.toISOString();
  const wait = sql`extract(epoch FROM (e.seen_at - e.arrived_at)) / 60`;
  const median = (level: number) =>
    sql`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${wait}) FILTER (WHERE e.triage_level = ${sql.raw(String(level))} AND e.seen_at IS NOT NULL)`;
  const targetCase = sql.raw(
    `(CASE e.triage_level ${Object.entries(TRIAGE_TARGET_MINUTES)
      .map(([level, minutes]) => `WHEN ${Number(level)} THEN ${Number(minutes)}`)
      .join(' ')} END)`,
  );
  const result = await db.execute<Row>(sql`
    SELECT f.code, f.name, f.region,
      count(e.id)::int AS attendances,
      count(e.id) FILTER (WHERE e.arrival_mode = 'AMBULANCE')::int AS ambulance,
      count(e.id) FILTER (WHERE e.status = 'ADMITTED')::int AS admitted,
      count(e.id) FILTER (WHERE e.status = 'LEFT_WITHOUT_BEING_SEEN')::int AS "leftUnseen",
      count(e.id) FILTER (WHERE e.seen_at IS NOT NULL)::int AS seen,
      count(e.id) FILTER (WHERE e.seen_at IS NOT NULL AND e.triage_level IS NOT NULL
        AND ${wait} <= ${targetCase})::int AS "seenWithinTarget",
      ${median(1)} AS "medianWaitL1", ${median(2)} AS "medianWaitL2", ${median(3)} AS "medianWaitL3",
      ${median(4)} AS "medianWaitL4", ${median(5)} AS "medianWaitL5"
    FROM facilities f
    JOIN ed_visits e ON e.facility_id = f.id AND e.arrived_at BETWEEN ${from} AND ${to}
    WHERE ${facilityFilter('f', scope)}
    GROUP BY f.id ORDER BY f.region, f.name`);
  const minutes = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v)));
  return {
    columns: [
      'code',
      'name',
      'region',
      'attendances',
      'ambulance',
      'admitted',
      'leftUnseenPct',
      'seenWithinTargetPct',
      'medianWaitL1',
      'medianWaitL2',
      'medianWaitL3',
      'medianWaitL4',
      'medianWaitL5',
    ],
    rows: result.rows.map((r) => {
      const small = num(r.attendances) < SMALL_CELL_THRESHOLD;
      return {
        ...r,
        attendances: suppress(num(r.attendances)),
        ambulance: suppress(num(r.ambulance)),
        admitted: suppress(num(r.admitted)),
        // Raw counts behind the percentages are not returned (they may be small cells).
        leftUnseen: undefined,
        seen: undefined,
        seenWithinTarget: undefined,
        leftUnseenPct: small ? null : pct(r.leftUnseen, r.attendances),
        seenWithinTargetPct: small ? null : pct(r.seenWithinTarget, r.seen),
        medianWaitL1: small ? null : minutes(r.medianWaitL1),
        medianWaitL2: small ? null : minutes(r.medianWaitL2),
        medianWaitL3: small ? null : minutes(r.medianWaitL3),
        medianWaitL4: small ? null : minutes(r.medianWaitL4),
        medianWaitL5: small ? null : minutes(r.medianWaitL5),
        suppressed: small,
      };
    }),
  };
}

/** Births per facility: caesarean, low birth weight and preterm rates (suppressed when small). */
async function birthsReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const result = await db.execute<Row>(sql`
    SELECT f.code, f.name, f.region,
      count(b.id)::int AS births,
      count(b.id) FILTER (WHERE b.delivery_type IN ('CAESAREAN_ELECTIVE', 'CAESAREAN_EMERGENCY'))::int AS caesarean,
      count(b.id) FILTER (WHERE b.birth_weight_grams < 2500)::int AS "lowBirthWeight",
      count(b.id) FILTER (WHERE b.gestational_weeks < 37)::int AS preterm,
      count(b.id) FILTER (WHERE b.apgar_5 < 7)::int AS "lowApgar5"
    FROM facilities f
    JOIN births b ON b.facility_id = f.id
      AND b.born_at BETWEEN ${q.from.toISOString()} AND ${q.to.toISOString()}
    WHERE ${facilityFilter('f', scope)}
    GROUP BY f.id ORDER BY f.region, f.name`);
  return {
    columns: [
      'code',
      'name',
      'region',
      'births',
      'caesareanPct',
      'lowBirthWeightPct',
      'pretermPct',
      'lowApgar5Pct',
    ],
    rows: result.rows.map((r) => {
      const small = num(r.births) < SMALL_CELL_THRESHOLD;
      return {
        ...r,
        births: suppress(num(r.births)),
        caesarean: undefined,
        lowBirthWeight: undefined,
        preterm: undefined,
        lowApgar5: undefined,
        caesareanPct: small ? null : pct(r.caesarean, r.births),
        lowBirthWeightPct: small ? null : pct(r.lowBirthWeight, r.births),
        pretermPct: small ? null : pct(r.preterm, r.births),
        lowApgar5Pct: small ? null : pct(r.lowApgar5, r.births),
        suppressed: small,
      };
    }),
  };
}

/** Imaging volume and reporting turnaround per facility and modality. */
async function imagingReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const result = await db.execute<Row>(sql`
    SELECT f.code, f.name, f.region, i.modality,
      count(i.id)::int AS orders,
      count(i.id) FILTER (WHERE i.priority <> 'ROUTINE')::int AS urgent,
      count(i.id) FILTER (WHERE i.status = 'REPORTED')::int AS reported,
      count(i.id) FILTER (WHERE i.status IN ('ORDERED', 'SCHEDULED', 'PERFORMED'))::int AS outstanding,
      count(i.id) FILTER (WHERE i.critical)::int AS critical,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (i.reported_at - i.created_at)) / 3600)
        FILTER (WHERE i.reported_at IS NOT NULL) AS "medianHoursToReport"
    FROM facilities f
    JOIN imaging_orders i ON i.facility_id = f.id AND i.status <> 'CANCELLED'
      AND i.created_at BETWEEN ${q.from.toISOString()} AND ${q.to.toISOString()}
    WHERE ${facilityFilter('f', scope)}
    GROUP BY f.id, i.modality ORDER BY f.region, f.name, i.modality`);
  return {
    // Examination counts are activity, not patient counts; critical findings are suppressed.
    columns: [
      'code',
      'name',
      'region',
      'modality',
      'orders',
      'urgent',
      'reported',
      'outstanding',
      'critical',
      'medianHoursToReport',
    ],
    rows: result.rows.map((r) => ({
      ...r,
      critical: num(r.critical) === 0 ? 0 : suppress(num(r.critical)),
      medianHoursToReport: hours(r.medianHoursToReport),
    })),
  };
}

/** Weekday theatre time available in the period (8 hours per theatre per weekday). */
const THEATRE_MINUTES_PER_WEEKDAY = 8 * 60;

/**
 * Operating theatre use per facility: booked minutes against available weekday time, cases by
 * priority, cancellations, waiting time from request to operation and WHO checklist completion.
 * Case counts are activity, not patient counts.
 */
async function theatreReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const from = q.from.toISOString();
  const to = q.to.toISOString();
  const result = await db.execute<Row>(sql`
    WITH weekdays AS (
      SELECT count(*)::int AS n FROM generate_series(${from}::timestamptz, ${to}::timestamptz, interval '1 day') d
      WHERE extract(isodow FROM d) < 6
    ),
    theatres AS (
      SELECT facility_id, count(*)::int AS n FROM care_units
      WHERE type::text = 'OPERATING_THEATRE' AND is_active GROUP BY facility_id
    )
    SELECT f.code, f.name, f.region,
      coalesce(th.n, 0) AS theatres,
      count(c.id)::int AS cases,
      count(c.id) FILTER (WHERE c.priority = 'ELECTIVE')::int AS elective,
      count(c.id) FILTER (WHERE c.priority = 'URGENT')::int AS urgent,
      count(c.id) FILTER (WHERE c.priority = 'EMERGENCY')::int AS emergency,
      count(c.id) FILTER (WHERE c.status = 'COMPLETED')::int AS completed,
      count(c.id) FILTER (WHERE c.status = 'CANCELLED')::int AS cancelled,
      coalesce(sum(c.estimated_minutes) FILTER (WHERE c.status IN ('SCHEDULED', 'IN_THEATRE', 'COMPLETED')), 0)::int AS "bookedMinutes",
      coalesce(th.n, 0) * (SELECT n FROM weekdays) * ${THEATRE_MINUTES_PER_WEEKDAY} AS "availableMinutes",
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (c.in_theatre_at - c.created_at)) / 3600)
        FILTER (WHERE c.in_theatre_at IS NOT NULL) AS "medianHoursToOperation",
      count(c.id) FILTER (WHERE c.status = 'COMPLETED' AND c.checklist ? 'signIn' AND c.checklist ? 'timeOut' AND c.checklist ? 'signOut')::int AS "checklistComplete"
    FROM facilities f
    JOIN surgical_cases c ON c.facility_id = f.id
      AND coalesce(c.scheduled_start, c.created_at) BETWEEN ${from} AND ${to}
    LEFT JOIN theatres th ON th.facility_id = f.id
    WHERE ${facilityFilter('f', scope)}
    GROUP BY f.id, th.n ORDER BY f.region, f.name`);
  return {
    columns: [
      'code',
      'name',
      'region',
      'theatres',
      'cases',
      'elective',
      'urgent',
      'emergency',
      'completed',
      'cancelled',
      'cancellationPct',
      'bookedMinutes',
      'availableMinutes',
      'utilisationPct',
      'medianHoursToOperation',
      'checklistCompletePct',
    ],
    rows: result.rows.map((r) => ({
      ...r,
      cancellationPct: pct(r.cancelled, r.cases),
      utilisationPct: pct(r.bookedMinutes, r.availableMinutes),
      medianHoursToOperation: hours(r.medianHoursToOperation),
      checklistCompletePct: pct(r.checklistComplete, r.completed),
      checklistComplete: undefined,
    })),
  };
}

const REPORTS: Record<
  (typeof REPORT_NAMES)[number],
  (ctx: AuthContext, q: ReportQuery) => Promise<{ columns: string[]; rows: unknown[] }>
> = {
  activity: activityReport,
  diagnoses: diagnosesReport,
  medications: medicationsReport,
  pharmacy: pharmacyReport,
  vaccinations: vaccinationsReport,
  referrals: referralsReport,
  appointments: appointmentsReport,
  workforce: workforceReport,
  occupancy: occupancyReport,
  admissions: admissionsReport,
  emergency: emergencyReport,
  births: birthsReport,
  imaging: imagingReport,
  theatre: theatreReport,
};

/** CSV with protection against spreadsheet formula injection. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') +
    '\r\n'
  );
}

async function run(req: Request) {
  const ctx = requireAuth(req);
  const { report } = parse(ReportName, req.params);
  const q = parse(Query, req.query);
  if (ctx.role === 'DIRECTOR' && (q.region || (q.facilityId && q.facilityId !== ctx.facilityId))) {
    throw badRequest('Directors can only report on their own facility');
  }
  const data = await REPORTS[report](ctx, q);
  return { ctx, report, q, data };
}

export const reportsRouter = Router();
reportsRouter.use(authenticate, requireRole('MINISTRY', 'DIRECTOR'));

reportsRouter.get('/:report', async (req, res) => {
  const { q, data } = await run(req);
  res.json({ from: q.from, to: q.to, smallCellThreshold: SMALL_CELL_THRESHOLD, ...data });
});

reportsRouter.get('/:report/export', async (req, res) => {
  const { ctx, report, q, data } = await run(req);
  await audit({
    action: AuditAction.REPORT_EXPORTED,
    actor: ctx,
    resourceType: 'report',
    meta: requestMeta(req),
    metadata: {
      report,
      from: q.from.toISOString(),
      to: q.to.toISOString(),
      region: q.region ?? null,
      facilityId: ctx.role === 'DIRECTOR' ? ctx.facilityId : (q.facilityId ?? null),
      rows: data.rows.length,
    },
  });
  const name = `pacient-${report}-${q.from.toISOString().slice(0, 10)}-to-${q.to.toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(toCsv(data.columns, data.rows as Record<string, unknown>[]));
});
