import { and, eq, like } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  appointments,
  auditLogs,
  careUnits,
  complaints,
  feedbackResponses,
  guardianships,
  notifications,
  patients,
} from '../src/db/schema.js';
import {
  addWorkingDays,
  dedupeKeyFor,
  monthOf,
  runComplaintsWorker,
} from '../src/modules/complaints/complaints.service.js';
import { api, bearer, createUser, createWorld, login, nextNationalId } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let child: typeof patients.$inferSelect;
let parentToken: string;
let limitedToken: string;
let unitId: string;
const DAY = 86_400_000;
const asGuardian = (token: string, patientId: string) => ({
  ...bearer(token),
  'X-Acting-For': patientId,
});
const description = 'The waiting time was more than four hours and nobody told us why.';

async function appointment(patientId: string, facilityId: string, at: Date, mode = 'IN_PERSON') {
  const [a] = await db
    .insert(appointments)
    .values({
      patientId,
      doctorId: w.users.doctor.id,
      facilityId,
      scheduledAt: at,
      reason: 'Kontroll',
      status: 'COMPLETED',
      mode,
    })
    .returning();
  return a!;
}

beforeAll(async () => {
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({
      facilityId: w.facility.id,
      name: 'Kirurgjia C',
      code: `KC${Date.now() % 100000}`,
      type: 'SURGICAL_WARD',
    })
    .returning();
  unitId = unit!.id;
  child = (
    await db
      .insert(patients)
      .values({
        nationalId: nextNationalId(),
        firstName: 'Ana',
        lastName: 'Berisha',
        dateOfBirth: '2017-03-01',
        sex: 'FEMALE',
        primaryFacilityId: w.facility.id,
      })
      .returning()
  )[0]!;
  const parent = await createUser('PATIENT');
  const limited = await createUser('PATIENT');
  const validUntil = new Date(Date.now() + 365 * DAY);
  await db.insert(guardianships).values([
    {
      patientId: child.id,
      guardianUserId: parent.id,
      relationship: 'PARENT',
      evidence: 'Certifikata e lindjes 3/2017',
      verifiedById: w.users.reception.id,
      validUntil,
    },
    {
      patientId: child.id,
      guardianUserId: limited.id,
      relationship: 'LEGAL_GUARDIAN',
      scope: 'APPOINTMENTS',
      evidence: 'Vendim gjykate 9/2024',
      verifiedById: w.users.reception.id,
      validUntil,
    },
  ]);
  parentToken = await login(parent.email);
  limitedToken = await login(limited.email);
});

describe('deadlines', () => {
  it('acknowledgement within 5 working days, response within 30 days', () => {
    // Friday 6 Nov 2026, noon in Kosovo → Friday 13 Nov.
    const friday = new Date('2026-11-06T11:00:00Z');
    expect(addWorkingDays(friday, 5).toISOString().slice(0, 10)).toBe('2026-11-13');
    // Saturday → the following Friday.
    expect(addWorkingDays(new Date('2026-11-07T11:00:00Z'), 5).toISOString().slice(0, 10)).toBe(
      '2026-11-13',
    );
    // Monday → Monday a week later.
    expect(addWorkingDays(new Date('2026-11-09T09:00:00Z'), 5).toISOString().slice(0, 10)).toBe(
      '2026-11-16',
    );
  });
});

describe('submitting complaints', () => {
  it('validates, numbers and flags complaints about facilities without recent care', async () => {
    const short = await api()
      .post('/api/v1/complaints/portal')
      .set(bearer(w.tokens.patient))
      .send({ facilityId: w.facility.id, category: 'WAITING_TIME', description: 'Too short' });
    expect(short.status).toBe(400);

    const noCare = await api()
      .post('/api/v1/complaints/portal')
      .set(bearer(w.tokens.patient))
      .send({ facilityId: w.otherFacility.id, category: 'WAITING_TIME', description });
    expect(noCare.status).toBe(201);
    expect(noCare.body.reference).toMatch(/^ANK-\d{4}-\d{5}$/);
    expect(noCare.body.hadRecentCare).toBe(false);

    await appointment(w.patient.id, w.facility.id, new Date(Date.now() - 40 * DAY));
    const withCare = await api()
      .post('/api/v1/complaints/portal')
      .set(bearer(w.tokens.patient))
      .send({
        facilityId: w.facility.id,
        category: 'COMMUNICATION',
        description,
        desiredOutcome: 'An apology',
      });
    expect(withCare.status).toBe(201);
    expect(withCare.body.hadRecentCare).toBe(true);
    const due = new Date(withCare.body.responseDueAt).getTime() - Date.now();
    expect(Math.round(due / DAY)).toBe(30);

    const facilities = await api()
      .get('/api/v1/complaints/portal/facilities')
      .set(bearer(w.tokens.patient));
    expect(facilities.body.items.find((f: { id: string }) => f.id === w.facility.id).visited).toBe(
      true,
    );

    // The director hears about it (no clinical detail in the title).
    const n = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.director.id),
          like(notifications.link, `%${withCare.body.id}%`),
        ),
      );
    expect(n[0]?.title).toContain(withCare.body.reference);
  });

  it('gives gap-free references under concurrent submissions', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api()
          .post('/api/v1/complaints/portal')
          .set(bearer(w.tokens.otherPatient))
          .send({ facilityId: w.facility.id, category: 'FACILITIES', description }),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const nums = results
      .map((r) => Number(String(r.body.reference).slice(-5)))
      .sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBe(nums[i - 1]! + 1);
  });

  it('guardians with full access complain for a child; appointment-only guardians cannot', async () => {
    const ok = await api()
      .post('/api/v1/complaints/portal')
      .set(asGuardian(parentToken, child.id))
      .send({ facilityId: w.facility.id, category: 'STAFF_ATTITUDE', description });
    expect(ok.status).toBe(201);
    const [row] = await db.select().from(complaints).where(eq(complaints.id, ok.body.id));
    expect(row!.patientId).toBe(child.id);
    const mine = await api()
      .get('/api/v1/complaints/portal')
      .set(asGuardian(parentToken, child.id));
    expect(mine.body.items.map((c: { id: string }) => c.id)).toContain(ok.body.id);

    const limited = await api()
      .post('/api/v1/complaints/portal')
      .set(asGuardian(limitedToken, child.id))
      .send({ facilityId: w.facility.id, category: 'STAFF_ATTITUDE', description });
    expect(limited.status).toBe(403);
  });

  it('reception records complaints received in person', async () => {
    const unknown = await api().post('/api/v1/complaints').set(bearer(w.tokens.reception)).send({
      patientNationalId: '9999999999',
      channel: 'PHONE',
      category: 'BILLING',
      description,
    });
    expect(unknown.status).toBe(400);
    const res = await api().post('/api/v1/complaints').set(bearer(w.tokens.reception)).send({
      patientNationalId: w.otherPatient.nationalId,
      channel: 'PHONE',
      category: 'BILLING',
      description,
    });
    expect(res.status).toBe(201);
    expect(res.body.channel).toBe('PHONE');
    const doctor = await api().post('/api/v1/complaints').set(bearer(w.tokens.doctor)).send({
      patientNationalId: w.otherPatient.nationalId,
      channel: 'PHONE',
      category: 'BILLING',
      description,
    });
    expect(doctor.status).toBe(403);
  });
});

describe('handling a complaint', () => {
  let id: string;
  beforeAll(async () => {
    const res = await api()
      .post('/api/v1/complaints/portal')
      .set(bearer(w.tokens.patient))
      .send({ facilityId: w.facility.id, category: 'CARE_QUALITY', description });
    id = res.body.id;
  });

  it('is visible only to the director, the assignee and the complainant', async () => {
    expect(
      (await api().get(`/api/v1/complaints/${id}`).set(bearer(w.tokens.director))).status,
    ).toBe(200);
    for (const token of [
      w.tokens.otherDirector,
      w.tokens.nurse,
      w.tokens.ministry,
      w.tokens.doctor,
    ]) {
      expect((await api().get(`/api/v1/complaints/${id}`).set(bearer(token))).status).toBe(404);
    }
    expect(
      (await api().get(`/api/v1/complaints/portal/${id}`).set(bearer(w.tokens.otherPatient)))
        .status,
    ).toBe(404);
    // Reading a complaint is never recorded as access to the clinical record.
    const access = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceType, 'complaint'), eq(auditLogs.resourceId, id)));
    expect(access.every((a) => a.patientId === null)).toBe(true);
  });

  it('the director assigns; the assignee acknowledges and responds', async () => {
    const outsider = await api()
      .post(`/api/v1/complaints/${id}/assign`)
      .set(bearer(w.tokens.director))
      .send({ userId: w.users.outsideDoctor.id });
    expect(outsider.status).toBe(400);
    const assign = await api()
      .post(`/api/v1/complaints/${id}/assign`)
      .set(bearer(w.tokens.director))
      .send({ userId: w.users.nurse.id });
    expect(assign.status).toBe(200);
    expect(assign.body.assignedTo).toBeTruthy();

    const list = await api().get('/api/v1/complaints').set(bearer(w.tokens.nurse));
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([id]);
    // The assignee cannot reassign or close.
    expect(
      (
        await api()
          .post(`/api/v1/complaints/${id}/assign`)
          .set(bearer(w.tokens.nurse))
          .send({ userId: w.users.doctor.id })
      ).status,
    ).toBe(403);

    const ack = await api()
      .post(`/api/v1/complaints/${id}/acknowledge`)
      .set(bearer(w.tokens.nurse));
    expect(ack.body.status).toBe('ACKNOWLEDGED');
    expect(
      (await api().post(`/api/v1/complaints/${id}/acknowledge`).set(bearer(w.tokens.nurse))).status,
    ).toBe(409);
    const [ackNote] = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.patientUser.id),
          eq(notifications.type, 'complaint.acknowledged'),
        ),
      );
    expect(ackNote?.link).toContain(id);

    expect(
      (
        await api()
          .post(`/api/v1/complaints/${id}/respond`)
          .set(bearer(w.tokens.nurse))
          .send({ response: 'Sorry.', outcome: 'UPHELD' })
      ).status,
    ).toBe(400);
    const respond = await api()
      .post(`/api/v1/complaints/${id}/respond`)
      .set(bearer(w.tokens.nurse))
      .send({
        response: 'We are sorry. We have changed how waiting times are communicated on the ward.',
        outcome: 'PARTLY_UPHELD',
      });
    expect(respond.status).toBe(200);
    expect(respond.body.status).toBe('RESPONDED');

    const portal = await api().get(`/api/v1/complaints/portal/${id}`).set(bearer(w.tokens.patient));
    expect(portal.body).toMatchObject({ outcome: 'PARTLY_UPHELD', canEscalate: true });
    expect(portal.body.response).toContain('sorry');
  });

  it('the complainant escalates within 30 days; the Ministry decides', async () => {
    expect(
      (await api().get(`/api/v1/complaints/${id}`).set(bearer(w.tokens.ministry))).status,
    ).toBe(404);
    const esc = await api()
      .post(`/api/v1/complaints/portal/${id}/escalate`)
      .set(bearer(w.tokens.patient))
      .send({ reason: 'The response did not explain what will change.' });
    expect(esc.status).toBe(200);
    expect(esc.body.status).toBe('ESCALATED');

    const queue = await api().get('/api/v1/complaints').set(bearer(w.tokens.ministry));
    expect(queue.body.items.map((c: { id: string }) => c.id)).toContain(id);
    const detail = await api().get(`/api/v1/complaints/${id}`).set(bearer(w.tokens.ministry));
    expect(detail.status).toBe(200);
    expect(detail.body.patientNationalId).toBeNull();

    const decide = await api()
      .post(`/api/v1/complaints/${id}/decision`)
      .set(bearer(w.tokens.ministry))
      .send({ decision: 'The facility must publish its waiting-time policy on every ward.' });
    expect(decide.body.status).toBe('CLOSED');
    expect(
      (
        await api()
          .post(`/api/v1/complaints/${id}/decision`)
          .set(bearer(w.tokens.ministry))
          .send({ decision: 'The facility must publish its waiting-time policy on every ward.' })
      ).status,
    ).toBe(409);
  });

  it('refuses escalation after 30 days and allows withdrawal before a response', async () => {
    const late = await api()
      .post('/api/v1/complaints/portal')
      .set(bearer(w.tokens.patient))
      .send({ facilityId: w.facility.id, category: 'PRIVACY', description });
    await db
      .update(complaints)
      .set({
        status: 'RESPONDED',
        response: 'Answered long ago with a full explanation of what happened.',
        outcome: 'NOT_UPHELD',
        respondedAt: new Date(Date.now() - 31 * DAY),
      })
      .where(eq(complaints.id, late.body.id));
    expect(
      (
        await api()
          .post(`/api/v1/complaints/portal/${late.body.id}/escalate`)
          .set(bearer(w.tokens.patient))
          .send({ reason: 'I disagree with the response given.' })
      ).status,
    ).toBe(409);

    const open = await api()
      .post('/api/v1/complaints/portal')
      .set(bearer(w.tokens.patient))
      .send({ facilityId: w.facility.id, category: 'OTHER', description });
    const wd = await api()
      .post(`/api/v1/complaints/portal/${open.body.id}/withdraw`)
      .set(bearer(w.tokens.patient));
    expect(wd.body).toMatchObject({ status: 'CLOSED', outcome: 'WITHDRAWN' });
  });
});

describe('anonymous feedback', () => {
  let apptId: string;
  let stayId: string;
  beforeAll(async () => {
    apptId = (await appointment(w.patient.id, w.facility.id, new Date(Date.now() - 2 * DAY))).id;
    const [stay] = await db
      .insert(admissions)
      .values({
        patientId: w.patient.id,
        facilityId: w.facility.id,
        unitId,
        admittingDoctorId: w.users.doctor.id,
        attendingDoctorId: w.users.doctor.id,
        source: 'ELECTIVE',
        reason: 'Operacion',
        admittedAt: new Date(Date.now() - 6 * DAY),
        status: 'DISCHARGED',
        dischargedAt: new Date(Date.now() - 3 * DAY),
        disposition: 'HOME',
      })
      .returning();
    stayId = stay!.id;
  });

  it('lists recent visits and stores ratings without anyone’s identity', async () => {
    const eligible = await api()
      .get('/api/v1/complaints/feedback/eligible')
      .set(bearer(w.tokens.patient));
    const ids = eligible.body.items.map((v: { visitId: string }) => v.visitId);
    expect(ids).toEqual(expect.arrayContaining([apptId, stayId]));
    // The appointment 40 days ago is out of the window.
    expect(eligible.body.items.length).toBe(2);

    const other = await api()
      .post('/api/v1/complaints/feedback')
      .set(bearer(w.tokens.otherPatient))
      .send({ setting: 'OUTPATIENT', visitId: apptId, overall: 1 });
    expect(other.status).toBe(409);

    const res = await api()
      .post('/api/v1/complaints/feedback')
      .set(bearer(w.tokens.patient))
      .send({
        setting: 'INPATIENT',
        visitId: stayId,
        overall: 4,
        scores: { communication: 5, cleanliness: 3 },
        wouldRecommend: true,
        comment: 'Kind nurses.',
      });
    expect(res.status).toBe(201);
    const [row] = await db
      .select()
      .from(feedbackResponses)
      .where(eq(feedbackResponses.dedupeKey, dedupeKeyFor('INPATIENT', stayId)));
    expect(row).toMatchObject({
      facilityId: w.facility.id,
      unitId,
      setting: 'INPATIENT',
      overall: 4,
    });
    expect(Object.keys(row!)).not.toEqual(expect.arrayContaining(['patientId']));
    expect(row!.month).toBe(monthOf(new Date(Date.now() - 3 * DAY)));
    expect(row!.createdAt.toISOString().slice(8, 19)).toBe('01T00:00:00');
    expect(row!.dedupeKey).not.toContain(stayId);

    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'feedback.submitted'));
    expect(entry).toMatchObject({
      actorUserId: null,
      actorRole: null,
      patientId: null,
      ipAddress: null,
    });

    const again = await api()
      .post('/api/v1/complaints/feedback')
      .set(bearer(w.tokens.patient))
      .send({ setting: 'INPATIENT', visitId: stayId, overall: 5 });
    expect(again.status).toBe(409);
    const left = await api()
      .get('/api/v1/complaints/feedback/eligible')
      .set(bearer(w.tokens.patient));
    expect(left.body.items.map((v: { visitId: string }) => v.visitId)).toEqual([apptId]);
  });

  it('appointment-only guardians may rate appointments but not stays', async () => {
    const stay = await db
      .insert(admissions)
      .values({
        patientId: child.id,
        facilityId: w.facility.id,
        unitId,
        admittingDoctorId: w.users.doctor.id,
        attendingDoctorId: w.users.doctor.id,
        source: 'ELECTIVE',
        reason: 'Bajamet',
        admittedAt: new Date(Date.now() - 5 * DAY),
        status: 'DISCHARGED',
        dischargedAt: new Date(Date.now() - 4 * DAY),
        disposition: 'HOME',
      })
      .returning();
    const visit = await appointment(child.id, w.facility.id, new Date(Date.now() - DAY));
    const limited = await api()
      .get('/api/v1/complaints/feedback/eligible')
      .set(asGuardian(limitedToken, child.id));
    expect(limited.body.items.map((v: { visitId: string }) => v.visitId)).toEqual([visit.id]);
    const full = await api()
      .get('/api/v1/complaints/feedback/eligible')
      .set(asGuardian(parentToken, child.id));
    expect(full.body.items.map((v: { visitId: string }) => v.visitId)).toContain(stay[0]!.id);
  });

  it('dashboards suppress small groups and show comments only from large groups', async () => {
    const small = await api()
      .get('/api/v1/complaints/feedback/dashboard')
      .set(bearer(w.tokens.director));
    expect(small.status).toBe(200);
    const inpatient = small.body.bySetting.find((g: { key: string }) => g.key === 'INPATIENT');
    expect(inpatient).toMatchObject({ suppressed: true, overall: null, responses: null });
    expect(small.body.comments).toEqual([]);

    const month = monthOf(new Date());
    await db.insert(feedbackResponses).values(
      Array.from({ length: 5 }, (_, i) => ({
        facilityId: w.facility.id,
        unitId,
        setting: 'INPATIENT',
        dedupeKey: `test-${Date.now()}-${i}`,
        overall: 5,
        wouldRecommend: i % 2 === 0,
        comment: i === 0 ? 'Clean rooms.' : null,
        month,
      })),
    );
    const big = await api()
      .get('/api/v1/complaints/feedback/dashboard')
      .set(bearer(w.tokens.director));
    const group = big.body.bySetting.find((g: { key: string }) => g.key === 'INPATIENT');
    expect(group.suppressed).toBe(false);
    expect(group.responses).toBe(6);
    expect(group.overall).toBeCloseTo(4.8, 1);
    expect(big.body.byUnit[0]).toMatchObject({ label: 'Kirurgjia C', responses: 6 });
    expect(big.body.comments.map((c: { comment: string }) => c.comment)).toEqual(
      expect.arrayContaining(['Kind nurses.', 'Clean rooms.']),
    );

    const other = await api()
      .get('/api/v1/complaints/feedback/dashboard')
      .set(bearer(w.tokens.otherDirector));
    expect(other.body.overall?.responses ?? null).toBeNull();
    expect(
      (await api().get('/api/v1/complaints/feedback/dashboard').set(bearer(w.tokens.nurse))).status,
    ).toBe(403);
    const national = await api()
      .get('/api/v1/complaints/feedback/dashboard')
      .set(bearer(w.tokens.ministry));
    expect(national.body.byFacility.length).toBeGreaterThan(0);
    expect(national.body.comments).toEqual([]);
  });

  it('complaint dashboards: facility counts, national suppression', async () => {
    const d = await api().get('/api/v1/complaints/dashboard').set(bearer(w.tokens.director));
    expect(d.status).toBe(200);
    expect(d.body.byCategory.some((c: { suppressed: boolean }) => c.suppressed)).toBe(false);
    expect(d.body.timeliness).toHaveProperty('acknowledgedOnTimePct');
    const n = await api().get('/api/v1/complaints/dashboard').set(bearer(w.tokens.ministry));
    const other = n.body.byFacility.find((f: { key: string }) => f.key === w.otherFacility.id);
    expect(other).toMatchObject({ count: null, suppressed: true });
  });
});

describe('worker', () => {
  it('reminds the handler before and on the deadline, once each', async () => {
    const res = await api()
      .post('/api/v1/complaints/portal')
      .set(bearer(w.tokens.patient))
      .send({ facilityId: w.facility.id, category: 'WAITING_TIME', description });
    const id = res.body.id;
    await db
      .update(complaints)
      .set({ acknowledgeDueAt: new Date(Date.now() + 2 * DAY) })
      .where(eq(complaints.id, id));
    const reminders = async () =>
      db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, w.users.director.id),
            like(notifications.link, `%complaint=${id}&reminder=%`),
          ),
        );
    await runComplaintsWorker();
    await runComplaintsWorker();
    expect((await reminders()).map((r) => r.link)).toEqual([
      `/complaints?complaint=${id}&reminder=acknowledge-soon`,
    ]);
    await db
      .update(complaints)
      .set({ acknowledgeDueAt: new Date(Date.now() - DAY) })
      .where(eq(complaints.id, id));
    await runComplaintsWorker();
    await runComplaintsWorker();
    expect((await reminders()).map((r) => r.link).sort()).toEqual([
      `/complaints?complaint=${id}&reminder=acknowledge-due`,
      `/complaints?complaint=${id}&reminder=acknowledge-soon`,
    ]);
  });

  it('invites patients to rate yesterday’s visits once', async () => {
    const visit = await appointment(
      w.otherPatient.id,
      w.facility.id,
      new Date(Date.now() - 30 * 3_600_000),
    );
    await runComplaintsWorker();
    await runComplaintsWorker();
    const invites = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.otherPatientUser.id),
          eq(notifications.type, 'feedback.invite'),
        ),
      );
    expect(invites).toHaveLength(1);
    // The invitation cannot be matched to a rating.
    expect(invites[0]!.link).not.toContain(dedupeKeyFor('OUTPATIENT', visit.id).slice(0, 32));
  });
});
