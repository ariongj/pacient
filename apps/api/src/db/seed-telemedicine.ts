import { eq } from 'drizzle-orm';
import { db } from './client.js';
import { appointments, patients, users, videoSessions } from './schema.js';

/**
 * Demo video visits (development seed only): one for the demo patient starting about 10 minutes
 * after seeding (the room opens 15 minutes before), one tomorrow, and two finished visits.
 */
export async function seedTelemedicine({
  facilityId,
  demoDoctorId,
}: {
  facilityId: string;
  demoDoctorId: string;
}) {
  const [demo] = await db
    .select({ patientId: patients.id })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(eq(users.email, 'patient@pacient.local'));
  if (!demo) return;
  const now = Date.now();
  const minutes = (m: number) => new Date(now + m * 60_000);
  const tomorrow = new Date(now + 86_400_000);
  tomorrow.setUTCHours(9, 40, 0, 0); // 10:40 Kosovo time (winter)

  const base = {
    patientId: demo.patientId,
    doctorId: demoDoctorId,
    facilityId,
    durationMinutes: 20,
    mode: 'VIDEO' as const,
    createdById: demoDoctorId,
  };
  await db.insert(appointments).values([
    {
      ...base,
      scheduledAt: minutes(10),
      reason: 'Kontroll me video: rezultatet e tensionit në shtëpi',
      status: 'CONFIRMED',
      bookedVia: 'PORTAL',
    },
    {
      ...base,
      scheduledAt: tomorrow,
      reason: 'Konsultë me video për recetën',
      status: 'CONFIRMED',
    },
  ]);

  const past = await db
    .insert(appointments)
    .values([
      {
        ...base,
        scheduledAt: minutes(-14 * 24 * 60),
        reason: 'Konsultë me video pas analizave',
        status: 'COMPLETED',
      },
      {
        ...base,
        scheduledAt: minutes(-40 * 24 * 60),
        reason: 'Kontroll me video i tensionit',
        status: 'COMPLETED',
      },
    ])
    .returning({ id: appointments.id, scheduledAt: appointments.scheduledAt });
  await db.insert(videoSessions).values(
    past.map((a) => ({
      appointmentId: a.id,
      status: 'ENDED',
      patientJoinedAt: new Date(a.scheduledAt.getTime() - 2 * 60_000),
      doctorJoinedAt: a.scheduledAt,
      startedAt: a.scheduledAt,
      endedAt: new Date(a.scheduledAt.getTime() + 14 * 60_000),
    })),
  );
}
