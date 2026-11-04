import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  allergies,
  auditLogs,
  beds,
  careUnits,
  downtimeExports,
  facilities,
  medicationAdministrations,
  notifications,
  prescriptions,
  vitalSigns,
} from '../src/db/schema.js';
import { openBuffer } from '../src/lib/secret-box.js';
import { setSyncKeysForTests } from '../src/modules/downtime/downtime.routes.js';
import {
  applyRetention,
  downtimeConfig,
  generateDowntimePacks,
  PACK_RETENTION,
} from '../src/modules/downtime/downtime.service.js';
import { dueTimes, frequencyHours } from '../src/modules/downtime/pack.js';
import { api, app, bearer, createWorld } from './helpers.js';

const execFileAsync = promisify(execFile);

let w: Awaited<ReturnType<typeof createWorld>>;
let dir: string;
let admissionId: string;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hasAge = spawnSync('age', ['--version']).status === 0;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'downtime-test-'));
  downtimeConfig.dir = dir;
  downtimeConfig.ageRecipient = undefined;
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Kirurgji B', code: 'KIR-B', type: 'GENERAL_WARD' })
    .returning();
  const [bed] = await db
    .insert(beds)
    .values({ unitId: unit!.id, label: 'B7', status: 'OCCUPIED' })
    .returning();
  const [adm] = await db
    .insert(admissions)
    .values({
      patientId: w.patient.id,
      facilityId: w.facility.id,
      unitId: unit!.id,
      bedId: bed!.id,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'ELECTIVE',
      reason: 'Observation',
      admittedAt: new Date(Date.now() - 2 * 86_400_000),
    })
    .returning();
  admissionId = adm!.id;
  await db.insert(allergies).values([
    {
      patientId: w.patient.id,
      substance: 'Penicillin',
      severity: 'SEVERE',
      verificationStatus: 'CONFIRMED',
      recordedById: w.users.doctor.id,
    },
    {
      patientId: w.patient.id,
      substance: 'Latex-refuted',
      severity: 'MILD',
      verificationStatus: 'REFUTED',
      recordedById: w.users.doctor.id,
    },
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await db.insert(prescriptions).values([
    {
      patientId: w.patient.id,
      doctorId: w.users.doctor.id,
      medication: 'Paracetamol',
      dosage: '1 g',
      doseAmount: '1000',
      doseUnit: 'mg',
      frequencyCode: 'Q4H',
      frequency: 'every 4 hours',
      route: 'oral',
      startDate: yesterday,
    },
    {
      patientId: w.patient.id,
      doctorId: w.users.doctor.id,
      medication: 'Enoxaparin',
      dosage: '40 mg',
      frequency: 'twice daily',
      route: 'subcutaneous',
      startDate: yesterday,
    },
    {
      patientId: w.patient.id,
      doctorId: w.users.doctor.id,
      medication: 'Morphine',
      dosage: '2 mg',
      frequency: 'as needed for pain',
      asNeeded: true,
      route: 'intravenous',
      startDate: today,
    },
    {
      patientId: w.patient.id,
      doctorId: w.users.doctor.id,
      medication: 'Stopped-drug',
      dosage: '5 mg',
      frequency: 'daily',
      startDate: yesterday,
      status: 'COMPLETED',
    },
  ]);
  await db.insert(vitalSigns).values({
    patientId: w.patient.id,
    recordedById: w.users.nurse.id,
    systolic: 128,
    diastolic: 82,
    heartRate: 88,
    respiratoryRate: 16,
    temperatureC: '37.4',
    oxygenSaturation: 97,
    recordedAt: new Date(Date.now() - 3_600_000),
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('schedule helpers', () => {
  it('maps structured and free-text frequencies to administration hours', () => {
    expect(frequencyHours('BID', null)).toEqual([8, 20]);
    expect(frequencyHours(null, 'twice daily')).toEqual([8, 20]);
    expect(frequencyHours(null, 'dy herë në ditë')).toEqual([8, 20]);
    expect(frequencyHours(null, 'svakih 8 sati')).toEqual([6, 14, 22]);
    expect(frequencyHours(null, 'as directed')).toBeNull();
  });

  it('lists due times within the next 12 hours', () => {
    const from = new Date('2026-03-10T06:30:00Z'); // 07:30 local
    expect(dueTimes([8, 20], from).map((d) => d.toISOString())).toEqual([
      '2026-03-10T07:00:00.000Z',
    ]);
    expect(dueTimes([0, 4, 8, 12, 16, 20], from)).toHaveLength(3);
    // Not before the prescription starts.
    expect(dueTimes([8, 20], from, 12, '2026-03-11')).toHaveLength(0);
  });
});

describe('downtime packs', () => {
  let packId: string;
  let html: string;

  it('generates an encrypted, self-contained pack with the ward content', async () => {
    const [pack] = await generateDowntimePacks(w.facility.id, new Date());
    expect(pack).toMatchObject({ kind: 'HTML_AES', patientCount: 1 });
    packId = pack!.id;
    const file = readFileSync(path.join(dir, pack!.fileName));
    expect(pack!.fileName).toMatch(new RegExp(`^${w.facility.code}/.+\\.html\\.enc$`));
    // Ciphertext on disk, never the names.
    expect(file.toString('latin1')).not.toContain(w.patient.lastName);
    const plain = openBuffer(file, 'downtime');
    expect(sha(plain)).toBe(pack!.sha256);
    expect(plain.length).toBe(pack!.sizeBytes);
    html = plain.toString('utf8');

    expect(html).toContain('<!doctype html>');
    expect(html).not.toMatch(/<script|<link |src=|https?:\/\//i);
    expect(html).toContain('Kirurgji B');
    expect(html).toContain('B7');
    expect(html).toContain(`${w.patient.firstName} ${w.patient.lastName}`);
    expect(html).toContain(w.patient.nationalId);
    expect(html).toContain('1990-01-01');
    expect(html).toContain(w.users.doctor.fullName);
    expect(html).toContain('Penicillin');
    expect(html).not.toContain('Latex-refuted');
    expect(html).toContain('Paracetamol');
    expect(html).toContain('1000 mg');
    expect(html).toContain('Enoxaparin');
    expect(html).toContain('Morphine');
    expect(html).not.toContain('Stopped-drug');
    expect(html).toContain('BP 128/82');
    expect(html).toContain('Emergency department');
    expect(html).toContain("Today&#39;s operating list");
  });

  it('shows next due times for 12 hours: 3 for every-4-hours, 1 for twice daily', () => {
    const li = (name: string) => html.split('<li>').find((l) => l.includes(name)) ?? '';
    const times = (s: string) => (/due: ([^<]*)/.exec(s)?.[1] ?? '').split(', ').filter(Boolean);
    expect(times(li('Paracetamol'))).toHaveLength(3);
    expect(times(li('Enoxaparin'))).toHaveLength(1);
    expect(li('Morphine')).toContain('as needed');
  });

  it('writes the pack in the director’s language unless another is chosen', async () => {
    const res = await api()
      .post('/api/v1/downtime/packs/generate')
      .set(bearer(w.tokens.director))
      .send({ locale: 'sq' });
    expect(res.status).toBe(201);
    const row = res.body.data[0];
    const plain = openBuffer(readFileSync(path.join(dir, row.fileName)), 'downtime').toString();
    expect(plain).toContain('<html lang="sq">');
    expect(plain).toContain('Alergjitë');
  });

  it('lets facility staff list and download packs; others are refused', async () => {
    for (const t of [w.tokens.director, w.tokens.doctor, w.tokens.nurse, w.tokens.reception]) {
      const res = await api().get('/api/v1/downtime/packs').set(bearer(t));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(2);
    }
    for (const t of [w.tokens.pharmacist, w.tokens.patient, w.tokens.ministry]) {
      expect((await api().get('/api/v1/downtime/packs').set(bearer(t))).status).toBe(403);
    }
    const other = await api().get('/api/v1/downtime/packs').set(bearer(w.tokens.otherDirector));
    expect(other.body.data).toHaveLength(0);
    expect(
      (await api().get(`/api/v1/downtime/packs/${packId}/download`).set(bearer(w.tokens.otherDirector)))
        .status,
    ).toBe(404);

    const dl = await api()
      .get(`/api/v1/downtime/packs/${packId}/download`)
      .set(bearer(w.tokens.nurse))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('text/html');
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['cache-control']).toBe('no-store');
    expect(sha(dl.body as Buffer)).toBe(sha(html));

    const [a] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'downtime.pack_downloaded'),
          eq(auditLogs.resourceId, packId),
          eq(auditLogs.actorUserId, w.users.nurse.id),
        ),
      );
    expect(a?.metadata).toMatchObject({ patientCount: 1, via: 'web' });
  });

  it('only directors generate packs on demand', async () => {
    for (const t of [w.tokens.doctor, w.tokens.nurse, w.tokens.reception]) {
      expect((await api().post('/api/v1/downtime/packs/generate').set(bearer(t))).status).toBe(403);
    }
    const audited = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'downtime.pack_generated'),
          eq(auditLogs.actorUserId, w.users.director.id),
        ),
      );
    expect(audited.length).toBeGreaterThanOrEqual(1);
    expect(audited[0]!.metadata).toMatchObject({ patientCount: 1, trigger: 'manual' });
  });

  it('detects a tampered pack file', async () => {
    const [row] = await db.select().from(downtimeExports).where(eq(downtimeExports.id, packId));
    const file = path.join(dir, row!.fileName);
    const original = readFileSync(file);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] ^= 0xff;
    writeFileSync(file, tampered);
    const res = await api()
      .get(`/api/v1/downtime/packs/${packId}/download`)
      .set(bearer(w.tokens.director));
    expect(res.status).toBe(500);
    writeFileSync(file, original);
  });

  it(`keeps only the newest ${PACK_RETENTION} packs and deletes older files`, async () => {
    const before = await db
      .select()
      .from(downtimeExports)
      .where(eq(downtimeExports.facilityId, w.facility.id));
    const fakes = Array.from({ length: PACK_RETENTION }, (_, i) => ({
      facilityId: w.facility.id,
      kind: 'HTML_AES',
      fileName: `${w.facility.code}/old-${i}.html.enc`,
      sha256: '0'.repeat(64),
      sizeBytes: 1,
      patientCount: 0,
      generatedAt: new Date(Date.now() - (i + 1) * 3_600_000 - 86_400_000),
    }));
    for (const f of fakes) writeFileSync(path.join(dir, f.fileName), 'x');
    await db.insert(downtimeExports).values(fakes);
    const removed = await applyRetention(w.facility.id);
    expect(removed).toBe(before.length);
    const after = await db
      .select()
      .from(downtimeExports)
      .where(eq(downtimeExports.facilityId, w.facility.id));
    expect(after).toHaveLength(PACK_RETENTION);
    // The real (newest) packs survive; the oldest fakes went, with their files.
    expect(after.map((r) => r.id)).toEqual(expect.arrayContaining(before.map((r) => r.id)));
    expect(existsSync(path.join(dir, `${w.facility.code}/old-${PACK_RETENTION - 1}.html.enc`))).toBe(
      false,
    );
    expect(existsSync(path.join(dir, `${w.facility.code}/old-0.html.enc`))).toBe(true);
  });

  it.skipIf(!hasAge)('also writes an age copy that only the offline key opens, served to sync keys', async () => {
    const keyFile = path.join(dir, 'ward-pc.key');
    execFileSync('age-keygen', ['-o', keyFile], { stdio: 'pipe' });
    const recipient = /public key: (age1[0-9a-z]+)/.exec(readFileSync(keyFile, 'utf8'))![1]!;
    downtimeConfig.ageRecipient = recipient;
    try {
      const packs = await generateDowntimePacks(w.facility.id, new Date());
      const age = packs.find((p) => p.kind === 'HTML_AGE')!;
      expect(age.fileName).toMatch(/\.html\.age$/);
      const plain = execFileSync('age', ['-d', '-i', keyFile, path.join(dir, age.fileName)]);
      expect(sha(plain)).toBe(age.sha256);

      // The web cannot open the age copy.
      expect(
        (await api().get(`/api/v1/downtime/packs/${age.id}/download`).set(bearer(w.tokens.director)))
          .status,
      ).toBe(409);

      const key = `dts_${randomBytes(24).toString('base64url')}`;
      setSyncKeysForTests(`${w.facility.code}:${sha(key)}`);
      expect((await api().get('/api/v1/downtime/sync/latest')).status).toBe(401);
      expect(
        (await api().get('/api/v1/downtime/sync/latest').set(bearer(`dts_${'x'.repeat(32)}`))).status,
      ).toBe(401);
      // A staff access token is not a sync key.
      expect((await api().get('/api/v1/downtime/sync/latest').set(bearer(w.tokens.director))).status).toBe(
        401,
      );
      const res = await api()
        .get('/api/v1/downtime/sync/latest')
        .set(bearer(key))
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      expect(res.status).toBe(200);
      expect(res.headers['x-pack-sha256']).toBe(age.sha256);
      expect((res.body as Buffer).subarray(0, 21).toString()).toBe('age-encryption.org/v1');

      // The ward PC script stores the encrypted copy and opens it with the offline key.
      const server = app.listen(0);
      try {
        const port = (server.address() as AddressInfo).port;
        const out = path.join(dir, 'ward-pc');
        const script = path.resolve(__dirname, '../../../scripts/downtime-sync.mjs');
        const envVars = {
          ...process.env,
          PACIENT_URL: `http://127.0.0.1:${port}`,
          DOWNTIME_SYNC_KEY: key,
          DOWNTIME_OUT_DIR: out,
        };
        await execFileAsync(process.execPath, [script, 'sync'], { env: envVars });
        const opened = await execFileAsync(
          process.execPath,
          [script, 'open', '--identity', keyFile],
          { env: envVars },
        );
        const htmlPath = opened.stdout.trim();
        expect(sha(readFileSync(htmlPath))).toBe(age.sha256);
        await execFileAsync(process.execPath, [script, 'check'], { env: envVars });
      } finally {
        server.close();
      }
    } finally {
      downtimeConfig.ageRecipient = undefined;
      setSyncKeysForTests(undefined);
    }
  });
});

describe('downtime mode', () => {
  it('only directors start and end downtime; staff see the status', async () => {
    for (const t of [w.tokens.doctor, w.tokens.nurse, w.tokens.reception]) {
      expect((await api().post('/api/v1/downtime/start').set(bearer(t)).send({})).status).toBe(403);
    }
    const idle = await api().get('/api/v1/downtime/status').set(bearer(w.tokens.pharmacist));
    expect(idle.status).toBe(200);
    expect(idle.body).toMatchObject({ active: false, since: null });
    expect(idle.body.latestPack).toBeTruthy();
    expect((await api().get('/api/v1/downtime/status').set(bearer(w.tokens.patient))).status).toBe(
      403,
    );

    const started = await api()
      .post('/api/v1/downtime/start')
      .set(bearer(w.tokens.director))
      .send({ note: 'Network maintenance 14:00–16:00' });
    expect(started.status).toBe(201);
    expect(started.body).toMatchObject({ active: true, note: 'Network maintenance 14:00–16:00' });
    expect(
      (await api().post('/api/v1/downtime/start').set(bearer(w.tokens.director)).send({})).status,
    ).toBe(409);

    const seen = await api().get('/api/v1/downtime/status').set(bearer(w.tokens.nurse));
    expect(seen.body.active).toBe(true);
    // Other facilities are unaffected.
    const other = await api().get('/api/v1/downtime/status').set(bearer(w.tokens.otherDirector));
    expect(other.body.active).toBe(false);
    // The API keeps working during downtime (indicator, not a block).
    expect((await api().get('/api/v1/downtime/packs').set(bearer(w.tokens.nurse))).status).toBe(200);

    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, w.users.nurse.id), eq(notifications.type, 'DOWNTIME')));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).not.toContain(w.patient.lastName);
  });

  it('back-entry checklist lists the ward’s patients with back-entered counts', async () => {
    const [rx] = await db
      .select()
      .from(prescriptions)
      .where(and(eq(prescriptions.patientId, w.patient.id), eq(prescriptions.medication, 'Paracetamol')));
    // Downtime began two hours ago; a paper dose given an hour ago is entered now.
    const since = new Date(Date.now() - 2 * 3_600_000);
    await db
      .update(facilities)
      .set({ downtimeSince: since })
      .where(eq(facilities.id, w.facility.id));
    const givenAt = new Date(since.getTime() + 3_600_000);
    await db.insert(medicationAdministrations).values({
      prescriptionId: rx!.id,
      patientId: w.patient.id,
      administeredById: w.users.nurse.id,
      status: 'GIVEN',
      administeredAt: givenAt,
      createdAt: new Date(),
      notes: 'Back-entered after downtime',
    });
    const res = await api().get('/api/v1/downtime/back-entry').set(bearer(w.tokens.nurse));
    expect(res.status).toBe(200);
    expect(res.body.window.active).toBe(true);
    const row = res.body.patients.find((p: { admissionId: string }) => p.admissionId === admissionId);
    expect(row).toMatchObject({ bed: 'B7', administrations: 1, administrationsBackEntered: 1 });
    expect((await api().get('/api/v1/downtime/back-entry').set(bearer(w.tokens.reception))).status).toBe(
      403,
    );
  });

  it('ends downtime, keeps the last window for back-entry and audits both', async () => {
    const ended = await api().post('/api/v1/downtime/end').set(bearer(w.tokens.director));
    expect(ended.status).toBe(200);
    expect(ended.body).toMatchObject({ active: false });
    expect(ended.body.lastWindow).toBeTruthy();
    expect((await api().post('/api/v1/downtime/end').set(bearer(w.tokens.director))).status).toBe(409);

    const checklist = await api().get('/api/v1/downtime/back-entry').set(bearer(w.tokens.doctor));
    expect(checklist.body.window).toMatchObject({ active: false });
    expect(checklist.body.patients.length).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceId, w.facility.id),
          inArray(auditLogs.action, ['downtime.started', 'downtime.ended']),
        ),
      );
    expect(rows.map((r) => r.action).sort()).toEqual(['downtime.ended', 'downtime.started']);
    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, w.users.doctor.id), eq(notifications.type, 'DOWNTIME')));
    expect(notes).toHaveLength(2);
  });
});
