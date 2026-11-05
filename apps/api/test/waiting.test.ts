import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  notifications,
  waitingListEntries,
  waitingListEvents,
} from '../src/db/schema.js';
import {
  isBreached,
  runBreachWarningsOnce,
  targetDateFor,
  waitingDays,
} from '../src/modules/waiting/waiting.service.js';
import { SMALL_CELL_THRESHOLD } from '../src/modules/stats/stats.service.js';
import { api, bearer, createPatient, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const DAY = 86_400_000;
const doctor = () => bearer(w.tokens.doctor);
const reception = () => bearer(w.tokens.reception);

beforeAll(async () => {
  w = await createWorld();
});

async function add(body: Record<string, unknown> = {}, token = w.tokens.doctor) {
  return api()
    .post('/api/v1/waiting-lists')
    .set(bearer(token))
    .send({
      patientId: w.patient.id,
      specialty: 'ORTHOPAEDICS',
      procedureName: `Knee replacement ${Math.random().toString(36).slice(2, 7)}`,
      priority: 'ROUTINE',
      clinicalReason: 'Severe osteoarthritis, failed conservative treatment',
      ...body,
    });
}

/** Moves an entry back in time (as if added `days` ago). */
async function age(id: string, days: number) {
  const addedAt = new Date(Date.now() - days * DAY);
  const [e] = await db.select().from(waitingListEntries).where(eq(waitingListEntries.id, id));
  await db
    .update(waitingListEntries)
    .set({
      addedAt,
      targetDate: targetDateFor(addedAt, e!.priority as 'ROUTINE', e!.suspendedDays),
    })
    .where(eq(waitingListEntries.id, id));
}

const events = async (id: string) =>
  (
    await db
      .select()
      .from(waitingListEvents)
      .where(eq(waitingListEvents.entryId, id))
      .orderBy(waitingListEvents.createdAt)
  ).map((e) => e.event);

describe('waiting-time rules', () => {
  it('computes waiting days without postponed days and the breach', () => {
    const now = new Date('2026-06-01T10:00:00Z');
    const base = {
      addedAt: new Date('2026-01-01T10:00:00Z'),
      status: 'WAITING',
      suspendedDays: 0,
      suspendedSince: null,
      completedAt: null,
      priority: 'PRIORITY',
    };
    expect(waitingDays(base, now)).toBe(151);
    expect(isBreached(base, now)).toBe(true);
    expect(waitingDays({ ...base, suspendedDays: 70 }, now)).toBe(81);
    expect(isBreached({ ...base, suspendedDays: 70 }, now)).toBe(false);
    // An open suspension pauses the clock too.
    expect(
      waitingDays(
        { ...base, status: 'SUSPENDED', suspendedSince: new Date('2026-05-02T10:00:00Z') },
        now,
      ),
    ).toBe(121);
    // Completed entries stop at the completion date.
    expect(
      waitingDays(
        { ...base, status: 'COMPLETED', completedAt: new Date('2026-01-31T10:00:00Z') },
        now,
      ),
    ).toBe(30);
    expect(targetDateFor(new Date('2026-01-01T10:00:00Z'), 'URGENT', 0)).toBe('2026-01-31');
    expect(targetDateFor(new Date('2026-01-01T10:00:00Z'), 'URGENT', 5)).toBe('2026-02-05');
  });
});

describe('adding to a waiting list', () => {
  it('adds with the target date of the priority and records an event and an audit entry', async () => {
    const res = await add({ priority: 'URGENT', procedureCode: 'NGB-1' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'WAITING',
      priority: 'URGENT',
      maxDays: 30,
      waitingDays: 0,
      breached: false,
      facilityId: w.facility.id,
    });
    expect(res.body.targetDate).toBe(targetDateFor(new Date(res.body.addedAt), 'URGENT', 0));
    expect(await events(res.body.id)).toEqual(['ADDED']);
    const logged = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.resourceId, res.body.id), eq(auditLogs.action, 'waiting_list.added')),
      );
    expect(logged).toHaveLength(1);
    expect(logged[0]!.patientId).toBe(w.patient.id);
  });

  it('validates input and refuses duplicates on the same list', async () => {
    expect((await add({ specialty: 'ASTROLOGY' })).status).toBe(400);
    expect((await add({ priority: 'SOON' })).status).toBe(400);
    expect((await add({ procedureName: 'x' })).status).toBe(400);
    const first = await add({
      procedureName: 'Cataract surgery, left eye',
      specialty: 'OPHTHALMOLOGY',
    });
    expect(first.status).toBe(201);
    const again = await add({
      procedureName: 'cataract surgery, LEFT eye',
      specialty: 'OPHTHALMOLOGY',
    });
    expect(again.status).toBe(409);
    // Another specialty is another list.
    expect(
      (await add({ procedureName: 'Cataract surgery, left eye', specialty: 'GENERAL_SURGERY' }))
        .status,
    ).toBe(201);
  });

  it('is only for doctors with access to the patient', async () => {
    expect((await add({}, w.tokens.reception)).status).toBe(403);
    expect((await add({}, w.tokens.nurse)).status).toBe(403);
    expect((await add({}, w.tokens.director)).status).toBe(403);
    // Not on the care team.
    expect((await add({ patientId: w.otherPatient.id })).status).toBe(403);
    expect((await add({}, w.tokens.outsideDoctor)).status).toBe(403);
    // A referral of another patient cannot be linked.
    expect((await add({ referralId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
  });
});

describe('lifecycle', () => {
  it('schedules, postpones (clock paused), resumes, reschedules and completes with a full history', async () => {
    const created = (await add({ priority: 'PRIORITY' })).body;
    await age(created.id, 40);
    const when = new Date(Date.now() + 14 * DAY).toISOString();
    const scheduled = await api()
      .post(`/api/v1/waiting-lists/${created.id}/schedule`)
      .set(reception())
      .send({ scheduledFor: when });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.status).toBe('SCHEDULED');
    // The patient is told the date and place, never the procedure.
    const told = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.patientUser.id));
    const n = told.find((x) => x.title.startsWith('Your planned treatment is scheduled'));
    expect(n).toBeDefined();
    expect(n!.title).not.toContain('Knee');

    const suspended = await api()
      .post(`/api/v1/waiting-lists/${created.id}/suspend`)
      .set(reception())
      .send({ reason: 'Patient travelling abroad until next month' });
    expect(suspended.body).toMatchObject({ status: 'SUSPENDED', scheduledFor: null });
    // Ten days of postponement.
    await db
      .update(waitingListEntries)
      .set({ suspendedSince: new Date(Date.now() - 10 * DAY) })
      .where(eq(waitingListEntries.id, created.id));
    const resumed = await api()
      .post(`/api/v1/waiting-lists/${created.id}/resume`)
      .set(reception())
      .send({});
    expect(resumed.body).toMatchObject({ status: 'WAITING', suspendedDays: 10, waitingDays: 30 });
    expect(resumed.body.targetDate).toBe(
      targetDateFor(new Date(resumed.body.addedAt), 'PRIORITY', 10),
    );

    // Not from a postponed state, and not into the past.
    expect(
      (
        await api()
          .post(`/api/v1/waiting-lists/${created.id}/schedule`)
          .set(reception())
          .send({ scheduledFor: new Date(Date.now() - 3 * DAY).toISOString() })
      ).status,
    ).toBe(400);
    await api()
      .post(`/api/v1/waiting-lists/${created.id}/schedule`)
      .set(doctor())
      .send({ scheduledFor: when });
    const unscheduled = await api()
      .post(`/api/v1/waiting-lists/${created.id}/unschedule`)
      .set(reception())
      .send({ reason: 'Theatre closed for maintenance' });
    expect(unscheduled.body.status).toBe('WAITING');
    const done = await api()
      .post(`/api/v1/waiting-lists/${created.id}/complete`)
      .set(doctor())
      .send({});
    expect(done.body.status).toBe('COMPLETED');
    expect(
      (await api().post(`/api/v1/waiting-lists/${created.id}/resume`).set(doctor()).send({}))
        .status,
    ).toBe(409);
    expect(await events(created.id)).toEqual([
      'ADDED',
      'SCHEDULED',
      'SUSPENDED',
      'RESUMED',
      'SCHEDULED',
      'UNSCHEDULED',
      'COMPLETED',
    ]);
    // The history is append-only.
    await expect(
      db
        .update(waitingListEvents)
        .set({ reason: 'x' })
        .where(eq(waitingListEvents.entryId, created.id)),
    ).rejects.toThrow();

    const detail = await api().get(`/api/v1/waiting-lists/${created.id}`).set(reception());
    expect(detail.body.events).toHaveLength(7);
    expect(detail.body.clinicalReason).toBeUndefined();
    expect(detail.body.patient.nationalId).toBe(w.patient.nationalId);
  });

  it('only doctors change the priority (target date recomputed from the date added)', async () => {
    const created = (await add({ priority: 'ROUTINE' })).body;
    await age(created.id, 50);
    expect(
      (
        await api()
          .post(`/api/v1/waiting-lists/${created.id}/priority`)
          .set(reception())
          .send({ priority: 'URGENT', reason: 'Worsening pain' })
      ).status,
    ).toBe(403);
    const res = await api()
      .post(`/api/v1/waiting-lists/${created.id}/priority`)
      .set(doctor())
      .send({ priority: 'URGENT', reason: 'Worsening pain, cannot walk' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ priority: 'URGENT', maxDays: 30, breached: true });
    expect(res.body.targetDate).toBe(targetDateFor(new Date(res.body.addedAt), 'URGENT', 0));
    expect(
      (
        await api()
          .post(`/api/v1/waiting-lists/${created.id}/priority`)
          .set(doctor())
          .send({ priority: 'URGENT', reason: 'Same again' })
      ).status,
    ).toBe(400);
  });

  it('reception removes for non-clinical reasons only', async () => {
    const created = (await add()).body;
    expect(
      (
        await api()
          .post(`/api/v1/waiting-lists/${created.id}/remove`)
          .set(reception())
          .send({ reasonCode: 'NO_LONGER_NEEDED' })
      ).status,
    ).toBe(403);
    const removed = await api()
      .post(`/api/v1/waiting-lists/${created.id}/remove`)
      .set(reception())
      .send({ reasonCode: 'TREATED_ELSEWHERE', reason: 'Operated privately' });
    expect(removed.body).toMatchObject({ status: 'REMOVED', removedReason: 'TREATED_ELSEWHERE' });
    const other = (await add()).body;
    expect(
      (
        await api()
          .post(`/api/v1/waiting-lists/${other.id}/remove`)
          .set(doctor())
          .send({ reasonCode: 'OTHER' })
      ).status,
    ).toBe(400);
    expect(
      (
        await api()
          .post(`/api/v1/waiting-lists/${other.id}/remove`)
          .set(doctor())
          .send({ reasonCode: 'NO_LONGER_NEEDED' })
      ).status,
    ).toBe(200);
  });

  it('keeps other facilities and other roles out', async () => {
    const created = (await add()).body;
    for (const token of [w.tokens.outsideDoctor, w.tokens.otherDirector]) {
      expect(
        (await api().get(`/api/v1/waiting-lists/${created.id}`).set(bearer(token))).status,
      ).toBe(404);
    }
    expect(
      (
        await api()
          .post(`/api/v1/waiting-lists/${created.id}/suspend`)
          .set(bearer(w.tokens.outsideDoctor))
          .send({ reason: 'Not my list' })
      ).status,
    ).toBe(404);
    for (const token of [
      w.tokens.nurse,
      w.tokens.pharmacist,
      w.tokens.ministry,
      w.tokens.patient,
    ]) {
      expect((await api().get('/api/v1/waiting-lists').set(bearer(token))).status).toBe(403);
    }
    expect(
      (
        await api()
          .post(`/api/v1/waiting-lists/${created.id}/schedule`)
          .set(bearer(w.tokens.director))
          .send({ scheduledFor: new Date(Date.now() + DAY).toISOString() })
      ).status,
    ).toBe(403);
    // The other facility's list does not contain this entry.
    const theirs = await api().get('/api/v1/waiting-lists').set(bearer(w.tokens.otherDirector));
    expect(theirs.body.items.some((e: { id: string }) => e.id === created.id)).toBe(false);
  });
});

describe('lists and dashboards', () => {
  it('sorts by priority then target date and filters breaches', async () => {
    const list = await api().get('/api/v1/waiting-lists').set(bearer(w.tokens.director));
    expect(list.status).toBe(200);
    const order = { URGENT: 0, PRIORITY: 1, ROUTINE: 2 } as Record<string, number>;
    const items = list.body.items as { priority: string; targetDate: string; breached: boolean }[];
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1]!;
      const b = items[i]!;
      expect(
        order[a.priority]! < order[b.priority]! ||
          (a.priority === b.priority && a.targetDate <= b.targetDate),
      ).toBe(true);
    }
    const breached = await api()
      .get('/api/v1/waiting-lists?breached=true')
      .set(bearer(w.tokens.director));
    expect(breached.body.items.length).toBeGreaterThan(0);
    expect(breached.body.items.every((e: { breached: boolean }) => e.breached)).toBe(true);
    const ortho = await api().get('/api/v1/waiting-lists?specialty=OPHTHALMOLOGY').set(reception());
    expect(
      ortho.body.items.every((e: { specialty: string }) => e.specialty === 'OPHTHALMOLOGY'),
    ).toBe(true);
  });

  it('gives the director per-specialty figures and the longest waits', async () => {
    const res = await api().get('/api/v1/waiting-lists/dashboard').set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    const ortho = res.body.bySpecialty.find(
      (r: { specialty: string }) => r.specialty === 'ORTHOPAEDICS',
    );
    expect(ortho.count).toBeGreaterThan(0);
    expect(ortho.breaches).toBeGreaterThanOrEqual(1);
    expect(typeof ortho.medianDays).toBe('number');
    expect(res.body.longestWaits.length).toBeGreaterThan(0);
    expect(res.body.longestWaits[0].breached).toBe(true);
    expect((await api().get('/api/v1/waiting-lists/dashboard').set(reception())).status).toBe(403);
  });

  it('gives the Ministry aggregates only, suppressing small groups', async () => {
    const res = await api().get('/api/v1/waiting-lists/national').set(bearer(w.tokens.ministry));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(w.patient.nationalId);
    const mine = res.body.byFacility.filter(
      (r: { facilityId: string }) => r.facilityId === w.facility.id,
    );
    expect(mine.length).toBeGreaterThan(0);
    for (const r of mine) {
      if (r.suppressed) expect(r.count).toBeNull();
      else expect(r.count).toBeGreaterThanOrEqual(SMALL_CELL_THRESHOLD);
    }
    // Ophthalmology at this facility has fewer than five entries.
    const eye = mine.find((r: { specialty: string }) => r.specialty === 'OPHTHALMOLOGY');
    expect(eye).toMatchObject({ suppressed: true, count: null, medianDays: null });
    expect(
      (await api().get('/api/v1/waiting-lists/national').set(bearer(w.tokens.director))).status,
    ).toBe(403);
  });

  it('publishes waiting times without sign-in and without personal data', async () => {
    // Six completed orthopaedic entries (enough to publish) and one dermatology entry (suppressed).
    const patients = await Promise.all(
      Array.from({ length: 7 }, () =>
        createPatient(w.facility.id, { doctorId: w.users.doctor.id }),
      ),
    );
    for (const [i, p] of patients.entries()) {
      const created = (
        await add({
          patientId: p.id,
          specialty: i < 6 ? 'UROLOGY' : 'DERMATOLOGY',
          procedureName: 'Planned procedure',
        })
      ).body;
      await age(created.id, 20 + i * 10);
      await api().post(`/api/v1/waiting-lists/${created.id}/complete`).set(doctor()).send({});
    }
    const res = await api().get('/api/v1/waiting-lists/public/times');
    expect(res.status).toBe(200);
    const rows = res.body.items.filter(
      (r: { facilityName: string }) => r.facilityName === w.facility.name,
    );
    const uro = rows.find((r: { specialty: string }) => r.specialty === 'UROLOGY');
    expect(uro).toMatchObject({ completed: 6, suppressed: false });
    expect(uro.medianDays).toBeGreaterThanOrEqual(40);
    const derm = rows.find((r: { specialty: string }) => r.specialty === 'DERMATOLOGY');
    expect(derm).toMatchObject({ completed: null, medianDays: null, suppressed: true });
    const text = JSON.stringify(res.body);
    for (const p of patients) {
      expect(text).not.toContain(p.nationalId);
      expect(text).not.toContain(p.id);
    }
    expect(text).not.toContain('patientId');
  });
});

describe('patient views', () => {
  it('shows the patient their own entries without queue positions or clinical notes', async () => {
    const res = await api().get('/api/v1/waiting-lists/mine').set(bearer(w.tokens.patient));
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    const e = res.body.items[0];
    expect(e).toHaveProperty('targetDate');
    expect(e).toHaveProperty('facilityName');
    expect(e).not.toHaveProperty('clinicalReason');
    expect(e).not.toHaveProperty('position');
    expect(e).not.toHaveProperty('addedById');
    const other = await api().get('/api/v1/waiting-lists/mine').set(bearer(w.tokens.otherPatient));
    expect(other.body.items).toEqual([]);
  });

  it('shows the chart tab with the clinical reason to the care team only', async () => {
    const res = await api().get(`/api/v1/waiting-lists/patients/${w.patient.id}`).set(doctor());
    expect(res.status).toBe(200);
    expect(res.body.items.some((e: { clinicalReason: string | null }) => e.clinicalReason)).toBe(
      true,
    );
    const desk = await api().get(`/api/v1/waiting-lists/patients/${w.patient.id}`).set(reception());
    expect(desk.status).toBe(200);
    expect(
      desk.body.items.every((e: { clinicalReason?: string }) => e.clinicalReason === undefined),
    ).toBe(true);
    expect(
      (
        await api()
          .get(`/api/v1/waiting-lists/patients/${w.patient.id}`)
          .set(bearer(w.tokens.colleague))
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .get(`/api/v1/waiting-lists/patients/${w.patient.id}`)
          .set(bearer(w.tokens.otherDirector))
      ).status,
    ).toBe(403);
  });
});

describe('breach warning worker', () => {
  it('warns the adding doctor once when 80% of the maximum wait has passed unscheduled', async () => {
    const created = (await add({ priority: 'URGENT' })).body;
    await age(created.id, 25);
    const fresh = (await add({ priority: 'URGENT' })).body;
    await age(fresh.id, 10);
    const sent = await runBreachWarningsOnce();
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(await events(created.id)).toContain('BREACH_WARNING');
    expect(await events(fresh.id)).not.toContain('BREACH_WARNING');
    const warned = (
      await db.select().from(notifications).where(eq(notifications.userId, w.users.doctor.id))
    ).filter((n) => n.link === `/waiting-lists?entry=${created.id}`);
    expect(warned).toHaveLength(1);
    expect(warned[0]!.title).not.toContain(w.patient.lastName);
    await runBreachWarningsOnce();
    expect((await events(created.id)).filter((e) => e === 'BREACH_WARNING')).toHaveLength(1);
  });
});
