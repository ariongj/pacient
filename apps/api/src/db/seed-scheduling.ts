/** Demo data for scheduling (development seed only): consulting hours, leave, online bookings. */
import { and, eq, ne } from 'drizzle-orm';
import { freeSlots } from '../modules/scheduling/slots.service.js';
import { addDays, localDate, zonedToUtc } from '../modules/scheduling/time.js';
import { db } from './client.js';
import {
  appointments,
  availabilityExceptions,
  doctorAvailability,
  patients,
  users,
} from './schema.js';

const weekdays = [1, 2, 3, 4, 5];

export async function seedScheduling({
  facilityId,
  demoDoctorId,
}: {
  facilityId: string;
  demoDoctorId: string;
}) {
  // Demo doctor: Mon–Fri mornings bookable online, Wednesday afternoon for staff bookings only.
  await db.insert(doctorAvailability).values([
    ...weekdays.map((weekday) => ({
      doctorId: demoDoctorId,
      facilityId,
      weekday,
      startTime: '08:00',
      endTime: '12:00',
      slotMinutes: 20,
      portalBookable: true,
    })),
    {
      doctorId: demoDoctorId,
      facilityId,
      weekday: 3,
      startTime: '14:00',
      endTime: '16:00',
      slotMinutes: 20,
      portalBookable: false,
    },
  ]);

  // A few colleagues with different hours.
  const colleagues = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DOCTOR'), ne(users.id, demoDoctorId)),
    )
    .limit(3);
  const plans = [
    { days: [1, 3, 5], start: '09:00', end: '13:00', slot: 30 },
    { days: [2, 4], start: '12:00', end: '17:00', slot: 20 },
    { days: [1, 2, 3, 4], start: '08:00', end: '11:00', slot: 15 },
  ];
  for (const [i, c] of colleagues.entries()) {
    const plan = plans[i]!;
    await db.insert(doctorAvailability).values(
      plan.days.map((weekday) => ({
        doctorId: c.id,
        facilityId,
        weekday,
        startTime: plan.start,
        endTime: plan.end,
        slotMinutes: plan.slot,
        portalBookable: true,
      })),
    );
  }

  // Training day next week: no slots.
  const today = localDate(new Date());
  let training = addDays(today, 7);
  while (new Date(`${training}T00:00:00Z`).getUTCDay() !== 2) training = addDays(training, 1);
  await db.insert(availabilityExceptions).values({
    doctorId: demoDoctorId,
    startsAt: zonedToUtc(training, '00:00')!,
    endsAt: zonedToUtc(addDays(training, 1), '00:00')!,
    reason: 'Trajnim profesional – Oda e Mjekëve',
    createdById: demoDoctorId,
  });

  // Two online bookings of the demo patient.
  const [demo] = await db
    .select({ id: patients.id, userId: patients.userId })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(eq(users.email, 'patient@pacient.local'));
  if (!demo) return;
  const reasons = ['Kontroll i tensionit të gjakut', 'Diskutim i rezultateve të analizave'];
  for (const [i, offset] of [3, 12].entries()) {
    const from = addDays(today, offset);
    const [slot] = await freeSlots(demoDoctorId, from, addDays(from, 6), { portalOnly: true });
    if (!slot) continue;
    await db.insert(appointments).values({
      patientId: demo.id,
      doctorId: demoDoctorId,
      facilityId,
      scheduledAt: new Date(slot.start),
      durationMinutes: slot.minutes,
      reason: reasons[i]!,
      status: 'CONFIRMED',
      bookedVia: 'PORTAL',
      createdById: demo.userId,
    });
  }
}
