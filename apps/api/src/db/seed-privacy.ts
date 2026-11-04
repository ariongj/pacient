/**
 * Demo data for data protection (development seed only): default retention policies, three
 * data-subject requests at the facility (one past its 30-day deadline, one answered) and one
 * legal hold. Fictional people only.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from './client.js';
import { dataSubjectRequests, legalHolds, patients, users } from './schema.js';
import { ensureRetentionPolicies } from '../modules/privacy/retention.js';

const DAY = 86_400_000;

export async function seedPrivacy({ facilityId }: { facilityId: string }) {
  await ensureRetentionPolicies();
  const existing = await db
    .select({ id: dataSubjectRequests.id })
    .from(dataSubjectRequests)
    .where(eq(dataSubjectRequests.facilityId, facilityId))
    .limit(1);
  if (existing.length) return;

  const list = await db
    .select({ id: patients.id })
    .from(patients)
    .where(and(eq(patients.primaryFacilityId, facilityId), isNull(patients.mergedIntoId)))
    .orderBy(asc(patients.createdAt))
    .limit(3);
  if (list.length === 0) return;
  const [director] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'DIRECTOR'), eq(users.facilityId, facilityId)))
    .limit(1);

  const now = Date.now();
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY);
  const due = (daysAgo: number) => new Date(now - daysAgo * DAY + 30 * DAY);
  const p = (i: number) => list[i % list.length]!.id;

  await db.insert(dataSubjectRequests).values([
    {
      patientId: p(0),
      facilityId,
      kind: 'ACCESS',
      status: 'RECEIVED',
      details: 'Requests a copy of all data held, including who viewed the record.',
      receivedVia: 'PORTAL',
      receivedAt: at(3),
      dueAt: due(3),
    },
    {
      patientId: p(1),
      facilityId,
      kind: 'OBJECTION',
      status: 'IN_PROGRESS',
      details: 'Objects to the use of contact details for appointment reminders by SMS.',
      receivedVia: 'POST',
      receivedAt: at(34),
      dueAt: due(34),
      handledById: director?.id ?? null,
      createdById: director?.id ?? null,
    },
    {
      patientId: p(2),
      facilityId,
      kind: 'ERASURE',
      status: 'REJECTED',
      details: 'Asks that an old hospital stay be deleted.',
      receivedVia: 'IN_PERSON',
      receivedAt: at(50),
      dueAt: due(50),
      completedAt: at(40),
      outcome:
        'Health records must be kept for the legal retention period (Law on Health); the patient was informed and offered a note of disagreement in the record.',
      handledById: director?.id ?? null,
      createdById: director?.id ?? null,
    },
  ]);
  if (director) {
    await db.insert(legalHolds).values({
      patientId: p(1),
      reason: 'Pending court case – preserve all records until the court releases them.',
      createdById: director.id,
    });
  }
}
