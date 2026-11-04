import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { auditLogs, drugInteractions, patients, prescriptionAlerts } from '../src/db/schema.js';
import { invalidateInteractionCache, orderPair } from '../src/modules/safety/engine.js';
import { SEED_INTERACTIONS } from '../src/modules/safety/knowledge.js';
import { api, bearer, createPatient, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;

beforeAll(async () => {
  w = await createWorld();
  const rows = SEED_INTERACTIONS.map(([x, y, severity, effect, management]) => {
    const [a, b] = orderPair(x, y);
    return { ingredientA: a, ingredientB: b, severity, effect, management };
  });
  await db.insert(drugInteractions).values(rows).onConflictDoNothing();
  invalidateInteractionCache();
});

type Alert = { code: string; kind: string; severity: string; blocking: boolean; message: string };

/** A fresh patient in the doctor's care team (optionally with a date of birth and sex). */
async function patient(opts: { dob?: string; sex?: 'FEMALE' | 'MALE' } = {}) {
  const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  if (opts.dob || opts.sex) {
    await db
      .update(patients)
      .set({ dateOfBirth: opts.dob ?? p.dateOfBirth, sex: opts.sex ?? p.sex })
      .where(eq(patients.id, p.id));
  }
  return p.id;
}

const base = (id: string) => `/api/v1/patients/${id}`;

async function prescribe(
  patientId: string,
  medication: string,
  extra: Record<string, unknown> = {},
) {
  return api()
    .post(`${base(patientId)}/prescriptions`)
    .set(bearer(w.tokens.doctor))
    .send({
      medication,
      dosage: '1 tablet',
      frequency: 'once daily',
      startDate: '2026-11-04',
      ...extra,
    });
}

async function check(patientId: string, medication: string, token = w.tokens.doctor) {
  const res = await api()
    .post('/api/v1/safety/check')
    .set(bearer(token))
    .send({ patientId, medication });
  return res;
}
const alertsOf = (res: { body: { alerts: Alert[] } }) => res.body.alerts;

describe('interactions and duplicates', () => {
  it('finds an interaction whichever medicine came first', async () => {
    const p1 = await patient();
    expect((await prescribe(p1, 'Warfarin 5 mg')).status).toBe(201);
    const a1 = alertsOf(await check(p1, 'Ibuprofen 400 mg'));
    const hit1 = a1.find((a) => a.kind === 'INTERACTION');
    expect(hit1).toMatchObject({
      code: 'INTERACTION:ibuprofen+warfarin',
      severity: 'MAJOR',
      blocking: true,
    });

    const p2 = await patient();
    expect((await prescribe(p2, 'Brufen 400 mg')).status).toBe(201); // brand name → ibuprofen
    const a2 = alertsOf(await check(p2, 'Marevan 3 mg'));
    expect(a2.find((a) => a.kind === 'INTERACTION')?.code).toBe('INTERACTION:ibuprofen+warfarin');
  });

  it('flags two medicines of the same class as duplicate therapy (not blocking)', async () => {
    const p = await patient();
    await prescribe(p, 'Ibuprofen 400 mg');
    const alerts = alertsOf(await check(p, 'Diclofenac 50 mg'));
    expect(alerts.find((a) => a.code === 'DUPLICATE:class:NSAID')).toMatchObject({
      severity: 'MODERATE',
      blocking: false,
    });
    // Moderate alerts do not block prescribing; they are stored with the prescription.
    const rx = await prescribe(p, 'Diclofenac 50 mg');
    expect(rx.status).toBe(201);
    expect(rx.body.alerts.some((a: Alert) => a.code === 'DUPLICATE:class:NSAID')).toBe(true);
    const stored = await db
      .select()
      .from(prescriptionAlerts)
      .where(eq(prescriptionAlerts.prescriptionId, rx.body.id));
    expect(stored.length).toBeGreaterThan(0);
    expect(stored[0]!.overrideReason).toBeNull();
  });
});

describe('allergies, kidney function, age and pregnancy', () => {
  it('penicillin allergy blocks amoxicillin and warns about cephalosporins', async () => {
    const p = await patient();
    await api()
      .post(`${base(p)}/allergies`)
      .set(bearer(w.tokens.doctor))
      .send({ substance: 'Penicillin', severity: 'MODERATE', verificationStatus: 'UNCONFIRMED' })
      .expect(201);
    expect(alertsOf(await check(p, 'Augmentin 875/125 mg'))[0]).toMatchObject({
      kind: 'ALLERGY',
      severity: 'MAJOR',
    });
    const ceph = alertsOf(await check(p, 'Ceftriaxone 1 g'));
    expect(ceph[0]).toMatchObject({ kind: 'ALLERGY', severity: 'MODERATE', blocking: false });
  });

  it('uses kidney function from creatinine (CKD-EPI) for metformin and nitrofurantoin', async () => {
    const p = await patient({ dob: '1980-03-01', sex: 'FEMALE' });
    await api()
      .post(`${base(p)}/lab-results`)
      .set(bearer(w.tokens.doctor))
      .send({ testName: 'Creatinine', value: '350', unit: 'µmol/L', flag: 'HIGH', status: 'FINAL' })
      .expect(201);
    const met = alertsOf(await check(p, 'Metformin 850 mg')).find((a) => a.kind === 'RENAL');
    expect(met).toMatchObject({ severity: 'CONTRAINDICATED', code: 'RENAL:metformin' });
    expect(met!.message).toMatch(/eGFR \d+/);
    const nitro = alertsOf(await check(p, 'Nitrofurantoin 100 mg')).find((a) => a.kind === 'RENAL');
    expect(nitro?.severity).toBe('MAJOR');
  });

  it('warns about aspirin and codeine in children', async () => {
    const p = await patient({ dob: '2018-05-01' });
    expect(alertsOf(await check(p, 'Aspirin 100 mg')).find((a) => a.kind === 'AGE')).toMatchObject({
      severity: 'MAJOR',
    });
    expect(alertsOf(await check(p, 'Codeine 15 mg')).find((a) => a.kind === 'AGE')).toMatchObject({
      severity: 'CONTRAINDICATED',
    });
  });

  it('blocks warfarin in pregnancy', async () => {
    const p = await patient({ dob: '1994-02-01', sex: 'FEMALE' });
    await api()
      .post(`${base(p)}/diagnoses`)
      .set(bearer(w.tokens.doctor))
      .send({ icd10Code: 'Z34.0', description: 'Supervision of normal first pregnancy' })
      .expect(201);
    const preg = alertsOf(await check(p, 'Warfarin 5 mg')).find((a) => a.kind === 'PREGNANCY');
    expect(preg).toMatchObject({ severity: 'CONTRAINDICATED', blocking: true });
  });
});

describe('prescribing with overrides', () => {
  it('needs a reason for each blocking alert, stores it and audits the override', async () => {
    const p = await patient();
    await prescribe(p, 'Warfarin 5 mg');
    const blocked = await prescribe(p, 'Ibuprofen 400 mg');
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('SAFETY_ALERTS');
    const codes = (blocked.body.error.details.alerts as Alert[])
      .filter((a) => a.blocking)
      .map((a) => a.code);
    expect(codes).toContain('INTERACTION:ibuprofen+warfarin');

    const tooShort = await prescribe(p, 'Ibuprofen 400 mg', {
      overrides: codes.map((code) => ({ code, reason: 'short' })),
    });
    expect(tooShort.status).toBe(400);

    const ok = await prescribe(p, 'Ibuprofen 400 mg', {
      overrides: codes.map((code) => ({
        code,
        reason: 'Two days only, with omeprazole; INR check Friday.',
      })),
    });
    expect(ok.status).toBe(201);
    const [stored] = await db
      .select()
      .from(prescriptionAlerts)
      .where(
        and(
          eq(prescriptionAlerts.prescriptionId, ok.body.id),
          eq(prescriptionAlerts.kind, 'INTERACTION'),
        ),
      );
    expect(stored).toMatchObject({
      severity: 'MAJOR',
      overrideReason: 'Two days only, with omeprazole; INR check Friday.',
      overriddenById: w.users.doctor.id,
    });
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'medication.alert_overridden'),
          eq(auditLogs.resourceId, ok.body.id),
        ),
      );
    expect(audits).toHaveLength(1);

    const list = await api()
      .get(`/api/v1/safety/patients/${p}/alerts`)
      .set(bearer(w.tokens.doctor));
    expect(list.body.byPrescription[ok.body.id][0].overrideReason).toContain('INR check');
  });

  it('shows prescribing alerts, overrides and fresh checks to the pharmacist', async () => {
    const p = await patient();
    await prescribe(p, 'Simvastatin 40 mg');
    const first = await prescribe(p, 'Clarithromycin 500 mg');
    const codes = (first.body.error.details.alerts as Alert[])
      .filter((a) => a.blocking)
      .map((a) => a.code);
    const rx = await prescribe(p, 'Clarithromycin 500 mg', {
      overrides: codes.map((code) => ({
        code,
        reason: 'Simvastatin paused for the 7-day course.',
      })),
    });
    expect(rx.status).toBe(201);

    const queue = await api().get('/api/v1/pharmacy/queue').set(bearer(w.tokens.pharmacist));
    const item = queue.body.items.find((i: { id: string }) => i.id === rx.body.id);
    expect(
      item.alerts.some((a: Alert) => a.kind === 'INTERACTION' && a.severity === 'CONTRAINDICATED'),
    ).toBe(true);
    const ctx = await api()
      .get(`/api/v1/pharmacy/prescriptions/${rx.body.id}`)
      .set(bearer(w.tokens.pharmacist));
    expect(ctx.body.prescribingAlerts[0].overrideReason).toContain('Simvastatin paused');

    // Pharmacists may run checks for patients with a prescription at their facility only.
    expect((await check(p, 'Ibuprofen 400 mg', w.tokens.pharmacist)).status).toBe(200);
    expect((await check(p, 'Ibuprofen 400 mg', w.tokens.outsidePharmacist)).status).toBe(403);

    const ret = await api()
      .post(`/api/v1/pharmacy/prescriptions/${rx.body.id}/return`)
      .set(bearer(w.tokens.pharmacist))
      .send({ note: 'Please choose azithromycin instead.', alertCode: codes[0] });
    expect(ret.body.pharmacyStatus).toBe('RETURNED');
  });

  it('translates alert messages into the reader’s language', async () => {
    const p = await patient();
    await prescribe(p, 'Warfarin 5 mg');
    const en = alertsOf(await check(p, 'Ibuprofen 400 mg'))[0]!.message;
    await api()
      .patch('/api/v1/auth/me/preferences')
      .set(bearer(w.tokens.colleague))
      .send({ locale: 'sq' })
      .expect(200);
    await api()
      .post(`${base(p)}/care-team`)
      .set(bearer(w.tokens.colleague))
      .send({});
    const sq = alertsOf(await check(p, 'Ibuprofen 400 mg', w.tokens.colleague));
    expect(sq[0]!.message).not.toBe(en);
    expect(sq[0]!.message).toMatch(/Ndërveprim/);
  });
});

describe('interaction checker and database', () => {
  it('checks a list of medicines pairwise', async () => {
    const res = await api()
      .post('/api/v1/safety/check-list')
      .set(bearer(w.tokens.pharmacist))
      .send({
        medications: [
          { medication: 'Warfarin' },
          { medication: 'Ibuprofen' },
          { medication: 'Diclofenac' },
        ],
      });
    expect(res.status).toBe(200);
    const codes = res.body.pairwise.map((a: Alert) => a.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'INTERACTION:ibuprofen+warfarin',
        'INTERACTION:diclofenac+warfarin',
        'DUPLICATE:class:NSAID',
      ]),
    );
  });

  it('only the Ministry edits the interaction database', async () => {
    const pair = {
      ingredientA: 'tramadol',
      ingredientB: 'ondansetron',
      severity: 'MODERATE',
      effect: 'Ondansetron may reduce the analgesic effect of tramadol.',
      management: 'Monitor pain control.',
    };
    expect(
      (await api().post('/api/v1/safety/interactions').set(bearer(w.tokens.doctor)).send(pair))
        .status,
    ).toBe(403);
    const created = await api()
      .post('/api/v1/safety/interactions')
      .set(bearer(w.tokens.ministry))
      .send(pair);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ ingredientA: 'ondansetron', ingredientB: 'tramadol' });
    expect(
      (await api().post('/api/v1/safety/interactions').set(bearer(w.tokens.ministry)).send(pair))
        .status,
    ).toBe(409);

    // The new pair is used immediately.
    const p = await patient();
    await prescribe(p, 'Tramadol 50 mg');
    const alerts = alertsOf(await check(p, 'Ondansetron 4 mg'));
    expect(alerts.some((a) => a.code === 'INTERACTION:ondansetron+tramadol')).toBe(true);

    const off = await api()
      .patch(`/api/v1/safety/interactions/${created.body.id}`)
      .set(bearer(w.tokens.ministry))
      .send({ isActive: false });
    expect(off.body.isActive).toBe(false);
    const after = alertsOf(await check(p, 'Ondansetron 4 mg'));
    expect(after.some((a) => a.code === 'INTERACTION:ondansetron+tramadol')).toBe(false);

    const list = await api()
      .get('/api/v1/safety/interactions?q=warfarin')
      .set(bearer(w.tokens.doctor));
    expect(list.body.items.length).toBeGreaterThan(5);
    expect(list.body.canEdit).toBe(false);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'medication.interactions_changed'));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });
});
