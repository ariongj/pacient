import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  allergies,
  auditLogs,
  careUnits,
  medicationAdministrations,
  medicationCatalog,
  prescriptions,
} from '../src/db/schema.js';
import { internalEan13, isValidGtin, normaliseBarcode } from '../src/modules/bcma/barcode.js';
import { doseInterval, timingCheck } from '../src/modules/bcma/timing.js';
import {
  signWristband,
  verifyWristband,
  WRISTBAND_MAX_AGE_DAYS,
} from '../src/modules/bcma/token.js';
import { api, bearer, createPatient, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let unitId: string;
let otherAdmittedId: string;
const seq = Math.floor(Math.random() * 1e6) * 10;
const codes = {
  paracetamol: internalEan13(seq + 1, 291),
  paracetamolOtherBrand: internalEan13(seq + 2, 291),
  paracetamol1g: internalEan13(seq + 3, 291),
  ibuprofen: internalEan13(seq + 4, 291),
  amoxicillin: internalEan13(seq + 5, 291),
};
const items: Record<keyof typeof codes, string> = {} as never;
const base = () => `/api/v1/patients/${w.patient.id}`;
const nurse = () => bearer(w.tokens.nurse);

async function catalogItem(
  key: keyof typeof codes,
  name: string,
  strength: string,
  ingredients: string[],
) {
  const [row] = await db
    .insert(medicationCatalog)
    .values({
      name: `${name} ${seq}`,
      form: 'tablet',
      strength,
      unit: 'tablet',
      ingredients,
      barcode: codes[key],
    })
    .returning();
  items[key] = row!.id;
}

async function prescription(
  medication: string,
  catalogKey: keyof typeof codes | null,
  frequency: string,
) {
  const [rx] = await db
    .insert(prescriptions)
    .values({
      patientId: w.patient.id,
      doctorId: w.users.doctor.id,
      medication,
      catalogItemId: catalogKey ? items[catalogKey] : null,
      dosage: '500 mg',
      frequency,
      startDate: '2026-11-01',
      pharmacyStatus: 'VERIFIED',
    })
    .returning();
  return rx!.id;
}

let band: string;
let otherBand: string;

beforeAll(async () => {
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({
      facilityId: w.facility.id,
      name: 'Interna B',
      code: `IB${seq}`.slice(0, 20),
      type: 'GENERAL_WARD',
    })
    .returning();
  unitId = unit!.id;
  const other = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  otherAdmittedId = other.id;
  for (const p of [w.patient.id, other.id]) {
    await db.insert(admissions).values({
      patientId: p,
      facilityId: w.facility.id,
      unitId,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'ELECTIVE',
      reason: 'Pneumoni',
      admittedAt: new Date(Date.now() - 86_400_000),
    });
  }
  await catalogItem('paracetamol', 'Paracetamol', '500 mg', ['paracetamol']);
  await catalogItem('paracetamolOtherBrand', 'Paracetamol Generic', '500 mg', ['paracetamol']);
  await catalogItem('paracetamol1g', 'Paracetamol Forte', '1 g', ['paracetamol']);
  await catalogItem('ibuprofen', 'Ibuprofen', '400 mg', ['ibuprofen']);
  await catalogItem('amoxicillin', 'Amoxicillin', '500 mg', ['amoxicillin']);
  await db.insert(allergies).values({
    patientId: w.patient.id,
    substance: 'Penicillin',
    severity: 'SEVERE',
    verificationStatus: 'CONFIRMED',
    recordedById: w.users.doctor.id,
  });
  await api().post(`${base()}/care-team`).set(nurse()).send({}).expect(201);
});

describe('wristband token', () => {
  it('signs and verifies; tampering and foreign tokens are rejected', () => {
    const id = '0b9a3c3e-8a3d-4a5b-9d7a-1f6b2b2f7c11';
    const t = signWristband(id);
    expect(t.startsWith('PAC1.')).toBe(true);
    const ok = verifyWristband(t);
    expect(ok).toMatchObject({ valid: true, patientId: id, expired: false });

    const [prefix, payload, sig] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({ p: '11111111-1111-4111-8111-111111111111', i: 1 }),
    ).toString('base64url');
    expect(verifyWristband(`${prefix}.${forged}.${sig}`).valid).toBe(false);
    const flipped = sig!.slice(0, -1) + (sig!.endsWith('A') ? 'B' : 'A');
    expect(verifyWristband(`${prefix}.${payload}.${flipped}`).valid).toBe(false);
    expect(verifyWristband('not-a-token').valid).toBe(false);
    expect(verifyWristband(`PAC2.${payload}.${sig}`).valid).toBe(false);

    const old = signWristband(id, new Date(Date.now() - (WRISTBAND_MAX_AGE_DAYS + 1) * 86_400_000));
    expect(verifyWristband(old)).toMatchObject({ valid: true, expired: true });
  });

  it('barcodes: EAN-13 check digits and normalisation', () => {
    const c = internalEan13(42);
    expect(c).toHaveLength(13);
    expect(c.startsWith('290')).toBe(true);
    expect(isValidGtin(c)).toBe(true);
    expect(isValidGtin(`${c.slice(0, 12)}${(Number(c[12]) + 1) % 10}`)).toBe(false);
    expect(normaliseBarcode(`01${'0'}${c}17271231`)).toBe(c);
    expect(normaliseBarcode(` ${c}\n`)).toBe(c);
  });

  it('timing: not due and already given', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    const q8 = doseInterval({ frequency: 'every 8 hours' });
    expect(q8.hours).toBe(8);
    expect(doseInterval({ frequency: '3 herë në ditë' }).hours).toBe(8);
    expect(doseInterval({ frequency: 'dy herë në ditë' }).hours).toBe(12);
    expect(doseInterval({ frequency: '2 puta dnevno' }).hours).toBe(12);
    expect(doseInterval({ frequency: 'once daily' }).hours).toBe(24);
    expect(doseInterval({ frequency: 'x', frequencyCode: 'Q6H' }).hours).toBe(6);
    expect(doseInterval({ frequency: 'sipas nevojës' }).asNeeded).toBe(true);
    expect(timingCheck(q8, new Date('2026-11-04T11:40:00Z'), now).problem).toBe('ALREADY_GIVEN');
    expect(timingCheck(q8, new Date('2026-11-04T08:00:00Z'), now).problem).toBe('NOT_DUE');
    expect(timingCheck(q8, new Date('2026-11-04T04:30:00Z'), now).problem).toBeNull();
    expect(
      timingCheck(doseInterval({ frequency: 'STAT' }), new Date('2026-11-03T08:00:00Z'), now)
        .problem,
    ).toBe('ALREADY_GIVEN');
  });
});

describe('printing a wristband', () => {
  it('is allowed for reception, nurses and doctors and is audited', async () => {
    const res = await api().post(`${base()}/wristband`).set(bearer(w.tokens.reception)).send({});
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^PAC1\./);
    expect(res.body.allergyStatus).toBe('ALLERGIES');
    expect(res.body.allergies).toContain('Penicillin');
    expect(res.body.patient.identifierKind).toBe('NATIONAL_ID');
    expect(res.body.stay).toMatchObject({ kind: 'ADMISSION', unit: 'Interna B' });
    expect(res.body.bloodGroup).toBeNull();
    band = res.body.token;
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.patientId, w.patient.id),
          eq(auditLogs.action, 'patient.wristband_printed'),
        ),
      );
    expect(audits.length).toBe(1);

    const other = await api()
      .post(`/api/v1/patients/${otherAdmittedId}/wristband`)
      .set(bearer(w.tokens.nurse));
    expect(other.status).toBe(201);
    otherBand = other.body.token;
  });

  it('is refused for pharmacists, patients and patients not admitted', async () => {
    expect((await api().post(`${base()}/wristband`).set(bearer(w.tokens.pharmacist))).status).toBe(
      403,
    );
    expect((await api().post(`${base()}/wristband`).set(bearer(w.tokens.patient))).status).toBe(
      403,
    );
    expect(
      (await api().post(`${base()}/wristband`).set(bearer(w.tokens.outsideDoctor))).status,
    ).toBe(403);
    const notAdmitted = await api()
      .post(`/api/v1/patients/${w.otherPatient.id}/wristband`)
      .set(bearer(w.tokens.reception));
    expect(notAdmitted.status).toBe(409);
  });
});

describe('bedside verification', () => {
  let paraRx: string;
  let textRx: string;
  let amoxRx: string;
  beforeAll(async () => {
    paraRx = await prescription('Paracetamol 500 mg', 'paracetamol', 'every 6 hours');
    textRx = await prescription('Ibuprofen', null, 'three times daily');
    amoxRx = await prescription('Amoxicillin 500 mg', 'amoxicillin', 'every 8 hours');
  });
  const verify = (body: Record<string, unknown>) =>
    api().post(`${base()}/bcma/verify`).set(nurse()).send(body);

  it('passes when the right patient and the right medicine are scanned', async () => {
    const res = await verify({
      prescriptionId: paraRx,
      patientToken: band,
      medicationBarcode: codes.paracetamol,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      patientConfirmed: true,
      medicationConfirmed: true,
      problems: [],
    });
    // Another brand with the same ingredient and strength is fine; a GS1 string is accepted.
    const generic = await verify({
      prescriptionId: paraRx,
      patientToken: band,
      medicationBarcode: `010${codes.paracetamolOtherBrand}`,
    });
    expect(generic.body.ok).toBe(true);
    // Free-text prescription matched by ingredient.
    const text = await verify({
      prescriptionId: textRx,
      patientToken: band,
      medicationBarcode: codes.ibuprofen,
    });
    expect(text.body.ok).toBe(true);
  });

  it('stops a wrong patient, a forged wristband and a wrong medicine', async () => {
    const wrong = await verify({
      prescriptionId: paraRx,
      patientToken: otherBand,
      medicationBarcode: codes.paracetamol,
    });
    expect(wrong.body.ok).toBe(false);
    expect(wrong.body.problems[0]).toMatchObject({
      code: 'WRONG_PATIENT',
      overridable: false,
      severity: 'STOP',
    });

    const forged = await verify({ prescriptionId: paraRx, patientToken: `${band}x` });
    expect(forged.body.problems.map((p: { code: string }) => p.code)).toContain('INVALID_TOKEN');

    const drug = await verify({
      prescriptionId: paraRx,
      patientToken: band,
      medicationBarcode: codes.ibuprofen,
    });
    expect(drug.body.problems).toEqual([
      expect.objectContaining({ code: 'WRONG_DRUG', overridable: false }),
    ]);
    expect(drug.body.medicationConfirmed).toBe(false);

    const strength = await verify({
      prescriptionId: paraRx,
      patientToken: band,
      medicationBarcode: codes.paracetamol1g,
    });
    expect(strength.body.problems).toEqual([
      expect.objectContaining({ code: 'DIFFERENT_STRENGTH', overridable: true }),
    ]);

    const unknown = await verify({
      prescriptionId: paraRx,
      patientToken: band,
      medicationBarcode: '2999999999992',
    });
    expect(unknown.body.problems.map((p: { code: string }) => p.code)).toEqual(['UNKNOWN_BARCODE']);
  });

  it('reports an expired wristband and an allergy', async () => {
    const old = signWristband(
      w.patient.id,
      new Date(Date.now() - (WRISTBAND_MAX_AGE_DAYS + 5) * 86_400_000),
    );
    const expired = await verify({
      prescriptionId: paraRx,
      patientToken: old,
      medicationBarcode: codes.paracetamol,
    });
    expect(expired.body.problems).toEqual([
      expect.objectContaining({ code: 'EXPIRED_TOKEN', overridable: true }),
    ]);

    const allergy = await verify({
      prescriptionId: amoxRx,
      patientToken: band,
      medicationBarcode: codes.amoxicillin,
    });
    expect(allergy.body.problems).toEqual([
      expect.objectContaining({ code: 'ALLERGY', overridable: true }),
    ]);
    expect(allergy.body.problems[0].message).toMatch(/penicillin/i);
  });

  it('only the care team can verify', async () => {
    const res = await api()
      .post(`${base()}/bcma/verify`)
      .set(bearer(w.tokens.reception))
      .send({ prescriptionId: paraRx, patientToken: band });
    expect(res.status).toBe(403);
  });

  describe('recording a dose', () => {
    const give = (body: Record<string, unknown>) =>
      api()
        .post(`${base()}/medication-administrations`)
        .set(nurse())
        .send({ status: 'GIVEN', doseGiven: '500 mg', ...body });

    it('stores the scan flags when both were scanned', async () => {
      const res = await give({
        prescriptionId: paraRx,
        patientScanned: true,
        medicationScanned: true,
        scanToken: band,
        barcode: codes.paracetamol,
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        patientScanned: true,
        medicationScanned: true,
        scanOverrideReason: null,
      });
      const mar = await api().get(`${base()}/medication-administrations`).set(nurse());
      expect(mar.body.items[0]).toMatchObject({ patientScanned: true, medicationScanned: true });
    });

    it('flags a second dose too soon as already given / not due', async () => {
      const res = await verify({
        prescriptionId: paraRx,
        patientToken: band,
        medicationBarcode: codes.paracetamol,
      });
      expect(res.body.problems.map((p: { code: string }) => p.code)).toEqual(['ALREADY_GIVEN']);
      const again = await give({
        prescriptionId: paraRx,
        patientScanned: true,
        medicationScanned: true,
        scanToken: band,
        barcode: codes.paracetamol,
      });
      expect(again.status).toBe(400);
      expect(again.body.error.details.problems[0].code).toBe('ALREADY_GIVEN');

      // Two hours later it is not yet due (every 6 hours).
      await db.insert(medicationAdministrations).values({
        prescriptionId: textRx,
        patientId: w.patient.id,
        administeredById: w.users.nurse.id,
        status: 'GIVEN',
        administeredAt: new Date(Date.now() - 2 * 3_600_000),
      });
      const early = await verify({
        prescriptionId: textRx,
        patientToken: band,
        medicationBarcode: codes.ibuprofen,
      });
      expect(early.body.problems.map((p: { code: string }) => p.code)).toEqual(['NOT_DUE']);
    });

    it('never accepts a wrong patient, even with a reason, and audits the refusal', async () => {
      const res = await give({
        prescriptionId: textRx,
        scanToken: otherBand,
        barcode: codes.ibuprofen,
        scanOverrideReason: 'I am sure this is the right patient, really.',
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BCMA_STOP');
      expect(res.body.error.details.problems[0].code).toBe('WRONG_PATIENT');
      const drug = await give({
        prescriptionId: textRx,
        scanToken: band,
        barcode: codes.paracetamol,
        scanOverrideReason: 'Pharmacy said it is the same thing.',
      });
      expect(drug.status).toBe(409);
      expect(drug.body.error.details.problems[0].code).toBe('WRONG_DRUG');
      // A refused dose is refused too when the wrong wristband is scanned.
      const refused = await api()
        .post(`${base()}/medication-administrations`)
        .set(nurse())
        .send({
          prescriptionId: textRx,
          status: 'REFUSED',
          reason: 'Patient refused',
          scanToken: otherBand,
        });
      expect(refused.status).toBe(409);
      const denied = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.patientId, w.patient.id),
            eq(auditLogs.action, 'medication.barcode_override'),
          ),
        );
      expect(denied.filter((a) => a.outcome === 'DENIED').length).toBe(3);
    });

    it('cannot claim a scan that did not happen', async () => {
      const res = await give({
        prescriptionId: amoxRx,
        patientScanned: true,
        medicationScanned: true,
      });
      expect(res.status).toBe(400);
      const fake = await give({
        prescriptionId: amoxRx,
        patientScanned: true,
        medicationScanned: true,
        scanToken: band,
        barcode: '2999999999992',
        scanOverrideReason: 'Barcode label damaged on the pack.',
      });
      expect(fake.status).toBe(400);
    });

    it('an override needs a reason of at least 10 characters and is audited', async () => {
      const none = await give({ prescriptionId: amoxRx });
      expect(none.status).toBe(400);
      expect(none.body.error.details).toMatchObject({
        patientScanned: false,
        medicationScanned: false,
      });
      const short = await give({ prescriptionId: amoxRx, scanOverrideReason: 'too short' });
      expect(short.status).toBe(400);
      // Scanned, but the allergy warning still needs a reason.
      const allergyNoReason = await give({
        prescriptionId: amoxRx,
        patientScanned: true,
        medicationScanned: true,
        scanToken: band,
        barcode: codes.amoxicillin,
      });
      expect(allergyNoReason.status).toBe(400);
      expect(allergyNoReason.body.error.details.problems[0].code).toBe('ALLERGY');

      const ok = await give({
        prescriptionId: amoxRx,
        scanToken: band,
        patientScanned: true,
        scanOverrideReason: 'Pack barcode unreadable; allergy reviewed by Dr on call.',
      });
      expect(ok.status).toBe(201);
      expect(ok.body).toMatchObject({
        patientScanned: true,
        medicationScanned: false,
        scanOverrideReason: 'Pack barcode unreadable; allergy reviewed by Dr on call.',
      });
      const audits = await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.resourceId, ok.body.id),
            eq(auditLogs.action, 'medication.barcode_override'),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toMatchObject({
        patientScanned: true,
        medicationScanned: false,
        problems: ['ALLERGY'],
      });
    });

    it('withheld doses need no scan', async () => {
      const res = await api()
        .post(`${base()}/medication-administrations`)
        .set(nurse())
        .send({
          prescriptionId: paraRx,
          status: 'WITHHELD',
          reason: 'Nil by mouth before surgery',
        });
      expect(res.status).toBe(201);
      expect(res.body.scanOverrideReason).toBeNull();
    });

    it('reports the ward scanning compliance', async () => {
      const res = await api().get(`${base()}/bcma/compliance?days=7`).set(nurse());
      expect(res.status).toBe(200);
      expect(res.body.unit.name).toBe('Interna B');
      // Given: paracetamol (both scanned), ibuprofen (seeded, unscanned), amoxicillin (override).
      expect(res.body.compliance).toMatchObject({ given: 3, bothScanned: 1, overridden: 1 });
      expect(res.body.compliance.compliancePct).toBeCloseTo(33.3, 1);
      expect(
        (await api().get(`${base()}/bcma/compliance`).set(bearer(w.tokens.patient))).status,
      ).toBe(403);
    });
  });
});
