import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  encounters,
  imagingOrders,
  labOrders,
  labResults,
  prescriptions,
  users,
} from '../src/db/schema.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;

beforeAll(async () => {
  w = await createWorld();
});

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

async function worklist(token: string) {
  const res = await api().get('/api/v1/worklist').set(bearer(token));
  expect(res.status).toBe(200);
  return res.body as Record<
    | 'draftNotes'
    | 'returnedPrescriptions'
    | 'unacknowledgedResults'
    | 'imagingToReview'
    | 'coveredResults',
    { id: string }[]
  >;
}

/** Work a doctor leaves at a facility: a draft, a returned prescription and three results. */
async function workAt(facilityId: string, doctorId: string, pharmacistId: string) {
  const patient = await createPatient(facilityId);
  const [draft] = await db
    .insert(encounters)
    .values({
      patientId: patient.id,
      doctorId,
      facilityId,
      type: 'OUTPATIENT',
      reason: 'Follow-up of hypertension',
    })
    .returning();
  const [rx] = await db
    .insert(prescriptions)
    .values({
      patientId: patient.id,
      doctorId,
      medication: 'Amlodipine 5 mg',
      dosage: '5 mg',
      frequency: 'once a day',
      startDate: '2026-11-01',
      pharmacyStatus: 'RETURNED',
      pharmacistNote: 'Interaction to review',
      verifiedById: pharmacistId,
      verifiedAt: new Date(),
    })
    .returning();
  const [order] = await db
    .insert(labOrders)
    .values({
      placerOrderNumber: `W${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      patientId: patient.id,
      orderedById: doctorId,
      facilityId,
      testCode: '2823-3',
      testName: 'Potassium',
    })
    .returning();
  const [ordered] = await db
    .insert(labResults)
    .values({
      patientId: patient.id,
      orderedById: doctorId,
      orderId: order!.id,
      testName: 'Potassium',
      value: '6.4',
      flag: 'CRITICAL',
      source: 'LIS',
    })
    .returning();
  // Entered by hand outside a visit: no facility is known.
  const [byHand] = await db
    .insert(labResults)
    .values({ patientId: patient.id, orderedById: doctorId, testName: 'Glucose', value: '5.1' })
    .returning();
  const [image] = await db
    .insert(imagingOrders)
    .values({
      accessionNumber: `A${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      patientId: patient.id,
      facilityId,
      orderedById: doctorId,
      modality: 'XRAY',
      bodyPart: 'Thorax',
      clinicalQuestion: 'Pneumonia?',
      status: 'REPORTED',
      impression: 'No consolidation',
      reportedAt: new Date(),
    })
    .returning();
  return { draft: draft!, rx: rx!, ordered: ordered!, byHand: byHand!, image: image! };
}

describe('a doctor’s worklist', () => {
  it('lists only the work of the doctor’s current facility', async () => {
    const doctor = await createUser('DOCTOR', w.facility.id);
    const old = await workAt(w.facility.id, doctor.id, w.users.pharmacist.id);
    const before = await worklist(await login(doctor.email));
    expect(ids(before.draftNotes)).toContain(old.draft.id);
    expect(ids(before.returnedPrescriptions)).toContain(old.rx.id);
    expect(ids(before.unacknowledgedResults)).toEqual(
      expect.arrayContaining([old.ordered.id, old.byHand.id]),
    );
    expect(ids(before.imagingToReview)).toContain(old.image.id);

    // The administrator's move waits until all of this is handed over; should the facility
    // change all the same (here directly in the database), the old facility's work stays there.
    await db.update(users).set({ facilityId: w.otherFacility.id }).where(eq(users.id, doctor.id));
    const fresh = await workAt(w.otherFacility.id, doctor.id, w.users.outsidePharmacist.id);
    const after = await worklist(await login(doctor.email));
    expect(ids(after.draftNotes)).toEqual([fresh.draft.id]);
    // Returned prescriptions are not filtered: the move itself waits until they are handed over.
    expect(ids(after.returnedPrescriptions)).toEqual(
      expect.arrayContaining([old.rx.id, fresh.rx.id]),
    );
    expect(ids(after.imagingToReview)).toEqual([fresh.image.id]);
    const results = ids(after.unacknowledgedResults);
    expect(results).not.toContain(old.ordered.id);
    expect(results).toContain(fresh.ordered.id);
    // A result without a known facility stays listed: an unreviewed result must not disappear.
    expect(results).toEqual(expect.arrayContaining([old.byHand.id, fresh.byHand.id]));
  });

  it('keeps the work of a doctor who never moved, whatever visit it is linked to', async () => {
    const doctor = await createUser('DOCTOR', w.facility.id);
    const patient = await createPatient(w.facility.id);
    // An earlier visit of the same patient at another facility.
    const [elsewhere] = await db
      .insert(encounters)
      .values({
        patientId: patient.id,
        doctorId: w.users.outsideDoctor.id,
        facilityId: w.otherFacility.id,
        type: 'OUTPATIENT',
        reason: 'Earlier visit',
        noteStatus: 'SIGNED',
      })
      .returning();
    const [result] = await db
      .insert(labResults)
      .values({
        patientId: patient.id,
        orderedById: doctor.id,
        encounterId: elsewhere!.id,
        testName: 'Potassium',
        value: '6.9',
        flag: 'CRITICAL',
      })
      .returning();
    const [rx] = await db
      .insert(prescriptions)
      .values({
        patientId: patient.id,
        doctorId: doctor.id,
        encounterId: elsewhere!.id,
        medication: 'Ramipril 5 mg',
        dosage: '5 mg',
        frequency: 'once a day',
        startDate: '2026-11-01',
        pharmacyStatus: 'RETURNED',
        pharmacistNote: 'Kidney function to check',
        verifiedById: w.users.pharmacist.id,
        verifiedAt: new Date(),
      })
      .returning();
    const list = await worklist(await login(doctor.email));
    expect(ids(list.unacknowledgedResults)).toContain(result!.id);
    expect(ids(list.returnedPrescriptions)).toContain(rx!.id);
  });
});
