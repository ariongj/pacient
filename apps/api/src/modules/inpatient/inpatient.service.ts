import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  admissions,
  beds,
  careUnits,
  diagnoses,
  imagingOrders,
  labResults,
  prescriptions,
  unitStaff,
  users,
  vitalSigns,
  type Role,
} from '../../db/schema.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../lib/http.js';
import { formatDateFor, toLocale, tr, type Locale } from '../../i18n/index.js';

/** Unit types that have beds and take admissions (the emergency department and radiology don't). */
export const WARD_TYPES = [
  'GENERAL_WARD',
  'SURGICAL_WARD',
  'ICU',
  'MATERNITY',
  'PAEDIATRIC',
  'NEONATAL',
] as const;
export const isWardType = (type: string) => (WARD_TYPES as readonly string[]).includes(type);

/** Roles that may work on a facility's bed board. */
export const BOARD_ROLES: Role[] = ['DOCTOR', 'NURSE', 'RECEPTION', 'DIRECTOR'];

export function assertFacilityStaff(ctx: AuthContext, roles: Role[] = BOARD_ROLES): string {
  if (!roles.includes(ctx.role) || !ctx.facilityId) {
    throw forbidden('Only staff of this facility can use the bed board');
  }
  return ctx.facilityId;
}

/** The unit, checked to belong to the caller's facility. */
export async function unitAtFacility(unitId: string, facilityId: string, executor: Executor = db) {
  const [unit] = await executor
    .select()
    .from(careUnits)
    .where(and(eq(careUnits.id, unitId), eq(careUnits.facilityId, facilityId)));
  if (!unit) throw notFound('Unit not found');
  return unit;
}

export async function wardAtFacility(unitId: string, facilityId: string, executor: Executor = db) {
  const unit = await unitAtFacility(unitId, facilityId, executor);
  if (!isWardType(unit.type)) throw badRequest('Patients can only be admitted to a ward');
  if (!unit.isActive) throw badRequest('This unit is closed');
  return unit;
}

/** Locks the bed row and checks it can take a patient. */
export async function lockAvailableBed(bedId: string, unitId: string, tx: Executor) {
  const result = await tx.execute<{ id: string; status: string; unit_id: string }>(
    sql`SELECT id, status, unit_id FROM beds WHERE id = ${bedId} FOR UPDATE`,
  );
  const bed = result.rows[0];
  if (!bed || bed.unit_id !== unitId) throw badRequest('This bed does not belong to the unit');
  if (bed.status !== 'AVAILABLE') throw badRequest('This bed is not available');
  return bed;
}

/** Nurses assigned to a unit (to tell them about arrivals). */
export async function unitNurses(unitId: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(unitStaff)
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(and(eq(unitStaff.unitId, unitId), eq(users.role, 'NURSE'), eq(users.isActive, true)));
  return rows.map((r) => r.id);
}

export async function localeOf(userId: string): Promise<Locale> {
  const [u] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, userId));
  return toLocale(u?.locale);
}

const FLAG_LABEL: Record<string, string> = {
  LOW: 'low',
  HIGH: 'high',
  CRITICAL: 'critical',
  NORMAL: 'normal',
};

/**
 * A draft discharge summary assembled from what was recorded during the stay, written in the
 * doctor's language. The doctor edits it before signing; nothing is signed automatically.
 */
export async function buildSummaryDraft(
  admission: typeof admissions.$inferSelect,
  locale: Locale,
): Promise<string> {
  const from = admission.admittedAt;
  const to = admission.dischargedAt ?? new Date();
  const L = (text: string, vars?: Record<string, string | number | Date>) => tr(locale, text, vars);
  const date = (d: Date) => formatDateFor(locale, d);

  const [unit] = await db
    .select({ name: careUnits.name })
    .from(careUnits)
    .where(eq(careUnits.id, admission.unitId));
  const [dx, meds, vitals, labs, imaging] = await Promise.all([
    db
      .select({
        code: diagnoses.icd10Code,
        description: diagnoses.description,
        diagnosedAt: diagnoses.diagnosedAt,
      })
      .from(diagnoses)
      .where(
        and(
          eq(diagnoses.patientId, admission.patientId),
          sql`(${diagnoses.diagnosedAt} BETWEEN ${from.toISOString()} AND ${to.toISOString()} OR ${diagnoses.status} IN ('ACTIVE', 'CHRONIC'))`,
        ),
      )
      .orderBy(desc(diagnoses.diagnosedAt))
      .limit(20),
    db
      .select({
        medication: prescriptions.medication,
        dosage: prescriptions.dosage,
        frequency: prescriptions.frequency,
      })
      .from(prescriptions)
      .where(
        and(eq(prescriptions.patientId, admission.patientId), eq(prescriptions.status, 'ACTIVE')),
      )
      .orderBy(desc(prescriptions.startDate))
      .limit(20),
    db
      .select()
      .from(vitalSigns)
      .where(eq(vitalSigns.patientId, admission.patientId))
      .orderBy(desc(vitalSigns.recordedAt))
      .limit(1),
    db
      .select({
        testName: labResults.testName,
        value: labResults.value,
        unit: labResults.unit,
        flag: labResults.flag,
        collectedAt: labResults.collectedAt,
      })
      .from(labResults)
      .where(
        and(
          eq(labResults.patientId, admission.patientId),
          isNull(labResults.supersededById),
          gte(labResults.collectedAt, from),
          lte(labResults.collectedAt, to),
        ),
      )
      .orderBy(desc(labResults.collectedAt))
      .limit(15),
    db
      .select({
        modality: imagingOrders.modality,
        bodyPart: imagingOrders.bodyPart,
        impression: imagingOrders.impression,
        reportedAt: imagingOrders.reportedAt,
      })
      .from(imagingOrders)
      .where(
        and(
          eq(imagingOrders.patientId, admission.patientId),
          eq(imagingOrders.status, 'REPORTED'),
          gte(imagingOrders.createdAt, from),
        ),
      )
      .orderBy(desc(imagingOrders.reportedAt))
      .limit(10),
  ]);

  const lines: string[] = [];
  lines.push(L('DISCHARGE SUMMARY'));
  lines.push(
    L('Admitted {date} to {unit}.', { date: date(from), unit: unit?.name ?? '' }) +
      (admission.dischargedAt ? ` ${L('Discharged {date}.', { date: date(to) })}` : ''),
  );
  lines.push('');
  lines.push(L('Reason for admission'));
  lines.push(admission.reason);
  lines.push('');
  lines.push(L('Diagnoses'));
  lines.push(
    ...(dx.length ? dx.map((d) => `- ${d.code} ${d.description}`) : [`- ${L('None recorded')}`]),
  );
  lines.push('');
  lines.push(L('Course in hospital'));
  lines.push(L('[Describe the course, treatment and procedures]'));
  lines.push('');
  const notableLabs = labs.filter((l) => l.flag !== 'NORMAL');
  lines.push(L('Investigations'));
  if (!notableLabs.length && !imaging.length) lines.push(`- ${L('No abnormal results recorded')}`);
  for (const l of notableLabs) {
    lines.push(
      `- ${l.testName}: ${l.value}${l.unit ? ` ${l.unit}` : ''} (${L(FLAG_LABEL[l.flag] ?? l.flag)}, ${date(l.collectedAt)})`,
    );
  }
  for (const i of imaging) {
    lines.push(`- ${i.modality} ${i.bodyPart}: ${i.impression ?? ''}`);
  }
  lines.push('');
  const v = vitals[0];
  if (v) {
    const parts = [
      v.systolic && v.diastolic ? `${L('BP')} ${v.systolic}/${v.diastolic} mmHg` : null,
      v.heartRate ? `${L('Pulse')} ${v.heartRate}/min` : null,
      v.temperatureC ? `${L('Temp.')} ${v.temperatureC} °C` : null,
      v.oxygenSaturation ? `SpO₂ ${v.oxygenSaturation}%` : null,
    ].filter(Boolean);
    if (parts.length) {
      lines.push(L('Last observations ({date})', { date: date(v.recordedAt) }));
      lines.push(parts.join(', '));
      lines.push('');
    }
  }
  lines.push(L('Medication at discharge'));
  lines.push(
    ...(meds.length
      ? meds.map((m) => `- ${m.medication} ${m.dosage}, ${m.frequency}`)
      : [`- ${L('None')}`]),
  );
  lines.push('');
  lines.push(L('Follow-up'));
  lines.push(L('[Follow-up appointments, checks and advice for the patient]'));
  return lines.join('\n');
}

/** Unit ids (with names) for display. */
export async function unitNames(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db
    .select({ id: careUnits.id, name: careUnits.name })
    .from(careUnits)
    .where(inArray(careUnits.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function bedLabels(ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db
    .select({ id: beds.id, label: beds.label })
    .from(beds)
    .where(inArray(beds.id, ids));
  return new Map(rows.map((r) => [r.id, r.label]));
}
