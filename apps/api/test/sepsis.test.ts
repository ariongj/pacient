import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  auditLogs,
  beds,
  careUnits,
  edVisits,
  notifications,
  patients,
  prescriptions,
  sepsisScreens,
  unitStaff,
  vitalSigns,
} from '../src/db/schema.js';
import { scoreVitalSign } from '../src/modules/news/news.service.js';
import {
  escalateOverdueOnce,
  outcomeFor,
  scorePromptsScreen,
  setSepsisPromptFailureForTests,
  suggestedFlags,
} from '../src/modules/sepsis/sepsis.service.js';
import { api, bearer, createPatient, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let ward: typeof careUnits.$inferSelect;
let ed: typeof careUnits.$inferSelect;
let adult: typeof patients.$inferSelect;
let singleThree: typeof patients.$inferSelect;
let child: typeof patients.$inferSelect;
let outpatient: typeof patients.$inferSelect;
let emergency: typeof patients.$inferSelect;

const NORMAL = {
  respiratoryRate: 16,
  oxygenSaturation: 97,
  onSupplementalOxygen: false,
  systolic: 120,
  heartRate: 80,
  consciousness: 'A',
  temperatureC: '37.0',
};

/** Stores a set of observations and scores it (as the vitals route does). */
async function observe(patientId: string, values: Partial<typeof NORMAL>) {
  const [v] = await db
    .insert(vitalSigns)
    .values({ patientId, recordedById: w.users.nurse.id, ...NORMAL, ...values })
    .returning();
  return scoreVitalSign(v!.id);
}

const screensOf = (patientId: string) =>
  db.select().from(sepsisScreens).where(eq(sepsisScreens.patientId, patientId));

const sepsisNotes = (userId: string, type = 'sepsis.prompt') =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, type)));

const bornYearsAgo = (years: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  w = await createWorld();
  const [w1] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Interna S', code: 'INT-S', type: 'GENERAL_WARD' })
    .returning();
  ward = w1!;
  const [e1] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Urgjenca S', code: 'URG-S', type: 'EMERGENCY' })
    .returning();
  ed = e1!;
  const bedRows = await db
    .insert(beds)
    .values([
      { unitId: ward!.id, label: 'S1', status: 'OCCUPIED' },
      { unitId: ward!.id, label: 'S2', status: 'OCCUPIED' },
      { unitId: ward!.id, label: 'S3', status: 'OCCUPIED' },
    ])
    .returning();
  await db.insert(unitStaff).values([
    { unitId: ward!.id, userId: w.users.nurse.id },
    { unitId: ed!.id, userId: w.users.nurse.id },
    { unitId: ed!.id, userId: w.users.colleague.id },
  ]);
  adult = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  singleThree = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  child = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  const [c1] = await db
    .update(patients)
    .set({ dateOfBirth: bornYearsAgo(3) })
    .where(eq(patients.id, child.id))
    .returning();
  child = c1!;
  outpatient = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  emergency = await createPatient(w.facility.id);
  await db.insert(admissions).values(
    [adult, singleThree, child].map((p, i) => ({
      patientId: p!.id,
      facilityId: w.facility.id,
      unitId: ward!.id,
      bedId: bedRows[i]!.id,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'EMERGENCY' as const,
      reason: 'Ethe',
    })),
  );
  await db.insert(edVisits).values({
    patientId: emergency.id,
    facilityId: w.facility.id,
    unitId: ed!.id,
    arrivalMode: 'WALK_IN',
    chiefComplaint: 'Ethe dhe dridhje',
    registeredById: w.users.reception.id,
    status: 'IN_TREATMENT',
    assignedDoctorId: w.users.colleague.id,
  });
});

afterAll(() => setSepsisPromptFailureForTests(false));

describe('rules', () => {
  it('prompts at NEWS2 5, a single parameter scoring 3, or PEWS MEDIUM/HIGH', () => {
    const news = (score: number, singleThree = false) => ({
      scale: 'NEWS2',
      score,
      risk: 'LOW',
      components: { singleThree },
    });
    expect(scorePromptsScreen(news(4))).toBe(false);
    expect(scorePromptsScreen(news(5))).toBe(true);
    expect(scorePromptsScreen(news(3, true))).toBe(true);
    const pews = (risk: string) => ({ scale: 'PEWS', score: 4, risk, components: {} });
    expect(scorePromptsScreen(pews('LOW_MEDIUM'))).toBe(false);
    expect(scorePromptsScreen(pews('MEDIUM'))).toBe(true);
    expect(scorePromptsScreen(pews('HIGH'))).toBe(true);
  });

  it('derives the outcome from infection and the flags', () => {
    expect(outcomeFor(false, ['SYSTOLIC_LE_90'])).toBe('NOT_SEPSIS');
    expect(outcomeFor(true, [])).toBe('NOT_SEPSIS');
    expect(outcomeFor(true, ['RIGORS'])).toBe('SEPSIS_SUSPECTED');
    expect(outcomeFor(true, ['RIGORS', 'LACTATE_GE_2'])).toBe('RED_FLAG');
  });

  it('suggests flags from the latest observations', () => {
    expect(
      suggestedFlags({
        systolic: 88,
        heartRate: 131,
        respiratoryRate: 22,
        oxygenSaturation: 93,
        onSupplementalOxygen: true,
        consciousness: 'V',
        temperatureC: '35.6',
      }).sort(),
    ).toEqual(
      [
        'HR_GE_130',
        'NEEDS_OXYGEN',
        'NEW_CONFUSION',
        'RR_21_24',
        'SYSTOLIC_LE_90',
        'TEMPERATURE_LT_36',
      ].sort(),
    );
    expect(
      suggestedFlags({
        systolic: 98,
        heartRate: 95,
        respiratoryRate: 16,
        oxygenSaturation: 97,
        onSupplementalOxygen: false,
        consciousness: 'A',
        temperatureC: '37.2',
      }).sort(),
    ).toEqual(['HR_91_130', 'SYSTOLIC_91_100']);
  });
});

describe('prompts from early warning scores', () => {
  it('does not prompt for a normal or mildly raised score', async () => {
    await observe(adult.id, NORMAL);
    await observe(adult.id, { heartRate: 95, temperatureC: '38.2' }); // NEWS2 2
    expect(await screensOf(adult.id)).toHaveLength(0);
  });

  it('prompts once for an inpatient with NEWS2 ≥ 5 and tells the ward without naming the patient', async () => {
    const score = await observe(adult.id, { respiratoryRate: 26, oxygenSaturation: 91 });
    expect(score).toMatchObject({ scale: 'NEWS2', score: 6 });
    const [screen] = await screensOf(adult.id);
    expect(screen).toMatchObject({ status: 'PENDING', trigger: 'PROMPTED' });
    expect(screen!.earlyWarningScoreId).toBe(score!.id);
    const doc = await sepsisNotes(w.users.doctor.id);
    expect(doc.map((n) => n.title)).toContain('Sepsis screen needed – Interna S, bed S1');
    expect(doc.every((n) => !n.title.includes(adult.lastName))).toBe(true);
    expect((await sepsisNotes(w.users.nurse.id)).length).toBeGreaterThan(0);
    // Pending already: no second prompt.
    await observe(adult.id, { respiratoryRate: 27, oxygenSaturation: 90 });
    expect(await screensOf(adult.id)).toHaveLength(1);
  });

  it('prompts on a single parameter scoring 3 and for a child with PEWS MEDIUM', async () => {
    const s = await observe(singleThree.id, { respiratoryRate: 25 });
    expect(s).toMatchObject({ score: 3 });
    expect(await screensOf(singleThree.id)).toHaveLength(1);
    // Toddler: heart rate 150 and respiration 45 (PEWS MEDIUM).
    const pews = await observe(child.id, { heartRate: 155, respiratoryRate: 52 });
    expect(pews!.scale).toBe('PEWS');
    expect(['MEDIUM', 'HIGH']).toContain(pews!.risk);
    expect(await screensOf(child.id)).toHaveLength(1);
  });

  it('prompts for an emergency patient but not for an outpatient', async () => {
    await observe(emergency.id, { respiratoryRate: 26, oxygenSaturation: 91 });
    const [screen] = await screensOf(emergency.id);
    expect(screen).toMatchObject({ status: 'PENDING' });
    expect(screen!.edVisitId).not.toBeNull();
    expect((await sepsisNotes(w.users.colleague.id)).map((n) => n.title)).toContain(
      'Sepsis screen needed – Urgjenca S',
    );
    await observe(outpatient.id, { respiratoryRate: 26, oxygenSaturation: 91 });
    expect(await screensOf(outpatient.id)).toHaveLength(0);
  });

  it('never breaks scoring when the prompt fails', async () => {
    setSepsisPromptFailureForTests(true);
    const score = await observe(outpatient.id, { respiratoryRate: 30, oxygenSaturation: 88 });
    expect(score).toMatchObject({ scale: 'NEWS2' });
    expect(score!.score).toBeGreaterThanOrEqual(6);
    setSepsisPromptFailureForTests(false);
  });
});

describe('screening and the Sepsis Six bundle', () => {
  let screenId: string;

  it('lets the care team answer a prompt; the outcome follows the answers', async () => {
    const [screen] = await screensOf(adult.id);
    screenId = screen!.id;
    const outsider = await api()
      .post(`/api/v1/sepsis/screens/${screenId}/screen`)
      .set(bearer(w.tokens.outsideDoctor))
      .send({ suspectedInfection: true, flags: [] });
    expect(outsider.status).toBe(403);
    const reception = await api()
      .post(`/api/v1/sepsis/screens/${screenId}/screen`)
      .set(bearer(w.tokens.reception))
      .send({ suspectedInfection: true, flags: [] });
    expect(reception.status).toBe(403);
    const bad = await api()
      .post(`/api/v1/sepsis/screens/${screenId}/screen`)
      .set(bearer(w.tokens.nurse))
      .send({ suspectedInfection: true, flags: ['NOT_A_FLAG'] });
    expect(bad.status).toBe(400);
    const res = await api()
      .post(`/api/v1/sepsis/screens/${screenId}/screen`)
      .set(bearer(w.tokens.nurse))
      .send({
        suspectedInfection: true,
        suspectedSource: 'RESPIRATORY',
        flags: ['RR_GE_25', 'NEEDS_OXYGEN'],
        // The client cannot choose the outcome.
        status: 'NOT_SEPSIS',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'RED_FLAG', suspectedSource: 'RESPIRATORY' });
    expect(res.body.bundleStartedAt).toBeTruthy();
    const again = await api()
      .post(`/api/v1/sepsis/screens/${screenId}/screen`)
      .set(bearer(w.tokens.nurse))
      .send({ suspectedInfection: false, flags: [] });
    expect(again.status).toBe(409);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'sepsis.screened'), eq(auditLogs.resourceId, screenId)));
    expect(audit.length).toBeGreaterThanOrEqual(2); // prompt + answer
  });

  it('records each step once, links the antibiotic, completes the bundle', async () => {
    const step = (body: Record<string, unknown>, token = w.tokens.nurse) =>
      api().post(`/api/v1/sepsis/screens/${screenId}/bundle`).set(bearer(token)).send(body);
    expect((await step({ step: 'oxygen' })).body.stepsDone).toBe(1);
    expect((await step({ step: 'oxygen' })).status).toBe(409);
    const [otherRx] = await db
      .insert(prescriptions)
      .values({
        patientId: outpatient.id,
        doctorId: w.users.doctor.id,
        medication: 'Ceftriaxone 2 g IV',
        dosage: '2 g',
        frequency: 'once daily',
        startDate: '2026-11-01',
      })
      .returning();
    expect((await step({ step: 'antibiotics', prescriptionId: otherRx!.id })).status).toBe(400);
    expect((await step({ step: 'fluids', prescriptionId: otherRx!.id })).status).toBe(400);
    expect(
      (await step({ step: 'cultures', at: new Date(Date.now() + 3_600_000).toISOString() })).status,
    ).toBe(400);
    const [rx] = await db
      .insert(prescriptions)
      .values({
        patientId: adult.id,
        doctorId: w.users.doctor.id,
        medication: 'Piperacillin/tazobactam 4,5 g IV',
        dosage: '4.5 g',
        frequency: 'every 8 hours',
        startDate: '2026-11-01',
      })
      .returning();
    for (const s of ['cultures', 'fluids', 'lactate', 'urineOutput']) {
      expect((await step({ step: s })).status).toBe(200);
    }
    const last = await step({ step: 'antibiotics', prescriptionId: rx!.id }, w.tokens.doctor);
    expect(last.status).toBe(200);
    expect(last.body.stepsDone).toBe(6);
    expect(last.body.bundleCompletedAt).toBeTruthy();
    expect(last.body.antibioticPrescriptionId).toBe(rx!.id);
    expect(last.body.steps.find((s: { step: string }) => s.step === 'antibiotics').by).toBe(
      w.users.doctor.fullName,
    );
    // Senior review: doctors only, once.
    const nurseReview = await api()
      .post(`/api/v1/sepsis/screens/${screenId}/senior-review`)
      .set(bearer(w.tokens.nurse))
      .send({});
    expect(nurseReview.status).toBe(403);
    const review = await api()
      .post(`/api/v1/sepsis/screens/${screenId}/senior-review`)
      .set(bearer(w.tokens.doctor))
      .send({});
    expect(review.status).toBe(200);
    expect(review.body.seniorReviewAt).toBeTruthy();
  });

  it('screens manually; no infection means no bundle; amber flags mean suspected sepsis', async () => {
    const none = await api()
      .post(`/api/v1/sepsis/patients/${singleThree.id}/screens`)
      .set(bearer(w.tokens.doctor))
      .send({ suspectedInfection: false, flags: ['HR_GE_130'] });
    expect(none.status).toBe(201);
    expect(none.body).toMatchObject({ status: 'NOT_SEPSIS', trigger: 'MANUAL' });
    expect(
      (
        await api()
          .post(`/api/v1/sepsis/screens/${none.body.id}/bundle`)
          .set(bearer(w.tokens.nurse))
          .send({ step: 'oxygen' })
      ).status,
    ).toBe(409);
    const amber = await api()
      .post(`/api/v1/sepsis/patients/${singleThree.id}/screens`)
      .set(bearer(w.tokens.nurse))
      .send({ suspectedInfection: true, suspectedSource: 'URINARY', flags: ['RIGORS'] });
    expect(amber.body).toMatchObject({ status: 'SEPSIS_SUSPECTED', bundleStartedAt: null });
    // The first step starts the clock.
    const first = await api()
      .post(`/api/v1/sepsis/screens/${amber.body.id}/bundle`)
      .set(bearer(w.tokens.nurse))
      .send({ step: 'cultures' });
    expect(first.body.bundleStartedAt).toBeTruthy();
    // Not on the care team: refused.
    expect(
      (
        await api()
          .post(`/api/v1/sepsis/patients/${singleThree.id}/screens`)
          .set(bearer(w.tokens.outsideDoctor))
          .send({ suspectedInfection: false, flags: [] })
      ).status,
    ).toBe(403);
  });

  it('shows the patient’s screens with suggested flags to the care team, audited', async () => {
    const res = await api().get(`/api/v1/sepsis/patients/${adult.id}`).set(bearer(w.tokens.doctor));
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ id: screenId, stepsDone: 6 });
    expect(res.body.suggestedFlags).toEqual(expect.arrayContaining(['RR_GE_25']));
    expect(res.body.location).toMatchObject({ unitName: 'Interna S', setting: 'INPATIENT' });
    expect(
      (await api().get(`/api/v1/sepsis/patients/${adult.id}`).set(bearer(w.tokens.patient))).status,
    ).toBe(403);
    expect(
      (await api().get(`/api/v1/sepsis/patients/${adult.id}`).set(bearer(w.tokens.outsideDoctor)))
        .status,
    ).toBe(403);
  });
});

describe('escalation of overdue bundles and unanswered prompts', () => {
  it('escalates a red-flag bundle incomplete after an hour, once, even with two workers', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const [stay] = await db
      .insert(admissions)
      .values({
        patientId: p.id,
        facilityId: w.facility.id,
        unitId: ward.id,
        admittingDoctorId: w.users.doctor.id,
        attendingDoctorId: w.users.doctor.id,
        source: 'EMERGENCY',
        reason: 'Ethe',
      })
      .returning();
    const started = new Date(Date.now() - 61 * 60_000);
    const [late] = await db
      .insert(sepsisScreens)
      .values({
        patientId: p.id,
        facilityId: w.facility.id,
        admissionId: stay!.id,
        trigger: 'MANUAL',
        status: 'RED_FLAG',
        redFlags: ['LACTATE_GE_2'],
        screenedAt: started,
        bundleStartedAt: started,
        bundle: { oxygen: started.toISOString() },
        createdAt: started,
      })
      .returning();
    const [onTime] = await db
      .insert(sepsisScreens)
      .values({
        patientId: p.id,
        facilityId: w.facility.id,
        admissionId: stay!.id,
        trigger: 'MANUAL',
        status: 'RED_FLAG',
        redFlags: ['LACTATE_GE_2'],
        screenedAt: new Date(),
        bundleStartedAt: new Date(Date.now() - 30 * 60_000),
      })
      .returning();
    const before = (await sepsisNotes(w.users.doctor.id, 'sepsis.escalation')).length;
    await Promise.all([escalateOverdueOnce(), escalateOverdueOnce()]);
    await escalateOverdueOnce();
    const after = await sepsisNotes(w.users.doctor.id, 'sepsis.escalation');
    const mine = after.filter((n) => n.link === `/sepsis?screen=${late!.id}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.title).toBe('Sepsis Six not complete after one hour – Interna S');
    expect(after.length - before).toBeGreaterThanOrEqual(1);
    expect(after.some((n) => n.link === `/sepsis?screen=${onTime!.id}`)).toBe(false);
    const [stored] = await db.select().from(sepsisScreens).where(eq(sepsisScreens.id, late!.id));
    expect(stored!.bundle.escalatedAt).toBeTruthy();
  });

  it('escalates a prompt nobody answered within an hour, once', async () => {
    const [prompt] = await db
      .update(sepsisScreens)
      .set({ createdAt: new Date(Date.now() - 70 * 60_000) })
      .where(and(eq(sepsisScreens.patientId, child.id), eq(sepsisScreens.status, 'PENDING')))
      .returning();
    expect(prompt).toBeTruthy();
    await escalateOverdueOnce();
    await escalateOverdueOnce();
    const notes = (await sepsisNotes(w.users.doctor.id, 'sepsis.escalation')).filter(
      (n) => n.link === `/sepsis?screen=${prompt!.id}`,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('Sepsis screen not done after one hour – Interna S, bed S3');
  });
});

describe('board and dashboard', () => {
  it('shows open screens to the ward and emergency staff and the care team only', async () => {
    const nurse = await api().get('/api/v1/sepsis/board').set(bearer(w.tokens.nurse));
    expect(nurse.status).toBe(200);
    const ids = nurse.body.items.map((i: { patientId: string }) => i.patientId);
    expect(ids).toContain(emergency.id);
    expect(ids).toContain(child.id);
    // The completed bundle is no longer open.
    expect(ids).not.toContain(adult.id);
    expect(nurse.body.items[0].status).toBe('RED_FLAG');
    const pendingOnly = await api()
      .get('/api/v1/sepsis/board?status=PENDING')
      .set(bearer(w.tokens.nurse));
    expect(pendingOnly.body.items.every((i: { status: string }) => i.status === 'PENDING')).toBe(
      true,
    );
    // The emergency doctor sees the emergency patient but not the ward's patients.
    const colleague = await api().get('/api/v1/sepsis/board').set(bearer(w.tokens.colleague));
    const theirs = colleague.body.items.map((i: { patientId: string }) => i.patientId);
    expect(theirs).toContain(emergency.id);
    expect(theirs).not.toContain(child.id);
    const outsider = await api().get('/api/v1/sepsis/board').set(bearer(w.tokens.outsideDoctor));
    expect(outsider.body.items).toHaveLength(0);
    expect((await api().get('/api/v1/sepsis/board').set(bearer(w.tokens.director))).status).toBe(
      403,
    );
  });

  it('gives the director compliance figures, withholding small numbers', async () => {
    const small = await api().get('/api/v1/sepsis/dashboard').set(bearer(w.tokens.director));
    expect(small.status).toBe(200);
    expect(small.body.total.redFlags).toBeGreaterThan(0);
    expect(small.body.total.redFlags).toBeLessThan(5);
    expect(small.body.total.withinTargetPct).toBeNull();
    expect(small.body.total.medianMinutesToAntibiotics).toBeNull();
    // Add five completed red-flag bundles: four within the hour, antibiotics after 30 minutes.
    const base = Date.now() - 2 * 86_400_000;
    const ps = await Promise.all(
      [0, 1, 2, 3, 4].map(() => createPatient(w.facility.id, { doctorId: w.users.doctor.id })),
    );
    await db.insert(sepsisScreens).values(
      ps.map((p, i) => {
        const start = new Date(base + i * 3_600_000);
        const minutes = i === 4 ? 90 : 45;
        const at = (m: number) => new Date(start.getTime() + m * 60_000).toISOString();
        return {
          patientId: p.id,
          facilityId: w.facility.id,
          trigger: 'MANUAL',
          status: 'RED_FLAG',
          redFlags: ['SYSTOLIC_LE_90'],
          screenedAt: start,
          bundleStartedAt: start,
          bundleCompletedAt: new Date(start.getTime() + minutes * 60_000),
          bundle: {
            oxygen: at(2),
            cultures: at(10),
            antibiotics: at(30),
            fluids: at(20),
            lactate: at(12),
            urineOutput: at(minutes),
          },
          createdAt: start,
        };
      }),
    );
    const res = await api().get('/api/v1/sepsis/dashboard').set(bearer(w.tokens.director));
    expect(res.body.total.redFlags).toBeGreaterThanOrEqual(5);
    expect(res.body.total.withinTargetPct).not.toBeNull();
    expect(res.body.total.medianMinutesToAntibiotics).toBe(30);
    expect(res.body.months.length).toBeGreaterThanOrEqual(1);
    // Another facility's director sees nothing of this one.
    const other = await api().get('/api/v1/sepsis/dashboard').set(bearer(w.tokens.otherDirector));
    expect(other.body.total.screens).toBe(0);
    expect((await api().get('/api/v1/sepsis/dashboard').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
  });
});

describe('audit', () => {
  it('records bundle steps and prompts in the audit trail', async () => {
    const rows = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(
        and(
          inArray(auditLogs.action, ['sepsis.screened', 'sepsis.bundle']),
          eq(auditLogs.patientId, adult.id),
        ),
      );
    expect(rows.filter((r) => r.action === 'sepsis.bundle').length).toBeGreaterThanOrEqual(6);
  });
});
