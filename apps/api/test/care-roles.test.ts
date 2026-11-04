import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { api, bearer, createWorld, nextNationalId } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});
const base = () => `/api/v1/patients/${w.patient.id}`;

describe('nurse', () => {
  it('needs to be in the care team, then reads the record and records nursing entries', async () => {
    expect((await api().get(`${base()}/summary`).set(bearer(w.tokens.nurse))).status).toBe(403);
    await api().post(`${base()}/care-team`).set(bearer(w.tokens.nurse)).send({}).expect(201);
    const summary = await api().get(`${base()}/summary`).set(bearer(w.tokens.nurse));
    expect(summary.status).toBe(200);
    expect(summary.body.accessBasis).toBe('CARE_TEAM');

    expect(
      (
        await api()
          .post(`${base()}/vitals`)
          .set(bearer(w.tokens.nurse))
          .send({ systolic: 128, diastolic: 82 })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post(`${base()}/allergies`)
          .set(bearer(w.tokens.nurse))
          .send({ substance: 'Latex', severity: 'MILD', source: 'PATIENT_REPORTED' })
      ).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post(`${base()}/immunizations`)
          .set(bearer(w.tokens.nurse))
          .send({ vaccine: 'Hepatitis B', doseNumber: 2 })
      ).status,
    ).toBe(201);
  });

  it('cannot diagnose, prescribe or use emergency access', async () => {
    const dx = await api()
      .post(`${base()}/diagnoses`)
      .set(bearer(w.tokens.nurse))
      .send({ icd10Code: 'I10', description: 'Hypertension' });
    expect(dx.status).toBe(403);
    const rx = await api().post(`${base()}/prescriptions`).set(bearer(w.tokens.nurse)).send({
      medication: 'Ibuprofen',
      dosage: '400 mg',
      frequency: 'tds',
      startDate: '2026-11-01',
    });
    expect(rx.status).toBe(403);
    const glass = await api()
      .post(`/api/v1/patients/${w.otherPatient.id}/emergency-access`)
      .set(bearer(w.tokens.nurse))
      .send({ reason: 'Trying to open an unrelated record' });
    expect(glass.status).toBe(403);
  });
});

describe('reception', () => {
  it('registers patients and manages the front desk without seeing clinical data', async () => {
    const list = await api().get('/api/v1/patients?scope=facility').set(bearer(w.tokens.reception));
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    expect((await api().get(`${base()}/summary`).set(bearer(w.tokens.reception))).status).toBe(403);
    expect((await api().get(`${base()}/encounters`).set(bearer(w.tokens.reception))).status).toBe(
      403,
    );

    const reg = await api().post('/api/v1/patients').set(bearer(w.tokens.reception)).send({
      nationalId: nextNationalId(),
      firstName: 'Ardit',
      lastName: 'Morina',
      dateOfBirth: '1999-02-02',
      sex: 'MALE',
    });
    expect(reg.status).toBe(201);

    const at = new Date(Date.now() + 3 * 86_400_000);
    at.setUTCHours(13, 0, 0, 0);
    const appt = await api().post('/api/v1/appointments').set(bearer(w.tokens.reception)).send({
      patientId: w.patient.id,
      doctorId: w.users.colleague.id,
      scheduledAt: at.toISOString(),
      reason: 'Check-up',
    });
    expect(appt.status).toBe(201);
    expect(appt.body.status).toBe('CONFIRMED');

    const checkIn = await api()
      .patch(`/api/v1/appointments/${appt.body.id}/status`)
      .set(bearer(w.tokens.reception))
      .send({ status: 'CHECKED_IN' });
    expect(checkIn.status).toBe(200);
    const complete = await api()
      .patch(`/api/v1/appointments/${appt.body.id}/status`)
      .set(bearer(w.tokens.reception))
      .send({ status: 'COMPLETED' });
    expect(complete.status).toBe(400);
    const doctorCompletes = await api()
      .patch(`/api/v1/appointments/${appt.body.id}/status`)
      .set(bearer(w.tokens.colleague))
      .send({ status: 'COMPLETED' });
    expect(doctorCompletes.status).toBe(200);
  });

  it('cannot book doctors of another facility', async () => {
    const res = await api()
      .post('/api/v1/appointments')
      .set(bearer(w.tokens.reception))
      .send({
        patientId: w.patient.id,
        doctorId: w.users.outsideDoctor.id,
        scheduledAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        reason: 'x-facility',
      });
    expect(res.status).toBe(400);
  });
});

describe('staff onboarding for the new roles', () => {
  it('directors invite nurses, pharmacists and reception; licences are required for clinicians', async () => {
    const invite = (body: object) =>
      api().post('/api/v1/staff/invitations').set(bearer(w.tokens.director)).send(body);
    const stamp = Date.now();
    expect(
      (await invite({ email: `n${stamp}@t.local`, fullName: 'Nurse A', role: 'NURSE' })).status,
    ).toBe(400);
    expect(
      (
        await invite({
          email: `n${stamp}@t.local`,
          fullName: 'Nurse A',
          role: 'NURSE',
          licenseNumber: 'N-1',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await invite({
          email: `p${stamp}@t.local`,
          fullName: 'Pharm A',
          role: 'PHARMACIST',
          licenseNumber: 'P-1',
        })
      ).status,
    ).toBe(201);
    expect(
      (await invite({ email: `r${stamp}@t.local`, fullName: 'Desk A', role: 'RECEPTION' })).status,
    ).toBe(201);
    expect(
      (
        await api()
          .post('/api/v1/staff/invitations')
          .set(bearer(w.tokens.ministry))
          .send({
            email: `x${stamp}@t.local`,
            fullName: 'Nurse B',
            role: 'NURSE',
            facilityId: w.facility.id,
            licenseNumber: 'N-2',
          })
      ).status,
    ).toBe(403);
  });
});

describe('pharmacy workflow', () => {
  let rxId: string;

  it('a new prescription reaches the pharmacist with safety alerts', async () => {
    await api()
      .post(`${base()}/allergies`)
      .set(bearer(w.tokens.doctor))
      .send({ substance: 'Penicillin', severity: 'SEVERE', verificationStatus: 'CONFIRMED' })
      .expect(201);
    const order = {
      medication: 'Amoxicillin 500 mg',
      dosage: '500 mg',
      frequency: 'three times daily',
      startDate: '2026-11-02',
    };
    // A confirmed severe penicillin allergy blocks prescribing until a reason is recorded.
    const blocked = await api()
      .post(`${base()}/prescriptions`)
      .set(bearer(w.tokens.doctor))
      .send(order);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SAFETY_ALERTS');
    const code = blocked.body.error.details.alerts[0].code as string;
    const rx = await api()
      .post(`${base()}/prescriptions`)
      .set(bearer(w.tokens.doctor))
      .send({
        ...order,
        overrides: [{ code, reason: 'Tolerated amoxicillin in 2024 – allergy doubtful.' }],
      });
    expect(rx.status).toBe(201);
    expect(rx.body.pharmacyStatus).toBe('PENDING');
    rxId = rx.body.id;

    const notifs = await api().get('/api/v1/notifications').set(bearer(w.tokens.pharmacist));
    expect(notifs.body.items.some((n: { type: string }) => n.type === 'pharmacy')).toBe(true);

    const queue = await api().get('/api/v1/pharmacy/queue').set(bearer(w.tokens.pharmacist));
    const item = queue.body.items.find((i: { id: string }) => i.id === rxId);
    expect(item.alerts[0]).toMatchObject({ kind: 'ALLERGY', severity: 'CONTRAINDICATED' });

    // Another facility's pharmacist never sees it; pharmacists never see the full record.
    const other = await api().get('/api/v1/pharmacy/queue').set(bearer(w.tokens.outsidePharmacist));
    expect(other.body.items.map((i: { id: string }) => i.id)).not.toContain(rxId);
    expect((await api().get(`${base()}/summary`).set(bearer(w.tokens.pharmacist))).status).toBe(
      403,
    );

    const ctx = await api()
      .get(`/api/v1/pharmacy/prescriptions/${rxId}`)
      .set(bearer(w.tokens.pharmacist));
    expect(ctx.status).toBe(200);
    expect(ctx.body.allergies.map((a: { substance: string }) => a.substance)).toContain(
      'Penicillin',
    );
    expect(ctx.body).not.toHaveProperty('encounters');
    const log = await api().get('/api/v1/portal/access-log').set(bearer(w.tokens.patient));
    expect(
      log.body.items.some((e: { action: string }) => e.action === 'pharmacy.context.viewed'),
    ).toBe(true);
  });

  it('verification with alerts needs an explicit review note', async () => {
    const blind = await api()
      .post(`/api/v1/pharmacy/prescriptions/${rxId}/verify`)
      .set(bearer(w.tokens.pharmacist))
      .send({});
    expect(blind.status).toBe(400);
  });

  it('returned prescriptions go back to the prescriber, who can resubmit', async () => {
    const ret = await api()
      .post(`/api/v1/pharmacy/prescriptions/${rxId}/return`)
      .set(bearer(w.tokens.pharmacist))
      .send({ note: 'Confirmed penicillin allergy – suggest a macrolide.' });
    expect(ret.body.pharmacyStatus).toBe('RETURNED');
    const wl = await api().get('/api/v1/worklist').set(bearer(w.tokens.doctor));
    expect(wl.body.returnedPrescriptions.map((r: { id: string }) => r.id)).toContain(rxId);

    // Nurses cannot administer an unverified prescription.
    await api().post(`${base()}/care-team`).set(bearer(w.tokens.nurse)).send({});
    const early = await api()
      .post(`${base()}/medication-administrations`)
      .set(bearer(w.tokens.nurse))
      .send({ prescriptionId: rxId, status: 'GIVEN' });
    expect(early.status).toBe(409);

    const resub = await api()
      .post(`${base()}/prescriptions/${rxId}/resubmit`)
      .set(bearer(w.tokens.doctor))
      .send({ note: 'Allergy reviewed with patient: tolerated amoxicillin in 2024, proceed.' });
    expect(resub.body.pharmacyStatus).toBe('PENDING');
  });

  it('verify → dispense → administer, with explicit reasons for doses not given', async () => {
    const verified = await api()
      .post(`/api/v1/pharmacy/prescriptions/${rxId}/verify`)
      .set(bearer(w.tokens.pharmacist))
      .send({
        alertsReviewed: true,
        note: 'Prescriber confirmed prior tolerance; monitor first dose.',
      });
    expect(verified.status).toBe(200);
    expect(verified.body.pharmacyStatus).toBe('VERIFIED');

    const dispensed = await api()
      .post(`/api/v1/pharmacy/prescriptions/${rxId}/dispense`)
      .set(bearer(w.tokens.pharmacist))
      .send({ quantity: '21 capsules' });
    // Not linked to the medication catalogue: dispensing without stock tracking needs a reason.
    expect(dispensed.status).toBe(400);
    const untracked = await api()
      .post(`/api/v1/pharmacy/prescriptions/${rxId}/dispense`)
      .set(bearer(w.tokens.pharmacist))
      .send({ quantity: '21 capsules', untrackedReason: 'Supplied from the ward stock cupboard' });
    expect(untracked.body.pharmacyStatus).toBe('DISPENSED');
    const pn = await api().get('/api/v1/notifications').set(bearer(w.tokens.patient));
    expect(pn.body.items.some((n: { type: string }) => n.type === 'pharmacy')).toBe(true);

    const noReason = await api()
      .post(`${base()}/medication-administrations`)
      .set(bearer(w.tokens.nurse))
      .send({ prescriptionId: rxId, status: 'WITHHELD' });
    expect(noReason.status).toBe(400);
    const given = await api()
      .post(`${base()}/medication-administrations`)
      .set(bearer(w.tokens.nurse))
      .send({ prescriptionId: rxId, status: 'GIVEN', doseGiven: '500 mg' });
    expect(given.status).toBe(201);
    const mar = await api()
      .get(`${base()}/medication-administrations`)
      .set(bearer(w.tokens.doctor));
    expect(mar.body.items[0]).toMatchObject({ status: 'GIVEN', medication: 'Amoxicillin 500 mg' });

    const cause = await db
      .execute(sql`UPDATE medication_administrations SET status = 'REFUSED'`)
      .then(
        () => 'ok',
        (e: { cause?: { message?: string } }) => e.cause?.message ?? '',
      );
    expect(cause).toMatch(/append-only/);
  });
});

describe('care tasks', () => {
  it('doctors assign tasks to the nursing team; nurses complete them', async () => {
    const created = await api()
      .post(`${base()}/care-tasks`)
      .set(bearer(w.tokens.doctor))
      .send({
        title: 'Check blood glucose before lunch',
        priority: 'URGENT',
        assignedRole: 'NURSE',
        dueAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    expect(created.status).toBe(201);

    const mine = await api().get('/api/v1/care-tasks').set(bearer(w.tokens.nurse));
    const task = mine.body.items.find((t: { id: string }) => t.id === created.body.id);
    expect(task).toMatchObject({ priority: 'URGENT', assignedRole: 'NURSE' });
    expect(
      (await api().get('/api/v1/notifications').set(bearer(w.tokens.nurse))).body.items.some(
        (n: { type: string }) => n.type === 'task',
      ),
    ).toBe(true);

    expect((await api().get('/api/v1/care-tasks').set(bearer(w.tokens.reception))).status).toBe(
      403,
    );
    await api()
      .post(`/api/v1/care-tasks/${created.body.id}/complete`)
      .set(bearer(w.tokens.nurse))
      .send({ note: 'Glucose 6.2 mmol/L' })
      .expect(204);
    const again = await api()
      .post(`/api/v1/care-tasks/${created.body.id}/complete`)
      .set(bearer(w.tokens.nurse))
      .send({});
    expect(again.status).toBe(409);
    const list = await api().get(`${base()}/care-tasks`).set(bearer(w.tokens.patient));
    expect(list.body.items.find((t: { id: string }) => t.id === created.body.id).status).toBe(
      'DONE',
    );
  });
});

describe('staff directory', () => {
  it('lists same-facility clinicians for reception, but not for patients', async () => {
    const res = await api().get('/api/v1/directory?role=DOCTOR').set(bearer(w.tokens.reception));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((u: { id: string }) => u.id);
    expect(ids).toContain(w.users.doctor.id);
    expect(ids).not.toContain(w.users.outsideDoctor.id);
    expect(res.body.items[0]).not.toHaveProperty('email');
    expect((await api().get('/api/v1/directory').set(bearer(w.tokens.patient))).status).toBe(403);
  });
});
