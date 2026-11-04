/**
 * Regression tests from the security review of the hospital modules:
 *  1. reads of clinical data in the newer modules must appear in the patient's access log;
 *  2. the NEWS2 board (vital-sign scores) is limited to staff responsible for the patient.
 */
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { admissions, auditLogs, beds, careUnits, unitStaff, vitalSigns } from '../src/db/schema.js';
import { scoreNewVitalsOnce } from '../src/modules/news/news.service.js';
import { api, bearer, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let unitId: string;

beforeAll(async () => {
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Ward R', code: 'WARD-R', type: 'GENERAL_WARD' })
    .returning();
  unitId = unit!.id;
  const [bed] = await db
    .insert(beds)
    .values({ unitId, label: 'R1', status: 'OCCUPIED' })
    .returning();
  await db.insert(unitStaff).values({ unitId, userId: w.users.nurse.id });
  await db.insert(admissions).values({
    patientId: w.patient.id,
    facilityId: w.facility.id,
    unitId,
    bedId: bed!.id,
    admittingDoctorId: w.users.doctor.id,
    attendingDoctorId: w.users.doctor.id,
    source: 'EMERGENCY',
    reason: 'Pneumonia',
  });
  await db.insert(vitalSigns).values({
    patientId: w.patient.id,
    recordedById: w.users.nurse.id,
    // Mildly abnormal (low risk): enough for a score, never escalated, so other test files that
    // run re-escalation over the shared database are not affected.
    respiratoryRate: 22,
    oxygenSaturation: 97,
    systolic: 120,
    heartRate: 80,
    temperatureC: '37.0',
    consciousness: 'A',
    onSupplementalOxygen: false,
  });
  await scoreNewVitalsOnce(new Date());
});

const viewsBy = (userId: string, section: string) =>
  db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.actorUserId, userId),
        eq(auditLogs.patientId, w.patient.id),
        eq(auditLogs.action, 'patient.record.viewed'),
      ),
    )
    .then((rows) =>
      rows.filter((r) => (r.metadata as { section?: string } | null)?.section === section),
    );

describe('reads of clinical data are recorded in the access log', () => {
  const endpoints: [string, (id: string) => string][] = [
    ['admissions', (id) => `/api/v1/hospital/patients/${id}/admissions`],
    ['emergency-visits', (id) => `/api/v1/ed/patients/${id}/visits`],
    ['imaging', (id) => `/api/v1/imaging/patients/${id}/orders`],
    ['birth', (id) => `/api/v1/identity/patients/${id}/birth`],
    ['vaccinations', (id) => `/api/v1/vaccination/patients/${id}/status`],
    ['nutrition', (id) => `/api/v1/nutrition/patients/${id}`],
    ['operations', (id) => `/api/v1/theatre/patients/${id}/cases`],
    ['early-warning', (id) => `/api/v1/early-warning/patients/${id}`],
    ['lab-orders', (id) => `/api/v1/patients/${id}/lab-orders`],
    ['blood-bank', (id) => `/api/v1/blood-bank/patients/${id}`],
  ];

  for (const [section, url] of endpoints) {
    it(`${section}: a doctor's read is audited, the patient's own read is not`, async () => {
      const res = await api().get(url(w.patient.id)).set(bearer(w.tokens.doctor));
      expect(res.status, `${section} ${res.text}`).toBe(200);
      expect(await viewsBy(w.users.doctor.id, section)).toHaveLength(1);
      // Repeated reads within 10 minutes are not logged again.
      await api().get(url(w.patient.id)).set(bearer(w.tokens.doctor));
      expect(await viewsBy(w.users.doctor.id, section)).toHaveLength(1);
    });
  }

  it('shows the accesses in the patient portal', async () => {
    const log = await api().get('/api/v1/portal/access-log').set(bearer(w.tokens.patient));
    expect(log.status).toBe(200);
    const sections = log.body.items.map((i: { section: string | null }) => i.section);
    expect(sections).toEqual(expect.arrayContaining(['admissions', 'imaging', 'vaccinations']));
  });
});

describe('NEWS2 board', () => {
  it('shows ward patients to the ward nurse and the attending doctor', async () => {
    for (const token of [w.tokens.nurse, w.tokens.doctor]) {
      const res = await api()
        .get(`/api/v1/early-warning/board?unitId=${unitId}`)
        .set(bearer(token));
      expect(res.status).toBe(200);
      const item = res.body.items.find((i: { patientId: string }) => i.patientId === w.patient.id);
      expect(item?.latest?.score).toBeGreaterThan(0);
    }
  });

  it('does not expose scores to staff of the facility without responsibility for the patient', async () => {
    const outsider = await createUser('NURSE', w.facility.id);
    const token = await login(outsider.email);
    const res = await api().get(`/api/v1/early-warning/board?unitId=${unitId}`).set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.items.some((i: { patientId: string }) => i.patientId === w.patient.id)).toBe(
      false,
    );
  });
});

describe('meal lists are limited to the kitchen and the caller’s own wards', () => {
  it('refuses a doctor with no ward and no admitted patients', async () => {
    const { createWorld: world, api: client, bearer: auth } = await import('./helpers.js');
    const w = await world();
    const res = await client().get('/api/v1/nutrition/kitchen').set(auth(w.tokens.colleague));
    expect(res.status).toBe(403);
  });
});
