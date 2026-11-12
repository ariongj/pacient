import { and, eq, inArray, or } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { auditLogs, drugInteractions, notifications, users } from '../src/db/schema.js';
import { internalEan13 } from '../src/modules/bcma/barcode.js';
import { invalidateInteractionCache, orderPair } from '../src/modules/safety/engine.js';
import { SEED_INTERACTIONS } from '../src/modules/safety/knowledge.js';
import { escalateOverdueOnce } from '../src/modules/sepsis/sepsis.service.js';
import { api, bearer, createUser, createWorld, login, nextNationalId } from './helpers.js';

/**
 * The whole patient cycle as ONE continuous story on one new patient, through the real API:
 * registration → appointment → visit → laboratory → pharmacy → imaging → referral → admission →
 * discharge → certificate → billing → vaccination → documents → history → patient portal.
 *
 * Each stage is its own test and asserts that it SEES what the stage before produced. The stages
 * depend on each other and run in order (one failing stage fails the ones after it).
 *
 * Direct database access is used only where there is no API for it:
 *  - seeding the drug-interaction reference data (a migration/seed task in production);
 *  - reading audit rows and notification rows of staff to check what was recorded;
 *  - running the sepsis escalation worker once (workers have no API).
 */

type World = Awaited<ReturnType<typeof createWorld>>;
type Staff = { id: string; token: string; fullName: string };

let w: World;
let labTech: Staff;
let labTech2: Staff;
let radiologist: Staff;
let radiographer: Staff;
let wardNurse: Staff;
let itSupport: Staff;

const iso = (d: Date) => d.toISOString();
const dayOffset = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const uniq = Math.random().toString(36).slice(2, 8);

/** The journey's state, filled in stage by stage. */
const j = {
  patientId: '',
  patientToken: '',
  patientUserId: '',
  firstName: 'Blerim',
  lastName: `Rrugëtimi${uniq}`,
  nationalId: nextNationalId(),
  email: `journey-${uniq}@test.local`,
  appointmentId: '',
  encounterId: '',
  encounterVersion: 0,
  diagnosisId: '',
  allergyId: '',
  labOrderId: '',
  labOrderNumber: '',
  preliminaryResultId: '',
  finalResultId: '',
  catalogItemId: '',
  packBarcode: internalEan13(Math.floor(Math.random() * 1e9), 291),
  otherPackBarcode: internalEan13(Math.floor(Math.random() * 1e9), 292),
  prescriptionId: '',
  imagingOrderId: '',
  referralId: '',
  wardId: '',
  bedId: '',
  admissionId: '',
  careTaskId: '',
  certificateId: '',
  verificationCode: '',
  chargeIds: [] as string[],
  paymentId: '',
  immunizationId: '',
  documentId: '',
  threadId: '',
};

const base = () => `/api/v1/patients/${j.patientId}`;
const get = (path: string, token: string) => api().get(path).set(bearer(token));
const post = (path: string, token: string, body: Record<string, unknown> = {}) =>
  api().post(path).set(bearer(token)).send(body);

async function staff(
  role: Parameters<typeof createUser>[0],
  facilityId: string,
  extra: Record<string, unknown> = {},
): Promise<Staff> {
  const u = await createUser(role, facilityId, extra);
  return { id: u.id, token: await login(u.email), fullName: u.fullName };
}

async function viewsBy(userId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.patientId, j.patientId),
        eq(auditLogs.actorUserId, userId),
        eq(auditLogs.action, 'patient.record.viewed'),
      ),
    );
}

beforeAll(async () => {
  w = await createWorld();
  labTech = await staff('LAB_TECHNICIAN', w.facility.id);
  labTech2 = await staff('LAB_TECHNICIAN', w.facility.id);
  radiologist = await staff('DOCTOR', w.facility.id, { specialty: 'Radiology' });
  radiographer = await staff('NURSE', w.facility.id);
  wardNurse = await staff('NURSE', w.facility.id);
  itSupport = await staff('IT_SUPPORT', w.facility.id);

  // Reference data that a deployment seeds once (no API creates the whole set).
  const rows = SEED_INTERACTIONS.map(([x, y, severity, effect, management]) => {
    const [a, b] = orderPair(x, y);
    return { ingredientA: a, ingredientB: b, severity, effect, management };
  });
  await db.insert(drugInteractions).values(rows).onConflictDoNothing();
  invalidateInteractionCache();

  // The director sets up the hospital through the API: a ward with beds and a radiology unit.
  const dir = w.tokens.director;
  const ward = await post('/api/v1/hospital/units', dir, {
    name: 'Interna – rrugëtimi',
    code: `J${uniq}`.slice(0, 10),
    type: 'GENERAL_WARD',
  });
  expect(ward.status).toBe(201);
  j.wardId = ward.body.id;
  const bedsRes = await post(`/api/v1/hospital/units/${j.wardId}/beds`, dir, {
    prefix: 'J',
    from: 1,
    to: 2,
  });
  expect(bedsRes.status).toBe(201);
  j.bedId = bedsRes.body.items[0].id;
  const radiology = await post('/api/v1/hospital/units', dir, {
    name: 'Radiologjia – rrugëtimi',
    code: `R${uniq}`.slice(0, 10),
    type: 'RADIOLOGY',
  });
  expect(radiology.status).toBe(201);
  for (const [unitId, userId] of [
    [j.wardId, wardNurse.id],
    [radiology.body.id, radiologist.id],
    [radiology.body.id, radiographer.id],
  ] as const) {
    expect((await post(`/api/v1/hospital/units/${unitId}/staff`, dir, { userId })).status).toBe(
      201,
    );
  }
});

describe('a. registration at the front desk', () => {
  const registration = () => ({
    nationalId: j.nationalId,
    firstName: j.firstName,
    lastName: j.lastName,
    dateOfBirth: '1985-03-14',
    sex: 'MALE',
    phone: '+38344123456',
    email: j.email,
    municipality: 'Prishtinë',
  });

  it('reception registers a new patient with a portal invitation', async () => {
    const res = await post('/api/v1/patients', w.tokens.reception, {
      ...registration(),
      createPortalAccount: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.patient).toMatchObject({
      nationalId: j.nationalId,
      lastName: j.lastName,
      primaryFacilityId: w.facility.id,
    });
    expect(res.body.activationUrl).toMatch(/token=/);
    j.patientId = res.body.patient.id;

    // The patient chooses a password through the activation link and signs in.
    const token = new URL(res.body.activationUrl).searchParams.get('token')!;
    const activated = await api()
      .post('/api/v1/auth/activate')
      .send({ token, password: 'journey-passphrase-2026' });
    expect(activated.status).toBe(204);
    j.patientToken = await login(j.email, 'journey-passphrase-2026');
    const me = await get('/api/v1/auth/me', j.patientToken);
    expect(me.body).toMatchObject({ role: 'PATIENT', patientId: j.patientId });
    j.patientUserId = me.body.id;
  });

  it('flags the same national ID and a likely duplicate (same name and date of birth)', async () => {
    const same = await post('/api/v1/patients', w.tokens.reception, registration());
    expect(same.status).toBe(409);
    const lookalike = await post('/api/v1/patients', w.tokens.reception, {
      ...registration(),
      nationalId: nextNationalId(),
      email: undefined,
    });
    expect(lookalike.status).toBe(409);
    expect(lookalike.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(lookalike.body.error.details[0].id).toBe(j.patientId);
  });

  it('reception finds the patient in search, with identification only', async () => {
    const res = await get(
      `/api/v1/patients?search=${encodeURIComponent(j.lastName)}`,
      w.tokens.reception,
    );
    expect(res.status).toBe(200);
    const row = res.body.items.find((p: { id: string }) => p.id === j.patientId);
    expect(row).toMatchObject({ nationalId: j.nationalId, hasPortalAccount: true });
    expect(Object.keys(row).sort()).toEqual(
      [
        'dateOfBirth',
        'firstName',
        'hasPortalAccount',
        'id',
        'inMyCare',
        'lastName',
        'nationalId',
        'primaryFacilityId',
        'sex',
        'temporaryIdentity',
      ].sort(),
    );
  });
});

describe('b. appointment', () => {
  it('reception books the doctor; the patient and the doctor both see it', async () => {
    const res = await post('/api/v1/appointments', w.tokens.reception, {
      patientId: j.patientId,
      doctorId: w.users.doctor.id,
      scheduledAt: iso(new Date(Date.now() + 45 * 60_000)),
      durationMinutes: 20,
      reason: 'Kollë dhe temperaturë prej tri ditësh',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('CONFIRMED');
    j.appointmentId = res.body.id;

    const mine = await get('/api/v1/appointments', j.patientToken);
    expect(mine.body.items.map((a: { id: string }) => a.id)).toContain(j.appointmentId);
    const schedule = await get('/api/v1/appointments', w.tokens.doctor);
    const row = schedule.body.items.find((a: { id: string }) => a.id === j.appointmentId);
    expect(row).toMatchObject({ patientId: j.patientId, status: 'CONFIRMED' });
  });

  it('reception checks the patient in on arrival; the doctor is told', async () => {
    const res = await api()
      .patch(`/api/v1/appointments/${j.appointmentId}/status`)
      .set(bearer(w.tokens.reception))
      .send({ status: 'CHECKED_IN' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CHECKED_IN');
    const notes = await get('/api/v1/notifications', w.tokens.doctor);
    const titles = notes.body.items.map((n: { title: string }) => n.title);
    expect(titles).toContain('Your patient has arrived');
    expect(titles).toContain('An appointment was booked for you');
  });
});

describe('c. the doctor opens the chart', () => {
  it('has no access before joining the care team (denial audited)', async () => {
    const res = await get(`${base()}/summary`, w.tokens.doctor);
    expect(res.status).toBe(403);
    const denied = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.patientId, j.patientId),
          eq(auditLogs.actorUserId, w.users.doctor.id),
          eq(auditLogs.action, 'patient.record.access_denied'),
        ),
      );
    expect(denied.length).toBeGreaterThan(0);
  });

  it('joins the care team of a patient of the facility and opens the chart (audited)', async () => {
    expect((await post(`${base()}/care-team`, w.tokens.doctor)).status).toBe(201);
    expect((await post(`${base()}/care-team`, w.tokens.nurse)).status).toBe(201);
    const res = await get(`${base()}/summary`, w.tokens.doctor);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      accessBasis: 'CARE_TEAM',
      patient: { id: j.patientId, allergyAssessment: 'NOT_RECORDED' },
      allergies: [],
      activeProblems: [],
    });
    const views = await viewsBy(w.users.doctor.id);
    expect(views.some((v) => (v.metadata as { section?: string }).section === 'summary')).toBe(
      true,
    );
    const team = await get(`${base()}/care-team`, w.tokens.doctor);
    expect(team.body.items.map((m: { doctorId: string }) => m.doctorId).sort()).toEqual(
      [w.users.doctor.id, w.users.nurse.id].sort(),
    );
  });
});

describe('d. nursing assessment', () => {
  it('the nurse records vital signs (early-warning score computed) and an allergy', async () => {
    const vitals = await post(`${base()}/vitals`, w.tokens.nurse, {
      systolic: 128,
      diastolic: 82,
      heartRate: 96,
      temperatureC: 38.4,
      respiratoryRate: 20,
      oxygenSaturation: 96,
      consciousness: 'A',
      onSupplementalOxygen: false,
      weightKg: 82,
      heightCm: 180,
    });
    expect(vitals.status).toBe(201);
    expect(vitals.body.news).toMatchObject({ scale: 'NEWS2', complete: true });
    expect(vitals.body.news.score).toBeGreaterThan(0);

    const allergy = await post(`${base()}/allergies`, w.tokens.nurse, {
      substance: 'Penicillin',
      reaction: 'Urtikarie',
      severity: 'MODERATE',
      source: 'PATIENT_REPORTED',
    });
    expect(allergy.status).toBe(201);
    j.allergyId = allergy.body.id;

    // The doctor sees both in the chart.
    const summary = await get(`${base()}/summary`, w.tokens.doctor);
    expect(summary.body.patient.allergyAssessment).toBe('ALLERGIES_RECORDED');
    expect(summary.body.allergies[0]).toMatchObject({
      substance: 'Penicillin',
      verificationStatus: 'UNCONFIRMED',
    });
    expect(summary.body.latestVitals).toMatchObject({ heartRate: 96, systolic: 128 });
  });
});

describe('e. the visit', () => {
  it('the doctor opens a visit, adds a diagnosis, confirms the allergy and writes the note', async () => {
    const enc = await post(`${base()}/encounters`, w.tokens.doctor, {
      type: 'OUTPATIENT',
      reason: 'Kollë dhe temperaturë',
    });
    expect(enc.status).toBe(201);
    expect(enc.body.noteStatus).toBe('DRAFT');
    j.encounterId = enc.body.id;

    const dx = await post(`${base()}/diagnoses`, w.tokens.doctor, {
      encounterId: j.encounterId,
      icd10Code: 'J18.9',
      description: 'Pneumoni, e paspecifikuar',
    });
    expect(dx.status).toBe(201);
    j.diagnosisId = dx.body.id;

    const confirmed = await api()
      .patch(`${base()}/allergies/${j.allergyId}`)
      .set(bearer(w.tokens.doctor))
      .send({ verificationStatus: 'CONFIRMED' });
    expect(confirmed.status).toBe(200);

    const edited = await api()
      .patch(`${base()}/encounters/${j.encounterId}`)
      .set(bearer(w.tokens.doctor))
      .send({ version: enc.body.version, notes: 'Krepitacione në bazën e djathtë. SpO2 96 %.' });
    expect(edited.status).toBe(200);
    j.encounterVersion = edited.body.version;

    // The draft is on the doctor's worklist until it is signed.
    const worklist = await get('/api/v1/worklist', w.tokens.doctor);
    expect(worklist.body.draftNotes.map((d: { id: string }) => d.id)).toContain(j.encounterId);
    // The patient does not see an unsigned note.
    const own = await get(`${base()}/encounters`, j.patientToken);
    expect(own.status).toBe(200);
    expect(own.body.items.find((e: { id: string }) => e.id === j.encounterId)?.notes ?? null).toBe(
      null,
    );
  });

  it('signs the note: it can no longer be edited, only amended', async () => {
    const signed = await post(`${base()}/encounters/${j.encounterId}/sign`, w.tokens.doctor, {
      version: j.encounterVersion,
    });
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ noteStatus: 'SIGNED', signedById: w.users.doctor.id });

    const edit = await api()
      .patch(`${base()}/encounters/${j.encounterId}`)
      .set(bearer(w.tokens.doctor))
      .send({ version: signed.body.version, notes: 'Changed afterwards' });
    expect(edit.status).toBe(409);

    const addendum = await post(`${base()}/encounters/${j.encounterId}/addenda`, w.tokens.doctor, {
      reason: 'Plotësim',
      content: 'Pacienti u këshillua për hidratim dhe pushim.',
    });
    expect(addendum.status).toBe(201);

    const list = await get(`${base()}/encounters`, w.tokens.doctor);
    const visit = list.body.items.find((e: { id: string }) => e.id === j.encounterId);
    expect(visit.noteStatus).toBe('SIGNED');
    expect(visit.notes).toContain('Krepitacione');
    expect(JSON.stringify(visit)).toContain('hidratim');

    // The appointment is completed; the patient now sees the signed note and the diagnosis.
    const done = await api()
      .patch(`/api/v1/appointments/${j.appointmentId}/status`)
      .set(bearer(w.tokens.doctor))
      .send({ status: 'COMPLETED' });
    expect(done.status).toBe(200);
    const own = await get(`${base()}/summary`, j.patientToken);
    expect(own.body.accessBasis).toBe('SELF');
    expect(own.body.activeProblems.map((d: { icd10Code: string }) => d.icd10Code)).toContain(
      'J18.9',
    );
    expect(
      own.body.recentEncounters.find((e: { id: string }) => e.id === j.encounterId).notes,
    ).toContain('Krepitacione');
  });
});

describe('f. laboratory', () => {
  it('the doctor orders a test; the laboratory worklist shows it with identification only', async () => {
    const order = await post(`${base()}/lab-orders`, w.tokens.doctor, {
      testCode: '718-7',
      priority: 'URGENT',
      clinicalNotes: 'Pneumoni – hemogram',
      encounterId: j.encounterId,
    });
    expect(order.status).toBe(201);
    j.labOrderId = order.body.id;
    j.labOrderNumber = order.body.placerOrderNumber;

    const list = await get('/api/v1/lab-work/worklist', labTech.token);
    expect(list.status).toBe(200);
    const row = list.body.items.find((i: { id: string }) => i.id === j.labOrderId);
    expect(row).toMatchObject({
      status: 'ORDERED',
      priority: 'URGENT',
      patient: { nationalId: j.nationalId, lastName: j.lastName },
    });
    // No diagnosis, allergy or note reaches the laboratory.
    expect(JSON.stringify(row)).not.toMatch(/J18\.9|Penicillin|Krepitacione/);
    // The laboratory cannot open the chart.
    expect((await get(`${base()}/summary`, labTech.token)).status).toBe(403);
  });

  it('specimen collected and received, result entered and validated by a second person', async () => {
    const lab = (path: string, token: string, body: Record<string, unknown> = {}) =>
      post(`/api/v1/lab-work${path}`, token, body);
    expect((await lab(`/orders/${j.labOrderId}/collect`, labTech.token)).status).toBe(200);
    const received = await lab(`/orders/${j.labOrderId}/receive`, labTech.token, {
      barcode: j.labOrderNumber,
    });
    expect(received.status).toBe(200);
    expect(received.body.status).toBe('RECEIVED');

    // The ordering doctor sees the progress in the chart.
    const orders = await get(`${base()}/lab-orders`, w.tokens.doctor);
    expect(orders.body.items.find((o: { id: string }) => o.id === j.labOrderId).status).toBe(
      'RECEIVED',
    );

    const entered = await lab(`/orders/${j.labOrderId}/result`, labTech.token, { value: '118' });
    expect(entered.status).toBe(201);
    expect(entered.body).toMatchObject({ status: 'PRELIMINARY', flag: 'LOW' });
    j.preliminaryResultId = entered.body.id;

    expect((await lab(`/results/${j.preliminaryResultId}/validate`, labTech.token)).status).toBe(
      403,
    );
    const validated = await lab(`/results/${j.preliminaryResultId}/validate`, labTech2.token);
    expect(validated.status).toBe(200);
    expect(validated.body.status).toBe('FINAL');
    j.finalResultId = validated.body.id;
  });

  it('the doctor finds the final result on the worklist, acknowledges and releases it', async () => {
    const worklist = await get('/api/v1/worklist', w.tokens.doctor);
    expect(worklist.status).toBe(200);
    const pending = worklist.body.unacknowledgedResults.find(
      (r: { id: string }) => r.id === j.finalResultId,
    );
    expect(pending).toMatchObject({ patientId: j.patientId, value: '118', flag: 'LOW' });
    expect(
      worklist.body.unacknowledgedResults.find(
        (r: { id: string }) => r.id === j.preliminaryResultId,
      ),
    ).toBeUndefined();

    // Not visible to the patient before release – and release needs acknowledgement first.
    const before = await get(`${base()}/lab-results`, j.patientToken);
    expect(before.body.items).toEqual([]);
    const early = await post(`${base()}/lab-results/${j.finalResultId}/release`, w.tokens.doctor);
    expect(early.status).toBe(409);

    const ack = await post(`${base()}/lab-results/${j.finalResultId}/acknowledge`, w.tokens.doctor);
    expect(ack.status).toBe(200);
    const released = await post(
      `${base()}/lab-results/${j.finalResultId}/release`,
      w.tokens.doctor,
    );
    expect(released.status).toBe(200);

    const after = await get('/api/v1/worklist', w.tokens.doctor);
    expect(
      after.body.unacknowledgedResults.find((r: { id: string }) => r.id === j.finalResultId),
    ).toBeUndefined();
    const own = await get(`${base()}/lab-results`, j.patientToken);
    expect(own.body.items).toHaveLength(1);
    expect(own.body.items[0]).toMatchObject({ id: j.finalResultId, value: '118', status: 'FINAL' });
    const chart = await get(`${base()}/lab-orders`, w.tokens.doctor);
    expect(chart.body.items.find((o: { id: string }) => o.id === j.labOrderId).status).toBe(
      'RESULTED',
    );
  });
});

describe('g. prescribing and the pharmacy', () => {
  it('the Ministry lists the medicine and the pharmacy has it in stock', async () => {
    const item = await post('/api/v1/stock/catalog', w.tokens.ministry, {
      name: `Paracetamol J${uniq}`,
      atcCode: 'N02BE01',
      form: 'tablet',
      strength: '500 mg',
      unit: 'tablet',
      isEssential: true,
      barcode: j.packBarcode,
      ingredients: ['Paracetamol'],
    });
    expect(item.status).toBe(201);
    expect(item.body).toMatchObject({ barcode: j.packBarcode, ingredients: ['paracetamol'] });
    j.catalogItemId = item.body.id;
    // A pack barcode identifies one item only, and must be a real GTIN (check digit).
    const other = (barcode: string) =>
      post('/api/v1/stock/catalog', w.tokens.ministry, {
        name: `Ibuprofen J${uniq}`,
        form: 'tablet',
        strength: '400 mg',
        unit: 'tablet',
        barcode,
        ingredients: ['ibuprofen'],
      });
    expect((await other(j.packBarcode)).status).toBe(409);
    expect(
      (await other(`${j.packBarcode.slice(0, 12)}${(Number(j.packBarcode[12]) + 1) % 10}`)).status,
    ).toBe(400);
    expect((await other(j.otherPackBarcode)).status).toBe(201);
    const receipt = await post('/api/v1/stock/receipts', w.tokens.pharmacist, {
      supplier: 'Depoja qendrore',
      items: [
        {
          itemId: j.catalogItemId,
          batchNumber: `B-${uniq}`,
          expiryDate: dayOffset(300),
          quantity: 100,
        },
      ],
    });
    expect(receipt.status).toBe(201);
  });

  it('the recorded penicillin allergy stops amoxicillin; a safe medicine is prescribed', async () => {
    const blocked = await post(`${base()}/prescriptions`, w.tokens.doctor, {
      medication: 'Amoxicillin 500 mg',
      dosage: '500 mg',
      frequency: 'three times a day',
      startDate: dayOffset(0),
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SAFETY_ALERTS');
    expect(
      blocked.body.error.details.alerts.some(
        (a: { kind: string; blocking: boolean }) => a.kind === 'ALLERGY' && a.blocking,
      ),
    ).toBe(true);

    const rx = await post(`${base()}/prescriptions`, w.tokens.doctor, {
      encounterId: j.encounterId,
      medication: `Paracetamol J${uniq} 500 mg`,
      catalogItemId: j.catalogItemId,
      doseAmount: 500,
      doseUnit: 'mg',
      frequencyCode: 'Q6H',
      durationDays: 5,
      startDate: dayOffset(0),
      instructions: 'Pas ushqimit',
    });
    expect(rx.status).toBe(201);
    expect(rx.body).toMatchObject({ pharmacyStatus: 'PENDING', status: 'ACTIVE' });
    expect(rx.body.endDate).toBe(dayOffset(4));
    j.prescriptionId = rx.body.id;
  });

  it('the pharmacist sees it with the medication context, verifies and dispenses from stock', async () => {
    const queue = await get('/api/v1/pharmacy/queue?status=PENDING', w.tokens.pharmacist);
    expect(queue.status).toBe(200);
    expect(queue.body.items.map((p: { id: string }) => p.id)).toContain(j.prescriptionId);

    const detail = await get(
      `/api/v1/pharmacy/prescriptions/${j.prescriptionId}`,
      w.tokens.pharmacist,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.allergies.map((a: { substance: string }) => a.substance)).toContain(
      'Penicillin',
    );
    expect(detail.body.latestWeight).not.toBeNull();
    // The pharmacist gets the medication context, never the chart.
    expect((await get(`${base()}/summary`, w.tokens.pharmacist)).status).toBe(403);

    // Not dispensable (or administrable) before verification.
    const early = await post(
      `/api/v1/pharmacy/prescriptions/${j.prescriptionId}/dispense`,
      w.tokens.pharmacist,
      { stock: { units: 20 } },
    );
    expect(early.status).toBe(409);

    const verified = await post(
      `/api/v1/pharmacy/prescriptions/${j.prescriptionId}/verify`,
      w.tokens.pharmacist,
      { alertsReviewed: true, note: 'Doza në rregull' },
    );
    expect(verified.status).toBe(200);
    expect(verified.body.pharmacyStatus).toBe('VERIFIED');

    const stock = await get(
      `/api/v1/pharmacy/prescriptions/${j.prescriptionId}/stock`,
      w.tokens.pharmacist,
    );
    expect(stock.body.item.id).toBe(j.catalogItemId);
    expect(stock.body.level.onHand ?? stock.body.level.quantity).toBe(100);

    const dispensed = await post(
      `/api/v1/pharmacy/prescriptions/${j.prescriptionId}/dispense`,
      w.tokens.pharmacist,
      { stock: { units: 20 } },
    );
    expect(dispensed.status).toBe(200);
    expect(dispensed.body).toMatchObject({
      pharmacyStatus: 'DISPENSED',
      dispensedQuantity: '20 tablet',
    });

    const batches = await get(
      `/api/v1/stock/items/${j.catalogItemId}/batches`,
      w.tokens.pharmacist,
    );
    expect(batches.body.batches[0].quantity).toBe(80);
    const movements = await get(
      `/api/v1/stock/movements?itemId=${j.catalogItemId}&type=DISPENSE`,
      w.tokens.pharmacist,
    );
    expect(movements.body.items).toHaveLength(1);

    // The doctor and the patient both see the dispensed medicine.
    const chart = await get(`${base()}/prescriptions`, w.tokens.doctor);
    expect(
      chart.body.items.find((p: { id: string }) => p.id === j.prescriptionId).pharmacyStatus,
    ).toBe('DISPENSED');
    const own = await get(`${base()}/prescriptions`, j.patientToken);
    expect(own.body.items.map((p: { id: string }) => p.id)).toContain(j.prescriptionId);
  });
});

describe('g2. a prescription the pharmacy sends back', () => {
  it('returns to the prescriber with a reason, is corrected, resubmitted and verified', async () => {
    const rx = await post(`${base()}/prescriptions`, w.tokens.doctor, {
      medication: 'Ambroxol 30 mg',
      dosage: '30 mg',
      frequency: 'tri herë në ditë',
      startDate: dayOffset(0),
    });
    expect(rx.status).toBe(201);
    const returned = await post(
      `/api/v1/pharmacy/prescriptions/${rx.body.id}/return`,
      w.tokens.pharmacist,
      { note: 'Ju lutem shënoni kohëzgjatjen e terapisë' },
    );
    expect(returned.status).toBe(200);
    expect(returned.body.pharmacyStatus).toBe('RETURNED');

    // It is on the prescriber's worklist with the pharmacist's note, and cannot be given.
    const worklist = await get('/api/v1/worklist', w.tokens.doctor);
    const mine = worklist.body.returnedPrescriptions.find(
      (p: { id: string }) => p.id === rx.body.id,
    );
    expect(mine).toMatchObject({
      patientId: j.patientId,
      pharmacistNote: 'Ju lutem shënoni kohëzgjatjen e terapisë',
    });
    const refused = await post(`${base()}/medication-administrations`, w.tokens.nurse, {
      prescriptionId: rx.body.id,
      status: 'GIVEN',
      scanOverrideReason: 'Pa barkod në këtë fazë',
    });
    expect(refused.status).toBe(409);

    const again = await post(`${base()}/prescriptions/${rx.body.id}/resubmit`, w.tokens.doctor, {
      frequency: 'tri herë në ditë, 7 ditë',
      note: 'U shtua kohëzgjatja',
    });
    expect(again.status).toBe(200);
    expect(again.body.pharmacyStatus).toBe('PENDING');
    const after = await get('/api/v1/worklist', w.tokens.doctor);
    expect(
      after.body.returnedPrescriptions.find((p: { id: string }) => p.id === rx.body.id),
    ).toBeUndefined();
    const queue = await get('/api/v1/pharmacy/queue?status=PENDING', w.tokens.pharmacist);
    expect(queue.body.items.find((p: { id: string }) => p.id === rx.body.id).frequency).toContain(
      '7 ditë',
    );
    const verified = await post(
      `/api/v1/pharmacy/prescriptions/${rx.body.id}/verify`,
      w.tokens.pharmacist,
      { alertsReviewed: true, note: 'Në rregull tani' },
    );
    expect(verified.status).toBe(200);
  });
});

describe('h. imaging', () => {
  it('ordered, performed by the radiographer, reported by the radiologist, reviewed and released', async () => {
    const order = await post('/api/v1/imaging/orders', w.tokens.doctor, {
      patientId: j.patientId,
      modality: 'XRAY',
      bodyPart: 'Chest',
      clinicalQuestion: 'Pneumoni e lobit të poshtëm të djathtë?',
      priority: 'URGENT',
      safetyChecks: {},
      encounterId: j.encounterId,
    });
    expect(order.status).toBe(201);
    j.imagingOrderId = order.body.id;

    const worklist = await get('/api/v1/imaging/worklist', radiographer.token);
    expect(worklist.body.items.map((o: { id: string }) => o.id)).toContain(j.imagingOrderId);
    const step = (action: string, token: string, body: Record<string, unknown> = {}) =>
      post(`/api/v1/imaging/orders/${j.imagingOrderId}/${action}`, token, body);
    expect((await step('perform', radiographer.token)).status).toBe(200);
    const report = await step('report', radiologist.token, {
      findings: 'Konsolidim në lobin e poshtëm të djathtë. Pa efuzion pleural.',
      impression: 'Pneumoni e lobit të poshtëm të djathtë',
    });
    expect(report.status).toBe(200);

    // The ordering doctor has it to review; the patient sees nothing before release.
    const mine = await get('/api/v1/worklist', w.tokens.doctor);
    expect(
      mine.body.imagingToReview.map((o: { id: string }) => o.id),
      JSON.stringify(Object.keys(mine.body)),
    ).toContain(j.imagingOrderId);
    const chart = await get(`/api/v1/imaging/patients/${j.patientId}/orders`, w.tokens.doctor);
    expect(chart.body.items.find((o: { id: string }) => o.id === j.imagingOrderId)).toMatchObject({
      status: 'REPORTED',
      impression: 'Pneumoni e lobit të poshtëm të djathtë',
    });
    const before = await get(`/api/v1/imaging/patients/${j.patientId}/orders`, j.patientToken);
    expect(
      before.body.items.find((o: { id: string }) => o.id === j.imagingOrderId)?.impression ?? null,
    ).toBeNull();

    expect((await step('acknowledge', w.tokens.doctor)).status).toBe(200);
    expect((await step('release', w.tokens.doctor)).status).toBe(200);
    const after = await get(`/api/v1/imaging/patients/${j.patientId}/orders`, j.patientToken);
    expect(
      after.body.items.find((o: { id: string }) => o.id === j.imagingOrderId).impression,
    ).toContain('Pneumoni');
  });
});

describe('i. referral to another facility', () => {
  it('the other facility has no access before the referral is accepted', async () => {
    expect((await get(`${base()}/summary`, w.tokens.outsideDoctor)).status).toBe(403);
    const referral = await post('/api/v1/referrals', w.tokens.doctor, {
      patientId: j.patientId,
      toFacilityId: w.otherFacility.id,
      toDoctorId: w.users.outsideDoctor.id,
      specialty: 'Pulmonology',
      priority: 'ROUTINE',
      reason: 'Kontroll pulmologjik pas pneumonisë',
      clinicalSummary: 'Pneumoni e lobit të poshtëm të djathtë, e trajtuar. Kërkohet kontroll.',
    });
    expect(referral.status).toBe(201);
    j.referralId = referral.body.id;
    // A pending referral alone opens nothing.
    expect((await get(`${base()}/summary`, w.tokens.outsideDoctor)).status).toBe(403);
    const incoming = await get('/api/v1/referrals', w.tokens.outsideDoctor);
    expect(incoming.body.items.map((r: { id: string }) => r.id)).toContain(j.referralId);
  });

  it('acceptance gives the receiving doctor the record', async () => {
    const accepted = await post(
      `/api/v1/referrals/${j.referralId}/accept`,
      w.tokens.outsideDoctor,
      {
        responseNote: 'Termin javën e ardhshme',
      },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('ACCEPTED');
    const chart = await get(`${base()}/summary`, w.tokens.outsideDoctor);
    expect(chart.status).toBe(200);
    expect(chart.body.activeProblems.map((d: { icd10Code: string }) => d.icd10Code)).toContain(
      'J18.9',
    );
    // The referring doctor and the patient see the outcome.
    const sent = await get('/api/v1/referrals', w.tokens.doctor);
    expect(sent.body.items.find((r: { id: string }) => r.id === j.referralId).status).toBe(
      'ACCEPTED',
    );
    const own = await get('/api/v1/referrals', j.patientToken);
    expect(own.body.items.find((r: { id: string }) => r.id === j.referralId).status).toBe(
      'ACCEPTED',
    );
  });
});

describe('j. admission to the ward', () => {
  it('the doctor admits the patient to a bed; the bed board shows it', async () => {
    // The ward nurse has no access to the patient before the admission.
    expect((await get(`${base()}/summary`, wardNurse.token)).status).toBe(403);
    const res = await post('/api/v1/hospital/admissions', w.tokens.doctor, {
      patientId: j.patientId,
      unitId: j.wardId,
      bedId: j.bedId,
      source: 'ELECTIVE',
      reason: 'Pneumoni me përkeqësim, nevojë për oksigjen',
    });
    expect(res.status).toBe(201);
    j.admissionId = res.body.id;

    const board = await get('/api/v1/hospital/board', wardNurse.token);
    const unit = board.body.units.find((u: { id: string }) => u.id === j.wardId);
    const bed = unit.beds.find((b: { id: string }) => b.id === j.bedId);
    expect(bed).toMatchObject({ status: 'OCCUPIED', stay: { patientId: j.patientId } });
    expect(bed.stay.reason).toContain('Pneumoni');
    // Reception sees who is in which bed, never why.
    const desk = await get('/api/v1/hospital/board', w.tokens.reception);
    const deskBed = desk.body.units
      .find((u: { id: string }) => u.id === j.wardId)
      .beds.find((b: { id: string }) => b.id === j.bedId);
    expect(deskBed.stay).toMatchObject({ patientId: j.patientId, reason: null });
  });

  it('the ward nurse records observations (NEWS2) and gives the due medicine at the bedside', async () => {
    const obs = await post(`${base()}/vitals`, wardNurse.token, {
      systolic: 104,
      diastolic: 64,
      heartRate: 112,
      temperatureC: 38.9,
      respiratoryRate: 23,
      oxygenSaturation: 93,
      consciousness: 'A',
      onSupplementalOxygen: true,
    });
    expect(obs.status).toBe(201);
    expect(obs.body.news).toMatchObject({ scale: 'NEWS2', complete: true });
    expect(obs.body.news.score).toBeGreaterThanOrEqual(5);
    const ews = await get('/api/v1/early-warning/board', wardNurse.token);
    expect(ews.status).toBe(200);
    expect(JSON.stringify(ews.body)).toContain(j.patientId);
    // The high score also prompts a sepsis screen for the team (nobody answers it in this story).
    const sepsis = await get('/api/v1/sepsis/board', w.tokens.doctor);
    expect(sepsis.status).toBe(200);
    expect(
      sepsis.body.items.find((i: { patientId: string }) => i.patientId === j.patientId),
    ).toMatchObject({ status: 'PENDING', bedLabel: 'J1' });

    // Wristband printed for the stay; wristband and pack are both scanned at the bedside.
    const band = await post(`${base()}/wristband`, wardNurse.token);
    expect(band.status).toBe(201);
    const dose = {
      prescriptionId: j.prescriptionId,
      status: 'GIVEN',
      doseGiven: '500 mg',
      patientScanned: true,
      scanToken: band.body.token,
    };
    // Without the pack scan a written reason is required.
    const noReason = await post(`${base()}/medication-administrations`, wardNurse.token, dose);
    expect(noReason.status).toBe(400);
    // The wrong pack stops the dose, whatever reason is given.
    const wrongPack = await post(`${base()}/medication-administrations`, wardNurse.token, {
      ...dose,
      medicationScanned: true,
      barcode: j.otherPackBarcode,
      scanOverrideReason: 'Nuk ka paketim tjetër në repart',
    });
    expect(wrongPack.status).toBe(409);
    expect(wrongPack.body.error.code).toBe('BCMA_STOP');
    const given = await post(`${base()}/medication-administrations`, wardNurse.token, {
      ...dose,
      medicationScanned: true,
      barcode: j.packBarcode,
    });
    expect(given.status).toBe(201);
    expect(given.body).toMatchObject({
      patientScanned: true,
      medicationScanned: true,
      scanOverrideReason: null,
    });
    const mar = await get(`${base()}/medication-administrations`, w.tokens.doctor);
    expect(mar.body.items.map((a: { id: string }) => a.id)).toContain(given.body.id);
  });

  it('a care task from the doctor is done by the nurse', async () => {
    const task = await post(`${base()}/care-tasks`, w.tokens.doctor, {
      title: 'Kontrollo saturimin çdo 4 orë',
      priority: 'URGENT',
      assignedRole: 'NURSE',
    });
    expect(task.status).toBe(201);
    j.careTaskId = task.body.id;
    const open = await get('/api/v1/care-tasks?scope=team', w.tokens.nurse);
    expect(open.status).toBe(200);
    expect(open.body.items.map((t: { id: string }) => t.id)).toContain(j.careTaskId);
    const done = await post(`/api/v1/care-tasks/${j.careTaskId}/complete`, w.tokens.nurse, {
      note: 'SpO2 95 % me 2 L O2',
    });
    expect(done.status).toBe(204);
    const chart = await get(`${base()}/care-tasks`, w.tokens.doctor);
    expect(chart.body.items.find((t: { id: string }) => t.id === j.careTaskId).status).toBe('DONE');
  });
});

describe('k. discharge and follow-up', () => {
  it('the doctor discharges with a signed summary; the bed goes to cleaning', async () => {
    const res = await post(
      `/api/v1/hospital/admissions/${j.admissionId}/discharge`,
      w.tokens.doctor,
      {
        disposition: 'HOME',
        dischargeSummary: 'Pneumoni e trajtuar me sukses. Stabil në lëshim, pa oksigjen.',
        followUp: 'Kontroll te mjeku familjar pas një jave',
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('DISCHARGED');
    expect(res.body.dischargeSignedAt).not.toBeNull();

    const board = await get('/api/v1/hospital/board', wardNurse.token);
    const bed = board.body.units
      .find((u: { id: string }) => u.id === j.wardId)
      .beds.find((b: { id: string }) => b.id === j.bedId);
    expect(bed).toMatchObject({ status: 'CLEANING', stay: null });
    const cleaned = await api()
      .patch(`/api/v1/hospital/beds/${j.bedId}`)
      .set(bearer(wardNurse.token))
      .send({ status: 'AVAILABLE' });
    expect(cleaned.status).toBe(200);
    // Unit-based access ends with the stay.
    expect((await get(`${base()}/summary`, wardNurse.token)).status).toBe(403);

    // The unanswered sepsis prompt leaves the board with the patient, and is never chased
    // afterwards: its ward and bed describe a stay that is over. (The escalation worker has no
    // API; it is called directly, one hour "later".)
    const sepsis = await get('/api/v1/sepsis/board', w.tokens.doctor);
    expect(
      sepsis.body.items.find((i: { patientId: string }) => i.patientId === j.patientId),
    ).toBeUndefined();
    await escalateOverdueOnce(new Date(Date.now() + 61 * 60_000));
    const notes = await get('/api/v1/notifications?pageSize=100', w.tokens.doctor);
    expect(
      notes.body.items.filter((n: { title: string }) => /Sepsis screen not done/.test(n.title)),
    ).toEqual([]);

    // The patient gets the letter once the doctor releases it.
    const stays = () => get(`/api/v1/hospital/patients/${j.patientId}/admissions`, j.patientToken);
    expect((await stays()).body.items[0].dischargeSummary).toBeNull();
    expect(
      (await post(`/api/v1/hospital/admissions/${j.admissionId}/release`, w.tokens.doctor)).status,
    ).toBe(200);
    expect((await stays()).body.items[0].dischargeSummary).toContain('mjeku familjar');
  });

  it('the doctor books the follow-up appointment; the patient sees it', async () => {
    const res = await post('/api/v1/appointments', w.tokens.doctor, {
      patientId: j.patientId,
      scheduledAt: iso(new Date(Date.now() + 7 * 86_400_000)),
      reason: 'Kontroll pas lëshimit nga spitali',
    });
    expect(res.status).toBe(201);
    const mine = await get('/api/v1/appointments', j.patientToken);
    expect(mine.body.items).toHaveLength(2);
    expect(mine.body.items.map((a: { status: string }) => a.status).sort()).toEqual([
      'COMPLETED',
      'CONFIRMED',
    ]);
  });

  it('the patient books a later check-up online in the doctor’s published hours', async () => {
    // No consulting hours published yet: the portal offers nothing to book.
    const none = await get('/api/v1/scheduling/doctors', j.patientToken);
    expect(none.status).toBe(200);
    expect(none.body.items.find((d: { id: string }) => d.id === w.users.doctor.id)).toBeUndefined();

    const hours = await api()
      .put(`/api/v1/scheduling/doctors/${w.users.doctor.id}/availability`)
      .set(bearer(w.tokens.doctor))
      .send({
        blocks: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startTime: '09:00',
          endTime: '11:00',
          slotMinutes: 30,
          portalBookable: true,
        })),
      });
    expect(hours.status).toBe(200);

    const doctors = await get('/api/v1/scheduling/doctors', j.patientToken);
    expect(
      doctors.body.items.find((d: { id: string }) => d.id === w.users.doctor.id),
    ).toMatchObject({ portalBookable: true, inCareTeam: true });
    const slots = await get(
      `/api/v1/scheduling/slots?doctorId=${w.users.doctor.id}&from=${dayOffset(14)}&to=${dayOffset(16)}`,
      j.patientToken,
    );
    expect(slots.status).toBe(200);
    expect(slots.body.items.length).toBeGreaterThan(0);
    const slot = slots.body.items[0];
    const booked = await post('/api/v1/scheduling/book', j.patientToken, {
      doctorId: w.users.doctor.id,
      start: slot.start,
      reason: 'Kontroll dy javë pas pneumonisë',
    });
    expect(booked.status).toBe(201);
    expect(booked.body).toMatchObject({ status: 'CONFIRMED', bookedVia: 'PORTAL' });
    // The slot is gone, and the doctor has the booking on the schedule.
    const again = await post('/api/v1/scheduling/book', j.patientToken, {
      doctorId: w.users.doctor.id,
      start: slot.start,
      reason: 'I njëjti termin',
    });
    expect(again.status).toBe(409);
    const schedule = await get('/api/v1/appointments', w.tokens.doctor);
    expect(schedule.body.items.map((a: { id: string }) => a.id)).toContain(booked.body.id);
    // Reception sees it too (same facility) and can check the patient in on the day.
    const desk = await get('/api/v1/appointments', w.tokens.reception);
    expect(desk.body.items.map((a: { id: string }) => a.id)).toContain(booked.body.id);
  });
});

describe('l. medical certificate', () => {
  it('the doctor issues sick leave; anyone with the code can verify it without sign-in', async () => {
    const res = await post(`/api/v1/certificates/patients/${j.patientId}`, w.tokens.doctor, {
      kind: 'SICK_LEAVE',
      startDate: dayOffset(-1),
      endDate: dayOffset(5),
      icd10Code: 'J18.9',
    });
    expect(res.status).toBe(201);
    expect(res.body.serialNumber).toContain(w.facility.code);
    j.certificateId = res.body.id;
    j.verificationCode = String(res.body.verificationUrl).split('/').pop()!;

    const verified = await api().get(`/api/v1/verify/certificates/${j.verificationCode}`);
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({
      genuine: true,
      state: 'VALID',
      kind: 'SICK_LEAVE',
      serialNumber: res.body.serialNumber,
      patient: { initials: 'B. R.', birthYear: 1985 },
    });
    // The public answer carries no name and no diagnosis.
    expect(JSON.stringify(verified.body)).not.toMatch(new RegExp(`${j.lastName}|J18`));
    expect((await api().get('/api/v1/verify/certificates/not-a-real-code')).status).toBe(404);
  });
});

describe('m. billing', () => {
  it('reception records the insurance; the visit, tests, medicine and stay become charges', async () => {
    const cover = await post(
      `/api/v1/billing/patients/${j.patientId}/insurance`,
      w.tokens.reception,
      { insurer: 'FSSH', policyNumber: `FSSH-${uniq}`, validFrom: '2024-01-01' },
    );
    expect(cover.status).toBe(201);
    const captured = await post('/api/v1/billing/capture', w.tokens.reception);
    expect(captured.status).toBe(200);

    const list = await get(`/api/v1/billing/patients/${j.patientId}/charges`, w.tokens.reception);
    expect(list.status).toBe(200);
    const sources = list.body.items.map((c: { sourceType: string }) => c.sourceType);
    for (const s of ['ENCOUNTER', 'LAB_ORDER', 'IMAGING', 'DISPENSE']) expect(sources).toContain(s);
    // Reception sees services and amounts, no clinical content.
    expect(JSON.stringify(list.body)).not.toMatch(/J18|Krepitacione|Penicillin/);
    // Capturing again creates nothing new.
    const again = await post('/api/v1/billing/capture', w.tokens.reception);
    expect(Object.values(again.body.created as Record<string, number>).every((n) => n === 0)).toBe(
      true,
    );
    j.chargeIds = list.body.items
      .filter((c: { copayCents: number; copayPaid: boolean }) => c.copayCents > 0 && !c.copayPaid)
      .map((c: { id: string }) => c.id);
    expect(j.chargeIds.length).toBeGreaterThan(0);
  });

  it('the co-payment is taken with a receipt and the insured part goes into the claim', async () => {
    const pay = await post('/api/v1/billing/payments', w.tokens.reception, {
      patientId: j.patientId,
      chargeIds: j.chargeIds,
      method: 'CARD',
    });
    expect(pay.status).toBe(201);
    expect(pay.body.receiptNumber).toContain(w.facility.code);
    expect(pay.body.lines).toHaveLength(j.chargeIds.length);
    j.paymentId = pay.body.id;

    const claim = await post('/api/v1/billing/claims', w.tokens.director, {
      periodFrom: dayOffset(-30),
      periodTo: dayOffset(0),
    });
    expect(claim.status).toBe(201);
    expect(claim.body.status).toBe('DRAFT');
    const detail = await get(`/api/v1/billing/claims/${claim.body.id}`, w.tokens.director);
    expect(detail.status).toBe(200);
    const lines = detail.body.lines.filter(
      (l: { patientId: string }) => l.patientId === j.patientId,
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l: { insurerCents: number }) => l.insurerCents > 0)).toBe(true);

    // The patient sees the bills and the receipt in the portal.
    const own = await get(`/api/v1/billing/patients/${j.patientId}/charges`, j.patientToken);
    expect(own.status).toBe(200);
    expect(own.body.payments.map((p: { id: string }) => p.id)).toContain(j.paymentId);
    expect(own.body.totals.openCopayCents).toBe(0);
    expect(own.body.totals.paidCopayCents).toBe(pay.body.amountCents);
  });
});

describe('n. vaccination', () => {
  it('the nurse records a vaccination; it appears in the history and the vaccination status', async () => {
    const res = await post(`${base()}/immunizations`, w.tokens.nurse, {
      vaccine: 'Grip sezonal (influenza)',
      lotNumber: 'FLU-2026-A',
      site: 'Krahu i majtë',
    });
    expect(res.status).toBe(201);
    j.immunizationId = res.body.id;
    const history = await get(`${base()}/immunizations`, w.tokens.doctor);
    expect(history.body.items.map((i: { id: string }) => i.id)).toContain(j.immunizationId);
    const status = await get(`/api/v1/vaccination/patients/${j.patientId}/status`, w.tokens.nurse);
    expect(status.status).toBe(200);
    expect(status.body.other.map((o: { immunizationId: string }) => o.immunizationId)).toContain(
      j.immunizationId,
    );
    // The facility due list is the childhood calendar: an adult is never on it.
    const due = await get('/api/v1/vaccination/due', w.tokens.nurse);
    expect(due.status).toBe(200);
    expect(JSON.stringify(due.body)).not.toContain(j.patientId);
  });
});

describe('o. documents', () => {
  it('the doctor adds a document to the record and shares it with the patient', async () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% leter lëshimi\ntrailer<</Root 1 0 R>>\n%%EOF\n',
      'latin1',
    );
    const res = await api()
      .post(`${base()}/documents`)
      .query({ category: 'DISCHARGE_SUMMARY', title: 'Fletëlëshimi', visibleToPatient: 'true' })
      .set(bearer(w.tokens.doctor))
      .set('Content-Type', 'application/pdf')
      .set('X-File-Name', encodeURIComponent('fletelshimi.pdf'))
      .send(pdf);
    expect(res.status).toBe(201);
    j.documentId = res.body.id;
    const list = await get(`${base()}/documents`, w.tokens.nurse);
    expect(list.body.items.map((d: { id: string }) => d.id)).toContain(j.documentId);
    const own = await get(`${base()}/documents`, j.patientToken);
    expect(own.body.items.map((d: { id: string }) => d.id)).toContain(j.documentId);
    const content = await api()
      .get(`${base()}/documents/${j.documentId}/content`)
      .set(bearer(j.patientToken))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(content.status).toBe(200);
    expect(Buffer.compare(content.body as Buffer, pdf)).toBe(0);
  });
});

describe('p. version history', () => {
  it('shows who recorded and who confirmed the allergy, and the pharmacy steps of the prescription', async () => {
    const allergy = await get(
      `/api/v1/history/patients/${j.patientId}/records/allergies/${j.allergyId}`,
      w.tokens.doctor,
    );
    expect(allergy.status).toBe(200);
    const [latest, first] = allergy.body.versions;
    expect(latest).toMatchObject({
      operation: 'UPDATE',
      by: { userId: w.users.doctor.id, role: 'DOCTOR' },
    });
    expect(latest.changes).toEqual([
      expect.objectContaining({
        field: 'verification_status',
        before: 'UNCONFIRMED',
        after: 'CONFIRMED',
      }),
    ]);
    expect(first).toMatchObject({
      operation: 'INSERT',
      by: { userId: w.users.nurse.id, role: 'NURSE' },
    });

    const rx = await get(
      `/api/v1/history/patients/${j.patientId}/records/prescriptions/${j.prescriptionId}`,
      w.tokens.doctor,
    );
    expect(rx.status).toBe(200);
    const actors = rx.body.versions.map(
      (v: { operation: string; by: { role: string } | null }) => `${v.operation}:${v.by?.role}`,
    );
    expect(actors).toEqual(['UPDATE:PHARMACIST', 'UPDATE:PHARMACIST', 'INSERT:DOCTOR']);
    // The history is for the treating team, not for the patient.
    expect(
      (
        await get(
          `/api/v1/history/patients/${j.patientId}/records/allergies/${j.allergyId}`,
          j.patientToken,
        )
      ).status,
    ).toBe(403);
  });
});

describe('q. the patient portal', () => {
  it('the patient sees the whole episode in their own record', async () => {
    const summary = await get(`${base()}/summary`, j.patientToken);
    expect(summary.status).toBe(200);
    expect(summary.body.allergies.map((a: { substance: string }) => a.substance)).toEqual([
      'Penicillin',
    ]);
    expect(summary.body.activeMedications.map((m: { id: string }) => m.id)).toContain(
      j.prescriptionId,
    );
    expect(summary.body.recentLabResults.map((r: { id: string }) => r.id)).toEqual([
      j.finalResultId,
    ]);
    expect(summary.body.immunizations.map((i: { id: string }) => i.id)).toContain(j.immunizationId);
    const certs = await get(`/api/v1/certificates/patients/${j.patientId}`, j.patientToken);
    expect(certs.body.items.map((c: { id: string }) => c.id)).toContain(j.certificateId);

    // Own record export (data portability) contains the episode; the export is audited.
    const exported = await get(`${base()}/export`, j.patientToken);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-disposition']).toContain('attachment');
    const text = JSON.stringify(exported.body);
    for (const needle of ['J18.9', 'Penicillin', j.prescriptionId, j.finalResultId]) {
      expect(text).toContain(needle);
    }
    // Another patient cannot read any of it.
    expect((await get(`${base()}/summary`, w.tokens.otherPatient)).status).toBe(403);
  });

  it('the patient writes to the doctor and gets an answer', async () => {
    const thread = await post('/api/v1/messages/threads', j.patientToken, {
      doctorId: w.users.doctor.id,
      subject: 'Pyetje për ilaçin',
      body: 'A mund ta marr paracetamolin edhe natën?',
    });
    expect(thread.status).toBe(201);
    j.threadId = thread.body.id;
    const inbox = await get('/api/v1/messages/threads', w.tokens.doctor);
    const row = inbox.body.items.find((t: { id: string }) => t.id === j.threadId);
    expect(row).toMatchObject({ patientId: j.patientId, unreadCount: 1 });
    const reply = await post(`/api/v1/messages/threads/${j.threadId}/messages`, w.tokens.doctor, {
      body: 'Po, çdo 6 orë, jo më shumë se 4 herë në ditë.',
    });
    expect(reply.status).toBe(201);
    const conversation = await get(`/api/v1/messages/threads/${j.threadId}`, j.patientToken);
    expect(conversation.body.messages.map((m: { senderRole: string }) => m.senderRole)).toEqual([
      'PATIENT',
      'DOCTOR',
    ]);
    // A doctor outside the conversation cannot read it.
    expect((await get(`/api/v1/messages/threads/${j.threadId}`, w.tokens.colleague)).status).toBe(
      404,
    );
  });

  it('the patient updates their phone number and asks for a correction; the doctor answers', async () => {
    const contact = await api()
      .patch('/api/v1/portal/contact')
      .set(bearer(j.patientToken))
      .send({ phone: '+38349765432' });
    expect(contact.status).toBe(200);
    const desk = await get(`/api/v1/patients/${j.patientId}`, w.tokens.reception);
    expect(desk.body.phone).toBe('+38349765432');

    const request = await post(`${base()}/correction-requests`, j.patientToken, {
      section: 'allergies',
      entryId: j.allergyId,
      description: 'Reagimi ndaj penicilinës ishte vetëm skuqje e lehtë, jo urtikarie.',
    });
    expect(request.status).toBe(201);
    const worklist = await get('/api/v1/worklist', w.tokens.doctor);
    expect(worklist.body.openCorrectionRequests.map((c: { id: string }) => c.id)).toContain(
      request.body.id,
    );
    const answer = await api()
      .patch(`${base()}/correction-requests/${request.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ status: 'REJECTED', response: 'Alergjia mbetet e shënuar për sigurinë tuaj.' });
    expect(answer.status).toBe(200);
    const mine = await get(`${base()}/correction-requests`, j.patientToken);
    expect(mine.body.items[0]).toMatchObject({
      status: 'REJECTED',
      response: 'Alergjia mbetet e shënuar për sigurinë tuaj.',
    });
    // The record itself was not changed by the request.
    const allergies = await get(`${base()}/allergies`, w.tokens.doctor);
    expect(allergies.body.items[0].reaction).toBe('Urtikarie');
  });

  it('"who viewed my record" lists the staff of the episode with their roles', async () => {
    const rows: { actorName: string | null; actorRole: string | null; action: string }[] = [];
    for (let page = 1; page <= 20; page++) {
      const res = await get(`/api/v1/portal/access-log?pageSize=100&page=${page}`, j.patientToken);
      expect(res.status).toBe(200);
      rows.push(...res.body.items);
      if (page >= res.body.totalPages) break;
    }
    const roles = new Set(rows.map((r) => r.actorRole));
    for (const role of ['RECEPTION', 'DOCTOR', 'NURSE', 'LAB_TECHNICIAN', 'PHARMACIST']) {
      expect(roles, `access log should name a ${role}`).toContain(role);
    }
    const names = new Set(rows.map((r) => r.actorName));
    for (const person of [
      w.users.doctor.fullName,
      w.users.nurse.fullName,
      w.users.reception.fullName,
      w.users.pharmacist.fullName,
      w.users.outsideDoctor.fullName,
      labTech.fullName,
      radiologist.fullName,
      wardNurse.fullName,
    ]) {
      expect(names, `access log should name ${person}`).toContain(person);
    }
    // The patient's own reading is not listed; the refused attempts of others are.
    expect(rows.some((r) => r.actorName === `${j.firstName} ${j.lastName}`)).toBe(false);
    expect(rows.some((r) => r.action === 'patient.record.access_denied')).toBe(true);
  });
});

describe('r. boundaries', () => {
  it('management, the Ministry, IT support and reception never open the chart', async () => {
    for (const token of [
      w.tokens.director,
      w.tokens.ministry,
      itSupport.token,
      w.tokens.reception,
      labTech.token,
    ]) {
      expect((await get(`${base()}/summary`, token)).status).toBe(403);
      expect((await get(`${base()}/lab-results`, token)).status).toBe(403);
    }
    // A doctor of the facility outside the care team, and another facility's director.
    expect((await get(`${base()}/summary`, w.tokens.colleague)).status).toBe(403);
    expect((await get(`/api/v1/patients/${j.patientId}`, w.tokens.otherDirector)).status).toBe(403);
    // Reception keeps demographics only.
    const demo = await get(`/api/v1/patients/${j.patientId}`, w.tokens.reception);
    expect(demo.status).toBe(200);
    expect(JSON.stringify(demo.body)).not.toMatch(/J18|Penicillin|Paracetamol/);
    // The Ministry and IT support do not even get demographics.
    expect((await get(`/api/v1/patients/${j.patientId}`, w.tokens.ministry)).status).toBe(403);
    expect((await get(`/api/v1/patients/${j.patientId}`, itSupport.token)).status).toBe(403);
  });
});

describe('r2. emergency access', () => {
  it('a colleague breaks the glass with a reason; the director reviews it; the patient sees it', async () => {
    const short = await post(`${base()}/emergency-access`, w.tokens.colleague, {
      reason: 'urgent',
    });
    expect(short.status).toBe(400);
    const grant = await post(`${base()}/emergency-access`, w.tokens.colleague, {
      reason: 'Pacienti u kthye me vështirësi në frymëmarrje, mjeku i tij mungon',
    });
    expect(grant.status).toBe(201);
    const chart = await get(`${base()}/summary`, w.tokens.colleague);
    expect(chart.status).toBe(200);
    expect(chart.body.accessBasis).toBe('EMERGENCY');
    // Emergency access never crosses to another facility.
    const outsider = await staff('DOCTOR', w.otherFacility.id);
    expect(
      (
        await post(`${base()}/emergency-access`, outsider.token, {
          reason: 'Përpjekje nga një institucion tjetër',
        })
      ).status,
    ).toBe(403);

    const queue = await get('/api/v1/emergency-access?status=unreviewed', w.tokens.director);
    const event = queue.body.items.find((e: { id: string }) => e.id === grant.body.id);
    expect(event).toMatchObject({ patientId: j.patientId, doctorId: w.users.colleague.id });
    expect(event.recordViews).toBeGreaterThan(0);
    const review = await post(
      `/api/v1/emergency-access/${grant.body.id}/review`,
      w.tokens.director,
      {
        outcome: 'APPROPRIATE',
        notes: 'Qasje e arsyeshme në mungesë të mjekut përgjegjës.',
      },
    );
    expect(review.status).toBe(204);

    const log = await get('/api/v1/portal/access-log?pageSize=100', j.patientToken);
    const entry = log.body.items.find(
      (r: { emergencyReason: string | null }) => r.emergencyReason !== null,
    );
    expect(entry).toMatchObject({
      actorName: w.users.colleague.fullName,
      emergencyReason: 'Pacienti u kthye me vështirësi në frymëmarrje, mjeku i tij mungon',
    });
  });
});

describe('s. notifications', () => {
  const CLINICAL = /J18|Pneumoni|Penicillin|Paracetamol|Hemoglob|Haemoglob|118|Kollë/i;

  async function allTitles(token: string) {
    const titles: string[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await get(`/api/v1/notifications?pageSize=100&page=${page}`, token);
      expect(res.status).toBe(200);
      titles.push(...res.body.items.map((n: { title: string }) => n.title));
      if (page >= res.body.totalPages) break;
    }
    return titles;
  }

  it('the patient was told about each step, without names or clinical detail', async () => {
    const titles = await allTitles(j.patientToken);
    for (const expected of [
      'An appointment was booked for you',
      'A new test result is available',
      'Your medication is ready at the pharmacy',
      'You have been referred to another facility',
      'Your referral was accepted',
    ]) {
      expect(titles, `patient should have been told: ${expected}`).toContain(expected);
    }
    expect(titles.some((t) => /certificate/i.test(t))).toBe(true);
    expect(titles.some((t) => /discharge letter/i.test(t))).toBe(true);
    expect(titles.some((t) => /message/i.test(t))).toBe(true);
    for (const t of titles) {
      expect(t).not.toContain(j.lastName);
      expect(t).not.toMatch(CLINICAL);
    }
  });

  it('staff were told what needs their action, without names or clinical detail', async () => {
    const doctor = await allTitles(w.tokens.doctor);
    for (const expected of [
      'Your patient has arrived',
      'New imaging report to review',
      'Your referral was accepted',
      'New message from a patient',
    ]) {
      expect(doctor, `doctor should have been told: ${expected}`).toContain(expected);
    }
    expect(doctor.some((t) => /laboratory result/i.test(t))).toBe(true);
    const pharmacist = await allTitles(w.tokens.pharmacist);
    expect(pharmacist).toContain('New prescription awaiting verification');
    const nurse = await allTitles(w.tokens.nurse);
    expect(nurse.some((t) => /care task/i.test(t))).toBe(true);
    for (const t of [...doctor, ...pharmacist, ...nurse]) {
      expect(t).not.toContain(j.lastName);
      expect(t).not.toMatch(CLINICAL);
    }
  });

  it('every notification link opens in the recipient’s own workspace', async () => {
    // A care-team notice goes to doctors and nurses: the nurse's copy must point to the nurse's
    // chart route (the doctor's route refuses nurses).
    const nurse = await get('/api/v1/notifications?pageSize=100', w.tokens.nurse);
    const correction = nurse.body.items.find(
      (n: { title: string }) => n.title === 'A patient requested a record correction',
    );
    expect(correction.link).toBe(`/nurse/patients/${j.patientId}`);
    const doctor = await get('/api/v1/notifications?pageSize=100', w.tokens.doctor);
    expect(
      doctor.body.items.find(
        (n: { title: string }) => n.title === 'A patient requested a record correction',
      ).link,
    ).toBe(`/doctor/patients/${j.patientId}`);

    // No participant of the story holds a link into another role's workspace.
    const WORKSPACE: Record<string, string[]> = {
      '/doctor': ['DOCTOR'],
      '/nurse': ['NURSE'],
      '/director': ['DIRECTOR'],
      '/ministry': ['MINISTRY'],
      '/reception': ['RECEPTION'],
      '/portal': ['PATIENT'],
      '/pharmacy': ['PHARMACIST', 'DIRECTOR'],
      '/lab': ['LAB_TECHNICIAN', 'DOCTOR', 'DIRECTOR'],
    };
    const rows = await db
      .select({ role: users.role, link: notifications.link, title: notifications.title })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(
        or(
          inArray(users.facilityId, [w.facility.id, w.otherFacility.id]),
          eq(users.id, j.patientUserId),
        ),
      );
    expect(rows.length).toBeGreaterThan(30);
    const wrong = rows.filter((r) => {
      const first = `/${(r.link ?? '').split(/[/?]/)[1] ?? ''}`;
      const allowed = WORKSPACE[first];
      return allowed !== undefined && !allowed.includes(r.role);
    });
    expect(wrong).toEqual([]);
  });
});
