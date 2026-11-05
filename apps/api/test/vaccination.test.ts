import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  careAssignments,
  guardianships,
  immunizations,
  notifications,
  patients,
  vaccineSchedule,
} from '../src/db/schema.js';
import { DEFAULT_SCHEDULE } from '../src/modules/vaccination/calendar.js';
import { runVaccinationRemindersOnce } from '../src/modules/vaccination/vaccination.service.js';
import {
  api,
  bearer,
  createFacility,
  createUser,
  createWorld,
  login,
  nextNationalId,
} from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const items = new Map<string, string>(); // code → schedule id

beforeAll(async () => {
  w = await createWorld();
  await db.insert(vaccineSchedule).values(DEFAULT_SCHEDULE).onConflictDoNothing();
  for (const s of await db.select().from(vaccineSchedule)) items.set(s.code, s.id);
});

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function child(
  ageDays: number,
  opts: { facilityId?: string; userId?: string; careTeam?: boolean } = {},
) {
  const [row] = await db
    .insert(patients)
    .values({
      nationalId: nextNationalId(),
      firstName: 'Fëmija',
      lastName: `Test${Math.random().toString(36).slice(2, 7)}`,
      dateOfBirth: isoDaysAgo(ageDays),
      sex: 'MALE',
      primaryFacilityId: opts.facilityId ?? w.facility.id,
      userId: opts.userId ?? null,
    })
    .returning();
  if (opts.careTeam !== false) {
    await db.insert(careAssignments).values({ patientId: row!.id, doctorId: w.users.doctor.id });
  }
  return row!;
}

async function guardian(
  patientId: string,
  userId: string,
  scope: 'FULL' | 'APPOINTMENTS' = 'FULL',
) {
  await db.insert(guardianships).values({
    patientId,
    guardianUserId: userId,
    relationship: 'PARENT',
    scope,
    evidence: 'Certifikatë lindjeje (test)',
    verifiedById: w.users.reception.id,
    validUntil: new Date(Date.now() + 10 * 365 * 86_400_000),
  });
}

const status = (patientId: string, headers: Record<string, string>) =>
  api().get(`/api/v1/vaccination/patients/${patientId}/status`).set(headers);
const stateOf = (body: { doses: { code: string; state: string }[] }, code: string) =>
  body.doses.find((d) => d.code === code)?.state;

describe('national schedule', () => {
  it('is readable by everyone and editable by the Ministry only', async () => {
    const list = await api().get('/api/v1/vaccination/schedule').set(bearer(w.tokens.patient));
    expect(list.status).toBe(200);
    expect(list.body.items.map((i: { code: string }) => i.code)).toContain('MMR_1');

    const body = {
      code: 'ROTA_1',
      vaccine: 'Rotavirus',
      doseNumber: 1,
      recommendedAgeDays: 61,
      overdueAgeDays: 105,
    };
    expect(
      (await api().post('/api/v1/vaccination/schedule').set(bearer(w.tokens.doctor)).send(body))
        .status,
    ).toBe(403);
    const created = await api()
      .post('/api/v1/vaccination/schedule')
      .set(bearer(w.tokens.ministry))
      .send({ ...body, isActive: false });
    expect(created.status).toBe(201);
    const bad = await api()
      .patch(`/api/v1/vaccination/schedule/${created.body.id}`)
      .set(bearer(w.tokens.ministry))
      .send({ overdueAgeDays: 10 });
    expect(bad.status).toBe(400);
    const ok = await api()
      .patch(`/api/v1/vaccination/schedule/${created.body.id}`)
      .set(bearer(w.tokens.ministry))
      .send({ description: 'Rotavirus, oral' });
    expect(ok.status).toBe(200);
    expect(ok.body.description).toBe('Rotavirus, oral');
  });
});

describe('child status and recording', () => {
  it('computes given, due, overdue, upcoming and not applicable doses from the date of birth', async () => {
    const baby = await child(75); // ~2.5 months
    const res = await status(baby.id, bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    expect(res.body.clinical).toBe(true);
    expect(stateOf(res.body, 'BCG')).toBe('OVERDUE'); // overdue after ~2 months
    expect(stateOf(res.body, 'HEPB_0')).toBe('NOT_APPLICABLE'); // birth dose window passed
    expect(stateOf(res.body, 'HEXA_1')).toBe('DUE');
    expect(stateOf(res.body, 'HEXA_2')).toBe('UPCOMING');
    expect(stateOf(res.body, 'MMR_1')).toBe('UPCOMING');
    const mmr = res.body.doses.find((d: { code: string }) => d.code === 'MMR_1');
    expect(mmr.dueDate > isoDaysAgo(0)).toBe(true);
    expect(res.body.nextDueDate <= isoDaysAgo(0)).toBe(true);

    const recorded = await api()
      .post(`/api/v1/vaccination/patients/${baby.id}/doses`)
      .set(bearer(w.tokens.doctor))
      .send({ scheduleItemId: items.get('HEXA_1'), lotNumber: 'L123', site: 'Kofsha e majtë' });
    expect(recorded.status).toBe(201);
    expect(recorded.body).toMatchObject({ vaccine: 'DTaP-IPV-Hib-HepB', doseNumber: 1 });
    const again = await api()
      .post(`/api/v1/vaccination/patients/${baby.id}/doses`)
      .set(bearer(w.tokens.doctor))
      .send({ scheduleItemId: items.get('HEXA_1') });
    expect(again.status).toBe(409);
    const after = await status(baby.id, bearer(w.tokens.doctor));
    expect(stateOf(after.body, 'HEXA_1')).toBe('GIVEN');
  });

  it('counts unlinked vaccinations by name and dose, and can link them explicitly', async () => {
    const toddler = await child(400);
    const [byName] = await db
      .insert(immunizations)
      .values({
        patientId: toddler.id,
        vaccine: 'MMR',
        doseNumber: 1,
        administeredAt: new Date(Date.now() - 20 * 86_400_000),
        administeredById: w.users.doctor.id,
        facilityId: w.facility.id,
      })
      .returning();
    const res = await status(toddler.id, bearer(w.tokens.doctor));
    expect(stateOf(res.body, 'MMR_1')).toBe('GIVEN');
    const [other] = await db
      .insert(immunizations)
      .values({
        patientId: toddler.id,
        vaccine: 'Pneumokok',
        doseNumber: 1,
        administeredAt: new Date(Date.now() - 300 * 86_400_000),
        administeredById: w.users.doctor.id,
        facilityId: w.facility.id,
      })
      .returning();
    const linked = await api()
      .post(`/api/v1/vaccination/patients/${toddler.id}/link`)
      .set(bearer(w.tokens.doctor))
      .send({ immunizationId: other!.id, scheduleItemId: items.get('PCV_1') });
    expect(linked.status).toBe(200);
    expect(stateOf((await status(toddler.id, bearer(w.tokens.doctor))).body, 'PCV_1')).toBe(
      'GIVEN',
    );
    // MMR 1 is already covered by the first record.
    const dup = await api()
      .post(`/api/v1/vaccination/patients/${toddler.id}/link`)
      .set(bearer(w.tokens.doctor))
      .send({ immunizationId: other!.id, scheduleItemId: items.get('MMR_1') });
    expect(dup.status).toBe(409);
    expect(byName).toBeTruthy();
  });

  it('lets guardians see their child, reception only which doses are due, and refuses others', async () => {
    const kid = await child(200);
    const parent = await createUser('PATIENT');
    const parentToken = await login(parent.email);
    await guardian(kid.id, parent.id);
    const asParent = await status(kid.id, { ...bearer(parentToken), 'X-Acting-For': kid.id });
    expect(asParent.status).toBe(200);
    expect(asParent.body.clinical).toBe(true);

    const rec = await status(kid.id, bearer(w.tokens.reception));
    expect(rec.status).toBe(200);
    expect(rec.body.clinical).toBe(false);
    expect(JSON.stringify(rec.body)).not.toContain('given');
    expect(rec.body.doses[0]).not.toHaveProperty('description');

    const otherFacility = await createFacility();
    const outsideReception = await createUser('RECEPTION', otherFacility.id);
    expect((await status(kid.id, bearer(await login(outsideReception.email)))).status).toBe(403);
    expect((await status(kid.id, bearer(w.tokens.pharmacist))).status).toBe(403);
    expect(
      (
        await api()
          .post(`/api/v1/vaccination/patients/${kid.id}/doses`)
          .set(bearer(w.tokens.reception))
          .send({ scheduleItemId: items.get('MMR_1') })
      ).status,
    ).toBe(403);
  });
});

describe('facility due list', () => {
  it('lists children of the facility with overdue doses first, and never adults', async () => {
    const overdue = await child(500); // ~16 months: MMR_1 overdue
    const due = await child(65, { careTeam: false }); // 2-month doses due
    const otherFacility = await createFacility();
    const elsewhere = await child(500, { facilityId: otherFacility.id, careTeam: false });
    const res = await api().get('/api/v1/vaccination/due?pageSize=100').set(bearer(w.tokens.nurse));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((c: { patient: { id: string } }) => c.patient.id);
    expect(ids).toContain(overdue.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(elsewhere.id);
    expect(ids).not.toContain(w.patient.id); // adult
    expect(ids.indexOf(overdue.id)).toBeLessThan(ids.indexOf(due.id));

    const onlyOverdue = await api()
      .get('/api/v1/vaccination/due?status=OVERDUE&pageSize=100')
      .set(bearer(w.tokens.reception));
    expect(onlyOverdue.status).toBe(200);
    for (const c of onlyOverdue.body.items) {
      expect(c.doses.every((d: { state: string }) => d.state === 'OVERDUE')).toBe(true);
    }
    expect(
      (await api().get('/api/v1/vaccination/due').set(bearer(w.tokens.pharmacist))).status,
    ).toBe(403);
  });
});

describe('reminders', () => {
  it('reminds guardians once per dose and kind, and the child only from 16', async () => {
    const parent = await createUser('PATIENT');
    const kidUser = await createUser('PATIENT');
    const kid = await child(62, { userId: kidUser.id }); // 2-month doses just due
    await guardian(kid.id, parent.id, 'APPOINTMENTS');
    const teenUser = await createUser('PATIENT');
    const teen = await child(Math.round(16.2 * 365.25), { userId: teenUser.id }); // Td overdue

    await runVaccinationRemindersOnce();
    const parentNotes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, parent.id), eq(notifications.type, 'vaccination')));
    expect(parentNotes.length).toBeGreaterThanOrEqual(2); // HEXA_1 and PCV_1 at least
    expect(parentNotes.every((n) => n.title.includes('(family member)'))).toBe(true);
    expect(parentNotes.some((n) => n.title.includes('DTaP-IPV-Hib-HepB'))).toBe(true);
    const kidNotes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, kidUser.id));
    expect(kidNotes).toHaveLength(0);
    const teenNotes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, teenUser.id), eq(notifications.type, 'vaccination')));
    expect(teenNotes.some((n) => n.title.startsWith('A vaccination is overdue'))).toBe(true);

    await runVaccinationRemindersOnce();
    const again = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, parent.id), eq(notifications.type, 'vaccination')));
    expect(again).toHaveLength(parentNotes.length);
    expect(teen.id).toBeTruthy();
  });
});

describe('coverage', () => {
  it('reports coverage by facility with small-cell suppression', async () => {
    const big = await createFacility();
    const small = await createFacility();
    for (let i = 0; i < 6; i++) {
      const c = await child(450, { facilityId: big.id, careTeam: false });
      if (i < 5) {
        await db.insert(immunizations).values({
          patientId: c.id,
          vaccine: 'MMR',
          doseNumber: 1,
          scheduleItemId: items.get('MMR_1'),
          administeredAt: new Date(Date.now() - 60 * 86_400_000),
          administeredById: w.users.doctor.id,
          facilityId: big.id,
        });
      }
    }
    for (let i = 0; i < 2; i++) await child(450, { facilityId: small.id, careTeam: false });

    const res = await api()
      .get('/api/v1/vaccination/coverage?cohort=12-23m')
      .set(bearer(w.tokens.ministry));
    expect(res.status).toBe(200);
    const bigRow = res.body.rows.find((r: { facilityId: string }) => r.facilityId === big.id);
    expect(bigRow.children).toBe(6);
    const mmr = bigRow.doses.find((d: { code: string }) => d.code === 'MMR_1');
    expect(mmr).toMatchObject({ vaccinated: 5, percent: 83.3 });
    const hexa = bigRow.doses.find((d: { code: string }) => d.code === 'HEXA_3');
    expect(hexa).toMatchObject({ vaccinated: null, percent: 0 });
    const smallRow = res.body.rows.find((r: { facilityId: string }) => r.facilityId === small.id);
    expect(smallRow).toMatchObject({ children: null, suppressed: true });
    expect(smallRow.doses.every((d: { percent: number | null }) => d.percent === null)).toBe(true);

    const director = await api().get('/api/v1/vaccination/coverage').set(bearer(w.tokens.director));
    expect(director.status).toBe(200);
    expect(director.body.scope).toBe('FACILITY');
    expect(
      director.body.rows.every((r: { facilityId: string }) => r.facilityId === w.facility.id),
    ).toBe(true);
    expect(
      (await api().get('/api/v1/vaccination/coverage').set(bearer(w.tokens.doctor))).status,
    ).toBe(403);
  });
});
