import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  allergies,
  auditLogs,
  clinicalResourceVersions,
  guardianships,
  patients,
  prescriptions,
  vitalSigns,
} from '../src/db/schema.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const doctor = () => bearer(w.tokens.doctor);
const base = () => `/api/v1/history/patients/${w.patient.id}`;

async function versions(table: string, id: string) {
  return db
    .select()
    .from(clinicalResourceVersions)
    .where(
      and(
        eq(clinicalResourceVersions.tableName, table),
        eq(clinicalResourceVersions.resourceId, id),
      ),
    )
    .orderBy(clinicalResourceVersions.version);
}

let allergyId: string;

beforeAll(async () => {
  w = await createWorld();
  const created = await api()
    .post(`/api/v1/patients/${w.patient.id}/allergies`)
    .set(doctor())
    .send({ substance: 'Penicillin', reaction: 'Rash', severity: 'MODERATE' });
  expect(created.status).toBe(201);
  allergyId = created.body.id;
  const confirmed = await api()
    .patch(`/api/v1/patients/${w.patient.id}/allergies/${allergyId}`)
    .set(doctor())
    .send({ verificationStatus: 'CONFIRMED' });
  expect(confirmed.status).toBe(200);
});

describe('the database trigger', () => {
  it('captures insert and update in order, with the changed columns', async () => {
    const rows = await versions('allergies', allergyId);
    expect(rows.map((r) => [r.version, r.operation])).toEqual([
      [1, 'INSERT'],
      [2, 'UPDATE'],
    ]);
    expect(rows[1]!.changedFields).toEqual(['verification_status']);
    expect(rows[1]!.patientId).toBe(w.patient.id);
    expect(rows[1]!.data).toMatchObject({
      substance: 'Penicillin',
      verification_status: 'CONFIRMED',
    });
  });

  it('skips updates that change nothing but updated_at, and records deletes', async () => {
    const [rx] = await db
      .insert(prescriptions)
      .values({
        patientId: w.patient.id,
        doctorId: w.users.doctor.id,
        medication: 'Amoxicillin 500 mg',
        dosage: '1 capsule',
        frequency: 'three times a day',
        startDate: '2026-11-01',
      })
      .returning();
    await db
      .update(prescriptions)
      .set({ updatedAt: new Date(Date.now() + 1000) })
      .where(eq(prescriptions.id, rx!.id));
    expect(await versions('prescriptions', rx!.id)).toHaveLength(1);
    await db.delete(prescriptions).where(eq(prescriptions.id, rx!.id));
    const rows = await versions('prescriptions', rx!.id);
    expect(rows.map((r) => r.operation)).toEqual(['INSERT', 'DELETE']);
    expect(rows[1]!.data).toMatchObject({ medication: 'Amoxicillin 500 mg' });
  });

  it('refuses to change or delete history', async () => {
    const [row] = await versions('allergies', allergyId);
    await expect(
      db.execute(sql`UPDATE clinical_resource_versions SET version = 9 WHERE id = ${row!.id}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`DELETE FROM clinical_resource_versions WHERE id = ${row!.id}`),
    ).rejects.toThrow();
  });
});

describe('record history', () => {
  it('attributes each version through the audit entry of the same transaction', async () => {
    const res = await api().get(`${base()}/records/allergies/${allergyId}`).set(doctor());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ table: 'allergies', title: 'Penicillin', deleted: false });
    const [latest, first] = res.body.versions;
    expect(latest).toMatchObject({
      version: 2,
      operation: 'UPDATE',
      mergedMove: false,
      by: { userId: w.users.doctor.id, name: w.users.doctor.fullName, role: 'DOCTOR' },
      changes: [
        {
          field: 'verification_status',
          label: 'Verification',
          before: 'UNCONFIRMED',
          after: 'CONFIRMED',
        },
      ],
    });
    expect(latest.by.action).toBe('clinical.entry.updated');
    expect(first.operation).toBe('INSERT');
    // The first version lists its filled fields; user ids are shown as names, never as ids.
    const recordedBy = first.changes.find((c: { field: string }) => c.field === 'recorded_by_id');
    expect(recordedBy).toMatchObject({ before: null, after: w.users.doctor.fullName });
  });

  it('shows changes without an audit entry as not attributed', async () => {
    const [v] = await db
      .insert(vitalSigns)
      .values({ patientId: w.patient.id, recordedById: w.users.nurse.id, heartRate: 80 })
      .returning();
    await db.update(vitalSigns).set({ heartRate: 92 }).where(eq(vitalSigns.id, v!.id));
    const res = await api().get(`${base()}/records/vital_signs/${v!.id}`).set(doctor());
    expect(res.status).toBe(200);
    expect(res.body.versions[0]).toMatchObject({
      by: null,
      changes: [{ field: 'heart_rate', before: 80, after: 92 }],
    });
  });

  it('never shows an e-prescription code', async () => {
    const [rx] = await db
      .insert(prescriptions)
      .values({
        patientId: w.patient.id,
        doctorId: w.users.doctor.id,
        medication: 'Metformin 500 mg',
        dosage: '1 tablet',
        frequency: 'twice a day',
        startDate: '2026-11-01',
      })
      .returning();
    await db
      .update(prescriptions)
      .set({ ePrescriptionCode: 'HSTR9TEST1' })
      .where(eq(prescriptions.id, rx!.id));
    const res = await api().get(`${base()}/records/prescriptions/${rx!.id}`).set(doctor());
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('HSTR9TEST1');
    expect(res.body.versions[0].changes).toEqual([
      expect.objectContaining({ field: 'e_prescription_code', before: null, after: true }),
    ]);
  });

  it('refuses records of another patient (404)', async () => {
    const [other] = await db
      .insert(allergies)
      .values({
        patientId: w.otherPatient.id,
        substance: 'Latex',
        severity: 'MILD',
        recordedById: w.users.doctor.id,
      })
      .returning();
    const res = await api().get(`${base()}/records/allergies/${other!.id}`).set(doctor());
    expect(res.status).toBe(404);
  });

  it('marks versions that only moved the record from a merged duplicate', async () => {
    const [dup] = await db
      .insert(patients)
      .values({
        nationalId: `9${String(Date.now()).slice(-9)}`,
        firstName: 'Test',
        lastName: 'Duplicate',
        dateOfBirth: '1990-01-01',
        sex: 'FEMALE',
        primaryFacilityId: w.facility.id,
      })
      .returning();
    const [a] = await db
      .insert(allergies)
      .values({
        patientId: dup!.id,
        substance: 'Aspirin',
        severity: 'SEVERE',
        recordedById: w.users.doctor.id,
      })
      .returning();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pacient.patient_merge', 'on', true)`);
      await tx.update(allergies).set({ patientId: w.patient.id }).where(eq(allergies.id, a!.id));
    });
    const res = await api().get(`${base()}/records/allergies/${a!.id}`).set(doctor());
    expect(res.status).toBe(200);
    expect(res.body.versions[0]).toMatchObject({ mergedMove: true, changes: [] });
  });
});

describe('recent changes', () => {
  it('lists changes newest first without baseline rows, filterable by table', async () => {
    const res = await api().get(`${base()}/changes`).set(doctor()).query({ pageSize: 50 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(3);
    const times = res.body.items.map((i: { recordedAt: string }) => i.recordedAt);
    expect([...times].sort().reverse()).toEqual(times);
    const confirmed = res.body.items.find(
      (i: { resourceId: string; version: number }) => i.resourceId === allergyId && i.version === 2,
    );
    expect(confirmed).toMatchObject({
      table: 'allergies',
      title: 'Penicillin',
      changedFields: [{ field: 'verification_status', label: 'Verification' }],
    });
    const only = await api().get(`${base()}/changes`).set(doctor()).query({ table: 'vital_signs' });
    expect(only.body.items.every((i: { table: string }) => i.table === 'vital_signs')).toBe(true);
    expect(res.body.items.some((i: { operation: string }) => i.operation === 'BASELINE')).toBe(
      false,
    );
  });
});

describe('access', () => {
  it('allows the care team and audits the read as a record view', async () => {
    const nurse = await api().get(`${base()}/changes`).set(bearer(w.tokens.nurse));
    // The nurse has no care relationship with this patient.
    expect(nurse.status).toBe(403);
    expect((await api().get(`${base()}/changes`).set(doctor())).status).toBe(200);
    const views = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.patientId, w.patient.id),
          eq(auditLogs.actorUserId, w.users.doctor.id),
          eq(auditLogs.action, 'patient.record.viewed'),
        ),
      );
    expect(
      views.some((v) => (v.metadata as { section?: string } | null)?.section === 'history'),
    ).toBe(true);
  });

  it('refuses other facilities, directors, the Ministry, reception and pharmacists', async () => {
    for (const token of [
      w.tokens.outsideDoctor,
      w.tokens.director,
      w.tokens.ministry,
      w.tokens.reception,
      w.tokens.pharmacist,
    ]) {
      expect((await api().get(`${base()}/changes`).set(bearer(token))).status).toBe(403);
      expect(
        (await api().get(`${base()}/records/allergies/${allergyId}`).set(bearer(token))).status,
      ).toBe(403);
    }
  });

  it('refuses the patient and a guardian with full access', async () => {
    expect((await api().get(`${base()}/changes`).set(bearer(w.tokens.patient))).status).toBe(403);
    const parent = await createUser('PATIENT');
    const child = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await db.update(patients).set({ dateOfBirth: '2016-05-01' }).where(eq(patients.id, child.id));
    await db.insert(guardianships).values({
      patientId: child.id,
      guardianUserId: parent.id,
      relationship: 'PARENT',
      evidence: 'Birth certificate 1/2016',
      verifiedById: w.users.reception.id,
      validUntil: new Date('2030-01-01'),
    });
    const token = await login(parent.email);
    // The care team can read the child's history; the guardian cannot.
    expect(
      (await api().get(`/api/v1/history/patients/${child.id}/changes`).set(doctor())).status,
    ).toBe(200);
    const res = await api()
      .get(`/api/v1/history/patients/${child.id}/changes`)
      .set({ ...bearer(token), 'X-Acting-For': child.id });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/treating care team/);
  });
});

describe('FHIR _history', () => {
  it('returns a history Bundle and single versions (vread)', async () => {
    const res = await api()
      .get(`/api/v1/fhir/AllergyIntolerance/${allergyId}/_history`)
      .set(doctor());
    expect(res.status).toBe(200);
    const bundle = JSON.parse(res.text);
    expect(bundle).toMatchObject({ resourceType: 'Bundle', type: 'history', total: 2 });
    expect(bundle.entry[0]).toMatchObject({
      request: { method: 'PUT', url: `AllergyIntolerance/${allergyId}` },
      resource: { meta: { versionId: '2' } },
    });
    expect(bundle.entry[1]).toMatchObject({ request: { method: 'POST' } });
    expect(bundle.entry[1].resource.verificationStatus.coding[0].code).toBe('unconfirmed');
    const v1 = await api()
      .get(`/api/v1/fhir/AllergyIntolerance/${allergyId}/_history/1`)
      .set(doctor());
    expect(v1.status).toBe(200);
    expect(JSON.parse(v1.text).meta.versionId).toBe('1');
    expect(
      (await api().get(`/api/v1/fhir/AllergyIntolerance/${allergyId}/_history/7`).set(doctor()))
        .status,
    ).toBe(404);
  });

  it('versions vital-sign observations and refuses outsiders and patients', async () => {
    const [v] = await db
      .insert(vitalSigns)
      .values({ patientId: w.patient.id, recordedById: w.users.nurse.id, heartRate: 70 })
      .returning();
    await db.update(vitalSigns).set({ heartRate: 75 }).where(eq(vitalSigns.id, v!.id));
    const res = await api().get(`/api/v1/fhir/Observation/${v!.id}-8867-4/_history`).set(doctor());
    expect(res.status).toBe(200);
    const bundle = JSON.parse(res.text);
    expect(bundle.total).toBe(2);
    expect(bundle.entry[0].resource.valueQuantity.value).toBe(75);
    // No blood pressure was ever recorded in this row.
    expect(
      (await api().get(`/api/v1/fhir/Observation/${v!.id}-bp/_history`).set(doctor())).status,
    ).toBe(404);
    expect(
      (
        await api()
          .get(`/api/v1/fhir/AllergyIntolerance/${allergyId}/_history`)
          .set(bearer(w.tokens.outsideDoctor))
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .get(`/api/v1/fhir/AllergyIntolerance/${allergyId}/_history`)
          .set(bearer(w.tokens.patient))
      ).status,
    ).toBe(403);
    const deleted = await api()
      .get(`/api/v1/fhir/MedicationRequest/${allergyId}/_history`)
      .set(doctor());
    expect(deleted.status).toBe(404);
  });

  it('declares history in the CapabilityStatement', async () => {
    const res = await api().get('/api/v1/fhir/metadata');
    const cap = JSON.parse(res.text);
    const allergy = cap.rest[0].resource.find(
      (r: { type: string }) => r.type === 'AllergyIntolerance',
    );
    expect(allergy.interaction).toEqual([{ code: 'vread' }, { code: 'history-instance' }]);
  });
});
