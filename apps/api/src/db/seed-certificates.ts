import { and, eq, ne } from 'drizzle-orm';
import { db } from './client.js';
import { medicalCertificates, patients, users } from './schema.js';
import {
  addDays,
  newVerificationCode,
  nextSerialNumber,
} from '../modules/certificates/certificates.service.js';
import { kosovoDate } from '../modules/identity/identity.service.js';

/** Fixed verification code of the demo patient's latest certificate (development only). */
export const DEMO_CERTIFICATE_CODE = 'demo-certificate-code-not-for-production';

/**
 * Synthetic demo certificates (development seed only): the demo patient has a sick-leave chain
 * with an extension, a revoked certificate and a current fitness certificate with a fixed
 * verification code; her daughter Lea has a school absence; other patients at the facility have
 * sick leave spread over the last months for the director's statistics.
 */
export async function seedCertificates({
  facilityId,
  demoDoctorId,
}: {
  facilityId: string;
  demoDoctorId: string;
}): Promise<void> {
  const [demo] = await db
    .select({ id: patients.id })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(eq(users.email, 'patient@pacient.local'));
  if (!demo) return;
  const today = kosovoDate(new Date());
  const at = (day: string, hour = 9) =>
    new Date(`${day}T${String(hour - 1).padStart(2, '0')}:15:00Z`);

  const issue = async (
    values: Omit<
      typeof medicalCertificates.$inferInsert,
      'facilityId' | 'issuedById' | 'serialNumber' | 'verificationCode'
    > & { verificationCode?: string; issuedAt: Date },
  ) =>
    db.transaction(async (tx) => {
      const serialNumber = await nextSerialNumber(tx, facilityId, kosovoDate(values.issuedAt));
      const [row] = await tx
        .insert(medicalCertificates)
        .values({
          ...values,
          facilityId,
          issuedById: demoDoctorId,
          serialNumber,
          verificationCode: values.verificationCode ?? newVerificationCode(),
        })
        .returning({ id: medicalCertificates.id });
      return row!.id;
    });

  // Demo patient: sick leave for acute bronchitis, extended once.
  const first = await issue({
    patientId: demo.id,
    kind: 'SICK_LEAVE',
    startDate: addDays(today, -25),
    endDate: addDays(today, -16),
    icd10Code: 'J20.9',
    issuedAt: at(addDays(today, -25)),
  });
  await issue({
    patientId: demo.id,
    kind: 'SICK_LEAVE',
    startDate: addDays(today, -15),
    endDate: addDays(today, -9),
    icd10Code: 'J20.9',
    extendsCertificateId: first,
    remarks: 'Kollë e vazhdueshme; kontroll pas një jave.',
    issuedAt: at(addDays(today, -16), 11),
  });
  // A general certificate issued with a wrong purpose and revoked.
  const wrong = await issue({
    patientId: demo.id,
    kind: 'GENERAL',
    startDate: addDays(today, -8),
    purpose: 'Për punëdhënësin',
    issuedAt: at(addDays(today, -8)),
  });
  await db
    .update(medicalCertificates)
    .set({
      status: 'REVOKED',
      revokedAt: at(addDays(today, -8), 10),
      revokedById: demoDoctorId,
      revokeReason: 'Qëllimi i gabuar – u lëshua vërtetim i ri',
    })
    .where(eq(medicalCertificates.id, wrong));
  // Latest: fitness for work after returning, with the fixed demo verification code.
  await issue({
    patientId: demo.id,
    kind: 'FITNESS_FOR_WORK',
    startDate: today,
    endDate: addDays(today, 364),
    outcome: 'FIT',
    purpose: 'Rikthim në punë pas pushimit mjekësor',
    verificationCode: DEMO_CERTIFICATE_CODE,
    issuedAt: new Date(),
  });

  // Her daughter: school absence.
  const [lea] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(and(eq(patients.firstName, 'Lea'), eq(patients.lastName, 'Krasniqi')));
  if (lea) {
    await issue({
      patientId: lea.id,
      kind: 'SCHOOL_ABSENCE',
      startDate: addDays(today, -6),
      endDate: addDays(today, -4),
      icd10Code: 'J06.9',
      issuedAt: at(addDays(today, -6), 10),
    });
  }

  // Other patients: sick leave and fitness certificates over the last months (statistics).
  const others = await db
    .select({ id: patients.id })
    .from(patients)
    .where(and(eq(patients.primaryFacilityId, facilityId), ne(patients.id, demo.id)))
    .limit(10);
  const codes = ['M54.5', 'J11.1', 'K52.9', 'S93.4', 'J06.9', 'M75.1', 'A09', 'J20.9'];
  for (const [i, p] of others.entries()) {
    if (p.id === lea?.id) continue;
    const start = addDays(today, -(20 + i * 17));
    const length = 3 + ((i * 5) % 12);
    await issue({
      patientId: p.id,
      kind: 'SICK_LEAVE',
      startDate: start,
      endDate: addDays(start, length - 1),
      icd10Code: codes[i % codes.length]!,
      issuedAt: at(start, 10),
    });
    if (i % 3 === 0) {
      await issue({
        patientId: p.id,
        kind: i % 2 === 0 ? 'SPORTS_FITNESS' : 'DRIVING_FITNESS',
        startDate: addDays(start, -10),
        endDate: addDays(start, 355),
        outcome: i === 3 ? 'FIT_WITH_RESTRICTIONS' : 'FIT',
        restrictions: i === 3 ? 'Vetëm me syze korrigjuese' : null,
        issuedAt: at(addDays(start, -10), 12),
      });
    }
  }
}
