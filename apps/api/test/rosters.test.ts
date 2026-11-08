import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  auditLogs,
  beds,
  careUnits,
  notifications,
  rosterShifts,
} from '../src/db/schema.js';
import { shiftWindow, toIcs, weekStartOf } from '../src/modules/rosters/rosters.service.js';
import { addDays, localDate } from '../src/modules/scheduling/time.js';
import { api, bearer, createPatient, createUser, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let wardId: string;
const director = () => bearer(w.tokens.director);
const today = () => localDate(new Date());
/** A Monday three weeks ahead, clear of the on-call and staffing tests. */
const week = () => weekStartOf(addDays(today(), 21));

beforeAll(async () => {
  w = await createWorld();
  const [ward] = await db
    .insert(careUnits)
    .values({
      facilityId: w.facility.id,
      name: 'Interna R',
      code: `IR${Math.floor(Math.random() * 1e6)}`,
      type: 'GENERAL_WARD',
    })
    .returning();
  wardId = ward!.id;
});

const plan = (body: Record<string, unknown>, token = w.tokens.director) =>
  api().post('/api/v1/rosters/shifts').set(bearer(token)).send(body);

describe('shift windows', () => {
  it('uses local time, spans midnight and follows the clock changes', () => {
    const night = shiftWindow('2027-01-12', 'NIGHT')!;
    expect((night.endsAt.getTime() - night.startsAt.getTime()) / 3_600_000).toBe(8);
    const onCall = shiftWindow('2027-01-12', 'ON_CALL')!;
    expect((onCall.endsAt.getTime() - onCall.startsAt.getTime()) / 3_600_000).toBe(16);
    // Clocks go forward on 28 March 2027 and back on 31 October 2027 (Europe/Belgrade).
    const spring = shiftWindow('2027-03-27', 'NIGHT')!;
    expect((spring.endsAt.getTime() - spring.startsAt.getTime()) / 3_600_000).toBe(7);
    const autumn = shiftWindow('2027-10-30', 'NIGHT')!;
    expect((autumn.endsAt.getTime() - autumn.startsAt.getTime()) / 3_600_000).toBe(9);
    // 02:30 does not exist on the spring change.
    expect(shiftWindow('2027-03-28', 'DAY', '02:30', '10:00')).toBeNull();
  });

  it('writes a valid iCalendar file', () => {
    const ics = toIcs([
      {
        id: 'x',
        summary: 'Turni i natës, Interna; A',
        location: 'Interna A',
        startsAt: new Date('2027-01-12T22:00:00Z'),
        endsAt: new Date('2027-01-13T06:00:00Z'),
        cancelled: false,
      },
    ]);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('DTSTART:20270112T220000Z\r\n');
    expect(ics).toContain('SUMMARY:Turni i natës\\, Interna\\; A');
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });
});

describe('planning shifts', () => {
  it('plans a shift, refuses overlaps, other facilities and non-directors', async () => {
    const date = addDays(week(), 0);
    const ok = await plan({ userId: w.users.nurse.id, unitId: wardId, kind: 'DAY', date });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ startTime: '07:00', endTime: '15:00', hours: 8 });
    const overlap = await plan({
      userId: w.users.nurse.id,
      kind: 'DAY',
      date,
      startTime: '14:00',
      endTime: '18:00',
    });
    expect(overlap.status).toBe(409);
    // Someone from another facility, a non-doctor on call, a unit of another facility.
    expect(
      (await plan({ userId: w.users.outsideDoctor.id, kind: 'DAY', date: addDays(date, 1) }))
        .status,
    ).toBe(400);
    expect(
      (
        await plan({
          userId: w.users.nurse.id,
          kind: 'ON_CALL',
          specialty: 'INTERNAL_MEDICINE',
          date: addDays(date, 3),
        })
      ).status,
    ).toBe(400);
    expect(
      (await plan({ userId: w.users.nurse.id, kind: 'ON_CALL', date: addDays(date, 3) })).status,
    ).toBe(400);
    // Staff read, but only directors plan; another facility's director cannot touch the shift.
    expect(
      (
        await plan(
          { userId: w.users.nurse.id, kind: 'LATE', date: addDays(date, 2) },
          w.tokens.nurse,
        )
      ).status,
    ).toBe(403);
    const view = await api().get(`/api/v1/rosters/week?start=${date}`).set(bearer(w.tokens.nurse));
    expect(view.status).toBe(200);
    expect(view.body.shifts.map((s: { id: string }) => s.id)).toContain(ok.body.id);
    const outside = await api()
      .get(`/api/v1/rosters/week?start=${date}`)
      .set(bearer(w.tokens.otherDirector));
    expect(outside.body.shifts).toHaveLength(0);
    expect(
      (
        await api()
          .patch(`/api/v1/rosters/shifts/${ok.body.id}`)
          .set(bearer(w.tokens.otherDirector))
          .send({ kind: 'LATE' })
      ).status,
    ).toBe(404);
    expect((await api().get('/api/v1/rosters/week').set(bearer(w.tokens.patient))).status).toBe(
      403,
    );
    // A time that does not exist on the clock change.
    expect(
      (
        await plan({
          userId: w.users.pharmacist.id,
          kind: 'DAY',
          date: '2027-03-28',
          startTime: '02:30',
          endTime: '10:00',
        })
      ).status,
    ).toBe(400);
  });

  it('warns about short rest and lets the director confirm with a reason', async () => {
    const date = addDays(week(), 4);
    expect(
      (await plan({ userId: w.users.nurse.id, unitId: wardId, kind: 'DAY', date })).status,
    ).toBe(201);
    // Night the same day: 8 hours of rest.
    const night = { userId: w.users.nurse.id, unitId: wardId, kind: 'NIGHT', date };
    const warned = await plan(night);
    expect(warned.status).toBe(409);
    expect(warned.body.error.code).toBe('WORKING_TIME_WARNINGS');
    expect(warned.body.error.details[0]).toMatchObject({
      code: 'REST_PERIOD',
      hours: 8,
      limit: 11,
    });
    const noReason = await plan({ ...night, acknowledgedWarnings: ['REST_PERIOD'] });
    expect(noReason.status).toBe(409);
    const confirmed = await plan({
      ...night,
      acknowledgedWarnings: ['REST_PERIOD'],
      overrideReason: 'Sickness cover, agreed with the nurse',
    });
    expect(confirmed.status).toBe(201);
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'roster.changed'), eq(auditLogs.resourceId, confirmed.body.id)),
      );
    expect(entry!.metadata).toMatchObject({
      warnings: ['REST_PERIOD'],
      overrideReason: 'Sickness cover, agreed with the nurse',
    });
  });

  it('warns about more than 48 hours a week and copies a week', async () => {
    const person = await createUser('NURSE', w.facility.id);
    const start = addDays(week(), 7);
    const body = {
      mode: 'PATTERN',
      userId: person.id,
      unitId: wardId,
      weekStart: start,
      pattern: ['DAY', 'DAY', 'DAY', 'DAY', 'DAY', 'DAY', 'DAY'],
    };
    const warned = await api().post('/api/v1/rosters/bulk').set(director()).send(body);
    expect(warned.status).toBe(409);
    expect(warned.body.error.details.some((d: { code: string }) => d.code === 'WEEKLY_HOURS')).toBe(
      true,
    );
    const ok = await api()
      .post('/api/v1/rosters/bulk')
      .set(director())
      .send({
        ...body,
        acknowledgedWarnings: ['WEEKLY_HOURS'],
        overrideReason: 'Winter pressure week',
      });
    expect(ok.status).toBe(201);
    expect(ok.body.created).toBe(7);
    // The same pattern again overlaps everything: nothing is created.
    const again = await api()
      .post('/api/v1/rosters/bulk')
      .set(director())
      .send({
        ...body,
        acknowledgedWarnings: ['WEEKLY_HOURS'],
        overrideReason: 'Winter pressure week',
      });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('SHIFT_OVERLAP');
    // Copy the ward's week to the following week.
    const copy = await api()
      .post('/api/v1/rosters/bulk')
      .set(director())
      .send({
        mode: 'COPY',
        fromWeekStart: start,
        weekStart: addDays(start, 7),
        unitId: wardId,
        acknowledgedWarnings: ['WEEKLY_HOURS'],
        overrideReason: 'Same pattern next week',
      });
    expect(copy.status).toBe(201);
    expect(copy.body.created).toBe(7);
    expect(copy.body.items[0]).toMatchObject({ startTime: '07:00', date: addDays(start, 7) });
    expect(
      (
        await api()
          .post('/api/v1/rosters/bulk')
          .set(director())
          .send({ ...body, weekStart: addDays(start, 1) })
      ).status,
    ).toBe(400);
  });
});

describe('publishing', () => {
  it('sends one summary per person and later only the change to the person concerned', async () => {
    const start = addDays(week(), 28);
    const nurse = await createUser('NURSE', w.facility.id);
    const doctor = await createUser('DOCTOR', w.facility.id);
    const ids: string[] = [];
    for (const i of [0, 2, 4]) {
      const r = await plan({
        userId: nurse.id,
        unitId: wardId,
        kind: 'DAY',
        date: addDays(start, i),
      });
      expect(r.status).toBe(201);
      ids.push(r.body.id);
    }
    expect(
      (
        await plan({
          userId: doctor.id,
          kind: 'ON_CALL',
          specialty: 'CARDIOLOGY',
          date: addDays(start, 1),
        })
      ).status,
    ).toBe(201);
    const count = async (userId: string) =>
      (
        await db
          .select()
          .from(notifications)
          .where(and(eq(notifications.userId, userId), eq(notifications.type, 'roster')))
      ).length;
    // Planning before publishing tells nobody.
    expect(await count(nurse.id)).toBe(0);
    const published = await api()
      .post('/api/v1/rosters/publish')
      .set(director())
      .send({ weekStart: start });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ notified: 2, shifts: 4 });
    expect(await count(nurse.id)).toBe(1);
    expect(await count(doctor.id)).toBe(1);
    const [summary] = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, nurse.id), eq(notifications.type, 'roster')));
    expect(summary!.title).toContain('3 shifts');
    // A change after publishing tells only that person.
    const cancel = await api()
      .post(`/api/v1/rosters/shifts/${ids[1]}/cancel`)
      .set(director())
      .send({ reason: 'Training day' });
    expect(cancel.status).toBe(200);
    expect(await count(nurse.id)).toBe(2);
    expect(await count(doctor.id)).toBe(1);
    expect(
      (
        await api()
          .post(`/api/v1/rosters/shifts/${ids[1]}/cancel`)
          .set(director())
          .send({ reason: 'Again' })
      ).status,
    ).toBe(409);
    const view = await api().get(`/api/v1/rosters/week?start=${start}`).set(director());
    expect(view.body.publications).toHaveLength(1);
    expect(
      (
        await api()
          .post('/api/v1/rosters/publish')
          .set(director())
          .send({ weekStart: addDays(start, 2) })
      ).status,
    ).toBe(400);
  });

  it('gives each person their own shifts and an iCalendar file', async () => {
    const mine = await api()
      .get(`/api/v1/rosters/mine?from=${week()}&to=${addDays(week(), 6)}`)
      .set(bearer(w.tokens.nurse));
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThanOrEqual(3);
    expect(mine.body.items.every((s: { userId: string }) => s.userId === w.users.nurse.id)).toBe(
      true,
    );
    const ics = await api().get('/api/v1/rosters/mine.ics').set(bearer(w.tokens.nurse));
    expect(ics.status).toBe(200);
    expect(ics.headers['content-type']).toMatch(/text\/calendar/);
    expect(ics.text).toContain('BEGIN:VEVENT');
    expect(ics.text).toContain('\r\n');
    expect((await api().get('/api/v1/rosters/mine.ics')).status).toBe(401);
  });
});

describe('on call and staffing', () => {
  it('shows who is on call now and next, also across midnight', async () => {
    const now = Date.now();
    const doctor2 = await createUser('DOCTOR', w.facility.id);
    await db.insert(rosterShifts).values([
      {
        facilityId: w.facility.id,
        userId: w.users.colleague.id,
        kind: 'ON_CALL',
        specialty: 'GENERAL_SURGERY',
        startsAt: new Date(now - 10 * 3_600_000),
        endsAt: new Date(now + 6 * 3_600_000),
        createdById: w.users.director.id,
      },
      {
        facilityId: w.facility.id,
        userId: doctor2.id,
        kind: 'ON_CALL',
        specialty: 'GENERAL_SURGERY',
        startsAt: new Date(now + 6 * 3_600_000),
        endsAt: new Date(now + 22 * 3_600_000),
        createdById: w.users.director.id,
      },
      {
        // Cancelled cover is ignored.
        facilityId: w.facility.id,
        userId: w.users.doctor.id,
        kind: 'ON_CALL',
        specialty: 'PAEDIATRICS',
        startsAt: new Date(now - 3_600_000),
        endsAt: new Date(now + 3_600_000),
        status: 'CANCELLED',
        createdById: w.users.director.id,
      },
    ]);
    const res = await api().get('/api/v1/rosters/on-call').set(bearer(w.tokens.nurse));
    expect(res.status).toBe(200);
    const surgery = res.body.items.find(
      (i: { specialty: string }) => i.specialty === 'GENERAL_SURGERY',
    );
    expect(surgery.current.map((c: { userId: string }) => c.userId)).toEqual([
      w.users.colleague.id,
    ]);
    expect(surgery.next.userId).toBe(doctor2.id);
    const other = await api().get('/api/v1/rosters/on-call').set(bearer(w.tokens.otherDirector));
    expect(
      other.body.items.find((i: { specialty: string }) => i.specialty === 'GENERAL_SURGERY'),
    ).toBeUndefined();
  });

  it('compares rostered nurses with occupied beds and lists gaps', async () => {
    for (let i = 1; i <= 4; i++) await db.insert(beds).values({ unitId: wardId, label: `R${i}` });
    for (let i = 0; i < 3; i++) {
      const p = await createPatient(w.facility.id);
      await db.insert(admissions).values({
        patientId: p.id,
        facilityId: w.facility.id,
        unitId: wardId,
        admittingDoctorId: w.users.doctor.id,
        attendingDoctorId: w.users.doctor.id,
        source: 'ELECTIVE',
        reason: 'Pneumoni',
      });
    }
    const day = await plan({
      userId: w.users.nurse.id,
      unitId: wardId,
      kind: 'DAY',
      date: today(),
      acknowledgedWarnings: ['REST_PERIOD', 'WEEKLY_HOURS'],
      overrideReason: 'Test staffing scenario',
    });
    expect([201, 409]).toContain(day.status);
    const res = await api().get('/api/v1/rosters/staffing').set(director());
    expect(res.status).toBe(200);
    const ward = res.body.wards.find((x: { unitId: string }) => x.unitId === wardId);
    expect(ward).toMatchObject({ beds: 4, occupied: 3, threshold: 8 });
    expect(ward.shifts.DAY).toMatchObject({ nurses: 1, ratio: 3, over: false });
    expect(ward.shifts.NIGHT).toMatchObject({ nurses: 0, ratio: null, over: true });
    const strict = await api().get('/api/v1/rosters/staffing?ratioGeneral=2').set(director());
    expect(
      strict.body.wards.find((x: { unitId: string }) => x.unitId === wardId).shifts.DAY.over,
    ).toBe(true);
    expect(res.body.gaps).toContainEqual({
      type: 'NO_NIGHT_NURSE',
      date: today(),
      unitId: wardId,
      unitName: 'Interna R',
    });
    // General surgery has cover tonight only until about 22 hours from now; later nights are gaps.
    expect(
      res.body.gaps.some(
        (g: { type: string; specialty?: string }) =>
          g.type === 'NO_ON_CALL' && g.specialty === 'GENERAL_SURGERY',
      ),
    ).toBe(true);
    expect((await api().get('/api/v1/rosters/staffing').set(bearer(w.tokens.nurse))).status).toBe(
      403,
    );
  });
});
