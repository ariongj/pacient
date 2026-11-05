import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careUnits,
  incidentActions,
  notifications,
  safetyIncidents,
} from '../src/db/schema.js';
import { monthKeys, suppressCells } from '../src/modules/incidents/incidents.service.js';
import { api, bearer, createFacility, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let unitId: string;
let otherUnitId: string;
const base = '/api/v1/incidents';
const as = (token: string) => bearer(token);
const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

const report = (token: string, body: Record<string, unknown> = {}) =>
  api()
    .post(base)
    .set(as(token))
    .send({
      occurredAt: hourAgo(),
      category: 'MEDICATION',
      harm: 'NO_HARM',
      description: 'Wrong strength of paracetamol was picked from the trolley and noticed.',
      ...body,
    });

const titlesFor = async (userId: string) =>
  (await db.select().from(notifications).where(eq(notifications.userId, userId))).map(
    (n) => n.title,
  );

beforeAll(async () => {
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({
      facilityId: w.facility.id,
      name: 'Interna Test',
      code: 'INT-T',
      type: 'GENERAL_WARD',
    })
    .returning();
  unitId = unit!.id;
  const [other] = await db
    .insert(careUnits)
    .values({
      facilityId: w.otherFacility.id,
      name: 'Other ward',
      code: 'OTH-T',
      type: 'GENERAL_WARD',
    })
    .returning();
  otherUnitId = other!.id;
});

describe('reporting', () => {
  it('validates the report and who may report', async () => {
    const future = await report(w.tokens.nurse, {
      occurredAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(future.status).toBe(400);
    expect((await report(w.tokens.nurse, { description: 'Too short' })).status).toBe(400);
    expect((await report(w.tokens.nurse, { category: 'GOSSIP' })).status).toBe(400);
    const foreignUnit = await report(w.tokens.nurse, { unitId: otherUnitId });
    expect(foreignUnit.status).toBe(400);
    expect((await report(w.tokens.patient)).status).toBe(403);
    expect((await report(w.tokens.ministry)).status).toBe(403);
    const ok = await report(w.tokens.nurse, { unitId, location: 'Room 4' });
    expect(ok.status).toBe(201);
    expect(ok.body.reference).toMatch(/^INC-\d{4}-\d{5}$/);
  });

  it('numbers reports per year without gaps or duplicates, also when concurrent', async () => {
    const results = await Promise.all(
      [
        w.tokens.doctor,
        w.tokens.nurse,
        w.tokens.pharmacist,
        w.tokens.reception,
        w.tokens.director,
      ].map((t) => report(t)),
    );
    const refs = results.map((r) => {
      expect(r.status).toBe(201);
      return r.body.reference as string;
    });
    expect(new Set(refs).size).toBe(5);
    const numbers = refs.map((r) => Number(r.slice(-5))).sort((a, b) => a - b);
    expect(numbers.at(-1)! - numbers[0]!).toBe(4);
  });

  it('stores no reporter for anonymous reports – not in the row, not in the audit trail', async () => {
    const res = await report(w.tokens.nurse, { anonymous: true, harm: 'LOW' });
    expect(res.status).toBe(201);
    const [row] = await db
      .select()
      .from(safetyIncidents)
      .where(eq(safetyIncidents.id, res.body.id));
    expect(row!.reportedById).toBeNull();
    expect(row!.anonymous).toBe(true);
    expect(row!.reporterRole).toBe('NURSE');
    const entries = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, res.body.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'incident.reported',
      actorUserId: null,
      actorRole: null,
      ipAddress: null,
      userAgent: null,
      requestId: null,
      actorFacilityId: w.facility.id,
    });
    const mine = await api().get(`${base}/mine`).set(as(w.tokens.nurse));
    expect(mine.body.items.map((i: { id: string }) => i.id)).not.toContain(res.body.id);
  });

  it('attaches a patient only for a carer, without revealing whether the ID exists', async () => {
    const attached = await report(w.tokens.doctor, { patientNationalId: w.patient.nationalId });
    expect(attached.status).toBe(201);
    const [row] = await db
      .select()
      .from(safetyIncidents)
      .where(eq(safetyIncidents.id, attached.body.id));
    expect(row!.patientId).toBe(w.patient.id);

    const notCaring = await report(w.tokens.colleague, { patientNationalId: w.patient.nationalId });
    const unknown = await report(w.tokens.colleague, { patientNationalId: '9999999999' });
    const reception = await report(w.tokens.reception, { patientNationalId: w.patient.nationalId });
    for (const r of [notCaring, unknown, reception]) expect(r.status).toBe(400);
    expect(notCaring.body.error.message).toBe(unknown.body.error.message);
    expect(reception.body.error.message).toBe(unknown.body.error.message);

    // Nothing about incidents appears in the patient's access log.
    const patientRows = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.patientId, w.patient.id), sql`${auditLogs.action} LIKE 'incident.%'`),
      );
    expect(patientRows).toHaveLength(0);
  });
});

describe('who sees what', () => {
  let incidentId: string;
  beforeAll(async () => {
    const res = await report(w.tokens.nurse, {
      harm: 'MODERATE',
      category: 'FALL',
      unitId,
      patientNationalId: undefined,
    });
    incidentId = res.body.id;
  });

  it('shows reporters their own named reports only, without review notes', async () => {
    const mine = await api().get(`${base}/mine`).set(as(w.tokens.nurse));
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((i: { id: string }) => i.id)).toBe(true);
    const own = await api().get(`${base}/${incidentId}`).set(as(w.tokens.nurse));
    expect(own.status).toBe(200);
    expect(own.body.viewerIsReviewer).toBe(false);
    expect(own.body).not.toHaveProperty('findings');
    expect(own.body).not.toHaveProperty('patient');
    // Colleagues, other facilities and patients cannot see it.
    for (const token of [w.tokens.colleague, w.tokens.otherDirector, w.tokens.patient]) {
      expect((await api().get(`${base}/${incidentId}`).set(as(token))).status).toBe(404);
    }
    const colleagueMine = await api().get(`${base}/mine`).set(as(w.tokens.colleague));
    expect(colleagueMine.body.items.map((i: { id: string }) => i.id)).not.toContain(incidentId);
  });

  it('gives the queue to the director and named safety leads of the facility only', async () => {
    const queue = await api().get(base).set(as(w.tokens.director));
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((i: { id: string }) => i.id)).toContain(incidentId);
    expect((await api().get(base).set(as(w.tokens.colleague))).status).toBe(403);
    expect((await api().get(base).set(as(w.tokens.otherDirector))).body.items).toEqual([]);
    expect((await api().get(base).set(as(w.tokens.ministry))).status).toBe(403);
    expect((await api().get(base).set(as(w.tokens.patient))).status).toBe(403);

    // The director names a safety lead.
    expect(
      (
        await api()
          .put(`${base}/reviewers`)
          .set(as(w.tokens.colleague))
          .send({ userIds: [w.users.colleague.id] })
      ).status,
    ).toBe(403);
    const foreign = await api()
      .put(`${base}/reviewers`)
      .set(as(w.tokens.director))
      .send({ userIds: [w.users.outsideDoctor.id] });
    expect(foreign.status).toBe(400);
    const named = await api()
      .put(`${base}/reviewers`)
      .set(as(w.tokens.director))
      .send({ userIds: [w.users.colleague.id] });
    expect(named.status).toBe(200);
    const list = await api().get(`${base}/reviewers`).set(as(w.tokens.director));
    expect(list.body.reviewers.map((r: { userId: string }) => r.userId)).toEqual([
      w.users.colleague.id,
    ]);
    const lead = await api().get(base).set(as(w.tokens.colleague));
    expect(lead.status).toBe(200);
    const detail = await api().get(`${base}/${incidentId}`).set(as(w.tokens.colleague));
    expect(detail.status).toBe(200);
    expect(detail.body.viewerIsReviewer).toBe(true);
    expect(detail.body.reporterName).toBe(w.users.nurse.fullName);
    const staff = await api().get(`${base}/staff`).set(as(w.tokens.colleague));
    expect(staff.body.reviewerIds).toEqual(
      expect.arrayContaining([w.users.director.id, w.users.colleague.id]),
    );
    expect(staff.body.staff.map((u: { id: string }) => u.id)).not.toContain(
      w.users.outsideDoctor.id,
    );
    expect((await api().get(`${base}/staff`).set(as(w.tokens.nurse))).status).toBe(403);
    const meta = await api().get(`${base}/meta`).set(as(w.tokens.colleague));
    expect(meta.body).toMatchObject({
      canReport: true,
      canReview: true,
      canManageReviewers: false,
    });
  });

  it('notifies the reviewers, with a priority title for severe harm', async () => {
    const severe = await report(w.tokens.nurse, { harm: 'SEVERE', category: 'FALL' });
    expect(severe.status).toBe(201);
    const directorTitles = await titlesFor(w.users.director.id);
    expect(directorTitles).toContain(
      `Serious safety incident reported: ${severe.body.reference} – review now`,
    );
    expect(await titlesFor(w.users.colleague.id)).toContain(
      `Serious safety incident reported: ${severe.body.reference} – review now`,
    );
    expect(await titlesFor(w.users.otherDirector.id)).not.toContain(
      `Serious safety incident reported: ${severe.body.reference} – review now`,
    );
    const routine = await report(w.tokens.doctor);
    expect(await titlesFor(w.users.director.id)).toContain(
      `New safety incident reported: ${routine.body.reference}`,
    );
  });
});

describe('review workflow', () => {
  let id: string;
  let reference: string;
  beforeAll(async () => {
    const res = await report(w.tokens.nurse, { harm: 'MODERATE', category: 'PRESSURE_INJURY' });
    id = res.body.id;
    reference = res.body.reference;
  });
  const patch = (token: string, body: Record<string, unknown>) =>
    api().patch(`${base}/${id}`).set(as(token)).send(body);

  it('moves through the states in order and tells the reporter', async () => {
    expect((await patch(w.tokens.director, { status: 'CLOSED' })).status).toBe(409);
    expect((await patch(w.tokens.nurse, { status: 'UNDER_REVIEW' })).status).toBe(404);
    const review = await patch(w.tokens.director, { status: 'UNDER_REVIEW' });
    expect(review.status).toBe(200);
    expect(review.body.reviewerId).toBe(w.users.director.id);
    expect(await titlesFor(w.users.nurse.id)).toContain(
      `Your incident report ${reference} is being reviewed`,
    );
    const noActions = await patch(w.tokens.director, { status: 'ACTION_PLANNED' });
    expect(noActions.status).toBe(400);

    const hazard = await patch(w.tokens.director, { hazardRef: 'hazard 17' });
    expect(hazard.status).toBe(400);
    const assign = await patch(w.tokens.director, { reviewerId: w.users.colleague.id });
    expect(assign.status).toBe(200);
    expect(await titlesFor(w.users.colleague.id)).toContain(
      `You were asked to review incident ${reference}`,
    );
    const notReviewer = await patch(w.tokens.director, { reviewerId: w.users.nurse.id });
    expect(notReviewer.status).toBe(400);
  });

  it('assigns actions to staff, who see and complete them', async () => {
    const foreign = await api()
      .post(`${base}/${id}/actions`)
      .set(as(w.tokens.colleague))
      .send({ description: 'Buy mattresses', ownerId: w.users.outsideDoctor.id });
    expect(foreign.status).toBe(400);
    const a1 = await api().post(`${base}/${id}/actions`).set(as(w.tokens.colleague)).send({
      description: 'Order pressure-relieving mattresses',
      ownerId: w.users.nurse.id,
      dueDate: '2020-01-01',
    });
    expect(a1.status).toBe(201);
    const a2 = await api()
      .post(`${base}/${id}/actions`)
      .set(as(w.tokens.colleague))
      .send({ description: 'Night-shift training on repositioning' });
    expect(a2.status).toBe(201);
    expect(await titlesFor(w.users.nurse.id)).toContain(
      `An action from incident ${reference} was assigned to you`,
    );
    const planned = await patch(w.tokens.colleague, { status: 'ACTION_PLANNED' });
    expect(planned.status).toBe(200);

    const mine = await api().get(`${base}/actions/mine`).set(as(w.tokens.nurse));
    expect(mine.body.items.map((a: { id: string }) => a.id)).toContain(a1.body.id);
    expect(mine.body.items[0]).not.toHaveProperty('incidentDescription');
    const rename = await api()
      .patch(`${base}/actions/${a1.body.id}`)
      .set(as(w.tokens.nurse))
      .send({ description: 'Something else' });
    expect(rename.status).toBe(403);
    const stranger = await api()
      .patch(`${base}/actions/${a1.body.id}`)
      .set(as(w.tokens.pharmacist))
      .send({ completed: true });
    expect(stranger.status).toBe(404);

    const dashboard = await api().get(`${base}/dashboard`).set(as(w.tokens.director));
    expect(dashboard.body.overdueActions.map((a: { id: string }) => a.id)).toContain(a1.body.id);
    const done = await api()
      .patch(`${base}/actions/${a1.body.id}`)
      .set(as(w.tokens.nurse))
      .send({ completed: true });
    expect(done.status).toBe(200);
    expect(done.body.completedAt).toBeTruthy();
  });

  it('closes only with findings, confirmed harm, open disclosure and every action handled', async () => {
    const noFindings = await patch(w.tokens.colleague, {
      status: 'CLOSED',
      reviewedHarm: 'MODERATE',
    });
    expect(noFindings.status).toBe(400);
    const noDisclosure = await patch(w.tokens.colleague, {
      status: 'CLOSED',
      reviewedHarm: 'MODERATE',
      findings: 'Repositioning every two hours was not done at night.',
    });
    expect(noDisclosure.status).toBe(400);
    expect(noDisclosure.body.error.message).toMatch(/open disclosure/);
    const before = await patch(w.tokens.colleague, {
      patientInformedAt: new Date(Date.now() - 86_400_000 * 30).toISOString(),
    });
    expect(before.status).toBe(400);
    // A refused close changes nothing, so each attempt sends the whole review.
    const review = {
      status: 'CLOSED',
      reviewedHarm: 'MODERATE',
      findings: 'Repositioning every two hours was not done at night.',
      patientInformedAt: new Date().toISOString(),
      lessons: 'Mattresses are checked at every admission.',
      contributingFactors: ['TEAM', 'ORGANISATIONAL'],
    };
    const openAction = await patch(w.tokens.colleague, review);
    expect(openAction.status).toBe(400);
    const actions = await db
      .select()
      .from(incidentActions)
      .where(eq(incidentActions.incidentId, id));
    const open = actions.filter((a) => !a.completedAt).map((a) => a.id);
    const closed = await patch(w.tokens.colleague, { ...review, carryOverActionIds: open });
    expect(closed.status).toBe(200);
    expect(closed.body.closedAt).toBeTruthy();
    expect(await titlesFor(w.users.nurse.id)).toContain(
      `Your incident report ${reference} was closed – see what was learned`,
    );
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, id), sql`${auditLogs.metadata}->>'to' = 'CLOSED'`));
    expect(entry!.metadata).toMatchObject({ carriedOverActionIds: open });
    expect(entry!.patientId).toBeNull();

    // The reporter now sees what was learned.
    const own = await api().get(`${base}/${id}`).set(as(w.tokens.nurse));
    expect(own.body.lessons).toBe('Mattresses are checked at every admission.');
    // Carried-over actions stay on the owner's list and can still be completed.
    const carried = await api()
      .patch(`${base}/actions/${open[0]}`)
      .set(as(w.tokens.colleague))
      .send({ completed: true });
    expect(carried.status).toBe(200);
  });

  it('is locked once closed; only the director reopens, with a reason', async () => {
    expect((await patch(w.tokens.colleague, { findings: 'Changed' })).status).toBe(409);
    expect(
      (
        await api()
          .post(`${base}/${id}/actions`)
          .set(as(w.tokens.director))
          .send({ description: 'Late action' })
      ).status,
    ).toBe(409);
    expect(
      (
        await patch(w.tokens.colleague, {
          status: 'UNDER_REVIEW',
          reopenReason: 'New information came up',
        })
      ).status,
    ).toBe(403);
    expect((await patch(w.tokens.director, { status: 'UNDER_REVIEW' })).status).toBe(400);
    const reopened = await patch(w.tokens.director, {
      status: 'UNDER_REVIEW',
      reopenReason: 'The family raised a new concern',
    });
    expect(reopened.status).toBe(200);
    expect(reopened.body.closedAt).toBeNull();
  });
});

describe('dashboards', () => {
  it('counts the facility for its reviewers', async () => {
    const res = await api().get(`${base}/dashboard`).set(as(w.tokens.director));
    expect(res.status).toBe(200);
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(safetyIncidents)
      .where(eq(safetyIncidents.facilityId, w.facility.id));
    expect(res.body.total).toBe(n);
    expect(res.body.byMonth).toHaveLength(12);
    expect(res.body.byMonth.at(-1).count).toBe(n);
    expect(res.body.byUnit.find((u: { key: string }) => u.key === 'Interna Test')).toBeTruthy();
    expect(res.body.timeToClose.closed).toBeGreaterThanOrEqual(0);
    expect((await api().get(`${base}/dashboard`).set(as(w.tokens.nurse))).status).toBe(403);
    expect((await api().get(`${base}/dashboard`).set(as(w.tokens.ministry))).status).toBe(403);
  });

  it('gives the Ministry national counts with small cells suppressed', async () => {
    // Five medication reports at a second facility – that cell is shown, one fall is not.
    const facility = await createFacility();
    const director = await createUser('DIRECTOR', facility.id);
    const token = await login(director.email);
    for (let i = 0; i < 5; i++) expect((await report(token)).status).toBe(201);
    const res = await api().get(`${base}/national`).set(as(w.tokens.ministry));
    expect(res.status).toBe(200);
    const counts = await db
      .select({ key: safetyIncidents.category, n: sql<number>`count(*)::int` })
      .from(safetyIncidents)
      .groupBy(safetyIncidents.category);
    for (const c of counts) {
      const cell = res.body.byCategory.find((x: { key: string }) => x.key === c.key);
      expect(cell).toEqual(
        c.n < 5
          ? { key: c.key, count: null, suppressed: true }
          : { key: c.key, count: c.n, suppressed: false },
      );
    }
    const mine = res.body.byFacility.find((f: { key: string }) => f.key === facility.name);
    expect(mine).toEqual({ key: facility.name, count: 5, suppressed: false });
    expect(JSON.stringify(res.body)).not.toContain('paracetamol');
    expect((await api().get(`${base}/national`).set(as(w.tokens.director))).status).toBe(403);
  });

  it('lists system incidents for the safety officer, text only after closure', async () => {
    const open = await report(w.tokens.nurse, {
      category: 'IT_SYSTEM',
      description: 'The scanner did not read the new wristbands for two hours on the ward.',
    });
    const res = await api().get(`${base}/national/it-system`).set(as(w.tokens.ministry));
    expect(res.status).toBe(200);
    const item = res.body.items.find((i: { id: string }) => i.id === open.body.id);
    expect(item).toMatchObject({ status: 'NEW', description: null, textWithheld: true });
    expect(item).not.toHaveProperty('patientId');
    expect(item).not.toHaveProperty('reportedById');
  });

  it('suppresses and orders months correctly', () => {
    expect(
      suppressCells([
        { key: 'A', count: 4 },
        { key: 'B', count: 5 },
        { key: 'C', count: 0 },
      ]),
    ).toEqual([
      { key: 'A', count: null, suppressed: true },
      { key: 'B', count: 5, suppressed: false },
      { key: 'C', count: 0, suppressed: false },
    ]);
    expect(monthKeys(3, new Date('2026-01-15T12:00:00Z'))).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
    ]);
  });
});
