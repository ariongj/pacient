import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { auditLogs, careUnits, imagingOrders, unitStaff } from '../src/db/schema.js';
import { setPacsConfigForTests } from '../src/modules/pacs/index.js';
import { PNG_SIGNATURE } from '../src/modules/pacs/png.js';
import { api, bearer, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let radiologist: { id: string; token: string };
let radiographer: { id: string; token: string };

beforeAll(async () => {
  setPacsConfigForTests({ mode: 'demo' });
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

afterAll(() => setPacsConfigForTests({ mode: 'demo' }));

const step = (id: string, action: string, token: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/imaging/orders/${id}/${action}`).set(bearer(token)).send(body);

async function performedCt() {
  const res = await api()
    .post('/api/v1/imaging/orders')
    .set(bearer(w.tokens.doctor))
    .send({
      patientId: w.patient.id,
      modality: 'CT',
      bodyPart: 'Head',
      clinicalQuestion: 'Headache after a fall – bleeding?',
      priority: 'URGENT',
      safetyChecks: { pregnancy: 'NO', contrast: false },
    });
  expect(res.status).toBe(201);
  expect((await step(res.body.id, 'perform', radiographer.token)).status).toBe(200);
  return res.body as { id: string; accessionNumber: string };
}

const images = (id: string, token: string) =>
  api().get(`/api/v1/imaging/orders/${id}/images`).set(bearer(token));

describe('demo archive', () => {
  it('creates a study when the examination is performed and lists its images', async () => {
    const o = await performedCt();
    const [row] = await db.select().from(imagingOrders).where(eq(imagingOrders.id, o.id));
    expect(row!.studyInstanceUid).toMatch(/^2\.25\.\d+$/);
    expect(row!.imagesAvailableAt).toBeTruthy();

    const res = await images(o.id, w.tokens.doctor);
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('demo');
    expect(res.body.series.length).toBeGreaterThanOrEqual(1);
    expect(res.body.series[0].instances.length).toBeGreaterThanOrEqual(8);
    expect(res.body.presets.map((p: { key: string }) => p.key)).toContain('lung');

    const s = res.body.series[0];
    const img = await api()
      .get(`/api/v1/imaging/orders/${o.id}/images/${s.uid}/${s.instances[3].uid}/rendered`)
      .query({ window: 1500, level: -600 })
      .set(bearer(w.tokens.doctor))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');
    const body = img.body as Buffer;
    expect(body.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(body.readUInt32BE(16)).toBe(512); // IHDR width
    expect(body.readUInt32BE(20)).toBe(512);

    // An instance from another study is refused.
    const foreign = await api()
      .get(`/api/v1/imaging/orders/${o.id}/images/${s.uid}/1.2.3.4/rendered`)
      .set(bearer(w.tokens.doctor));
    expect(foreign.status).toBe(404);
  });

  it('limits viewing to the care team, radiology and – after release – the patient', async () => {
    const o = await performedCt();
    expect((await images(o.id, radiographer.token)).status).toBe(200);
    expect((await images(o.id, w.tokens.outsideDoctor)).status).toBe(403);
    expect((await images(o.id, w.tokens.reception)).status).toBe(403);
    expect((await images(o.id, w.tokens.patient)).status).toBe(403);

    expect(
      (
        await step(o.id, 'report', radiologist.token, {
          findings: 'No intracranial haemorrhage. Ventricles normal in size.',
          impression: 'Normal CT of the head',
          critical: false,
        })
      ).status,
    ).toBe(200);
    expect((await step(o.id, 'acknowledge', w.tokens.doctor)).status).toBe(200);
    expect((await images(o.id, w.tokens.patient)).status).toBe(403);
    expect((await step(o.id, 'release', w.tokens.doctor)).status).toBe(200);
    const patient = await images(o.id, w.tokens.patient);
    expect(patient.status).toBe(200);
    expect(patient.body.order.critical).toBeUndefined();
  });

  it('records one audit entry per viewer and examination within ten minutes', async () => {
    const o = await performedCt();
    await images(o.id, w.tokens.colleague).expect(403); // not on the care team
    for (let i = 0; i < 3; i++) await images(o.id, w.tokens.doctor).expect(200);
    const rows = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'imaging.images_viewed'),
          eq(auditLogs.resourceId, o.id),
          eq(auditLogs.actorUserId, w.users.doctor.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.patientId).toBe(w.patient.id);
  });

  it('lets only radiology staff link studies, after the examination', async () => {
    const res = await api().post('/api/v1/imaging/orders').set(bearer(w.tokens.doctor)).send({
      patientId: w.patient.id,
      modality: 'ULTRASOUND',
      bodyPart: 'Abdomen',
      clinicalQuestion: 'Right upper quadrant pain – gallstones?',
      priority: 'ROUTINE',
      safetyChecks: {},
    });
    const id = res.body.id as string;
    expect((await step(id, 'study/lookup', radiographer.token)).status).toBe(409);
    expect((await images(id, w.tokens.doctor)).status).toBe(404); // nothing linked yet
    await db.update(imagingOrders).set({ status: 'PERFORMED' }).where(eq(imagingOrders.id, id));
    expect((await step(id, 'study/lookup', w.tokens.doctor)).status).toBe(403);
    const bad = await step(id, 'study', radiographer.token, { studyInstanceUid: 'not-a-uid' });
    expect(bad.status).toBe(400);
    const linked = await step(id, 'study/lookup', radiographer.token);
    expect(linked.status).toBe(200);
    expect(linked.body.studyInstanceUid).toMatch(/^2\.25\./);
  });
});

describe('DICOMweb archive', () => {
  let server: Server;
  let base = '';
  const seenAuth: string[] = [];
  const json = (body: unknown) => JSON.stringify(body);

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenAuth.push(String(req.headers.authorization ?? ''));
      const url = new URL(req.url ?? '/', 'http://x');
      const p = url.pathname.replace(/^\/dicom-web/, '');
      res.setHeader('Content-Type', 'application/dicom+json');
      if (p === '/studies' && url.searchParams.get('AccessionNumber')) {
        res.end(json([{ '0020000D': { vr: 'UI', Value: ['1.2.840.99.1'] } }]));
      } else if (p === '/studies' && url.searchParams.get('StudyInstanceUID')) {
        res.end(
          url.searchParams.get('StudyInstanceUID') === '1.2.840.99.1'
            ? json([{ '0020000D': { vr: 'UI', Value: ['1.2.840.99.1'] } }])
            : '[]',
        );
      } else if (p === '/studies/1.2.840.99.1/series') {
        res.end(
          json([
            {
              '0020000E': { vr: 'UI', Value: ['1.2.840.99.1.5'] },
              '0008103E': { vr: 'LO', Value: ['Axial'] },
              '00080060': { vr: 'CS', Value: ['CT'] },
              '00200011': { vr: 'IS', Value: [5] },
            },
          ]),
        );
      } else if (p === '/studies/1.2.840.99.1/series/1.2.840.99.1.5/instances') {
        res.end(
          json([
            { '00080018': { vr: 'UI', Value: ['1.2.840.99.1.5.2'] }, '00200013': { Value: [2] } },
            { '00080018': { vr: 'UI', Value: ['1.2.840.99.1.5.1'] }, '00200013': { Value: [1] } },
          ]),
        );
      } else if (p.endsWith('/rendered')) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dicom-web`;
    setPacsConfigForTests({ mode: 'dicomweb', baseUrl: base, authHeader: 'Basic dGVzdDp0ZXN0' });
  });

  afterAll(async () => {
    setPacsConfigForTests({ mode: 'demo' });
    await new Promise((r) => server.close(r));
  });

  it('finds the study by accession number and passes rendered images through', async () => {
    const o = await performedCt();
    const [before] = await db.select().from(imagingOrders).where(eq(imagingOrders.id, o.id));
    expect(before!.studyInstanceUid).toBeNull(); // no automatic link outside demo mode
    const linked = await step(o.id, 'study/lookup', radiographer.token);
    expect(linked.status).toBe(200);
    expect(linked.body.studyInstanceUid).toBe('1.2.840.99.1');

    const list = await images(o.id, w.tokens.doctor);
    expect(list.status).toBe(200);
    expect(list.body.series[0].instances.map((i: { uid: string }) => i.uid)).toEqual([
      '1.2.840.99.1.5.1',
      '1.2.840.99.1.5.2',
    ]);
    const img = await api()
      .get(`/api/v1/imaging/orders/${o.id}/images/1.2.840.99.1.5/1.2.840.99.1.5.1/rendered`)
      .set(bearer(w.tokens.doctor));
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/jpeg');
    expect(seenAuth.every((a) => a === 'Basic dGVzdDp0ZXN0')).toBe(true);

    const unknown = await step(o.id, 'study', radiographer.token, { studyInstanceUid: '1.2.3' });
    expect(unknown.status).toBe(404);
  });

  it('answers 502 when the PACS cannot be reached', async () => {
    const o = await performedCt();
    setPacsConfigForTests({ baseUrl: 'http://127.0.0.1:9/dicom-web', timeoutMs: 1500 });
    const res = await step(o.id, 'study/lookup', radiographer.token);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PACS_UNAVAILABLE');
    setPacsConfigForTests({ baseUrl: base });
  });
});
