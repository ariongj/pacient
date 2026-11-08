import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careUnits,
  guardianships,
  homeVisits,
  notifications,
  patients,
  unitStaff,
  vitalSigns,
} from '../src/db/schema.js';
import {
  parseCarePlan,
  scheduleTimes,
  serialiseCarePlan,
} from '../src/modules/homecare/homecare.service.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let teamId: string;
let otherTeamId: string;
let teamNurse2: Awaited<ReturnType<typeof createUser>>;
let teamNurse2Token: string;
let outsiderNurseToken: string;
const doctor = () => bearer(w.tokens.doctor);
const nurse = () => bearer(w.tokens.nurse);
const HOUR = 3_600_000;

async function team(facilityId: string, name: string) {
  const [u] = await db
    .insert(careUnits)
    .values({
      facilityId,
      name,
      code: `HC${Math.floor(Math.random() * 1e8)}`,
      type: 'COMMUNITY_NURSING',
    })
    .returning();
  return u!.id;
}

async function refer(patientId: string, body: Record<string, unknown> = {}) {
  return api()
    .post(`/api/v1/home-care/patients/${patientId}/episodes`)
    .set(doctor())
    .send({
      teamUnitId: teamId,
      reason: 'Plagë pas operacionit',
      tasks: ['WOUND_CARE', 'MEDICATION'],
      goals: 'Shërimi i plagës',
      visitAddress: 'Rr. Agim Ramadani 12, Prishtinë',
      accessNotes: 'Kati 2, zilja e majtë',
      ...body,
    });
}

beforeAll(async () => {
  w = await createWorld();
  teamId = await team(w.facility.id, 'Kujdesi në shtëpi – test');
  otherTeamId = await team(w.otherFacility.id, 'Ekipi tjetër');
  teamNurse2 = await createUser('NURSE', w.facility.id);
  teamNurse2Token = await login(teamNurse2.email);
  const outsider = await createUser('NURSE', w.facility.id);
  outsiderNurseToken = await login(outsider.email);
  await db.insert(unitStaff).values([
    { unitId: teamId, userId: w.users.nurse.id },
    { unitId: teamId, userId: teamNurse2.id },
  ]);
});

describe('care plan and schedule helpers', () => {
  it('stores the care plan as goals and tasks and reads plain text as goals', () => {
    expect(
      parseCarePlan(serialiseCarePlan({ goals: ' Mobilizim ', tasks: ['WOUND_CARE'] })),
    ).toEqual({
      goals: 'Mobilizim',
      tasks: ['WOUND_CARE'],
    });
    expect(parseCarePlan('Vetëm tekst')).toEqual({ goals: 'Vetëm tekst', tasks: [] });
    expect(parseCarePlan(null)).toEqual({ goals: '', tasks: [] });
  });

  it('plans recurring visits keeping the local time', () => {
    const start = new Date('2026-03-27T08:00:00Z'); // 09:00 in Kosovo, the weekend DST starts
    expect(scheduleTimes(start, 'ONCE', 4)).toHaveLength(1);
    const daily = scheduleTimes(start, 'DAILY', 1);
    expect(daily).toHaveLength(7);
    // After the change to summer time 09:00 local is 07:00 UTC.
    expect(daily[3]!.toISOString()).toBe('2026-03-30T07:00:00.000Z');
    expect(scheduleTimes(start, 'TWICE_WEEKLY', 2)).toHaveLength(4);
    expect(scheduleTimes(start, 'WEEKLY', 3)).toHaveLength(3);
  });
});

describe('referral', () => {
  it('lets a doctor of the care team refer to a team of the facility, once per team', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const byNurse = await api()
      .post(`/api/v1/home-care/patients/${p.id}/episodes`)
      .set(nurse())
      .send({ teamUnitId: teamId, reason: 'x', tasks: ['WOUND_CARE'] });
    expect(byNurse.status).toBe(403);
    expect(
      (
        await api()
          .post(`/api/v1/home-care/patients/${p.id}/episodes`)
          .set(bearer(w.tokens.outsideDoctor))
          .send({ teamUnitId: teamId, reason: 'Plagë', tasks: ['WOUND_CARE'], visitAddress: 'X 1' })
      ).status,
    ).toBe(403);
    expect((await refer(p.id, { tasks: [] })).status).toBe(400);
    expect((await refer(p.id, { visitAddress: undefined })).status).toBe(400); // no address on file
    expect((await refer(p.id, { teamUnitId: otherTeamId })).status).toBe(400);

    const res = await refer(p.id);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('REFERRED');
    expect(parseCarePlan(res.body.carePlan).tasks).toEqual(['WOUND_CARE', 'MEDICATION']);
    expect((await refer(p.id)).status).toBe(409);

    const told = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, teamNurse2.id));
    expect(told.some((n) => n.link === `/home-care?episode=${res.body.id}`)).toBe(true);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'homecare.changed'), eq(auditLogs.resourceId, res.body.id)));
    expect(audit).toHaveLength(1);
  });

  it('allows a team of the patient’s registered facility (hospital discharge)', async () => {
    const hospitalDoctor = await createUser('DOCTOR', w.otherFacility.id);
    const p = await createPatient(w.facility.id, { doctorId: hospitalDoctor.id });
    const token = await login(hospitalDoctor.email);
    const res = await api()
      .post(`/api/v1/home-care/patients/${p.id}/episodes`)
      .set(bearer(token))
      .send({
        teamUnitId: teamId,
        reason: 'Pas daljes nga spitali',
        tasks: ['OBSERVATIONS'],
        visitAddress: 'Rr. B 2',
      });
    expect(res.status).toBe(201);
    const teams = await api().get(`/api/v1/home-care/teams?patientId=${p.id}`).set(bearer(token));
    expect(teams.body.teams.map((t: { id: string }) => t.id).sort()).toEqual(
      [teamId, otherTeamId].sort(),
    );
  });
});

describe('the team at work', () => {
  let patientId: string;
  let episodeId: string;
  beforeAll(async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    patientId = p.id;
    episodeId = (await refer(patientId)).body.id;
  });

  it('gives team members record access while the episode is open, not other staff', async () => {
    expect(
      (await api().get(`/api/v1/home-care/patients/${patientId}`).set(bearer(teamNurse2Token)))
        .status,
    ).toBe(200);
    expect(
      (await api().get(`/api/v1/home-care/patients/${patientId}`).set(bearer(outsiderNurseToken)))
        .status,
    ).toBe(403);
    expect(
      (await api().get(`/api/v1/home-care/patients/${patientId}`).set(bearer(w.tokens.reception)))
        .status,
    ).toBe(403);
  });

  it('accepts the referral (team only) and tells the doctor and the patient', async () => {
    expect(
      (
        await api().post(`/api/v1/home-care/episodes/${episodeId}/visits`).set(nurse()).send({
          startAt: new Date().toISOString(),
          frequency: 'ONCE',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await api()
          .post(`/api/v1/home-care/episodes/${episodeId}/accept`)
          .set(bearer(outsiderNurseToken))
      ).status,
    ).toBe(403);
    const res = await api().post(`/api/v1/home-care/episodes/${episodeId}/accept`).set(nurse());
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ACTIVE');
    expect(
      (await api().post(`/api/v1/home-care/episodes/${episodeId}/accept`).set(nurse())).status,
    ).toBe(409);
    const doctorTold = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.doctor.id));
    expect(doctorTold.some((n) => /accepted your home care referral/.test(n.title))).toBe(true);
  });

  it('plans recurring visits for team nurses only', async () => {
    const base = { frequency: 'DAILY', weeks: 1 };
    const tomorrow = new Date(Date.now() + 24 * HOUR);
    expect(
      (
        await api()
          .post(`/api/v1/home-care/episodes/${episodeId}/visits`)
          .set(nurse())
          .send({ ...base, startAt: tomorrow.toISOString(), assignedToId: w.users.pharmacist.id })
      ).status,
    ).toBe(400);
    expect(
      (
        await api()
          .post(`/api/v1/home-care/episodes/${episodeId}/visits`)
          .set(nurse())
          .send({ ...base, weeks: 13, startAt: tomorrow.toISOString() })
      ).status,
    ).toBe(400);
    const res = await api()
      .post(`/api/v1/home-care/episodes/${episodeId}/visits`)
      .set(nurse())
      .send({ ...base, startAt: tomorrow.toISOString(), assignedToId: teamNurse2.id });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(7);
    // The care plan tasks are used when none are given.
    expect(res.body.items[0].tasks).toEqual(['WOUND_CARE', 'MEDICATION']);
  });

  it('shows the day list per nurse, then checks in and out with observations', async () => {
    const soon = new Date(Date.now() + 30 * 60_000);
    const created = await api()
      .post(`/api/v1/home-care/episodes/${episodeId}/visits`)
      .set(nurse())
      .send({
        startAt: soon.toISOString(),
        frequency: 'ONCE',
        assignedToId: w.users.nurse.id,
        tasks: ['OBSERVATIONS'],
      });
    const visitId = created.body.items[0].id;
    const board = await api().get('/api/v1/home-care/board').set(nurse());
    expect(board.status).toBe(200);
    const mine = board.body.byNurse.find(
      (g: { nurseId: string }) => g.nurseId === w.users.nurse.id,
    );
    const row = mine.visits.find((v: { id: string }) => v.id === visitId);
    expect(row).toMatchObject({
      address: 'Rr. Agim Ramadani 12, Prishtinë',
      accessNotes: 'Kati 2, zilja e majtë',
      status: 'PLANNED',
    });
    expect(
      (await api().get('/api/v1/home-care/board').set(bearer(outsiderNurseToken))).body.team,
    ).toBeNull();

    const checkIn = await api().post(`/api/v1/home-care/visits/${visitId}/check-in`).set(nurse());
    expect(checkIn.status).toBe(200);
    expect(checkIn.body.inProgress).toBe(true);
    expect(
      (await api().post(`/api/v1/home-care/visits/${visitId}/check-in`).set(nurse())).status,
    ).toBe(409);
    expect(
      (
        await api()
          .post(`/api/v1/home-care/visits/${visitId}/cancel`)
          .set(nurse())
          .send({ reason: 'gabim' })
      ).status,
    ).toBe(409);

    // Lone working: checked in 3 hours ago without a check-out is flagged.
    await db
      .update(homeVisits)
      .set({
        visitedAt: new Date(Date.now() - 3 * HOUR),
        scheduledFor: new Date(Date.now() - 3 * HOUR),
      })
      .where(eq(homeVisits.id, visitId));
    const flagged = await api().get('/api/v1/home-care/board').set(nurse());
    const attention = flagged.body.attention.find((v: { id: string }) => v.id === visitId);
    expect(attention).toMatchObject({ checkOutOverdue: true, inProgress: true });

    const done = await api()
      .post(`/api/v1/home-care/visits/${visitId}/complete`)
      .set(nurse())
      .send({
        notes: 'Plaga pa shenja infeksioni',
        tasksDone: ['OBSERVATIONS', 'WOUND_CARE'],
        observations: {
          systolic: 92,
          heartRate: 118,
          respiratoryRate: 24,
          oxygenSaturation: 93,
          temperatureC: 38.6,
          consciousness: 'A',
          onSupplementalOxygen: false,
        },
      });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'DONE', inProgress: false });
    expect(done.body.finishedAt).toBeTruthy();
    expect(done.body.news).toMatchObject({ scale: 'NEWS2' });
    expect(done.body.news.score).toBeGreaterThan(5);
    const [v] = await db.select().from(vitalSigns).where(eq(vitalSigns.id, done.body.vitalSignId));
    expect(v).toMatchObject({ patientId, heartRate: 118 });
    expect(
      (
        await api()
          .post(`/api/v1/home-care/visits/${visitId}/complete`)
          .set(nurse())
          .send({ notes: 'sërish' })
      ).status,
    ).toBe(409);
  });

  it('tells the referring doctor and the team once when a medication visit is missed', async () => {
    const [visit] = await db
      .select()
      .from(homeVisits)
      .where(and(eq(homeVisits.episodeId, episodeId), eq(homeVisits.status, 'PLANNED')))
      .limit(1);
    const res = await api()
      .post(`/api/v1/home-care/visits/${visit!.id}/missed`)
      .set(nurse())
      .send({ reason: 'Pacienti nuk hapi derën' });
    expect(res.status).toBe(200);
    expect(res.body.alerted).toBe(true);
    expect(
      (
        await api()
          .post(`/api/v1/home-care/visits/${visit!.id}/missed`)
          .set(nurse())
          .send({ reason: 'sërish' })
      ).status,
    ).toBe(409);
    const link = `/home-care?visit=${visit!.id}&missed=1`;
    const sent = await db.select().from(notifications).where(eq(notifications.link, link));
    expect(sent.map((n) => n.userId).sort()).toEqual([w.users.doctor.id, teamNurse2.id].sort());
    expect(sent[0]!.title).not.toMatch(/Patient/);
  });

  it('does not alert for a missed wound-care visit', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const ep = (await refer(p.id, { tasks: ['WOUND_CARE'] })).body.id;
    await api().post(`/api/v1/home-care/episodes/${ep}/accept`).set(nurse());
    const planned = await api()
      .post(`/api/v1/home-care/episodes/${ep}/visits`)
      .set(nurse())
      .send({ startAt: new Date().toISOString(), frequency: 'ONCE' });
    const res = await api()
      .post(`/api/v1/home-care/visits/${planned.body.items[0].id}/missed`)
      .set(nurse())
      .send({ reason: 'Pacienti në spital' });
    expect(res.body.alerted).toBe(false);
  });

  it('shows the patient upcoming visits and the plan; limited guardians see times only', async () => {
    await db
      .update(patients)
      .set({ userId: w.users.patientUser.id })
      .where(eq(patients.id, w.patient.id));
    // The world patient gets an episode too.
    const ep = (await refer(w.patient.id)).body.id;
    await api().post(`/api/v1/home-care/episodes/${ep}/accept`).set(nurse());
    await api()
      .post(`/api/v1/home-care/episodes/${ep}/visits`)
      .set(nurse())
      .send({
        startAt: new Date(Date.now() + 48 * HOUR).toISOString(),
        frequency: 'WEEKLY',
        weeks: 2,
        assignedToId: teamNurse2.id,
      });
    const mine = await api().get('/api/v1/home-care/mine').set(bearer(w.tokens.patient));
    expect(mine.status).toBe(200);
    expect(mine.body.limited).toBe(false);
    const item = mine.body.items[0];
    expect(item.carePlan.goals).toBe('Shërimi i plagës');
    expect(item.upcoming).toHaveLength(2);
    expect(item.upcoming[0].nurse).toBe(teamNurse2.fullName);
    // Another patient sees only their own (nothing).
    const other = await api().get('/api/v1/home-care/mine').set(bearer(w.tokens.otherPatient));
    expect(other.body.items).toEqual([]);

    const guardian = await createUser('PATIENT');
    await db.insert(guardianships).values({
      patientId: w.patient.id,
      guardianUserId: guardian.id,
      relationship: 'OTHER_AUTHORISED',
      scope: 'APPOINTMENTS',
      evidence: 'Autorizim 1/2026',
      verifiedById: w.users.reception.id,
      validFrom: new Date(Date.now() - 86_400_000),
      validUntil: new Date(Date.now() + 86_400_000 * 30),
    });
    const token = await login(guardian.email);
    const limited = await api()
      .get('/api/v1/home-care/mine')
      .set({ ...bearer(token), 'X-Acting-For': w.patient.id });
    expect(limited.status).toBe(200);
    expect(limited.body.limited).toBe(true);
    expect(limited.body.items[0].carePlan).toBeNull();
    expect(limited.body.items[0].upcoming).toHaveLength(2);
    expect(limited.body.items[0].upcoming[0].tasks).toEqual([]);
  });

  it('holds (cancelling future visits), resumes and discharges; the team then loses access', async () => {
    const hold = await api()
      .post(`/api/v1/home-care/episodes/${episodeId}/hold`)
      .set(nurse())
      .send({ reason: 'Shtruar në spital' });
    expect(hold.status).toBe(200);
    expect(hold.body.visitsCancelled).toBeGreaterThan(0);
    expect(
      (await api().post(`/api/v1/home-care/episodes/${episodeId}/resume`).set(nurse())).body.status,
    ).toBe('ACTIVE');
    const plan = await api()
      .patch(`/api/v1/home-care/episodes/${episodeId}/care-plan`)
      .set(doctor())
      .send({ goals: 'Mbyllja e plagës brenda 3 javësh' });
    expect(plan.status).toBe(200);
    expect(plan.body.carePlan.goals).toBe('Mbyllja e plagës brenda 3 javësh');
    expect(
      (
        await api()
          .patch(`/api/v1/home-care/episodes/${episodeId}/care-plan`)
          .set(bearer(outsiderNurseToken))
          .send({ goals: 'x' })
      ).status,
    ).toBe(403);
    const discharged = await api()
      .post(`/api/v1/home-care/episodes/${episodeId}/discharge`)
      .set(nurse())
      .send({ reason: 'Plaga u shërua' });
    expect(discharged.status).toBe(200);
    expect(discharged.body.status).toBe('DISCHARGED');
    expect(
      (await api().get(`/api/v1/home-care/patients/${patientId}`).set(bearer(teamNurse2Token)))
        .status,
    ).toBe(403);
    // The patient's doctor still sees the history.
    const chart = await api().get(`/api/v1/home-care/patients/${patientId}`).set(doctor());
    expect(chart.body.items.find((e: { id: string }) => e.id === episodeId).status).toBe(
      'DISCHARGED',
    );
  });

  it('gives the director team activity without names', async () => {
    expect((await api().get('/api/v1/home-care/stats').set(nurse())).status).toBe(403);
    const res = await api().get('/api/v1/home-care/stats').set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    const t = res.body.teams.find((x: { id: string }) => x.id === teamId);
    expect(t.dischargedLast12Months).toBeGreaterThanOrEqual(1);
    expect(
      t.weeks.reduce((n: number, wk: { done: number }) => n + wk.done, 0),
    ).toBeGreaterThanOrEqual(1);
    expect(
      t.weeks.reduce((n: number, wk: { missed: number }) => n + wk.missed, 0),
    ).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(res.body)).not.toMatch(/Patient|Rr\./);
    const other = await api().get('/api/v1/home-care/stats').set(bearer(w.tokens.otherDirector));
    expect(other.body.teams.map((x: { id: string }) => x.id)).toEqual([otherTeamId]);
  });
});
