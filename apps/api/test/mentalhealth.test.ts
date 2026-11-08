import { and, eq, like } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  auditLogs,
  careUnits,
  emergencyAccessGrants,
  involuntaryAdmissions,
  medicationAdministrations,
  notifications,
  patients,
  prescriptions,
  restrictiveInterventions,
  unitStaff,
} from '../src/db/schema.js';
import { AuditAction } from '../src/modules/audit/audit.service.js';
import {
  debriefState,
  legalSteps,
  observationState,
} from '../src/modules/mentalhealth/definitions.js';
import {
  DEADLINE_NOTIFICATION,
  runDeadlineRemindersOnce,
} from '../src/modules/mentalhealth/mentalhealth.service.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

const BASE = '/api/v1/mental-health';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

let w: Awaited<ReturnType<typeof createWorld>>;
let psych: typeof careUnits.$inferSelect;
let ward: typeof careUnits.$inferSelect;
/** w.patient (has a portal account), admitted to the psychiatric ward. */
let main: typeof patients.$inferSelect;
let second: typeof patients.$inferSelect;
let late: typeof patients.$inferSelect;
let onWard: typeof patients.$inferSelect;
let outpatient: typeof patients.$inferSelect;
let stranger: { token: string; id: string };

const ASSESSMENT =
  'Persistent command hallucinations with a plan to harm himself; refuses voluntary admission.';

async function admit(patientId: string, unitId: string, admittedAt = ago(5 * DAY)) {
  await db.insert(admissions).values({
    patientId,
    facilityId: w.facility.id,
    unitId,
    admittingDoctorId: w.users.doctor.id,
    attendingDoctorId: w.users.doctor.id,
    source: 'EMERGENCY',
    reason: 'Pranim',
    admittedAt,
  });
}

const start = (patientId: string, body: Record<string, unknown> = {}, token = w.tokens.doctor) =>
  api()
    .post(`${BASE}/patients/${patientId}/involuntary`)
    .set(bearer(token))
    .send({ grounds: ['DANGER_TO_SELF'], assessment: ASSESSMENT, ...body });

const step = (id: string, path: string, body: Record<string, unknown>, token: string) =>
  api().post(`${BASE}/involuntary/${id}/${path}`).set(bearer(token)).send(body);

beforeAll(async () => {
  w = await createWorld();
  const [p] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Psikiatria A', code: 'PSY-A', type: 'PSYCHIATRIC' })
    .returning();
  psych = p!;
  const [g] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Interna MH', code: 'INT-MH', type: 'GENERAL_WARD' })
    .returning();
  ward = g!;
  await db.insert(unitStaff).values([
    { unitId: psych.id, userId: w.users.nurse.id },
    { unitId: psych.id, userId: w.users.colleague.id },
  ]);
  main = w.patient;
  second = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  late = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  onWard = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  outpatient = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
  for (const x of [main, second, late]) await admit(x.id, psych.id);
  await admit(onWard.id, ward.id);
  const user = await createUser('DOCTOR', w.facility.id);
  stranger = { id: user.id, token: await login(user.email) };
});

describe('legal steps and clocks (pure)', () => {
  const base = {
    status: 'ACTIVE',
    startedAt: new Date('2026-03-01T08:00:00Z'),
    secondOpinionAt: null,
    rightsExplainedAt: null,
    representativeNotifiedAt: null,
    courtNotifiedAt: null,
    courtDecisionAt: null,
    courtDecision: null,
    authorisedUntil: null,
  };
  const at = (iso: string) => new Date(iso);
  const statusOf = (steps: ReturnType<typeof legalSteps>, s: string) =>
    steps.find((x) => x.step === s)?.status;

  it('computes due, due-soon and overdue from the start', () => {
    const early = legalSteps(base, at('2026-03-01T10:00:00Z'));
    expect(statusOf(early, 'SECOND_OPINION')).toBe('PENDING');
    expect(early.find((s) => s.step === 'COURT_NOTIFIED')!.dueAt!.toISOString()).toBe(
      '2026-03-03T08:00:00.000Z',
    );
    const soon = legalSteps(base, at('2026-03-02T04:00:00Z'));
    expect(statusOf(soon, 'SECOND_OPINION')).toBe('DUE_SOON');
    const lateNow = legalSteps(base, at('2026-03-02T09:00:00Z'));
    expect(statusOf(lateNow, 'SECOND_OPINION')).toBe('OVERDUE');
    expect(statusOf(lateNow, 'COURT_NOTIFIED')).toBe('PENDING');
    // No authorisation step until the court confirms.
    expect(lateNow.map((s) => s.step)).not.toContain('AUTHORISATION_REVIEW');
  });

  it('times the court decision from the notification and the review from the authorisation', () => {
    const notified = { ...base, courtNotifiedAt: at('2026-03-02T08:00:00Z') };
    const s = legalSteps(notified, at('2026-03-05T09:00:00Z'));
    expect(s.find((x) => x.step === 'COURT_DECISION')!.dueAt!.toISOString()).toBe(
      '2026-03-05T08:00:00.000Z',
    );
    expect(statusOf(s, 'COURT_DECISION')).toBe('OVERDUE');
    const confirmed = {
      ...notified,
      courtDecisionAt: at('2026-03-04T08:00:00Z'),
      courtDecision: 'CONFIRMED',
      authorisedUntil: at('2026-04-01T08:00:00Z'),
    };
    expect(
      statusOf(legalSteps(confirmed, at('2026-03-20T00:00:00Z')), 'AUTHORISATION_REVIEW'),
    ).toBe('PENDING');
    expect(
      statusOf(legalSteps(confirmed, at('2026-03-28T00:00:00Z')), 'AUTHORISATION_REVIEW'),
    ).toBe('DUE_SOON');
    expect(
      statusOf(legalSteps(confirmed, at('2026-04-02T00:00:00Z')), 'AUTHORISATION_REVIEW'),
    ).toBe('OVERDUE');
  });

  it('marks steps not done as not applicable once it has ended', () => {
    const s = legalSteps({ ...base, status: 'RELEASED' }, at('2026-03-10T00:00:00Z'));
    expect(s.every((x) => x.status === 'NOT_APPLICABLE')).toBe(true);
  });

  it('observation and debrief clocks', () => {
    const r = {
      kind: 'SECLUSION',
      startedAt: at('2026-03-01T08:00:00Z'),
      endedAt: null,
      debriefAt: null,
      observations: [{ at: '2026-03-01T08:10:00Z' }],
    };
    expect(observationState(r, at('2026-03-01T08:20:00Z')).observationOverdue).toBe(false);
    expect(observationState(r, at('2026-03-01T08:26:00Z')).observationOverdue).toBe(true);
    const rt = { ...r, kind: 'RAPID_TRANQUILLISATION' };
    expect(observationState(rt, at('2026-03-01T12:00:00Z')).nextObservationDueAt).toBeNull();
    const ended = { ...r, endedAt: at('2026-03-01T09:00:00Z') };
    expect(observationState(ended, at('2026-03-02T00:00:00Z')).observationOverdue).toBe(false);
    expect(debriefState(ended, at('2026-03-04T08:00:00Z')).debriefOverdue).toBe(false);
    expect(debriefState(ended, at('2026-03-04T10:00:00Z')).debriefOverdue).toBe(true);
  });
});

describe('involuntary admission', () => {
  let iaId: string;

  it('is recorded only by a doctor for a patient admitted to a psychiatric ward', async () => {
    expect((await start(outpatient.id)).status).toBe(409);
    expect((await start(onWard.id)).status).toBe(409);
    expect((await start(main.id, {}, w.tokens.nurse)).status).toBe(403);
    expect((await start(main.id, {}, stranger.token)).status).toBe(403);
    expect((await start(main.id, {}, w.tokens.outsideDoctor)).status).toBe(403);
    expect((await start(main.id, { grounds: [] })).status).toBe(400);
    expect((await start(main.id, { assessment: 'short' })).status).toBe(400);
    expect((await start(main.id, { startedAt: ahead(DAY).toISOString() })).status).toBe(400);
    expect((await start(main.id, { startedAt: ago(30 * DAY).toISOString() })).status).toBe(400);
  });

  it('starts the legal clocks', async () => {
    const res = await start(main.id, { grounds: ['DANGER_TO_SELF', 'SEVERE_SELF_NEGLECT'] });
    expect(res.status).toBe(201);
    iaId = res.body.id;
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.steps.map((s: { step: string }) => s.step)).toEqual([
      'SECOND_OPINION',
      'RIGHTS_EXPLAINED',
      'REPRESENTATIVE_NOTIFIED',
      'COURT_NOTIFIED',
      'COURT_DECISION',
    ]);
    expect(res.body.overdueSteps).toEqual([]);
    expect((await start(main.id)).status).toBe(409);
    const [log] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, AuditAction.INVOLUNTARY_ADMISSION_CHANGED),
          eq(auditLogs.resourceId, iaId),
        ),
      );
    expect(log?.metadata).toMatchObject({ kind: 'started' });
  });

  it('needs a different doctor for the second examination (also enforced by the database)', async () => {
    const same = await step(iaId, 'second-opinion', { confirms: true }, w.tokens.doctor);
    expect(same.status).toBe(409);
    await expect(
      db
        .update(involuntaryAdmissions)
        .set({ secondOpinionById: w.users.doctor.id, secondOpinionAt: new Date() })
        .where(eq(involuntaryAdmissions.id, iaId)),
    ).rejects.toThrow();
    expect((await step(iaId, 'second-opinion', { confirms: true }, w.tokens.nurse)).status).toBe(
      403,
    );
    const ok = await step(iaId, 'second-opinion', { confirms: true }, w.tokens.colleague);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ACTIVE');
    expect(ok.body.secondOpinion).toMatchObject({ confirms: true });
    expect(ok.body.secondOpinion.by).toBe(w.users.colleague.fullName);
    expect(
      (await step(iaId, 'second-opinion', { confirms: true }, w.tokens.colleague)).status,
    ).toBe(409);
  });

  it('records rights, the representative and the court, once each', async () => {
    const rights = await step(iaId, 'rights', {}, w.tokens.nurse);
    expect(rights.status).toBe(200);
    expect(rights.body.rightsExplainedAt).toBeTruthy();
    expect((await step(iaId, 'rights', {}, w.tokens.nurse)).status).toBe(409);
    const rep = await step(iaId, 'representative', { name: 'Motra, Arta' }, w.tokens.nurse);
    expect(rep.status).toBe(200);
    expect(rep.body.representative.name).toBe('Motra, Arta');
    expect(
      (await step(iaId, 'court-notification', { reference: 'X' }, w.tokens.doctor)).status,
    ).toBe(400);
    expect(
      (await step(iaId, 'court-notification', { reference: 'C-12/26' }, w.tokens.nurse)).status,
    ).toBe(403);
    const court = await step(iaId, 'court-notification', { reference: 'C-12/26' }, w.tokens.doctor);
    expect(court.status).toBe(200);
    expect(court.body.court.reference).toBe('C-12/26');
  });

  it('records the court decision with a lawful authorisation period', async () => {
    expect(
      (await step(iaId, 'court-decision', { decision: 'CONFIRMED' }, w.tokens.doctor)).status,
    ).toBe(400);
    const tooLong = await step(
      iaId,
      'court-decision',
      { decision: 'CONFIRMED', authorisedUntil: ahead(120 * DAY).toISOString() },
      w.tokens.doctor,
    );
    expect(tooLong.status).toBe(400);
    const ok = await step(
      iaId,
      'court-decision',
      { decision: 'CONFIRMED', authorisedUntil: ahead(30 * DAY).toISOString() },
      w.tokens.doctor,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.court.decision).toBe('CONFIRMED');
    const review = ok.body.steps.find((s: { step: string }) => s.step === 'AUTHORISATION_REVIEW');
    expect(review.status).toBe('PENDING');
    expect(ok.body.steps.filter((s: { status: string }) => s.status === 'DONE')).toHaveLength(5);
  });

  it('extends the authorisation only to a later date', async () => {
    const shorter = await step(
      iaId,
      'authorisation',
      { authorisedUntil: ahead(10 * DAY).toISOString() },
      w.tokens.doctor,
    );
    expect(shorter.status).toBe(400);
    const ok = await step(
      iaId,
      'authorisation',
      { authorisedUntil: ahead(60 * DAY).toISOString(), reference: 'C-12/26-2' },
      w.tokens.doctor,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.court.reference).toBe('C-12/26-2');
  });

  it('releases the patient when the second doctor does not confirm', async () => {
    const res = await start(second.id);
    const released = await step(
      res.body.id,
      'second-opinion',
      { confirms: false },
      w.tokens.colleague,
    );
    expect(released.body.status).toBe('RELEASED');
    expect(released.body.endReason).toBe('NOT_CONFIRMED');
    expect(
      released.body.steps
        .filter((s: { step: string }) => s.step !== 'SECOND_OPINION')
        .every((s: { status: string }) => s.status === 'NOT_APPLICABLE'),
    ).toBe(true);
    expect((await step(res.body.id, 'rights', {}, w.tokens.nurse)).status).toBe(409);
  });

  it('ends it when the patient stays voluntarily, or when the court rejects it', async () => {
    const a = await start(second.id);
    const voluntary = await step(
      a.body.id,
      'second-opinion',
      { confirms: false, staysVoluntarily: true },
      w.tokens.colleague,
    );
    expect(voluntary.body).toMatchObject({ status: 'ENDED', endReason: 'BECAME_VOLUNTARY' });

    const b = await start(second.id);
    await step(b.body.id, 'court-notification', { reference: 'C-13/26' }, w.tokens.doctor);
    const rejected = await step(
      b.body.id,
      'court-decision',
      { decision: 'REJECTED' },
      w.tokens.doctor,
    );
    expect(rejected.body).toMatchObject({ status: 'RELEASED', endReason: 'COURT_REJECTED' });

    const c = await start(second.id);
    expect((await step(c.body.id, 'end', { reason: 'OTHER' }, w.tokens.doctor)).status).toBe(400);
    const ended = await step(c.body.id, 'end', { reason: 'DISCHARGED' }, w.tokens.doctor);
    expect(ended.body).toMatchObject({ status: 'ENDED', endReason: 'DISCHARGED' });
    expect((await step(c.body.id, 'end', { reason: 'DISCHARGED' }, w.tokens.doctor)).status).toBe(
      409,
    );
  });
});

describe('deadline reminders', () => {
  let lateId: string;

  it('notifies the deciding doctor and the director once per overdue step, across instances', async () => {
    const res = await start(late.id, { startedAt: ago(30 * HOUR).toISOString() });
    expect(res.status).toBe(201);
    lateId = res.body.id;
    expect(res.body.overdueSteps).toEqual([
      'SECOND_OPINION',
      'RIGHTS_EXPLAINED',
      'REPRESENTATIVE_NOTIFIED',
    ]);
    // Two API instances running at once still send each reminder once.
    const [a, b] = await Promise.all([runDeadlineRemindersOnce(), runDeadlineRemindersOnce()]);
    expect(a + b).toBe(3);
    expect(await runDeadlineRemindersOnce()).toBe(0);
    const forDirector = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.director.id),
          eq(notifications.type, DEADLINE_NOTIFICATION),
          like(notifications.link, `%ia=${lateId}%`),
        ),
      );
    expect(forDirector).toHaveLength(3);
    const forDoctor = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.doctor.id),
          like(notifications.link, `%ia=${lateId}&step=SECOND_OPINION`),
        ),
      );
    expect(forDoctor).toHaveLength(1);
    // No names in a notification (they reach phones and email).
    for (const n of forDirector) {
      expect(JSON.stringify(n)).not.toContain(late.lastName);
    }
    const otherDirector = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.otherDirector.id),
          eq(notifications.type, DEADLINE_NOTIFICATION),
        ),
      );
    expect(otherDirector).toHaveLength(0);
  });

  it('stops reminding once the step is done', async () => {
    await step(lateId, 'court-notification', { reference: 'C-14/26' }, w.tokens.doctor);
    const later = new Date(Date.now() + 30 * HOUR);
    await runDeadlineRemindersOnce(later);
    const court = await db
      .select()
      .from(notifications)
      .where(like(notifications.link, `%ia=${lateId}&step=COURT_NOTIFIED`));
    expect(court).toHaveLength(0);
  });

  it('warns before the authorisation ends, once per authorisation period', async () => {
    const [main1] = await db
      .select()
      .from(involuntaryAdmissions)
      .where(
        and(
          eq(involuntaryAdmissions.patientId, main.id),
          eq(involuntaryAdmissions.status, 'ACTIVE'),
        ),
      );
    const warnAt = new Date(main1!.authorisedUntil!.getTime() - 3 * DAY);
    await runDeadlineRemindersOnce(warnAt);
    const key = `ia=${main1!.id}&step=AUTHORISATION_REVIEW`;
    const warned = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, w.users.director.id), like(notifications.link, `%${key}%`)),
      );
    expect(warned).toHaveLength(1);
    await runDeadlineRemindersOnce(warnAt);
    const again = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, w.users.director.id), like(notifications.link, `%${key}%`)),
      );
    expect(again).toHaveLength(1);
  });
});

describe('restrictive interventions', () => {
  let seclusionId: string;

  const startRi = (patientId: string, body: Record<string, unknown>, token = w.tokens.nurse) =>
    api().post(`${BASE}/patients/${patientId}/restrictive`).set(bearer(token)).send(body);
  const riStep = (
    id: string,
    path: string,
    body: Record<string, unknown>,
    token = w.tokens.nurse,
  ) => api().post(`${BASE}/restrictive/${id}/${path}`).set(bearer(token)).send(body);

  it('is recorded by the ward nurse or doctor for an admitted patient', async () => {
    expect(
      (
        await startRi(
          outpatient.id,
          { kind: 'SECLUSION', reason: 'Agitated and hitting staff' },
          w.tokens.doctor,
        )
      ).status,
    ).toBe(409);
    expect((await startRi(main.id, { kind: 'SECLUSION', reason: 'Agitated' })).status).toBe(400);
    expect(
      (
        await startRi(
          main.id,
          { kind: 'SECLUSION', reason: 'Agitated and hitting staff' },
          stranger.token,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await startRi(main.id, {
          kind: 'SECLUSION',
          reason: 'Agitated and hitting staff',
          medicationAdministrationId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await startRi(main.id, {
          kind: 'RAPID_TRANQUILLISATION',
          reason: 'Severe agitation, de-escalation failed',
          medicationAdministrationId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(400);
    const res = await startRi(main.id, {
      kind: 'SECLUSION',
      reason: 'Agitated and hitting staff after de-escalation failed',
      startedAt: ago(20 * 60_000).toISOString(),
    });
    expect(res.status).toBe(201);
    seclusionId = res.body.id;
    expect(res.body.observationOverdue).toBe(true);
    expect(res.body.orderedBy).toBe(w.users.nurse.fullName);
    // Any ward: restraint can happen outside psychiatry too.
    const elsewhere = await startRi(
      onWard.id,
      { kind: 'PHYSICAL_RESTRAINT', reason: 'Pulling out the central line, delirious' },
      w.tokens.doctor,
    );
    expect(elsewhere.status).toBe(201);
    const rt = await startRi(main.id, {
      kind: 'RAPID_TRANQUILLISATION',
      reason: 'Severe agitation, de-escalation failed',
    });
    expect(rt.body.nextObservationDueAt).toBeNull();
    // Rapid tranquillisation may refer to the medicine given (this patient's only).
    const [rx] = await db
      .insert(prescriptions)
      .values({
        patientId: main.id,
        doctorId: w.users.doctor.id,
        medication: 'Lorazepam',
        dosage: '2 mg',
        frequency: 'STAT',
        route: 'intramuscular',
        startDate: new Date().toISOString().slice(0, 10),
      })
      .returning();
    const [given] = await db
      .insert(medicationAdministrations)
      .values({
        prescriptionId: rx!.id,
        patientId: main.id,
        administeredById: w.users.nurse.id,
        status: 'GIVEN',
        doseGiven: '2 mg',
      })
      .returning();
    const chart = await api().get(`${BASE}/patients/${main.id}`).set(bearer(w.tokens.nurse));
    expect(chart.body.recentAdministrations[0]).toMatchObject({
      id: given!.id,
      medication: 'Lorazepam',
    });
    const linked = await startRi(main.id, {
      kind: 'RAPID_TRANQUILLISATION',
      reason: 'Severe agitation, de-escalation failed',
      medicationAdministrationId: given!.id,
    });
    expect(linked.status).toBe(201);
    expect(linked.body.observations[0].administrationId).toBe(given!.id);
    const otherPatients = await startRi(
      onWard.id,
      {
        kind: 'RAPID_TRANQUILLISATION',
        reason: 'Severe agitation, de-escalation failed',
        medicationAdministrationId: given!.id,
      },
      w.tokens.doctor,
    );
    expect(otherPatients.status).toBe(400);
  });

  it('keeps the 15-minute observation log', async () => {
    const obs = await riStep(seclusionId, 'observations', {
      note: 'Calmer, sitting on the bed, drank water',
      vitalsChecked: true,
    });
    expect(obs.status).toBe(200);
    expect(obs.body.observationOverdue).toBe(false);
    expect(obs.body.observations).toHaveLength(1);
    expect(obs.body.observations[0]).toMatchObject({
      by: w.users.nurse.fullName,
      vitalsChecked: true,
    });
    const due = new Date(obs.body.nextObservationDueAt).getTime() - Date.now();
    expect(due).toBeGreaterThan(14 * 60_000);
    expect(due).toBeLessThanOrEqual(15 * 60_000);
    expect(
      (await riStep(seclusionId, 'observations', { note: 'x', at: ago(DAY).toISOString() })).status,
    ).toBe(400);
  });

  it('prompts the debrief after the end, once', async () => {
    expect(
      (await riStep(seclusionId, 'debrief', { note: 'Talked it through with him' })).status,
    ).toBe(409);
    const ended = await riStep(seclusionId, 'end', { injuries: 'Graze on the left forearm' });
    expect(ended.status).toBe(200);
    expect(ended.body.durationMinutes).toBeGreaterThanOrEqual(20);
    expect(ended.body.injuries).toBe('Graze on the left forearm');
    expect(ended.body.nextObservationDueAt).toBeNull();
    expect(ended.body.debriefOverdue).toBe(false);
    expect(new Date(ended.body.debriefDueAt).getTime()).toBeGreaterThan(Date.now() + 71 * HOUR);
    expect((await riStep(seclusionId, 'end', {})).status).toBe(409);
    const debrief = await riStep(seclusionId, 'debrief', {
      note: 'Talked it through with him and his sister; agreed early warning signs.',
    });
    expect(debrief.status).toBe(200);
    expect(debrief.body.debriefAt).toBeTruthy();
    expect(
      (await riStep(seclusionId, 'debrief', { note: 'A second debrief note here' })).status,
    ).toBe(409);
    const logs = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, AuditAction.RESTRICTIVE_INTERVENTION_RECORDED),
          eq(auditLogs.resourceId, seclusionId),
        ),
      );
    expect(logs.map((l) => (l.metadata as { kind: string }).kind).sort()).toEqual([
      'debrief',
      'ended',
      'observation',
      'started',
    ]);
  });

  it('flags a debrief not held within 72 hours', async () => {
    const [row] = await db
      .insert(restrictiveInterventions)
      .values({
        patientId: main.id,
        facilityId: w.facility.id,
        kind: 'MECHANICAL_RESTRAINT',
        reason: 'Old restraint without a debrief',
        startedAt: ago(4 * DAY),
        endedAt: ago(4 * DAY - HOUR),
        orderedById: w.users.nurse.id,
      })
      .returning();
    const board = await api().get(`${BASE}/patients/${main.id}`).set(bearer(w.tokens.nurse));
    const item = board.body.restrictive.find((r: { id: string }) => r.id === row!.id);
    expect(item.debriefOverdue).toBe(true);
  });
});

describe('who sees what', () => {
  it('the care team and the ward staff see the record, and the view is in the access log', async () => {
    for (const token of [w.tokens.doctor, w.tokens.nurse, w.tokens.colleague]) {
      const res = await api().get(`${BASE}/patients/${main.id}`).set(bearer(token));
      expect(res.status).toBe(200);
    }
    const res = await api().get(`${BASE}/patients/${main.id}`).set(bearer(w.tokens.nurse));
    expect(res.body.involuntary[0].assessment).toBe(ASSESSMENT);
    const viewed = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, AuditAction.PATIENT_RECORD_VIEWED),
          eq(auditLogs.actorUserId, w.users.nurse.id),
          eq(auditLogs.patientId, main.id),
        ),
      );
    expect(
      viewed.some((v) => (v.metadata as { section?: string }).section === 'mental_health'),
    ).toBe(true);
    // The patient has no page for it, but sees who looked.
    const own = await api().get(`${BASE}/patients/${main.id}`).set(bearer(w.tokens.patient));
    expect(own.status).toBe(403);
    const log = await api().get('/api/v1/portal/access-log').set(bearer(w.tokens.patient));
    expect(log.status).toBe(200);
    expect(
      log.body.items.some(
        (i: { section: string | null; actorName: string }) =>
          i.section === 'mental_health' && i.actorName === w.users.nurse.fullName,
      ),
    ).toBe(true);
  });

  it('other doctors, break-glass access and non-clinical roles do not', async () => {
    for (const token of [
      stranger.token,
      w.tokens.outsideDoctor,
      w.tokens.director,
      w.tokens.ministry,
      w.tokens.pharmacist,
      w.tokens.reception,
    ]) {
      const res = await api().get(`${BASE}/patients/${main.id}`).set(bearer(token));
      expect(res.status).toBe(403);
    }
    await db.insert(emergencyAccessGrants).values({
      patientId: main.id,
      doctorId: stranger.id,
      reason: 'Unconscious in the emergency department',
      expiresAt: ahead(HOUR),
    });
    const glass = await api().get(`${BASE}/patients/${main.id}`).set(bearer(stranger.token));
    expect(glass.status).toBe(403);
    const denied = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, AuditAction.PATIENT_RECORD_ACCESS_DENIED),
          eq(auditLogs.actorUserId, stranger.id),
          eq(auditLogs.patientId, main.id),
        ),
      );
    expect(
      denied.some((d) => (d.metadata as { section?: string })?.section === 'mental_health'),
    ).toBe(true);
  });

  it('the board lists only the patients the caller is responsible for', async () => {
    const nurse = await api().get(`${BASE}/board`).set(bearer(w.tokens.nurse));
    expect(nurse.status).toBe(200);
    const ids = nurse.body.involuntary.map((i: { patientId: string }) => i.patientId);
    expect(ids).toEqual(expect.arrayContaining([main.id, late.id]));
    expect(nurse.body.involuntary[0].patient.unitName).toBe('Psikiatria A');
    // The nurse is not on the general ward.
    expect(
      nurse.body.restrictive.some((r: { patientId: string }) => r.patientId === onWard.id),
    ).toBe(false);
    expect(nurse.body.counts.overdueLegalSteps).toBeGreaterThan(0);
    const other = await api().get(`${BASE}/board`).set(bearer(stranger.token));
    expect(other.body.involuntary).toHaveLength(0);
    expect(other.body.restrictive).toHaveLength(0);
    expect((await api().get(`${BASE}/board`).set(bearer(w.tokens.director))).status).toBe(403);
  });

  it('the director sees the legal deadlines with names but no clinical detail', async () => {
    const res = await api().get(`${BASE}/oversight`).set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    const names = res.body.involuntary.map(
      (i: { patient: { lastName: string } }) => i.patient.lastName,
    );
    expect(names).toEqual(expect.arrayContaining([main.lastName, late.lastName]));
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(ASSESSMENT);
    expect(body).not.toContain('DANGER_TO_SELF');
    expect(body).not.toContain('Agitated');
    expect(res.body.overdueLegalSteps).toBeGreaterThan(0);
    expect(res.body.restrictiveLast30Days.SECLUSION).toBeGreaterThanOrEqual(1);
    const logged = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, AuditAction.PATIENT_RECORD_VIEWED),
          eq(auditLogs.actorUserId, w.users.director.id),
          eq(auditLogs.patientId, late.id),
        ),
      );
    expect(
      logged.some(
        (l) => (l.metadata as { section?: string }).section === 'mental_health_legal_oversight',
      ),
    ).toBe(true);
    const other = await api().get(`${BASE}/oversight`).set(bearer(w.tokens.otherDirector));
    expect(other.body.involuntary).toHaveLength(0);
    expect((await api().get(`${BASE}/oversight`).set(bearer(w.tokens.doctor))).status).toBe(403);
  });
});

describe('national statistics', () => {
  beforeAll(async () => {
    // Five ended seclusions at the other facility, 10–50 minutes long, over admitted bed-days.
    const [unit] = await db
      .insert(careUnits)
      .values({
        facilityId: w.otherFacility.id,
        name: 'Psikiatria B',
        code: 'PSY-B',
        type: 'PSYCHIATRIC',
      })
      .returning();
    for (let i = 0; i < 5; i++) {
      const p = await createPatient(w.otherFacility.id);
      const [adm] = await db
        .insert(admissions)
        .values({
          patientId: p.id,
          facilityId: w.otherFacility.id,
          unitId: unit!.id,
          admittingDoctorId: w.users.outsideDoctor.id,
          attendingDoctorId: w.users.outsideDoctor.id,
          source: 'ELECTIVE',
          reason: 'Pranim',
          admittedAt: ago(20 * DAY),
          status: 'DISCHARGED',
          dischargedAt: ago(10 * DAY),
          disposition: 'HOME',
        })
        .returning();
      const startedAt = ago(15 * DAY);
      await db.insert(restrictiveInterventions).values({
        patientId: p.id,
        admissionId: adm!.id,
        facilityId: w.otherFacility.id,
        kind: 'SECLUSION',
        reason: 'Statistics fixture',
        startedAt,
        endedAt: new Date(startedAt.getTime() + (i + 1) * 10 * 60_000),
        orderedById: w.users.outsideDoctor.id,
      });
      await db.insert(involuntaryAdmissions).values({
        patientId: p.id,
        admissionId: adm!.id,
        facilityId: w.otherFacility.id,
        grounds: ['DANGER_TO_OTHERS'],
        assessment: 'Statistics fixture',
        startedAt,
        decidedById: w.users.outsideDoctor.id,
        courtNotifiedAt: new Date(startedAt.getTime() + (i < 4 ? 20 : 60) * HOUR),
        status: 'ENDED',
        endedAt: ago(10 * DAY),
        endReason: 'DISCHARGED',
      });
    }
  });

  it('gives the Ministry aggregates only, hiding small numbers', async () => {
    expect((await api().get(`${BASE}/stats`).set(bearer(w.tokens.director))).status).toBe(403);
    const res = await api().get(`${BASE}/stats`).set(bearer(w.tokens.ministry));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(main.lastName);
    expect(body).not.toContain('Statistics fixture');
    const ours = res.body.facilities.find(
      (f: { facilityId: string }) => f.facilityId === w.facility.id,
    );
    // 1–4 cases are hidden; so are the rates and medians behind them.
    expect(ours.restrictive.seclusion).toBeNull();
    expect(ours.per1000BedDays.seclusion).toBeNull();
    expect(ours.medianDurationMinutes).toBeNull();
    const theirs = res.body.facilities.find(
      (f: { facilityId: string }) => f.facilityId === w.otherFacility.id,
    );
    expect(theirs.involuntary).toBe(5);
    expect(theirs.courtOnTimePct).toBe(80);
    expect(theirs.restrictive.seclusion).toBe(5);
    expect(theirs.medianDurationMinutes).toBe(30);
    // 5 seclusions over 5 × 10 = 50 bed-days in the window.
    expect(theirs.per1000BedDays.seclusion).toBe(100);
    expect(res.body.smallCellThreshold).toBe(5);
    expect(res.body.months.length).toBeGreaterThanOrEqual(12);
  });
});
