import { beforeAll, describe, expect, it } from 'vitest';
import { api, bearer, createWorld, nextNationalId } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});
const base = () => `/api/v1/patients/${w.patient.id}`;

describe('closed-loop result follow-up', () => {
  it('acknowledge → release; patients only see released results', async () => {
    const created = await api()
      .post(`${base()}/lab-results`)
      .set(bearer(w.tokens.doctor))
      .send({ testName: 'Potassium', value: '6.4', unit: 'mmol/L', flag: 'CRITICAL' });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const worklist = await api().get('/api/v1/worklist').set(bearer(w.tokens.doctor));
    expect(worklist.status).toBe(200);
    expect(worklist.body.unacknowledgedResults[0]).toMatchObject({ id, flag: 'CRITICAL' });

    const patientBefore = await api().get(`${base()}/lab-results`).set(bearer(w.tokens.patient));
    expect(patientBefore.body.items.map((r: { id: string }) => r.id)).not.toContain(id);

    const early = await api()
      .post(`${base()}/lab-results/${id}/release`)
      .set(bearer(w.tokens.doctor));
    expect(early.status).toBe(409);

    const ack = await api()
      .post(`${base()}/lab-results/${id}/acknowledge`)
      .set(bearer(w.tokens.doctor));
    expect(ack.status).toBe(200);
    expect(ack.body.acknowledgedAt).toBeTruthy();

    const after = await api().get('/api/v1/worklist').set(bearer(w.tokens.doctor));
    expect(after.body.unacknowledgedResults.map((r: { id: string }) => r.id)).not.toContain(id);

    expect(
      (await api().post(`${base()}/lab-results/${id}/release`).set(bearer(w.tokens.doctor))).status,
    ).toBe(200);
    const patientAfter = await api().get(`${base()}/lab-results`).set(bearer(w.tokens.patient));
    expect(patientAfter.body.items.map((r: { id: string }) => r.id)).toContain(id);
  });

  it('preliminary results cannot be released', async () => {
    const created = await api()
      .post(`${base()}/lab-results`)
      .set(bearer(w.tokens.doctor))
      .send({ testName: 'Blood culture', value: 'pending', status: 'PRELIMINARY' });
    await api()
      .post(`${base()}/lab-results/${created.body.id}/acknowledge`)
      .set(bearer(w.tokens.doctor));
    const res = await api()
      .post(`${base()}/lab-results/${created.body.id}/release`)
      .set(bearer(w.tokens.doctor));
    expect(res.status).toBe(409);
  });
});

describe('allergy verification and assessment', () => {
  it('distinguishes "no known allergies" from "not recorded"', async () => {
    const before = await api().get(`${base()}/summary`).set(bearer(w.tokens.doctor));
    expect(before.body.patient.allergyAssessment).toBe('NOT_RECORDED');

    const nka = await api()
      .put(`${base()}/allergy-assessment`)
      .set(bearer(w.tokens.doctor))
      .send({ status: 'NO_KNOWN_ALLERGIES' });
    expect(nka.status).toBe(200);

    const allergy = await api()
      .post(`${base()}/allergies`)
      .set(bearer(w.tokens.doctor))
      .send({ substance: 'Aspirin', severity: 'MILD', source: 'PATIENT_REPORTED' });
    expect(allergy.body).toMatchObject({
      verificationStatus: 'UNCONFIRMED',
      source: 'PATIENT_REPORTED',
    });

    const after = await api().get(`${base()}/summary`).set(bearer(w.tokens.doctor));
    expect(after.body.patient.allergyAssessment).toBe('ALLERGIES_RECORDED');

    // Cannot claim "no known allergies" while an allergy is on file.
    const conflicting = await api()
      .put(`${base()}/allergy-assessment`)
      .set(bearer(w.tokens.doctor))
      .send({ status: 'NO_KNOWN_ALLERGIES' });
    expect(conflicting.status).toBe(409);

    const refuted = await api()
      .patch(`${base()}/allergies/${allergy.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ verificationStatus: 'REFUTED' });
    expect(refuted.status).toBe(200);
    expect(
      (
        await api()
          .put(`${base()}/allergy-assessment`)
          .set(bearer(w.tokens.doctor))
          .send({ status: 'NO_KNOWN_ALLERGIES' })
      ).status,
    ).toBe(200);
  });
});

describe('patient correction requests', () => {
  it('patients request corrections, clinicians resolve them', async () => {
    const asDoctor = await api()
      .post(`${base()}/correction-requests`)
      .set(bearer(w.tokens.doctor))
      .send({ section: 'allergies', description: 'Doctor should not be able to file this' });
    expect(asDoctor.status).toBe(403);

    const created = await api()
      .post(`${base()}/correction-requests`)
      .set(bearer(w.tokens.patient))
      .send({
        section: 'allergies',
        description: 'I am not allergic to aspirin, it was ibuprofen.',
      });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('OPEN');

    const worklist = await api().get('/api/v1/worklist').set(bearer(w.tokens.doctor));
    expect(worklist.body.openCorrectionRequests.map((c: { id: string }) => c.id)).toContain(
      created.body.id,
    );

    const resolved = await api()
      .patch(`${base()}/correction-requests/${created.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ status: 'ACCEPTED', response: 'Updated the allergy record after review.' });
    expect(resolved.status).toBe(200);

    const list = await api().get(`${base()}/correction-requests`).set(bearer(w.tokens.patient));
    expect(list.body.items[0]).toMatchObject({
      status: 'ACCEPTED',
      resolvedBy: w.users.doctor.fullName,
    });

    const again = await api()
      .patch(`${base()}/correction-requests/${created.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ status: 'REJECTED', response: 'Changing my mind' });
    expect(again.status).toBe(404);
  });
});

describe('identity: duplicate review at registration', () => {
  const person = {
    firstName: 'Dren',
    lastName: 'Hoxha',
    dateOfBirth: '1991-09-09',
    sex: 'MALE' as const,
  };

  it('flags same name and date of birth for review instead of merging', async () => {
    const first = await api()
      .post('/api/v1/patients')
      .set(bearer(w.tokens.doctor))
      .send({ ...person, nationalId: nextNationalId() });
    expect(first.status).toBe(201);

    const second = await api()
      .post('/api/v1/patients')
      .set(bearer(w.tokens.doctor))
      .send({ ...person, nationalId: nextNationalId() });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(second.body.error.details[0].id).toBe(first.body.patient.id);

    const confirmed = await api()
      .post('/api/v1/patients')
      .set(bearer(w.tokens.doctor))
      .send({ ...person, nationalId: nextNationalId(), confirmedNotDuplicate: true });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.patient.id).not.toBe(first.body.patient.id);
  });
});
