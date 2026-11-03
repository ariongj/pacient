import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { appointments, guardianships, notifications, patients } from '../src/db/schema.js';
import { runAppointmentRemindersOnce } from '../src/modules/scheduling/reminders.js';
import { freeSlots } from '../src/modules/scheduling/slots.service.js';
import { addDays, localDate, weekdayOf, zonedToUtc } from '../src/modules/scheduling/time.js';
import { api, bearer, createUser, createWorld, login, nextNationalId } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const day = addDays(localDate(new Date()), 7);
const at = (time: string, date = day) => zonedToUtc(date, time)!.toISOString();

const allWeek = (extra: Record<string, unknown> = {}) =>
  [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
    {
      weekday,
      startTime: '08:00',
      endTime: '10:00',
      slotMinutes: 20,
      portalBookable: true,
      ...extra,
    },
    {
      weekday,
      startTime: '14:00',
      endTime: '15:00',
      slotMinutes: 20,
      portalBookable: false,
      ...extra,
    },
  ]);

const slotsFor = async (token: string, doctorId: string, from = day, to = day) => {
  const res = await api()
    .get(`/api/v1/scheduling/slots?doctorId=${doctorId}&from=${from}&to=${to}`)
    .set(bearer(token));
  return res;
};

beforeAll(async () => {
  w = await createWorld();
  const put = await api()
    .put(`/api/v1/scheduling/doctors/${w.users.doctor.id}/availability`)
    .set(bearer(w.tokens.doctor))
    .send({ blocks: allWeek() });
  expect(put.status).toBe(200);
});

describe('time zone handling', () => {
  it('converts local consulting hours to UTC across daylight-saving changes', () => {
    // Clocks go forward on 28 March 2027 (02:00 → 03:00) and back on 31 October 2027.
    expect(zonedToUtc('2027-03-28', '01:00')!.toISOString()).toBe('2027-03-28T00:00:00.000Z');
    expect(zonedToUtc('2027-03-28', '02:20')).toBeNull();
    expect(zonedToUtc('2027-03-28', '03:00')!.toISOString()).toBe('2027-03-28T01:00:00.000Z');
    expect(zonedToUtc('2027-10-31', '02:30')!.toISOString()).toBe('2027-10-31T00:30:00.000Z');
    expect(zonedToUtc('2027-07-01', '08:00')!.toISOString()).toBe('2027-07-01T06:00:00.000Z');
    expect(zonedToUtc('2027-01-15', '08:00')!.toISOString()).toBe('2027-01-15T07:00:00.000Z');
  });

  it('skips the hour that does not exist when clocks go forward', async () => {
    const doc = await createUser('DOCTOR', w.facility.id);
    const t = await login(doc.email);
    const sunday = '2027-03-28';
    expect(weekdayOf(sunday)).toBe(0);
    await api()
      .put(`/api/v1/scheduling/doctors/${doc.id}/availability`)
      .set(bearer(t))
      .send({
        blocks: [
          {
            weekday: 0,
            startTime: '01:00',
            endTime: '04:00',
            slotMinutes: 20,
            validFrom: sunday,
            validUntil: sunday,
          },
        ],
      })
      .expect(200);
    const slots = await freeSlots(doc.id, sunday, sunday);
    expect(slots.map((s) => s.start)).toEqual([
      '2027-03-28T00:00:00.000Z',
      '2027-03-28T00:20:00.000Z',
      '2027-03-28T00:40:00.000Z',
      '2027-03-28T01:00:00.000Z',
      '2027-03-28T01:20:00.000Z',
      '2027-03-28T01:40:00.000Z',
    ]);
  });
});

describe('consulting hours', () => {
  it('can be changed by the doctor, their facility’s director or reception only', async () => {
    const body = { blocks: allWeek() };
    const url = `/api/v1/scheduling/doctors/${w.users.doctor.id}/availability`;
    expect((await api().put(url).set(bearer(w.tokens.colleague)).send(body)).status).toBe(403);
    expect((await api().put(url).set(bearer(w.tokens.otherDirector)).send(body)).status).toBe(403);
    expect((await api().put(url).set(bearer(w.tokens.patient)).send(body)).status).toBe(403);
    expect((await api().put(url).set(bearer(w.tokens.reception)).send(body)).status).toBe(200);
    const get = await api().get(url).set(bearer(w.tokens.director));
    expect(get.status).toBe(200);
    expect(get.body.blocks).toHaveLength(14);
  });

  it('rejects overlapping blocks and invalid times', async () => {
    const url = `/api/v1/scheduling/doctors/${w.users.doctor.id}/availability`;
    const overlap = await api()
      .put(url)
      .set(bearer(w.tokens.doctor))
      .send({
        blocks: [
          { weekday: 1, startTime: '08:00', endTime: '10:00', slotMinutes: 20 },
          { weekday: 1, startTime: '09:30', endTime: '11:00', slotMinutes: 20 },
        ],
      });
    expect(overlap.status).toBe(400);
    const bad = await api()
      .put(url)
      .set(bearer(w.tokens.doctor))
      .send({ blocks: [{ weekday: 1, startTime: '10:00', endTime: '09:00', slotMinutes: 20 }] });
    expect(bad.status).toBe(400);
  });
});

describe('free slots', () => {
  it('subtracts exceptions and existing appointments', async () => {
    const before = await slotsFor(w.tokens.reception, w.users.doctor.id);
    expect(before.status).toBe(200);
    expect(before.body.items).toHaveLength(9); // 6 bookable + 3 staff-only

    const exc = await api()
      .post(`/api/v1/scheduling/doctors/${w.users.doctor.id}/exceptions`)
      .set(bearer(w.tokens.doctor))
      .send({ startsAt: at('08:20'), endsAt: at('09:00'), reason: 'Training' });
    expect(exc.status).toBe(201);
    const appt = await api()
      .post('/api/v1/appointments')
      .set(bearer(w.tokens.doctor))
      .send({ patientId: w.patient.id, scheduledAt: at('09:00'), reason: 'Check-up' });
    expect(appt.status).toBe(201);

    const after = await slotsFor(w.tokens.reception, w.users.doctor.id);
    const starts = after.body.items.map((s: { start: string }) => s.start);
    expect(starts).not.toContain(at('08:20'));
    expect(starts).not.toContain(at('08:40'));
    expect(starts).not.toContain(at('09:00'));
    expect(starts).toContain(at('08:00'));
    expect(starts).toHaveLength(6);

    await api()
      .delete(`/api/v1/scheduling/doctors/${w.users.doctor.id}/exceptions/${exc.body.id}`)
      .set(bearer(w.tokens.doctor))
      .expect(204);
  });

  it('shows patients only bookable slots from tomorrow on', async () => {
    const today = localDate(new Date());
    const res = await slotsFor(w.tokens.patient, w.users.doctor.id, today, addDays(today, 8));
    expect(res.status).toBe(200);
    expect(res.body.from).toBe(addDays(today, 1));
    expect(res.body.items.every((s: { portalBookable: boolean }) => s.portalBookable)).toBe(true);
    expect(
      res.body.items.every((s: { start: string }) => localDate(new Date(s.start)) > today),
    ).toBe(true);
    // Doctors of other facilities (not in the care team) cannot be booked.
    expect((await slotsFor(w.tokens.patient, w.users.outsideDoctor.id)).status).toBe(403);
  });

  it('limits the range to 31 days', async () => {
    const res = await slotsFor(w.tokens.reception, w.users.doctor.id, day, addDays(day, 40));
    expect(res.status).toBe(400);
  });
});

describe('online booking', () => {
  const book = (token: string, start: string, headers: Record<string, string> = {}) =>
    api()
      .post('/api/v1/scheduling/book')
      .set({ ...bearer(token), ...headers })
      .send({ doctorId: w.users.doctor.id, start, reason: 'Kontroll i tensionit' });

  it('gives a contested slot to exactly one patient', async () => {
    const [a, b] = await Promise.all([
      book(w.tokens.patient, at('09:20')),
      book(w.tokens.otherPatient, at('09:20')),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    expect(winner.body).toMatchObject({ status: 'CONFIRMED', bookedVia: 'PORTAL' });
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.doctor.id));
    expect(notes.some((n) => n.title.startsWith('New appointment booked online'))).toBe(true);
  });

  it('refuses staff-only slots and taken slots', async () => {
    expect((await book(w.tokens.patient, at('14:00'))).status).toBe(409);
    expect((await book(w.tokens.patient, at('09:00'))).status).toBe(409);
  });

  it('allows at most three upcoming online bookings', async () => {
    const own = await db
      .select()
      .from(appointments)
      .where(and(eq(appointments.patientId, w.patient.id), eq(appointments.bookedVia, 'PORTAL')));
    const free = (
      await slotsFor(w.tokens.patient, w.users.doctor.id, addDays(day, 1), addDays(day, 1))
    ).body.items as { start: string }[];
    let n = own.length;
    for (const s of free) {
      const res = await book(w.tokens.patient, s.start);
      if (n < 3) {
        expect(res.status).toBe(201);
        n++;
      } else {
        expect(res.status).toBe(409);
        break;
      }
    }
  });

  it('lets a guardian book for a child, also with appointments-only access', async () => {
    const [child] = await db
      .insert(patients)
      .values({
        nationalId: nextNationalId(),
        firstName: 'Lea',
        lastName: 'Test',
        dateOfBirth: '2018-04-02',
        sex: 'FEMALE',
        primaryFacilityId: w.facility.id,
      })
      .returning();
    const parent = await createUser('PATIENT');
    await db.insert(guardianships).values({
      patientId: child!.id,
      guardianUserId: parent.id,
      relationship: 'PARENT',
      scope: 'APPOINTMENTS',
      evidence: 'Birth certificate 12/2018',
      verifiedById: w.users.reception.id,
      validUntil: new Date('2036-04-02T00:00:00Z'),
    });
    const parentToken = await login(parent.email);
    const res = await book(parentToken, at('08:00', addDays(day, 2)), {
      'X-Acting-For': child!.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.patientId).toBe(child!.id);
  });

  it('only lets patients cancel online until two hours before', async () => {
    const [soon] = await db
      .insert(appointments)
      .values({
        patientId: w.patient.id,
        doctorId: w.users.doctor.id,
        facilityId: w.facility.id,
        scheduledAt: new Date(Date.now() + 3_600_000),
        reason: 'Soon',
        status: 'CONFIRMED',
      })
      .returning();
    const res = await api()
      .patch(`/api/v1/appointments/${soon!.id}/status`)
      .set(bearer(w.tokens.patient))
      .send({ status: 'CANCELLED' });
    expect(res.status).toBe(400);
  });
});

describe('reminders', () => {
  it('reminds once, only for confirmed appointments 20–28 hours ahead', async () => {
    const now = new Date();
    const mk = (hours: number, status: 'CONFIRMED' | 'CANCELLED' = 'CONFIRMED') =>
      db
        .insert(appointments)
        .values({
          patientId: w.patient.id,
          doctorId: w.users.colleague.id,
          facilityId: w.facility.id,
          scheduledAt: new Date(now.getTime() + hours * 3_600_000),
          reason: 'Private reason that must not appear',
          status,
        })
        .returning()
        .then((r) => r[0]!);
    const due = await mk(24);
    const later = await mk(40);
    const cancelled = await mk(24, 'CANCELLED');

    expect(await runAppointmentRemindersOnce(now)).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(appointments).where(eq(appointments.id, due.id));
    expect(rows[0]!.reminderSentAt).not.toBeNull();
    for (const id of [later.id, cancelled.id]) {
      const [r] = await db.select().from(appointments).where(eq(appointments.id, id));
      expect(r!.reminderSentAt).toBeNull();
    }
    expect(await runAppointmentRemindersOnce(now)).toBe(0);

    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.patientUser.id));
    const reminders = notes.filter((n) => n.title.startsWith('Reminder: appointment tomorrow'));
    expect(reminders).toHaveLength(1);
    expect(JSON.stringify(reminders)).not.toContain('Private reason');
  });
});
