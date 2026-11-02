/** Demo consent decisions (development seed only). */
import { and, eq, isNull, ne } from 'drizzle-orm';
import { CONSENT_WORDING_VERSION } from '../modules/consent/texts.js';
import { db } from './client.js';
import { careAssignments, consentRecords, patients } from './schema.js';

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

export async function seedConsents({
  demoPatientId,
  demoDoctorId,
}: {
  demoPatientId: string;
  demoDoctorId: string;
}) {
  const [demo] = await db
    .select({ userId: patients.userId, facilityId: patients.primaryFacilityId })
    .from(patients)
    .where(eq(patients.id, demoPatientId));
  if (!demo?.userId) return;

  await db.insert(consentRecords).values([
    {
      patientId: demoPatientId,
      type: 'RESEARCH',
      decision: 'GRANTED',
      method: 'PORTAL',
      wordingVersion: CONSENT_WORDING_VERSION,
      recordedById: demo.userId,
      createdAt: daysAgo(40),
    },
    {
      patientId: demoPatientId,
      type: 'TREATMENT',
      decision: 'GRANTED',
      method: 'IN_PERSON',
      procedure: 'Minor skin excision',
      note: 'Benefits, risks (bleeding, infection, scarring) and alternatives explained; questions answered.',
      wordingVersion: CONSENT_WORDING_VERSION,
      recordedById: demoDoctorId,
      createdAt: daysAgo(12),
    },
  ]);

  // Another patient of the demo doctor withdrew consent to sharing with other facilities, so a
  // referral elsewhere needs a conversation first.
  const [other] = await db
    .select({ id: patients.id, userId: patients.userId })
    .from(careAssignments)
    .innerJoin(patients, eq(patients.id, careAssignments.patientId))
    .where(
      and(
        eq(careAssignments.doctorId, demoDoctorId),
        isNull(careAssignments.endedAt),
        ne(patients.id, demoPatientId),
        eq(patients.primaryFacilityId, demo.facilityId),
      ),
    )
    .limit(1);
  if (!other) return;
  await db.insert(consentRecords).values({
    patientId: other.id,
    type: 'CROSS_FACILITY_SHARING',
    decision: 'WITHDRAWN',
    method: other.userId ? 'PORTAL' : 'IN_PERSON',
    note: other.userId
      ? null
      : 'Patient asked at the clinic that the record stays at this facility.',
    wordingVersion: CONSENT_WORDING_VERSION,
    recordedById: other.userId ?? demoDoctorId,
    createdAt: daysAgo(20),
  });
}
