import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { auditLogs, labResults, notifications, resultEscalations } from '../src/db/schema.js';
import { runEscalationOnce } from '../src/modules/cover/escalation.js';
import { buildOru } from '../src/ops/oru.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});

const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

/** An absent doctor with a patient, and a colleague at the same facility to cover. */
async function pair() {
  const away = await createUser('DOCTOR', w.facility.id);
  const coverer = await createUser('DOCTOR', w.facility.id);
  const patient = await createPatient(w.facility.id, { doctorId: away.id });
  return {
    away,
    coverer,
    patient,
    awayToken: await login(away.email),
    coverToken: await login(coverer.email),
  };
}

async function arrange(token: string, body: Record<string, unknown>) {
  return api().post('/api/v1/cover').set(bearer(token)).send(body);
}

async function insertResult(
  patientId: string,
  orderedById: string,
  opts: { flag?: 'CRITICAL' | 'NORMAL'; ageMinutes?: number } = {},
) {
  const at = new Date(Date.now() - (opts.ageMinutes ?? 0) * 60_000);
  const [row] = await db
    .insert(labResults)
    .values({
      patientId,
      orderedById,
      testName: 'Potassium',
      value: '6.9',
      unit: 'mmol/L',
      flag: opts.flag ?? 'CRITICAL',
      collectedAt: at,
      createdAt: at,
      updatedAt: at,
    })
    .returning();
  return row!;
}

const titlesFor = async (userId: string) =>
  (await db.select().from(notifications).where(eq(notifications.userId, userId))).map(
    (n) => n.title,
  );

describe('arranging cover', () => {
  it('lets a doctor arrange cover for themself and tells the colleague', async () => {
    const p = await pair();
    const res = await arrange(p.awayToken, {
      coverDoctorId: p.coverer.id,
      startsAt: iso(-HOUR),
      endsAt: iso(48 * HOUR),
      note: 'Conference',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ doctorId: p.away.id, coverDoctorId: p.coverer.id });
    expect((await titlesFor(p.coverer.id)).some((t) => t.startsWith('You are covering'))).toBe(
      true,
    );
    const mine = await api().get('/api/v1/cover').set(bearer(p.awayToken));
    expect(mine.body.mine[0]).toMatchObject({ coverDoctorName: p.coverer.fullName });
    const theirs = await api().get('/api/v1/cover').set(bearer(p.coverToken));
    expect(theirs.body.coveringFor[0]).toMatchObject({ doctorName: p.away.fullName });

    const overlap = await arrange(p.awayToken, {
      coverDoctorId: w.users.colleague.id,
      startsAt: iso(24 * HOUR),
      endsAt: iso(72 * HOUR),
    });
    expect(overlap.status).toBe(409);
  });

  it('enforces who can cover and for how long', async () => {
    const p = await pair();
    const base = { startsAt: iso(HOUR), endsAt: iso(5 * HOUR) };
    const cases: [string, Record<string, unknown>, number][] = [
      [p.awayToken, { ...base, coverDoctorId: w.users.outsideDoctor.id }, 400],
      [p.awayToken, { ...base, coverDoctorId: w.users.nurse.id }, 400],
      [p.awayToken, { ...base, coverDoctorId: p.away.id }, 400],
      [p.awayToken, { ...base, coverDoctorId: p.coverer.id, doctorId: w.users.doctor.id }, 403],
      [
        p.awayToken,
        { coverDoctorId: p.coverer.id, startsAt: iso(-5 * HOUR), endsAt: iso(-HOUR) },
        400,
      ],
      [
        p.awayToken,
        { coverDoctorId: p.coverer.id, startsAt: iso(HOUR), endsAt: iso(61 * 24 * HOUR) },
        400,
      ],
      [w.tokens.nurse, { ...base, coverDoctorId: p.coverer.id }, 403],
      [w.tokens.director, { ...base, coverDoctorId: p.coverer.id }, 400], // director must name the doctor
      [w.tokens.otherDirector, { ...base, coverDoctorId: p.coverer.id, doctorId: p.away.id }, 400],
    ];
    for (const [token, body, status] of cases) {
      const res = await arrange(token, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
    }
  });

  it('lets the director arrange and cancel cover for their staff', async () => {
    const p = await pair();
    const res = await arrange(w.tokens.director, {
      doctorId: p.away.id,
      coverDoctorId: p.coverer.id,
      startsAt: iso(HOUR),
      endsAt: iso(10 * HOUR),
    });
    expect(res.status).toBe(201);
    expect((await titlesFor(p.away.id)).some((t) => t.includes('will cover your results'))).toBe(
      true,
    );
    const list = await api().get('/api/v1/cover').set(bearer(w.tokens.director));
    expect(list.body.items.some((a: { id: string }) => a.id === res.body.id)).toBe(true);
    const other = await api().get('/api/v1/cover').set(bearer(w.tokens.otherDirector));
    expect(other.body.items.some((a: { id: string }) => a.id === res.body.id)).toBe(false);

    // A colleague who is not involved cannot cancel it; the director can.
    const stranger = await api()
      .post(`/api/v1/cover/${res.body.id}/cancel`)
      .set(bearer(w.tokens.colleague));
    expect(stranger.status).toBe(403);
    const cancel = await api()
      .post(`/api/v1/cover/${res.body.id}/cancel`)
      .set(bearer(w.tokens.director));
    expect(cancel.status).toBe(200);
    expect(cancel.body.cancelledAt).toBeTruthy();
    const again = await api()
      .post(`/api/v1/cover/${res.body.id}/cancel`)
      .set(bearer(w.tokens.director));
    expect(again.status).toBe(409);
  });

  it('lists colleagues at my facility only, without me', async () => {
    const res = await api().get('/api/v1/cover/colleagues').set(bearer(w.tokens.doctor));
    const ids = res.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(w.users.colleague.id);
    expect(ids).not.toContain(w.users.doctor.id);
    expect(ids).not.toContain(w.users.outsideDoctor.id);
    expect(ids).not.toContain(w.users.nurse.id);
  });
});

describe('access and worklist while covering', () => {
  it('gives care-team access only during the cover window', async () => {
    const p = await pair();
    const summary = () =>
      api().get(`/api/v1/patients/${p.patient.id}/summary`).set(bearer(p.coverToken));
    expect((await summary()).status).toBe(403);

    // Upcoming cover does not grant access yet.
    const later = await arrange(p.awayToken, {
      coverDoctorId: p.coverer.id,
      startsAt: iso(24 * HOUR),
      endsAt: iso(48 * HOUR),
    });
    expect(later.status).toBe(201);
    expect((await summary()).status).toBe(403);

    const now = await arrange(p.awayToken, {
      coverDoctorId: p.coverer.id,
      startsAt: iso(-HOUR),
      endsAt: iso(12 * HOUR),
    });
    expect(now.status).toBe(201);
    const ok = await summary();
    expect(ok.status).toBe(200);
    expect(ok.body.accessBasis).toBe('CARE_TEAM');

    // The audit trail (and so the patient's access log) records that it was through cover.
    const trail = await db.select().from(auditLogs).where(eq(auditLogs.patientId, p.patient.id));
    expect(
      trail.some(
        (a) =>
          a.actorUserId === p.coverer.id &&
          (a.metadata as Record<string, unknown> | null)?.via === 'COVER',
      ),
    ).toBe(true);

    // The cover doctor can review the absent doctor's result.
    const result = await insertResult(p.patient.id, p.away.id, { flag: 'NORMAL' });
    const work = await api().get('/api/v1/worklist').set(bearer(p.coverToken));
    const covered = work.body.coveredResults.find((r: { id: string }) => r.id === result.id);
    expect(covered).toMatchObject({ orderedBy: p.away.fullName, escalationLevel: 0 });
    const ack = await api()
      .post(`/api/v1/patients/${p.patient.id}/lab-results/${result.id}/acknowledge`)
      .set(bearer(p.coverToken))
      .send({});
    expect(ack.status).toBe(200);
    expect(ack.body.acknowledgedById).toBe(p.coverer.id);

    // Other patients of the facility stay closed; so does everything once cover is cancelled.
    const stranger = await createPatient(w.facility.id);
    expect(
      (await api().get(`/api/v1/patients/${stranger.id}/summary`).set(bearer(p.coverToken))).status,
    ).toBe(403);
    await api().post(`/api/v1/cover/${now.body.id}/cancel`).set(bearer(p.awayToken));
    expect((await summary()).status).toBe(403);
    const after = await api().get('/api/v1/worklist').set(bearer(p.coverToken));
    expect(after.body.coveredResults).toEqual([]);
  });

  it('sends laboratory alerts to the covering doctor too', async () => {
    const p = await pair();
    await arrange(p.awayToken, {
      coverDoctorId: p.coverer.id,
      startsAt: iso(-HOUR),
      endsAt: iso(HOUR * 8),
    });
    const client = await api()
      .post('/api/v1/integrations/clients')
      .set(bearer(w.tokens.director))
      .send({ name: 'Cover test laboratory' });
    const order = await api()
      .post(`/api/v1/patients/${p.patient.id}/lab-orders`)
      .set(bearer(p.awayToken))
      .send({ testCode: '2823-3', priority: 'STAT' });
    expect(order.status).toBe(201);
    const res = await api()
      .post('/api/v1/integrations/lab/results')
      .set({ Authorization: `Bearer ${client.body.apiKey}` })
      .set('Content-Type', 'application/hl7-v2')
      .send(
        buildOru({
          controlId: `COV${Date.now()}`,
          placerOrderNumber: order.body.placerOrderNumber,
          patient: p.patient,
          observations: [
            { code: '2823-3', name: 'Potassium', value: '6.8', unit: 'mmol/L', flag: 'HH' },
          ],
        }),
      );
    expect(res.headers['x-pacient-status']).toBe('ACCEPTED');
    expect(await titlesFor(p.away.id)).toContain('CRITICAL laboratory result – review now');
    expect(await titlesFor(p.coverer.id)).toContain(
      `CRITICAL laboratory result – review now (covering for ${p.away.fullName})`,
    );
  });
});

describe('critical-result escalation', () => {
  const levels = async (resultId: string) =>
    (
      await db
        .select({ level: resultEscalations.level })
        .from(resultEscalations)
        .where(eq(resultEscalations.labResultId, resultId))
    )
      .map((r) => r.level)
      .sort();

  it('escalates unreviewed critical results once per level, and the director last', async () => {
    const p = await pair();
    const teamDoctor = await createUser('DOCTOR', w.facility.id);
    const joined = await api()
      .post(`/api/v1/patients/${p.patient.id}/care-team`)
      .set(bearer(w.tokens.director))
      .send({ doctorId: teamDoctor.id });
    expect(joined.status).toBeLessThan(300);
    await arrange(p.awayToken, {
      coverDoctorId: p.coverer.id,
      startsAt: iso(-HOUR),
      endsAt: iso(8 * HOUR),
    });
    const result = await insertResult(p.patient.id, p.away.id, { ageMinutes: 5 });

    await runEscalationOnce();
    expect(await levels(result.id)).toEqual([]);

    const in30 = new Date(Date.now() + 31 * 60_000);
    await runEscalationOnce(in30);
    expect(await levels(result.id)).toEqual([1]);
    for (const id of [p.away.id, p.coverer.id, teamDoctor.id]) {
      expect(await titlesFor(id)).toContain('Critical result still not reviewed (30 min)');
    }
    const before = (await titlesFor(p.away.id)).length;
    await runEscalationOnce(in30); // idempotent
    expect((await titlesFor(p.away.id)).length).toBe(before);
    expect((await titlesFor(w.users.director.id)).some((t) => t.includes(p.away.fullName))).toBe(
      false,
    );

    await runEscalationOnce(new Date(Date.now() + 121 * 60_000));
    expect(await levels(result.id)).toEqual([1, 2]);
    const directorTitles = await titlesFor(w.users.director.id);
    const forDirector = directorTitles.find((t) => t.includes(p.away.fullName))!;
    expect(forDirector).toBe(
      `A critical result has waited 2 hours for review – contact ${p.away.fullName}`,
    );
    expect(forDirector).not.toContain(p.patient.lastName);
    expect(await titlesFor(w.users.otherDirector.id)).not.toContain(forDirector);
  });

  it('never escalates acknowledged, superseded or non-critical results', async () => {
    const p = await pair();
    const acked = await insertResult(p.patient.id, p.away.id, { ageMinutes: 200 });
    await db
      .update(labResults)
      .set({ acknowledgedAt: new Date(), acknowledgedById: p.away.id })
      .where(eq(labResults.id, acked.id));
    const normal = await insertResult(p.patient.id, p.away.id, { flag: 'NORMAL', ageMinutes: 200 });
    await runEscalationOnce();
    expect(await levels(acked.id)).toEqual([]);
    expect(await levels(normal.id)).toEqual([]);
  });

  it('shows directors waiting critical results without patient identity', async () => {
    const p = await pair();
    await arrange(p.awayToken, {
      coverDoctorId: p.coverer.id,
      startsAt: iso(-HOUR),
      endsAt: iso(8 * HOUR),
    });
    const waiting = await insertResult(p.patient.id, p.away.id, { ageMinutes: 45 });
    const fresh = await insertResult(p.patient.id, p.away.id, { ageMinutes: 5 });
    await runEscalationOnce();

    const res = await api().get('/api/v1/cover/escalations').set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: { id: string }) => i.id === waiting.id);
    expect(item).toMatchObject({
      orderingDoctor: p.away.fullName,
      level: 1,
      coveredBy: [p.coverer.fullName],
    });
    expect(item.minutesWaiting).toBeGreaterThanOrEqual(44);
    expect(res.body.items.some((i: { id: string }) => i.id === fresh.id)).toBe(false);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(p.patient.lastName);
    expect(json).not.toContain('6.9');
    expect(Object.keys(item).sort()).toEqual(
      ['coveredBy', 'id', 'level', 'minutesWaiting', 'orderingDoctor'].sort(),
    );

    const other = await api().get('/api/v1/cover/escalations').set(bearer(w.tokens.otherDirector));
    expect(other.body.items.some((i: { id: string }) => i.id === waiting.id)).toBe(false);
    expect((await api().get('/api/v1/cover/escalations').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
  });
});
