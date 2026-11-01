import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';

/**
 * Aggregate statistics for management tiers. Only counts are returned – never identifiable
 * records. Counts below SMALL_CELL_THRESHOLD in disease breakdowns are suppressed so that rare
 * conditions in small facilities cannot be used to re-identify individuals.
 */
export const SMALL_CELL_THRESHOLD = 5;

const n = (v: unknown) => Number(v ?? 0);

function suppress<T extends { count: number }>(rows: T[]) {
  return rows.map((r) =>
    r.count < SMALL_CELL_THRESHOLD
      ? { ...r, count: null, suppressed: true as const }
      : { ...r, suppressed: false as const },
  );
}

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

function monthSeries(raw: { month: string; count: unknown }[]) {
  // Always return 12 contiguous months (zero-filled) so charts have a stable axis.
  const map = new Map(raw.map((r) => [r.month, n(r.count)]));
  const out: { month: string; count: number }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    out.push({ month: key, count: map.get(key) ?? 0 });
  }
  return out;
}

export async function facilityStats(facilityId: string) {
  const [totals] = await rows<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*) FROM patients WHERE primary_facility_id = ${facilityId}) AS patients,
      (SELECT count(*) FROM patients WHERE primary_facility_id = ${facilityId} AND user_id IS NOT NULL) AS portal_users,
      (SELECT count(*) FROM users WHERE facility_id = ${facilityId} AND role = 'DOCTOR' AND is_active) AS active_doctors,
      (SELECT count(*) FROM encounters WHERE facility_id = ${facilityId} AND started_at >= now() - interval '30 days') AS encounters_30d,
      (SELECT count(*) FROM appointments WHERE facility_id = ${facilityId} AND scheduled_at >= now() AND status IN ('REQUESTED','CONFIRMED')) AS upcoming_appointments,
      (SELECT count(*) FROM appointments WHERE facility_id = ${facilityId} AND status = 'REQUESTED' AND scheduled_at >= now()) AS pending_requests,
      (SELECT count(*) FROM emergency_access_grants g JOIN users u ON u.id = g.doctor_id
         WHERE u.facility_id = ${facilityId} AND g.created_at >= now() - interval '30 days') AS emergency_access_30d
  `);

  const [byMonth, byType, topDiagnoses, doctorWorkload, appointmentStatus] = await Promise.all([
    rows<{ month: string; count: unknown }>(sql`
      SELECT to_char(date_trunc('month', started_at), 'YYYY-MM') AS month, count(*) AS count
      FROM encounters
      WHERE facility_id = ${facilityId} AND started_at >= date_trunc('month', now()) - interval '11 months'
      GROUP BY 1 ORDER BY 1`),
    rows<{ type: string; count: unknown }>(sql`
      SELECT type, count(*) AS count FROM encounters
      WHERE facility_id = ${facilityId} AND started_at >= now() - interval '365 days'
      GROUP BY type ORDER BY count DESC`),
    rows<{ icd10Code: string; description: string; count: unknown }>(sql`
      SELECT d.icd10_code AS "icd10Code", min(d.description) AS description, count(DISTINCT d.patient_id) AS count
      FROM diagnoses d JOIN users u ON u.id = d.doctor_id
      WHERE u.facility_id = ${facilityId} AND d.diagnosed_at >= now() - interval '365 days'
      GROUP BY d.icd10_code ORDER BY count DESC LIMIT 10`),
    rows<{
      doctorId: string;
      fullName: string;
      specialty: string | null;
      patients: unknown;
      encounters30d: unknown;
    }>(sql`
      SELECT u.id AS "doctorId", u.full_name AS "fullName", u.specialty,
        (SELECT count(*) FROM care_assignments ca WHERE ca.doctor_id = u.id AND ca.ended_at IS NULL) AS patients,
        (SELECT count(*) FROM encounters e WHERE e.doctor_id = u.id AND e.started_at >= now() - interval '30 days') AS "encounters30d"
      FROM users u
      WHERE u.facility_id = ${facilityId} AND u.role = 'DOCTOR' AND u.is_active
      ORDER BY "encounters30d" DESC, u.full_name`),
    rows<{ status: string; count: unknown }>(sql`
      SELECT status, count(*) AS count FROM appointments
      WHERE facility_id = ${facilityId} AND scheduled_at >= now() - interval '30 days'
      GROUP BY status`),
  ]);

  return {
    totals: {
      patients: n(totals?.patients),
      portalUsers: n(totals?.portal_users),
      activeDoctors: n(totals?.active_doctors),
      encounters30d: n(totals?.encounters_30d),
      upcomingAppointments: n(totals?.upcoming_appointments),
      pendingAppointmentRequests: n(totals?.pending_requests),
      emergencyAccess30d: n(totals?.emergency_access_30d),
    },
    encountersByMonth: monthSeries(byMonth),
    encountersByType: byType.map((r) => ({ type: r.type, count: n(r.count) })),
    topDiagnoses: suppress(topDiagnoses.map((r) => ({ ...r, count: n(r.count) }))),
    doctorWorkload: doctorWorkload.map((r) => ({
      ...r,
      patients: n(r.patients),
      encounters30d: n(r.encounters30d),
    })),
    appointmentsByStatus: appointmentStatus.map((r) => ({ status: r.status, count: n(r.count) })),
  };
}

export async function nationalStats() {
  const [totals] = await rows<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*) FROM facilities WHERE is_active) AS facilities,
      (SELECT count(*) FROM patients) AS patients,
      (SELECT count(*) FROM patients WHERE user_id IS NOT NULL) AS portal_users,
      (SELECT count(*) FROM users WHERE role = 'DOCTOR' AND is_active) AS doctors,
      (SELECT count(*) FROM encounters WHERE started_at >= now() - interval '30 days') AS encounters_30d,
      (SELECT count(*) FROM emergency_access_grants WHERE created_at >= now() - interval '30 days') AS emergency_access_30d
  `);

  const [byFacility, byRegion, byMonth, topDiagnoses] = await Promise.all([
    rows<Record<string, unknown>>(sql`
      SELECT f.id, f.code, f.name, f.type, f.region, f.is_active AS "isActive",
        (SELECT count(*) FROM patients p WHERE p.primary_facility_id = f.id) AS patients,
        (SELECT count(*) FROM users u WHERE u.facility_id = f.id AND u.role = 'DOCTOR' AND u.is_active) AS doctors,
        (SELECT count(*) FROM encounters e WHERE e.facility_id = f.id AND e.started_at >= now() - interval '30 days') AS "encounters30d",
        (SELECT u.full_name FROM users u WHERE u.facility_id = f.id AND u.role = 'DIRECTOR' AND u.is_active ORDER BY u.created_at LIMIT 1) AS "directorName"
      FROM facilities f ORDER BY f.region, f.name`),
    rows<Record<string, unknown>>(sql`
      SELECT f.region,
        count(DISTINCT f.id) AS facilities,
        (SELECT count(*) FROM patients p JOIN facilities f2 ON f2.id = p.primary_facility_id WHERE f2.region = f.region) AS patients,
        (SELECT count(*) FROM encounters e JOIN facilities f3 ON f3.id = e.facility_id
           WHERE f3.region = f.region AND e.started_at >= now() - interval '30 days') AS "encounters30d"
      FROM facilities f WHERE f.is_active GROUP BY f.region ORDER BY f.region`),
    rows<{ month: string; count: unknown }>(sql`
      SELECT to_char(date_trunc('month', started_at), 'YYYY-MM') AS month, count(*) AS count
      FROM encounters WHERE started_at >= date_trunc('month', now()) - interval '11 months'
      GROUP BY 1 ORDER BY 1`),
    rows<{ icd10Code: string; description: string; count: unknown }>(sql`
      SELECT icd10_code AS "icd10Code", min(description) AS description, count(DISTINCT patient_id) AS count
      FROM diagnoses WHERE diagnosed_at >= now() - interval '365 days'
      GROUP BY icd10_code ORDER BY count DESC LIMIT 15`),
  ]);

  return {
    totals: {
      facilities: n(totals?.facilities),
      patients: n(totals?.patients),
      portalUsers: n(totals?.portal_users),
      doctors: n(totals?.doctors),
      encounters30d: n(totals?.encounters_30d),
      emergencyAccess30d: n(totals?.emergency_access_30d),
    },
    byFacility: byFacility.map((r) => ({
      ...r,
      patients: n(r.patients),
      doctors: n(r.doctors),
      encounters30d: n(r.encounters30d),
    })),
    byRegion: byRegion.map((r) => ({
      region: r.region as string,
      facilities: n(r.facilities),
      patients: n(r.patients),
      encounters30d: n(r.encounters30d),
    })),
    encountersByMonth: monthSeries(byMonth),
    topDiagnoses: suppress(topDiagnoses.map((r) => ({ ...r, count: n(r.count) }))),
    smallCellThreshold: SMALL_CELL_THRESHOLD,
  };
}
