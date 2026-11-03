import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import { admissions, careUnits, unitStaff, users } from '../../db/schema.js';

/* ------------------------------------------------------------------ theatres and staff ------- */

/** Active operating theatres of a facility. */
export async function theatreUnits(facilityId: string, executor: Executor = db) {
  return executor
    .select({ id: careUnits.id, name: careUnits.name, code: careUnits.code })
    .from(careUnits)
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        eq(careUnits.type, 'OPERATING_THEATRE'),
        eq(careUnits.isActive, true),
      ),
    )
    .orderBy(careUnits.code);
}

/** Staff assigned to the facility's theatres (optionally one theatre, optionally some roles). */
export async function theatreStaff(
  facilityId: string,
  opts: { unitId?: string; roles?: ('DOCTOR' | 'NURSE')[] } = {},
  executor: Executor = db,
) {
  const rows = await executor
    .select({ id: users.id })
    .from(unitStaff)
    .innerJoin(careUnits, eq(careUnits.id, unitStaff.unitId))
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        eq(careUnits.type, 'OPERATING_THEATRE'),
        eq(careUnits.isActive, true),
        eq(users.isActive, true),
        inArray(users.role, opts.roles ?? ['DOCTOR', 'NURSE']),
        opts.unitId ? eq(careUnits.id, opts.unitId) : undefined,
      ),
    );
  return [...new Set(rows.map((r) => r.id))];
}

export async function isTheatreStaff(
  userId: string,
  facilityId: string | null,
  unitId?: string,
  executor: Executor = db,
) {
  if (!facilityId) return false;
  return (await theatreStaff(facilityId, { unitId }, executor)).includes(userId);
}

/** The attending doctor of the patient's current stay, if any. */
export async function attendingDoctorOf(patientId: string, executor: Executor = db) {
  const [row] = await executor
    .select({ id: admissions.attendingDoctorId, admissionId: admissions.id })
    .from(admissions)
    .where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'ADMITTED')));
  return row ?? null;
}

/* ------------------------------------------------------------------ WHO checklist ------------ */

const confirmed = z.literal(true, { error: 'Every confirmation in this step is required' });
const yesNo = z.enum(['YES', 'NO']);
const note = z.string().trim().max(500).optional().nullable();

/**
 * WHO Surgical Safety Checklist. Confirmations must be ticked; risk questions are answered. Each
 * step is stored with who completed it and when.
 */
export const CHECKLIST_STEPS = {
  signIn: z
    .object({
      identityConfirmed: confirmed,
      siteMarked: z.enum(['YES', 'NOT_APPLICABLE']),
      consentConfirmed: confirmed,
      anaesthesiaCheckComplete: confirmed,
      pulseOximeterFunctioning: confirmed,
      knownAllergy: yesNo,
      difficultAirwayRisk: yesNo,
      bloodLossRisk: yesNo,
      note,
    })
    .strict(),
  timeOut: z
    .object({
      teamIntroduced: confirmed,
      patientSiteProcedureConfirmed: confirmed,
      antibioticProphylaxis: z.enum(['GIVEN', 'NOT_APPLICABLE']),
      criticalEventsReviewed: confirmed,
      imagingDisplayed: z.enum(['YES', 'NOT_APPLICABLE']),
      note,
    })
    .strict(),
  signOut: z
    .object({
      procedureRecorded: confirmed,
      countsCorrect: z.boolean(),
      countsNote: note,
      specimenLabelled: z.enum(['YES', 'NOT_APPLICABLE']),
      equipmentProblems: z.string().trim().max(500).optional().nullable(),
      recoveryConcerns: z.string().trim().max(1000).optional().nullable(),
      note,
    })
    .strict()
    .refine(
      (v) => v.countsCorrect || (v.countsNote && v.countsNote.length >= 5),
      'If the counts are not correct, describe what was done',
    ),
} as const;
export type ChecklistStep = keyof typeof CHECKLIST_STEPS;
export const STEP_ORDER: ChecklistStep[] = ['signIn', 'timeOut', 'signOut'];

export interface ChecklistEntry {
  answers: Record<string, unknown>;
  by: { id: string; name: string };
  at: string;
}
export type Checklist = Partial<Record<ChecklistStep, ChecklistEntry>> & {
  consentWaiver?: { reason: string; by: { id: string; name: string }; at: string };
  postponements?: { reason: string; by: { id: string; name: string }; at: string }[];
  forcedBooking?: { reason: string; by: { id: string; name: string }; at: string };
};

/** The checklist as clients see it: which steps are done. */
export const checklistProgress = (c: Checklist) => ({
  signIn: Boolean(c.signIn),
  timeOut: Boolean(c.timeOut),
  signOut: Boolean(c.signOut),
});

/* ------------------------------------------------------------------ conflicts ---------------- */

/** Cases in the same theatre overlapping [start, start + minutes). */
export async function theatreConflict(
  theatreUnitId: string,
  start: Date,
  minutes: number,
  excludeId: string,
  executor: Executor = db,
) {
  const end = new Date(start.getTime() + minutes * 60_000);
  const result = await executor.execute<{ id: string; procedure: string; scheduled_start: string }>(
    sql`SELECT id, procedure, scheduled_start FROM surgical_cases
        WHERE theatre_unit_id = ${theatreUnitId} AND id <> ${excludeId}
          AND status IN ('SCHEDULED', 'IN_THEATRE')
          AND tstzrange(scheduled_start, scheduled_start + make_interval(mins => estimated_minutes))
              && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
        LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

/** Cases where this surgeon (primary or assistant) is already booked in that period. */
export async function surgeonConflict(
  surgeonId: string,
  start: Date,
  minutes: number,
  excludeId: string,
  executor: Executor = db,
) {
  const end = new Date(start.getTime() + minutes * 60_000);
  const result = await executor.execute<{ id: string; procedure: string; scheduled_start: string }>(
    sql`SELECT id, procedure, scheduled_start FROM surgical_cases
        WHERE (primary_surgeon_id = ${surgeonId} OR assistant_id = ${surgeonId}) AND id <> ${excludeId}
          AND status IN ('SCHEDULED', 'IN_THEATRE')
          AND tstzrange(scheduled_start, scheduled_start + make_interval(mins => estimated_minutes))
              && tstzrange(${start.toISOString()}::timestamptz, ${end.toISOString()}::timestamptz)
        LIMIT 1`,
  );
  return result.rows[0] ?? null;
}
