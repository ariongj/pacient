import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  advanceDirectives,
  auditLogs,
  careUnits,
  edVisits,
  guardianships,
  notifications,
  organDonationDecisions,
  patientDocuments,
  patients,
  unitStaff,
} from '../src/db/schema.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let minor: typeof patients.$inferSelect;
let minorUserToken: string;
let deceasedToken: string;
let parentToken: string;
let child: typeof patients.$inferSelect;
let edNurseToken: string;
let edUnitId: string;

const pp = () => `/api/v1/directives/patients/${w.patient.id}`;
const as = (token: string) => bearer(token);

beforeAll(async () => {
  w = await createWorld();
  // A 16-year-old with their own portal account.
  const minorUser = await createUser('PATIENT');
  minor = (
    await db
      .insert(patients)
      .values({
        nationalId: `9${Date.now()}`.slice(0, 10),
        firstName: 'Blerta',
        lastName: 'Hasani',
        dateOfBirth: `${new Date().getFullYear() - 16}-03-01`,
        sex: 'FEMALE',
        primaryFacilityId: w.facility.id,
        userId: minorUser.id,
      })
      .returning()
  )[0]!;
  minorUserToken = await login(minorUser.email);
  // A deceased adult with an account (it is normally disabled; enough to test the rule).
  const deceasedUser = await createUser('PATIENT');
  await createPatient(w.facility.id, { userId: deceasedUser.id }).then((p) =>
    db.update(patients).set({ deceasedAt: new Date() }).where(eq(patients.id, p.id)),
  );
  deceasedToken = await login(deceasedUser.email);
  // A child with a parent who has full guardian access.
  child = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  await db
    .update(patients)
    .set({ dateOfBirth: `${new Date().getFullYear() - 7}-01-15` })
    .where(eq(patients.id, child.id));
  const parent = await createUser('PATIENT');
  await db.insert(guardianships).values({
    patientId: child.id,
    guardianUserId: parent.id,
    relationship: 'PARENT',
    evidence: 'Birth certificate 3/2019',
    verifiedById: w.users.reception.id,
    validUntil: new Date(Date.now() + 365 * 86_400_000),
  });
  parentToken = await login(parent.email);
  // Emergency department with one assigned nurse.
  const [unit] = await db
    .insert(careUnits)
    .values({
      facilityId: w.facility.id,
      name: 'Emergjenca',
      code: `ED${Date.now() % 100000}`,
      type: 'EMERGENCY',
    })
    .returning();
  edUnitId = unit!.id;
  const edNurse = await createUser('NURSE', w.facility.id);
  await db.insert(unitStaff).values({ unitId: unit!.id, userId: edNurse.id });
  edNurseToken = await login(edNurse.email);
  // The ward nurse joins the patient's care team.
  await api()
    .post(`/api/v1/patients/${w.patient.id}/care-team`)
    .set(bearer(w.tokens.nurse))
    .send({})
    .expect(201);
});

describe('organ donation in the portal', () => {
  it('lets an adult register and change their decision, keeping the history', async () => {
    const mine = await api().get('/api/v1/directives/mine').set(as(w.tokens.patient));
    expect(mine.status).toBe(200);
    expect(mine.body.donation).toMatchObject({ eligible: true, current: null, history: [] });

    const missingOrgans = await api()
      .post('/api/v1/directives/mine/organ-donation')
      .set(as(w.tokens.patient))
      .send({ decision: 'DONOR_SOME' });
    expect(missingOrgans.status).toBe(400);

    const first = await api()
      .post('/api/v1/directives/mine/organ-donation')
      .set(as(w.tokens.patient))
      .send({ decision: 'DONOR_SOME', organs: ['KIDNEYS', 'CORNEAS'], familyInformed: true });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ recordedVia: 'PORTAL', organs: ['KIDNEYS', 'CORNEAS'] });
    const second = await api()
      .post('/api/v1/directives/mine/organ-donation')
      .set(as(w.tokens.patient))
      .send({ decision: 'DONOR', organs: ['HEART'] });
    expect(second.status).toBe(201);
    // Organs are only kept for "some organs".
    expect(second.body.organs).toBeNull();

    const after = await api().get('/api/v1/directives/mine').set(as(w.tokens.patient));
    expect(after.body.donation.current.decision).toBe('DONOR');
    expect(after.body.donation.history.map((h: { decision: string }) => h.decision)).toEqual([
      'DONOR',
      'DONOR_SOME',
    ]);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.patientId, w.patient.id), eq(auditLogs.action, 'donation.recorded')));
    expect(audits).toHaveLength(2);
  });

  it('keeps decisions append-only', async () => {
    const [row] = await db
      .select()
      .from(organDonationDecisions)
      .where(eq(organDonationDecisions.patientId, w.patient.id))
      .limit(1);
    await expect(
      db
        .update(organDonationDecisions)
        .set({ decision: 'NOT_DONOR' })
        .where(eq(organDonationDecisions.id, row!.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(organDonationDecisions).where(eq(organDonationDecisions.id, row!.id)),
    ).rejects.toThrow();
  });

  it('refuses minors, deceased people and guardians', async () => {
    const m = await api().get('/api/v1/directives/mine').set(as(minorUserToken));
    expect(m.body.donation).toMatchObject({ eligible: false, reason: 'MINOR' });
    const mPost = await api()
      .post('/api/v1/directives/mine/organ-donation')
      .set(as(minorUserToken))
      .send({ decision: 'DONOR' });
    expect(mPost.status).toBe(409);
    expect(minor.id).toBeTruthy();

    const d = await api()
      .post('/api/v1/directives/mine/organ-donation')
      .set(as(deceasedToken))
      .send({ decision: 'DONOR' });
    expect(d.status).toBe(409);

    const g = await api()
      .get('/api/v1/directives/mine')
      .set({ ...as(parentToken), 'X-Acting-For': child.id });
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ acting: true, donation: { eligible: false, history: [] } });
    const gPost = await api()
      .post('/api/v1/directives/mine/organ-donation')
      .set({ ...as(parentToken), 'X-Acting-For': child.id })
      .send({ decision: 'DONOR' });
    expect(gPost.status).toBe(403);
  });
});

describe('who sees the organ donation decision', () => {
  it('is not part of the chart; doctors consult the register explicitly and it is audited', async () => {
    const chart = await api().get(pp()).set(as(w.tokens.doctor));
    expect(chart.status).toBe(200);
    expect(JSON.stringify(chart.body)).not.toContain('DONOR');

    const noPurpose = await api()
      .post(`${pp()}/organ-donation/check`)
      .set(as(w.tokens.doctor))
      .send({});
    expect(noPurpose.status).toBe(400);
    const check = await api()
      .post(`${pp()}/organ-donation/check`)
      .set(as(w.tokens.doctor))
      .send({ purpose: 'END_OF_LIFE_CARE', note: 'Palliative care planning' });
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({
      registered: true,
      current: { decision: 'DONOR' },
      changes: 2,
    });
    const [logged] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.patientId, w.patient.id),
          eq(auditLogs.resourceType, 'organ_donation'),
          eq(auditLogs.actorUserId, w.users.doctor.id),
        ),
      );
    expect(logged).toMatchObject({ action: 'patient.record.viewed' });
    expect(logged!.metadata).toMatchObject({ purpose: 'END_OF_LIFE_CARE' });

    // The patient sees the check in their access log.
    const log = await api().get('/api/v1/portal/access-log').set(as(w.tokens.patient));
    expect(log.status).toBe(200);
    expect(JSON.stringify(log.body)).toContain(w.users.doctor.fullName);

    for (const token of [w.tokens.nurse, w.tokens.outsideDoctor, w.tokens.ministry]) {
      const denied = await api()
        .post(`${pp()}/organ-donation/check`)
        .set(as(token))
        .send({ purpose: 'TRANSPLANT_COORDINATION' });
      expect(denied.status).toBe(403);
    }
  });

  it('gives the Ministry aggregates only, with small numbers suppressed', async () => {
    const stats = await api().get('/api/v1/directives/registry/stats').set(as(w.tokens.ministry));
    expect(stats.status).toBe(200);
    const text = JSON.stringify(stats.body);
    expect(text).not.toContain(w.patient.nationalId);
    expect(text).not.toContain(w.patient.id);
    const counts: (number | null)[] = [
      stats.body.registered,
      stats.body.donors,
      ...stats.body.byDecision.map((d: { count: number | null }) => d.count),
      ...stats.body.byAgeBand.map((b: { registered: number | null }) => b.registered),
    ];
    for (const c of counts) if (c !== null) expect(c === 0 || c >= 5).toBe(true);

    // With enough registrations the national figures appear.
    for (let i = 0; i < 6; i++) {
      const p = await createPatient(w.facility.id);
      await db.insert(organDonationDecisions).values({
        patientId: p.id,
        decision: i % 3 === 0 ? 'NOT_DONOR' : 'DONOR',
        recordedVia: 'IN_PERSON',
        recordedByUserId: w.users.reception.id,
      });
    }
    const more = await api().get('/api/v1/directives/registry/stats').set(as(w.tokens.ministry));
    expect(more.body.registered).toBeGreaterThanOrEqual(7);
    expect(more.body.donorPctOfRegistered).toBeGreaterThan(0);

    for (const token of [w.tokens.director, w.tokens.doctor, w.tokens.patient]) {
      expect((await api().get('/api/v1/directives/registry/stats').set(as(token))).status).toBe(
        403,
      );
    }
  });

  it('records a decision in person with the person present', async () => {
    const url = `/api/v1/directives/patients/${w.otherPatient.id}/organ-donation`;
    const absent = await api().post(url).set(as(w.tokens.reception)).send({ decision: 'DONOR' });
    expect(absent.status).toBe(400);
    const ok = await api()
      .post(url)
      .set(as(w.tokens.reception))
      .send({ decision: 'NOT_DONOR', personPresent: true });
    expect(ok.status).toBe(201);
    expect(ok.body).not.toHaveProperty('decision');
    const outside = await api()
      .post(url)
      .set(as(w.tokens.otherDirector))
      .send({ decision: 'DONOR', personPresent: true });
    expect(outside.status).toBe(403);
    const minorRec = await api()
      .post(`/api/v1/directives/patients/${minor.id}/organ-donation`)
      .set(as(w.tokens.reception))
      .send({ decision: 'DONOR', personPresent: true });
    expect(minorRec.status).toBe(409);
    const mine = await api().get('/api/v1/directives/mine').set(as(w.tokens.otherPatient));
    expect(mine.body.donation.current).toMatchObject({
      decision: 'NOT_DONOR',
      recordedVia: 'IN_PERSON',
      recordedByRole: 'RECEPTION',
    });
  });
});

describe('advance directives', () => {
  let dnacprId: string;

  it('lets only doctors record DNACPR, with who it was discussed with', async () => {
    const body = {
      kind: 'DNACPR',
      summary: 'Do not attempt CPR: advanced heart failure, agreed after discussion.',
      discussedWith: 'Patient and daughter',
      reviewDate: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
    };
    expect((await api().post(pp()).set(as(w.tokens.nurse)).send(body)).status).toBe(403);
    expect((await api().post(pp()).set(as(w.tokens.outsideDoctor)).send(body)).status).toBe(403);
    expect(
      (
        await api()
          .post(pp())
          .set(as(w.tokens.doctor))
          .send({ ...body, discussedWith: '' })
      ).status,
    ).toBe(400);
    const pastReview = await api()
      .post(pp())
      .set(as(w.tokens.doctor))
      .send({ ...body, reviewDate: '2020-01-01' });
    expect(pastReview.status).toBe(400);
    const res = await api().post(pp()).set(as(w.tokens.doctor)).send(body);
    expect(res.status).toBe(201);
    dnacprId = res.body.id;
    const again = await api().post(pp()).set(as(w.tokens.doctor)).send(body);
    expect(again.status).toBe(409);
  });

  it('shows the flag to the care team and tells the patient without alarming wording', async () => {
    const flags = await api().get(`${pp()}/flags`).set(as(w.tokens.nurse));
    expect(flags.status).toBe(200);
    expect(flags.body.items).toEqual([
      expect.objectContaining({ id: dnacprId, kind: 'DNACPR', reviewDue: false }),
    ]);
    for (const token of [w.tokens.reception, w.tokens.director, w.tokens.pharmacist]) {
      expect((await api().get(`${pp()}/flags`).set(as(token))).status).toBe(403);
      expect((await api().get(pp()).set(as(token))).status).toBe(403);
    }
    const notes = await db
      .select({ title: notifications.title })
      .from(notifications)
      .where(eq(notifications.userId, w.users.patientUser.id));
    const titles = notes.map((n) => n.title).join(' | ');
    expect(titles).toMatch(/decision about your care was recorded|vendim për kujdesin tuaj/);
    expect(titles).not.toMatch(/DNACPR|resuscitat|ringjall/i);
    const portal = await api().get('/api/v1/directives/mine').set(as(w.tokens.patient));
    expect(portal.body.directives).toEqual([
      expect.objectContaining({ id: dnacprId, kind: 'DNACPR', status: 'ACTIVE' }),
    ]);
  });

  it('never edits a directive: it is revoked with a reason', async () => {
    await expect(
      db
        .update(advanceDirectives)
        .set({ summary: 'changed' })
        .where(eq(advanceDirectives.id, dnacprId)),
    ).rejects.toThrow();
    await expect(
      db.delete(advanceDirectives).where(eq(advanceDirectives.id, dnacprId)),
    ).rejects.toThrow();
    const patientTry = await api()
      .post(`/api/v1/directives/mine/directives/${dnacprId}/revoke`)
      .set(as(w.tokens.patient))
      .send({ reason: 'I would like this changed' });
    expect(patientTry.status).toBe(403);
    expect(
      (
        await api()
          .post(`/api/v1/directives/${dnacprId}/revoke`)
          .set(as(w.tokens.nurse))
          .send({ reason: 'Not mine to revoke' })
      ).status,
    ).toBe(403);
    const revoked = await api()
      .post(`/api/v1/directives/${dnacprId}/revoke`)
      .set(as(w.tokens.doctor))
      .send({ reason: 'Condition improved after treatment; reviewed with the patient' });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: 'REVOKED' });
    const twice = await api()
      .post(`/api/v1/directives/${dnacprId}/revoke`)
      .set(as(w.tokens.doctor))
      .send({ reason: 'Again' });
    expect(twice.status).toBe(409);
    expect((await api().get(`${pp()}/flags`).set(as(w.tokens.doctor))).body.items).toEqual([]);
    const list = await api().get(pp()).set(as(w.tokens.doctor));
    expect(list.body.items[0]).toMatchObject({
      status: 'REVOKED',
      revokeReason: expect.any(String),
    });
  });

  it('lets nurses record a healthcare proxy and checks linked documents', async () => {
    const proxy = await api().post(pp()).set(as(w.tokens.nurse)).send({
      kind: 'HEALTHCARE_PROXY',
      summary: 'Husband to be consulted about care decisions',
      proxyName: 'Driton Gashi',
      proxyPhone: '044 123 456',
    });
    expect(proxy.status).toBe(201);
    const nurseRefusal = await api()
      .post(pp())
      .set(as(w.tokens.nurse))
      .send({ kind: 'ADVANCE_REFUSAL', summary: 'Refuses blood transfusion' });
    expect(nurseRefusal.status).toBe(403);
    const [otherDoc] = await db
      .insert(patientDocuments)
      .values({
        patientId: w.otherPatient.id,
        category: 'OTHER',
        title: 'Not this patient',
        fileName: 'x.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
        sha256: 'a'.repeat(64),
        uploadedById: w.users.doctor.id,
      })
      .returning();
    const wrongDoc = await api().post(pp()).set(as(w.tokens.doctor)).send({
      kind: 'ADVANCE_REFUSAL',
      summary: 'Refuses blood transfusion (signed statement)',
      documentId: otherDoc!.id,
    });
    expect(wrongDoc.status).toBe(400);
    const refusal = await api()
      .post(pp())
      .set(as(w.tokens.doctor))
      .send({ kind: 'ADVANCE_REFUSAL', summary: 'Refuses blood transfusion (signed statement)' });
    expect(refusal.status).toBe(201);
    // The patient may withdraw their own refusal; a second proxy is refused until the first goes.
    const portalProxy = await api()
      .post('/api/v1/directives/mine/healthcare-proxy')
      .set(as(w.tokens.patient))
      .send({ proxyName: 'Someone else' });
    expect(portalProxy.status).toBe(409);
    const withdraw = await api()
      .post(`/api/v1/directives/mine/directives/${refusal.body.id}/revoke`)
      .set(as(w.tokens.patient))
      .send({ reason: 'I have changed my mind' });
    expect(withdraw.status).toBe(200);
  });

  it('lets an adult name a healthcare proxy in the portal, but not a minor or a guardian', async () => {
    const res = await api()
      .post('/api/v1/directives/mine/healthcare-proxy')
      .set(as(w.tokens.otherPatient))
      .send({ proxyName: 'Vjosa Berisha', relationship: 'Sister', proxyPhone: '049 111 222' });
    expect(res.status).toBe(201);
    const list = await api().get('/api/v1/directives/mine').set(as(w.tokens.otherPatient));
    expect(list.body.directives[0]).toMatchObject({
      kind: 'HEALTHCARE_PROXY',
      proxyName: 'Vjosa Berisha',
      selfRegistered: true,
    });
    expect(
      (
        await api()
          .post('/api/v1/directives/mine/healthcare-proxy')
          .set(as(minorUserToken))
          .send({ proxyName: 'Parent' })
      ).status,
    ).toBe(409);
    expect(
      (
        await api()
          .post('/api/v1/directives/mine/healthcare-proxy')
          .set({ ...as(parentToken), 'X-Acting-For': child.id })
          .send({ proxyName: 'Parent' })
      ).status,
    ).toBe(403);
  });

  it('marks directives whose review date has passed', async () => {
    await db.insert(advanceDirectives).values({
      patientId: child.id,
      kind: 'TREATMENT_ESCALATION',
      summary: 'Ward-based care, no intensive care',
      discussedWith: 'Parents',
      reviewDate: '2025-01-01',
      createdById: w.users.doctor.id,
    });
    const flags = await api()
      .get(`/api/v1/directives/patients/${child.id}/flags`)
      .set(as(w.tokens.doctor));
    expect(flags.body.items).toEqual([
      expect.objectContaining({ kind: 'TREATMENT_ESCALATION', reviewDue: true }),
    ]);
    // Guardians with full access see the directives that concern the child.
    const g = await api()
      .get('/api/v1/directives/mine')
      .set({ ...as(parentToken), 'X-Acting-For': child.id });
    expect(g.body.directives).toHaveLength(1);
  });
});

describe('emergency department flags', () => {
  it('lists active flags for patients in the department, to its staff only', async () => {
    await db.insert(advanceDirectives).values({
      patientId: w.otherPatient.id,
      kind: 'DNACPR',
      summary: 'Do not attempt CPR',
      discussedWith: 'Patient',
      createdById: w.users.doctor.id,
    });
    await db.insert(edVisits).values({
      patientId: w.otherPatient.id,
      facilityId: w.facility.id,
      unitId: edUnitId,
      arrivalMode: 'AMBULANCE',
      chiefComplaint: 'Shortness of breath',
      registeredById: w.users.reception.id,
    });
    const res = await api().get('/api/v1/directives/ed-flags').set(as(edNurseToken));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        patientId: w.otherPatient.id,
        items: [expect.objectContaining({ kind: 'DNACPR' })],
      }),
    ]);
    // Not assigned to the department.
    expect((await api().get('/api/v1/directives/ed-flags').set(as(w.tokens.nurse))).status).toBe(
      403,
    );
    expect(
      (await api().get('/api/v1/directives/ed-flags').set(as(w.tokens.reception))).status,
    ).toBe(403);
    // The view is recorded in the patient's access log.
    const logged = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.patientId, w.otherPatient.id),
          eq(auditLogs.action, 'patient.record.viewed'),
        ),
      );
    expect(logged.length).toBeGreaterThan(0);
  });
});
