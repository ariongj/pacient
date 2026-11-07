import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  antenatalVisits,
  auditLogs,
  careAssignments,
  guardianships,
  labResults,
  notifications,
  patients,
  pregnancies,
} from '../src/db/schema.js';
import {
  addDays,
  contactSchedule,
  eddFromLmp,
  encodeRiskFactors,
  decodeRiskFactors,
  formatGestation,
  gestationDays,
  kosovoDay,
  riskLevelFor,
  visitAlerts,
  withAgeFactors,
} from '../src/modules/maternity/definitions.js';
import {
  maternityIndicators,
  runAntenatalRemindersOnce,
  suppress,
} from '../src/modules/maternity/maternity.service.js';
import { SMALL_CELL_THRESHOLD } from '../src/modules/stats/stats.service.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const today = () => kosovoDay(new Date());
/** LMP so that today is `weeks`+`days` of gestation. */
const lmpFor = (weeks: number, days = 0) => addDays(today(), -(weeks * 7 + days));

async function mother(
  opts: { dateOfBirth?: string; userId?: string; sex?: 'FEMALE' | 'MALE' } = {},
) {
  const p = await createPatient(w.facility.id, {
    doctorId: w.users.doctor.id,
    userId: opts.userId,
  });
  await db
    .update(patients)
    .set({
      sex: opts.sex ?? 'FEMALE',
      dateOfBirth: opts.dateOfBirth ?? '1994-03-10',
      municipality: 'Prizren',
    })
    .where(eq(patients.id, p.id));
  await db.insert(careAssignments).values({ patientId: p.id, doctorId: w.users.nurse.id });
  return p;
}

const book = (patientId: string, body: Record<string, unknown>, token = w.tokens.doctor) =>
  api()
    .post(`/api/v1/maternity/patients/${patientId}/pregnancies`)
    .set(bearer(token))
    .send({ gravida: 1, para: 0, ...body });

const visit = (pregnancyId: string, body: Record<string, unknown>, token = w.tokens.nurse) =>
  api().post(`/api/v1/maternity/pregnancies/${pregnancyId}/visits`).set(bearer(token)).send(body);

beforeAll(async () => {
  w = await createWorld();
});

describe('dating and rules', () => {
  it('computes EDD and gestational age from the LMP', () => {
    expect(eddFromLmp('2026-01-01')).toBe('2026-10-08');
    expect(gestationDays('2026-10-08', '2026-01-01')).toBe(0);
    expect(gestationDays('2026-10-08', '2026-06-20')).toBe(170);
    expect(formatGestation(170)).toBe('24+2');
  });

  it('maps risk factors to a risk level and adds age factors automatically', () => {
    expect(riskLevelFor(['SMOKING', 'ANAEMIA', 'RH_NEGATIVE'])).toBe('LOW');
    expect(riskLevelFor(['SMOKING', 'PREVIOUS_CAESAREAN'])).toBe('HIGH');
    expect(withAgeFactors(['AGE_OVER_40', 'SMOKING'], 17)).toEqual(['SMOKING', 'AGE_UNDER_18']);
    expect(withAgeFactors([], 41)).toEqual(['AGE_OVER_40']);
    const stored = encodeRiskFactors(['OTHER', 'DIABETES'], 'Previous uterine surgery');
    expect(stored).toEqual(['DIABETES', 'OTHER:Previous uterine surgery']);
    expect(decodeRiskFactors(stored)).toEqual({
      codes: ['DIABETES', 'OTHER'],
      otherNote: 'Previous uterine surgery',
    });
  });

  it('raises visit alerts at the documented thresholds', () => {
    const codes = (v: Parameters<typeof visitAlerts>[0]) => visitAlerts(v).map((a) => a.code);
    expect(codes({ gestationDays: 25 * 7, systolic: 139, diastolic: 89 })).toEqual([]);
    expect(visitAlerts({ gestationDays: 25 * 7, systolic: 140, diastolic: 85 })).toEqual([
      { code: 'PRE_ECLAMPSIA_RISK', severity: 'WARNING' },
    ]);
    expect(visitAlerts({ gestationDays: 25 * 7, systolic: 120, urineProtein: '1+' })).toEqual([
      { code: 'PRE_ECLAMPSIA_RISK', severity: 'WARNING' },
    ]);
    expect(
      visitAlerts({ gestationDays: 25 * 7, systolic: 145, diastolic: 95, urineProtein: '2+' }),
    ).toEqual([{ code: 'PRE_ECLAMPSIA_RISK', severity: 'SEVERE' }]);
    expect(codes({ gestationDays: 30 * 7, systolic: 165, diastolic: 100 })).toEqual([
      'SEVERE_HYPERTENSION',
      'PRE_ECLAMPSIA_RISK',
    ]);
    // Before 20 weeks raised BP is hypertension, proteinuria alone is not pre-eclampsia.
    expect(codes({ gestationDays: 16 * 7, systolic: 142, diastolic: 92 })).toEqual([
      'HYPERTENSION',
    ]);
    expect(codes({ gestationDays: 16 * 7, urineProtein: '1+' })).toEqual([]);
    expect(codes({ gestationDays: 30 * 7, fetalHeartRate: 105 })).toEqual(['FETAL_HEART_RATE']);
    expect(codes({ gestationDays: 30 * 7, fetalHeartRate: 160 })).toEqual([]);
    expect(codes({ gestationDays: 23 * 7, fetalMovements: false })).toEqual([]);
    expect(codes({ gestationDays: 28 * 7, fetalMovements: false })).toEqual([
      'REDUCED_FETAL_MOVEMENTS',
    ]);
    expect(codes({ gestationDays: 30 * 7, fundalHeightCm: 34 })).toEqual(['FUNDAL_HEIGHT']);
    expect(codes({ gestationDays: 30 * 7, fundalHeightCm: 33 })).toEqual([]);
    expect(codes({ gestationDays: 37 * 7, presentation: 'BREECH' })).toEqual(['MALPRESENTATION']);
    expect(codes({ gestationDays: 37 * 7 })).toEqual(['PRESENTATION_NOT_RECORDED']);
  });

  it('builds the WHO contact schedule with due, overdue and not-applicable contacts', () => {
    const edd = '2027-01-01';
    // Booked at 18 weeks, today 27+0, visits at 19 and 25 weeks.
    const s = contactSchedule(
      edd,
      18 * 7,
      [
        { gestationDays: 19 * 7, visitAt: 'a' },
        { gestationDays: 25 * 7, visitAt: 'b' },
      ],
      27 * 7,
      false,
    );
    expect(s.map((c) => [c.week, c.state])).toEqual([
      [12, 'NOT_APPLICABLE'],
      [20, 'DONE'],
      [26, 'DONE'],
      [30, 'UPCOMING'],
      [34, 'UPCOMING'],
      [36, 'UPCOMING'],
      [38, 'UPCOMING'],
      [40, 'UPCOMING'],
    ]);
    // Today 34+1 with no visit since 25 weeks: the 30-week contact is overdue, 34 is due.
    const later = contactSchedule(
      edd,
      18 * 7,
      [{ gestationDays: 25 * 7, visitAt: 'b' }],
      34 * 7 + 1,
      false,
    );
    expect(later.find((c) => c.week === 30)!.state).toBe('OVERDUE');
    expect(later.find((c) => c.week === 34)!.state).toBe('DUE');
  });
});

describe('booking', () => {
  it('books with LMP dating, adds age factors and audits', async () => {
    const m = await mother({ dateOfBirth: '1984-01-05' }); // over 40
    const res = await book(m.id, { lmpDate: lmpFor(10, 2), riskFactors: ['SMOKING'] });
    expect(res.status).toBe(201);
    const p = res.body.pregnancy;
    expect(p).toMatchObject({
      status: 'ONGOING',
      eddMethod: 'LMP',
      eddDate: eddFromLmp(lmpFor(10, 2)),
      gestation: '10+2',
      riskLevel: 'HIGH',
    });
    expect(p.riskFactors).toEqual(expect.arrayContaining(['SMOKING', 'AGE_OVER_40']));
    expect(res.body.warnings).toEqual([]);
    const [a] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'pregnancy.booked'), eq(auditLogs.resourceId, p.id)));
    expect(a).toBeDefined();
    // One ongoing pregnancy per patient.
    const again = await book(m.id, { lmpDate: lmpFor(10) });
    expect(again.status).toBe(409);
  });

  it('prefers the dating scan and warns about a discrepancy of more than 7 days', async () => {
    const m = await mother();
    const lmp = lmpFor(12);
    const scan = addDays(eddFromLmp(lmp), 9);
    const res = await book(m.id, { lmpDate: lmp, scanEdd: scan });
    expect(res.status).toBe(201);
    expect(res.body.pregnancy).toMatchObject({ eddMethod: 'ULTRASOUND', eddDate: scan });
    expect(res.body.warnings).toEqual([{ code: 'EDD_DISCREPANCY', days: 9 }]);
    const m2 = await mother();
    const close = await book(m2.id, { lmpDate: lmp, scanEdd: addDays(eddFromLmp(lmp), 5) });
    expect(close.body.warnings).toEqual([]);
  });

  it('validates the booking', async () => {
    const m = await mother();
    expect((await book(m.id, {})).status).toBe(400);
    expect((await book(m.id, { lmpDate: addDays(today(), 3) })).status).toBe(400);
    expect((await book(m.id, { lmpDate: lmpFor(46) })).status).toBe(400);
    expect((await book(m.id, { lmpDate: lmpFor(8), gravida: 2, para: 2 })).status).toBe(400);
    expect((await book(m.id, { lmpDate: lmpFor(8), riskFactors: ['OTHER'] })).status).toBe(400);
    const man = await mother({ sex: 'MALE' });
    expect((await book(man.id, { lmpDate: lmpFor(8) })).status).toBe(400);
    const child = await mother({ dateOfBirth: addDays(today(), -9 * 365) });
    expect((await book(child.id, { lmpDate: lmpFor(8) })).status).toBe(400);
    // A teenager gets the under-18 factor and a high risk level.
    const teen = await mother({ dateOfBirth: addDays(today(), -17 * 365) });
    const res = await book(teen.id, { lmpDate: lmpFor(8) });
    expect(res.status).toBe(201);
    expect(res.body.pregnancy).toMatchObject({ riskLevel: 'HIGH', riskFactors: ['AGE_UNDER_18'] });
  });

  it('enforces access: care team only; reception, director and other doctors are refused', async () => {
    const m = await mother();
    expect((await book(m.id, { lmpDate: lmpFor(8) }, w.tokens.reception)).status).toBe(403);
    expect((await book(m.id, { lmpDate: lmpFor(8) }, w.tokens.director)).status).toBe(403);
    expect((await book(m.id, { lmpDate: lmpFor(8) }, w.tokens.colleague)).status).toBe(403);
    expect(
      (await api().get(`/api/v1/maternity/patients/${m.id}`).set(bearer(w.tokens.colleague)))
        .status,
    ).toBe(403);
    // The nurse in the care team may book.
    expect((await book(m.id, { lmpDate: lmpFor(8) }, w.tokens.nurse)).status).toBe(201);
  });

  it('updates the risk factors while ongoing and recomputes the level', async () => {
    const m = await mother();
    const { body } = await book(m.id, { lmpDate: lmpFor(14) });
    expect(body.pregnancy.riskLevel).toBe('LOW');
    const res = await api()
      .patch(`/api/v1/maternity/pregnancies/${body.pregnancy.id}`)
      .set(bearer(w.tokens.doctor))
      .send({ riskFactors: ['GESTATIONAL_DIABETES'], reason: 'Abnormal glucose tolerance' });
    expect(res.status).toBe(200);
    expect(res.body.pregnancy).toMatchObject({
      riskLevel: 'HIGH',
      riskFactors: ['GESTATIONAL_DIABETES'],
    });
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'pregnancy.updated'), eq(auditLogs.resourceId, body.pregnancy.id)),
      );
    expect(audits[0]!.metadata).toMatchObject({ changed: ['riskFactors'] });
  });
});

describe('visits, schedule and key tests', () => {
  let m: Awaited<ReturnType<typeof mother>>;
  let pregnancyId: string;
  beforeAll(async () => {
    m = await mother();
    pregnancyId = (await book(m.id, { lmpDate: lmpFor(27) })).body.pregnancy.id;
    // Booked at 14 weeks (13 weeks ago).
    await db
      .update(pregnancies)
      .set({ createdAt: new Date(Date.now() - 13 * 7 * 86_400_000) })
      .where(eq(pregnancies.id, pregnancyId));
  });

  it('computes gestation at the visit and returns alerts without blocking', async () => {
    const at = new Date(Date.now() - 7 * 86_400_000);
    const res = await visit(pregnancyId, {
      visitAt: at.toISOString(),
      systolic: 148,
      diastolic: 96,
      urineProtein: '1+',
      fetalHeartRate: 142,
      fundalHeightCm: 26,
      notes: 'Headache for two days',
      nextVisitDate: addDays(today(), 3),
    });
    expect(res.status).toBe(201);
    expect(res.body.gestationDays).toBe(26 * 7);
    expect(res.body.alerts).toEqual([{ code: 'PRE_ECLAMPSIA_RISK', severity: 'SEVERE' }]);
  });

  it('validates visit dates', async () => {
    expect((await visit(pregnancyId, { visitAt: new Date(Date.now() + 86_400_000) })).status).toBe(
      400,
    );
    expect(
      (await visit(pregnancyId, { visitAt: new Date(Date.now() - 200 * 86_400_000) })).status,
    ).toBe(400);
    expect((await visit(pregnancyId, { nextVisitDate: addDays(today(), -1) })).status).toBe(400);
    expect((await visit(pregnancyId, { systolic: 120 })).status).toBe(400);
  });

  it('shows the schedule, key tests from lab results and post-term flags in the chart', async () => {
    await db.insert(labResults).values([
      {
        patientId: m.id,
        orderedById: w.users.doctor.id,
        testName: 'Hemoglobina',
        value: '118',
        unit: 'g/L',
        collectedAt: new Date(Date.now() - 100 * 86_400_000),
      },
      {
        patientId: m.id,
        orderedById: w.users.doctor.id,
        testName: 'HIV 1/2 Ag/Ab',
        testCode: '56888-1',
        value: 'Negative',
        collectedAt: new Date(Date.now() - 100 * 86_400_000),
      },
    ]);
    const res = await api().get(`/api/v1/maternity/patients/${m.id}`).set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    const p = res.body.items[0];
    expect(p.gestation).toBe('27+0');
    expect(p.nextVisitDate).toBe(addDays(today(), 3));
    expect(p.visits[0].notes).toBe('Headache for two days');
    const tests = Object.fromEntries(
      p.keyTests.map((t: { code: string; state: string }) => [t.code, t.state]),
    );
    expect(tests).toMatchObject({
      HAEMOGLOBIN: 'DONE',
      HIV: 'DONE',
      SYPHILIS: 'OVERDUE',
      ANOMALY_SCAN: 'OVERDUE',
      GLUCOSE_TOLERANCE: 'DUE',
    });
    const contacts = Object.fromEntries(
      p.schedule.map((c: { week: number; state: string }) => [c.week, c.state]),
    );
    expect(contacts[26]).toBe('DONE');
    expect(contacts[20]).toBe('OVERDUE');
    expect(res.body.canBook).toBe(false);
    const [viewAudit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'patient.record.viewed'), eq(auditLogs.patientId, m.id)));
    expect(viewAudit?.metadata).toMatchObject({ section: 'pregnancy' });
  });

  it('lists the pregnancy on the care team worklist with filters', async () => {
    const all = await api().get('/api/v1/maternity/worklist').set(bearer(w.tokens.nurse));
    expect(all.status).toBe(200);
    const item = all.body.items.find((i: { id: string }) => i.id === pregnancyId);
    expect(item).toMatchObject({ overdueContact: true, gestation: '27+0' });
    expect(item.alerts[0].code).toBe('PRE_ECLAMPSIA_RISK');
    expect(all.body.counts.ALERTS).toBeGreaterThanOrEqual(1);
    const alerts = await api()
      .get('/api/v1/maternity/worklist?filter=ALERTS')
      .set(bearer(w.tokens.nurse));
    expect(alerts.body.items.map((i: { id: string }) => i.id)).toContain(pregnancyId);
    const post = await api()
      .get('/api/v1/maternity/worklist?filter=POST_TERM')
      .set(bearer(w.tokens.nurse));
    expect(post.body.items.map((i: { id: string }) => i.id)).not.toContain(pregnancyId);
    // Other doctors (not in the care team) do not see it.
    const other = await api().get('/api/v1/maternity/worklist').set(bearer(w.tokens.colleague));
    expect(other.body.items.map((i: { id: string }) => i.id)).not.toContain(pregnancyId);
    expect(
      (await api().get('/api/v1/maternity/worklist').set(bearer(w.tokens.director))).status,
    ).toBe(403);
  });

  it('flags a post-term pregnancy', async () => {
    const late = await mother();
    const { body } = await book(late.id, { lmpDate: lmpFor(42, 2) });
    expect(body.pregnancy).toMatchObject({ postTerm: true, gestation: '42+2' });
    const post = await api()
      .get('/api/v1/maternity/worklist?filter=POST_TERM')
      .set(bearer(w.tokens.doctor));
    expect(post.body.items.map((i: { id: string }) => i.id)).toContain(body.pregnancy.id);
  });
});

describe('closing', () => {
  it('records an outcome; visits and changes are refused afterwards', async () => {
    const m = await mother();
    const { body } = await book(m.id, { lmpDate: lmpFor(9) });
    const id = body.pregnancy.id;
    const bad = await api()
      .post(`/api/v1/maternity/pregnancies/${id}/close`)
      .set(bearer(w.tokens.doctor))
      .send({ outcome: 'TRANSFERRED_OUT' });
    expect(bad.status).toBe(400);
    const res = await api()
      .post(`/api/v1/maternity/pregnancies/${id}/close`)
      .set(bearer(w.tokens.doctor))
      .send({ outcome: 'MISCARRIAGE', note: 'Complete miscarriage, no complications' });
    expect(res.status).toBe(200);
    expect(res.body.pregnancy).toMatchObject({ status: 'MISCARRIAGE' });
    expect((await visit(id, {})).status).toBe(409);
    expect(
      (
        await api()
          .post(`/api/v1/maternity/pregnancies/${id}/close`)
          .set(bearer(w.tokens.doctor))
          .send({ outcome: 'DELIVERED' })
      ).status,
    ).toBe(409);
    // A new pregnancy can be booked afterwards.
    expect((await book(m.id, { lmpDate: lmpFor(4), gravida: 2 })).status).toBe(201);
  });

  it('closes the ongoing pregnancy as delivered when the birth is registered', async () => {
    const m = await mother();
    const { body } = await book(m.id, { lmpDate: lmpFor(39, 2) });
    const res = await api()
      .post('/api/v1/identity/births')
      .set(bearer(w.tokens.doctor))
      .send({
        motherPatientId: m.id,
        bornAt: new Date(Date.now() - 3_600_000).toISOString(),
        sex: 'MALE',
        deliveryType: 'SPONTANEOUS_VAGINAL',
        gestationalWeeks: 39,
        gestationalDays: 2,
        birthWeightGrams: 3400,
        apgar1: 8,
        apgar5: 9,
      });
    expect(res.status).toBe(201);
    const [p] = await db.select().from(pregnancies).where(eq(pregnancies.id, body.pregnancy.id));
    expect(p).toMatchObject({ status: 'DELIVERED', birthId: res.body.birthId });
  });
});

describe('portal and reminders', () => {
  it('shows the mother her pregnancy without clinician notes or risk factors', async () => {
    const user = await createUser('PATIENT');
    const m = await mother({ userId: user.id });
    const { body } = await book(m.id, { lmpDate: lmpFor(20), riskFactors: ['SMOKING'] });
    await visit(body.pregnancy.id, {
      systolic: 118,
      diastolic: 72,
      weightKg: 64.5,
      notes: 'Discussed smoking cessation',
      nextVisitDate: addDays(today(), 2),
    });
    const token = await login(user.email);
    const res = await api().get('/api/v1/maternity/mine').set(bearer(token));
    expect(res.status).toBe(200);
    const p = res.body.items[0];
    expect(p).toMatchObject({ gestation: '20+0', nextVisitDate: addDays(today(), 2) });
    expect(p.visits[0]).toMatchObject({ systolic: 118, notes: null, recordedBy: null });
    expect(p.riskFactors).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('smoking');

    // Reminder 1–3 days before the planned visit, once.
    const sent = await runAntenatalRemindersOnce();
    expect(sent).toBeGreaterThanOrEqual(1);
    const mine = await db.select().from(notifications).where(eq(notifications.userId, user.id));
    expect(mine.filter((n) => n.type === 'antenatal_reminder')).toHaveLength(1);
    await runAntenatalRemindersOnce();
    const again = await db.select().from(notifications).where(eq(notifications.userId, user.id));
    expect(again.filter((n) => n.type === 'antenatal_reminder')).toHaveLength(1);
    expect(again.find((n) => n.type === 'antenatal_reminder')!.title).not.toMatch(/smok/i);
  });

  it('keeps a minor’s pregnancy confidential from guardians, whatever their access', async () => {
    const guardian = await createUser('PATIENT');
    const teen = await mother({ dateOfBirth: addDays(today(), -16 * 365) });
    await book(teen.id, { lmpDate: lmpFor(15) });
    const [g] = await db
      .insert(guardianships)
      .values({
        patientId: teen.id,
        guardianUserId: guardian.id,
        relationship: 'PARENT',
        scope: 'FULL',
        evidence: 'Certifikata e lindjes 1/2010',
        verifiedById: w.users.reception.id,
        validFrom: new Date(Date.now() - 86_400_000),
        validUntil: new Date(Date.now() + 365 * 86_400_000),
      })
      .returning();
    const token = await login(guardian.email);
    const as = { ...bearer(token), 'X-Acting-For': teen.id };
    const res = await api().get('/api/v1/maternity/mine').set(as);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], confidentialFromGuardians: true });
    await db
      .update(guardianships)
      .set({ scope: 'APPOINTMENTS' })
      .where(eq(guardianships.id, g!.id));
    const limited = await api().get('/api/v1/maternity/mine').set(as);
    expect(limited.status).toBe(403);
  });

  it('refuses staff the portal endpoint', async () => {
    expect((await api().get('/api/v1/maternity/mine').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
  });
});

describe('dashboards', () => {
  it('gives the director exact facility counts and the Ministry suppressed national figures', async () => {
    const res = await api().get('/api/v1/maternity/dashboard').set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('FACILITY');
    expect(res.body.ongoing.total).toBeGreaterThanOrEqual(5);
    expect(res.body.ongoing.postTerm).toBeGreaterThanOrEqual(1);
    expect(res.body.byMunicipality).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/firstName|nationalId/);

    const nat = await api().get('/api/v1/maternity/dashboard').set(bearer(w.tokens.ministry));
    expect(nat.status).toBe(200);
    expect(nat.body.scope).toBe('NATIONAL');
    for (const row of nat.body.byMunicipality) {
      if (row.booked !== null)
        expect(row.booked === 0 || row.booked >= SMALL_CELL_THRESHOLD).toBe(true);
      if (row.booked === null) expect(row.highRiskPct).toBeNull();
    }
    expect(
      (await api().get('/api/v1/maternity/dashboard').set(bearer(w.tokens.doctor))).status,
    ).toBe(403);
  });

  it('suppresses small cells and computes booking and contact indicators', async () => {
    expect([0, 1, 4, 5, 12].map(suppress)).toEqual([0, null, null, 5, 12]);
    const [facility] = await maternityIndicators({
      facilityId: w.facility.id,
      byMunicipality: false,
    });
    expect(facility!.booked).toBeGreaterThanOrEqual(SMALL_CELL_THRESHOLD);
    // Every pregnancy booked in this file was booked from 4 weeks on; the 42-week booking is late.
    expect(facility!.firstTrimesterPct).toBeGreaterThan(0);
    expect(facility!.firstTrimesterPct).toBeLessThan(100);
    // Too few deliveries in this facility to publish contact percentages.
    expect(facility!.anc4Pct).toBeNull();
    const visits = await db.select().from(antenatalVisits);
    expect(visits.length).toBeGreaterThan(0);
  });
});
