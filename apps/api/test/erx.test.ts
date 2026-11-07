import { and, desc, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { auditLogs, communityDispensings, notifications, prescriptions } from '../src/db/schema.js';
import {
  checkCharacter,
  CODE_ALPHABET,
  DEMO_ERX_CODE,
  eprescriptionTerms,
  formatCode,
  generateCode,
  isControlled,
  normaliseCode,
} from '../src/modules/erx/erx.service.js';
import { api, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let pharmacyKey: Record<string, string>;
let otherPharmacyKey: Record<string, string>;
let noScopeKey: Record<string, string>;
const doctor = () => bearer(w.tokens.doctor);
const today = () => new Date().toISOString().slice(0, 10);

async function newKey(name: string, scopes: string[]) {
  const res = await api()
    .post('/api/v1/partner/clients')
    .set(bearer(w.tokens.ministry))
    .send({ name, organisation: `${name} sh.p.k.`, scopes });
  expect(res.status).toBe(201);
  return { Authorization: `Bearer ${res.body.apiKey}` };
}

async function prescribe(
  medication: string,
  ePrescription: Record<string, unknown> | null = { repeats: 0 },
  patientId = w.patient.id,
) {
  return api()
    .post(`/api/v1/patients/${patientId}/prescriptions`)
    .set(doctor())
    .send({
      medication,
      dosage: '1 tablet',
      frequency: 'once daily',
      startDate: today(),
      ...(ePrescription ? { ePrescription } : {}),
    });
}

const lookup = (code: string, query: Record<string, string>, key = pharmacyKey) =>
  api().get(`/api/v1/partner/e-prescriptions/${code}`).query(query).set(key);

const dispense = (code: string, extra: Record<string, unknown> = {}, key = pharmacyKey) =>
  api()
    .post(`/api/v1/partner/e-prescriptions/${code}/dispense`)
    .set(key)
    .send({
      nationalId: w.patient.nationalId,
      pharmacyName: 'Barnatorja Test',
      pharmacistName: 'Farm. Test Pharmacist',
      pharmacistLicence: 'FARM-1',
      productName: 'Generic product',
      quantity: '1 box',
      ...extra,
    });

beforeAll(async () => {
  w = await createWorld();
  pharmacyKey = await newKey('Pharmacy A', ['prescriptions.dispense']);
  otherPharmacyKey = await newKey('Pharmacy B', ['prescriptions.dispense']);
  noScopeKey = await newKey('Statistics only', ['stats.read']);
});

describe('e-prescription codes', () => {
  it('are 12 characters from an unambiguous alphabet with a check character', () => {
    expect(CODE_ALPHABET).not.toMatch(/[IO01]/);
    const codes = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = generateCode();
      expect(c).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
      expect(normaliseCode(c)).toBe(c);
      codes.add(c);
    }
    expect(codes.size).toBe(2000);
    const code = generateCode();
    expect(formatCode(code)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // Typed with spaces, dashes and in lower case is fine.
    expect(normaliseCode(formatCode(code).toLowerCase().replace('-', ' '))).toBe(code);
    expect(normaliseCode(DEMO_ERX_CODE)).toBe(DEMO_ERX_CODE);
  });

  it('detects a mistyped character and swapped neighbours', () => {
    const code = 'ABCDEFGHJKL' + checkCharacter('ABCDEFGHJKL');
    for (let i = 0; i < 12; i++) {
      const other = CODE_ALPHABET[(CODE_ALPHABET.indexOf(code[i]!) + 1) % CODE_ALPHABET.length];
      expect(normaliseCode(code.slice(0, i) + other + code.slice(i + 1))).toBeNull();
    }
    let detected = 0;
    for (let i = 0; i < 11; i++) {
      const swapped = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
      if (normaliseCode(swapped) === null) detected++;
    }
    expect(detected).toBe(11);
    expect(normaliseCode('ABCD-EFGH')).toBeNull();
    expect(normaliseCode('ABCD-EFGH-IJK0')).toBeNull();
  });
});

describe('issuing rules', () => {
  it('limits repeats and validity, and treats controlled medicines strictly', () => {
    const plain = { atcCode: 'C10AA05', medication: 'Atorvastatin 20 mg' };
    expect(eprescriptionTerms({ repeats: 0 }, plain)).toMatchObject({
      repeatsAllowed: 0,
      validDays: 30,
      controlled: false,
    });
    expect(eprescriptionTerms({ repeats: 3 }, plain).validDays).toBe(120);
    expect(eprescriptionTerms({ repeats: 12 }, plain).validDays).toBe(365);
    expect(() => eprescriptionTerms({ repeats: 0, validDays: 120 }, plain)).toThrow(/90 days/);
    expect(() => eprescriptionTerms({ repeats: 13 }, plain)).toThrow();
    expect(isControlled('N02AX02', 'Tramadol 50 mg')).toBe(true);
    expect(isControlled(null, 'Diazepam 5 mg')).toBe(true);
    expect(isControlled('N02BE01', 'Paracetamol')).toBe(false);
    const tramadol = { atcCode: 'N02AX02', medication: 'Tramadol 50 mg' };
    expect(() => eprescriptionTerms({ repeats: 1 }, tramadol)).toThrow(/repeat/);
    expect(eprescriptionTerms({ repeats: 0 }, tramadol)).toMatchObject({
      validDays: 7,
      controlled: true,
    });
    expect(() => eprescriptionTerms({ repeats: 0, validDays: 10 }, tramadol)).toThrow(/7 days/);
  });

  it('issues a prescription as an e-prescription and tells the patient without the code', async () => {
    const res = await prescribe('Atorvastatin 20 mg', { repeats: 2, validDays: 90 });
    expect(res.status).toBe(201);
    expect(res.body.ePrescriptionCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(res.body.repeatsAllowed).toBe(2);
    const expectedUntil = new Date(Date.now() + 89 * 86_400_000).toISOString().slice(0, 10);
    expect(
      Math.abs(Date.parse(res.body.communityValidUntil) - Date.parse(expectedUntil)),
    ).toBeLessThanOrEqual(86_400_000);
    const [note] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.patientUser.id))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    expect(note!.title).toBe('A new e-prescription is ready in your portal');
    expect(JSON.stringify(note)).not.toContain(res.body.ePrescriptionCode.replace(/-/g, ''));
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'erx.issued'), eq(auditLogs.resourceId, res.body.id)));
    expect(entry!.patientId).toBe(w.patient.id);

    // Controlled medicine with repeats is refused before anything is saved.
    const controlled = await prescribe('Tramadol 50 mg', { repeats: 2 });
    expect(controlled.status).toBe(400);
    // A plain prescription stays a hospital prescription.
    const plain = await prescribe('Omeprazole 20 mg', null);
    expect(plain.body.ePrescriptionCode).toBeNull();
    const issue = await api()
      .post(`/api/v1/e-prescriptions/prescriptions/${plain.body.id}/issue`)
      .set(doctor())
      .send({ repeats: 1 });
    expect(issue.status).toBe(201);
    expect(issue.body).toMatchObject({ status: 'ACTIVE', suppliesTotal: 2, repeatsAllowed: 1 });
    const again = await api()
      .post(`/api/v1/e-prescriptions/prescriptions/${plain.body.id}/issue`)
      .set(doctor())
      .send({ repeats: 1 });
    expect(again.status).toBe(409);
    // Only a doctor with access issues.
    const nurse = await api()
      .post(`/api/v1/e-prescriptions/prescriptions/${plain.body.id}/issue`)
      .set(bearer(w.tokens.nurse))
      .send({ repeats: 0 });
    expect(nurse.status).toBe(403);
  });
});

describe('community pharmacy API', () => {
  let code: string;
  beforeAll(async () => {
    code = (await prescribe('Amlodipine 5 mg', { repeats: 1 })).body.ePrescriptionCode;
  });

  it('needs both the code and the patient, and says the same for every mismatch', async () => {
    const ok = await lookup(code, { nationalId: w.patient.nationalId });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      code,
      status: 'ACTIVE',
      suppliesTotal: 2,
      suppliesRemaining: 2,
      medication: 'Amlodipine 5 mg',
      controlled: false,
      patient: { lastName: w.patient.lastName, dateOfBirth: w.patient.dateOfBirth },
      allergies: { status: 'NOT_RECORDED', substances: [] },
    });
    expect(ok.body.prescriber.name).toBe(w.users.doctor.fullName);
    expect(JSON.stringify(ok.body)).not.toMatch(/diagnos|icd/i);
    // Date of birth instead of the national ID; code typed without dashes.
    const byDob = await lookup(code.replace(/-/g, '').toLowerCase(), {
      dateOfBirth: w.patient.dateOfBirth,
    });
    expect(byDob.status).toBe(200);

    const wrongPatient = await lookup(code, { nationalId: w.otherPatient.nationalId });
    const unknown = await lookup(formatCode(generateCode()), { nationalId: w.patient.nationalId });
    const malformed = await lookup('ABCD-EFGH-JKLM', { nationalId: w.patient.nationalId });
    for (const r of [wrongPatient, unknown, malformed]) {
      expect(r.status).toBe(404);
      expect(r.body.error.message).toBe('No e-prescription matches this code and patient');
    }
    expect((await lookup(code, {})).status).toBe(400);
    expect((await lookup(code, { nationalId: w.patient.nationalId }, noScopeKey)).status).toBe(403);
    expect(
      (await api().get(`/api/v1/partner/e-prescriptions/${code}`).query({ nationalId: '1' }))
        .status,
    ).toBe(401);

    // The read is in the patient's access log under the pharmacy system's name.
    const entries = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.patientId, w.patient.id), eq(auditLogs.action, 'partner.api.access')),
      );
    expect(
      entries.some(
        (e) =>
          (e.metadata as { actorLabel?: string; result?: string }).actorLabel ===
            'Pharmacy A (API)' &&
          (e.metadata as { result?: string }).result === 'e_prescription_read',
      ),
    ).toBe(true);
  });

  it('dispenses each supply once, records substitutions and refuses when none is left', async () => {
    const first = await dispense(code, { productName: 'Amlodipine Generic 5 mg' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ supplyNumber: 0, substituted: true, suppliesRemaining: 1 });
    const second = await dispense(code, { productName: 'Amlodipine 5 mg' }, otherPharmacyKey);
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({
      supplyNumber: 1,
      substituted: false,
      suppliesRemaining: 0,
    });
    const third = await dispense(code);
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('FULLY_DISPENSED');
    const after = await lookup(code, { nationalId: w.patient.nationalId });
    expect(after.body.status).toBe('DISPENSED');
    expect(after.body.dispensings.map((d: { pharmacyName: string }) => d.pharmacyName)).toEqual([
      'Barnatorja Test',
      'Barnatorja Test',
    ]);
    const [note] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.patientUser.id))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    expect(note!.title).toBe('Your e-prescription was dispensed at Barnatorja Test');
    // The wrong patient cannot dispense.
    const fresh = (await prescribe('Metformin 850 mg')).body.ePrescriptionCode;
    expect((await dispense(fresh, { nationalId: w.otherPatient.nationalId })).status).toBe(404);
  });

  it('never hands over the last supply twice, even at the same moment', async () => {
    const last = (await prescribe('Salbutamol 100 mcg')).body.ePrescriptionCode;
    const results = await Promise.all([dispense(last), dispense(last, {}, otherPharmacyKey)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const [rx] = await db
      .select({ id: prescriptions.id })
      .from(prescriptions)
      .where(eq(prescriptions.ePrescriptionCode, last.replace(/-/g, '')));
    const rows = await db
      .select()
      .from(communityDispensings)
      .where(eq(communityDispensings.prescriptionId, rx!.id));
    expect(rows).toHaveLength(1);
  });

  it('refuses expired, cancelled and stopped e-prescriptions', async () => {
    const expired = await prescribe('Ibuprofen 400 mg');
    await db
      .update(prescriptions)
      .set({ communityValidUntil: '2020-01-01' })
      .where(eq(prescriptions.id, expired.body.id));
    const exp = await dispense(expired.body.ePrescriptionCode);
    expect(exp.status).toBe(409);
    expect(exp.body.error.code).toBe('EXPIRED');

    const cancelled = await prescribe('Amoxicillin 500 mg');
    const byNurse = await api()
      .post(`/api/v1/e-prescriptions/prescriptions/${cancelled.body.id}/cancel`)
      .set(bearer(w.tokens.nurse))
      .send({ reason: 'Wrong medicine' });
    expect(byNurse.status).toBe(403);
    const cancel = await api()
      .post(`/api/v1/e-prescriptions/prescriptions/${cancelled.body.id}/cancel`)
      .set(doctor())
      .send({ reason: 'Allergy reported by the patient' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('CANCELLED');
    const notDispensable = await dispense(cancelled.body.ePrescriptionCode);
    expect(notDispensable.status).toBe(409);
    expect(notDispensable.body.error.code).toBe('NOT_DISPENSABLE');
    const [note] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.patientUser.id))
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    expect(note!.title).toBe('Your doctor cancelled an e-prescription');

    const stopped = await prescribe('Omeprazole 20 mg');
    await api()
      .patch(`/api/v1/patients/${w.patient.id}/prescriptions/${stopped.body.id}`)
      .set(doctor())
      .send({ status: 'COMPLETED' })
      .expect(200);
    expect((await dispense(stopped.body.ePrescriptionCode)).status).toBe(409);
  });

  it('lets the same system reverse a dispensing within 24 hours', async () => {
    const c = (await prescribe('Metformin 850 mg')).body.ePrescriptionCode;
    const d = await dispense(c);
    expect(d.status).toBe(201);
    const byOther = await api()
      .post(`/api/v1/partner/e-prescriptions/dispensings/${d.body.id}/reverse`)
      .set(otherPharmacyKey)
      .send({ reason: 'Recorded on the wrong patient' });
    expect(byOther.status).toBe(404);
    const rev = await api()
      .post(`/api/v1/partner/e-prescriptions/dispensings/${d.body.id}/reverse`)
      .set(pharmacyKey)
      .send({ reason: 'Recorded on the wrong patient' });
    expect(rev.status).toBe(201);
    expect(rev.body.suppliesDispensed).toBe(0);
    const twice = await api()
      .post(`/api/v1/partner/e-prescriptions/dispensings/${d.body.id}/reverse`)
      .set(pharmacyKey)
      .send({ reason: 'Again' });
    expect(twice.status).toBe(409);
    // The supply is available again; the history shows the reversal.
    expect((await dispense(c)).status).toBe(201);
    const view = await lookup(c, { nationalId: w.patient.nationalId });
    expect(view.body.dispensings).toHaveLength(2);
    expect(view.body.dispensings[0].reversedAt).toBeTruthy();
    expect(view.body.dispensings[1].reversedAt).toBeNull();

    // Older than 24 hours: no reversal.
    const old = (await prescribe('Amlodipine 5 mg')).body;
    const [client] = await db
      .select({ id: communityDispensings.partnerClientId })
      .from(communityDispensings)
      .where(eq(communityDispensings.id, d.body.id));
    const [stale] = await db
      .insert(communityDispensings)
      .values({
        prescriptionId: old.id,
        patientId: w.patient.id,
        partnerClientId: client!.id,
        pharmacyName: 'Barnatorja Test',
        pharmacistName: 'Farm. Test',
        supplyNumber: 0,
        productName: 'Amlodipine',
        quantity: '1 box',
        dispensedAt: new Date(Date.now() - 25 * 3_600_000),
      })
      .returning();
    const late = await api()
      .post(`/api/v1/partner/e-prescriptions/dispensings/${stale!.id}/reverse`)
      .set(pharmacyKey)
      .send({ reason: 'Too late' });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('REVERSAL_WINDOW_PASSED');
  });

  it('limits failed look-ups per pharmacy system', async () => {
    const key = await newKey('Guessing pharmacy', ['prescriptions.dispense']);
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await lookup(formatCode(generateCode()), { nationalId: '1234567890' }, key)).status;
    }
    expect(last).toBe(429);
    // Other systems are not affected.
    expect((await lookup(code, { nationalId: w.patient.nationalId })).status).toBe(200);
  });
});

describe('views', () => {
  it('shows the patient their codes and history, and the care team the same', async () => {
    const mine = await api()
      .get(`/api/v1/e-prescriptions/patients/${w.patient.id}`)
      .set(bearer(w.tokens.patient));
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(3);
    const dispensed = mine.body.items.find(
      (i: { status: string; dispensings: unknown[] }) =>
        i.status === 'DISPENSED' && i.dispensings.length === 2,
    );
    expect(dispensed.code).toMatch(/-/);
    expect(dispensed.dispensings[0]).toMatchObject({ pharmacyName: 'Barnatorja Test' });
    const statuses = new Set(mine.body.items.map((i: { status: string }) => i.status));
    for (const s of ['ACTIVE', 'DISPENSED', 'EXPIRED', 'CANCELLED', 'STOPPED']) {
      expect(statuses.has(s)).toBe(true);
    }
    const byDoctor = await api()
      .get(`/api/v1/e-prescriptions/patients/${w.patient.id}`)
      .set(doctor());
    expect(byDoctor.body.items).toHaveLength(mine.body.items.length);
    for (const token of [w.tokens.otherPatient, w.tokens.reception, w.tokens.outsideDoctor]) {
      expect(
        (await api().get(`/api/v1/e-prescriptions/patients/${w.patient.id}`).set(bearer(token)))
          .status,
      ).toBe(403);
    }
    const list = await api().get('/api/v1/e-prescriptions/mine').set(doctor());
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({ patientId: w.patient.id, code: null });
    expect(
      (await api().get('/api/v1/e-prescriptions/mine').set(bearer(w.tokens.nurse))).status,
    ).toBe(403);
    // The chart's prescription list carries the e-prescription fields.
    const chart = await api().get(`/api/v1/patients/${w.patient.id}/prescriptions`).set(doctor());
    expect(
      chart.body.items.some((p: { ePrescriptionCode: string | null }) => p.ePrescriptionCode),
    ).toBe(true);
  });

  it('reports statistics without patients and with small numbers suppressed', async () => {
    const director = await api()
      .get('/api/v1/e-prescriptions/stats')
      .set(bearer(w.tokens.director));
    expect(director.status).toBe(200);
    expect(director.body.scope).toBe('FACILITY');
    expect(director.body.issued.value).toBeGreaterThanOrEqual(5);
    expect(director.body.pharmacies).toBeNull();
    // Fewer than five cancelled e-prescriptions: suppressed.
    expect(director.body.cancelled).toEqual({ value: null, suppressed: true });
    expect(JSON.stringify(director.body)).not.toContain(w.patient.lastName);
    const other = await api()
      .get('/api/v1/e-prescriptions/stats')
      .set(bearer(w.tokens.otherDirector));
    expect(other.body.issued).toEqual({ value: 0, suppressed: false });
    const ministry = await api()
      .get('/api/v1/e-prescriptions/stats')
      .set(bearer(w.tokens.ministry));
    expect(ministry.body.scope).toBe('NATIONAL');
    expect(Array.isArray(ministry.body.pharmacies)).toBe(true);
    expect((await api().get('/api/v1/e-prescriptions/stats').set(doctor())).status).toBe(403);
  });
});
