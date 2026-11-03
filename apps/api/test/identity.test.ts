import { and, eq, isNull } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  auditLogs,
  births,
  careAssignments,
  careUnits,
  edVisits,
  guardianships,
  patientMerges,
  patients,
  unitStaff,
  vitalSigns,
} from '../src/db/schema.js';
import { confirmIdentity } from '../src/modules/identity/identity.service.js';
import { api, bearer, createPatient, createUser, createWorld, login, nextNationalId } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let maternityId: string;

beforeAll(async () => {
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Maternity', code: `MAT${Date.now() % 1000}`, type: 'MATERNITY' })
    .returning();
  maternityId = unit!.id;
});

const birthBody = (motherPatientId: string, extra: Record<string, unknown> = {}) => ({
  motherPatientId,
  bornAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  sex: 'FEMALE',
  deliveryType: 'SPONTANEOUS_VAGINAL',
  gestationalWeeks: 39,
  gestationalDays: 2,
  birthWeightGrams: 3350,
  lengthCm: 50,
  apgar1: 8,
  apgar5: 9,
  ...extra,
});

async function femalePatient(opts: { userId?: string } = {}) {
  const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id, ...opts });
  await db.update(patients).set({ sex: 'FEMALE', municipality: 'Prishtinë' }).where(eq(patients.id, p.id));
  return p;
}

async function admit(patientId: string) {
  const [a] = await db
    .insert(admissions)
    .values({
      patientId,
      facilityId: w.facility.id,
      unitId: maternityId,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'ELECTIVE',
      reason: 'Labour',
    })
    .returning();
  return a!;
}

describe('temporary identities', () => {
  it('lets reception, nurses and doctors register an unidentified patient', async () => {
    const res = await api()
      .post('/api/v1/identity/temporary')
      .set(bearer(w.tokens.reception))
      .send({ sex: 'MALE', estimatedAge: 40, identityNote: 'Man, about 40, brought by ambulance' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ temporaryIdentity: 'UNIDENTIFIED', firstName: 'Unknown', sex: 'MALE' });
    expect(res.body.nationalId).toMatch(/^TMP\d{10}$/);
    expect(res.body.lastName).toBe(`#${res.body.nationalId.slice(-4)}`);
    expect(res.body.dateOfBirth).toBe(`${new Date().getFullYear() - 40}-01-01`);

    for (const token of [w.tokens.nurse, w.tokens.doctor]) {
      const r = await api()
        .post('/api/v1/identity/temporary')
        .set(bearer(token))
        .send({ sex: 'UNKNOWN', identityNote: 'Found unconscious' });
      expect(r.status).toBe(201);
    }
    for (const token of [w.tokens.pharmacist, w.tokens.director, w.tokens.patient, w.tokens.ministry]) {
      const r = await api()
        .post('/api/v1/identity/temporary')
        .set(bearer(token))
        .send({ sex: 'MALE', identityNote: 'Test' });
      expect(r.status).toBe(403);
    }

    const list = await api().get('/api/v1/identity/temporary').set(bearer(w.tokens.director));
    expect(list.body.items.some((i: { id: string }) => i.id === res.body.id)).toBe(true);
    const other = await api().get('/api/v1/identity/temporary').set(bearer(w.tokens.otherDirector));
    expect(other.body.items.some((i: { id: string }) => i.id === res.body.id)).toBe(false);

    const search = await api()
      .get(`/api/v1/patients?scope=facility&search=${res.body.nationalId.slice(0, 9)}`)
      .set(bearer(w.tokens.reception));
    expect(search.body.items.find((i: { id: string }) => i.id === res.body.id)).toMatchObject({
      temporaryIdentity: 'UNIDENTIFIED',
    });

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.patientId, res.body.id), eq(auditLogs.action, 'patient.temporary.registered')));
    expect(audits).toHaveLength(1);
  });

  it('confirms the identity, or refuses when the person already has a record', async () => {
    const tmp = await api()
      .post('/api/v1/identity/temporary')
      .set(bearer(w.tokens.reception))
      .send({ sex: 'FEMALE', estimatedAge: 70, identityNote: 'Elderly woman, confused' });
    const existing = await createPatient(w.facility.id);

    const clash = await api()
      .post(`/api/v1/identity/${tmp.body.id}/confirm`)
      .set(bearer(w.tokens.reception))
      .send({ nationalId: existing.nationalId, firstName: 'Shpresa', lastName: 'Berisha', dateOfBirth: '1956-03-04', sex: 'FEMALE' });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('IDENTITY_EXISTS');
    expect(clash.body.error.details).toEqual({ existingPatientId: existing.id });

    const other = await api()
      .post(`/api/v1/identity/${tmp.body.id}/confirm`)
      .set(bearer(w.tokens.otherDirector))
      .send({ nationalId: nextNationalId(), firstName: 'A', lastName: 'B', dateOfBirth: '1956-03-04', sex: 'FEMALE' });
    expect(other.status).toBe(404);

    const nationalId = nextNationalId();
    const ok = await api()
      .post(`/api/v1/identity/${tmp.body.id}/confirm`)
      .set(bearer(w.tokens.reception))
      .send({ nationalId, firstName: 'Shpresa', lastName: 'Berisha', dateOfBirth: '1956-03-04', sex: 'FEMALE' });
    expect(ok.status).toBe(200);
    const [p] = await db.select().from(patients).where(eq(patients.id, tmp.body.id));
    expect(p).toMatchObject({ nationalId, firstName: 'Shpresa', temporaryIdentity: null });
    expect(p!.identityConfirmedAt).not.toBeNull();

    const again = await api()
      .post(`/api/v1/identity/${tmp.body.id}/confirm`)
      .set(bearer(w.tokens.reception))
      .send({ nationalId: nextNationalId(), firstName: 'X', lastName: 'Y', dateOfBirth: '1956-03-04', sex: 'FEMALE' });
    expect(again.status).toBe(409);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.patientId, tmp.body.id), eq(auditLogs.action, 'patient.identity.confirmed')));
    expect(audit!.metadata).toMatchObject({ via: 'STAFF', previousNumber: tmp.body.nationalId });
  });

  it('exposes confirmIdentity for the civil registry interface', async () => {
    const tmp = await api()
      .post('/api/v1/identity/temporary')
      .set(bearer(w.tokens.nurse))
      .send({ sex: 'MALE', identityNote: 'Young man without documents' });
    const result = await confirmIdentity(
      { patientId: tmp.body.id, nationalId: nextNationalId(), firstName: 'Arben', lastName: 'Morina', dateOfBirth: '2001-07-01', sex: 'MALE' },
      { ctx: null, via: 'CIVIL_REGISTRY', clientName: 'Civil registry' },
    );
    expect(result.patientId).toBe(tmp.body.id);
  });
});

describe('births', () => {
  it('registers a newborn linked to the mother with guardianship, care team and rooming-in', async () => {
    const motherUser = await createUser('PATIENT');
    const mother = await femalePatient({ userId: motherUser.id });
    const stay = await admit(mother.id);

    const res = await api()
      .post('/api/v1/identity/births')
      .set(bearer(w.tokens.doctor))
      .send(birthBody(mother.id, { motherAdmissionId: stay.id }));
    expect(res.status).toBe(201);
    const baby = res.body.newborn;
    expect(baby).toMatchObject({ temporaryIdentity: 'NEWBORN', lastName: mother.lastName, firstName: 'Foshnja', sex: 'FEMALE' });
    expect(baby.nationalId).toMatch(/^TMP\d{10}$/);
    expect(res.body.guardianshipCreated).toBe(true);

    const [p] = await db.select().from(patients).where(eq(patients.id, baby.id));
    expect(p!.municipality).toBe('Prishtinë');
    const [g] = await db.select().from(guardianships).where(eq(guardianships.patientId, baby.id));
    expect(g).toMatchObject({ guardianUserId: motherUser.id, relationship: 'PARENT', scope: 'FULL' });
    expect(g!.validUntil.getUTCFullYear()).toBe(new Date(p!.dateOfBirth).getUTCFullYear() + 18);
    const team = await db
      .select()
      .from(careAssignments)
      .where(and(eq(careAssignments.patientId, baby.id), isNull(careAssignments.endedAt)));
    expect(team.map((t) => t.doctorId)).toContain(w.users.doctor.id);
    const [adm] = await db.select().from(admissions).where(eq(admissions.patientId, baby.id));
    expect(adm).toMatchObject({ unitId: maternityId, source: 'BIRTH', status: 'ADMITTED', bedId: null });
    const [vs] = await db.select().from(vitalSigns).where(eq(vitalSigns.patientId, baby.id));
    expect(Number(vs!.weightKg)).toBeCloseTo(3.4, 1);

    // The mother sees her baby's record in the portal as a guardian.
    const motherToken = await login(motherUser.email);
    const portal = await api()
      .get(`/api/v1/identity/patients/${baby.id}/birth`)
      .set({ ...bearer(motherToken), 'X-Acting-For': baby.id });
    expect(portal.status).toBe(200);
    expect(portal.body.asNewborn).toMatchObject({ apgar1: 8, apgar5: 9, birthWeightGrams: 3350, motherId: mother.id });

    const chart = await api().get(`/api/v1/identity/patients/${mother.id}/birth`).set(bearer(w.tokens.doctor));
    expect(chart.body.asMother.map((b: { newbornId: string }) => b.newbornId)).toContain(baby.id);

    // Civil registration confirms the newborn and stamps the birth.
    await confirmIdentity(
      { patientId: baby.id, nationalId: nextNationalId(), firstName: 'Ana', lastName: mother.lastName, dateOfBirth: p!.dateOfBirth, sex: 'FEMALE' },
      { ctx: null, via: 'CIVIL_REGISTRY' },
    );
    const [b] = await db.select().from(births).where(eq(births.newbornPatientId, baby.id));
    expect(b!.civilRegisteredAt).not.toBeNull();
  });

  it('shows reception the front-desk view only, and refuses outsiders', async () => {
    const mother = await femalePatient();
    const reg = await api()
      .post('/api/v1/identity/births')
      .set(bearer(w.tokens.doctor))
      .send(birthBody(mother.id, { firstName: 'Era' }));
    expect(reg.status).toBe(201);
    expect(reg.body.guardianshipCreated).toBe(false);

    const desk = await api().get('/api/v1/identity/births').set(bearer(w.tokens.reception));
    const row = desk.body.items.find((i: { id: string }) => i.id === reg.body.birthId);
    expect(row).toMatchObject({ newbornFirstName: 'Era', motherId: mother.id });
    expect(row.apgar1).toBeUndefined();
    expect(row.birthWeightGrams).toBeUndefined();
    expect(desk.body.clinical).toBe(false);

    const clinicians = await api().get('/api/v1/identity/births').set(bearer(w.tokens.doctor));
    expect(clinicians.body.items.find((i: { id: string }) => i.id === reg.body.birthId).apgar5).toBe(9);

    const outsider = await api()
      .post('/api/v1/identity/births')
      .set(bearer(w.tokens.outsideDoctor))
      .send(birthBody(mother.id));
    expect(outsider.status).toBe(403);
    for (const token of [w.tokens.reception, w.tokens.pharmacist, w.tokens.director]) {
      const r = await api().post('/api/v1/identity/births').set(bearer(token)).send(birthBody(mother.id));
      expect(r.status).toBe(403);
    }
    const birthOther = await api().get('/api/v1/identity/births').set(bearer(w.tokens.outsideDoctor));
    expect(birthOther.body.items.some((i: { id: string }) => i.id === reg.body.birthId)).toBe(false);
  });

  it('lets maternity unit staff register births for the admitted mother', async () => {
    const nurse = await createUser('NURSE', w.facility.id);
    await db.insert(unitStaff).values({ unitId: maternityId, userId: nurse.id });
    const mother = await createPatient(w.facility.id);
    await db.update(patients).set({ sex: 'FEMALE' }).where(eq(patients.id, mother.id));
    const token = await login(nurse.email);
    expect((await api().post('/api/v1/identity/births').set(bearer(token)).send(birthBody(mother.id))).status).toBe(403);
    await admit(mother.id);
    const ok = await api().post('/api/v1/identity/births').set(bearer(token)).send(birthBody(mother.id, { birthOrder: 1 }));
    expect(ok.status).toBe(201);
    const twin = await api()
      .post('/api/v1/identity/births')
      .set(bearer(token))
      .send(birthBody(mother.id, { birthOrder: 2, sex: 'MALE', birthWeightGrams: 2400 }));
    expect(twin.status).toBe(201);
  });

  it('validates birth details', async () => {
    const mother = await femalePatient();
    const cases = [
      { apgar1: 11 },
      { apgar5: -1 },
      { birthWeightGrams: 100 },
      { gestationalWeeks: 50 },
      { gestationalDays: 7 },
      { bornAt: new Date(Date.now() + 3_600_000).toISOString() },
      { deliveryType: 'HOME' },
    ];
    for (const c of cases) {
      const r = await api().post('/api/v1/identity/births').set(bearer(w.tokens.doctor)).send(birthBody(mother.id, c));
      expect(r.status, JSON.stringify(c)).toBe(400);
    }
    const male = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await db.update(patients).set({ sex: 'MALE' }).where(eq(patients.id, male.id));
    const r = await api().post('/api/v1/identity/births').set(bearer(w.tokens.doctor)).send(birthBody(male.id));
    expect(r.status).toBe(400);
  });
});

describe('merge with hospital records', () => {
  const merge = (survivorId: string, mergedId: string) =>
    api()
      .post('/api/v1/patient-merges')
      .set(bearer(w.tokens.director))
      .send({ survivorId, mergedId, reason: 'Same person registered twice at the desk' });

  it('moves births with the mother and undoes it exactly', async () => {
    const mother = await femalePatient();
    const reg = await api().post('/api/v1/identity/births').set(bearer(w.tokens.doctor)).send(birthBody(mother.id));
    const survivor = await femalePatient();
    const res = await merge(survivor.id, mother.id);
    expect(res.status).toBe(201);
    const [b] = await db.select().from(births).where(eq(births.id, reg.body.birthId));
    expect(b!.motherPatientId).toBe(survivor.id);

    const [m] = await db.select().from(patientMerges).where(eq(patientMerges.mergedId, mother.id));
    expect(m!.movedRows['births.mother_patient_id']).toEqual([reg.body.birthId]);
    const undo = await api()
      .post(`/api/v1/patient-merges/${m!.id}/unmerge`)
      .set(bearer(w.tokens.director))
      .send({ reason: 'Merged the wrong person by mistake' });
    expect(undo.status).toBe(200);
    const [b2] = await db.select().from(births).where(eq(births.id, reg.body.birthId));
    expect(b2!.motherPatientId).toBe(mother.id);
  });

  it('refuses to merge a mother with her baby, or two records that are both in hospital', async () => {
    const mother = await femalePatient();
    const reg = await api().post('/api/v1/identity/births').set(bearer(w.tokens.doctor)).send(birthBody(mother.id));
    expect((await merge(mother.id, reg.body.newborn.id)).status).toBe(409);

    const a = await femalePatient();
    const b = await femalePatient();
    await admit(a.id);
    await admit(b.id);
    const res = await merge(a.id, b.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/active hospital stay/);

    const c = await femalePatient();
    const d = await femalePatient();
    const [ed] = await db
      .insert(careUnits)
      .values({ facilityId: w.facility.id, name: 'Emergency', code: `ED${Date.now() % 1000}`, type: 'EMERGENCY' })
      .returning();
    for (const pid of [c.id, d.id]) {
      await db.insert(edVisits).values({
        patientId: pid,
        facilityId: w.facility.id,
        unitId: ed!.id,
        arrivalMode: 'WALK_IN',
        chiefComplaint: 'Chest pain',
        registeredById: w.users.reception.id,
      });
    }
    const res2 = await merge(c.id, d.id);
    expect(res2.status).toBe(409);
    expect(res2.body.error.message).toMatch(/emergency/);
  });
});
