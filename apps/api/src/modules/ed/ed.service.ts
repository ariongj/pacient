import { and, eq, inArray } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { careUnits, unitStaff, users, type Role } from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../lib/http.js';

/**
 * Emergency department rules shared by the routes.
 *
 * Five-level triage (as in the Manchester Triage System): the level decides how long a patient
 * may safely wait before a clinician sees them.
 */
export const TRIAGE_LEVELS = [1, 2, 3, 4, 5] as const;
export type TriageLevel = (typeof TRIAGE_LEVELS)[number];

/** Maximum waiting time before being seen, in minutes. */
export const TARGET_MINUTES: Record<TriageLevel, number> = { 1: 0, 2: 10, 3: 60, 4: 120, 5: 240 };
/** Patients should be triaged within this many minutes of arrival. */
export const TRIAGE_TARGET_MINUTES = 15;

export const OPEN_STATUSES = ['WAITING', 'IN_TREATMENT'] as const;

export type EdUnit = typeof careUnits.$inferSelect;

/** The emergency department of the caller's facility (or the one asked for). */
export async function edUnitFor(ctx: AuthContext, unitId?: string, executor: Executor = db) {
  if (!ctx.facilityId) throw forbidden('Emergency department access requires a facility');
  const rows = await executor
    .select()
    .from(careUnits)
    .where(
      and(
        eq(careUnits.facilityId, ctx.facilityId),
        eq(careUnits.type, 'EMERGENCY'),
        eq(careUnits.isActive, true),
        ...(unitId ? [eq(careUnits.id, unitId)] : []),
      ),
    )
    .orderBy(careUnits.name);
  const unit = rows[0];
  if (!unit) throw notFound('This facility has no emergency department');
  return unit;
}

export async function isUnitStaff(userId: string, unitId: string, executor: Executor = db) {
  const [row] = await executor
    .select({ id: unitStaff.id })
    .from(unitStaff)
    .where(and(eq(unitStaff.unitId, unitId), eq(unitStaff.userId, userId)))
    .limit(1);
  return Boolean(row);
}

/** Doctors and nurses of the emergency department may triage and treat. */
export async function isEdClinician(ctx: AuthContext, unit: EdUnit, executor: Executor = db) {
  return (
    (ctx.role === 'DOCTOR' || ctx.role === 'NURSE') &&
    ctx.facilityId === unit.facilityId &&
    (await isUnitStaff(ctx.userId, unit.id, executor))
  );
}

export async function assertEdClinician(ctx: AuthContext, unit: EdUnit, executor: Executor = db) {
  if (!(await isEdClinician(ctx, unit, executor))) {
    throw forbidden('Only doctors and nurses assigned to the emergency department can do this');
  }
}

/** Arrivals are registered by reception at the facility or by emergency department clinicians. */
export async function assertCanRegister(ctx: AuthContext, unit: EdUnit, executor: Executor = db) {
  if (ctx.role === 'RECEPTION' && ctx.facilityId === unit.facilityId) return;
  await assertEdClinician(ctx, unit, executor);
}

/** May see the board: reception of the facility and emergency department clinicians. */
export async function assertCanViewBoard(ctx: AuthContext, unit: EdUnit, executor: Executor = db) {
  await assertCanRegister(ctx, unit, executor);
}

/** Active staff of the unit with one of the given roles. */
export async function unitStaffIds(unitId: string, roles: Role[], executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(unitStaff)
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(and(eq(unitStaff.unitId, unitId), eq(users.isActive, true), inArray(users.role, roles)));
  return rows.map((r) => r.id);
}

export function minutesBetween(from: Date, to: Date) {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
}
