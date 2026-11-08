import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  beds,
  careUnits,
  dialysisSchedules,
  dialysisSessions,
  unitStaff,
} from '../src/db/schema.js';
import { AuditAction } from '../src/modules/audit/audit.service.js';
import {
  addDays,
  adequacyOf,
  daugirdasKtV,
  interdialyticGain,
  kosovoDate,
  planSessions,
  urr,
  weekdayOf,
  type SessionRow,
} from '../src/modules/dialysis/dialysis.service.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let unitId: string;
let smallUnitId: string;
let otherUnitId: string;
let unitDoctorToken: string;
let unitNurseToken: string;
const today = kosovoDate(new Date());

async function unit(facilityId: string, name: string, stations: number) {
  const [u] = await db
    .insert(careUnits)
    .values({
      facilityId,
      name,
      code: `DI${Math.floor(Math.random() * 1e8)}`,
      type: 'DIALYSIS',
    })
    .returning();
  if (stations) {
    await db
      .insert(beds)
      .values(Array.from({ length: stations }, (_, i) => ({ unitId: u!.id, label: `S${i + 1}` })));
  }
  return u!.id;
}

const ALL_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function schedule(token: string, patientId: string, body: Record<string, unknown> = {}) {
  return api()
    .post(`/api/v1/dialysis/patients/${patientId}/schedules`)
    .set(bearer(token))
    .send({
      unitId,
      days: ALL_DAYS,
      shift: 'MORNING',
      targetWeightKg: 70,
      vascularAccess: 'FISTULA',
      ...body,
    });
}

async function todaysSession(patientId: string) {
  const [s] = await db
    .select()
    .from(dialysisSessions)
    .where(and(eq(dialysisSessions.patientId, patientId), eq(dialysisSessions.sessionDate, today)));
  return s!;
}

beforeAll(async () => {
  w = await createWorld();
  unitId = await unit(w.facility.id, 'Dializa – test', 6);
  smallUnitId = await unit(w.facility.id, 'Dializa e vogël', 1);
  otherUnitId = await unit(w.otherFacility.id, 'Dializa tjetër', 4);
  const unitDoctor = await createUser('DOCTOR', w.facility.id);
  const unitNurse = await createUser('NURSE', w.facility.id);
  unitDoctorToken = await login(unitDoctor.email);
  unitNurseToken = await login(unitNurse.email);
  await db.insert(unitStaff).values([
    { unitId, userId: unitDoctor.id },
    { unitId, userId: unitNurse.id },
    { unitId: smallUnitId, userId: unitDoctor.id },
  ]);
});

describe('adequacy and weight helpers', () => {
  it('computes URR and the Daugirdas spKt/V (worked example)', () => {
    // Urea 100 → 30 mg/dl over 4 h, 3 l removed, 70 kg after dialysis.
    expect(urr(100, 30)).toBeCloseTo(70, 5);
    // −ln(0.3 − 0.032) + (4 − 1.05) × 3 / 70 = 1.3168 + 0.1264
    expect(
      daugirdasKtV({ preUrea: 100, postUrea: 30, hours: 4, ultrafiltrationL: 3, postWeightKg: 70 }),
    ).toBeCloseTo(1.443, 3);
    expect(() =>
      daugirdasKtV({ preUrea: 100, postUrea: 2, hours: 4, ultrafiltrationL: 0, postWeightKg: 70 }),
    ).toThrow();
  });

  it('uses the recorded duration, falls back to URR when Kt/V cannot be computed', () => {
    const base = {
      preUrea: '100',
      postUrea: '30',
      startedAt: new Date('2026-03-02T07:00:00Z'),
      endedAt: new Date('2026-03-02T11:00:00Z'),
      ultrafiltrationMl: 3000,
      postWeightKg: '70',
    } as unknown as SessionRow;
    expect(adequacyOf(base, null)).toEqual({ urr: 70, ktv: 1.44, meetsTarget: true });
    const short = { ...base, postUrea: '50', endedAt: new Date('2026-03-02T09:00:00Z') };
    expect(adequacyOf(short as SessionRow, null).meetsTarget).toBe(false);
    const noWeight = { ...base, postWeightKg: null, startedAt: null, endedAt: null };
    expect(adequacyOf(noWeight as SessionRow, 240)).toEqual({
      urr: 70,
      ktv: null,
      meetsTarget: true,
    });
    expect(adequacyOf({ ...base, preUrea: null } as SessionRow, 240).urr).toBeNull();
  });

  it('warns about an interdialytic weight gain above 4% of the target weight', () => {
    expect(interdialyticGain(73, 70.5, 70)).toEqual({ gainKg: 2.5, percent: 3.6, warning: false });
    expect(interdialyticGain(73.5, 70.5, 70)).toEqual({ gainKg: 3, percent: 4.3, warning: true });
    expect(interdialyticGain(73, null, 70)).toBeNull();
  });

  it('knows the weekday of a date', () => {
    expect(weekdayOf('2026-03-02')).toBe('MON');
    expect(weekdayOf('2026-03-08')).toBe('SUN');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('schedules', () => {
  it('lets unit doctors and care-team doctors start a schedule, nurses and outsiders not', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    expect((await schedule(unitNurseToken, p.id)).status).toBe(403);
    expect((await schedule(w.tokens.colleague, p.id)).status).toBe(403);
    expect((await schedule(w.tokens.outsideDoctor, p.id)).status).toBe(403);
    expect((await schedule(unitDoctorToken, p.id, { unitId: otherUnitId })).status).toBe(403);
    const res = await schedule(w.tokens.doctor, p.id);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('ACTIVE');
    // Only one active schedule per patient.
    expect((await schedule(unitDoctorToken, p.id)).status).toBe(409);
    const [log] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, AuditAction.DIALYSIS_SCHEDULE_CHANGED),
          eq(auditLogs.resourceId, res.body.id),
        ),
      );
    expect(log).toBeDefined();
  });

  it('plans 14 days ahead, idempotently', async () => {
    const p = await createPatient(w.facility.id);
    const res = await schedule(unitDoctorToken, p.id, { days: ['MON', 'WED', 'FRI'] });
    expect(res.status).toBe(201);
    const planned = await db
      .select()
      .from(dialysisSessions)
      .where(eq(dialysisSessions.scheduleId, res.body.id));
    expect(planned.length).toBe(6);
    expect(planned.every((s) => ['MON', 'WED', 'FRI'].includes(weekdayOf(s.sessionDate)))).toBe(
      true,
    );
    expect(await planSessions({ scheduleId: res.body.id })).toBe(0);
    expect(await planSessions({ scheduleId: res.body.id, today: addDays(today, 7) })).toBe(3);
  });

  it('refuses a full shift and counts only active schedules of that shift', async () => {
    const a = await createPatient(w.facility.id);
    const b = await createPatient(w.facility.id);
    const first = await schedule(unitDoctorToken, a.id, {
      unitId: smallUnitId,
      days: ['MON', 'WED'],
    });
    expect(first.status).toBe(201);
    const full = await schedule(unitDoctorToken, b.id, {
      unitId: smallUnitId,
      days: ['WED', 'THU'],
    });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe('SHIFT_FULL');
    expect(full.body.error.details.map((d: { message: string }) => d.message)).toEqual(['WED']);
    // Another shift or other days are free.
    const afternoon = await schedule(unitDoctorToken, b.id, {
      unitId: smallUnitId,
      days: ['WED'],
      shift: 'AFTERNOON',
    });
    expect(afternoon.status).toBe(201);
    // Ending a schedule frees the station.
    const ended = await api()
      .post(`/api/v1/dialysis/schedules/${first.body.id}/end`)
      .set(bearer(unitDoctorToken))
      .send({ reason: 'TRANSPLANT' });
    expect(ended.status).toBe(200);
    expect(ended.body.endReason).toBe('TRANSPLANT');
    const moved = await api()
      .patch(`/api/v1/dialysis/schedules/${afternoon.body.id}`)
      .set(bearer(unitDoctorToken))
      .send({ shift: 'MORNING' });
    expect(moved.status).toBe(200);
    const future = await db
      .select()
      .from(dialysisSessions)
      .where(eq(dialysisSessions.scheduleId, first.body.id));
    expect(future.every((s) => s.sessionDate < today || s.status === 'CANCELLED')).toBe(true);
  });

  it('requires a reason text for OTHER and refuses ending twice', async () => {
    const p = await createPatient(w.facility.id);
    const s = await schedule(unitDoctorToken, p.id, { days: ['TUE'] });
    const end = (body: object) =>
      api()
        .post(`/api/v1/dialysis/schedules/${s.body.id}/end`)
        .set(bearer(unitDoctorToken))
        .send(body);
    expect((await end({ reason: 'OTHER' })).status).toBe(400);
    expect((await end({ reason: 'OTHER', note: 'Shpërngulje jashtë vendit' })).status).toBe(200);
    expect((await end({ reason: 'RECOVERED' })).status).toBe(409);
  });
});

describe('sessions', () => {
  let patientId: string;
  beforeAll(async () => {
    const p = await createPatient(w.facility.id);
    patientId = p.id;
    expect((await schedule(unitDoctorToken, patientId)).status).toBe(201);
    // A previous session two days ago ended at 70.5 kg.
    const [prevSchedule] = await db
      .select()
      .from(dialysisSchedules)
      .where(eq(dialysisSchedules.patientId, patientId));
    await db.insert(dialysisSessions).values({
      patientId,
      unitId,
      scheduleId: prevSchedule!.id,
      sessionDate: addDays(today, -2),
      status: 'COMPLETED',
      postWeightKg: '70.5',
    });
  });

  it('records start and end with weight gain, blood pressure and adequacy', async () => {
    const s = await todaysSession(patientId);
    expect(s.status).toBe('PLANNED');
    const start = await api()
      .post(`/api/v1/dialysis/sessions/${s.id}/start`)
      .set(bearer(unitNurseToken))
      .send({ machine: 'S3', preWeightKg: 74, preSystolic: 185, preDiastolic: 95 });
    expect(start.status).toBe(200);
    expect(start.body.status).toBe('IN_PROGRESS');
    expect(start.body.interdialyticGainKg).toBe(3.5);
    const codes = start.body.warnings.map((x: { code: string }) => x.code);
    expect(codes).toContain('IDWG_HIGH');
    expect(codes).toContain('PRE_BP_HIGH');
    // Starting twice is refused.
    expect(
      (
        await api()
          .post(`/api/v1/dialysis/sessions/${s.id}/start`)
          .set(bearer(unitNurseToken))
          .send({ machine: 'S3', preWeightKg: 74, preSystolic: 150, preDiastolic: 85 })
      ).status,
    ).toBe(409);
    const startedAt = new Date(Date.now() - 4 * 3_600_000);
    await db.update(dialysisSessions).set({ startedAt }).where(eq(dialysisSessions.id, s.id));
    const endBody = {
      postWeightKg: 70,
      postSystolic: 130,
      postDiastolic: 80,
      ultrafiltrationMl: 3000,
      preUrea: 25, // mmol/l
      postUrea: 7.5,
      complications: ['CRAMPS'],
    };
    expect(
      (
        await api()
          .post(`/api/v1/dialysis/sessions/${s.id}/end`)
          .set(bearer(unitNurseToken))
          .send({ ...endBody, postUrea: 30 })
      ).status,
    ).toBe(400);
    expect(
      (
        await api()
          .post(`/api/v1/dialysis/sessions/${s.id}/end`)
          .set(bearer(unitNurseToken))
          .send({ ...endBody, complications: ['OTHER'] })
      ).status,
    ).toBe(400);
    const end = await api()
      .post(`/api/v1/dialysis/sessions/${s.id}/end`)
      .set(bearer(unitNurseToken))
      .send(endBody);
    expect(end.status).toBe(200);
    expect(end.body.status).toBe('COMPLETED');
    expect(end.body.adequacy.urr).toBe(70);
    expect(end.body.adequacy.ktv).toBeCloseTo(1.44, 1);
    expect(end.body.adequacy.meetsTarget).toBe(true);
    expect(end.body.complications).toEqual(['CRAMPS']);
    const logs = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, AuditAction.DIALYSIS_SESSION_RECORDED),
          eq(auditLogs.resourceId, s.id),
        ),
      );
    expect(logs.length).toBe(2);
  });

  it('adds late urea results to a completed session only', async () => {
    const s = await todaysSession(patientId);
    const res = await api()
      .patch(`/api/v1/dialysis/sessions/${s.id}/urea`)
      .set(bearer(unitNurseToken))
      .send({ preUrea: 22, postUrea: 8 });
    expect(res.status).toBe(200);
    expect(res.body.adequacy.urr).toBeCloseTo(63.6, 1);
  });

  it('marks a planned session missed, not a future one, and keeps outsiders out', async () => {
    const p = await createPatient(w.facility.id);
    await schedule(unitDoctorToken, p.id);
    const s = await todaysSession(p.id);
    const [future] = await db
      .select()
      .from(dialysisSessions)
      .where(
        and(
          eq(dialysisSessions.patientId, p.id),
          eq(dialysisSessions.sessionDate, addDays(today, 1)),
        ),
      );
    const missed = (id: string, token: string) =>
      api()
        .post(`/api/v1/dialysis/sessions/${id}/missed`)
        .set(bearer(token))
        .send({ reason: 'Nuk erdhi, i sëmurë' });
    expect((await missed(future!.id, unitNurseToken)).status).toBe(409);
    expect((await missed(s.id, w.tokens.nurse)).status).toBe(403);
    expect((await missed(s.id, w.tokens.outsideDoctor)).status).toBe(403);
    const ok = await missed(s.id, unitNurseToken);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('MISSED');
  });
});

describe('board, chart and statistics', () => {
  it('shows the board and patient list to unit staff only', async () => {
    const board = await api()
      .get(`/api/v1/dialysis/units/${unitId}/board`)
      .set(bearer(unitNurseToken));
    expect(board.status).toBe(200);
    const morning = board.body.shifts.find((s: { shift: string }) => s.shift === 'MORNING');
    expect(morning.stations).toBe(6);
    expect(morning.items.length).toBeGreaterThan(0);
    expect(morning.items[0].patient.lastName).toBeDefined();
    expect(
      (await api().get(`/api/v1/dialysis/units/${unitId}/board`).set(bearer(w.tokens.nurse)))
        .status,
    ).toBe(403);
    const list = await api()
      .get(`/api/v1/dialysis/units/${unitId}/patients`)
      .set(bearer(unitDoctorToken));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(2);
    const units = await api().get('/api/v1/dialysis/units').set(bearer(unitNurseToken));
    expect(units.body.items.find((u: { id: string }) => u.id === unitId).isStaff).toBe(true);
  });

  it('gives the chart section to the care team, audited', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await schedule(w.tokens.doctor, p.id);
    const res = await api().get(`/api/v1/dialysis/patients/${p.id}`).set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    expect(res.body.schedules).toHaveLength(1);
    expect(res.body.canSchedule).toBe(false);
    expect(res.body.targets).toEqual({ ktv: 1.2, urr: 65 });
    // Unit staff have access while the schedule is active.
    expect(
      (await api().get(`/api/v1/dialysis/patients/${p.id}`).set(bearer(unitNurseToken))).status,
    ).toBe(200);
    expect(
      (await api().get(`/api/v1/dialysis/patients/${p.id}`).set(bearer(w.tokens.outsideDoctor)))
        .status,
    ).toBe(403);
    expect(
      (await api().get(`/api/v1/dialysis/patients/${p.id}`).set(bearer(w.tokens.director))).status,
    ).toBe(403);
  });

  it('gives directors exact figures and the Ministry suppressed ones', async () => {
    const director = await api().get('/api/v1/dialysis/stats').set(bearer(w.tokens.director));
    expect(director.status).toBe(200);
    expect(director.body.scope).toBe('FACILITY');
    const mine = director.body.items.find(
      (i: { facilityId: string }) => i.facilityId === w.facility.id,
    );
    expect(mine.patientsOnDialysis).toBeGreaterThan(0);
    expect(mine.completed90).toBe(2);
    expect(
      director.body.items.some((i: { facilityId: string }) => i.facilityId === w.otherFacility.id),
    ).toBe(false);
    const ministry = await api().get('/api/v1/dialysis/stats').set(bearer(w.tokens.ministry));
    expect(ministry.status).toBe(200);
    const national = ministry.body.items.find(
      (i: { facilityId: string }) => i.facilityId === w.facility.id,
    );
    expect(national.completed90).toBeNull(); // 2 sessions: hidden
    expect(national.meetingTargetPercent).toBeNull();
    expect((await api().get('/api/v1/dialysis/stats').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
  });
});
