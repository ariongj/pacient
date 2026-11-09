import { and, eq, like, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careAssignments,
  guardianships,
  notifications,
  promAssignments,
  promResponses,
} from '../src/db/schema.js';
import {
  bandOf,
  changeOf,
  dueState,
  INSTRUMENTS,
  nextDueAfter,
  scoreAnswers,
  validateAnswers,
} from '../src/modules/proms/instruments.js';
import { runPromRemindersOnce } from '../src/modules/proms/proms.service.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

const DAY = 86_400_000;
const BASE = '/api/v1/proms';
let w: Awaited<ReturnType<typeof createWorld>>;

const all = (n: number, value: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i + 1}`, value]));

beforeAll(async () => {
  w = await createWorld();
  await db.insert(careAssignments).values({ patientId: w.patient.id, doctorId: w.users.nurse.id });
});

const assign = (patientId: string, body: Record<string, unknown>, token = w.tokens.doctor) =>
  api().post(`${BASE}/patients/${patientId}/assignments`).set(bearer(token)).send(body);
const submit = (token: string, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  api()
    .post(`${BASE}/mine/responses`)
    .set({ ...bearer(token), ...extra })
    .send(body);

/* ---------------------------------------------------------------------------- scoring -- */

describe('scoring', () => {
  it('scores PHQ-9 with the standard bands and flags item 9', () => {
    expect(scoreAnswers('PHQ9', all(9, 0))).toEqual({
      score: 0,
      severity: 'MINIMAL',
      safetyFlag: false,
      advice: null,
    });
    const mild = { ...all(9, 0), q1: 2, q2: 2, q3: 1, q4: 1 };
    expect(scoreAnswers('PHQ9', mild).severity).toBe('MILD');
    expect(scoreAnswers('PHQ9', { ...all(9, 1), q1: 3, q2: 3 }).severity).toBe('MODERATE');
    expect(scoreAnswers('PHQ9', { ...all(9, 2), q9: 0, q1: 3 }).severity).toBe('MODERATELY_SEVERE');
    // Item 9 above zero: safety flag and crisis advice, whatever the total.
    expect(scoreAnswers('PHQ9', { ...all(9, 0), q9: 1 })).toMatchObject({
      score: 1,
      severity: 'MINIMAL',
      safetyFlag: true,
      advice: 'CRISIS',
    });
    // A severe total is flagged too, with the "contact your doctor" advice.
    expect(scoreAnswers('PHQ9', { ...all(9, 3), q9: 0 })).toMatchObject({
      score: 24,
      severity: 'SEVERE',
      safetyFlag: true,
      advice: 'HIGH',
    });
  });

  it('scores GAD-7, WHO-5 (percentage) and AUDIT-C (sex-specific cut-off)', () => {
    expect(scoreAnswers('GAD7', all(7, 1))).toMatchObject({ score: 7, severity: 'MILD' });
    expect(scoreAnswers('GAD7', all(7, 3))).toMatchObject({
      score: 21,
      severity: 'SEVERE',
      safetyFlag: false,
      advice: 'HIGH',
    });
    expect(scoreAnswers('WHO5', all(5, 5))).toMatchObject({ score: 100, severity: 'GOOD' });
    expect(scoreAnswers('WHO5', all(5, 2))).toMatchObject({ score: 40, severity: 'LOW' });
    expect(scoreAnswers('WHO5', all(5, 1))).toMatchObject({
      score: 20,
      severity: 'VERY_LOW',
      advice: 'HIGH',
    });
    expect(bandOf('AUDITC', 3, 'MALE')).toBe('LOWER_RISK');
    expect(bandOf('AUDITC', 3, 'FEMALE')).toBe('INCREASED_RISK');
    expect(bandOf('AUDITC', 4, 'MALE')).toBe('INCREASED_RISK');
    expect(bandOf('AUDITC', 9, 'FEMALE')).toBe('HIGH_RISK');
  });

  it('validates answers', () => {
    expect(() => validateAnswers('GAD7', all(6, 1))).toThrow('Please answer every question');
    expect(() => validateAnswers('GAD7', { ...all(7, 1), q3: 4 })).toThrow('not valid');
    expect(() => validateAnswers('GAD7', { ...all(7, 1), q8: 1 })).toThrow('Unknown');
    expect(() => validateAnswers('WHO5', { ...all(5, 1), q2: '3' })).toThrow('not valid');
    // AUDIT-C: someone who never drinks need not answer questions 2 and 3.
    expect(validateAnswers('AUDITC', { q1: 0 })).toEqual({ q1: 0, q2: 0, q3: 0 });
    expect(() => validateAnswers('AUDITC', { q1: 1 })).toThrow('Please answer every question');
  });

  it('tells clinically meaningful change apart, by direction', () => {
    expect(changeOf('PHQ9', 18, 12)).toEqual({
      previous: 18,
      difference: -6,
      meaningful: true,
      direction: 'BETTER',
    });
    expect(changeOf('PHQ9', 12, 14)).toMatchObject({ meaningful: false, direction: 'WORSE' });
    expect(changeOf('WHO5', 40, 52)).toMatchObject({ meaningful: true, direction: 'BETTER' });
    expect(changeOf('AUDITC', 6, 2)).toMatchObject({ meaningful: false, direction: 'BETTER' });
    expect(changeOf('GAD7', null, 5)).toBeNull();
  });

  it('plans due dates and states', () => {
    const at = new Date('2026-01-31T09:00:00Z');
    expect(nextDueAfter('WEEKLY', at)!.toISOString()).toBe('2026-02-07T09:00:00.000Z');
    expect(nextDueAfter('QUARTERLY', at)!.toISOString().slice(0, 7)).toBe('2026-05');
    expect(nextDueAfter('ONCE', at)).toBeNull();
    const now = new Date();
    const a = (days: number, frequency = 'MONTHLY') => ({
      status: 'ACTIVE',
      frequency,
      nextDueAt: new Date(now.getTime() + days * DAY),
    });
    expect(dueState(a(2), now)).toBe('UPCOMING');
    expect(dueState(a(-2), now)).toBe('DUE');
    expect(dueState(a(-8), now)).toBe('OVERDUE');
    expect(dueState(a(-4, 'WEEKLY'), now)).toBe('OVERDUE');
    expect(dueState({ status: 'ENDED', frequency: 'ONCE', nextDueAt: null }, now)).toBe('NONE');
  });

  it('publishes only licence-free instruments, marked as working translations', async () => {
    const res = await api().get(`${BASE}/instruments`).set(bearer(w.tokens.patient));
    expect(res.status).toBe(200);
    expect(res.body.instruments.map((i: { code: string }) => i.code)).toEqual([
      'PHQ9',
      'GAD7',
      'WHO5',
      'AUDITC',
    ]);
    expect(
      res.body.instruments.every((i: { translationStatus: string }) => i.translationStatus),
    ).toBe(true);
    expect(INSTRUMENTS.PHQ9.items[8]!.text.sq).toBeTruthy();
  });
});

/* ------------------------------------------------------------------------- assignments -- */

describe('assigning', () => {
  it('lets the care team ask, once per questionnaire, and tells the patient', async () => {
    const res = await assign(w.patient.id, { instrument: 'PHQ9', frequency: 'MONTHLY' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ instrument: 'PHQ9', status: 'ACTIVE', due: 'DUE' });
    expect((await assign(w.patient.id, { instrument: 'PHQ9', frequency: 'WEEKLY' })).status).toBe(
      409,
    );
    // Nurses of the care team may ask too.
    const nurse = await assign(
      w.patient.id,
      { instrument: 'WHO5', frequency: 'ONCE' },
      w.tokens.nurse,
    );
    expect(nurse.status).toBe(201);
    const told = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.patientUser.id),
          eq(notifications.type, 'prom_assigned'),
        ),
      );
    expect(told.length).toBe(2);
    const audited = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'prom.assigned'), eq(auditLogs.patientId, w.patient.id)));
    expect(audited.length).toBe(2);
  });

  it('validates and refuses staff without write access', async () => {
    expect((await assign(w.patient.id, { instrument: 'EQ5D', frequency: 'ONCE' })).status).toBe(
      400,
    );
    expect((await assign(w.patient.id, { instrument: 'GAD7', frequency: 'DAILY' })).status).toBe(
      400,
    );
    for (const token of [
      w.tokens.outsideDoctor,
      w.tokens.colleague,
      w.tokens.reception,
      w.tokens.pharmacist,
      w.tokens.director,
    ]) {
      expect(
        (await assign(w.patient.id, { instrument: 'GAD7', frequency: 'ONCE' }, token)).status,
      ).toBe(403);
    }
    expect(
      (await api().get(`${BASE}/patients/${w.patient.id}`).set(bearer(w.tokens.outsideDoctor)))
        .status,
    ).toBe(403);
  });

  it('changes the rhythm and ends a request with a reason', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const a = await assign(p.id, { instrument: 'GAD7', frequency: 'WEEKLY' });
    const changed = await api()
      .patch(`${BASE}/assignments/${a.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ frequency: 'QUARTERLY' });
    expect(changed.status).toBe(200);
    expect(changed.body.frequency).toBe('QUARTERLY');
    const end = (reason: unknown) =>
      api()
        .post(`${BASE}/assignments/${a.body.id}/end`)
        .set(bearer(w.tokens.doctor))
        .send({ reason });
    expect((await end('')).status).toBe(400);
    expect((await end('Symptoms resolved')).body).toMatchObject({ status: 'ENDED', due: 'NONE' });
    expect((await end('Again')).status).toBe(409);
    // A new request is possible once the old one has ended.
    expect((await assign(p.id, { instrument: 'GAD7', frequency: 'ONCE' })).status).toBe(201);
  });
});

/* ------------------------------------------------------------------------------ portal -- */

describe('answering in the portal', () => {
  it('scores, moves the due date on and shows the person their history', async () => {
    const answers = { ...all(9, 1), q9: 0 };
    const res = await submit(w.tokens.patient, { instrument: 'PHQ9', answers });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      response: { instrument: 'PHQ9', score: 8, severity: 'MILD' },
      advice: null,
      careTeamNotified: false,
      change: null,
    });
    const [a] = await db
      .select()
      .from(promAssignments)
      .where(
        and(eq(promAssignments.patientId, w.patient.id), eq(promAssignments.instrument, 'PHQ9')),
      );
    expect(a!.nextDueAt!.getTime()).toBeGreaterThan(Date.now() + 27 * DAY);
    // An unscheduled answer to the active request is accepted, with the change since last time.
    const again = await submit(w.tokens.patient, { instrument: 'PHQ9', answers: all(9, 0) });
    expect(again.body.change).toMatchObject({ previous: 8, difference: -8, meaningful: true });
    // A one-off questionnaire ends once answered.
    const who = await submit(w.tokens.patient, { instrument: 'WHO5', answers: all(5, 4) });
    expect(who.body.response).toMatchObject({ score: 80, severity: 'GOOD' });
    expect(
      (await submit(w.tokens.patient, { instrument: 'WHO5', answers: all(5, 4) })).status,
    ).toBe(404);
    const mine = await api().get(`${BASE}/mine`).set(bearer(w.tokens.patient));
    expect(mine.status).toBe(200);
    expect(mine.body.assignments.map((x: { instrument: string }) => x.instrument)).toEqual([
      'PHQ9',
    ]);
    expect(mine.body.responses).toHaveLength(3);
    expect(mine.body.responses[0]).not.toHaveProperty('reviewNote');
    const submitted = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'prom.submitted'), eq(auditLogs.patientId, w.patient.id)));
    expect(submitted).toHaveLength(3);
    expect(submitted[0]!.metadata).not.toHaveProperty('score');
  });

  it('refuses incomplete answers and questionnaires nobody asked for', async () => {
    expect(
      (await submit(w.tokens.patient, { instrument: 'PHQ9', answers: all(8, 1) })).status,
    ).toBe(400);
    expect(
      (await submit(w.tokens.patient, { instrument: 'AUDITC', answers: { q1: 0 } })).status,
    ).toBe(404);
    expect(
      (await submit(w.tokens.otherPatient, { instrument: 'PHQ9', answers: all(9, 0) })).status,
    ).toBe(404);
    expect(
      (
        await submit(
          w.tokens.otherPatient,
          { instrument: 'PHQ9', answers: all(9, 0) },
          { 'X-Acting-For': w.patient.id },
        )
      ).status,
    ).toBe(403);
  });

  it('flags thoughts of self-harm: crisis advice, care team told at once, review list first', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const user = await createUser('PATIENT');
    await db.execute(sql`UPDATE patients SET user_id = ${user.id} WHERE id = ${p.id}`);
    const token = await login(user.email);
    await db.insert(careAssignments).values({ patientId: p.id, doctorId: w.users.nurse.id });
    await assign(p.id, { instrument: 'PHQ9', frequency: 'MONTHLY' });
    const res = await submit(token, { instrument: 'PHQ9', answers: { ...all(9, 1), q9: 2 } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ advice: 'CRISIS', careTeamNotified: true });
    const alerts = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, 'prom_safety'), like(notifications.link, '%response=%')));
    const mine = alerts.filter((n) => n.link === `/proms?response=${res.body.response.id}`);
    expect(mine.map((n) => n.userId).sort()).toEqual([w.users.doctor.id, w.users.nurse.id].sort());
    expect(mine[0]!.title).toBe('A questionnaire answer needs your attention today');

    const list = await api().get(`${BASE}/review`).set(bearer(w.tokens.doctor));
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ id: res.body.response.id, safetyFlag: true });
    expect(list.body.counts.flagged).toBeGreaterThanOrEqual(1);
    // The colleague without a care relationship does not see it.
    const other = await api().get(`${BASE}/review`).set(bearer(w.tokens.colleague));
    expect(other.body.items.some((r: { id: string }) => r.id === res.body.response.id)).toBe(false);

    const review = (token2: string, note?: string) =>
      api()
        .post(`${BASE}/responses/${res.body.response.id}/review`)
        .set(bearer(token2))
        .send({ note });
    expect((await review(w.tokens.colleague)).status).toBe(403);
    const done = await review(w.tokens.doctor, 'Called the patient; seen today.');
    expect(done.status).toBe(200);
    expect(done.body.reviewedById).toBe(w.users.doctor.id);
    expect((await review(w.tokens.nurse)).status).toBe(409);
    const audited = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'prom.reviewed'), eq(auditLogs.patientId, p.id)));
    expect(audited).toHaveLength(1);
  });

  it('keeps submitted answers as answered', async () => {
    const [r] = await db
      .select()
      .from(promResponses)
      .where(eq(promResponses.patientId, w.patient.id))
      .limit(1);
    await expect(
      db.execute(sql`UPDATE prom_responses SET score = 99 WHERE id = ${r!.id}`),
    ).rejects.toThrow();
    await expect(db.execute(sql`DELETE FROM prom_responses WHERE id = ${r!.id}`)).rejects.toThrow();
  });
});

/* ---------------------------------------------------------------------------- guardians -- */

describe('guardians', () => {
  it('see and answer only non-sensitive questionnaires, and only with full access', async () => {
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
    await assign(child.id, { instrument: 'PHQ9', frequency: 'MONTHLY' });
    await assign(child.id, { instrument: 'WHO5', frequency: 'MONTHLY' });
    // The sensitive request is not announced to guardians; the WHO-5 one is.
    const told = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, full.id), eq(notifications.type, 'prom_assigned')));
    expect(told).toHaveLength(1);

    const fullToken = await login(full.email);
    const apptToken = await login(appts.email);
    const as = (token: string) => ({ ...bearer(token), 'X-Acting-For': child.id });
    const mine = await api().get(`${BASE}/mine`).set(as(fullToken));
    expect(mine.status).toBe(200);
    expect(mine.body.acting).toBe(true);
    expect(mine.body.assignments.map((a: { instrument: string }) => a.instrument)).toEqual([
      'WHO5',
    ]);
    expect(
      (
        await submit(
          fullToken,
          { instrument: 'PHQ9', answers: all(9, 0) },
          { 'X-Acting-For': child.id },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await submit(
          fullToken,
          { instrument: 'WHO5', answers: all(5, 3) },
          { 'X-Acting-For': child.id },
        )
      ).status,
    ).toBe(201);
    expect((await api().get(`${BASE}/mine`).set(as(apptToken))).status).toBe(403);
    expect(
      (
        await submit(
          apptToken,
          { instrument: 'WHO5', answers: all(5, 3) },
          { 'X-Acting-For': child.id },
        )
      ).status,
    ).toBe(403);
  });
});

/* ---------------------------------------------------------------------------- reminders -- */

describe('reminders', () => {
  it('reminds the patient once per due date and skips whole missed periods', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const user = await createUser('PATIENT');
    await db.execute(sql`UPDATE patients SET user_id = ${user.id} WHERE id = ${p.id}`);
    const created = await assign(p.id, {
      instrument: 'GAD7',
      frequency: 'WEEKLY',
      firstDueAt: new Date(Date.now() + DAY).toISOString(),
    });
    // Not due yet: no reminder (and no "assigned" notice for a future start).
    await runPromRemindersOnce();
    const count = async () =>
      (
        await db
          .select()
          .from(notifications)
          .where(and(eq(notifications.userId, user.id), like(notifications.type, 'prom_%')))
      ).length;
    expect(await count()).toBe(0);
    // Three weeks overdue: the due date moves to the last occasion, one reminder only.
    await db
      .update(promAssignments)
      .set({ nextDueAt: new Date(Date.now() - 20 * DAY) })
      .where(eq(promAssignments.id, created.body.id));
    await Promise.all([runPromRemindersOnce(), runPromRemindersOnce()]);
    await runPromRemindersOnce();
    expect(await count()).toBe(1);
    const [a] = await db
      .select()
      .from(promAssignments)
      .where(eq(promAssignments.id, created.body.id));
    expect(Date.now() - a!.nextDueAt!.getTime()).toBeLessThan(7 * DAY);
    expect(Date.now() - a!.nextDueAt!.getTime()).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------------------- views -- */

describe('views', () => {
  it('shows the chart section to the care team and audits it', async () => {
    const res = await api().get(`${BASE}/patients/${w.patient.id}`).set(bearer(w.tokens.nurse));
    expect(res.status).toBe(200);
    expect(res.body.responses.length).toBeGreaterThanOrEqual(3);
    expect(res.body.responses[0]).toHaveProperty('answers');
    expect(res.body.canAssign).toBe(true);
    const views = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorUserId, w.users.nurse.id),
          eq(auditLogs.patientId, w.patient.id),
          eq(auditLogs.action, 'patient.record.viewed'),
        ),
      );
    expect(views.length).toBeGreaterThan(0);
    for (const token of [w.tokens.reception, w.tokens.pharmacist, w.tokens.director]) {
      expect((await api().get(`${BASE}/patients/${w.patient.id}`).set(bearer(token))).status).toBe(
        403,
      );
    }
  });

  it('gives the director counts only, hiding small numbers', async () => {
    const res = await api().get(`${BASE}/stats`).set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { instrument: string }) => i.instrument)).toEqual([
      'PHQ9',
      'GAD7',
      'WHO5',
      'AUDITC',
    ]);
    // Requests made less than two weeks ago are not counted yet; nothing small is shown.
    for (const i of res.body.items) {
      for (const v of [i.asked, i.answered, i.responses, i.safetyFlags]) {
        expect(v === null || v === 0 || v >= 5).toBe(true);
      }
    }
    expect(JSON.stringify(res.body)).not.toContain(w.patient.lastName);
    for (const token of [w.tokens.doctor, w.tokens.ministry, w.tokens.patient]) {
      expect((await api().get(`${BASE}/stats`).set(bearer(token))).status).toBe(403);
    }
  });
});
