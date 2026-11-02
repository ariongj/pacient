import { and, eq, gt, inArray, isNull, lte } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { careAssignments, coverArrangements, users } from '../../db/schema.js';

/**
 * Result cover: while a doctor is away, a colleague at the same facility covers their results. An
 * arrangement is active between startsAt and endsAt unless it was cancelled.
 */
const activeAt = (now: Date) =>
  and(
    isNull(coverArrangements.cancelledAt),
    lte(coverArrangements.startsAt, now),
    gt(coverArrangements.endsAt, now),
  );

/** Doctors currently covering for `doctorId` (with names, for notification titles). */
export async function activeCoverDoctorsFor(
  doctorIds: string[],
  executor: Executor = db,
  now = new Date(),
) {
  if (!doctorIds.length) return [];
  return executor
    .select({
      doctorId: coverArrangements.doctorId,
      coverDoctorId: coverArrangements.coverDoctorId,
      doctorName: users.fullName,
    })
    .from(coverArrangements)
    .innerJoin(users, eq(users.id, coverArrangements.doctorId))
    .where(and(inArray(coverArrangements.doctorId, doctorIds), activeAt(now)));
}

/** Doctors that `coverDoctorId` currently covers for. */
export async function doctorsCoveredBy(coverDoctorId: string, executor: Executor = db) {
  const rows = await executor
    .select({ doctorId: coverArrangements.doctorId })
    .from(coverArrangements)
    .where(and(eq(coverArrangements.coverDoctorId, coverDoctorId), activeAt(new Date())));
  return [...new Set(rows.map((r) => r.doctorId))];
}

/**
 * The absent doctor through whom `coverDoctorId` may treat this patient right now: someone they
 * actively cover who is on the patient's care team. Null when there is no such cover.
 */
export async function coverAccessVia(
  coverDoctorId: string,
  patientId: string,
  executor: Executor = db,
): Promise<string | null> {
  const covered = await doctorsCoveredBy(coverDoctorId, executor);
  if (!covered.length) return null;
  const [row] = await executor
    .select({ doctorId: careAssignments.doctorId })
    .from(careAssignments)
    .where(
      and(
        eq(careAssignments.patientId, patientId),
        inArray(careAssignments.doctorId, covered),
        isNull(careAssignments.endedAt),
      ),
    )
    .limit(1);
  return row?.doctorId ?? null;
}
