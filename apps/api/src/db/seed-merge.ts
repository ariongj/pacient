/** Demo data for duplicate-record merging (development seed only). */
import { db } from './client.js';
import { appointments, careAssignments, encounters, patients } from './schema.js';

/**
 * The same man registered twice at the demo facility: once properly, once at the front desk in a
 * hurry with a typo in the surname and a temporary national ID. The director sees the pair under
 * "Duplicate records".
 */
export async function seedMerge({
  facilityId,
  demoDoctorId,
}: {
  facilityId: string;
  demoDoctorId: string;
}) {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
  const [main, duplicate] = await db
    .insert(patients)
    .values([
      {
        nationalId: '1179004120',
        firstName: 'Blerim',
        lastName: 'Gashi',
        dateOfBirth: '1979-04-12',
        sex: 'MALE',
        bloodType: 'A+',
        phone: '+383 44 312 908',
        address: 'Rr. Agim Ramadani 14',
        municipality: 'Prishtinë',
        primaryFacilityId: facilityId,
        createdAt: daysAgo(400),
      },
      {
        nationalId: '9900000417',
        firstName: 'Blerim',
        lastName: 'Gashl',
        dateOfBirth: '1979-04-12',
        sex: 'MALE',
        phone: '044 312 908',
        email: 'blerim.gashi@example.com',
        emergencyContactName: 'Vjosa Gashi',
        emergencyContactPhone: '+383 49 220 114',
        municipality: 'Prishtinë',
        primaryFacilityId: facilityId,
        createdAt: daysAgo(12),
      },
    ])
    .returning();
  await db.insert(careAssignments).values({ patientId: main!.id, doctorId: demoDoctorId });
  await db.insert(encounters).values([
    {
      patientId: main!.id,
      doctorId: demoDoctorId,
      facilityId,
      type: 'OUTPATIENT',
      reason: 'Kontroll vjetor',
      notes: 'Tensioni i gjakut 128/82. Pa ankesa.',
      noteStatus: 'SIGNED',
      signedAt: daysAgo(90),
      startedAt: daysAgo(90),
    },
    {
      patientId: duplicate!.id,
      doctorId: demoDoctorId,
      facilityId,
      type: 'EMERGENCY',
      reason: 'Ndrydhje e kyçit të këmbës (pa termin)',
      notes: 'Ndrydhje e kyçit të këmbës, shkalla I. Pushim, akull, fashim kompresiv.',
      noteStatus: 'SIGNED',
      signedAt: daysAgo(12),
      startedAt: daysAgo(12),
    },
  ]);
  await db.insert(appointments).values({
    patientId: duplicate!.id,
    doctorId: demoDoctorId,
    facilityId,
    scheduledAt: new Date(Date.now() + 5 * 86_400_000),
    reason: 'Kontroll i kyçit të këmbës',
    status: 'CONFIRMED',
  });
}
