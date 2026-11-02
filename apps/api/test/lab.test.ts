import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { labResults as labResultsTable } from '../src/db/schema.js';
import { field, parseHl7 } from '../src/lib/hl7.js';
import { buildOru } from '../src/ops/oru.js';
import { api, bearer, createPatient, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let labKey: string;
let otherLabKey: string;

beforeAll(async () => {
  w = await createWorld();
  const created = await api()
    .post('/api/v1/integrations/clients')
    .set(bearer(w.tokens.director))
    .send({ name: 'Central Laboratory LIS' });
  expect(created.status).toBe(201);
  labKey = created.body.apiKey;
  const other = await api()
    .post('/api/v1/integrations/clients')
    .set(bearer(w.tokens.otherDirector))
    .send({ name: 'Other Facility Lab' });
  otherLabKey = other.body.apiKey;
});

const lab = (key = labKey) => ({ Authorization: `Bearer ${key}` });
let seq = 0;
const controlId = () => `T${Date.now()}${seq++}`;

async function order(testCode = '718-7', patient = w.patient, priority = 'ROUTINE') {
  const res = await api()
    .post(`/api/v1/patients/${patient.id}/lab-orders`)
    .set(bearer(w.tokens.doctor))
    .send({ testCode, priority, clinicalNotes: 'Fatigue, check for anaemia' });
  expect(res.status).toBe(201);
  return res.body as { id: string; placerOrderNumber: string; status: string };
}

function oru(
  placer: string,
  obs: Partial<{ code: string; name: string; value: string; flag: string; status: string }> = {},
  patient: {
    nationalId: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
  } = w.patient,
  id = controlId(),
) {
  return buildOru({
    controlId: id,
    placerOrderNumber: placer,
    fillerOrderNumber: 'LAB-1',
    patient,
    observations: [
      {
        code: obs.code ?? '718-7',
        name: obs.name ?? 'Haemoglobin',
        value: obs.value ?? '135',
        unit: 'g/L',
        referenceRange: '120-160',
        flag: obs.flag ?? 'N',
        status: obs.status ?? 'F',
      },
    ],
  });
}

const postResult = (body: string, key = labKey) =>
  api()
    .post('/api/v1/integrations/lab/results')
    .set(lab(key))
    .set('Content-Type', 'application/hl7-v2')
    .send(body);

async function labResults(patientId = w.patient.id, token = w.tokens.doctor) {
  const res = await api().get(`/api/v1/patients/${patientId}/lab-results`).set(bearer(token));
  expect(res.status).toBe(200);
  return res.body.items as {
    id: string;
    testName: string;
    value: string;
    flag: string;
    status: string;
    source: string;
    orderId: string | null;
    previousValue: string | null;
  }[];
}

describe('lab orders', () => {
  it('offers a LOINC catalogue and lets the treating doctor order tests', async () => {
    const cat = await api().get('/api/v1/lab-catalog').set(bearer(w.tokens.doctor));
    expect(cat.body.items.find((t: { code: string }) => t.code === '718-7')).toMatchObject({
      name: expect.stringContaining('Haemoglobin'),
    });
    const o = await order();
    expect(o.placerOrderNumber).toMatch(/^PAC\d{6}[0-9A-F]{6}$/);
    expect(o.status).toBe('ORDERED');
    const list = await api()
      .get(`/api/v1/patients/${w.patient.id}/lab-orders`)
      .set(bearer(w.tokens.doctor));
    expect(list.status).toBe(200);
    expect(list.body.items.some((i: { id: string }) => i.id === o.id)).toBe(true);
  });

  it('only doctors with a care relationship can order', async () => {
    for (const token of [w.tokens.nurse, w.tokens.outsideDoctor, w.tokens.patient]) {
      const res = await api()
        .post(`/api/v1/patients/${w.patient.id}/lab-orders`)
        .set(bearer(token))
        .send({ testCode: '718-7', priority: 'ROUTINE' });
      expect(res.status).toBe(403);
    }
    const unknown = await api()
      .post(`/api/v1/patients/${w.patient.id}/lab-orders`)
      .set(bearer(w.tokens.doctor))
      .send({ testCode: '9999-9', priority: 'ROUTINE' });
    expect(unknown.status).toBe(400);
  });

  it('cancels an order until the laboratory starts processing it', async () => {
    const o = await order('2345-7');
    const cancel = await api()
      .post(`/api/v1/patients/${w.patient.id}/lab-orders/${o.id}/cancel`)
      .set(bearer(w.tokens.doctor));
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('CANCELLED');
    const receive = await api()
      .post(`/api/v1/integrations/lab/orders/${o.placerOrderNumber}/receive`)
      .set(lab());
    expect(receive.status).toBe(409);
  });
});

describe('laboratory API authentication', () => {
  it('requires a valid, active API key – staff tokens are not accepted', async () => {
    expect((await api().get('/api/v1/integrations/lab/orders')).status).toBe(401);
    expect(
      (await api().get('/api/v1/integrations/lab/orders').set(bearer(w.tokens.director))).status,
    ).toBe(401);
    expect(
      (await api().get('/api/v1/integrations/lab/orders').set(lab('pk_not-a-real-key'))).status,
    ).toBe(401);
    const ping = await api().get('/api/v1/integrations/lab/ping').set(lab());
    expect(ping.body).toMatchObject({ ok: true, laboratory: 'Central Laboratory LIS' });
  });

  it('lets directors manage only their own facility’s connections', async () => {
    const mine = await api().get('/api/v1/integrations/clients').set(bearer(w.tokens.director));
    expect(mine.body.items.map((c: { name: string }) => c.name)).toEqual([
      'Central Laboratory LIS',
    ]);
    expect(JSON.stringify(mine.body)).not.toContain(labKey);
    const theirs = mine.body.items[0].id as string;
    const revoke = await api()
      .post(`/api/v1/integrations/clients/${theirs}/revoke`)
      .set(bearer(w.tokens.otherDirector));
    expect(revoke.status).toBe(404);
    for (const token of [w.tokens.doctor, w.tokens.ministry]) {
      expect((await api().get('/api/v1/integrations/clients').set(bearer(token))).status).toBe(403);
    }
  });

  it('stops working immediately once revoked', async () => {
    const created = await api()
      .post('/api/v1/integrations/clients')
      .set(bearer(w.tokens.director))
      .send({ name: 'Temporary analyser' });
    expect(
      (await api().get('/api/v1/integrations/lab/ping').set(lab(created.body.apiKey))).status,
    ).toBe(200);
    await api()
      .post(`/api/v1/integrations/clients/${created.body.id}/revoke`)
      .set(bearer(w.tokens.director));
    expect(
      (await api().get('/api/v1/integrations/lab/ping').set(lab(created.body.apiKey))).status,
    ).toBe(401);
  });
});

describe('order pull and result ingestion (HL7 v2)', () => {
  it('lists new orders for the lab’s own facility only, as JSON or ORM^O01', async () => {
    const o = await order();
    const pulled = await api().get('/api/v1/integrations/lab/orders').set(lab());
    const item = pulled.body.items.find(
      (i: { placerOrderNumber: string }) => i.placerOrderNumber === o.placerOrderNumber,
    );
    expect(item).toMatchObject({
      test: { code: '718-7', system: 'http://loinc.org' },
      patient: { nationalId: w.patient.nationalId },
    });
    const other = await api().get('/api/v1/integrations/lab/orders').set(lab(otherLabKey));
    expect(JSON.stringify(other.body)).not.toContain(o.placerOrderNumber);

    const hl7 = await api().get('/api/v1/integrations/lab/orders?format=hl7').set(lab());
    expect(hl7.headers['content-type']).toContain('application/hl7-v2');
    const msg = hl7.text.split('\r\r').find((m) => m.includes(o.placerOrderNumber))!;
    const parsed = parseHl7(msg);
    expect(field(parsed.get('MSH')!, 9, 1)).toBe('ORM');
    expect(field(parsed.get('PID')!, 3, 1)).toBe(w.patient.nationalId);
    expect(field(parsed.get('ORC')!, 1)).toBe('NW');

    const received = await api()
      .post(`/api/v1/integrations/lab/orders/${o.placerOrderNumber}/receive`)
      .set(lab())
      .send({ fillerOrderNumber: 'LAB-77' });
    expect(received.body.status).toBe('RECEIVED');
    const again = await api().get('/api/v1/integrations/lab/orders').set(lab());
    expect(JSON.stringify(again.body)).not.toContain(o.placerOrderNumber);
  });

  it('files results, acknowledges with AA and puts them on the doctor’s worklist', async () => {
    const o = await order();
    const res = await postResult(oru(o.placerOrderNumber, { value: '98', flag: 'L' }));
    expect(res.status).toBe(200);
    expect(res.headers['x-pacient-status']).toBe('ACCEPTED');
    const ack = parseHl7(res.text);
    expect(field(ack.get('MSA')!, 1)).toBe('AA');

    const results = await labResults();
    const r = results.find((x) => x.orderId === o.id)!;
    expect(r).toMatchObject({ value: '98', flag: 'LOW', status: 'FINAL', source: 'LIS' });

    const orders = await api()
      .get(`/api/v1/patients/${w.patient.id}/lab-orders`)
      .set(bearer(w.tokens.doctor));
    expect(orders.body.items.find((i: { id: string }) => i.id === o.id).status).toBe('RESULTED');

    const worklist = await api().get('/api/v1/worklist').set(bearer(w.tokens.doctor));
    expect(worklist.body.unacknowledgedResults.some((x: { id: string }) => x.id === r.id)).toBe(
      true,
    );

    // The patient does not see it until a clinician has reviewed and released it.
    const portal = await labResults(w.patient.id, w.tokens.patient);
    expect(portal.some((x) => x.id === r.id)).toBe(false);
  });

  it('is idempotent: a retransmitted message is not filed twice', async () => {
    const o = await order();
    const id = controlId();
    const body = oru(o.placerOrderNumber, { value: '141' }, w.patient, id);
    expect((await postResult(body)).headers['x-pacient-status']).toBe('ACCEPTED');
    const dup = await postResult(body);
    expect(dup.status).toBe(200);
    expect(dup.headers['x-pacient-status']).toBe('DUPLICATE');
    expect(field(parseHl7(dup.text).get('MSA')!, 1)).toBe('AA');
    expect((await labResults()).filter((x) => x.orderId === o.id)).toHaveLength(1);
  });

  it('rejects malformed messages and unsupported message types with AR', async () => {
    const bad = await postResult('this is not HL7');
    expect(bad.status).toBe(422);
    expect(bad.headers['x-pacient-status']).toBe('REJECTED');
    const o = await order();
    const adt = oru(o.placerOrderNumber).replace('ORU^R01^ORU_R01', 'ADT^A01^ADT_A01');
    const res = await postResult(adt);
    expect(res.status).toBe(422);
    expect(field(parseHl7(res.text).get('MSA')!, 1)).toBe('AR');
  });

  it('alerts the ordering doctor about critical results', async () => {
    const o = await order('2823-3', w.patient, 'STAT');
    const res = await postResult(
      oru(o.placerOrderNumber, { code: '2823-3', name: 'Potassium', value: '6.8', flag: 'HH' }),
    );
    expect(res.headers['x-pacient-status']).toBe('ACCEPTED');
    expect((await labResults()).find((x) => x.orderId === o.id)?.flag).toBe('CRITICAL');
    const notes = await api().get('/api/v1/notifications').set(bearer(w.tokens.doctor));
    expect(
      notes.body.items.some((n: { title: string }) => n.title.startsWith('CRITICAL laboratory')),
    ).toBe(true);
    const worklist = await api().get('/api/v1/worklist').set(bearer(w.tokens.doctor));
    expect(worklist.body.unacknowledgedResults[0].flag).toBe('CRITICAL');
  });

  it('supersedes a result when the laboratory corrects it, and reopens review', async () => {
    const o = await order();
    await postResult(oru(o.placerOrderNumber, { value: '150', status: 'F' }));
    const first = (await labResults()).find((x) => x.orderId === o.id)!;
    const ack = await api()
      .post(`/api/v1/patients/${w.patient.id}/lab-results/${first.id}/acknowledge`)
      .set(bearer(w.tokens.doctor))
      .send({});
    expect(ack.status).toBe(200);

    const corrected = await postResult(
      oru(o.placerOrderNumber, { value: '105', flag: 'L', status: 'C' }),
    );
    expect(corrected.headers['x-pacient-status']).toBe('ACCEPTED');
    const current = (await labResults()).filter((x) => x.orderId === o.id);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ value: '105', status: 'CORRECTED', previousValue: '150' });

    const worklist = await api().get('/api/v1/worklist').set(bearer(w.tokens.doctor));
    const ids = worklist.body.unacknowledgedResults.map((x: { id: string }) => x.id);
    expect(ids).toContain(current[0]!.id);
    expect(ids).not.toContain(first.id);
    const notes = await api().get('/api/v1/notifications').set(bearer(w.tokens.doctor));
    expect(notes.body.items.some((n: { title: string }) => n.title.includes('corrected'))).toBe(
      true,
    );
  });

  it('never files results against the wrong patient: mismatches are held for review', async () => {
    const o = await order();
    const wrongPerson = { ...w.otherPatient };
    const res = await postResult(oru(o.placerOrderNumber, { value: '133' }, wrongPerson));
    expect(res.status).toBe(200);
    expect(res.headers['x-pacient-status']).toBe('NEEDS_REVIEW');
    expect((await labResults()).some((x) => x.orderId === o.id)).toBe(false);
    const anywhere = await db
      .select()
      .from(labResultsTable)
      .where(eq(labResultsTable.orderId, o.id));
    expect(anywhere).toHaveLength(0);

    const unknownOrder = await postResult(oru('PAC000000DEADBE', { value: '133' }));
    expect(unknownOrder.headers['x-pacient-status']).toBe('NEEDS_REVIEW');
  });
});

describe('review queue', () => {
  it('lets the director inspect, file to the right patient, or ignore held messages', async () => {
    const o = await order();
    const dob = { ...w.patient, dateOfBirth: '1990-01-02' }; // typo in date of birth at the lab
    const held = await postResult(oru(o.placerOrderNumber, { value: '127' }, dob));
    expect(held.headers['x-pacient-status']).toBe('NEEDS_REVIEW');

    const queue = await api()
      .get('/api/v1/integrations/messages?status=NEEDS_REVIEW')
      .set(bearer(w.tokens.director));
    expect(queue.status).toBe(200);
    expect(queue.body.counts.NEEDS_REVIEW).toBeGreaterThanOrEqual(1);
    const msg = queue.body.items[0];

    const other = await api()
      .get(`/api/v1/integrations/messages/${msg.id}`)
      .set(bearer(w.tokens.otherDirector));
    expect(other.status).toBe(404);

    const detail = await api()
      .get(`/api/v1/integrations/messages/${msg.id}`)
      .set(bearer(w.tokens.director));
    expect(detail.body.identifiers).toMatchObject({
      nationalId: w.patient.nationalId,
      dateOfBirth: '19900102',
      placerOrderNumber: o.placerOrderNumber,
    });
    expect(detail.body.rawSealed).toBeUndefined();
    expect(detail.body.candidates.map((c: { id: string }) => c.id)).toContain(w.patient.id);

    // Filing to a patient who is not on the order is refused.
    const wrong = await api()
      .post(`/api/v1/integrations/messages/${msg.id}/review`)
      .set(bearer(w.tokens.director))
      .send({ action: 'FILE', patientId: w.otherPatient.id, note: 'Trying the wrong patient' });
    expect(wrong.status).toBe(400);

    const filed = await api()
      .post(`/api/v1/integrations/messages/${msg.id}/review`)
      .set(bearer(w.tokens.director))
      .send({
        action: 'FILE',
        patientId: w.patient.id,
        note: 'Confirmed by phone: DOB typo at lab',
      });
    expect(filed.status).toBe(204);
    expect((await labResults()).find((x) => x.orderId === o.id)?.value).toBe('127');

    const twice = await api()
      .post(`/api/v1/integrations/messages/${msg.id}/review`)
      .set(bearer(w.tokens.director))
      .send({ action: 'IGNORE', note: 'Second attempt' });
    expect(twice.status).toBe(409);
  });

  it('can ignore a message that belongs to no one here', async () => {
    const stranger = await createPatient(w.otherFacility.id);
    const res = await postResult(oru('PAC000000ABCDEF', {}, stranger));
    expect(res.headers['x-pacient-status']).toBe('NEEDS_REVIEW');
    const queue = await api()
      .get('/api/v1/integrations/messages?status=NEEDS_REVIEW')
      .set(bearer(w.tokens.director));
    const msg = queue.body.items[0];
    const detail = await api()
      .get(`/api/v1/integrations/messages/${msg.id}`)
      .set(bearer(w.tokens.director));
    expect(detail.body.candidates).toEqual([]); // other facility's patient is not offered
    const ignored = await api()
      .post(`/api/v1/integrations/messages/${msg.id}/review`)
      .set(bearer(w.tokens.director))
      .send({ action: 'IGNORE', note: 'Sent to us in error by the lab' });
    expect(ignored.status).toBe(204);
    const after = await api()
      .get('/api/v1/integrations/messages?status=IGNORED')
      .set(bearer(w.tokens.director));
    expect(after.body.items.some((m: { id: string }) => m.id === msg.id)).toBe(true);
  });
});
