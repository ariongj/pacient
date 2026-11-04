// The recorder must load before the app so it can see every router mount.
import { listRoutes } from './support/route-recorder.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  appointments,
  bloodGroupTests,
  bloodUnits,
  careUnits,
  dietOrders,
  earlyWarningScores,
  immunizations,
  insuranceCoverages,
  medicationCatalog,
  prescriptions,
  stockBatches,
  stockMovements,
  surgicalCases,
  transfusionRequests,
  transfusions,
  vaccineSchedule,
  videoSessions,
  vitalSigns,
} from '../src/db/schema.js';
import { openApiDocument } from '../src/openapi/spec.js';
import { api, app, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;

type Bundle = { entry: { resource: Record<string, unknown> }[] };
const parse = (res: { text: string }) => JSON.parse(res.text) as Bundle;
const ofType = (b: Bundle, type: string) =>
  b.entry.map((e) => e.resource).filter((r) => r.resourceType === type);

/**
 * TODO(openapi): mount prefixes whose routers are still being built. Their routes are not yet in
 * the OpenAPI registry; remove each prefix from this list once its endpoints are documented.
 */
const UNDOCUMENTED_PREFIXES_TODO: string[] = [];

/** Infrastructure endpoints outside the versioned API (probes and the Prometheus scrape). */
const INFRASTRUCTURE_ROUTES = ['GET /health/live', 'GET /health/ready', 'GET /metrics'];

describe('OpenAPI covers every API route', () => {
  const stack = (app as unknown as { router: { stack: never[] } }).router.stack;
  const all = [...new Set(listRoutes(stack))];
  const routes = all
    .filter((r) => r.includes(' /api/v1/'))
    .map((r) => r.replace(' /api/v1', ' '))
    .filter((r) => {
      const path = r.split(' ')[1]!;
      return !UNDOCUMENTED_PREFIXES_TODO.some((p) => path === p || path.startsWith(`${p}/`));
    });
  const doc = openApiDocument() as unknown as {
    paths: Record<
      string,
      Record<string, { tags: string[]; parameters?: { name: string; in: string }[] }>
    >;
    tags: { name: string }[];
  };
  const documented = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
  );

  it('documents every route that the routers mounted in app.ts register', () => {
    expect(routes.length).toBeGreaterThan(350);
    const known = new Set(documented);
    expect(routes.filter((r) => !known.has(r))).toEqual([]);
  });

  it('documents no route that does not exist', () => {
    const real = new Set(routes);
    expect(documented.filter((r) => !real.has(r))).toEqual([]);
    expect(all.filter((r) => !r.includes(' /api/v1/')).sort()).toEqual(INFRASTRUCTURE_ROUTES);
  });

  it('declares every path parameter and uses only declared tags', () => {
    const tags = new Set(doc.tags.map((t) => t.name));
    const problems: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      const want = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      for (const [method, operation] of Object.entries(methods)) {
        const got = (operation.parameters ?? [])
          .filter((p) => p.in === 'path')
          .map((p) => p.name)
          .sort();
        if (want.join() !== got.join()) problems.push(`${method} ${path}: path parameters`);
        if (!tags.has(operation.tags[0]!)) problems.push(`${method} ${path}: unknown tag`);
      }
    }
    expect(problems).toEqual([]);
    expect([...tags]).toEqual(
      expect.arrayContaining(['Operating theatres', 'Blood bank', 'Billing', 'Video visits']),
    );
  });
});

describe('FHIR export of the hospital modules', () => {
  let unitId: string;
  let catalogId: string;
  beforeAll(async () => {
    w = await createWorld();
    const pid = w.patient.id;
    const doctorId = w.users.doctor.id;
    const facilityId = w.facility.id;
    const [unit] = await db
      .insert(careUnits)
      .values({
        facilityId,
        name: 'Kirurgjia',
        code: `K${Date.now() % 100000}`,
        type: 'SURGICAL_WARD',
      })
      .returning();
    unitId = unit!.id;
    const [adm] = await db
      .insert(admissions)
      .values({
        patientId: pid,
        facilityId,
        unitId,
        admittingDoctorId: doctorId,
        attendingDoctorId: doctorId,
        source: 'ELECTIVE',
        reason: 'Planned hernia repair',
      })
      .returning();
    await db.insert(surgicalCases).values([
      {
        patientId: pid,
        facilityId,
        admissionId: adm!.id,
        procedure: 'Inguinal hernia repair',
        laterality: 'RIGHT',
        indication: 'Symptomatic hernia',
        primarySurgeonId: doctorId,
        status: 'COMPLETED',
        incisionAt: new Date(Date.now() - 3 * 3_600_000),
        closureAt: new Date(Date.now() - 2 * 3_600_000),
        operationNote: 'Mesh repair, no complications. SECRET-OP-NOTE',
        noteSignedById: doctorId,
        noteSignedAt: new Date(Date.now() - 2 * 3_600_000),
        createdById: doctorId,
      },
      {
        patientId: pid,
        facilityId,
        procedure: 'Planned knee arthroscopy',
        laterality: 'LEFT',
        indication: 'Meniscus tear',
        primarySurgeonId: doctorId,
        status: 'REQUESTED',
        createdById: doctorId,
      },
    ]);
    await db.insert(dietOrders).values({
      patientId: pid,
      admissionId: adm!.id,
      dietType: 'DIABETIC',
      restrictions: ['gluten'],
      notes: 'SECRET-DIET-NOTE',
      orderedById: doctorId,
    });
    const [rx] = await db
      .insert(prescriptions)
      .values({
        patientId: pid,
        doctorId,
        medication: 'Amoxicillin 500 mg',
        dosage: '500 mg',
        frequency: 'three times a day',
        startDate: '2026-11-01',
        dispensedAt: new Date(),
        dispensedById: w.users.pharmacist.id,
      })
      .returning();
    const [item] = await db
      .insert(medicationCatalog)
      .values({
        name: `Amoxicillin ${Date.now()}`,
        atcCode: 'J01CA04',
        form: 'capsule',
        strength: '500 mg',
        unit: 'capsule',
      })
      .returning();
    catalogId = item!.id;
    const [batch] = await db
      .insert(stockBatches)
      .values({
        facilityId,
        itemId: catalogId,
        batchNumber: 'LOT-FHIR-1',
        expiryDate: '2028-01-31',
        quantity: 100,
        createdById: w.users.pharmacist.id,
      })
      .returning();
    await db.insert(stockMovements).values({
      facilityId,
      itemId: catalogId,
      batchId: batch!.id,
      type: 'DISPENSE',
      quantity: -21,
      prescriptionId: rx!.id,
      createdById: w.users.pharmacist.id,
    });
    const [vs] = await db
      .insert(vitalSigns)
      .values({
        patientId: pid,
        recordedById: w.users.nurse.id,
        heartRate: 112,
        respiratoryRate: 24,
        consciousness: 'C',
        onSupplementalOxygen: true,
        painScore: 6,
      })
      .returning();
    await db.insert(earlyWarningScores).values({
      patientId: pid,
      vitalSignId: vs!.id,
      admissionId: adm!.id,
      score: 8,
      risk: 'HIGH',
      components: {},
      complete: false,
    });
    await db.insert(bloodGroupTests).values({
      patientId: pid,
      facilityId,
      abo: 'A',
      rhD: 'POS',
      testedById: doctorId,
    });
    const [unitRow] = await db
      .insert(bloodUnits)
      .values({
        facilityId,
        unitNumber: `U${Date.now()}`,
        product: 'RED_CELLS',
        abo: 'A',
        rhD: 'POS',
        volumeMl: 280,
        collectedAt: new Date(Date.now() - 5 * 86_400_000),
        expiresAt: new Date(Date.now() + 20 * 86_400_000),
        status: 'TRANSFUSED',
        receivedById: doctorId,
      })
      .returning();
    const [req] = await db
      .insert(transfusionRequests)
      .values({
        patientId: pid,
        facilityId,
        admissionId: adm!.id,
        product: 'RED_CELLS',
        units: 1,
        urgency: 'URGENT',
        indication: 'Anaemia after surgery',
        status: 'COMPLETED',
        requestedById: doctorId,
      })
      .returning();
    await db.insert(transfusions).values({
      requestId: req!.id,
      unitId: unitRow!.id,
      patientId: pid,
      issuedById: doctorId,
      checkedById: w.users.nurse.id,
      startedAt: new Date(Date.now() - 3_600_000),
      endedAt: new Date(),
      status: 'COMPLETED',
    });
    await db.insert(insuranceCoverages).values({
      patientId: pid,
      insurer: 'FSSH',
      policyNumber: 'FSSH-123',
      validFrom: '2026-01-01',
    });
    const [dose] = await db
      .insert(vaccineSchedule)
      .values({
        code: `MMR-1-${Date.now()}`,
        vaccine: 'MMR',
        doseNumber: 1,
        recommendedAgeDays: 365,
        overdueAgeDays: 455,
      })
      .returning();
    await db.insert(immunizations).values({
      patientId: pid,
      vaccine: 'MMR',
      doseNumber: 1,
      administeredAt: new Date('2000-01-01'),
      administeredById: w.users.nurse.id,
      facilityId,
      scheduleItemId: dose!.id,
    });
    const [appt] = await db
      .insert(appointments)
      .values({
        patientId: pid,
        doctorId,
        facilityId,
        scheduledAt: new Date(Date.now() - 86_400_000),
        reason: 'Follow-up by video SECRET-VIDEO-REASON',
        status: 'COMPLETED',
        mode: 'VIDEO',
      })
      .returning();
    await db.insert(videoSessions).values({
      appointmentId: appt!.id,
      status: 'ENDED',
      startedAt: new Date(Date.now() - 86_400_000),
      endedAt: new Date(Date.now() - 86_400_000 + 900_000),
    });
  });

  it('includes the new resource types for the care team, with notes', async () => {
    const res = await api()
      .get(`/api/v1/fhir/Patient/${w.patient.id}/$everything`)
      .set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    const b = parse(res);
    const procedures = ofType(b, 'Procedure');
    expect(procedures.map((p) => (p.code as { text?: string }).text)).toEqual(
      expect.arrayContaining(['Inguinal hernia repair', 'Planned knee arthroscopy']),
    );
    expect(JSON.stringify(procedures)).toContain('SECRET-OP-NOTE');
    expect(JSON.stringify(procedures)).toContain('116859006');
    const dispense = ofType(b, 'MedicationDispense')[0]!;
    expect(JSON.stringify(dispense)).toContain('LOT-FHIR-1');
    expect((dispense.quantity as { value: number }).value).toBe(21);
    expect(ofType(b, 'NutritionOrder')).toHaveLength(1);
    expect(ofType(b, 'Coverage')).toHaveLength(1);
    const obs = JSON.stringify(ofType(b, 'Observation'));
    for (const code of ['882-1', '72514-3', '80288-4', '1104051000000101', 'supplemental-oxygen']) {
      expect(obs).toContain(code);
    }
    const imm = ofType(b, 'Immunization')[0]!;
    expect(JSON.stringify(imm.protocolApplied)).toContain('MMR');
    const vr = ofType(b, 'Encounter').find(
      (e) => (e.class as { code?: string } | undefined)?.code === 'VR',
    );
    expect(vr).toBeTruthy();
    expect(vr!.status).toBe('finished');

    const meta = await api().get('/api/v1/fhir/metadata');
    const types = (
      JSON.parse(meta.text) as { rest: { resource: { type: string }[] }[] }
    ).rest[0]!.resource.map((r) => r.type);
    expect(types).toEqual(
      expect.arrayContaining(['Procedure', 'MedicationDispense', 'NutritionOrder', 'Coverage']),
    );
  });

  it('hides unfinished operations and clinical notes from the patient view', async () => {
    const res = await api()
      .get(`/api/v1/fhir/Patient/${w.patient.id}/$everything`)
      .set(bearer(w.tokens.patient));
    expect(res.status).toBe(200);
    const b = parse(res);
    const text = JSON.stringify(b);
    expect(text).not.toContain('Planned knee arthroscopy');
    expect(text).not.toContain('SECRET-OP-NOTE');
    expect(text).not.toContain('SECRET-DIET-NOTE');
    expect(
      ofType(b, 'Procedure').some(
        (p) => (p.code as { text?: string }).text === 'Inguinal hernia repair',
      ),
    ).toBe(true);
    expect(ofType(b, 'Coverage')).toHaveLength(1);
  });

  it('gives a PAYMENT partner coverage and procedure codes but no notes', async () => {
    const created = await api()
      .post('/api/v1/partner/clients')
      .set(bearer(w.tokens.ministry))
      .send({ name: 'Fund test', organisation: 'Fund test org', scopes: ['fhir.patient.read'] });
    expect(created.status).toBe(201);
    const res = await api()
      .get(`/api/v1/partner/fhir/Patient/${w.patient.id}/$everything`)
      .set('Authorization', `Bearer ${created.body.apiKey as string}`)
      .set('X-Purpose-Of-Use', 'PAYMENT');
    expect(res.status).toBe(200);
    const b = parse(res);
    const text = JSON.stringify(b);
    expect(ofType(b, 'Coverage')).toHaveLength(1);
    expect(ofType(b, 'Procedure').length).toBeGreaterThan(0);
    expect(text).not.toContain('SECRET-OP-NOTE');
    expect(text).not.toContain('SECRET-VIDEO-REASON');
    expect(text).not.toContain('Symptomatic hernia');
    expect(ofType(b, 'MedicationDispense')).toHaveLength(0);
    expect(ofType(b, 'NutritionOrder')).toHaveLength(0);
    expect(
      ofType(b, 'Encounter').some((e) => (e.class as { code?: string } | undefined)?.code === 'VR'),
    ).toBe(true);
  });
});
