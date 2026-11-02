/** Demo data for result cover and critical-result escalation (development seed only). */
import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from './client.js';
import {
  careAssignments,
  coverArrangements,
  labResults,
  resultEscalations,
  users,
} from './schema.js';

export async function seedCover({
  facilityId,
  demoDoctorId,
}: {
  facilityId: string;
  demoDoctorId: string;
}) {
  // A colleague at the same facility who has patients and is away this week.
  const candidates = await db
    .select({ doctorId: users.id, patientId: careAssignments.patientId })
    .from(users)
    .innerJoin(
      careAssignments,
      and(eq(careAssignments.doctorId, users.id), isNull(careAssignments.endedAt)),
    )
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DOCTOR'), ne(users.id, demoDoctorId)),
    )
    .limit(1);
  const pick = candidates[0];
  if (!pick) return;
  const day = 86_400_000;
  const now = Date.now();
  await db.insert(coverArrangements).values({
    doctorId: pick.doctorId,
    coverDoctorId: demoDoctorId,
    facilityId,
    startsAt: new Date(now - day),
    endsAt: new Date(now + 5 * day),
    note: 'Pushim vjetor – ju lutem shqyrtoni rezultatet dhe mesazhet urgjente',
    createdById: pick.doctorId,
  });
  // A critical potassium for one of the colleague's patients, unreviewed for three hours.
  const at = new Date(now - 3 * 3_600_000);
  const [result] = await db
    .insert(labResults)
    .values({
      patientId: pick.patientId,
      orderedById: pick.doctorId,
      testName: 'Potassium',
      testCode: '2823-3',
      value: '6.7',
      unit: 'mmol/L',
      referenceRange: '3.5-5.1',
      flag: 'CRITICAL',
      status: 'FINAL',
      collectedAt: new Date(at.getTime() - 3_600_000),
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  await db.insert(resultEscalations).values([
    {
      labResultId: result!.id,
      level: 1,
      notifiedUserIds: [pick.doctorId, demoDoctorId],
      createdAt: new Date(at.getTime() + 30 * 60_000),
    },
    {
      labResultId: result!.id,
      level: 2,
      notifiedUserIds: [pick.doctorId, demoDoctorId],
      createdAt: new Date(at.getTime() + 120 * 60_000),
    },
  ]);
}
