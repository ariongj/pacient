import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { beds, careAssignments, careUnits, edVisits, unitStaff } from '../src/db/schema.js';
import { api, bearer, createPatient, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let ward: { id: string };
let ward2: { id: string };
let edUnit: { id: string };
let bedIds: string[];
let ward2Beds: string[];

const dir = () => bearer(w.tokens.director);

beforeAll(async () => {
  w = await createWorld();
  const a = await api()
    .post('/api/v1/hospital/units')
    .set(dir())
    .send({ name: 'Interna A', code: 'int-a', type: 'GENERAL_WARD' });
  expect(a.status).toBe(201);
  ward = a.body;
  const b = await api()
    .post('/api/v1/hospital/units')
    .set(dir())
    .send({ name: 'Kirurgjia', code: 'KIR', type: 'SURGICAL_WARD' });
  ward2 = b.body;
  const e = await api()
    .post('/api/v1/hospital/units')
    .set(dir())
    .send({ name: 'Emergjenca', code: 'EMG', type: 'EMERGENCY' });
  edUnit = e.body;
  const created = await api()
    .post(`/api/v1/hospital/units/${ward.id}/beds`)
    .set(dir())
    .send({ prefix: 'A', from: 1, to: 6 });
  expect(created.status).toBe(201);
  bedIds = created.body.items.map((x: { id: string }) => x.id);
  const created2 = await api()
    .post(`/api/v1/hospital/units/${ward2.id}/beds`)
    .set(dir())
    .send({ labels: ['K1', 'K2'] });
  ward2Beds = created2.body.items.map((x: { id: string }) => x.id);
});

describe('units, beds and staff', () => {
  it('only the director configures units, codes are unique, emergency has no beds', async () => {
    expect(
      (
        await api()
          .post('/api/v1/hospital/units')
          .set(bearer(w.tokens.doctor))
          .send({ name: 'X', code: 'X', type: 'ICU' })
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .post('/api/v1/hospital/units')
          .set(dir())
          .send({ name: 'Dup', code: 'INT-A', type: 'ICU' })
      ).status,
    ).toBe(409);
    expect(
      (
        await api()
          .post(`/api/v1/hospital/units/${edUnit.id}/beds`)
          .set(dir())
          .send({ labels: ['E1'] })
      ).status,
    ).toBe(400);
    expect(
      (
        await api()
          .patch(`/api/v1/hospital/units/${ward.id}`)
          .set(bearer(w.tokens.otherDirector))
          .send({ name: 'Hack' })
      ).status,
    ).toBe(404);
  });

  it('lists units of my facility with beds and occupancy (contract for the emergency board)', async () => {
    const res = await api()
      .get('/api/v1/hospital/units?type=GENERAL_WARD,SURGICAL_WARD')
      .set(bearer(w.tokens.nurse));
    expect(res.status).toBe(200);
    const a = res.body.items.find((u: { id: string }) => u.id === ward.id);
    expect(a).toMatchObject({ code: 'INT-A', total: 6, occupied: 0, available: 6 });
    expect(a.beds[0]).toMatchObject({ label: 'A1', status: 'AVAILABLE' });
    expect(res.body.items.some((u: { type: string }) => u.type === 'EMERGENCY')).toBe(false);
    expect((await api().get('/api/v1/hospital/units').set(bearer(w.tokens.patient))).status).toBe(
      403,
    );
    const other = await api().get('/api/v1/hospital/units').set(bearer(w.tokens.outsideDoctor));
    expect(other.body.items).toEqual([]);
  });

  it('assigns facility staff to units', async () => {
    const res = await api()
      .post(`/api/v1/hospital/units/${ward.id}/staff`)
      .set(dir())
      .send({ userId: w.users.nurse.id });
    expect(res.status).toBe(201);
    const outsider = await api()
      .post(`/api/v1/hospital/units/${ward.id}/staff`)
      .set(dir())
      .send({ userId: w.users.outsideDoctor.id });
    expect(outsider.status).toBe(400);
    const list = await api().get(`/api/v1/hospital/units/${ward.id}/staff`).set(dir());
    expect(list.body.items.map((s: { userId: string }) => s.userId)).toContain(w.users.nurse.id);
  });
});

describe('admission, transfer and discharge', () => {
  let admissionId: string;

  it('admits a patient of the care team to an available bed', async () => {
    const res = await api().post('/api/v1/hospital/admissions').set(bearer(w.tokens.doctor)).send({
      patientId: w.patient.id,
      unitId: ward.id,
      bedId: bedIds[0],
      source: 'ELECTIVE',
      reason: 'Pneumoni, dispne',
    });
    expect(res.status).toBe(201);
    admissionId = res.body.id;
    const [bed] = await db.select().from(beds).where(eq(beds.id, bedIds[0]!));
    expect(bed!.status).toBe('OCCUPIED');

    const again = await api()
      .post('/api/v1/hospital/admissions')
      .set(bearer(w.tokens.doctor))
      .send({ patientId: w.patient.id, unitId: ward.id, source: 'ELECTIVE', reason: 'Dy herë' });
    expect(again.status).toBe(409);
  });

  it('refuses occupied beds, nurses and doctors without access', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const occupied = await api()
      .post('/api/v1/hospital/admissions')
      .set(bearer(w.tokens.doctor))
      .send({
        patientId: p.id,
        unitId: ward.id,
        bedId: bedIds[0],
        source: 'ELECTIVE',
        reason: 'Test',
      });
    expect(occupied.status).toBe(400);
    const nurse = await api()
      .post('/api/v1/hospital/admissions')
      .set(bearer(w.tokens.nurse))
      .send({ patientId: p.id, unitId: ward.id, source: 'ELECTIVE', reason: 'Test' });
    expect(nurse.status).toBe(403);
    const noAccess = await api()
      .post('/api/v1/hospital/admissions')
      .set(bearer(w.tokens.colleague))
      .send({ patientId: p.id, unitId: ward.id, source: 'ELECTIVE', reason: 'Test' });
    expect(noAccess.status).toBe(403);
    const toEd = await api()
      .post('/api/v1/hospital/admissions')
      .set(bearer(w.tokens.doctor))
      .send({ patientId: p.id, unitId: edUnit.id, source: 'ELECTIVE', reason: 'Test' });
    expect(toEd.status).toBe(400);
  });

  it('shows the board to reception and the director without the clinical reason', async () => {
    const recep = await api().get('/api/v1/hospital/board').set(bearer(w.tokens.reception));
    expect(recep.status).toBe(200);
    const unit = recep.body.units.find((u: { id: string }) => u.id === ward.id);
    const bed = unit.beds.find((b: { id: string }) => b.id === bedIds[0]);
    expect(bed.stay).toMatchObject({ patientId: w.patient.id, reason: null });
    const director = await api().get('/api/v1/hospital/board').set(dir());
    expect(
      director.body.units.find((u: { id: string }) => u.id === ward.id).beds[0].stay.reason,
    ).toBeNull();
    const doctor = await api().get('/api/v1/hospital/board?mine=true').set(bearer(w.tokens.doctor));
    const mine = doctor.body.units.find((u: { id: string }) => u.id === ward.id);
    expect(mine.beds[0].stay).toMatchObject({ reason: 'Pneumoni, dispne', mine: true });
    expect((await api().get('/api/v1/hospital/board').set(bearer(w.tokens.patient))).status).toBe(
      403,
    );
  });

  it('transfers to another ward: the old bed needs cleaning', async () => {
    const res = await api()
      .post(`/api/v1/hospital/admissions/${admissionId}/transfer`)
      .set(bearer(w.tokens.doctor))
      .send({ unitId: ward2.id, bedId: ward2Beds[0], reason: 'Vlerësim kirurgjik' });
    expect(res.status).toBe(200);
    const [oldBed] = await db.select().from(beds).where(eq(beds.id, bedIds[0]!));
    const [newBed] = await db.select().from(beds).where(eq(beds.id, ward2Beds[0]!));
    expect(oldBed!.status).toBe('CLEANING');
    expect(newBed!.status).toBe('OCCUPIED');
    const detail = await api()
      .get(`/api/v1/hospital/admissions/${admissionId}`)
      .set(bearer(w.tokens.doctor));
    expect(detail.body.movements).toHaveLength(2);
    expect(detail.body).toMatchObject({ unitName: 'Kirurgjia', bedLabel: 'K1' });
  });

  it('beds can be cleaned, but an occupied bed cannot be changed by hand', async () => {
    expect(
      (
        await api()
          .patch(`/api/v1/hospital/beds/${bedIds[0]}`)
          .set(bearer(w.tokens.nurse))
          .send({ status: 'AVAILABLE' })
      ).status,
    ).toBe(200);
    expect(
      (
        await api()
          .patch(`/api/v1/hospital/beds/${ward2Beds[0]}`)
          .set(bearer(w.tokens.reception))
          .send({ status: 'AVAILABLE' })
      ).status,
    ).toBe(409);
    expect(
      (
        await api()
          .patch(`/api/v1/hospital/beds/${bedIds[1]}`)
          .set(bearer(w.tokens.doctor))
          .send({ status: 'OUT_OF_SERVICE' })
      ).status,
    ).toBe(403);
  });

  it('drafts, signs and releases the discharge summary; the signed text is immutable', async () => {
    const draft = await api()
      .get(`/api/v1/hospital/admissions/${admissionId}/summary-draft`)
      .set(bearer(w.tokens.doctor));
    expect(draft.status).toBe(200);
    expect(draft.body.dischargeSummary).toContain('Pneumoni, dispne');
    expect(draft.body.dischargeSummary).toContain('DISCHARGE SUMMARY'); // doctor's locale is en
    const saved = await api()
      .put(`/api/v1/hospital/admissions/${admissionId}/summary`)
      .set(bearer(w.tokens.doctor))
      .send({ dischargeSummary: 'Draft text that is long enough' });
    expect(saved.status).toBe(200);

    const discharged = await api()
      .post(`/api/v1/hospital/admissions/${admissionId}/discharge`)
      .set(bearer(w.tokens.doctor))
      .send({
        disposition: 'HOME',
        dischargeSummary: 'Pneumonia treated with antibiotics. Stable on discharge.',
        followUp: 'Family doctor in one week',
      });
    expect(discharged.status).toBe(200);
    expect(discharged.body.status).toBe('DISCHARGED');
    const [bed] = await db.select().from(beds).where(eq(beds.id, ward2Beds[0]!));
    expect(bed!.status).toBe('CLEANING');
    const err = await db
      .execute(sql`UPDATE admissions SET discharge_summary = 'changed' WHERE id = ${admissionId}`)
      .then(() => null)
      .catch((e: Error & { cause?: Error }) => e.cause?.message ?? e.message);
    expect(err).toMatch(/immutable/);

    const before = await api()
      .get(`/api/v1/hospital/patients/${w.patient.id}/admissions`)
      .set(bearer(w.tokens.patient));
    expect(before.status).toBe(200);
    expect(before.body.items[0].dischargeSummary).toBeNull();
    expect(before.body.items[0].movements).toEqual([]);

    expect(
      (
        await api()
          .post(`/api/v1/hospital/admissions/${admissionId}/release`)
          .set(bearer(w.tokens.doctor))
      ).status,
    ).toBe(200);
    const after = await api()
      .get(`/api/v1/hospital/patients/${w.patient.id}/admissions`)
      .set(bearer(w.tokens.patient));
    expect(after.body.items[0].dischargeSummary).toContain('Family doctor in one week');
    const notes = await api().get('/api/v1/notifications').set(bearer(w.tokens.patient));
    expect(
      notes.body.items.some((n: { title: string }) => n.title.includes('discharge letter')),
    ).toBe(true);
  });

  it('keeps outsiders out of the stay', async () => {
    expect(
      (
        await api()
          .get(`/api/v1/hospital/admissions/${admissionId}`)
          .set(bearer(w.tokens.outsideDoctor))
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .get(`/api/v1/hospital/patients/${w.patient.id}/admissions`)
          .set(bearer(w.tokens.otherPatient))
      ).status,
    ).toBe(403);
  });
});

describe('emergency admission and unit-based access', () => {
  it('admits from the emergency department; unit nurses see the patient only while admitted', async () => {
    const p = await createPatient(w.facility.id);
    // The colleague works in the emergency department where the patient is waiting.
    await db.insert(unitStaff).values({ unitId: edUnit.id, userId: w.users.colleague.id });
    const [visit] = await db
      .insert(edVisits)
      .values({
        patientId: p.id,
        facilityId: w.facility.id,
        unitId: edUnit.id,
        arrivalMode: 'AMBULANCE',
        chiefComplaint: 'Dhimbje gjoksi',
        registeredById: w.users.reception.id,
        status: 'IN_TREATMENT',
      })
      .returning();

    // Before admission the ward nurse has no access.
    expect(
      (await api().get(`/api/v1/patients/${p.id}/summary`).set(bearer(w.tokens.nurse))).status,
    ).toBe(403);

    const res = await api()
      .post('/api/v1/hospital/admissions')
      .set(bearer(w.tokens.colleague))
      .send({
        patientId: p.id,
        unitId: ward.id,
        bedId: bedIds[2],
        source: 'ELECTIVE',
        reason: 'Sindrom koronar akut',
        edVisitId: visit!.id,
      });
    expect(res.status).toBe(201);
    expect(res.body.source).toBe('EMERGENCY');
    const [v] = await db.select().from(edVisits).where(eq(edVisits.id, visit!.id));
    expect(v).toMatchObject({ status: 'ADMITTED', admissionId: res.body.id });
    expect(v!.departedAt).not.toBeNull();
    const care = await db.select().from(careAssignments).where(eq(careAssignments.patientId, p.id));
    expect(care.map((c) => c.doctorId)).toContain(w.users.colleague.id);

    // The nurse assigned to the ward now has access.
    expect(
      (await api().get(`/api/v1/patients/${p.id}/summary`).set(bearer(w.tokens.nurse))).status,
    ).toBe(200);

    await api()
      .post(`/api/v1/hospital/admissions/${res.body.id}/discharge`)
      .set(bearer(w.tokens.colleague))
      .send({ disposition: 'HOME', dischargeSummary: 'Stable, discharged home with treatment.' });
    expect(
      (await api().get(`/api/v1/patients/${p.id}/summary`).set(bearer(w.tokens.nurse))).status,
    ).toBe(403);
  });

  it('cancels an admission entered in error within 24 hours and frees the bed', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const res = await api().post('/api/v1/hospital/admissions').set(bearer(w.tokens.doctor)).send({
      patientId: p.id,
      unitId: ward.id,
      bedId: bedIds[3],
      source: 'ELECTIVE',
      reason: 'Gabim',
    });
    expect(res.status).toBe(201);
    const cancel = await api()
      .post(`/api/v1/hospital/admissions/${res.body.id}/cancel`)
      .set(bearer(w.tokens.doctor))
      .send({ reason: 'Pacient i gabuar' });
    expect(cancel.status).toBe(204);
    const [bed] = await db.select().from(beds).where(eq(beds.id, bedIds[3]!));
    expect(bed!.status).toBe('AVAILABLE');
  });

  it('cannot close a unit with patients still admitted', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await api().post('/api/v1/hospital/admissions').set(bearer(w.tokens.doctor)).send({
      patientId: p.id,
      unitId: ward.id,
      bedId: bedIds[4],
      source: 'ELECTIVE',
      reason: 'Vëzhgim',
    });
    const res = await api()
      .patch(`/api/v1/hospital/units/${ward.id}`)
      .set(dir())
      .send({ isActive: false });
    expect(res.status).toBe(409);
    const [u] = await db.select().from(careUnits).where(eq(careUnits.id, ward.id));
    expect(u!.isActive).toBe(true);
  });
});

describe('hospital reports', () => {
  it('reports occupancy, admissions, emergency, births and imaging with suppression', async () => {
    const occ = await api().get('/api/v1/reports/occupancy').set(dir());
    expect(occ.status, JSON.stringify(occ.body)).toBe(200);
    const row = occ.body.rows.find((r: { unitType: string }) => r.unitType === 'GENERAL_WARD');
    expect(row).toMatchObject({ beds: 6 });
    expect(typeof row.occupancyPct).toBe('number');

    const adm = await api().get('/api/v1/reports/admissions').set(dir());
    expect(adm.status, JSON.stringify(adm.body)).toBe(200);
    // Fewer than five admissions in a unit type: patient counts are suppressed.
    const general = adm.body.rows.find((r: { unitType: string }) => r.unitType === 'GENERAL_WARD');
    expect(general).toMatchObject({ suppressed: true, admissions: null });

    for (const name of ['emergency', 'births', 'imaging']) {
      const res = await api().get(`/api/v1/reports/${name}`).set(bearer(w.tokens.ministry));
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(200);
      expect(Array.isArray(res.body.columns)).toBe(true);
    }
    const ed = await api().get('/api/v1/reports/emergency').set(dir());
    for (const r of ed.body.rows) expect(r).not.toHaveProperty('leftUnseen');
    expect((await api().get('/api/v1/reports/occupancy').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
  });
});
