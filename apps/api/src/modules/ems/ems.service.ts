import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { careUnits, emsCareRecords, unitStaff, users } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../lib/http.js';
import { scoreNews2, type News2Input, type News2Result } from '../news/news2.js';
import { ageInMonths, scorePews, type PewsResult } from '../news/pews.js';

/**
 * Emergency medical services (ambulance): call → dispatch → on scene → transport → handover to
 * the emergency department, or closure on scene.
 *
 * ILLUSTRATIVE call categories: P1 immediately life-threatening, P2 urgent, P3 non-urgent, derived
 * from a short structured question set. They must be replaced by the national EMS dispatch
 * protocol once it is adopted. A single response-time target is used for statistics: P1 on scene
 * within 15 minutes of dispatch (national targets usually differ for urban and rural areas).
 */
export const PRIORITIES = ['P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const P1_TARGET_MINUTES = 15;

export const STATUSES = [
  'RECEIVED',
  'DISPATCHED',
  'ON_SCENE',
  'TRANSPORTING',
  'HANDED_OVER',
  'CLOSED',
  'CANCELLED',
] as const;
export type EmsStatus = (typeof STATUSES)[number];
export const OPEN_STATUSES: EmsStatus[] = [
  'RECEIVED',
  'DISPATCHED',
  'ON_SCENE',
  'TRANSPORTING',
  'HANDED_OVER',
];

export const OUTCOMES = [
  'TRANSPORTED',
  'TREATED_ON_SCENE',
  'REFUSED_TRANSPORT',
  'DECEASED_ON_SCENE',
  'NO_PATIENT',
  'CANCELLED',
] as const;
export type Outcome = (typeof OUTCOMES)[number];
/** Outcomes that close a call on scene (no transport). */
export const ON_SCENE_OUTCOMES: Outcome[] = [
  'TREATED_ON_SCENE',
  'REFUSED_TRANSPORT',
  'DECEASED_ON_SCENE',
  'NO_PATIENT',
];

export const VEHICLE_STATUSES = [
  'AVAILABLE',
  'DISPATCHED',
  'ON_SCENE',
  'TRANSPORTING',
  'AT_HOSPITAL',
  'OUT_OF_SERVICE',
] as const;

/** Answers of the structured call questions. */
export interface CallAnswers {
  conscious: boolean;
  breathingNormally: boolean;
  chestPain?: boolean;
  majorBleeding?: boolean;
  strokeSigns?: boolean;
  seriousInjury?: boolean;
  severePain?: boolean;
}

/**
 * P1 when the patient is unconscious, not breathing normally, has chest pain, major bleeding or
 * signs of a stroke; P2 for a serious injury or severe pain; otherwise P3.
 */
export function priorityFor(a: CallAnswers): Priority {
  if (!a.conscious || !a.breathingNormally || a.chestPain || a.majorBleeding || a.strokeSigns) {
    return 'P1';
  }
  if (a.seriousInjury || a.severePain) return 'P2';
  return 'P3';
}

/** Observation ranges for pre-hospital records (beyond these a value is a typing error). */
export const OBSERVATION_RANGES = {
  systolic: [40, 300],
  diastolic: [20, 200],
  heartRate: [20, 300],
  respiratoryRate: [4, 80],
  spo2: [30, 100],
  gcs: [3, 15],
  glucose: [0.5, 50],
  temperature: [25, 45],
} as const;
export type ObservationKey = keyof typeof OBSERVATION_RANGES;

/**
 * NEWS2 consciousness from the Glasgow Coma Scale: 15 alert; 13–14 treated as new confusion (C);
 * 9–12 responds to voice (V); 8 or less responds to pain or unresponsive (P). An approximation –
 * crews should record ACVPU where possible.
 */
export function acvpuFromGcs(gcs: number): 'A' | 'C' | 'V' | 'P' {
  if (gcs >= 15) return 'A';
  if (gcs >= 13) return 'C';
  if (gcs >= 9) return 'V';
  return 'P';
}

export type EarlyWarning =
  | { scale: 'NEWS2'; result: News2Result; recordedAt: Date }
  | { scale: 'PEWS'; result: PewsResult; recordedAt: Date };

/**
 * Early warning score from the latest observation record: PEWS for children (date of birth
 * known and under 18), otherwise NEWS2 (also when the age is unknown).
 */
export function earlyWarningFor(
  observations: { recordedAt: Date; data: Record<string, unknown> }[],
  dateOfBirth: string | null,
): EarlyWarning | null {
  const latest = [...observations].sort(
    (a, b) => b.recordedAt.getTime() - a.recordedAt.getTime(),
  )[0];
  if (!latest) return null;
  const d = latest.data;
  const num = (k: string) => (typeof d[k] === 'number' ? (d[k] as number) : null);
  const gcs = num('gcs');
  const input: News2Input = {
    respiratoryRate: num('respiratoryRate'),
    oxygenSaturation: num('spo2'),
    onSupplementalOxygen: typeof d.onOxygen === 'boolean' ? d.onOxygen : null,
    systolic: num('systolic'),
    heartRate: num('heartRate'),
    consciousness: gcs === null ? null : acvpuFromGcs(gcs),
    temperatureC: num('temperature'),
  };
  if (dateOfBirth) {
    const months = ageInMonths(dateOfBirth, latest.recordedAt);
    if (months < 18 * 12) {
      return { scale: 'PEWS', result: scorePews(input, months), recordedAt: latest.recordedAt };
    }
  }
  return { scale: 'NEWS2', result: scoreNews2(input), recordedAt: latest.recordedAt };
}

export async function observationsOf(incidentId: string, executor: Executor = db) {
  return executor
    .select({ recordedAt: emsCareRecords.recordedAt, data: emsCareRecords.data })
    .from(emsCareRecords)
    .where(and(eq(emsCareRecords.incidentId, incidentId), eq(emsCareRecords.kind, 'OBSERVATION')));
}

export type ServiceUnit = typeof careUnits.$inferSelect;

/** Ambulance services (AMBULANCE_SERVICE units) the caller works in. */
export async function myServices(ctx: AuthContext, executor: Executor = db) {
  if (ctx.role !== 'DOCTOR' && ctx.role !== 'NURSE') return [];
  return executor
    .select({
      id: careUnits.id,
      name: careUnits.name,
      code: careUnits.code,
      facilityId: careUnits.facilityId,
    })
    .from(unitStaff)
    .innerJoin(careUnits, eq(careUnits.id, unitStaff.unitId))
    .where(
      and(
        eq(unitStaff.userId, ctx.userId),
        eq(careUnits.type, 'AMBULANCE_SERVICE'),
        eq(careUnits.isActive, true),
      ),
    )
    .orderBy(careUnits.name);
}

export async function serviceUnit(id: string, executor: Executor = db) {
  const [unit] = await executor
    .select()
    .from(careUnits)
    .where(and(eq(careUnits.id, id), eq(careUnits.type, 'AMBULANCE_SERVICE')));
  if (!unit) throw notFound('Ambulance service not found');
  return unit;
}

export async function isServiceStaff(ctx: AuthContext, serviceUnitId: string, ex: Executor = db) {
  if (ctx.role !== 'DOCTOR' && ctx.role !== 'NURSE') return false;
  const [row] = await ex
    .select({ id: unitStaff.id })
    .from(unitStaff)
    .where(and(eq(unitStaff.unitId, serviceUnitId), eq(unitStaff.userId, ctx.userId)))
    .limit(1);
  return Boolean(row);
}

/** Emergency department units of a facility. */
export async function edUnitsOf(facilityId: string, executor: Executor = db) {
  return executor
    .select({ id: careUnits.id, name: careUnits.name })
    .from(careUnits)
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        eq(careUnits.type, 'EMERGENCY'),
        eq(careUnits.isActive, true),
      ),
    );
}

/** Doctors and nurses of the facility's emergency department(s) (pre-alert recipients). */
export async function edClinicianIds(facilityId: string, executor: Executor = db) {
  const units = await edUnitsOf(facilityId, executor);
  if (!units.length) return [];
  const rows = await executor
    .select({ id: users.id })
    .from(unitStaff)
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(
      and(
        inArray(
          unitStaff.unitId,
          units.map((u) => u.id),
        ),
        eq(users.isActive, true),
        inArray(users.role, ['DOCTOR', 'NURSE']),
      ),
    );
  return [...new Set(rows.map((r) => r.id))];
}

/** Doctor or nurse of an emergency department at the given facility. */
export async function isEdClinicianAt(ctx: AuthContext, facilityId: string, ex: Executor = db) {
  if (ctx.facilityId !== facilityId) return false;
  if (ctx.role !== 'DOCTOR' && ctx.role !== 'NURSE') return false;
  const units = await edUnitsOf(facilityId, ex);
  if (!units.length) return false;
  const [row] = await ex
    .select({ id: unitStaff.id })
    .from(unitStaff)
    .where(
      and(
        eq(unitStaff.userId, ctx.userId),
        inArray(
          unitStaff.unitId,
          units.map((u) => u.id),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** EMS-<year>-NNNNNN, serialised per year with an advisory lock (race-safe). */
export async function nextReference(tx: Executor, at = new Date()): Promise<string> {
  const year = at.getUTCFullYear();
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ems_reference_${year}`}))`);
  const result = await tx.execute<{ n: number }>(sql`
    SELECT COALESCE(MAX(substring(reference from 10)::int), 0) + 1 AS n
    FROM ems_incidents WHERE reference LIKE ${`EMS-${year}-%`}`);
  const n = Number(result.rows[0]?.n ?? 1);
  return `EMS-${year}-${String(n).padStart(6, '0')}`;
}

export const minutesBetween = (from: Date | null, to: Date | null) =>
  from && to ? Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000)) : null;

/** Age band shown on the ED pre-alert strip (no names before handover). */
export function ageBandOf(dateOfBirth: string | null, at = new Date()): string | null {
  if (!dateOfBirth) return null;
  const years = Math.floor(ageInMonths(dateOfBirth, at) / 12);
  if (years < 1) return 'INFANT';
  if (years < 18) return 'CHILD';
  if (years < 65) return 'ADULT';
  return 'OLDER_ADULT';
}
