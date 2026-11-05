import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  auditLogs,
  births,
  careAssignments,
  careUnits,
  imagingOrders,
  patients,
} from '../src/db/schema.js';
import { partnerOperations } from '../src/openapi/spec.js';
import { api, bearer, createWorld, nextNationalId } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const keys: Record<'hif' | 'civil' | 'dir', { id: string; apiKey: string }> = {} as never;

const key = (k: string) => ({ Authorization: `Bearer ${k}` });
const treatment = {
  'X-Purpose-Of-Use': 'TREATMENT',
  'X-Requesting-Practitioner': 'Dr. Test Partner (lic. 123)',
};
const fhirJson = (res: { text: string }) =>
  JSON.parse(res.text) as { total: number; entry: { resource: Record<string, unknown> }[] };
const types = (bundle: ReturnType<typeof fhirJson>) =>
  bundle.entry.map((e) => e.resource.resourceType);

async function createClient(name: string, scopes: string[]) {
  const res = await api()
    .post('/api/v1/partner/clients')
    .set(bearer(w.tokens.ministry))
    .send({ name, organisation: `${name} organisation`, scopes });
  expect(res.status).toBe(201);
  expect(res.body.apiKey).toMatch(/^pk_/);
  return { id: res.body.id as string, apiKey: res.body.apiKey as string };
}

async function partnerAudits(clientId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, 'partner.api.access'),
        sql`${auditLogs.metadata}->>'clientId' = ${clientId}`,
      ),
    );
}

let releasedLabId: string;
let unreleasedLabId: string;

beforeAll(async () => {
  w = await createWorld();
  keys.hif = await createClient('Insurance fund', ['fhir.patient.read', 'stats.read']);
  keys.civil = await createClient('Civil registry', ['births.notify']);
  keys.dir = await createClient('Public health', ['directory.read']);

  const base = `/api/v1/patients/${w.patient.id}`;
  const doc = bearer(w.tokens.doctor);
  await api()
    .post(`${base}/diagnoses`)
    .set(doc)
    .send({ icd10Code: 'I10', description: 'Hypertension' });
  const released = await api()
    .post(`${base}/lab-results`)
    .set(doc)
    .send({ testName: 'HbA1c', value: '6.1' });
  await api().post(`${base}/lab-results/${released.body.id}/acknowledge`).set(doc).expect(200);
  await api().post(`${base}/lab-results/${released.body.id}/release`).set(doc).expect(200);
  releasedLabId = released.body.id;
  const unreleased = await api()
    .post(`${base}/lab-results`)
    .set(doc)
    .send({ testName: 'Potassium', value: '4.2' });
  unreleasedLabId = unreleased.body.id;
  // A confidential visit with a diagnosis: never shared with partners.
  const enc = await api()
    .post(`${base}/encounters`)
    .set(doc)
    .send({ type: 'OUTPATIENT', reason: 'Confidential consultation' });
  await api().post(`${base}/diagnoses`).set(doc).send({
    encounterId: enc.body.id,
    icd10Code: 'Z30.0',
    description: 'Contraceptive counselling',
  });
  await api()
    .post(`${base}/encounters/${enc.body.id}/confidentiality`)
    .set(doc)
    .send({ confidential: true })
    .expect(200);
});

describe('partner API keys', () => {
  it('requires a valid, active key and reports its scopes', async () => {
    expect((await api().get('/api/v1/partner/ping')).status).toBe(401);
    expect((await api().get('/api/v1/partner/ping').set(key('pk_unknown'))).status).toBe(401);
    // A staff session is not a partner key.
    expect((await api().get('/api/v1/partner/ping').set(bearer(w.tokens.doctor))).status).toBe(401);
    const ok = await api().get('/api/v1/partner/ping').set(key(keys.hif.apiKey));
    expect(ok.body).toMatchObject({ ok: true, scopes: ['fhir.patient.read', 'stats.read'] });
  });

  it('refuses (and audits) calls outside the granted scopes', async () => {
    const res = await api()
      .get('/api/v1/partner/fhir/Patient')
      .query({ identifier: w.patient.nationalId })
      .set(key(keys.dir.apiKey))
      .set(treatment);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SCOPE_REQUIRED');
    const audits = await partnerAudits(keys.dir.id);
    expect(
      audits.some((a) => a.outcome === 'DENIED' && a.metadata?.result === 'missing_scope'),
    ).toBe(true);
  });

  it('only the Ministry manages partner systems; keys are never listed', async () => {
    for (const token of [w.tokens.director, w.tokens.doctor]) {
      expect((await api().get('/api/v1/partner/clients').set(bearer(token))).status).toBe(403);
    }
    const list = await api().get('/api/v1/partner/clients').set(bearer(w.tokens.ministry));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(keys.hif.apiKey);
    expect(
      (
        await api()
          .post('/api/v1/partner/clients')
          .set(bearer(w.tokens.ministry))
          .send({ name: 'Bad', organisation: 'Bad org', scopes: ['everything'] })
      ).status,
    ).toBe(400);
  });
});

describe('FHIR for partners', () => {
  it('requires a purpose of use, and a practitioner for treatment', async () => {
    const noPurpose = await api()
      .get('/api/v1/partner/fhir/Patient')
      .query({ identifier: w.patient.nationalId })
      .set(key(keys.hif.apiKey));
    expect(noPurpose.status).toBe(400);
    expect(noPurpose.body.error.code).toBe('PURPOSE_REQUIRED');
    const noPractitioner = await api()
      .get(`/api/v1/partner/fhir/Patient/${w.patient.id}/$everything`)
      .set(key(keys.hif.apiKey))
      .set('X-Purpose-Of-Use', 'TREATMENT');
    expect(noPractitioner.status).toBe(400);
    expect(noPractitioner.body.error.code).toBe('PRACTITIONER_REQUIRED');
  });

  it('finds a patient by national ID with minimal identification', async () => {
    for (const identifier of [
      w.patient.nationalId,
      `urn:pacient:national-id|${w.patient.nationalId}`,
    ]) {
      const res = await api()
        .get('/api/v1/partner/fhir/Patient')
        .query({ identifier })
        .set(key(keys.hif.apiKey))
        .set('X-Purpose-Of-Use', 'PAYMENT');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/fhir\+json/);
      const bundle = fhirJson(res);
      expect(bundle.total).toBe(1);
      expect(bundle.entry[0]!.resource).toMatchObject({
        resourceType: 'Patient',
        id: w.patient.id,
      });
      expect(bundle.entry[0]!.resource.telecom).toBeUndefined();
      expect(bundle.entry[0]!.resource.address).toBeUndefined();
    }
    const none = await api()
      .get('/api/v1/partner/fhir/Patient')
      .query({ identifier: '0000000000' })
      .set(key(keys.hif.apiKey))
      .set('X-Purpose-Of-Use', 'PAYMENT');
    expect(fhirJson(none).total).toBe(0);
  });

  it('for treatment returns what the patient sees – never unreleased results or confidential visits', async () => {
    const res = await api()
      .get(`/api/v1/partner/fhir/Patient/${w.patient.id}/$everything`)
      .set(key(keys.hif.apiKey))
      .set(treatment);
    expect(res.status).toBe(200);
    const bundle = fhirJson(res);
    const ids = bundle.entry.map((e) => e.resource.id);
    expect(ids).toContain(releasedLabId);
    expect(ids).not.toContain(unreleasedLabId);
    expect(res.text).not.toContain('Z30.0');
    expect(res.text).toContain('I10');
    // Audited against the patient, with the partner named for the access log.
    const audits = await partnerAudits(keys.hif.id);
    const exported = audits.find((a) => a.metadata?.result === 'exported');
    expect(exported).toMatchObject({ patientId: w.patient.id, outcome: 'SUCCESS' });
    expect(exported!.metadata).toMatchObject({
      clientName: 'Insurance fund',
      actorLabel: 'Insurance fund (API)',
      purpose: 'TREATMENT',
      practitioner: 'Dr. Test Partner (lic. 123)',
    });
  });

  it('for payment returns encounters and diagnosis codes only', async () => {
    const res = await api()
      .get(`/api/v1/partner/fhir/Patient/${w.patient.id}/$everything`)
      .set(key(keys.hif.apiKey))
      .set('X-Purpose-Of-Use', 'PAYMENT');
    const bundle = fhirJson(res);
    const t = types(bundle);
    expect(t).toContain('Condition');
    expect(t).not.toContain('Observation');
    expect(t).not.toContain('MedicationRequest');
    expect(t).not.toContain('DocumentReference');
    for (const e of bundle.entry.filter((x) => x.resource.resourceType === 'Encounter')) {
      expect(e.resource.reasonCode).toBeUndefined();
    }
    const patient = bundle.entry.find((x) => x.resource.resourceType === 'Patient')!.resource;
    expect(patient.telecom).toBeUndefined();
  });

  it('is refused (and audited) when the patient withdrew consent to sharing', async () => {
    const [p] = await db
      .insert(patients)
      .values({
        nationalId: nextNationalId(),
        firstName: 'Private',
        lastName: 'Person',
        dateOfBirth: '1980-05-05',
        sex: 'MALE',
        primaryFacilityId: w.facility.id,
      })
      .returning();
    await db.execute(sql`INSERT INTO consent_records (patient_id, type, decision, method, wording_version, recorded_by_id)
      VALUES (${p!.id}, 'CROSS_FACILITY_SHARING', 'WITHDRAWN', 'IN_PERSON', '2026-1', ${w.users.doctor.id})`);
    const search = await api()
      .get('/api/v1/partner/fhir/Patient')
      .query({ identifier: p!.nationalId })
      .set(key(keys.hif.apiKey))
      .set('X-Purpose-Of-Use', 'PAYMENT');
    expect(search.status).toBe(403);
    expect(search.body.error.code).toBe('CONSENT_WITHDRAWN');
    const everything = await api()
      .get(`/api/v1/partner/fhir/Patient/${p!.id}/$everything`)
      .set(key(keys.hif.apiKey))
      .set(treatment);
    expect(everything.status).toBe(403);
    const denied = (await partnerAudits(keys.hif.id)).filter(
      (a) => a.patientId === p!.id && a.outcome === 'DENIED',
    );
    expect(denied.length).toBe(2);
  });

  it('includes hospital stays, imaging (released reports only) and newborn birth data', async () => {
    const [unit] = await db
      .insert(careUnits)
      .values({
        facilityId: w.facility.id,
        name: 'Interna A',
        code: `INT${Date.now() % 10000}`,
        type: 'GENERAL_WARD',
      })
      .returning();
    await db.insert(admissions).values({
      patientId: w.patient.id,
      facilityId: w.facility.id,
      unitId: unit!.id,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'ELECTIVE',
      reason: 'Planned observation',
      status: 'DISCHARGED',
      admittedAt: new Date(Date.now() - 3 * 86_400_000),
      dischargedAt: new Date(Date.now() - 86_400_000),
      disposition: 'HOME',
    });
    const [img] = await db
      .insert(imagingOrders)
      .values({
        accessionNumber: `IMGT${Date.now() % 1_000_000}`,
        patientId: w.patient.id,
        facilityId: w.facility.id,
        orderedById: w.users.doctor.id,
        modality: 'XRAY',
        bodyPart: 'Thorax',
        clinicalQuestion: 'Pneumonia?',
        status: 'REPORTED',
        findings: 'Clear lungs.',
        impression: 'No acute findings',
        reportedById: w.users.doctor.id,
        reportedAt: new Date(),
        performedAt: new Date(),
      })
      .returning();

    const staff = fhirJson(
      await api()
        .get(`/api/v1/fhir/Patient/${w.patient.id}/$everything`)
        .set(bearer(w.tokens.doctor)),
    );
    const enc = staff.entry.find(
      (e) =>
        e.resource.resourceType === 'Encounter' &&
        (e.resource.class as { code: string }).code === 'IMP',
    );
    expect(enc?.resource.hospitalization).toMatchObject({
      dischargeDisposition: { coding: [{ code: 'home' }] },
    });
    expect(types(staff)).toContain('ServiceRequest');
    expect(staff.entry.some((e) => e.resource.id === `${img!.id}-report`)).toBe(true);

    // Unreleased report: partner (patient view) sees the order but not the report.
    const partner = fhirJson(
      await api()
        .get(`/api/v1/partner/fhir/Patient/${w.patient.id}/$everything`)
        .set(key(keys.hif.apiKey))
        .set(treatment),
    );
    expect(partner.entry.some((e) => e.resource.id === img!.id)).toBe(true);
    expect(partner.entry.some((e) => e.resource.id === `${img!.id}-report`)).toBe(false);

    // Newborn with a temporary identity: birth weight, Apgar, mother as RelatedPerson.
    const { newborn } = await newbornOf(w.patient.id);
    await db.insert(careAssignments).values({ patientId: newborn.id, doctorId: w.users.doctor.id });
    const baby = fhirJson(
      await api()
        .get(`/api/v1/fhir/Patient/${newborn.id}/$everything`)
        .set(bearer(w.tokens.doctor)),
    );
    const babyPatient = baby.entry.find((e) => e.resource.resourceType === 'Patient')!.resource;
    expect(babyPatient.identifier).toEqual([
      { use: 'temp', system: 'urn:pacient:temporary-id', value: newborn.nationalId },
    ]);
    expect(babyPatient.multipleBirthBoolean).toBe(false);
    const codes = baby.entry.flatMap((e) =>
      ((e.resource.code as { coding?: { code: string }[] })?.coding ?? []).map((c) => c.code),
    );
    expect(codes).toEqual(expect.arrayContaining(['8339-4', '9272-6', '9274-2']));
    expect(types(baby)).toContain('RelatedPerson');
  });
});

let birthSeq = 0;
async function newbornOf(motherId: string) {
  const [newborn] = await db
    .insert(patients)
    .values({
      nationalId: `TMP26110${String(1000 + birthSeq++).padStart(5, '0')}`,
      firstName: 'Foshnja',
      lastName: 'Test',
      dateOfBirth: '2026-11-01',
      sex: 'FEMALE',
      primaryFacilityId: w.facility.id,
      temporaryIdentity: 'NEWBORN',
    })
    .returning();
  const [birth] = await db
    .insert(births)
    .values({
      motherPatientId: motherId,
      newbornPatientId: newborn!.id,
      facilityId: w.facility.id,
      bornAt: new Date(Date.now() - 86_400_000),
      deliveryType: 'SPONTANEOUS_VAGINAL',
      gestationalWeeks: 39,
      birthWeightGrams: 3400,
      apgar1: 8,
      apgar5: 9,
      attendantId: w.users.doctor.id,
    })
    .returning();
  return { newborn: newborn!, birth: birth! };
}

describe('aggregates and directory', () => {
  it('serves national statistics with stats.read', async () => {
    const res = await api().get('/api/v1/partner/stats/national').set(key(keys.hif.apiKey));
    expect(res.status).toBe(200);
    expect(
      (await api().get('/api/v1/partner/stats/national').set(key(keys.dir.apiKey))).status,
    ).toBe(403);
  });

  it('lists facilities and practitioners without staff contact details', async () => {
    const f = await api().get('/api/v1/partner/directory/facilities').set(key(keys.dir.apiKey));
    expect(f.status).toBe(200);
    expect(f.body.items.length).toBeGreaterThan(0);
    const p = await api()
      .get('/api/v1/partner/directory/practitioners')
      .query({ role: 'DOCTOR' })
      .set(key(keys.dir.apiKey));
    expect(p.status).toBe(200);
    const doctor = p.body.items.find((i: { id: string }) => i.id === w.users.doctor.id);
    expect(doctor).toMatchObject({ role: 'DOCTOR' });
    expect(Object.keys(doctor)).not.toEqual(expect.arrayContaining(['email']));
    expect(JSON.stringify(p.body)).not.toContain(w.users.doctor.email);
  });
});

describe('civil registry', () => {
  it('lists births awaiting registration and records the issued national ID', async () => {
    const { birth, newborn } = await newbornOf(w.otherPatient.id);
    const list = await api().get('/api/v1/partner/births').set(key(keys.civil.apiKey));
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: { birthId: string }) => i.birthId === birth.id);
    expect(item).toMatchObject({
      newbornTemporaryId: newborn.nationalId,
      motherNationalId: w.otherPatient.nationalId,
      sex: 'FEMALE',
    });

    // A number that already belongs to someone else is refused, unchanged.
    const taken = await api()
      .post(`/api/v1/partner/births/${birth.id}/registration`)
      .set(key(keys.civil.apiKey))
      .send({ nationalId: w.patient.nationalId, firstName: 'Lira' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('IDENTITY_EXISTS');

    const nationalId = nextNationalId();
    const ok = await api()
      .post(`/api/v1/partner/births/${birth.id}/registration`)
      .set(key(keys.civil.apiKey))
      .send({ nationalId, firstName: 'Lira' });
    expect(ok.status).toBe(200);
    const [after] = await db.select().from(patients).where(eq(patients.id, newborn.id));
    expect(after).toMatchObject({ nationalId, firstName: 'Lira', temporaryIdentity: null });
    const again = await api().get('/api/v1/partner/births').set(key(keys.civil.apiKey));
    expect(again.body.items.some((i: { birthId: string }) => i.birthId === birth.id)).toBe(false);
  });
});

describe('usage, revocation and the API description', () => {
  it('shows usage to the Ministry only', async () => {
    const res = await api()
      .get(`/api/v1/partner/clients/${keys.hif.id}/usage`)
      .set(bearer(w.tokens.ministry));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.denied).toBeGreaterThan(0);
    expect(res.body.distinctPatients).toBeGreaterThan(0);
    expect(
      (
        await api()
          .get(`/api/v1/partner/clients/${keys.hif.id}/usage`)
          .set(bearer(w.tokens.director))
      ).status,
    ).toBe(403);
  });

  it('every partner call is audited', async () => {
    const before = (await partnerAudits(keys.dir.id)).length;
    await api().get('/api/v1/partner/directory/facilities').set(key(keys.dir.apiKey));
    await api().get('/api/v1/partner/stats/national').set(key(keys.dir.apiKey));
    expect((await partnerAudits(keys.dir.id)).length).toBe(before + 2);
  });

  it('stops working immediately once revoked', async () => {
    const tmp = await createClient('Temporary', ['directory.read']);
    expect(
      (await api().get('/api/v1/partner/directory/facilities').set(key(tmp.apiKey))).status,
    ).toBe(200);
    await api()
      .post(`/api/v1/partner/clients/${tmp.id}/revoke`)
      .set(bearer(w.tokens.ministry))
      .expect(204);
    expect(
      (await api().get('/api/v1/partner/directory/facilities').set(key(tmp.apiKey))).status,
    ).toBe(401);
    const audits = await partnerAudits(tmp.id);
    expect(audits.some((a) => a.metadata?.result === 'revoked_key')).toBe(true);
  });

  it('publishes an OpenAPI 3.1 description listing every partner endpoint', async () => {
    const res = await api().get('/api/v1/partner/openapi.json');
    expect(res.status).toBe(200);
    const doc = res.body as {
      openapi: string;
      tags: { name: string }[];
      paths: Record<string, Record<string, { tags: string[] }>>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.tags.map((t) => t.name)).toEqual(
      expect.arrayContaining(['Partner API', 'FHIR', 'Hospital', 'Laboratory']),
    );
    expect(Object.keys(doc.components.securitySchemes)).toEqual(
      expect.arrayContaining(['userBearer', 'partnerKey', 'labKey']),
    );
    const expected = [
      ['get', '/partner/ping'],
      ['get', '/partner/fhir/metadata'],
      ['get', '/partner/fhir/Patient'],
      ['get', '/partner/fhir/Patient/{id}/$everything'],
      ['get', '/partner/stats/national'],
      ['get', '/partner/directory/facilities'],
      ['get', '/partner/directory/practitioners'],
      ['get', '/partner/births'],
      ['post', '/partner/births/{birthId}/registration'],
      ['get', '/partner/claims'],
      ['get', '/partner/claims/{id}'],
      ['post', '/partner/claims/{id}/decision'],
      ['get', '/partner/surveillance/cases'],
      ['get', '/partner/surveillance/summary'],
      ['get', '/partner/deaths'],
      ['post', '/partner/deaths/{certificateNumber}/acknowledge'],
    ] as const;
    for (const [method, path] of expected) {
      expect(doc.paths[path]?.[method]?.tags, `${method} ${path}`).toContain('Partner API');
    }
    expect(partnerOperations().length).toBe(expected.length);
  });
});
