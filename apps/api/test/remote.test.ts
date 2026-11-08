import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careAssignments,
  guardianships,
  homeReadings,
  monitoringPlans,
  notifications,
  vitalSigns,
} from '../src/db/schema.js';
import {
  DEFAULT_THRESHOLDS,
  evaluateReading,
  planThresholds,
  ThresholdsSchema,
} from '../src/modules/remote/definitions.js';
import { enrolPatient } from '../src/modules/registers/registers.service.js';
import { kosovoDay, runRemoteDigestsOnce } from '../src/modules/remote/remote.service.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

const DAY = 86_400_000;
const BASE = '/api/v1/remote-monitoring';
let w: Awaited<ReturnType<typeof createWorld>>;

beforeAll(async () => {
  w = await createWorld();
  // The nurse is part of the patient's care team.
  await db.insert(careAssignments).values({ patientId: w.patient.id, doctorId: w.users.nurse.id });
});

async function enrol(patientId: string, body: Record<string, unknown>, token = w.tokens.doctor) {
  return api().post(`${BASE}/patients/${patientId}/plans`).set(bearer(token)).send(body);
}
const submit = (token: string, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  api()
    .post(`${BASE}/mine/readings`)
    .set({ ...bearer(token), ...extra })
    .send(body);
const bp = (systolic: number, diastolic: number, measuredAt?: Date) => ({
  kind: 'BLOOD_PRESSURE',
  values: { systolic, diastolic },
  ...(measuredAt ? { measuredAt: measuredAt.toISOString() } : {}),
});

/* --------------------------------------------------------------------------- unit rules -- */

describe('flagging rules', () => {
  const limits = planThresholds(['BLOOD_PRESSURE', 'GLUCOSE', 'WEIGHT', 'SPO2'], {});

  it('flags blood pressure against review and urgent limits', () => {
    expect(evaluateReading('BLOOD_PRESSURE', { systolic: 130, diastolic: 80 }, limits).flag).toBe(
      'NORMAL',
    );
    expect(evaluateReading('BLOOD_PRESSURE', { systolic: 165, diastolic: 90 }, limits)).toEqual({
      flag: 'OUT_OF_RANGE',
      reasons: ['BP_HIGH'],
    });
    expect(evaluateReading('BLOOD_PRESSURE', { systolic: 150, diastolic: 121 }, limits).flag).toBe(
      'URGENT',
    );
    expect(
      evaluateReading('BLOOD_PRESSURE', { systolic: 78, diastolic: 50 }, limits).reasons,
    ).toEqual(['BP_URGENT_LOW']);
  });

  it('flags low and high glucose, and low oxygen', () => {
    expect(evaluateReading('GLUCOSE', { value: 3.6 }, limits).flag).toBe('OUT_OF_RANGE');
    expect(evaluateReading('GLUCOSE', { value: 2.7 }, limits).reasons).toEqual([
      'GLUCOSE_URGENT_LOW',
    ]);
    expect(evaluateReading('GLUCOSE', { value: 22 }, limits).flag).toBe('URGENT');
    expect(evaluateReading('SPO2', { value: 92 }, limits).flag).toBe('OUT_OF_RANGE');
    expect(evaluateReading('SPO2', { value: 88 }, limits).flag).toBe('URGENT');
  });

  it('warns about a weight gain of 2 kg within three days', () => {
    expect(
      evaluateReading('WEIGHT', { value: 82.1 }, limits, { previousWeights: [80, 80.5] }).reasons,
    ).toEqual(['WEIGHT_GAIN']);
    expect(evaluateReading('WEIGHT', { value: 81 }, limits, { previousWeights: [80] }).flag).toBe(
      'NORMAL',
    );
  });

  it('without a plan only clearly urgent readings are flagged', () => {
    const d = { ...DEFAULT_THRESHOLDS };
    expect(
      evaluateReading('BLOOD_PRESSURE', { systolic: 170, diastolic: 95 }, d, { urgentOnly: true })
        .flag,
    ).toBe('NORMAL');
    expect(
      evaluateReading('BLOOD_PRESSURE', { systolic: 190, diastolic: 95 }, d, { urgentOnly: true })
        .flag,
    ).toBe('URGENT');
  });

  it('validates limits: bounds and order', () => {
    expect(ThresholdsSchema.safeParse({ systolicHigh: 150 }).success).toBe(true);
    expect(ThresholdsSchema.safeParse({ systolicHigh: 20 }).success).toBe(false);
    expect(ThresholdsSchema.safeParse({ systolicHigh: 170, systolicUrgentHigh: 160 }).success).toBe(
      false,
    );
    expect(ThresholdsSchema.safeParse({ madeUp: 1 }).success).toBe(false);
  });
});

/* ---------------------------------------------------------------------------- enrolment -- */

describe('enrolment', () => {
  it('lets the treating doctor enrol with personal limits, once', async () => {
    const res = await enrol(w.patient.id, {
      kinds: ['BLOOD_PRESSURE', 'BLOOD_PRESSURE'],
      thresholds: { systolicHigh: 150, silentAfterDays: 2 },
      frequency: 'Twice daily',
      instructions: 'Sit for 5 minutes before measuring.',
    });
    expect(res.status).toBe(201);
    expect(res.body.kinds).toEqual(['BLOOD_PRESSURE']);
    expect(res.body.thresholds).toMatchObject({
      systolicHigh: 150,
      systolicUrgentHigh: 180,
      silentAfterDays: 2,
    });
    expect(res.body.thresholds.glucoseLow).toBeUndefined();
    expect((await enrol(w.patient.id, { kinds: ['GLUCOSE'] })).status).toBe(409);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.patientId, w.patient.id), eq(auditLogs.action, 'remote.plan')));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    // The patient is told (generic text).
    const told = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.patientUser.id),
          eq(notifications.type, 'remote_plan'),
        ),
      );
    expect(told[0]?.title).toBe('Your doctor has set up home monitoring for you');
  });

  it('refuses nurses, doctors outside the care team and limits for other kinds', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await db.insert(careAssignments).values({ patientId: p.id, doctorId: w.users.nurse.id });
    expect((await enrol(p.id, { kinds: ['WEIGHT'] }, w.tokens.nurse)).status).toBe(403);
    expect((await enrol(p.id, { kinds: ['WEIGHT'] }, w.tokens.outsideDoctor)).status).toBe(403);
    expect((await enrol(p.id, { kinds: ['WEIGHT'] }, w.tokens.colleague)).status).toBe(403);
    expect((await enrol(p.id, { kinds: [] })).status).toBe(400);
    expect(
      (await enrol(p.id, { kinds: ['WEIGHT'], thresholds: { systolicHigh: 150 } })).status,
    ).toBe(400);
    expect(
      (await enrol(p.id, { kinds: ['WEIGHT'], thresholds: { systolicHigh: 999 } })).status,
    ).toBe(400);
  });

  it('can be edited and ended with a reason', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const created = await enrol(p.id, { kinds: ['GLUCOSE'], thresholds: { glucoseLow: 4.5 } });
    const edited = await api()
      .patch(`${BASE}/plans/${created.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ kinds: ['GLUCOSE', 'WEIGHT'], frequency: 'Every morning' });
    expect(edited.status).toBe(200);
    expect(edited.body.thresholds).toMatchObject({ glucoseLow: 4.5, weightGainKg3Days: 2 });
    expect(edited.body.frequency).toBe('Every morning');
    const noReason = await api()
      .post(`${BASE}/plans/${created.body.id}/end`)
      .set(bearer(w.tokens.doctor))
      .send({});
    expect(noReason.status).toBe(400);
    const ended = await api()
      .post(`${BASE}/plans/${created.body.id}/end`)
      .set(bearer(w.tokens.doctor))
      .send({ reason: 'Blood sugar stable for six months' });
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({
      status: 'ENDED',
      endReason: 'Blood sugar stable for six months',
    });
    const again = await api()
      .patch(`${BASE}/plans/${created.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ frequency: 'x' });
    expect(again.status).toBe(409);
    // A new plan can follow an ended one.
    expect((await enrol(p.id, { kinds: ['WEIGHT'] })).status).toBe(201);
  });

  it('suggests register patients in my care without a plan', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await enrolPatient(p.id, ['HEART_FAILURE'], { source: 'MANUAL' });
    const asthma = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await enrolPatient(asthma.id, ['ASTHMA'], { source: 'MANUAL' });
    const res = await api().get(`${BASE}/suggestions`).set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    const mine = res.body.items.find((i: { patient: { id: string } }) => i.patient.id === p.id);
    expect(mine).toMatchObject({
      registers: ['HEART_FAILURE'],
      kinds: ['WEIGHT', 'BLOOD_PRESSURE', 'HEART_RATE'],
    });
    expect(
      res.body.items.some((i: { patient: { id: string } }) => i.patient.id === asthma.id),
    ).toBe(false);
    // Not in the colleague's care.
    const theirs = await api().get(`${BASE}/suggestions`).set(bearer(w.tokens.colleague));
    expect(theirs.body.items.some((i: { patient: { id: string } }) => i.patient.id === p.id)).toBe(
      false,
    );
    // The chart shows the suggestion too.
    const chart = await api().get(`${BASE}/patients/${p.id}`).set(bearer(w.tokens.doctor));
    expect(chart.body.suggestion).toMatchObject({ registers: ['HEART_FAILURE'] });
    await enrol(p.id, { kinds: ['WEIGHT'] });
    const after = await api().get(`${BASE}/suggestions`).set(bearer(w.tokens.doctor));
    expect(after.body.items.some((i: { patient: { id: string } }) => i.patient.id === p.id)).toBe(
      false,
    );
  });
});

/* ------------------------------------------------------------------------------ readings -- */

describe('readings from the portal', () => {
  it('validates values and the measurement time', async () => {
    const t = w.tokens.patient;
    expect((await submit(t, bp(300, 90))).status).toBe(400);
    expect((await submit(t, bp(80, 90))).status).toBe(400); // systolic must be higher
    expect((await submit(t, { kind: 'GLUCOSE', values: { value: 'abc' } })).status).toBe(400);
    expect((await submit(t, { kind: 'WEIGHT', values: { value: 80, extra: 1 } })).status).toBe(400);
    expect((await submit(t, { kind: 'NOPE', values: {} })).status).toBe(400);
    expect((await submit(t, bp(130, 80, new Date(Date.now() + 3600_000)))).status).toBe(400);
    expect((await submit(t, bp(130, 80, new Date(Date.now() - 8 * DAY)))).status).toBe(400);
    const ok = await submit(t, bp(130, 80, new Date(Date.now() - 6 * DAY)));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ flag: 'NORMAL', advice: null, planned: true });
  });

  it('flags against the personal limits and lists out-of-range readings for review', async () => {
    // Personal limit 150 (enrolment test): 152 is out of range for this patient.
    const res = await submit(w.tokens.patient, bp(152, 88));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      flag: 'OUT_OF_RANGE',
      reasons: ['BP_HIGH'],
      advice: 'OUT_OF_RANGE',
    });
    expect(res.body.reading.values).toEqual({ systolic: 152, diastolic: 88 });

    const list = await api().get(`${BASE}/review`).set(bearer(w.tokens.doctor));
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: { id: string }) => i.id === res.body.reading.id);
    expect(item).toMatchObject({ flag: 'OUT_OF_RANGE', reasons: ['BP_HIGH'] });
    expect(item.patient.id).toBe(w.patient.id);
    // Not in the colleague's list (not in their care).
    const other = await api().get(`${BASE}/review`).set(bearer(w.tokens.colleague));
    expect(other.body.items.some((i: { id: string }) => i.id === res.body.reading.id)).toBe(false);
    // Out-of-range readings do not alert anyone straight away.
    const urgent = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, w.users.doctor.id), eq(notifications.type, 'remote_urgent')),
      );
    expect(urgent).toHaveLength(0);
  });

  it('urgent readings: the patient is told to seek help, the care team is notified at once', async () => {
    const res = await submit(w.tokens.patient, bp(195, 115));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ flag: 'URGENT', advice: 'URGENT' });
    const sent = await db
      .select()
      .from(notifications)
      .where(
        and(
          inArray(notifications.userId, [
            w.users.doctor.id,
            w.users.nurse.id,
            w.users.colleague.id,
          ]),
          eq(notifications.type, 'remote_urgent'),
        ),
      );
    expect(sent.map((n) => n.userId).sort()).toEqual([w.users.doctor.id, w.users.nurse.id].sort());
    expect(sent[0]!.link).toBe(`/remote-monitoring?reading=${res.body.reading.id}`);
    // No name or value in the notification.
    expect(sent[0]!.title).not.toContain(w.patient.lastName);
    expect(sent[0]!.title).not.toMatch(/195/);

    const list = await api().get(`${BASE}/review`).set(bearer(w.tokens.nurse));
    expect(list.body.items[0]).toMatchObject({ id: res.body.reading.id, flag: 'URGENT' });
    expect(list.body.counts.urgent).toBeGreaterThanOrEqual(1);
  });

  it('low blood sugar gets its own advice', async () => {
    const res = await submit(w.tokens.patient, { kind: 'GLUCOSE', values: { value: 2.4 } });
    expect(res.status).toBe(201);
    // Glucose is not in this patient's plan: only urgent readings are flagged.
    expect(res.body).toMatchObject({
      flag: 'URGENT',
      advice: 'URGENT_LOW_GLUCOSE',
      planned: false,
    });
    const mild = await submit(w.tokens.patient, { kind: 'GLUCOSE', values: { value: 3.7 } });
    expect(mild.body).toMatchObject({ flag: 'NORMAL', planned: false });
  });

  it('readings without any plan are accepted and only flagged when clearly urgent', async () => {
    const u = await createUser('PATIENT');
    await createPatient(w.facility.id, { userId: u.id, doctorId: w.users.doctor.id });
    const token = await login(u.email);
    expect((await submit(token, bp(170, 95))).body).toMatchObject({
      flag: 'NORMAL',
      planned: false,
    });
    expect((await submit(token, bp(185, 95))).body.flag).toBe('URGENT');
    const mine = await api().get(`${BASE}/mine`).set(bearer(token));
    expect(mine.body.plan).toBeNull();
    expect(mine.body.readings).toHaveLength(2);
  });

  it('are kept apart from the clinic’s vital signs', async () => {
    const vitals = await db.select().from(vitalSigns).where(eq(vitalSigns.patientId, w.patient.id));
    expect(vitals).toHaveLength(0);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.patientId, w.patient.id), eq(auditLogs.action, 'remote.reading')));
    expect(audits.length).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------------------- review -- */

describe('review', () => {
  it('is recorded once, with a note, by the care team', async () => {
    const res = await submit(w.tokens.patient, bp(158, 92));
    const id = res.body.reading.id as string;
    expect(
      (await api().post(`${BASE}/readings/${id}/review`).set(bearer(w.tokens.colleague)).send({}))
        .status,
    ).toBe(403);
    const done = await api()
      .post(`${BASE}/readings/${id}/review`)
      .set(bearer(w.tokens.nurse))
      .send({ note: 'Called the patient; rechecked 142/86.' });
    expect(done.status).toBe(200);
    expect(done.body.reviewNote).toBe('Called the patient; rechecked 142/86.');
    expect(
      (await api().post(`${BASE}/readings/${id}/review`).set(bearer(w.tokens.doctor)).send({}))
        .status,
    ).toBe(409);
    const list = await api().get(`${BASE}/review`).set(bearer(w.tokens.doctor));
    expect(list.body.items.some((i: { id: string }) => i.id === id)).toBe(false);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, id), eq(auditLogs.action, 'remote.reviewed')));
    expect(audit).toBeDefined();
    // The patient sees that it was reviewed, but not the note written for colleagues.
    const mine = await api().get(`${BASE}/mine`).set(bearer(w.tokens.patient));
    const own = mine.body.readings.find((r: { id: string }) => r.id === id);
    expect(own.reviewedAt).toBeTruthy();
    expect(own.reviewNote).toBeUndefined();
  });

  it('normal readings need no review', async () => {
    const res = await submit(w.tokens.patient, bp(128, 78));
    expect(
      (
        await api()
          .post(`${BASE}/readings/${res.body.reading.id}/review`)
          .set(bearer(w.tokens.doctor))
          .send({})
      ).status,
    ).toBe(409);
  });
});

/* ---------------------------------------------------------------------- daily digest -- */

describe('daily digest', () => {
  it('sends one digest per doctor per day', async () => {
    const now = new Date();
    await runRemoteDigestsOnce(now);
    const digests = async (userId: string) =>
      db
        .select()
        .from(notifications)
        .where(and(eq(notifications.userId, userId), eq(notifications.type, 'remote_digest')));
    const first = await digests(w.users.doctor.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.link).toBe(`/remote-monitoring?digest=${kosovoDay(now)}`);
    expect(first[0]!.title).toMatch(/^\d+ home readings outside the limits/);
    // Nurses are notified of urgent readings only; the digest goes to doctors.
    expect(await digests(w.users.nurse.id)).toHaveLength(0);

    await submit(w.tokens.patient, bp(162, 90));
    await runRemoteDigestsOnce(now);
    expect(await digests(w.users.doctor.id)).toHaveLength(1);
    // The next day brings a new digest while readings still wait.
    await runRemoteDigestsOnce(new Date(now.getTime() + DAY));
    expect(await digests(w.users.doctor.id)).toHaveLength(2);
    // A doctor with nothing waiting gets nothing.
    expect(await digests(w.users.colleague.id)).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------- silent patients -- */

describe('silent patients', () => {
  it('lists enrolled patients who stopped sending readings', async () => {
    const quiet = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const plan = await enrol(quiet.id, { kinds: ['WEIGHT'] });
    const newcomer = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await enrol(newcomer.id, { kinds: ['WEIGHT'] });
    await db
      .update(monitoringPlans)
      .set({ createdAt: new Date(Date.now() - 20 * DAY) })
      .where(eq(monitoringPlans.id, plan.body.id));
    await db.insert(homeReadings).values({
      patientId: quiet.id,
      planId: plan.body.id,
      kind: 'WEIGHT',
      values: { value: 80 },
      measuredAt: new Date(Date.now() - 5 * DAY),
    });
    const res = await api().get(`${BASE}/silent`).set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    const row = res.body.items.find((i: { patient: { id: string } }) => i.patient.id === quiet.id);
    expect(row).toMatchObject({ daysSilent: 5, silentAfterDays: 3 });
    // A plan started today is not silent yet.
    expect(
      res.body.items.some((i: { patient: { id: string } }) => i.patient.id === newcomer.id),
    ).toBe(false);
    const other = await api().get(`${BASE}/silent`).set(bearer(w.tokens.colleague));
    expect(
      other.body.items.some((i: { patient: { id: string } }) => i.patient.id === quiet.id),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------------------ access -- */

describe('access', () => {
  it('the chart view is for the care team and is audited', async () => {
    const res = await api().get(`${BASE}/patients/${w.patient.id}`).set(bearer(w.tokens.nurse));
    expect(res.status).toBe(200);
    expect(res.body.plan.kinds).toEqual(['BLOOD_PRESSURE']);
    expect(res.body.readings.length).toBeGreaterThan(0);
    expect(res.body).toMatchObject({ canEnrol: false, canReview: true });
    for (const token of [
      w.tokens.colleague,
      w.tokens.outsideDoctor,
      w.tokens.director,
      w.tokens.reception,
      w.tokens.pharmacist,
      w.tokens.ministry,
    ]) {
      expect((await api().get(`${BASE}/patients/${w.patient.id}`).set(bearer(token))).status).toBe(
        403,
      );
    }
    const views = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.patientId, w.patient.id), eq(auditLogs.action, 'patient.record.viewed')),
      );
    expect(
      views.some((v) => (v.metadata as { section?: string } | null)?.section === 'home_readings'),
    ).toBe(true);
  });

  it('patients see and enter only their own readings', async () => {
    const mine = await api().get(`${BASE}/mine`).set(bearer(w.tokens.patient));
    expect(mine.status).toBe(200);
    expect(mine.body.plan.kinds).toEqual(['BLOOD_PRESSURE']);
    const theirs = await api().get(`${BASE}/mine`).set(bearer(w.tokens.otherPatient));
    expect(theirs.body.plan).toBeNull();
    expect(theirs.body.readings).toHaveLength(0);
    // Staff cannot use the portal endpoints; patients cannot read the chart or the review list.
    expect((await submit(w.tokens.doctor, bp(130, 80))).status).toBe(403);
    expect(
      (await api().get(`${BASE}/patients/${w.patient.id}`).set(bearer(w.tokens.patient))).status,
    ).toBe(403);
    expect((await api().get(`${BASE}/review`).set(bearer(w.tokens.patient))).status).toBe(403);
    // Someone else's patient id in the header does not help.
    expect(
      (await submit(w.tokens.otherPatient, bp(130, 80), { 'X-Acting-For': w.patient.id })).status,
    ).toBe(403);
  });

  it('guardians with full access may enter readings; appointments-only guardians may not', async () => {
    const child = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const full = await createUser('PATIENT');
    const appts = await createUser('PATIENT');
    for (const [u, scope] of [
      [full, 'FULL'],
      [appts, 'APPOINTMENTS'],
    ] as const) {
      await db.insert(guardianships).values({
        patientId: child.id,
        guardianUserId: u.id,
        relationship: 'PARENT',
        scope,
        evidence: 'Birth certificate',
        verifiedById: w.users.reception.id,
        validUntil: new Date(Date.now() + 365 * DAY),
      });
    }
    const fullToken = await login(full.email);
    const apptToken = await login(appts.email);
    const ok = await submit(
      fullToken,
      { kind: 'TEMPERATURE', values: { value: 38.4 } },
      { 'X-Acting-For': child.id },
    );
    expect(ok.status).toBe(201);
    const [row] = await db
      .select()
      .from(homeReadings)
      .where(eq(homeReadings.id, ok.body.reading.id));
    expect(row).toMatchObject({ patientId: child.id, enteredByUserId: full.id });
    expect(
      (
        await submit(
          apptToken,
          { kind: 'TEMPERATURE', values: { value: 38.4 } },
          { 'X-Acting-For': child.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .get(`${BASE}/mine`)
          .set({ ...bearer(apptToken), 'X-Acting-For': child.id })
      ).status,
    ).toBe(403);
  });
});

/* ------------------------------------------------------------------------ director stats -- */

describe('director figures', () => {
  it('counts for the own facility only, without names', async () => {
    // A flagged reading reviewed within a day, and one reviewed late.
    const [plan] = await db
      .select()
      .from(monitoringPlans)
      .where(
        and(eq(monitoringPlans.patientId, w.patient.id), eq(monitoringPlans.status, 'ACTIVE')),
      );
    const twoDaysAgo = new Date(Date.now() - 2 * DAY);
    await db.insert(homeReadings).values([
      {
        patientId: w.patient.id,
        planId: plan!.id,
        kind: 'BLOOD_PRESSURE',
        values: { systolic: 165, diastolic: 95 },
        measuredAt: twoDaysAgo,
        createdAt: twoDaysAgo,
        flag: 'OUT_OF_RANGE',
        reviewedAt: new Date(twoDaysAgo.getTime() + 3600_000),
        reviewedById: w.users.doctor.id,
      },
      {
        patientId: w.patient.id,
        planId: plan!.id,
        kind: 'BLOOD_PRESSURE',
        values: { systolic: 166, diastolic: 95 },
        measuredAt: twoDaysAgo,
        createdAt: twoDaysAgo,
        flag: 'OUT_OF_RANGE',
        reviewedAt: new Date(twoDaysAgo.getTime() + 30 * 3600_000),
        reviewedById: w.users.doctor.id,
      },
    ]);
    const res = await api().get(`${BASE}/stats`).set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    expect(res.body.enrolledPatients).toBeGreaterThanOrEqual(1);
    expect(res.body.review).toMatchObject({ flagged: 2, reviewedWithin24h: 1, pct: 50 });
    expect(res.body.weekly.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(res.body)).not.toContain(w.patient.lastName);

    const other = await api().get(`${BASE}/stats`).set(bearer(w.tokens.otherDirector));
    expect(other.body).toMatchObject({ enrolledPatients: 0, review: { flagged: 0, pct: null } });
    for (const token of [w.tokens.doctor, w.tokens.ministry, w.tokens.patient]) {
      expect((await api().get(`${BASE}/stats`).set(bearer(token))).status).toBe(403);
    }
  });
});
