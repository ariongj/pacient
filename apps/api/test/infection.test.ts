import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  antimicrobialApprovals,
  auditLogs,
  beds,
  careUnits,
  labResults,
  notifications,
  unitStaff,
} from '../src/db/schema.js';
import { matchRestrictedAgent } from '../src/modules/infection/definitions.js';
import { per1000, runInfectionWorkerOnce } from '../src/modules/infection/infection.service.js';
import { SMALL_CELL_THRESHOLD } from '../src/modules/stats/stats.service.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let wardId: string;
let icDoctor: { id: string; token: string };
const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const doctor = () => bearer(w.tokens.doctor);

async function admit(patientId: string, daysAgo: number, bedLabel?: string) {
  let bedId: string | null = null;
  if (bedLabel) {
    const [b] = await db
      .insert(beds)
      .values({ unitId: wardId, label: bedLabel, status: 'OCCUPIED' })
      .returning();
    bedId = b!.id;
  }
  const [a] = await db
    .insert(admissions)
    .values({
      patientId,
      facilityId: w.facility.id,
      unitId: wardId,
      bedId,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'EMERGENCY',
      reason: 'Pneumoni',
      admittedAt: new Date(Date.now() - daysAgo * DAY),
    })
    .returning();
  return a!;
}

const prescribe = (patientId: string, body: Record<string, unknown>) =>
  api()
    .post(`/api/v1/patients/${patientId}/prescriptions`)
    .set(doctor())
    .send({
      dosage: '1 g',
      frequency: 'every 8 hours',
      route: 'intravenous',
      startDate: today(),
      ...body,
    });

beforeAll(async () => {
  w = await createWorld();
  const [ward] = await db
    .insert(careUnits)
    .values({
      facilityId: w.facility.id,
      name: 'Interna IC',
      code: `IC${Date.now() % 1e6}`,
      type: 'GENERAL_WARD',
    })
    .returning();
  wardId = ward!.id;
  const [ic] = await db
    .insert(careUnits)
    .values({
      facilityId: w.facility.id,
      name: 'Njësia e kontrollit të infeksioneve',
      code: `KI${Date.now() % 1e6}`,
      type: 'INFECTION_CONTROL',
    })
    .returning();
  const user = await createUser('DOCTOR', w.facility.id);
  await db.insert(unitStaff).values({ unitId: ic!.id, userId: user.id });
  icDoctor = { id: user.id, token: await login(user.email) };
  await admit(w.patient.id, 10, 'A1');
});

describe('restricted antibiotics', () => {
  it('recognises reserve agents by name and ATC code, and oral vancomycin is not restricted', () => {
    expect(matchRestrictedAgent({ medication: 'Meropenem 1 g' })?.code).toBe('MEROPENEM');
    expect(matchRestrictedAgent({ medication: 'X', atcCode: 'J01XB01' })?.code).toBe('COLISTIN');
    expect(
      matchRestrictedAgent({ medication: 'Vankomicinë 1 g', route: 'intravenous' })?.code,
    ).toBe('VANCOMYCIN');
    expect(matchRestrictedAgent({ medication: 'Vancomycin 125 mg', route: 'oral' })).toBeNull();
    expect(matchRestrictedAgent({ medication: 'Amoxicillin 500 mg' })).toBeNull();
  });

  let approvalId: string;

  it('requires the indication and justification, records the request and never delays the prescription', async () => {
    const missing = await prescribe(w.patient.id, { medication: 'Meropenem 1 g' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('ANTIMICROBIAL_APPROVAL_REQUIRED');

    const ordinary = await prescribe(w.patient.id, { medication: 'Ceftriaxone 2 g' });
    expect(ordinary.status).toBe(201);
    expect(ordinary.body.antimicrobialApproval).toBeNull();

    const res = await prescribe(w.patient.id, {
      medication: 'Meropenem 1 g',
      antimicrobial: {
        indication: 'Sepsë me burim urinar',
        justification: 'ESBL Klebsiella në urokulturë, rezistente ndaj ceftriaksonit',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.antimicrobialApproval).toMatchObject({
      agent: 'MEROPENEM',
      status: 'REQUESTED',
    });
    const [a] = await db
      .select()
      .from(antimicrobialApprovals)
      .where(eq(antimicrobialApprovals.prescriptionId, res.body.id));
    expect(a).toMatchObject({ status: 'REQUESTED', facilityId: w.facility.id });
    const hours = (a!.reviewDueAt!.getTime() - a!.createdAt.getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(72, 0);
    approvalId = a!.id;
    // The pharmacist and infection control are asked, without patient details.
    const asked = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, w.users.pharmacist.id), eq(notifications.type, 'stewardship')),
      );
    expect(asked).toHaveLength(1);
    expect(asked[0]!.title).not.toMatch(/meropenem|Klebsiella/i);
    const icAsked = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, icDoctor.id), eq(notifications.type, 'stewardship')));
    expect(icAsked).toHaveLength(1);
  });

  it('lets only the stewardship team of the facility decide, never the requester', async () => {
    const url = `/api/v1/infection/antimicrobials/${approvalId}/decision`;
    expect((await api().post(url).set(doctor()).send({ decision: 'APPROVED' })).status).toBe(403);
    expect(
      (await api().post(url).set(bearer(w.tokens.nurse)).send({ decision: 'APPROVED' })).status,
    ).toBe(403);
    expect(
      (await api().post(url).set(bearer(w.tokens.outsidePharmacist)).send({ decision: 'APPROVED' }))
        .status,
    ).toBe(404);
    expect(
      (await api().post(url).set(bearer(w.tokens.pharmacist)).send({ decision: 'DECLINED' }))
        .status,
    ).toBe(400);
    const ok = await api()
      .post(url)
      .set(bearer(w.tokens.pharmacist))
      .send({ decision: 'APPROVED' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('APPROVED');
    expect(
      (
        await api()
          .post(url)
          .set(bearer(icDoctor.token))
          .send({ decision: 'DECLINED', note: 'Nuk ka indikacion' })
      ).status,
    ).toBe(409);
    const told = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, w.users.doctor.id), eq(notifications.type, 'stewardship')),
      );
    expect(told.some((n) => /approved/.test(n.title))).toBe(true);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'infection.antimicrobial_decided'),
          eq(auditLogs.resourceId, approvalId),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it('flags the 72-hour review when overdue, reminds the prescriber once, and records the outcome', async () => {
    await db
      .update(antimicrobialApprovals)
      .set({ reviewDueAt: new Date(Date.now() - 3_600_000) })
      .where(eq(antimicrobialApprovals.id, approvalId));
    const queue = await api().get('/api/v1/infection/stewardship').set(bearer(w.tokens.pharmacist));
    expect(queue.status).toBe(200);
    expect(queue.body.scope).toBe('team');
    expect(queue.body.reviewsOverdue.map((r: { id: string }) => r.id)).toContain(approvalId);
    const mine = await api().get('/api/v1/infection/stewardship').set(doctor());
    expect(mine.body.scope).toBe('mine');
    expect(
      (await api().get('/api/v1/infection/stewardship').set(bearer(w.tokens.nurse))).status,
    ).toBe(403);

    await runInfectionWorkerOnce();
    await runInfectionWorkerOnce();
    const reminders = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.doctor.id),
          sql`${notifications.link} LIKE ${`%review=${approvalId}`}`,
        ),
      );
    expect(reminders).toHaveLength(1);

    const url = `/api/v1/infection/antimicrobials/${approvalId}/review`;
    expect(
      (await api().post(url).set(bearer(w.tokens.outsideDoctor)).send({ outcome: 'STOP' })).status,
    ).toBe(404);
    const reviewed = await api().post(url).set(doctor()).send({ outcome: 'NARROW' });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.reviewOutcome).toBe('NARROW');
    expect((await api().post(url).set(doctor()).send({ outcome: 'STOP' })).status).toBe(409);

    const stats = await api()
      .get('/api/v1/infection/stewardship/stats')
      .set(bearer(w.tokens.director));
    expect(stats.status).toBe(200);
    const row = stats.body.facilities.find(
      (f: { facility: string }) => f.facility === w.facility.name,
    );
    // Reviewed within a day of the due time counts as on time.
    expect(row).toMatchObject({ starts: 1, approvalRate: 100, reviewCompliance: 100 });
    expect(row.startsPer1000).toBe(per1000(1, row.patientDays));
  });
});

describe('isolation', () => {
  let orderId: string;

  it('starts precautions once per type, shows them on the bed board and ends them with a reason', async () => {
    const url = `/api/v1/infection/patients/${w.patient.id}/isolations`;
    const res = await api().post(url).set(doctor()).send({ precaution: 'CONTACT', reason: 'MRSA' });
    expect(res.status).toBe(201);
    orderId = res.body.id;
    expect(
      (await api().post(url).set(doctor()).send({ precaution: 'CONTACT', reason: 'MRSA' })).status,
    ).toBe(409);
    expect(
      (
        await api()
          .post(url)
          .set(bearer(w.tokens.outsideDoctor))
          .send({ precaution: 'AIRBORNE', reason: 'TB' })
      ).status,
    ).toBe(403);

    const board = await api().get('/api/v1/hospital/board').set(bearer(w.tokens.reception));
    const stay = board.body.units
      .flatMap((u: { beds: { stay: { patientId: string } | null }[] }) => u.beds)
      .map((b: { stay: unknown }) => b.stay)
      .find((s: { patientId: string } | null) => s?.patientId === w.patient.id);
    expect(stay.isolation).toEqual([{ precaution: 'CONTACT', reason: null }]);
    const clinical = await api().get('/api/v1/hospital/board').set(doctor());
    const stay2 = clinical.body.units
      .flatMap((u: { beds: { stay: { patientId: string } | null }[] }) => u.beds)
      .map((b: { stay: unknown }) => b.stay)
      .find((s: { patientId: string } | null) => s?.patientId === w.patient.id);
    expect(stay2.isolation).toEqual([{ precaution: 'CONTACT', reason: 'MRSA' }]);
  });

  it('lets infection control act for any admitted patient and lists isolations by role', async () => {
    const other = await createPatient(w.facility.id);
    await admit(other.id, 3, 'A2');
    const started = await api()
      .post(`/api/v1/infection/patients/${other.id}/isolations`)
      .set(bearer(icDoctor.token))
      .send({ precaution: 'AIRBORNE', reason: 'Dyshim për TBC' });
    expect(started.status).toBe(201);
    // Not admitted here: infection control has no special access.
    const outpatient = await createPatient(w.facility.id);
    expect(
      (
        await api()
          .post(`/api/v1/infection/patients/${outpatient.id}/isolations`)
          .set(bearer(icDoctor.token))
          .send({ precaution: 'CONTACT', reason: 'Kontakt' })
      ).status,
    ).toBe(403);

    const ic = await api().get('/api/v1/infection/isolations').set(bearer(icDoctor.token));
    expect(ic.body.items.map((i: { patientId: string }) => i.patientId)).toEqual(
      expect.arrayContaining([w.patient.id, other.id]),
    );
    const nurse = await api().get('/api/v1/infection/isolations').set(bearer(w.tokens.nurse));
    expect(nurse.body.items).toHaveLength(0);
    const director = await api().get('/api/v1/infection/isolations').set(bearer(w.tokens.director));
    expect(director.body.scope).toBe('counts');
    expect(JSON.stringify(director.body)).not.toMatch(/MRSA|TBC/);

    const chart = await api()
      .get(`/api/v1/infection/patients/${other.id}`)
      .set(bearer(icDoctor.token));
    expect(chart.status).toBe(200);
    expect(chart.body.activeIsolations[0].precaution).toBe('AIRBORNE');
    expect(
      (
        await api()
          .get(`/api/v1/infection/patients/${other.id}`)
          .set(bearer(w.tokens.outsideDoctor))
      ).status,
    ).toBe(403);
  });

  it('ends precautions once, with a reason', async () => {
    const url = `/api/v1/infection/isolations/${orderId}/end`;
    expect((await api().post(url).set(doctor()).send({})).status).toBe(400);
    expect(
      (await api().post(url).set(doctor()).send({ reason: 'Tre kultura negative' })).status,
    ).toBe(200);
    expect(
      (await api().post(url).set(doctor()).send({ reason: 'Tre kultura negative' })).status,
    ).toBe(409);
    const chart = await api().get(`/api/v1/infection/patients/${w.patient.id}`).set(doctor());
    expect(chart.body.activeIsolations).toHaveLength(0);
    expect(chart.body.isolationHistory[0].endReason).toBe('Tre kultura negative');
  });
});

describe('healthcare-associated infections', () => {
  it('records a suspected infection on the ward of the stay, confirmed only by infection control', async () => {
    const res = await api()
      .post(`/api/v1/infection/patients/${w.patient.id}/hai`)
      .set(doctor())
      .send({
        type: 'CAUTI',
        organism: 'E. coli',
        onsetAt: new Date(Date.now() - 2 * DAY).toISOString(),
        deviceRelated: true,
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'SUSPECTED', unitId: wardId });
    const told = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, icDoctor.id), eq(notifications.type, 'infection')));
    expect(told.length).toBeGreaterThan(0);

    const url = `/api/v1/infection/hai/${res.body.id}/review`;
    expect((await api().post(url).set(doctor()).send({ status: 'CONFIRMED' })).status).toBe(403);
    const ok = await api().post(url).set(bearer(icDoctor.token)).send({ status: 'CONFIRMED' });
    expect(ok.status).toBe(200);

    const list = await api()
      .get('/api/v1/infection/hai?status=CONFIRMED')
      .set(bearer(icDoctor.token));
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(res.body.id);
  });

  it('reports rates per 1,000 patient-days by ward, and hides small national counts', async () => {
    const res = await api()
      .get('/api/v1/infection/surveillance?months=3')
      .set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    const ward = res.body.units.find((u: { unit: string }) => u.unit === 'Interna IC');
    expect(ward.confirmed).toBe(1);
    expect(ward.deviceRelated).toBe(1);
    expect(ward.patientDays).toBeGreaterThanOrEqual(12);
    expect(ward.rate).toBe(per1000(1, ward.patientDays));
    expect((await api().get('/api/v1/infection/surveillance').set(doctor())).status).toBe(403);

    const national = await api()
      .get('/api/v1/infection/surveillance')
      .set(bearer(w.tokens.ministry));
    const mine = national.body.facilities.find(
      (f: { facility: string }) => f.facility === w.facility.name,
    );
    expect(SMALL_CELL_THRESHOLD).toBeGreaterThan(1);
    expect(mine).toMatchObject({ confirmed: null, rate: null, suppressed: true });
  });

  it('suggests positive cultures taken after 48 hours, once, to infection control', async () => {
    const p = await createPatient(w.facility.id);
    const stay = await admit(p.id, 6, 'A3');
    const culture = (value: string, afterHours: number) =>
      db
        .insert(labResults)
        .values({
          patientId: p.id,
          orderedById: w.users.doctor.id,
          testName: 'Hemokultura',
          value,
          flag: 'CRITICAL',
          collectedAt: new Date(stay.admittedAt.getTime() + afterHours * 3_600_000),
        })
        .returning();
    const [positive] = await culture('Klebsiella pneumoniae', 72);
    await culture('Negative – no growth', 80);
    await culture('Staphylococcus epidermidis', 12);
    const res = await api().get('/api/v1/infection/suggestions').set(bearer(icDoctor.token));
    expect(res.status).toBe(200);
    const ids = res.body.items.filter((i: { patientId: string }) => i.patientId === p.id);
    expect(ids.map((i: { labResultId: string }) => i.labResultId)).toEqual([positive!.id]);
    expect((await api().get('/api/v1/infection/suggestions').set(doctor())).status).toBe(403);

    await runInfectionWorkerOnce();
    await runInfectionWorkerOnce();
    const told = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, icDoctor.id),
          sql`${notifications.link} LIKE ${`%suggestion=${positive!.id}`}`,
        ),
      );
    expect(told).toHaveLength(1);
    expect(told[0]!.title).not.toMatch(/Klebsiella/);
  });
});
