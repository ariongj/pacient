import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careAssignments,
  documentContents,
  guardianships,
  patients,
} from '../src/db/schema.js';
import { setScannerForTests } from '../src/modules/documents/scanner.js';
import { api, bearer, createUser, createWorld, login, nextNationalId } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let child: typeof patients.$inferSelect;
let parentToken: string;
let limitedParentToken: string;

const SECRET_TEXT = 'Synthetic referral: knee pain, please assess';
const pdf = (text = SECRET_TEXT) =>
  Buffer.from(
    `%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${text}\ntrailer<</Root 1 0 R>>\n%%EOF\n`,
    'latin1',
  );
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('synthetic image'),
]);

beforeAll(async () => {
  w = await createWorld();
  child = (
    await db
      .insert(patients)
      .values({
        nationalId: nextNationalId(),
        firstName: 'Lea',
        lastName: 'Docs',
        dateOfBirth: '2016-05-10',
        sex: 'FEMALE',
        primaryFacilityId: w.facility.id,
      })
      .returning()
  )[0]!;
  await db.insert(careAssignments).values([
    { patientId: child.id, doctorId: w.users.doctor.id },
    // Nurses join the care team through the same assignment table.
    { patientId: w.patient.id, doctorId: w.users.nurse.id },
  ]);
  const parent = await createUser('PATIENT');
  const limitedParent = await createUser('PATIENT');
  const grant = {
    patientId: child.id,
    relationship: 'PARENT' as const,
    evidence: 'Birth certificate 1/2016',
    verifiedById: w.users.reception.id,
    validUntil: new Date('2034-05-10'),
  };
  await db.insert(guardianships).values([
    { ...grant, guardianUserId: parent.id, scope: 'FULL' },
    { ...grant, guardianUserId: limitedParent.id, scope: 'APPOINTMENTS' },
  ]);
  parentToken = await login(parent.email);
  limitedParentToken = await login(limitedParent.email);
});

afterEach(() => setScannerForTests(null));

const asGuardian = (token: string, patientId: string) => ({
  ...bearer(token),
  'X-Acting-For': patientId,
});

function upload(
  patientId: string,
  token: string | Record<string, string>,
  body: Buffer,
  query: Record<string, string> = { category: 'REFERRAL_LETTER', title: 'Referral letter' },
  type = 'application/pdf',
  fileName = 'referral letter.pdf',
) {
  return api()
    .post(`/api/v1/patients/${patientId}/documents`)
    .query(query)
    .set(typeof token === 'string' ? bearer(token) : token)
    .set('Content-Type', type)
    .set('X-File-Name', encodeURIComponent(fileName))
    .send(body);
}

const list = (patientId: string, headers: Record<string, string>) =>
  api().get(`/api/v1/patients/${patientId}/documents`).set(headers);

describe('uploading documents', () => {
  it('stores documents encrypted and returns the exact bytes to the care team', async () => {
    const res = await upload(w.patient.id, w.tokens.doctor, pdf());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      category: 'REFERRAL_LETTER',
      fileName: 'referral letter.pdf',
      mimeType: 'application/pdf',
      source: 'STAFF',
      visibleToPatient: false,
      scanStatus: 'NOT_SCANNED',
    });

    const [stored] = await db
      .select()
      .from(documentContents)
      .where(eq(documentContents.documentId, res.body.id));
    expect(stored!.content.includes(Buffer.from('knee pain'))).toBe(false);
    expect(stored!.content.includes(Buffer.from('%PDF'))).toBe(false);

    const content = await api()
      .get(`/api/v1/patients/${w.patient.id}/documents/${res.body.id}/content`)
      .set(bearer(w.tokens.doctor))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(content.status).toBe(200);
    expect(Buffer.compare(content.body as Buffer, pdf())).toBe(0);
    expect(content.headers['content-type']).toBe('application/pdf');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect(content.headers['content-security-policy']).toContain('sandbox');
    expect(content.headers['content-disposition']).toContain(
      "filename*=UTF-8''referral%20letter.pdf",
    );

    const viewed = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'document.viewed'), eq(auditLogs.resourceId, res.body.id)));
    expect(viewed).toHaveLength(1);
    expect(viewed[0]!.patientId).toBe(w.patient.id);
  });

  it('nurses on the care team can upload; everyone else is refused', async () => {
    expect((await upload(w.patient.id, w.tokens.nurse, pdf())).status).toBe(201);
    for (const token of [
      w.tokens.reception,
      w.tokens.pharmacist,
      w.tokens.outsideDoctor,
      w.tokens.director,
      w.tokens.ministry,
      w.tokens.otherPatient,
    ]) {
      expect((await upload(w.patient.id, token, pdf())).status).toBe(403);
      expect((await list(w.patient.id, bearer(token))).status).toBe(403);
    }
  });

  it('rejects files whose content does not match their type, and audits it', async () => {
    const fake = Buffer.from('MZ\x90\x00 this is an executable pretending to be a PDF', 'latin1');
    const res = await upload(w.patient.id, w.tokens.doctor, fake);
    expect(res.status).toBe(415);
    const pngAsPdf = await upload(w.patient.id, w.tokens.doctor, png);
    expect(pngAsPdf.status).toBe(415);
    const other = await upload(
      w.patient.id,
      w.tokens.doctor,
      Buffer.from('<html>'),
      undefined,
      'text/html',
    );
    expect(other.status).toBe(415);
    const rejected = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'document.rejected'), eq(auditLogs.patientId, w.patient.id)));
    expect(rejected.length).toBeGreaterThanOrEqual(2);
    expect(rejected[0]!.outcome).toBe('FAILURE');
  });

  it('refuses files over 10 MB', async () => {
    const big = Buffer.concat([pdf(), Buffer.alloc(10 * 1024 * 1024 + 10, 0x20)]);
    const res = await upload(w.patient.id, w.tokens.doctor, big);
    expect(res.status).toBe(413);
  });

  it('blocks files the malware scanner flags', async () => {
    setScannerForTests(async () => ({ clean: false, signature: 'Eicar-Test-Signature' }));
    const res = await upload(w.patient.id, w.tokens.doctor, pdf('EICAR'));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MALWARE_DETECTED');
    setScannerForTests(async () => ({ clean: true }));
    const ok = await upload(w.patient.id, w.tokens.doctor, pdf('clean'));
    expect(ok.status).toBe(201);
    expect(ok.body.scanStatus).toBe('CLEAN');
    setScannerForTests(async () => {
      throw new Error('clamd down');
    });
    expect((await upload(w.patient.id, w.tokens.doctor, pdf('x'))).status).toBe(503);
  });

  it('sanitises file names', async () => {
    const res = await upload(
      w.patient.id,
      w.tokens.doctor,
      png,
      { category: 'CLINICAL_PHOTO', title: 'Wound day 3' },
      'image/png',
      '../../etc/<passwd>.png',
    );
    expect(res.status).toBe(201);
    expect(res.body.fileName).toBe('passwd.png');
  });
});

describe('what patients and guardians see', () => {
  it('patients only see current documents shared with them', async () => {
    const hidden = await upload(w.patient.id, w.tokens.doctor, pdf('internal'), {
      category: 'DISCHARGE_SUMMARY',
      title: 'Internal discharge summary',
    });
    const shared = await upload(w.patient.id, w.tokens.doctor, pdf('shared'), {
      category: 'REFERRAL_LETTER',
      title: 'Shared referral',
      visibleToPatient: 'true',
    });
    const items = (await list(w.patient.id, bearer(w.tokens.patient))).body.items as {
      id: string;
    }[];
    const ids = items.map((d) => d.id);
    expect(ids).toContain(shared.body.id);
    expect(ids).not.toContain(hidden.body.id);
    expect(
      (
        await api()
          .get(`/api/v1/patients/${w.patient.id}/documents/${hidden.body.id}/content`)
          .set(bearer(w.tokens.patient))
      ).status,
    ).toBe(404);

    // Sharing later notifies the patient.
    const patch = await api()
      .patch(`/api/v1/patients/${w.patient.id}/documents/${hidden.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ visibleToPatient: true });
    expect(patch.status).toBe(200);
    const notes = await api().get('/api/v1/notifications').set(bearer(w.tokens.patient));
    expect(
      notes.body.items.some((n: { title: string }) => n.title.startsWith('A new document')),
    ).toBe(true);
    expect(
      (
        await api()
          .patch(`/api/v1/patients/${w.patient.id}/documents/${hidden.body.id}`)
          .set(bearer(w.tokens.nurse))
          .send({ visibleToPatient: false })
      ).status,
    ).toBe(403);

    // Entered in error: hidden from the patient, kept (flagged) for the care team.
    const err = await api()
      .post(`/api/v1/patients/${w.patient.id}/documents/${shared.body.id}/entered-in-error`)
      .set(bearer(w.tokens.doctor))
      .send({ reason: 'Uploaded to the wrong patient' });
    expect(err.status).toBe(200);
    const after = (await list(w.patient.id, bearer(w.tokens.patient))).body.items as {
      id: string;
    }[];
    expect(after.map((d) => d.id)).not.toContain(shared.body.id);
    const staff = (await list(w.patient.id, bearer(w.tokens.doctor))).body.items as {
      id: string;
      status: string;
      errorReason: string;
    }[];
    expect(staff.find((d) => d.id === shared.body.id)).toMatchObject({
      status: 'ENTERED_IN_ERROR',
      errorReason: 'Uploaded to the wrong patient',
    });
    expect(
      (
        await api()
          .post(`/api/v1/patients/${w.patient.id}/documents/${shared.body.id}/entered-in-error`)
          .set(bearer(w.tokens.doctor))
          .send({ reason: 'Second time' })
      ).status,
    ).toBe(409);
  });

  it('patient uploads are always "patient provided" and alert the care team', async () => {
    const res = await upload(w.patient.id, w.tokens.patient, pdf('results from abroad'), {
      category: 'DISCHARGE_SUMMARY',
      title: 'Blood test from Germany',
      visibleToPatient: 'false',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      category: 'PATIENT_PROVIDED',
      source: 'PATIENT',
      visibleToPatient: true,
      title: 'Blood test from Germany',
    });
    const notes = await api().get('/api/v1/notifications').set(bearer(w.tokens.doctor));
    expect(
      notes.body.items.some((n: { title: string }) => n.title.includes('patient added a document')),
    ).toBe(true);
    // Patient-provided documents cannot be hidden from the patient.
    const hide = await api()
      .patch(`/api/v1/patients/${w.patient.id}/documents/${res.body.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ visibleToPatient: false });
    expect(hide.status).toBe(400);
    // The patient can withdraw their own upload, but not a staff document.
    const own = await api()
      .post(`/api/v1/patients/${w.patient.id}/documents/${res.body.id}/entered-in-error`)
      .set(bearer(w.tokens.patient))
      .send({ reason: 'Wrong file, sorry' });
    expect(own.status).toBe(200);
  });

  it('guardians never see confidential documents; appointments-only guardians see none', async () => {
    const normal = await upload(child.id, w.tokens.doctor, pdf('vaccination letter'), {
      category: 'OTHER',
      title: 'School vaccination letter',
      visibleToPatient: 'true',
    });
    const confidential = await upload(child.id, w.tokens.doctor, pdf('confidential'), {
      category: 'OTHER',
      title: 'Confidential consultation letter',
      visibleToPatient: 'true',
      confidentialFromGuardians: 'true',
    });
    const res = await list(child.id, asGuardian(parentToken, child.id));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((d: { id: string }) => d.id);
    expect(ids).toContain(normal.body.id);
    expect(ids).not.toContain(confidential.body.id);
    expect(
      (
        await api()
          .get(`/api/v1/patients/${child.id}/documents/${confidential.body.id}/content`)
          .set(asGuardian(parentToken, child.id))
      ).status,
    ).toBe(404);
    expect((await list(child.id, asGuardian(limitedParentToken, child.id))).status).toBe(403);
    expect((await upload(child.id, asGuardian(limitedParentToken, child.id), pdf())).status).toBe(
      403,
    );

    // A guardian with full access can add a document for the child.
    const added = await upload(child.id, asGuardian(parentToken, child.id), pdf('school note'));
    expect(added.status).toBe(201);
    expect(added.body.category).toBe('PATIENT_PROVIDED');
  });
});

describe('FHIR', () => {
  it('exports documents as DocumentReference with a link to the content', async () => {
    const res = await api()
      .get(`/api/v1/fhir/Patient/${w.patient.id}/$everything`)
      .set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as {
      entry: { resource: { resourceType: string; status: string; content?: unknown[] } }[];
    };
    const docs = body.entry.filter((e) => e.resource.resourceType === 'DocumentReference');
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.some((d) => d.resource.status === 'entered-in-error')).toBe(true);
    expect(JSON.stringify(docs[0]!.resource.content)).toMatch(/\/documents\/.+\/content/);

    const portal = await api()
      .get(`/api/v1/fhir/Patient/${w.patient.id}/$everything`)
      .set(bearer(w.tokens.patient));
    const portalDocs = (JSON.parse(portal.text) as typeof body).entry.filter(
      (e) => e.resource.resourceType === 'DocumentReference',
    );
    expect(portalDocs.every((d) => d.resource.status === 'current')).toBe(true);
    expect(portalDocs.length).toBeLessThan(docs.length);
  });
});
