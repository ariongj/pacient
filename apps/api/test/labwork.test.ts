import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { auditLogs, labOrders, labResults, notifications } from '../src/db/schema.js';
import { flagFor, catalogByCode, parseRange } from '../src/modules/lab/catalog.js';
import { percentiles } from '../src/modules/lab/work.service.js';
import { api, bearer, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let tech: Awaited<ReturnType<typeof createUser>>;
let techToken: string;
let tech2Token: string;
let labDoctorToken: string;
let otherTechToken: string;
let itToken: string;

beforeAll(async () => {
  w = await createWorld();
  tech = await createUser('LAB_TECHNICIAN', w.facility.id);
  techToken = await login(tech.email);
  tech2Token = await login((await createUser('LAB_TECHNICIAN', w.facility.id)).email);
  labDoctorToken = await login(
    (await createUser('DOCTOR', w.facility.id, { specialty: 'Laboratory medicine' })).email,
  );
  otherTechToken = await login((await createUser('LAB_TECHNICIAN', w.otherFacility.id)).email);
  itToken = await login((await createUser('IT_SUPPORT', w.facility.id)).email);
});

async function order(testCode = '718-7', priority = 'ROUTINE') {
  const res = await api()
    .post(`/api/v1/patients/${w.patient.id}/lab-orders`)
    .set(bearer(w.tokens.doctor))
    .send({ testCode, priority, clinicalNotes: 'Fatigue' });
  expect(res.status).toBe(201);
  return res.body as { id: string; placerOrderNumber: string };
}

const post = (token: string, path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/lab-work${path}`).set(bearer(token)).send(body);

describe('flags for manual entry', () => {
  it('uses the reference range and the critical limits', () => {
    const hb = catalogByCode('718-7');
    expect(parseRange('120-160')).toEqual({ low: 120, high: 160 });
    expect(parseRange('<5')).toEqual({ high: 5 });
    expect(flagFor(hb, '135')).toBe('NORMAL');
    expect(flagFor(hb, '110')).toBe('LOW');
    expect(flagFor(hb, '170')).toBe('HIGH');
    expect(flagFor(hb, '65')).toBe('CRITICAL');
    expect(flagFor(hb, '135', true)).toBe('CRITICAL');
    expect(flagFor(hb, 'not done')).toBe('NORMAL');
    expect(percentiles([10, 20, 30, 40, 50])).toEqual({ median: 30, p90: 46 });
    expect(percentiles([])).toEqual({ median: null, p90: null });
  });
});

describe('worklist and specimen', () => {
  it('shows laboratory staff the order with identification only, and logs the view', async () => {
    const o = await order('2823-3', 'STAT');
    const list = await api().get('/api/v1/lab-work/worklist').set(bearer(techToken));
    expect(list.status).toBe(200);
    const row = list.body.items.find((i: { id: string }) => i.id === o.id);
    expect(row).toMatchObject({
      testCode: '2823-3',
      priority: 'STAT',
      status: 'ORDERED',
      patient: { nationalId: w.patient.nationalId, dateOfBirth: w.patient.dateOfBirth },
    });
    expect(list.body.items[0].priority).toBe('STAT');
    const logged = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.patientId, w.patient.id), eq(auditLogs.action, 'patient.record.viewed')),
      );
    expect(
      logged.some((l) => (l.metadata as { section?: string })?.section === 'lab-worklist'),
    ).toBe(true);
    // Other facility's laboratory, IT support, ordinary doctors, nurses and directors: no worklist.
    const other = await api().get('/api/v1/lab-work/worklist').set(bearer(otherTechToken));
    expect(other.body.items.find((i: { id: string }) => i.id === o.id)).toBeUndefined();
    for (const token of [itToken, w.tokens.doctor, w.tokens.nurse, w.tokens.director]) {
      expect((await api().get('/api/v1/lab-work/worklist').set(bearer(token))).status).toBe(403);
    }
    expect((await api().get('/api/v1/lab-work/worklist').set(bearer(labDoctorToken))).status).toBe(
      200,
    );
  });

  it('collects, receives with a matching barcode and rejects with a reason', async () => {
    const o = await order();
    expect((await post(techToken, `/orders/${o.id}/receive`, { barcode: 'WRONG-1' })).status).toBe(
      400,
    );
    const collected = await post(techToken, `/orders/${o.id}/collect`, {});
    expect(collected.body.barcode).toBe(o.placerOrderNumber);
    const received = await post(techToken, `/orders/${o.id}/receive`, {
      barcode: o.placerOrderNumber.toLowerCase(),
    });
    expect(received.status).toBe(200);
    expect(received.body.status).toBe('RECEIVED');
    expect(
      (await post(techToken, `/orders/${o.id}/receive`, { barcode: o.placerOrderNumber })).status,
    ).toBe(409);
    expect(
      (await post(otherTechToken, `/orders/${o.id}/reject`, { reason: 'HAEMOLYSED' })).status,
    ).toBe(404);
    expect((await post(techToken, `/orders/${o.id}/reject`, { reason: 'OTHER' })).status).toBe(400);
    const rejected = await post(techToken, `/orders/${o.id}/reject`, { reason: 'HAEMOLYSED' });
    expect(rejected.status).toBe(200);
    const [row] = await db.select().from(labOrders).where(eq(labOrders.id, o.id));
    expect(row).toMatchObject({ status: 'ORDERED', receivedAt: null });
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.doctor.id));
    const n = notes.find((x) => x.title.includes('rejected'));
    expect(n).toBeDefined();
    expect(n!.title).not.toContain(w.patient.lastName);
    expect(n!.title).not.toContain('Haemoglobin');
  });
});

describe('manual results with four eyes', () => {
  it('enters a preliminary result, refuses self-validation and finalises on validation', async () => {
    const o = await order('718-7');
    expect((await post(techToken, `/orders/${o.id}/result`, { value: '130' })).status).toBe(409);
    await post(techToken, `/orders/${o.id}/receive`, { barcode: o.placerOrderNumber });
    const first = await post(techToken, `/orders/${o.id}/result`, { value: '65' });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'PRELIMINARY', flag: 'CRITICAL' });
    // A correction before validation replaces the preliminary value.
    const entered = await post(techToken, `/orders/${o.id}/result`, { value: '118' });
    expect(entered.body.flag).toBe('LOW');
    const superseded = await db.select().from(labResults).where(eq(labResults.id, first.body.id));
    expect(superseded[0]!.supersededById).toBe(entered.body.id);

    // Preliminary results cannot be released to the patient.
    const release = await api()
      .post(`/api/v1/patients/${w.patient.id}/lab-results/${entered.body.id}/release`)
      .set(bearer(w.tokens.doctor));
    expect([404, 409]).toContain(release.status);

    const self = await post(techToken, `/results/${entered.body.id}/validate`);
    expect(self.status).toBe(403);
    const list = await api()
      .get('/api/v1/lab-work/worklist?view=validation')
      .set(bearer(tech2Token));
    const row = list.body.items.find((i: { id: string }) => i.id === o.id);
    expect(row.result).toMatchObject({ value: '118', canValidate: true, enteredById: tech.id });

    const validated = await post(tech2Token, `/results/${entered.body.id}/validate`);
    expect(validated.status).toBe(200);
    expect(validated.body.status).toBe('FINAL');
    expect((await post(tech2Token, `/results/${entered.body.id}/validate`)).status).toBe(409);
    const [ord] = await db.select().from(labOrders).where(eq(labOrders.id, o.id));
    expect(ord!.status).toBe('RESULTED');
    // The final result is the ordering doctor's to acknowledge.
    const [fin] = await db.select().from(labResults).where(eq(labResults.id, validated.body.id));
    expect(fin).toMatchObject({
      orderedById: w.users.doctor.id,
      acknowledgedAt: null,
      value: '118',
    });
    expect((await post(techToken, `/orders/${o.id}/result`, { value: '120' })).status).toBe(409);
  });

  it('alerts the ordering doctor as important for a critical validated result', async () => {
    const o = await order('2823-3');
    await post(techToken, `/orders/${o.id}/receive`, { barcode: o.placerOrderNumber });
    const r = await post(techToken, `/orders/${o.id}/result`, { value: '6.8' });
    expect(r.body.flag).toBe('CRITICAL');
    const v = await post(labDoctorToken, `/results/${r.body.id}/validate`);
    expect(v.status).toBe(200);
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.doctor.id));
    expect(notes.some((n) => n.title.startsWith('CRITICAL laboratory result'))).toBe(true);
  });

  it('refuses manual entry for orders handled by a laboratory system', async () => {
    const o = await order();
    const created = await api()
      .post('/api/v1/integrations/clients')
      .set(bearer(w.tokens.director))
      .send({ name: 'LIS for manual entry test' });
    await db
      .update(labOrders)
      .set({ labClientId: created.body.id ?? created.body.client?.id, status: 'RECEIVED' })
      .where(eq(labOrders.id, o.id));
    expect((await post(techToken, `/orders/${o.id}/result`, { value: '130' })).status).toBe(409);
  });
});

describe('statistics and labels', () => {
  it('gives the director turnaround times without patients, and prints labels for the lab', async () => {
    const stats = await api().get('/api/v1/lab-work/stats').set(bearer(w.tokens.director));
    expect(stats.status).toBe(200);
    const routine = stats.body.turnaround.find(
      (t: { priority: string }) => t.priority === 'ROUTINE',
    );
    expect(routine.count).toBeGreaterThan(0);
    expect(stats.body.rejections[0]).toMatchObject({ reason: 'HAEMOLYSED' });
    expect(JSON.stringify(stats.body)).not.toContain(w.patient.lastName);
    expect((await api().get('/api/v1/lab-work/stats').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
    expect((await api().get('/api/v1/lab-work/stats').set(bearer(itToken))).status).toBe(403);

    const o = await order();
    const label = await api().get(`/api/v1/lab-work/orders/${o.id}/label`).set(bearer(techToken));
    expect(label.status).toBe(200);
    expect(label.body).toMatchObject({ barcode: o.placerOrderNumber, testName: 'Haemoglobin' });
    expect(
      (await api().get(`/api/v1/lab-work/orders/${o.id}/label`).set(bearer(w.tokens.director)))
        .status,
    ).toBe(403);
  });
});

describe('new roles have no clinical record access', () => {
  it('refuses laboratory technicians and IT support everywhere in the record', async () => {
    const id = w.patient.id;
    for (const token of [techToken, itToken]) {
      const auth = bearer(token);
      expect((await api().get(`/api/v1/patients/${id}`).set(auth)).status).toBe(403);
      expect((await api().get(`/api/v1/patients/${id}/summary`).set(auth)).status).toBe(403);
      expect((await api().get(`/api/v1/patients/${id}/encounters`).set(auth)).status).toBe(403);
      expect((await api().get(`/api/v1/patients/${id}/lab-orders`).set(auth)).status).toBe(403);
      expect((await api().get(`/api/v1/patients/${id}/documents`).set(auth)).status).toBe(403);
      expect((await api().get('/api/v1/patients?search=Test').set(auth)).status).toBe(403);
      expect((await api().get(`/api/v1/fhir/Patient/${id}`).set(auth)).status).toBe(403);
      expect(
        (
          await api()
            .post(`/api/v1/patients/${id}/emergency-access`)
            .set(auth)
            .send({ reason: 'Unconscious patient, need allergies' })
        ).status,
      ).toBe(403);
      expect(
        (
          await api()
            .post(`/api/v1/patients/${id}/lab-orders`)
            .set(auth)
            .send({ testCode: '718-7' })
        ).status,
      ).toBe(403);
    }
  });
});
