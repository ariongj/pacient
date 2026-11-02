import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { careAssignments, patients } from '../src/db/schema.js';
import { api, bearer, createUser, createWorld, login, nextNationalId } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let child: typeof patients.$inferSelect;
let teen: typeof patients.$inferSelect;
let parent: Awaited<ReturnType<typeof createUser>>;
let parentToken: string;
let teenToken: string;

beforeAll(async () => {
  w = await createWorld();
  child = (
    await db
      .insert(patients)
      .values({
        nationalId: nextNationalId(),
        firstName: 'Lea',
        lastName: 'Krasniqi',
        dateOfBirth: '2016-05-10',
        sex: 'FEMALE',
        primaryFacilityId: w.facility.id,
      })
      .returning()
  )[0]!;
  const teenUser = await createUser('PATIENT');
  teen = (
    await db
      .insert(patients)
      .values({
        nationalId: nextNationalId(),
        firstName: 'Ari',
        lastName: 'Krasniqi',
        dateOfBirth: '2010-03-01',
        sex: 'MALE',
        primaryFacilityId: w.facility.id,
        userId: teenUser.id,
      })
      .returning()
  )[0]!;
  await db.insert(careAssignments).values([
    { patientId: child!.id, doctorId: w.users.doctor.id },
    { patientId: teen!.id, doctorId: w.users.doctor.id },
  ]);
  parent = await createUser('PATIENT');
  parentToken = await login(parent.email);
  teenToken = await login(teenUser.email);
});

const asGuardian = (token: string, patientId: string) => ({
  ...bearer(token),
  'X-Acting-For': patientId,
});
const addGuardian = (
  patientId: string,
  body: Record<string, unknown>,
  token = w.tokens.reception,
) => api().post(`/api/v1/patients/${patientId}/guardians`).set(bearer(token)).send(body);

describe('registering guardians', () => {
  it('reception links a parent after checking evidence; access ends at the 18th birthday', async () => {
    const res = await addGuardian(child!.id, {
      email: parent.email,
      fullName: parent.fullName,
      relationship: 'PARENT',
      evidence: 'Birth certificate 4411/2016',
    });
    expect(res.status).toBe(201);
    expect(res.body.guardianship.validUntil.slice(0, 10)).toBe('2034-05-10');
    expect(res.body.activationUrl).toBeUndefined();

    const deps = await api().get('/api/v1/portal/dependants').set(bearer(parentToken));
    expect(deps.body.items.map((d: { patientId: string }) => d.patientId)).toContain(child!.id);

    const dup = await addGuardian(child!.id, {
      email: parent.email,
      fullName: 'Duplicate Parent',
      relationship: 'PARENT',
      evidence: 'Birth certificate',
    });
    expect(dup.status).toBe(409);
  });

  it('invites guardians who have no account yet', async () => {
    const res = await addGuardian(teen!.id, {
      email: `grandma-${Date.now()}@test.local`,
      fullName: 'Grandma Krasniqi',
      relationship: 'LEGAL_GUARDIAN',
      scope: 'APPOINTMENTS',
      evidence: 'Court order 77/2025',
    });
    expect(res.status).toBe(201);
    expect(res.body.activationUrl).toMatch(/activate/);
  });

  it('rejects staff accounts, other facilities and non-front-desk roles', async () => {
    expect(
      (
        await addGuardian(child!.id, {
          email: w.users.doctor.email,
          fullName: 'Dr',
          relationship: 'PARENT',
          evidence: 'Birth certificate',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await addGuardian(
          child!.id,
          {
            email: 'x@test.local',
            fullName: 'X Y',
            relationship: 'PARENT',
            evidence: 'Birth certificate',
          },
          w.tokens.otherDirector,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await addGuardian(
          child!.id,
          {
            email: 'y@test.local',
            fullName: 'X Y',
            relationship: 'PARENT',
            evidence: 'Birth certificate',
          },
          w.tokens.doctor,
        )
      ).status,
    ).toBe(403);
  });

  it('adults can only have a court-appointed guardian with an end date', async () => {
    const parentOfAdult = await createUser('PATIENT');
    const base = {
      email: parentOfAdult.email,
      fullName: 'Court Guardian',
      evidence: 'Court order 12/2026',
    };
    expect((await addGuardian(w.patient.id, { ...base, relationship: 'PARENT' })).status).toBe(400);
    expect(
      (await addGuardian(w.patient.id, { ...base, relationship: 'LEGAL_GUARDIAN' })).status,
    ).toBe(400);
    const ok = await addGuardian(w.patient.id, {
      ...base,
      relationship: 'LEGAL_GUARDIAN',
      validUntil: '2028-01-01',
    });
    expect(ok.status).toBe(201);

    // The adult patient sees who holds proxy access and can revoke it.
    const mine = await api()
      .get(`/api/v1/patients/${w.patient.id}/guardians`)
      .set(bearer(w.tokens.patient));
    expect(mine.body.items[0]).not.toHaveProperty('guardianEmail');
    const revoke = await api()
      .post(`/api/v1/patients/${w.patient.id}/guardians/${ok.body.guardianship.id}/revoke`)
      .set(bearer(w.tokens.patient))
      .send({ reason: 'I no longer need support' });
    expect(revoke.status).toBe(200);
  });
});

describe('acting as guardian', () => {
  it('opens the child’s record only with a valid grant, and every view is audited', async () => {
    expect(
      (await api().get(`/api/v1/patients/${child!.id}/summary`).set(bearer(parentToken))).status,
    ).toBe(403);
    const summary = await api()
      .get(`/api/v1/patients/${child!.id}/summary`)
      .set(asGuardian(parentToken, child!.id));
    expect(summary.status).toBe(200);
    expect(summary.body.accessBasis).toBe('GUARDIAN');

    const audit = await api()
      .get(`/api/v1/audit-logs?patientId=${child!.id}&action=patient.record.viewed`)
      .set(bearer(w.tokens.ministry));
    expect(audit.body.items[0]).toMatchObject({
      actorUserId: parent.id,
      metadata: { basis: 'GUARDIAN' },
    });

    const other = await api()
      .get(`/api/v1/patients/${w.otherPatient.id}/summary`)
      .set(asGuardian(parentToken, w.otherPatient.id));
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('PROXY_NOT_AUTHORISED');
    expect(
      (await api().get('/api/v1/auth/me').set(asGuardian(w.tokens.doctor, child!.id))).status,
    ).toBe(403);
  });

  it('hides confidential visits and unreleased results from guardians', async () => {
    const base = `/api/v1/patients/${child!.id}`;
    const enc = await api()
      .post(`${base}/encounters`)
      .set(bearer(w.tokens.doctor))
      .send({ type: 'OUTPATIENT', reason: 'Confidential consultation' });
    await api().post(`${base}/diagnoses`).set(bearer(w.tokens.doctor)).send({
      encounterId: enc.body.id,
      icd10Code: 'Z30.0',
      description: 'Contraceptive counselling',
    });
    const lab = await api()
      .post(`${base}/lab-results`)
      .set(bearer(w.tokens.doctor))
      .send({ encounterId: enc.body.id, testName: 'hCG', value: 'Negative' });
    await api().post(`${base}/lab-results/${lab.body.id}/acknowledge`).set(bearer(w.tokens.doctor));
    await api()
      .post(`${base}/encounters/${enc.body.id}/confidentiality`)
      .set(bearer(w.tokens.doctor))
      .send({ confidential: true })
      .expect(200);
    await api()
      .post(`${base}/lab-results/${lab.body.id}/release`)
      .set(bearer(w.tokens.doctor))
      .expect(200);

    const g = asGuardian(parentToken, child!.id);
    const encs = await api().get(`${base}/encounters`).set(g);
    expect(encs.body.items.map((e: { id: string }) => e.id)).not.toContain(enc.body.id);
    const dx = await api().get(`${base}/diagnoses`).set(g);
    expect(dx.body.items.map((d: { icd10Code: string }) => d.icd10Code)).not.toContain('Z30.0');
    const labs = await api().get(`${base}/lab-results`).set(g);
    expect(labs.body.items.map((l: { id: string }) => l.id)).not.toContain(lab.body.id);
    const fhir = JSON.parse(
      (await api().get(`/api/v1/fhir/Patient/${child!.id}/$everything`).set(g)).text,
    );
    expect(JSON.stringify(fhir)).not.toContain('Z30.0');
    // No guardian notification for a confidential result.
    const n = await api().get('/api/v1/notifications').set(bearer(parentToken));
    expect(n.body.items.some((i: { type: string }) => i.type === 'result')).toBe(false);

    // The treating doctor still sees everything.
    const doc = await api().get(`${base}/diagnoses`).set(bearer(w.tokens.doctor));
    expect(doc.body.items.map((d: { icd10Code: string }) => d.icd10Code)).toContain('Z30.0');
  });

  it('notifies guardians of ordinary results, with a link that opens the child’s record', async () => {
    const base = `/api/v1/patients/${child!.id}`;
    const lab = await api()
      .post(`${base}/lab-results`)
      .set(bearer(w.tokens.doctor))
      .send({ testName: 'Ferritin', value: '35' });
    await api().post(`${base}/lab-results/${lab.body.id}/acknowledge`).set(bearer(w.tokens.doctor));
    await api().post(`${base}/lab-results/${lab.body.id}/release`).set(bearer(w.tokens.doctor));
    const n = await api().get('/api/v1/notifications').set(bearer(parentToken));
    const item = n.body.items.find((i: { type: string }) => i.type === 'result');
    expect(item.title).toMatch(/family member/);
    expect(item.link).toContain(`for=${child!.id}`);
  });

  it('lets guardians book appointments and message the care team for the child', async () => {
    const g = asGuardian(parentToken, child!.id);
    const at = new Date(Date.now() + 6 * 86_400_000);
    at.setUTCHours(11, 0, 0, 0);
    const appt = await api().post('/api/v1/appointments').set(g).send({
      doctorId: w.users.doctor.id,
      scheduledAt: at.toISOString(),
      reason: 'Vaccination check',
    });
    expect(appt.status).toBe(201);
    expect(appt.body.patientId).toBe(child!.id);

    const thread = await api().post('/api/v1/messages/threads').set(g).send({
      doctorId: w.users.doctor.id,
      subject: 'Fever',
      body: 'Lea has had a fever since yesterday.',
    });
    expect(thread.status).toBe(201);
    const list = await api().get('/api/v1/messages/threads').set(g);
    expect(list.body.items.map((t: { id: string }) => t.id)).toContain(thread.body.id);
  });

  it('keeps a young person’s own conversations private from their guardian', async () => {
    await addGuardian(teen!.id, {
      email: parent.email,
      fullName: parent.fullName,
      relationship: 'PARENT',
      evidence: 'Birth certificate 18/2010',
    }).expect(201);
    const own = await api().post('/api/v1/messages/threads').set(bearer(teenToken)).send({
      doctorId: w.users.doctor.id,
      subject: 'Private question',
      body: 'Can I talk to you alone?',
    });
    expect(own.status).toBe(201);
    const g = asGuardian(parentToken, teen!.id);
    const list = await api().get('/api/v1/messages/threads').set(g);
    expect(list.body.items.map((t: { id: string }) => t.id)).not.toContain(own.body.id);
    expect((await api().get(`/api/v1/messages/threads/${own.body.id}`).set(g)).status).toBe(404);

    // The young person can see who holds proxy access to their record.
    const mine = await api().get(`/api/v1/patients/${teen!.id}/guardians`).set(bearer(teenToken));
    expect(mine.body.items.length).toBeGreaterThan(0);
    // …but a minor cannot revoke it themselves.
    const id = mine.body.items[0].id;
    expect(
      (
        await api()
          .post(`/api/v1/patients/${teen!.id}/guardians/${id}/revoke`)
          .set(bearer(teenToken))
          .send({ reason: 'I want privacy' })
      ).status,
    ).toBe(403);
  });

  it('appointments-only guardians cannot see clinical data or messages', async () => {
    const grandma = await createUser('PATIENT');
    await addGuardian(child!.id, {
      email: grandma.email,
      fullName: 'Grandma',
      relationship: 'OTHER_AUTHORISED',
      scope: 'APPOINTMENTS',
      evidence: 'Signed parental consent form',
    }).expect(201);
    const g = asGuardian(await login(grandma.email), child!.id);
    expect((await api().get(`/api/v1/patients/${child!.id}/summary`).set(g)).status).toBe(403);
    expect((await api().get('/api/v1/messages/threads').set(g)).status).toBe(403);
    expect((await api().get('/api/v1/portal/access-log').set(g)).status).toBe(403);
    expect((await api().get('/api/v1/appointments').set(g)).status).toBe(200);
  });

  it('revocation takes effect immediately', async () => {
    const list = await api()
      .get(`/api/v1/patients/${child!.id}/guardians`)
      .set(bearer(w.tokens.reception));
    const grant = list.body.items.find(
      (g: { guardianUserId: string; active: boolean }) =>
        g.guardianUserId === parent.id && g.active,
    );
    await api()
      .post(`/api/v1/patients/${child!.id}/guardians/${grant.id}/revoke`)
      .set(bearer(w.tokens.reception))
      .send({ reason: 'Custody arrangement changed' })
      .expect(200);
    const after = await api()
      .get(`/api/v1/patients/${child!.id}/summary`)
      .set(asGuardian(parentToken, child!.id));
    expect(after.status).toBe(403);
    const deps = await api().get('/api/v1/portal/dependants').set(bearer(parentToken));
    expect(deps.body.items.map((d: { patientId: string }) => d.patientId)).not.toContain(child!.id);
  });
});
