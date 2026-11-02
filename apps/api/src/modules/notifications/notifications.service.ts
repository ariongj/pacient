import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { publish } from '../../lib/events.js';
import { careAssignments, notifications, patients, users, type Role } from '../../db/schema.js';

export interface NotificationInput {
  type: string;
  /** Keep generic: never include diagnoses, results or other clinical detail. */
  title: string;
  body?: string;
  link?: string;
}

export async function notifyUsers(
  userIds: (string | null | undefined)[],
  n: NotificationInput,
  executor: Executor = db,
) {
  const ids = [...new Set(userIds.filter((x): x is string => Boolean(x)))];
  if (!ids.length) return;
  await executor.insert(notifications).values(
    ids.map((userId) => ({
      userId,
      type: n.type,
      title: n.title,
      body: n.body ?? null,
      link: n.link ?? null,
    })),
  );
  // Delivered live (after commit when inside a transaction).
  await publish(ids, { type: 'notification' }, executor);
}

/** Notifies the patient's portal account, if they have one. */
export async function notifyPatient(
  patientId: string,
  n: NotificationInput,
  executor: Executor = db,
) {
  const [row] = await executor
    .select({ userId: patients.userId })
    .from(patients)
    .where(eq(patients.id, patientId));
  await notifyUsers([row?.userId], n, executor);
}

export async function notifyCareTeam(
  patientId: string,
  n: NotificationInput,
  executor: Executor = db,
  exceptUserId?: string,
) {
  const rows = await executor
    .select({ doctorId: careAssignments.doctorId })
    .from(careAssignments)
    .where(and(eq(careAssignments.patientId, patientId), isNull(careAssignments.endedAt)));
  await notifyUsers(
    rows.map((r) => r.doctorId).filter((id) => id !== exceptUserId),
    n,
    executor,
  );
}

/** Notifies care-team members of the patient who have the given role (e.g. all nurses). */
export async function notifyCareTeamRole(
  patientId: string,
  role: Role,
  n: NotificationInput,
  executor: Executor = db,
  exceptUserId?: string,
) {
  const rows = await executor
    .select({ id: users.id })
    .from(careAssignments)
    .innerJoin(users, eq(users.id, careAssignments.doctorId))
    .where(
      and(
        eq(careAssignments.patientId, patientId),
        isNull(careAssignments.endedAt),
        eq(users.role, role),
        eq(users.isActive, true),
      ),
    );
  await notifyUsers(
    rows.map((r) => r.id).filter((id) => id !== exceptUserId),
    n,
    executor,
  );
}

/** Notifies all active users with one of the given roles at a facility (e.g. its directors). */
export async function notifyFacilityRole(
  facilityId: string,
  roles: Role[],
  n: NotificationInput,
  executor: Executor = db,
) {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), inArray(users.role, roles), eq(users.isActive, true)),
    );
  await notifyUsers(
    rows.map((r) => r.id),
    n,
    executor,
  );
}
