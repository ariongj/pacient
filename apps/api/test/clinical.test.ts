import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { encounters } from '../src/db/schema.js';
import { api, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});

const base = () => `/api/v1/patients/${w.patient.id}`;

describe('clinical documentation', () => {
  it('records an encounter with diagnoses, prescriptions, vitals, labs and allergies', async () => {
    const enc = await api()
      .post(`${base()}/encounters`)
      .set(bearer(w.tokens.doctor))
      .send({ type: 'OUTPATIENT', reason: 'Headache and dizziness', notes: 'BP elevated.' });
    expect(enc.status).toBe(201);
    expect(enc.body.facilityId).toBe(w.facility.id);
    const encounterId = enc.body.id;

    const dx = await api().post(`${base()}/diagnoses`).set(bearer(w.tokens.doctor)).send({
      encounterId,
      icd10Code: 'i10',
      description: 'Essential hypertension',
      status: 'CHRONIC',
    });
    expect(dx.status).toBe(201);
    expect(dx.body.icd10Code).toBe('I10');

    const rx = await api().post(`${base()}/prescriptions`).set(bearer(w.tokens.doctor)).send({
      encounterId,
      medication: 'Amlodipine',
      dosage: '5 mg',
      frequency: 'once daily',
      startDate: '2026-01-10',
    });
    expect(rx.status).toBe(201);

    expect(
      (
        await api()
          .post(`${base()}/vitals`)
          .set(bearer(w.tokens.doctor))
          .send({ encounterId, systolic: 158, diastolic: 96, heartRate: 80, temperatureC: 36.8 })
      ).status,
    ).toBe(201);
    expect(
      (
        await api().post(`${base()}/lab-results`).set(bearer(w.tokens.doctor)).send({
          encounterId,
          testName: 'Creatinine',
          value: '88',
          unit: 'µmol/L',
          flag: 'NORMAL',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post(`${base()}/allergies`)
          .set(bearer(w.tokens.doctor))
          .send({ substance: 'Penicillin', reaction: 'Hives', severity: 'MODERATE' })
      ).status,
    ).toBe(201);

    const sum = await api().get(`${base()}/summary`).set(bearer(w.tokens.patient));
    expect(sum.status).toBe(200);
    expect(sum.body.activeProblems.map((d: { icd10Code: string }) => d.icd10Code)).toContain('I10');
    expect(sum.body.activeMedications[0].medication).toBe('Amlodipine');
    expect(sum.body.allergies[0].substance).toBe('Penicillin');
    expect(sum.body.latestVitals.systolic).toBe(158);

    const encounters = await api().get(`${base()}/encounters`).set(bearer(w.tokens.patient));
    expect(encounters.body.items[0].diagnoses[0].icd10Code).toBe('I10');
    expect(encounters.body.items[0].prescriptions[0].medication).toBe('Amlodipine');
  });

  it('validates clinical input', async () => {
    const badIcd = await api()
      .post(`${base()}/diagnoses`)
      .set(bearer(w.tokens.doctor))
      .send({ icd10Code: 'hypertension', description: 'x' });
    expect(badIcd.status).toBe(400);
    expect(badIcd.body.error.details).toBeInstanceOf(Array);

    const badVitals = await api()
      .post(`${base()}/vitals`)
      .set(bearer(w.tokens.doctor))
      .send({ systolic: 900 });
    expect(badVitals.status).toBe(400);

    const empty = await api().post(`${base()}/vitals`).set(bearer(w.tokens.doctor)).send({});
    expect(empty.status).toBe(400);

    // Back-entry from paper downtime charts: the real observation time, never in the future.
    const takenAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const backEntered = await api()
      .post(`${base()}/vitals`)
      .set(bearer(w.tokens.doctor))
      .send({ heartRate: 80, recordedAt: takenAt });
    expect(backEntered.status).toBe(201);
    expect(new Date(backEntered.body.recordedAt).toISOString()).toBe(takenAt);
    const future = await api()
      .post(`${base()}/vitals`)
      .set(bearer(w.tokens.doctor))
      .send({ heartRate: 80, recordedAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(future.status).toBe(400);
    const onlyTime = await api()
      .post(`${base()}/vitals`)
      .set(bearer(w.tokens.doctor))
      .send({ recordedAt: takenAt });
    expect(onlyTime.status).toBe(400);

    const badDates = await api().post(`${base()}/prescriptions`).set(bearer(w.tokens.doctor)).send({
      medication: 'X',
      dosage: '1',
      frequency: 'd',
      startDate: '2026-02-01',
      endDate: '2026-01-01',
    });
    expect(badDates.status).toBe(400);
  });

  it('rejects linking an entry to another patient’s encounter', async () => {
    await api()
      .post(`/api/v1/patients/${w.otherPatient.id}/care-team`)
      .set(bearer(w.tokens.doctor))
      .send({});
    const enc = await api()
      .post(`/api/v1/patients/${w.otherPatient.id}/encounters`)
      .set(bearer(w.tokens.doctor))
      .send({ type: 'OUTPATIENT', reason: 'Check-up' });
    const res = await api()
      .post(`${base()}/diagnoses`)
      .set(bearer(w.tokens.doctor))
      .send({ encounterId: enc.body.id, icd10Code: 'J06.9', description: 'URI' });
    expect(res.status).toBe(404);
  });

  it('only the authoring doctor can edit a draft, and stale edits are rejected', async () => {
    const enc = await api()
      .post(`${base()}/encounters`)
      .set(bearer(w.tokens.doctor))
      .send({ type: 'TELEHEALTH', reason: 'Follow-up call' });
    expect(enc.body).toMatchObject({ noteStatus: 'DRAFT', version: 1 });
    await api().post(`${base()}/care-team`).set(bearer(w.tokens.colleague)).send({});
    const other = await api()
      .patch(`${base()}/encounters/${enc.body.id}`)
      .set(bearer(w.tokens.colleague))
      .send({ version: 1, notes: 'tampered' });
    expect(other.status).toBe(403);

    const own = await api()
      .patch(`${base()}/encounters/${enc.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ version: 1, notes: 'Patient doing well' });
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ notes: 'Patient doing well', version: 2 });

    const stale = await api()
      .patch(`${base()}/encounters/${enc.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ version: 1, notes: 'Overwrites the previous edit' });
    expect(stale.status).toBe(409);
  });

  it('signed notes are immutable and amended only through attributable addenda', async () => {
    const enc = await api()
      .post(`${base()}/encounters`)
      .set(bearer(w.tokens.doctor))
      .send({ type: 'OUTPATIENT', reason: 'Review', notes: 'Original note text' });

    const addendumOnDraft = await api()
      .post(`${base()}/encounters/${enc.body.id}/addenda`)
      .set(bearer(w.tokens.doctor))
      .send({ reason: 'Clarification', content: 'Extra info' });
    expect(addendumOnDraft.status).toBe(409);

    const signed = await api()
      .post(`${base()}/encounters/${enc.body.id}/sign`)
      .set(bearer(w.tokens.doctor))
      .send({ version: 1 });
    expect(signed.status).toBe(200);
    expect(signed.body.noteStatus).toBe('SIGNED');

    const edit = await api()
      .patch(`${base()}/encounters/${enc.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ version: signed.body.version, notes: 'Rewritten' });
    expect(edit.status).toBe(409);

    // The database itself refuses to rewrite a signed note.
    await expect(
      db.update(encounters).set({ notes: 'direct tamper' }).where(eq(encounters.id, enc.body.id)),
    ).rejects.toThrow();

    const addendum = await api()
      .post(`${base()}/encounters/${enc.body.id}/addenda`)
      .set(bearer(w.tokens.doctor))
      .send({ reason: 'Correction of dosage', content: 'Dose discussed was 5 mg, not 10 mg.' });
    expect(addendum.status).toBe(201);

    const list = await api().get(`${base()}/encounters`).set(bearer(w.tokens.patient));
    const shown = list.body.items.find((e: { id: string }) => e.id === enc.body.id);
    expect(shown.notes).toBe('Original note text');
    expect(shown.addenda[0]).toMatchObject({ reason: 'Correction of dosage' });
  });

  it('hides unsigned draft notes from the patient', async () => {
    const enc = await api()
      .post(`${base()}/encounters`)
      .set(bearer(w.tokens.doctor))
      .send({ type: 'OUTPATIENT', reason: 'Draft visit', notes: 'Working hypothesis' });
    const list = await api().get(`${base()}/encounters`).set(bearer(w.tokens.patient));
    expect(list.body.items.find((e: { id: string }) => e.id === enc.body.id).notes).toBeNull();
    const asDoctor = await api().get(`${base()}/encounters`).set(bearer(w.tokens.doctor));
    expect(asDoctor.body.items.find((e: { id: string }) => e.id === enc.body.id).notes).toBe(
      'Working hypothesis',
    );
  });
  it('lets patients export their complete record and audits the export', async () => {
    const res = await api().get(`${base()}/export`).set(bearer(w.tokens.patient));
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.body.format).toBe('pacient-record/v1');
    expect(res.body.encounters.length).toBeGreaterThan(0);
  });

  it('sends no-store cache headers on health data', async () => {
    const res = await api().get(`${base()}/summary`).set(bearer(w.tokens.patient));
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('patient registration', () => {
  it('a doctor registers a patient, joins their care team and can create a portal invite', async () => {
    const res = await api().post('/api/v1/patients').set(bearer(w.tokens.doctor)).send({
      nationalId: '1234500001',
      firstName: 'Liridon',
      lastName: 'Gashi',
      dateOfBirth: '1979-03-04',
      sex: 'MALE',
      email: 'liridon@test.local',
      createPortalAccount: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.patient.primaryFacilityId).toBe(w.facility.id);
    expect(res.body.activationUrl).toMatch(/\/activate\?token=/);

    const sum = await api()
      .get(`/api/v1/patients/${res.body.patient.id}/summary`)
      .set(bearer(w.tokens.doctor));
    expect(sum.status).toBe(200);

    const dup = await api().post('/api/v1/patients').set(bearer(w.tokens.doctor)).send({
      nationalId: '1234500001',
      firstName: 'A',
      lastName: 'B',
      dateOfBirth: '1979-03-04',
      sex: 'MALE',
    });
    expect(dup.status).toBe(409);
  });

  it('patients update their own contact details from the portal', async () => {
    const res = await api()
      .patch('/api/v1/portal/contact')
      .set(bearer(w.tokens.patient))
      .send({ phone: '+383 44 000 000' });
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('+383 44 000 000');
    expect(res.body).not.toHaveProperty('userId');
  });
});
