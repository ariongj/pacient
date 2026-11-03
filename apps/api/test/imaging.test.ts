import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  careUnits,
  coverArrangements,
  imagingOrders,
  notifications,
  unitStaff,
} from '../src/db/schema.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let radiologist: { id: string; token: string };
let radiographer: { id: string; token: string };

const CT_SAFETY = { pregnancy: 'NO', contrast: false };

beforeAll(async () => {
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Radiology', code: 'RAD', type: 'RADIOLOGY' })
    .returning();
  const rad = await createUser('DOCTOR', w.facility.id, { specialty: 'Radiology' });
  const rgr = await createUser('NURSE', w.facility.id);
  await db.insert(unitStaff).values([
    { unitId: unit!.id, userId: rad.id },
    { unitId: unit!.id, userId: rgr.id },
  ]);
  radiologist = { id: rad.id, token: await login(rad.email) };
  radiographer = { id: rgr.id, token: await login(rgr.email) };
});

async function order(body: Record<string, unknown> = {}, token = w.tokens.doctor) {
  return api()
    .post('/api/v1/imaging/orders')
    .set(bearer(token))
    .send({
      patientId: w.patient.id,
      modality: 'CT',
      bodyPart: 'Head',
      clinicalQuestion: 'Headache after a fall – bleeding?',
      priority: 'ROUTINE',
      safetyChecks: CT_SAFETY,
      ...body,
    });
}

const step = (id: string, action: string, token: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/imaging/orders/${id}/${action}`).set(bearer(token)).send(body);

async function reported(critical = false) {
  const o = (await order()).body;
  expect((await step(o.id, 'perform', radiographer.token)).status).toBe(200);
  const r = await step(o.id, 'report', radiologist.token, {
    findings: 'No intracranial haemorrhage. Ventricles normal in size.',
    impression: critical ? 'Acute subdural haematoma' : 'Normal CT of the head',
    critical,
  });
  expect(r.status).toBe(200);
  return o as { id: string; accessionNumber: string };
}

const titles = async (userId: string) =>
  (await db.select().from(notifications).where(eq(notifications.userId, userId))).map(
    (n) => n.title,
  );

describe('ordering', () => {
  it('requires the safety screening that applies to the modality', async () => {
    // The world patient is a woman born in 1990 – pregnancy status is required for CT.
    const missing = await order({ safetyChecks: { contrast: false } });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toMatch(/Pregnancy status/);
    const contrast = await order({ safetyChecks: { pregnancy: 'NO', contrast: true } });
    expect(contrast.status).toBe(400);
    const mri = await order({ modality: 'MRI', safetyChecks: { contrast: false } });
    expect(mri.status).toBe(400);
    const pacemaker = await order({
      modality: 'MRI',
      safetyChecks: { contrast: false, implants: 'YES' },
    });
    expect(pacemaker.status).toBe(400);
    const ultrasound = await order({
      modality: 'ULTRASOUND',
      bodyPart: 'Abdomen',
      safetyChecks: {},
    });
    expect(ultrasound.status).toBe(201);
    const ok = await order();
    expect(ok.status).toBe(201);
    expect(ok.body.accessionNumber).toMatch(/^IMG\d{6}[0-9A-F]{6}$/);
    expect(ok.body.safetyChecks).toEqual(CT_SAFETY);
  });

  it('only lets doctors with a care relationship order', async () => {
    expect((await order({}, w.tokens.nurse)).status).toBe(403);
    expect((await order({}, w.tokens.outsideDoctor)).status).toBe(403);
  });

  it('alerts the radiology unit about STAT requests', async () => {
    expect((await order({ priority: 'STAT' })).status).toBe(201);
    expect(await titles(radiographer.id)).toContain('STAT imaging request – perform now');
  });
});

describe('radiology workflow', () => {
  it('shows the worklist only to radiology unit staff, STAT first', async () => {
    expect((await api().get('/api/v1/imaging/worklist').set(bearer(w.tokens.nurse))).status).toBe(
      403,
    );
    const list = await api().get('/api/v1/imaging/worklist').set(bearer(radiographer.token));
    expect(list.status).toBe(200);
    expect(list.body.items[0].priority).toBe('STAT');
    expect(list.body.isRadiologist).toBe(false);
  });

  it('lets the radiographer perform and only the radiologist report', async () => {
    const o = (await order()).body;
    expect(
      (await step(o.id, 'schedule', radiographer.token, { scheduledAt: new Date() })).status,
    ).toBe(200);
    expect(
      (
        await step(o.id, 'report', w.tokens.doctor, {
          findings: 'Findings text long enough',
          impression: 'Normal',
        })
      ).status,
    ).toBe(403);
    expect((await step(o.id, 'perform', w.tokens.nurse)).status).toBe(403);
    expect((await step(o.id, 'perform', radiographer.token)).status).toBe(200);
    expect(
      (
        await step(o.id, 'report', radiographer.token, {
          findings: 'Findings text long enough',
          impression: 'Normal',
        })
      ).status,
    ).toBe(403);
    const signed = await step(o.id, 'report', radiologist.token, {
      findings: 'No acute intracranial abnormality.',
      impression: 'Normal CT of the head',
    });
    expect(signed.status).toBe(200);
    expect(signed.body.status).toBe('REPORTED');
    expect(
      (
        await step(o.id, 'report', radiologist.token, {
          findings: 'Second attempt at a report',
          impression: 'Changed',
        })
      ).status,
    ).toBe(409);
  });

  it('keeps signed reports immutable in the database', async () => {
    const o = await reported();
    const err = await db
      .update(imagingOrders)
      .set({ impression: 'Edited' })
      .where(eq(imagingOrders.id, o.id))
      .catch((e: unknown) => e);
    expect(String((err as { cause?: Error }).cause?.message ?? err)).toMatch(/immutable/);
  });

  it('gives radiology staff record access only while the examination is open', async () => {
    const patient = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const o = (await order({ patientId: patient.id, modality: 'ULTRASOUND', safetyChecks: {} }))
      .body;
    const chart = () =>
      api().get(`/api/v1/patients/${patient.id}/summary`).set(bearer(radiographer.token));
    expect((await chart()).status).toBe(200);
    await step(o.id, 'perform', radiographer.token);
    await step(o.id, 'report', radiologist.token, {
      findings: 'Liver, gallbladder and kidneys unremarkable.',
      impression: 'Normal abdominal ultrasound',
    });
    expect((await chart()).status).toBe(403);
  });
});

describe('follow-up', () => {
  it('requires acknowledgement before release, and the patient sees only released reports', async () => {
    const o = await reported();
    const portal = async () =>
      (
        await api()
          .get(`/api/v1/imaging/patients/${w.patient.id}/orders`)
          .set(bearer(w.tokens.patient))
      ).body.items as { id: string; impression: string; safetyChecks?: unknown }[];
    expect((await portal()).some((x) => x.id === o.id)).toBe(false);
    expect((await step(o.id, 'release', w.tokens.doctor)).status).toBe(409);
    expect((await step(o.id, 'acknowledge', w.tokens.doctor)).status).toBe(200);
    expect((await step(o.id, 'acknowledge', w.tokens.doctor)).status).toBe(409);
    expect((await step(o.id, 'release', w.tokens.doctor)).status).toBe(200);
    const mine = (await portal()).find((x) => x.id === o.id)!;
    expect(mine.impression).toBe('Normal CT of the head');
    expect(mine.safetyChecks).toBeUndefined();
    expect(await titles(w.users.patientUser.id)).toContain('A new imaging report is available');
  });

  it('alerts the ordering doctor and their cover about critical findings', async () => {
    const coverer = await createUser('DOCTOR', w.facility.id);
    await db.insert(coverArrangements).values({
      doctorId: w.users.doctor.id,
      coverDoctorId: coverer.id,
      facilityId: w.facility.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 86_400_000),
      createdById: w.users.doctor.id,
    });
    const o = await reported(true);
    expect(await titles(w.users.doctor.id)).toContain('CRITICAL imaging finding – review now');
    expect(
      (await titles(coverer.id)).some((t) =>
        t.startsWith('CRITICAL imaging finding – review now (covering for'),
      ),
    ).toBe(true);
    // It is on the cover doctor's worklist as well as the orderer's, critical first.
    const coverList = await api()
      .get('/api/v1/worklist')
      .set(bearer(await login(coverer.email)));
    expect(coverList.body.imagingToReview[0]).toMatchObject({ id: o.id, critical: true });
    const mine = await api().get('/api/v1/worklist').set(bearer(w.tokens.doctor));
    expect(mine.body.imagingToReview.some((x: { id: string }) => x.id === o.id)).toBe(true);
    await step(o.id, 'acknowledge', w.tokens.doctor);
    const after = await api().get('/api/v1/worklist').set(bearer(w.tokens.doctor));
    expect(after.body.imagingToReview.some((x: { id: string }) => x.id === o.id)).toBe(false);
    await db.execute(sql`DELETE FROM cover_arrangements WHERE cover_doctor_id = ${coverer.id}`);
  });

  it('lets the orderer cancel only before the examination is performed', async () => {
    const o = (await order()).body;
    expect((await step(o.id, 'cancel', w.tokens.doctor, { reason: 'Ordered twice' })).status).toBe(
      200,
    );
    const done = await reported();
    expect(
      (await step(done.id, 'cancel', w.tokens.doctor, { reason: 'Too late now' })).status,
    ).toBe(409);
    const [row] = await db
      .select()
      .from(imagingOrders)
      .where(and(eq(imagingOrders.id, o.id), eq(imagingOrders.status, 'CANCELLED')));
    expect(row?.cancelReason).toBe('Ordered twice');
  });
});
