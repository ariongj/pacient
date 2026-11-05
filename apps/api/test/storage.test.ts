import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { documentContents, patientDocuments } from '../src/db/schema.js';
import { migrateDocumentsToS3 } from '../src/db/migrate-documents-to-s3.js';
import { S3Client, signV4 } from '../src/modules/storage/s3.js';
import {
  documentKey,
  s3Store,
  setStorageForTests,
  type ObjectStore,
} from '../src/modules/storage/storage.js';
import { api, bearer, createWorld } from './helpers.js';

/* ----------------------------------------------------------------------------------------------
 * A tiny S3-compatible server for the tests. It stores objects in memory and RECOMPUTES every
 * request's Signature Version 4 independently of the client, rejecting unsigned payloads, a wrong
 * payload hash, a stale date or a bad signature (403, like S3).
 * -------------------------------------------------------------------------------------------- */
const ACCESS_KEY = 'TESTACCESSKEY';
const SECRET = 'test/secret+key=with/odd chars';
const REGION = 'eu-central-1';
const BUCKET = 'pacient-documents';

const hex = (d: Buffer | string) => createHash('sha256').update(d).digest('hex');
const mac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();

function checkSignature(req: IncomingMessage, body: Buffer): string | null {
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(
      req.headers.authorization ?? '',
    );
  if (!m) return 'malformed authorization';
  const [, akid, day, region, signedHeaders, signature] = m;
  if (akid !== ACCESS_KEY) return 'unknown access key';
  const payloadHash = String(req.headers['x-amz-content-sha256'] ?? '');
  if (payloadHash === 'UNSIGNED-PAYLOAD') return 'unsigned payload refused';
  if (payloadHash !== hex(body)) return 'payload hash mismatch';
  const stamp = String(req.headers['x-amz-date'] ?? '');
  const when = Date.parse(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`,
  );
  if (!Number.isFinite(when) || Math.abs(Date.now() - when) > 15 * 60_000) return 'stale date';
  if (stamp.slice(0, 8) !== day) return 'scope date mismatch';
  const names = signedHeaders!.split(';');
  for (const required of ['host', 'x-amz-content-sha256', 'x-amz-date']) {
    if (!names.includes(required)) return `${required} not signed`;
  }
  const canonicalHeaders = names
    .map((n) => `${n}:${String(req.headers[n] ?? '').trim()}\n`)
    .join('');
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  const canonical = [req.method, path, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, `${day}/${region}/s3/aws4_request`, hex(canonical)];
  const key = mac(mac(mac(mac(`AWS4${SECRET}`, day!), region!), 's3'), 'aws4_request');
  const expected = createHmac('sha256', key).update(toSign.join('\n')).digest();
  const given = Buffer.from(signature!, 'hex');
  return timingSafeEqual(expected, given) ? null : 'signature mismatch';
}

const objects = new Map<string, Buffer>();
const seen: { method: string; path: string; sse?: string }[] = [];
let server: Server;
let endpoint = '';

function fakeS3() {
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const problem = checkSignature(req, body);
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      seen.push({
        method: req.method ?? '',
        path,
        sse: req.headers['x-amz-server-side-encryption'] as string | undefined,
      });
      if (problem) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end(`<Error><Code>SignatureDoesNotMatch</Code><Message>${problem}</Message></Error>`);
        return;
      }
      if (!path.startsWith(`/${BUCKET}/`)) {
        res.writeHead(404).end('<Error><Code>NoSuchBucket</Code></Error>');
        return;
      }
      const key = path.slice(BUCKET.length + 2);
      if (req.method === 'PUT') {
        objects.set(key, body);
        res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` }).end();
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        const obj = objects.get(key);
        if (!obj) {
          res
            .writeHead(404)
            .end(req.method === 'GET' ? '<Error><Code>NoSuchKey</Code></Error>' : '');
          return;
        }
        res.writeHead(200, { 'content-length': String(obj.length) });
        res.end(req.method === 'GET' ? obj : undefined);
      } else {
        res.writeHead(405).end();
      }
    });
  });
}

const client = (over: Partial<ConstructorParameters<typeof S3Client>[0]> = {}) =>
  new S3Client({
    endpoint,
    region: REGION,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    forcePathStyle: true,
    timeoutMs: 3000,
    ...over,
  });

let w: Awaited<ReturnType<typeof createWorld>>;
let store: ObjectStore;

beforeAll(async () => {
  server = fakeS3();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  store = s3Store(client());
  w = await createWorld();
});
afterAll(async () => {
  setStorageForTests(null);
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => setStorageForTests(null));

const SECRET_TEXT = 'Synthetic discharge letter: appendicitis';
const pdf = (text = SECRET_TEXT) =>
  Buffer.from(`%PDF-1.4\n% ${text}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1');

function upload(body: Buffer, title = 'Discharge letter') {
  return api()
    .post(`/api/v1/patients/${w.patient.id}/documents`)
    .query({ category: 'DISCHARGE_SUMMARY', title })
    .set(bearer(w.tokens.doctor))
    .set('Content-Type', 'application/pdf')
    .set('X-File-Name', 'letter.pdf')
    .send(body);
}
function download(id: string) {
  return api()
    .get(`/api/v1/patients/${w.patient.id}/documents/${id}/content`)
    .set(bearer(w.tokens.doctor))
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}
const rowOf = async (id: string) =>
  (await db.select().from(patientDocuments).where(eq(patientDocuments.id, id)))[0]!;

describe('Signature Version 4', () => {
  it('matches the AWS documentation example (GET object with a range)', () => {
    const headers = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9' },
      payloadHash: hex(''),
      region: 'us-east-1',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: new Date('2013-05-24T00:00:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('builds path-style and virtual-hosted URLs', () => {
    const key = 'documents/2026/11/0c2f6b8e-0000-4000-8000-000000000001';
    expect(
      client({ endpoint: 'http://minio:9000', forcePathStyle: true }).objectUrl(key).href,
    ).toBe(`http://minio:9000/${BUCKET}/${key}`);
    expect(
      client({
        endpoint: 'https://s3.eu-central-1.amazonaws.com',
        forcePathStyle: false,
      }).objectUrl(key).href,
    ).toBe(`https://${BUCKET}.s3.eu-central-1.amazonaws.com/${key}`);
    // Unusual characters are percent-encoded once, as SigV4 expects.
    expect(client().objectUrl('a b/ü+c').pathname).toBe(`/${BUCKET}/a%20b/%C3%BC%2Bc`);
  });

  it('round-trips objects through the verifying server, with optional SSE', async () => {
    const c = client({ serverSideEncryption: 'AES256' });
    await c.putObject('t/one', Buffer.from('ciphertext bytes'));
    expect(seen.at(-1)).toMatchObject({ method: 'PUT', sse: 'AES256' });
    expect((await c.getObject('t/one'))!.toString()).toBe('ciphertext bytes');
    expect(await c.headObject('t/one')).toEqual({ size: 16 });
    expect(await c.getObject('t/missing')).toBeNull();
    expect(await c.headObject('t/missing')).toBeNull();
    // Encoded keys are signed correctly too.
    await c.putObject('t/a b+ü', Buffer.from('x'));
    expect((await c.getObject('t/a b+ü'))!.toString()).toBe('x');
  });

  it('the server rejects a wrong secret, and the client reports it', async () => {
    await expect(
      client({ secretAccessKey: 'wrong' }).putObject('t/x', Buffer.from('x')),
    ).rejects.toMatchObject({ status: 403, code: 'SignatureDoesNotMatch' });
  });
});

describe('documents in object storage', () => {
  it('stores only ciphertext under an anonymous key and serves the exact bytes', async () => {
    setStorageForTests({ backend: 'S3', store });
    const res = await upload(pdf());
    expect(res.status).toBe(201);
    expect(res.body.storageKey).toBeUndefined();
    expect(res.body.storageBackend).toBeUndefined();
    const row = await rowOf(res.body.id);
    expect(row.storageBackend).toBe('S3');
    expect(row.storageKey).toBe(documentKey(row.id, row.createdAt));
    expect(row.storageKey).toMatch(/^documents\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    expect(row.storageKey).not.toContain(w.patient.id);
    expect(row.storageKey).not.toContain(w.patient.nationalId);
    // Nothing in the database copy table; the object holds ciphertext only.
    expect(
      await db.select().from(documentContents).where(eq(documentContents.documentId, row.id)),
    ).toHaveLength(0);
    const object = objects.get(row.storageKey!)!;
    expect(object.includes(Buffer.from('appendicitis'))).toBe(false);
    expect(object.includes(Buffer.from('%PDF'))).toBe(false);
    const got = await download(row.id);
    expect(got.status).toBe(200);
    expect(Buffer.compare(got.body as Buffer, pdf())).toBe(0);
  });

  it('reads database and object-storage documents side by side', async () => {
    const dbDoc = await upload(pdf('stored in the database'), 'DB letter');
    expect((await rowOf(dbDoc.body.id)).storageBackend).toBe('DB');
    setStorageForTests({ backend: 'S3', store });
    const s3Doc = await upload(pdf('stored in S3'), 'S3 letter');
    expect((await rowOf(s3Doc.body.id)).storageBackend).toBe('S3');
    for (const [id, text] of [
      [dbDoc.body.id, 'stored in the database'],
      [s3Doc.body.id, 'stored in S3'],
    ] as const) {
      const got = await download(id);
      expect(got.status).toBe(200);
      expect(Buffer.compare(got.body as Buffer, pdf(text))).toBe(0);
    }
  });

  it('never serves a tampered or missing object, and reports an outage as 503', async () => {
    setStorageForTests({ backend: 'S3', store });
    const res = await upload(pdf('tamper target'));
    const row = await rowOf(res.body.id);
    const original = objects.get(row.storageKey!)!;

    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    objects.set(row.storageKey!, tampered);
    const bad = await download(row.id);
    expect(bad.status).toBe(500);

    // Swapping in another document's (valid) ciphertext is caught by the hash check.
    const other = await upload(pdf('another document'));
    objects.set(row.storageKey!, objects.get((await rowOf(other.body.id)).storageKey!)!);
    expect((await download(row.id)).status).toBe(500);

    objects.delete(row.storageKey!);
    expect((await download(row.id)).status).toBe(500);

    objects.set(row.storageKey!, original);
    expect((await download(row.id)).status).toBe(200);

    // Unreachable store: reads and uploads answer 503 and nothing is recorded.
    const down = s3Store(client({ endpoint: 'http://127.0.0.1:1' }));
    setStorageForTests({ backend: 'S3', store: down });
    expect((await download(row.id)).status).toBe(503);
    const before = (await db.select().from(patientDocuments)).length;
    const failed = await upload(pdf('during an outage'));
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('STORAGE_UNAVAILABLE');
    expect((await db.select().from(patientDocuments)).length).toBe(before);
  });
});

describe('migrating database documents to object storage', () => {
  it('moves, verifies, is idempotent and keeps database copies unless asked', async () => {
    // New uploads on the database backend; reads of migrated ones go to the test store.
    setStorageForTests({ backend: 'DB', store });
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push((await upload(pdf(`to migrate ${n}`), `Old ${n}`)).body.id);
    const log: string[] = [];

    // A store that corrupts one upload: that document must stay on the database backend.
    let corruptNext = true;
    const flaky: ObjectStore = {
      ...store,
      put: async (key, bytes) => {
        if (corruptNext && key.endsWith(ids[1]!)) {
          corruptNext = false;
          return store.put(key, Buffer.concat([bytes, Buffer.from('!')]));
        }
        return store.put(key, bytes);
      },
    };
    const first = await migrateDocumentsToS3({
      store: flaky,
      batchSize: 2,
      log: (l) => log.push(l),
    });
    expect(first.failed.map((f) => f.documentId)).toContain(ids[1]);
    expect((await rowOf(ids[0]!)).storageBackend).toBe('S3');
    expect((await rowOf(ids[1]!)).storageBackend).toBe('DB');
    expect((await rowOf(ids[2]!)).storageBackend).toBe('S3');
    // Database copies kept by default.
    expect(
      await db.select().from(documentContents).where(inArray(documentContents.documentId, ids)),
    ).toHaveLength(3);
    for (const id of ids) expect((await download(id)).status).toBe(200);

    // Re-run: only the failed one is left to move.
    const second = await migrateDocumentsToS3({ store, log: () => undefined });
    expect(second.failed).toHaveLength(0);
    expect((await rowOf(ids[1]!)).storageBackend).toBe('S3');
    expect(second.remaining).toBe(0);

    // Dry run changes nothing.
    const dry = await migrateDocumentsToS3({ store, dryRun: true, log: () => undefined });
    expect(dry.migrated).toBe(0);

    // Deleting database copies re-verifies each object first; a broken object keeps its copy.
    const broken = (await rowOf(ids[2]!)).storageKey!;
    const good = objects.get(broken)!;
    objects.set(broken, Buffer.from('not the document'));
    const cleanup = await migrateDocumentsToS3({
      store,
      deleteDbCopies: true,
      log: () => undefined,
    });
    expect(cleanup.failed.map((f) => f.documentId)).toEqual([ids[2]]);
    const left = await db
      .select({ id: documentContents.documentId })
      .from(documentContents)
      .where(inArray(documentContents.documentId, ids));
    expect(left.map((r) => r.id)).toEqual([ids[2]]);
    objects.set(broken, good);
    await migrateDocumentsToS3({ store, deleteDbCopies: true, log: () => undefined });
    expect(
      await db.select().from(documentContents).where(inArray(documentContents.documentId, ids)),
    ).toHaveLength(0);
    // Still readable, now from object storage only.
    for (const id of ids) expect((await download(id)).status).toBe(200);
  });
});
