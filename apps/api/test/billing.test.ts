import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../src/db/client.js';
import {
  admissions,
  auditLogs,
  careUnits,
  charges,
  encounters,
  imagingOrders,
  insuranceCoverages,
  labOrders,
  partnerClients,
  patients,
  prescriptions,
} from '../src/db/schema.js';
import { hashToken } from '../src/lib/tokens.js';
import { captureCharges } from '../src/modules/billing/billing.service.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000);
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function insure(patientId: string, extra: Partial<typeof insuranceCoverages.$inferInsert> = {}) {
  await db.insert(insuranceCoverages).values({
    patientId,
    insurer: 'FSSH',
    policyNumber: `FSSH-${randomBytes(3).toString('hex')}`,
    status: 'ACTIVE',
    validFrom: '2020-01-01',
    ...extra,
  });
}

async function signedEncounter(patientId: string, doctorId: string, startedAt = day(-3)) {
  const [e] = await db
    .insert(encounters)
    .values({
      patientId,
      doctorId,
      facilityId: w.facility.id,
      type: 'OUTPATIENT',
      reason: 'Kontroll',
      noteStatus: 'SIGNED',
      startedAt,
      signedAt: startedAt,
      signedById: doctorId,
    })
    .returning();
  return e!;
}

const chargesOf = (patientId: string) =>
  db.select().from(charges).where(eq(charges.patientId, patientId));

beforeAll(async () => {
  w = await createWorld();
});

describe('insurance coverage', () => {
  it('reception records coverage; age exemptions are automatic; the patient can read it', async () => {
    const res = await api()
      .post(`/api/v1/billing/patients/${w.patient.id}/insurance`)
      .set(bearer(w.tokens.reception))
      .send({ insurer: 'FSSH', policyNumber: 'FSSH-123', validFrom: '2024-01-01' });
    expect(res.status).toBe(201);
    const own = await api()
      .get(`/api/v1/billing/patients/${w.patient.id}/insurance`)
      .set(bearer(w.tokens.patient));
    expect(own.status).toBe(200);
    expect(own.body.current.insurer).toBe('FSSH');
    expect(own.body.canEdit).toBe(false);
    expect(own.body.automaticExemption).toBeNull();

    const child = await createPatient(w.facility.id);
    await db.update(patients).set({ dateOfBirth: iso(day(-365 * 8)) }).where(eq(patients.id, child.id));
    const c = await api()
      .get(`/api/v1/billing/patients/${child.id}/insurance`)
      .set(bearer(w.tokens.reception));
    expect(c.body.automaticExemption).toBe('CHILD');

    // Other roles and other facilities may not.
    expect(
      (
        await api()
          .post(`/api/v1/billing/patients/${w.patient.id}/insurance`)
          .set(bearer(w.tokens.doctor))
          .send({ insurer: 'FSSH', validFrom: '2024-01-01' })
      ).status,
    ).toBe(403);
    const outsider = await createUser('RECEPTION', w.otherFacility.id);
    const t = await login(outsider.email);
    expect(
      (await api().get(`/api/v1/billing/patients/${w.patient.id}/insurance`).set(bearer(t))).status,
    ).toBe(403);
    expect(
      (await api().get(`/api/v1/billing/patients/${w.patient.id}/insurance`).set(bearer(w.tokens.otherPatient)))
        .status,
    ).toBe(403);
  });

  it('verification (demo rule) insures permanent national IDs only', async () => {
    const p = await createPatient(w.facility.id);
    const ok = await api()
      .post(`/api/v1/billing/patients/${p.id}/insurance/verify`)
      .set(bearer(w.tokens.reception));
    expect(ok.body).toMatchObject({ eligible: true, insurer: 'FSSH' });
    const temp = await createPatient(w.facility.id);
    await db.update(patients).set({ nationalId: `TMP${Date.now() % 1e9}` }).where(eq(patients.id, temp.id));
    const no = await api()
      .post(`/api/v1/billing/patients/${temp.id}/insurance/verify`)
      .set(bearer(w.tokens.reception));
    expect(no.body.eligible).toBe(false);
  });
});

describe('charge capture', () => {
  it('creates charges once per source, with co-payment rules', async () => {
    const insured = await createPatient(w.facility.id);
    await insure(insured.id);
    const pensioner = await createPatient(w.facility.id);
    await db.update(patients).set({ dateOfBirth: '1950-03-01' }).where(eq(patients.id, pensioner.id));
    await insure(pensioner.id);
    const uninsured = await createPatient(w.facility.id);

    for (const p of [insured, pensioner, uninsured]) await signedEncounter(p.id, w.users.doctor.id);
    await db.insert(labOrders).values({
      placerOrderNumber: `PAC${randomBytes(5).toString('hex')}`,
      patientId: insured.id,
      orderedById: w.users.doctor.id,
      facilityId: w.facility.id,
      testCode: '718-7',
      testName: 'Haemoglobin',
      specimen: 'Blood',
      priority: 'ROUTINE',
      status: 'RESULTED',
      resultedAt: day(-2),
    });
    await db.insert(imagingOrders).values({
      accessionNumber: `IMG${randomBytes(5).toString('hex')}`,
      patientId: insured.id,
      facilityId: w.facility.id,
      orderedById: w.users.doctor.id,
      modality: 'CT',
      bodyPart: 'Koka',
      clinicalQuestion: 'Trauma',
      status: 'REPORTED',
      impression: 'Pa ndryshime',
      reportedAt: day(-2),
    });
    const [rx] = await db
      .insert(prescriptions)
      .values({
        patientId: insured.id,
        doctorId: w.users.doctor.id,
        medication: 'Amoxicillin',
        dosage: '500 mg',
        frequency: '3x',
        startDate: iso(day(-2)),
        pharmacyStatus: 'DISPENSED',
        dispensedById: w.users.pharmacist.id,
        dispensedAt: day(-2),
      })
      .returning();
    const [unit] = await db
      .insert(careUnits)
      .values({ facilityId: w.facility.id, name: 'Interna', code: `W${randomBytes(2).toString('hex')}`, type: 'GENERAL_WARD' })
      .returning();
    await db.insert(admissions).values({
      patientId: insured.id,
      facilityId: w.facility.id,
      unitId: unit!.id,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'ELECTIVE',
      reason: 'Vëzhgim',
      status: 'DISCHARGED',
      admittedAt: day(-6),
      dischargedAt: day(-2),
      disposition: 'HOME',
    });

    const first = await captureCharges(w.facility.id);
    expect(first.ENCOUNTER).toBeGreaterThanOrEqual(3);
    expect(first.LAB_ORDER).toBeGreaterThanOrEqual(1);
    expect(first.IMAGING).toBeGreaterThanOrEqual(1);
    expect(first.DISPENSE).toBeGreaterThanOrEqual(1);
    expect(first.BED_DAY).toBeGreaterThanOrEqual(1);
    const again = await captureCharges(w.facility.id);
    expect(Object.values(again).every((n) => n === 0)).toBe(true);

    const mine = await chargesOf(insured.id);
    expect(mine.filter((c) => c.sourceType === 'DISPENSE' && c.sourceId === rx!.id)).toHaveLength(1);
    const bed = mine.find((c) => c.sourceType === 'BED_DAY')!;
    expect(bed.quantity).toBe(4);
    const consult = mine.find((c) => c.sourceType === 'ENCOUNTER')!;
    expect(consult.copayCents).toBeGreaterThan(0);
    expect(consult.copayCents + consult.insurerCents).toBe(consult.totalCents);

    const [p65] = (await chargesOf(pensioner.id)).filter((c) => c.sourceType === 'ENCOUNTER');
    expect(p65!.copayCents).toBe(0);
    const [none] = (await chargesOf(uninsured.id)).filter((c) => c.sourceType === 'ENCOUNTER');
    expect(none!.insurerCents).toBe(0);
    expect(none!.copayCents).toBe(none!.totalCents);
  });
});

describe('co-payments and receipts', () => {
  it('takes payment for selected co-payments and issues a numbered receipt', async () => {
    const p = await createPatient(w.facility.id);
    await insure(p.id);
    await signedEncounter(p.id, w.users.doctor.id, day(-4));
    await signedEncounter(p.id, w.users.colleague.id, day(-3));
    await captureCharges(w.facility.id);
    const list = await api()
      .get(`/api/v1/billing/patients/${p.id}/charges`)
      .set(bearer(w.tokens.reception));
    expect(list.status).toBe(200);
    const open = list.body.items.filter((c: { copayPaid: boolean }) => !c.copayPaid);
    expect(open.length).toBe(2);
    const pay = await api()
      .post('/api/v1/billing/payments')
      .set(bearer(w.tokens.reception))
      .send({ patientId: p.id, chargeIds: [open[0].id], method: 'CASH' });
    expect(pay.status).toBe(201);
    expect(pay.body.receiptNumber).toMatch(new RegExp(`^${w.facility.code}-\\d{4}-\\d{6}$`));
    expect(pay.body.amountCents).toBe(open[0].copayCents);
    const twice = await api()
      .post('/api/v1/billing/payments')
      .set(bearer(w.tokens.reception))
      .send({ patientId: p.id, chargeIds: [open[0].id], method: 'CASH' });
    expect(twice.status).toBe(409);
    const after = await api()
      .get(`/api/v1/billing/patients/${p.id}/charges`)
      .set(bearer(w.tokens.reception));
    expect(after.body.items.filter((c: { copayPaid: boolean }) => !c.copayPaid)).toHaveLength(1);
    expect(after.body.payments).toHaveLength(1);
    // A paid charge cannot be voided; an unpaid one can.
    expect(
      (
        await api()
          .post(`/api/v1/billing/charges/${open[0].id}/void`)
          .set(bearer(w.tokens.reception))
          .send({ reason: 'Gabim në regjistrim' })
      ).status,
    ).toBe(409);
    expect(
      (
        await api()
          .post(`/api/v1/billing/charges/${open[1].id}/void`)
          .set(bearer(w.tokens.reception))
          .send({ reason: 'Gabim në regjistrim' })
      ).status,
    ).toBe(204);
    const receipt = await api().get(`/api/v1/billing/payments/${pay.body.id}`).set(bearer(w.tokens.reception));
    expect(receipt.body.lines).toHaveLength(1);
  });

  it('manual charges follow the same price rules', async () => {
    const p = await createPatient(w.facility.id);
    const res = await api()
      .post('/api/v1/billing/charges')
      .set(bearer(w.tokens.reception))
      .send({ patientId: p.id, serviceCode: 'CONS-SP', quantity: 1 });
    expect(res.status).toBe(201);
    expect(res.body.insurerCents).toBe(0);
    expect(res.body.copayCents).toBe(res.body.totalCents);
    expect(
      (
        await api()
          .post('/api/v1/billing/charges')
          .set(bearer(w.tokens.reception))
          .send({ patientId: p.id, serviceCode: 'NOPE' })
      ).status,
    ).toBe(400);
  });
});

describe('claims to the Health Insurance Fund', () => {
  let claimId: string;
  let reference: string;
  let insuredId: string;
  const key = `pk_test_hif_${randomBytes(8).toString('hex')}`;

  it('creates a draft claim with insured charges of the period and submits it', async () => {
    const facility = w.facility;
    const p = await createPatient(facility.id);
    insuredId = p.id;
    await insure(p.id);
    await signedEncounter(p.id, w.users.doctor.id, day(-5));
    await captureCharges(facility.id);
    const res = await api()
      .post('/api/v1/billing/claims')
      .set(bearer(w.tokens.director))
      .send({ periodFrom: iso(day(-40)), periodTo: iso(day(0)) });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.totalCents).toBeGreaterThan(0);
    claimId = res.body.id;
    reference = res.body.reference;
    const detail = await api().get(`/api/v1/billing/claims/${claimId}`).set(bearer(w.tokens.director));
    expect(detail.body.lines.every((l: { insurerCents: number }) => l.insurerCents > 0)).toBe(true);
    // Charges in a claim are not claimed twice.
    const empty = await api()
      .post('/api/v1/billing/claims')
      .set(bearer(w.tokens.director))
      .send({ periodFrom: iso(day(-40)), periodTo: iso(day(0)) });
    expect(empty.status).toBe(400);
    const submit = await api().post(`/api/v1/billing/claims/${claimId}/submit`).set(bearer(w.tokens.director));
    expect(submit.body.status).toBe('SUBMITTED');
    const [claimed] = (await chargesOf(p.id)).filter((c) => c.claimId === claimId);
    expect(claimed!.status).toBe('CLAIMED');
    expect(
      (await api().get(`/api/v1/billing/claims/${claimId}`).set(bearer(w.tokens.otherDirector))).status,
    ).toBe(404);
  });

  it('the Fund reads claims through the partner API and records its decision', async () => {
    const [client] = await db
      .insert(partnerClients)
      .values({
        name: 'FSSH test',
        organisation: 'Fondi i Sigurimit Shëndetësor',
        scopes: ['claims.read'],
        apiKeyHash: hashToken(key),
        apiKeyPrefix: key.slice(0, 10),
        createdById: w.users.ministry.id,
      })
      .returning();
    const auth = { Authorization: `Bearer ${key}` };
    const list = await api().get('/api/v1/partner/claims').set(auth);
    expect(list.status).toBe(200);
    expect(list.body.items.some((c: { reference: string }) => c.reference === reference)).toBe(true);
    const detail = await api().get(`/api/v1/partner/claims/${claimId}`).set(auth);
    expect(detail.status).toBe(200);
    expect(detail.body.lines[0]).toHaveProperty('nationalId');
    expect(detail.body.lines[0]).not.toHaveProperty('patientName');
    const logs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.patientId, insuredId), eq(auditLogs.action, 'partner.api.access')));
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const lineId = detail.body.lines[0].id;
    const decision = await api()
      .post(`/api/v1/partner/claims/${claimId}/decision`)
      .set(auth)
      .send({ status: 'PARTIALLY_PAID', paidCents: 100, rejectedLineIds: [lineId], note: 'Mungon dokumentacioni' });
    expect(decision.status).toBe(200);
    expect(decision.body.status).toBe('PARTIALLY_PAID');
    const [rejected] = await db.select().from(charges).where(eq(charges.id, lineId));
    expect(rejected!.status).toBe('REJECTED');

    // Without the scope: refused.
    const otherKey = `pk_test_other_${randomBytes(8).toString('hex')}`;
    await db.insert(partnerClients).values({
      name: 'Stats only',
      organisation: 'IKShPK',
      scopes: ['stats.read'],
      apiKeyHash: hashToken(otherKey),
      apiKeyPrefix: otherKey.slice(0, 10),
      createdById: w.users.ministry.id,
    });
    expect(
      (await api().get('/api/v1/partner/claims').set({ Authorization: `Bearer ${otherKey}` })).status,
    ).toBe(403);
    expect(client).toBeDefined();
  });
});

describe('billing report', () => {
  it('reports revenue per facility and month for the director', async () => {
    const res = await api().get('/api/v1/reports/billing').set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    expect(res.body.columns).toContain('insurerCents');
    expect(res.body.rows.every((r: { code: string }) => r.code === w.facility.code)).toBe(true);
    const ministry = await api().get('/api/v1/reports/billing').set(bearer(w.tokens.ministry));
    expect(ministry.status).toBe(200);
  });
});
