import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { careUnits, consentRecords, surgicalCases, unitStaff } from '../src/db/schema.js';
import { api, bearer, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let ot1: string;
let ot2: string;
let theatreNurse: { id: string; token: string };
let consentId: string;

const SIGN_IN = {
  identityConfirmed: true,
  siteMarked: 'YES',
  consentConfirmed: true,
  anaesthesiaCheckComplete: true,
  pulseOximeterFunctioning: true,
  knownAllergy: 'NO',
  difficultAirwayRisk: 'NO',
  bloodLossRisk: 'NO',
};
const TIME_OUT = {
  teamIntroduced: true,
  patientSiteProcedureConfirmed: true,
  antibioticProphylaxis: 'GIVEN',
  criticalEventsReviewed: true,
  imagingDisplayed: 'NOT_APPLICABLE',
};
const SIGN_OUT = {
  procedureRecorded: true,
  countsCorrect: true,
  specimenLabelled: 'YES',
  equipmentProblems: null,
  recoveryConcerns: 'Routine recovery',
};

// Two days ahead, on the hour, so bookings never fall in the past.
const day = new Date(Date.now() + 2 * 86_400_000);
day.setUTCHours(8, 0, 0, 0);
const at = (h: number, m = 0) => new Date(day.getTime() + (h * 60 + m) * 60_000).toISOString();

beforeAll(async () => {
  w = await createWorld();
  const units = await db
    .insert(careUnits)
    .values([
      { facilityId: w.facility.id, name: 'Theatre 1', code: 'OT1', type: 'OPERATING_THEATRE' },
      { facilityId: w.facility.id, name: 'Theatre 2', code: 'OT2', type: 'OPERATING_THEATRE' },
    ])
    .returning();
  ot1 = units[0]!.id;
  ot2 = units[1]!.id;
  const nurse = await createUser('NURSE', w.facility.id);
  await db.insert(unitStaff).values({ unitId: ot1, userId: nurse.id });
  theatreNurse = { id: nurse.id, token: await login(nurse.email) };
  const [consent] = await db
    .insert(consentRecords)
    .values({
      patientId: w.patient.id,
      type: 'TREATMENT',
      decision: 'GRANTED',
      method: 'IN_PERSON',
      procedure: 'Laparoscopic cholecystectomy',
      wordingVersion: '2026-1',
      recordedById: w.users.doctor.id,
    })
    .returning();
  consentId = consent!.id;
});

async function request(body: Record<string, unknown> = {}, token = w.tokens.doctor) {
  return api()
    .post('/api/v1/theatre/cases')
    .set(bearer(token))
    .send({
      patientId: w.patient.id,
      procedure: 'Laparoscopic cholecystectomy',
      laterality: 'NOT_APPLICABLE',
      priority: 'ELECTIVE',
      indication: 'Symptomatic gallstones',
      primarySurgeonId: w.users.doctor.id,
      anaesthesiaType: 'GENERAL',
      estimatedMinutes: 60,
      consentRecordId: consentId,
      ...body,
    });
}

const step = (id: string, action: string, token: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/theatre/cases/${id}/${action}`).set(bearer(token)).send(body);

const schedule = (id: string, body: Record<string, unknown>, token = theatreNurse.token) =>
  step(id, 'schedule', token, { theatreUnitId: ot1, scheduledStart: at(0), ...body });

describe('requesting operations', () => {
  it('requires the side and a doctor with write access', async () => {
    expect((await request({ laterality: undefined })).status).toBe(400);
    expect((await request({}, w.tokens.nurse)).status).toBe(403);
    expect((await request({}, w.tokens.outsideDoctor)).status).toBe(403);
    const ok = await request({ laterality: 'RIGHT', procedure: 'Inguinal hernia repair' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: 'REQUESTED', laterality: 'RIGHT' });
  });

  it('accepts only a granted treatment consent of the same patient', async () => {
    const [other] = await db
      .insert(consentRecords)
      .values({
        patientId: w.patient.id,
        type: 'RESEARCH',
        decision: 'GRANTED',
        method: 'PORTAL',
        wordingVersion: '2026-1',
        recordedById: w.users.patientUser.id,
      })
      .returning();
    expect((await request({ consentRecordId: other!.id })).status).toBe(400);
  });

  it('blocks scheduling an elective operation without consent; urgent ones need a reason', async () => {
    const elective = (await request({ consentRecordId: null })).body;
    const r = await schedule(elective.id, { scheduledStart: at(10) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('CONSENT_REQUIRED');

    const urgent = (await request({ consentRecordId: null, priority: 'URGENT' })).body;
    expect((await schedule(urgent.id, { scheduledStart: at(10) })).status).toBe(400);
    const waived = await schedule(urgent.id, {
      scheduledStart: at(10),
      consentWaiverReason: 'Patient unconscious, no relative reachable',
    });
    expect(waived.status).toBe(200);
    expect(waived.body.checklist.consentWaiver.reason).toMatch(/unconscious/);
  });
});

describe('scheduling', () => {
  it('refuses overlaps in a theatre and warns about double-booked surgeons', async () => {
    const a = (await request()).body;
    expect((await schedule(a.id, { scheduledStart: at(2) })).status).toBe(200);
    const b = (await request({ primarySurgeonId: w.users.colleague.id })).body;
    const clash = await schedule(b.id, { scheduledStart: at(2, 30) });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('THEATRE_BOOKED');
    expect((await schedule(b.id, { scheduledStart: at(3) })).status).toBe(200);

    const c = (await request()).body; // same surgeon as a
    const busy = await schedule(c.id, { theatreUnitId: ot2, scheduledStart: at(2, 15) });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('SURGEON_DOUBLE_BOOKED');
    const forced = await schedule(c.id, {
      theatreUnitId: ot2,
      scheduledStart: at(2, 15),
      force: true,
      forceReason: 'Assistant performs the first part',
    });
    expect(forced.status).toBe(200);
  });

  it('only lets theatre staff or the surgeon schedule', async () => {
    const a = (await request()).body;
    expect((await schedule(a.id, { scheduledStart: at(20) }, w.tokens.nurse)).status).toBe(403);
    expect((await schedule(a.id, { scheduledStart: at(20) }, w.tokens.colleague)).status).toBe(403);
    expect((await schedule(a.id, { scheduledStart: at(20) }, w.tokens.doctor)).status).toBe(200);
  });

  it('postpones and cancels with a reason', async () => {
    const a = (await request()).body;
    await schedule(a.id, { scheduledStart: at(22) });
    expect((await step(a.id, 'postpone', theatreNurse.token, {})).status).toBe(400);
    const p = await step(a.id, 'postpone', theatreNurse.token, { reason: 'No ICU bed tonight' });
    expect(p.body.status).toBe('POSTPONED');
    const c = await step(a.id, 'cancel', w.tokens.doctor, { reason: 'Patient declined' });
    expect(c.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Patient declined' });
  });
});

describe('WHO checklist and operation note', () => {
  it('enforces the steps in order and signs an immutable note', async () => {
    const a = (await request()).body;
    await schedule(a.id, { scheduledStart: at(5) });
    expect((await step(a.id, 'time-out', theatreNurse.token, TIME_OUT)).status).toBe(409);
    expect(
      (await step(a.id, 'sign-in', theatreNurse.token, { ...SIGN_IN, identityConfirmed: false }))
        .status,
    ).toBe(400);
    const signIn = await step(a.id, 'sign-in', theatreNurse.token, SIGN_IN);
    expect(signIn.body.status).toBe('IN_THEATRE');
    expect((await step(a.id, 'sign-in', theatreNurse.token, SIGN_IN)).status).toBe(409);
    expect((await step(a.id, 'time-out', theatreNurse.token, TIME_OUT)).status).toBe(200);
    const note = {
      operationNote: 'Laparoscopic cholecystectomy, critical view of safety achieved.',
    };
    expect((await step(a.id, 'complete', w.tokens.doctor, note)).status).toBe(409);
    expect(
      (await step(a.id, 'sign-out', theatreNurse.token, { ...SIGN_OUT, countsCorrect: false }))
        .status,
    ).toBe(400);
    expect((await step(a.id, 'sign-out', theatreNurse.token, SIGN_OUT)).status).toBe(200);
    expect((await step(a.id, 'complete', theatreNurse.token, note)).status).toBe(403);
    expect((await step(a.id, 'complete', w.tokens.colleague, note)).status).toBe(403);
    const done = await step(a.id, 'complete', w.tokens.doctor, {
      ...note,
      estimatedBloodLossMl: 50,
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED' });
    expect(done.body.noteSignedAt).toBeTruthy();

    await expect(
      db
        .update(surgicalCases)
        .set({ operationNote: 'Changed afterwards' })
        .where(eq(surgicalCases.id, a.id)),
    ).rejects.toThrow();

    const detail = await api().get(`/api/v1/theatre/cases/${a.id}`).set(bearer(w.tokens.doctor));
    expect(detail.body.progress).toEqual({ signIn: true, timeOut: true, signOut: true });
    expect(detail.body.checklist.signIn.by.id).toBe(theatreNurse.id);
  });
});

describe('access', () => {
  it('gives theatre staff the record only around the operation', async () => {
    const summary = () =>
      api().get(`/api/v1/patients/${w.otherPatient.id}/summary`).set(bearer(theatreNurse.token));
    // The colleague cares for the other patient so they can request the operation.
    await api()
      .post(`/api/v1/patients/${w.otherPatient.id}/care-team`)
      .set(bearer(w.tokens.director))
      .send({ doctorId: w.users.colleague.id });
    const [consent] = await db
      .insert(consentRecords)
      .values({
        patientId: w.otherPatient.id,
        type: 'TREATMENT',
        decision: 'GRANTED',
        method: 'IN_PERSON',
        procedure: 'Knee arthroscopy',
        wordingVersion: '2026-1',
        recordedById: w.users.colleague.id,
      })
      .returning();
    const created = await request(
      {
        patientId: w.otherPatient.id,
        primarySurgeonId: w.users.colleague.id,
        procedure: 'Knee arthroscopy',
        laterality: 'LEFT',
        consentRecordId: consent!.id,
      },
      w.tokens.colleague,
    );
    expect(created.status).toBe(201);
    expect((await summary()).status).toBe(403);
    await schedule(created.body.id, { scheduledStart: at(30) });
    expect((await summary()).status).toBe(200);
    // Long after the operation, access ends.
    await db.execute(
      sql`UPDATE surgical_cases SET status = 'COMPLETED', out_of_theatre_at = now() - interval '3 days' WHERE id = ${created.body.id}`,
    );
    expect((await summary()).status).toBe(403);
  });

  it('shows the indication only to the clinical team and gives patients a short view', async () => {
    const date = at(5).slice(0, 10);
    const forNurse = await api()
      .get(`/api/v1/theatre/schedule?date=${date}`)
      .set(bearer(theatreNurse.token));
    expect(forNurse.status).toBe(200);
    expect(forNurse.body.items.some((i: { indication?: string }) => i.indication)).toBe(true);
    const forReception = await api()
      .get(`/api/v1/theatre/schedule?date=${date}`)
      .set(bearer(w.tokens.reception));
    expect(forReception.status).toBe(200);
    expect(forReception.body.items.length).toBeGreaterThan(0);
    expect(forReception.body.items.every((i: { indication?: string }) => !i.indication)).toBe(true);

    const mine = await api()
      .get(`/api/v1/theatre/patients/${w.patient.id}/cases`)
      .set(bearer(w.tokens.patient));
    expect(mine.status).toBe(200);
    const completed = mine.body.items.find((i: { status: string }) => i.status === 'COMPLETED');
    expect(completed).toBeTruthy();
    expect(completed.operationNote).toBeUndefined();
    expect(completed.indication).toBeUndefined();
    expect(
      mine.body.items.every((i: { status: string }) =>
        ['SCHEDULED', 'COMPLETED'].includes(i.status),
      ),
    ).toBe(true);
    expect(
      (
        await api()
          .get(`/api/v1/theatre/patients/${w.patient.id}/cases`)
          .set(bearer(w.tokens.outsideDoctor))
      ).status,
    ).toBe(403);
  });

  it('reports theatre use to the director', async () => {
    const r = await api()
      .get(
        `/api/v1/reports/theatre?from=${new Date().toISOString().slice(0, 10)}&to=${at(48).slice(0, 10)}`,
      )
      .set(bearer(w.tokens.director));
    expect(r.status).toBe(200);
    const row = r.body.rows[0];
    expect(row).toMatchObject({ theatres: 2 });
    expect(row.cases).toBeGreaterThan(0);
    expect(typeof row.utilisationPct).toBe('number');
  });
});
