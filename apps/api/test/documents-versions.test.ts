import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { auditLogs, patientDocuments } from '../src/db/schema.js';
import { api, bearer, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let outsiderToken: string;

const pdf = (text: string) =>
  Buffer.from(`%PDF-1.4\n% ${text}\ntrailer<</Root 1 0 R>>\n%%EOF\n`, 'latin1');
const base = () => `/api/v1/patients/${w.patient.id}/documents`;

beforeAll(async () => {
  w = await createWorld();
  // A doctor at the same facility who is not on the patient's care team.
  const outsider = await createUser('DOCTOR', w.facility.id);
  outsiderToken = await login(outsider.email);
});

function send(
  path: string,
  token: string,
  body: Buffer,
  query: Record<string, string> = {},
  fileName = 'letter.pdf',
) {
  return api()
    .post(path)
    .query(query)
    .set(bearer(token))
    .set('Content-Type', 'application/pdf')
    .set('X-File-Name', fileName)
    .send(body);
}
const firstVersion = (title = 'Referral letter', visible = 'true') =>
  send(base(), w.tokens.doctor, pdf(`${title} v1`), {
    category: 'REFERRAL_LETTER',
    title,
    visibleToPatient: visible,
  });
const newVersion = (id: string, token: string, text: string, query: Record<string, string> = {}) =>
  send(`${base()}/${id}/versions`, token, pdf(text), query, 'letter-v2.pdf');
const content = (id: string, token: string) =>
  api()
    .get(`${base()}/${id}/content`)
    .set(bearer(token))
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });

describe('document versions', () => {
  it('a new version replaces the old one in the list; the history keeps both', async () => {
    const v1 = await firstVersion('Signed referral');
    expect(v1.status).toBe(201);
    expect(v1.body.version).toBe(1);

    const v2 = await newVersion(v1.body.id, w.tokens.doctor, 'Signed referral v2', {
      title: 'Signed referral (corrected)',
    });
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({
      version: 2,
      previousVersionId: v1.body.id,
      title: 'Signed referral (corrected)',
      category: 'REFERRAL_LETTER',
      visibleToPatient: true,
      status: 'CURRENT',
      supersededAt: null,
    });
    const old = (
      await db.select().from(patientDocuments).where(eq(patientDocuments.id, v1.body.id))
    )[0]!;
    expect(old.supersededAt).not.toBeNull();
    expect(old.status).toBe('CURRENT');

    const list = await api().get(base()).set(bearer(w.tokens.doctor));
    const chain = list.body.items.filter((d: { id: string }) =>
      [v1.body.id, v2.body.id].includes(d.id),
    );
    expect(chain.map((d: { id: string; version: number }) => [d.id, d.version])).toEqual([
      [v2.body.id, 2],
    ]);
    expect(chain[0].sha256).toBeUndefined();

    for (const id of [v1.body.id, v2.body.id]) {
      const history = await api().get(`${base()}/${id}/versions`).set(bearer(w.tokens.doctor));
      expect(history.status).toBe(200);
      expect(history.body.items.map((d: { id: string }) => d.id)).toEqual([v2.body.id, v1.body.id]);
    }
    // The old version stays readable, byte for byte.
    const oldContent = await content(v1.body.id, w.tokens.doctor);
    expect(Buffer.compare(oldContent.body as Buffer, pdf('Signed referral v1'))).toBe(0);

    // Shared with the patient: they see the latest in the list and both in the history.
    const mine = await api().get(base()).set(bearer(w.tokens.patient));
    expect(mine.body.items.some((d: { id: string }) => d.id === v2.body.id)).toBe(true);
    expect(mine.body.items.some((d: { id: string }) => d.id === v1.body.id)).toBe(false);
    const theirHistory = await api()
      .get(`${base()}/${v2.body.id}/versions`)
      .set(bearer(w.tokens.patient));
    expect(theirHistory.body.items).toHaveLength(2);

    const audited = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'document.version_added'), eq(auditLogs.resourceId, v2.body.id)),
      );
    expect(audited).toHaveLength(1);
    expect(audited[0]!.patientId).toBe(w.patient.id);
    expect(audited[0]!.metadata).toMatchObject({ previousVersionId: v1.body.id, version: 2 });
  });

  it('only the latest version can be replaced, and versions never fork', async () => {
    const v1 = await firstVersion('Lab report');
    const v2 = await newVersion(v1.body.id, w.tokens.doctor, 'Lab report v2');
    expect(v2.status).toBe(201);
    const again = await newVersion(v1.body.id, w.tokens.doctor, 'Lab report v2 bis');
    expect(again.status).toBe(409);

    // Two people replacing the same version at the same moment: exactly one succeeds.
    const results = await Promise.all([
      newVersion(v2.body.id, w.tokens.doctor, 'Lab report v3 a'),
      newVersion(v2.body.id, w.tokens.doctor, 'Lab report v3 b'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const third = await db
      .select()
      .from(patientDocuments)
      .where(eq(patientDocuments.previousVersionId, v2.body.id));
    expect(third).toHaveLength(1);
    // The database refuses a second successor outright.
    const [tmpl] = await db
      .select()
      .from(patientDocuments)
      .where(eq(patientDocuments.id, third[0]!.id));
    const { id: _id, ...copy } = tmpl!;
    await expect(db.insert(patientDocuments).values({ ...copy })).rejects.toThrow();

    // Sharing changes only on the latest version.
    const patchOld = await api()
      .patch(`${base()}/${v1.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ visibleToPatient: false });
    expect(patchOld.status).toBe(409);
  });

  it('who may add versions', async () => {
    const staffDoc = await firstVersion('Clinic letter', 'true');
    // The patient cannot replace a care-team document …
    expect((await newVersion(staffDoc.body.id, w.tokens.patient, 'patient edit')).status).toBe(403);
    // … a doctor outside the care team cannot either …
    expect((await newVersion(staffDoc.body.id, outsiderToken, 'outsider edit')).status).toBe(403);

    // … the patient replaces their own document, and the care team does not.
    const own = await send(base(), w.tokens.patient, pdf('Results from abroad'), {
      title: 'Results from abroad',
    });
    expect(own.status).toBe(201);
    expect(own.body.source).toBe('PATIENT');
    const ownV2 = await newVersion(own.body.id, w.tokens.patient, 'Results from abroad, full');
    expect(ownV2.status).toBe(201);
    expect(ownV2.body).toMatchObject({ source: 'PATIENT', category: 'PATIENT_PROVIDED' });
    expect((await newVersion(ownV2.body.id, w.tokens.doctor, 'doctor edit')).status).toBe(403);

    // Files are checked like any upload.
    const fake = await api()
      .post(`${base()}/${staffDoc.body.id}/versions`)
      .set(bearer(w.tokens.doctor))
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('MZ not a pdf'));
    expect(fake.status).toBe(415);
  });

  it('entered in error applies to one version', async () => {
    const v1 = await firstVersion('Discharge note');
    const v2 = await newVersion(v1.body.id, w.tokens.doctor, 'Discharge note v2');
    const markOld = await api()
      .post(`${base()}/${v1.body.id}/entered-in-error`)
      .set(bearer(w.tokens.doctor))
      .send({ reason: 'Scanned the wrong page' });
    expect(markOld.status).toBe(200);
    const latest = (
      await db.select().from(patientDocuments).where(eq(patientDocuments.id, v2.body.id))
    )[0]!;
    expect(latest.status).toBe('CURRENT');
    // The patient's history no longer shows the version in error.
    const theirs = await api()
      .get(`${base()}/${v2.body.id}/versions`)
      .set(bearer(w.tokens.patient));
    expect(theirs.body.items.map((d: { id: string }) => d.id)).toEqual([v2.body.id]);

    const markLatest = await api()
      .post(`${base()}/${v2.body.id}/entered-in-error`)
      .set(bearer(w.tokens.doctor))
      .send({ reason: 'Uploaded to the wrong patient' });
    expect(markLatest.status).toBe(200);
    // A version entered in error cannot be replaced; the patient no longer sees the document.
    expect((await newVersion(v2.body.id, w.tokens.doctor, 'v3')).status).toBe(409);
    const mine = await api().get(base()).set(bearer(w.tokens.patient));
    expect(mine.body.items.some((d: { id: string }) => d.id === v2.body.id)).toBe(false);
    const staff = await api().get(base()).set(bearer(w.tokens.doctor));
    expect(staff.body.items.find((d: { id: string }) => d.id === v2.body.id)).toMatchObject({
      status: 'ENTERED_IN_ERROR',
      version: 2,
    });
  });
});
