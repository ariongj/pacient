import { and, eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careTasks,
  guardianships,
  notifications,
  patients,
  referrals,
  screeningEpisodes,
  screeningOptOuts,
} from '../src/db/schema.js';
import {
  addMonths,
  ageOn,
  bandFor,
  inPopulation,
  isoDate,
  nextDueAfter,
} from '../src/modules/screening/definitions.js';
import {
  coverage,
  inviteDuePeople,
  programmeStatus,
  sendReminders,
} from '../src/modules/screening/screening.service.js';
import { SMALL_CELL_THRESHOLD } from '../src/modules/stats/stats.service.js';
import {
  api,
  bearer,
  createFacility,
  createPatient,
  createUser,
  createWorld,
  login,
} from './helpers.js';

const DAY = 86_400_000;
let w: Awaited<ReturnType<typeof createWorld>>;

/** Date of birth for someone who is `years` old today (birthday a month ago). */
const dobForAge = (years: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return isoDate(d);
};

async function person(
  facilityId: string,
  sex: 'FEMALE' | 'MALE',
  age: number,
  opts: { userId?: string; doctorId?: string } = {},
) {
  const p = await createPatient(facilityId, opts);
  await db
    .update(patients)
    .set({ sex, dateOfBirth: dobForAge(age), municipality: 'Prizren' })
    .where(eq(patients.id, p.id));
  return { ...p, sex, dateOfBirth: dobForAge(age) };
}

const episodesOf = (patientId: string) =>
  db.select().from(screeningEpisodes).where(eq(screeningEpisodes.patientId, patientId));

beforeAll(async () => {
  w = await createWorld();
});

describe('programme rules (illustrative)', () => {
  it('selects the population by sex and age', () => {
    const at = new Date('2026-06-01T00:00:00Z');
    const f = (age: number) => ({ sex: 'FEMALE', dateOfBirth: `${2026 - age}-01-15` });
    const m = (age: number) => ({ sex: 'MALE', dateOfBirth: `${2026 - age}-01-15` });
    expect(inPopulation('CERVICAL', f(24), at)).toBe(false);
    expect(inPopulation('CERVICAL', f(25), at)).toBe(true);
    expect(inPopulation('CERVICAL', f(64), at)).toBe(true);
    expect(inPopulation('CERVICAL', f(65), at)).toBe(false);
    expect(inPopulation('CERVICAL', m(40), at)).toBe(false);
    expect(inPopulation('BREAST', f(49), at)).toBe(false);
    expect(inPopulation('BREAST', f(50), at)).toBe(true);
    expect(inPopulation('BREAST', f(69), at)).toBe(true);
    expect(inPopulation('BREAST', f(70), at)).toBe(false);
    expect(inPopulation('COLORECTAL', m(50), at)).toBe(true);
    expect(inPopulation('COLORECTAL', f(74), at)).toBe(true);
    expect(inPopulation('COLORECTAL', m(75), at)).toBe(false);
    expect(ageOn('1976-06-02', at)).toBe(49);
    expect(ageOn('1976-06-01', at)).toBe(50);
  });

  it('computes the next due date from the interval for the age at the test', () => {
    const at = new Date('2026-03-31T10:00:00Z');
    expect(bandFor('CERVICAL', 30)).toMatchObject({ months: 36, test: 'CYTOLOGY' });
    expect(bandFor('CERVICAL', 55)).toMatchObject({ months: 60, test: 'HPV' });
    expect(nextDueAfter('CERVICAL', { dateOfBirth: '1996-01-01' }, at, 'NORMAL')).toBe(
      '2029-03-31',
    );
    expect(nextDueAfter('CERVICAL', { dateOfBirth: '1970-01-01' }, at, 'NORMAL')).toBe(
      '2031-03-31',
    );
    // Five years on she would be 66: no further routine invitation.
    expect(nextDueAfter('CERVICAL', { dateOfBirth: '1965-01-01' }, at, 'NORMAL')).toBeNull();
    expect(nextDueAfter('BREAST', { dateOfBirth: '1970-01-01' }, at, 'NORMAL')).toBe('2028-03-31');
    expect(nextDueAfter('COLORECTAL', { dateOfBirth: '1960-01-01' }, at, 'INADEQUATE')).toBe(
      '2026-06-30',
    );
    expect(nextDueAfter('COLORECTAL', { dateOfBirth: '1960-01-01' }, at, 'ABNORMAL')).toBeNull();
    expect(isoDate(addMonths(new Date('2026-01-31T00:00:00Z'), 1))).toBe('2026-02-28');
  });
});

describe('invitations and reminders', () => {
  it('invites only eligible people, at most the daily cap per facility, once', async () => {
    const f = await createFacility();
    const eligible = [
      await person(f.id, 'FEMALE', 30),
      await person(f.id, 'FEMALE', 31),
      await person(f.id, 'FEMALE', 32),
    ];
    const male = await person(f.id, 'MALE', 40);
    const tooYoung = await person(f.id, 'FEMALE', 22);
    const optedOut = await person(f.id, 'FEMALE', 33);
    await db
      .insert(screeningOptOuts)
      .values({ patientId: optedOut.id, programme: 'CERVICAL', recordedVia: 'PORTAL' });
    const deceased = await person(f.id, 'FEMALE', 34);
    await db.update(patients).set({ deceasedAt: new Date() }).where(eq(patients.id, deceased.id));
    const recent = await person(f.id, 'FEMALE', 35);
    await db.insert(screeningEpisodes).values({
      patientId: recent.id,
      programme: 'CERVICAL',
      facilityId: f.id,
      status: 'RESULTED',
      dueDate: isoDate(new Date(Date.now() - 400 * DAY)),
      screenedAt: new Date(Date.now() - 400 * DAY),
      result: 'NORMAL',
      resultedAt: new Date(Date.now() - 390 * DAY),
      nextDueDate: isoDate(new Date(Date.now() + 700 * DAY)),
    });
    const ceased = await person(f.id, 'FEMALE', 36);
    await db.insert(screeningEpisodes).values({
      patientId: ceased.id,
      programme: 'CERVICAL',
      facilityId: f.id,
      status: 'NOT_ELIGIBLE',
      dueDate: isoDate(new Date()),
      resultDetail: 'Total hysterectomy',
    });
    const underFollowUp = await person(f.id, 'FEMALE', 37);
    await db.insert(screeningEpisodes).values({
      patientId: underFollowUp.id,
      programme: 'CERVICAL',
      facilityId: f.id,
      status: 'REFERRED',
      dueDate: isoDate(new Date()),
      result: 'ABNORMAL',
      resultedAt: new Date(),
    });

    const atFacility = async () =>
      db
        .select()
        .from(screeningEpisodes)
        .where(
          and(eq(screeningEpisodes.facilityId, f.id), eq(screeningEpisodes.status, 'INVITED')),
        );
    // Other test files' patients are invited too; only this facility is checked.
    await inviteDuePeople(new Date(), 2);
    const first = await atFacility();
    expect(first).toHaveLength(2);
    expect(first.every((e) => eligible.some((p) => p.id === e.patientId))).toBe(true);
    expect(first[0]!.testType).toBe('CYTOLOGY');
    // The same day the cap is already used.
    await inviteDuePeople(new Date(), 2);
    expect(await atFacility()).toHaveLength(2);
    // Next day the third eligible person is invited; nobody twice, nobody excluded.
    await inviteDuePeople(new Date(Date.now() + DAY), 2);
    const second = await atFacility();
    expect(second).toHaveLength(3);
    expect(new Set(second.map((e) => e.patientId))).toEqual(new Set(eligible.map((p) => p.id)));
    for (const p of [male, tooYoung, optedOut, deceased, recent, ceased, underFollowUp]) {
      expect((await episodesOf(p.id)).filter((e) => e.status === 'INVITED')).toHaveLength(0);
    }
    const audited = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'screening.invited'),
          inArray(
            auditLogs.patientId,
            eligible.map((p) => p.id),
          ),
        ),
      );
    expect(audited).toHaveLength(3);
  });

  it('notifies the person without health details and reminds once after six weeks', async () => {
    const f = await createFacility();
    const user = await createUser('PATIENT');
    const p = await person(f.id, 'FEMALE', 55, { userId: user.id });
    await inviteDuePeople(new Date(), 10);
    const invited = await episodesOf(p.id);
    // A woman of 55 is in all three programmes; one message for all of them.
    expect(invited.map((e) => e.programme).sort()).toEqual(['BREAST', 'CERVICAL', 'COLORECTAL']);
    const messages = await db.select().from(notifications).where(eq(notifications.userId, user.id));
    expect(messages).toHaveLength(1);
    expect(messages[0]!.title).not.toMatch(/cervi|breast|bowel|cancer|qafë|gji|zorr/i);
    await db
      .update(screeningEpisodes)
      .set({ invitedAt: new Date(Date.now() - 43 * DAY) })
      .where(eq(screeningEpisodes.patientId, p.id));
    expect(await sendReminders()).toBeGreaterThanOrEqual(3);
    expect(await sendReminders()).toBe(0);
    const after = await db.select().from(notifications).where(eq(notifications.userId, user.id));
    expect(after).toHaveLength(2);
    expect((await episodesOf(p.id)).every((e) => e.reminderSentAt)).toBe(true);
  });
});

describe('screening lifecycle in the chart', () => {
  const base = '/api/v1/screening';
  const doctor = () => bearer(w.tokens.doctor);

  it('shows the programmes to the care team only and records views', async () => {
    const res = await api().get(`${base}/patients/${w.patient.id}`).set(doctor());
    expect(res.status).toBe(200);
    const cervical = res.body.programmes.find(
      (p: { programme: string }) => p.programme === 'CERVICAL',
    );
    expect(cervical).toMatchObject({ inPopulation: true, testOffered: 'CYTOLOGY' });
    expect(
      res.body.programmes.find((p: { programme: string }) => p.programme === 'BREAST'),
    ).toMatchObject({ state: 'NOT_IN_POPULATION' });
    expect(
      (await api().get(`${base}/patients/${w.patient.id}`).set(bearer(w.tokens.colleague))).status,
    ).toBe(403);
    expect(
      (await api().get(`${base}/patients/${w.patient.id}`).set(bearer(w.tokens.reception))).status,
    ).toBe(403);
    expect(
      (await api().get(`${base}/patients/${w.patient.id}`).set(bearer(w.tokens.director))).status,
    ).toBe(403);
    const views = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.patientId, w.patient.id), eq(auditLogs.action, 'patient.record.viewed')),
      );
    expect(views.some((v) => (v.metadata as { section?: string }).section === 'screening')).toBe(
      true,
    );
  });

  it('invite → book → test → normal result sets the next routine due date', async () => {
    const p = await person(w.facility.id, 'FEMALE', 40, { doctorId: w.users.doctor.id });
    const invite = await api()
      .post(`${base}/patients/${p.id}/invitations`)
      .set(doctor())
      .send({ programme: 'CERVICAL' });
    expect(invite.status).toBe(201);
    const id = invite.body.id as string;
    expect(
      (
        await api()
          .post(`${base}/patients/${p.id}/invitations`)
          .set(doctor())
          .send({ programme: 'CERVICAL' })
      ).status,
    ).toBe(409);
    // Men are not in the cervical programme.
    const man = await person(w.facility.id, 'MALE', 40, { doctorId: w.users.doctor.id });
    expect(
      (
        await api()
          .post(`${base}/patients/${man.id}/invitations`)
          .set(doctor())
          .send({ programme: 'CERVICAL' })
      ).status,
    ).toBe(400);

    const book = await api()
      .post(`${base}/episodes/${id}/book`)
      .set(bearer(w.tokens.nurse))
      .send({ bookedFor: new Date(Date.now() + 7 * DAY).toISOString() });
    // The nurse is not on this patient's care team.
    expect(book.status).toBe(403);
    expect(
      (
        await api()
          .post(`${base}/episodes/${id}/book`)
          .set(doctor())
          .send({ bookedFor: new Date(Date.now() + 7 * DAY).toISOString() })
      ).body.status,
    ).toBe('BOOKED');
    const wrongTest = await api()
      .post(`${base}/episodes/${id}/test`)
      .set(doctor())
      .send({ screenedAt: new Date().toISOString(), testType: 'FIT' });
    expect(wrongTest.status).toBe(400);
    const screenedAt = new Date();
    expect(
      (
        await api()
          .post(`${base}/episodes/${id}/test`)
          .set(doctor())
          .send({ screenedAt: screenedAt.toISOString(), testType: 'CYTOLOGY' })
      ).body.status,
    ).toBe('SCREENED');
    const result = await api()
      .post(`${base}/episodes/${id}/result`)
      .set(doctor())
      .send({ result: 'NORMAL', resultDetail: 'NILM' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: 'RESULTED',
      result: 'NORMAL',
      nextDueDate: isoDate(addMonths(screenedAt, 36)),
    });
    const view = await api().get(`${base}/patients/${p.id}`).set(doctor());
    expect(
      view.body.programmes.find((x: { programme: string }) => x.programme === 'CERVICAL'),
    ).toMatchObject({ state: 'UP_TO_DATE', lastResult: 'NORMAL' });
    // A second result is refused.
    expect(
      (await api().post(`${base}/episodes/${id}/result`).set(doctor()).send({ result: 'NORMAL' }))
        .status,
    ).toBe(409);
  });

  it('an inadequate sample is repeated after three months', async () => {
    const p = await person(w.facility.id, 'FEMALE', 60, { doctorId: w.users.doctor.id });
    const id = (
      await api()
        .post(`${base}/patients/${p.id}/invitations`)
        .set(doctor())
        .send({ programme: 'COLORECTAL' })
    ).body.id as string;
    const noTest = await api()
      .post(`${base}/episodes/${id}/result`)
      .set(doctor())
      .send({ result: 'INADEQUATE' });
    expect(noTest.status).toBe(400);
    const screenedAt = new Date();
    const res = await api()
      .post(`${base}/episodes/${id}/result`)
      .set(doctor())
      .send({ result: 'INADEQUATE', screenedAt: screenedAt.toISOString(), testType: 'FIT' });
    expect(res.body).toMatchObject({
      status: 'RESULTED',
      nextDueDate: isoDate(addMonths(screenedAt, 3)),
    });
  });

  it('an abnormal result starts follow-up with a task for the patient’s doctor', async () => {
    const p = await person(w.facility.id, 'FEMALE', 58, { doctorId: w.users.doctor.id });
    const id = (
      await api()
        .post(`${base}/patients/${p.id}/invitations`)
        .set(doctor())
        .send({ programme: 'BREAST' })
    ).body.id as string;
    const otherReferral = await db
      .insert(referrals)
      .values({
        patientId: w.otherPatient.id,
        fromFacilityId: w.facility.id,
        toFacilityId: w.otherFacility.id,
        fromDoctorId: w.users.doctor.id,
        specialty: 'Breast surgery',
        reason: 'Other patient',
        clinicalSummary: 'Other patient',
      })
      .returning();
    {
      const wrong = await api().post(`${base}/episodes/${id}/result`).set(doctor()).send({
        result: 'ABNORMAL',
        screenedAt: new Date().toISOString(),
        testType: 'MAMMOGRAPHY',
        referralId: otherReferral[0]!.id,
      });
      expect(wrong.status).toBe(400);
    }
    const res = await api().post(`${base}/episodes/${id}/result`).set(doctor()).send({
      result: 'ABNORMAL',
      resultDetail: 'BI-RADS 4',
      screenedAt: new Date().toISOString(),
      testType: 'MAMMOGRAPHY',
    });
    expect(res.body).toMatchObject({ status: 'REFERRED', result: 'ABNORMAL', nextDueDate: null });
    const tasks = await db.select().from(careTasks).where(eq(careTasks.patientId, p.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ assignedToId: w.users.doctor.id, priority: 'URGENT' });
    const told = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.doctor.id),
          eq(notifications.type, 'screening_follow_up'),
        ),
      );
    expect(told.length).toBeGreaterThanOrEqual(1);

    // The worklist shows the follow-up, flagged after the safety-net period without a referral.
    await db
      .update(screeningEpisodes)
      .set({ resultedAt: new Date(Date.now() - 20 * DAY) })
      .where(eq(screeningEpisodes.id, id));
    const list = await api()
      .get(`${base}/worklist`)
      .query({ view: 'followup', pageSize: 100 })
      .set(doctor());
    expect(list.status).toBe(200);
    const row = list.body.items.find((x: { patient: { id: string } }) => x.patient.id === p.id);
    expect(row.programmes[0]).toMatchObject({ state: 'FOLLOW_UP', followUpOverdue: true });

    // Nurses cannot close a follow-up; the doctor returns the patient to routine screening.
    expect(
      (
        await api()
          .post(`${base}/episodes/${id}/close`)
          .set(bearer(w.tokens.nurse))
          .send({ nextDueDate: null })
      ).status,
    ).toBe(403);
    const next = isoDate(new Date(Date.now() + 365 * DAY));
    const closed = await api()
      .post(`${base}/episodes/${id}/close`)
      .set(doctor())
      .send({ nextDueDate: next, note: 'Benign on biopsy' });
    expect(closed.body).toMatchObject({ status: 'CLOSED', nextDueDate: next });
  });

  it('declining, ceasing and reinstating', async () => {
    const p = await person(w.facility.id, 'FEMALE', 45, { doctorId: w.users.doctor.id });
    const id = (
      await api()
        .post(`${base}/patients/${p.id}/invitations`)
        .set(doctor())
        .send({ programme: 'CERVICAL' })
    ).body.id as string;
    const declined = await api()
      .post(`${base}/episodes/${id}/decline`)
      .set(doctor())
      .send({ reason: 'Not this year' });
    expect(declined.body.status).toBe('DECLINED');
    expect(declined.body.nextDueDate > isoDate(new Date())).toBe(true);

    const cease = await api()
      .post(`${base}/patients/${p.id}/cease`)
      .set(doctor())
      .send({ programme: 'CERVICAL', reason: 'Total hysterectomy 2025' });
    expect(cease.status).toBe(201);
    const statuses = (await api().get(`${base}/patients/${p.id}`).set(doctor())).body.programmes;
    expect(statuses.find((x: { programme: string }) => x.programme === 'CERVICAL').state).toBe(
      'CEASED',
    );
    // The worker never invites a ceased programme.
    await inviteDuePeople(new Date(), 1000);
    expect(
      (await episodesOf(p.id)).filter((e) => e.programme === 'CERVICAL' && e.status === 'INVITED'),
    ).toHaveLength(0);
    // A doctor can reinstate by inviting again.
    const again = await api()
      .post(`${base}/patients/${p.id}/invitations`)
      .set(doctor())
      .send({ programme: 'CERVICAL' });
    expect(again.status).toBe(201);
  });

  it('programme state follows the latest episode', () => {
    const now = new Date();
    const person = { sex: 'FEMALE', dateOfBirth: dobForAge(52) };
    const ep = (over: Partial<typeof screeningEpisodes.$inferSelect>) =>
      ({
        id: 'x',
        patientId: 'p',
        programme: 'BREAST',
        facilityId: 'f',
        status: 'INVITED',
        invitedAt: now,
        reminderSentAt: null,
        dueDate: isoDate(now),
        bookedFor: null,
        screenedAt: null,
        testType: null,
        result: null,
        resultDetail: null,
        resultedAt: null,
        referralId: null,
        nextDueDate: null,
        recordedById: null,
        createdAt: now,
        updatedAt: now,
        ...over,
      }) as typeof screeningEpisodes.$inferSelect;
    expect(programmeStatus('BREAST', person, [], []).state).toBe('DUE');
    expect(programmeStatus('BREAST', person, [ep({})], []).state).toBe('IN_PROGRESS');
    expect(
      programmeStatus(
        'BREAST',
        person,
        [ep({ invitedAt: new Date(now.getTime() - 100 * DAY) })],
        [],
      ).invitationOverdue,
    ).toBe(true);
    expect(
      programmeStatus(
        'BREAST',
        person,
        [ep({ status: 'RESULTED', result: 'NORMAL', nextDueDate: '2099-01-01' })],
        [],
      ).state,
    ).toBe('UP_TO_DATE');
    expect(
      programmeStatus('BREAST', person, [ep({ status: 'RESULTED', nextDueDate: null })], []).state,
    ).toBe('LEFT');
    expect(
      programmeStatus(
        'BREAST',
        person,
        [],
        [
          {
            id: 'o',
            patientId: 'p',
            programme: 'BREAST',
            reason: null,
            recordedVia: 'PORTAL',
            recordedById: null,
            createdAt: now,
            withdrawnAt: null,
          },
        ],
      ).state,
    ).toBe('OPTED_OUT');
  });
});

describe('the patient in the portal', () => {
  it('sees programmes and results without clinical text, and can opt out and back in', async () => {
    const res = await api().get('/api/v1/screening/mine').set(bearer(w.tokens.patient));
    expect(res.status).toBe(200);
    expect(res.body.programmes).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toContain('resultDetail');

    const out = await api()
      .post('/api/v1/screening/mine/opt-outs')
      .set(bearer(w.tokens.patient))
      .send({ programme: 'CERVICAL', reason: 'Screened privately' });
    expect(out.status).toBe(201);
    expect(
      (
        await api()
          .post('/api/v1/screening/mine/opt-outs')
          .set(bearer(w.tokens.patient))
          .send({ programme: 'CERVICAL' })
      ).status,
    ).toBe(409);
    const mine = await api().get('/api/v1/screening/mine').set(bearer(w.tokens.patient));
    expect(
      mine.body.programmes.find((p: { programme: string }) => p.programme === 'CERVICAL'),
    ).toMatchObject({ state: 'OPTED_OUT', optedOut: true });
    // Never invited while opted out.
    await inviteDuePeople(new Date(), 1000);
    expect(
      (await episodesOf(w.patient.id)).filter(
        (e) => e.status === 'INVITED' && e.programme === 'CERVICAL',
      ),
    ).toHaveLength(0);
    const back = await api()
      .post('/api/v1/screening/mine/opt-outs/CERVICAL/withdraw')
      .set(bearer(w.tokens.patient));
    expect(back.status).toBe(200);
    expect(
      (
        await db
          .select()
          .from(auditLogs)
          .where(
            and(eq(auditLogs.patientId, w.patient.id), eq(auditLogs.action, 'screening.opt_out')),
          )
      ).length,
    ).toBe(2);
    // Staff cannot use the portal endpoints.
    expect((await api().get('/api/v1/screening/mine').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
  });

  it('refuses guardians whose access covers appointments only', async () => {
    const guardian = await createUser('PATIENT');
    const child = await createPatient(w.facility.id);
    await db.insert(guardianships).values({
      patientId: child.id,
      guardianUserId: guardian.id,
      relationship: 'PARENT',
      scope: 'APPOINTMENTS',
      evidence: 'Birth certificate 1/2026',
      verifiedById: w.users.reception.id,
      validUntil: new Date(Date.now() + 365 * DAY),
    });
    const token = await login(guardian.email);
    const res = await api()
      .get('/api/v1/screening/mine')
      .set(bearer(token))
      .set('X-Acting-For', child.id);
    expect(res.status).toBe(403);
  });
});

describe('coverage', () => {
  it('directors see their facility, the Ministry the nation, with small cells suppressed', async () => {
    const f = await createFacility({ municipality: 'Gjakovë' });
    const director = await createUser('DIRECTOR', f.id);
    const token = await login(director.email);
    // Six women aged 52: four screened within the interval (one abnormal), one opted out.
    const women = [];
    for (let i = 0; i < 6; i++) women.push(await person(f.id, 'FEMALE', 52));
    for (const [i, p] of women.slice(0, 4).entries()) {
      await db.insert(screeningEpisodes).values({
        patientId: p.id,
        programme: 'BREAST',
        facilityId: f.id,
        status: i === 0 ? 'REFERRED' : 'RESULTED',
        invitedAt: new Date(Date.now() - 60 * DAY),
        dueDate: isoDate(new Date(Date.now() - 60 * DAY)),
        screenedAt: new Date(Date.now() - 30 * DAY),
        testType: 'MAMMOGRAPHY',
        result: i === 0 ? 'ABNORMAL' : 'NORMAL',
        resultedAt: new Date(Date.now() - 20 * DAY),
        nextDueDate: i === 0 ? null : isoDate(new Date(Date.now() + 700 * DAY)),
      });
    }
    await db
      .insert(screeningOptOuts)
      .values({ patientId: women[5]!.id, programme: 'BREAST', recordedVia: 'PORTAL' });

    const res = await api().get('/api/v1/screening/coverage').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('FACILITY');
    const breast = res.body.total.find((r: { programme: string }) => r.programme === 'BREAST');
    // Population 6 is shown; 4 screened and 1 abnormal are below the threshold of 5.
    expect(SMALL_CELL_THRESHOLD).toBe(5);
    expect(breast).toMatchObject({
      population: 6,
      screenedInInterval: null,
      coveragePct: null,
      abnormal12m: null,
      suppressed: true,
    });
    expect(
      (
        await api()
          .get('/api/v1/screening/coverage')
          .query({ facilityId: w.facility.id })
          .set(bearer(token))
      ).status,
    ).toBe(403);
    expect(
      (await api().get('/api/v1/screening/coverage').set(bearer(w.tokens.doctor))).status,
    ).toBe(403);

    // A fifth screened woman lifts the screened count over the threshold.
    await db.insert(screeningEpisodes).values({
      patientId: women[4]!.id,
      programme: 'BREAST',
      facilityId: f.id,
      status: 'RESULTED',
      dueDate: isoDate(new Date()),
      screenedAt: new Date(Date.now() - 10 * DAY),
      testType: 'MAMMOGRAPHY',
      result: 'NORMAL',
      resultedAt: new Date(Date.now() - 5 * DAY),
      nextDueDate: isoDate(new Date(Date.now() + 700 * DAY)),
    });
    const [row] = (await coverage({ facilityId: f.id, groupBy: 'NONE' })).filter(
      (r) => r.programme === 'BREAST',
    );
    expect(row).toMatchObject({ population: 6, screenedInInterval: 5, coveragePct: 83.3 });

    const national = await api()
      .get('/api/v1/screening/coverage')
      .query({ groupBy: 'MUNICIPALITY' })
      .set(bearer(w.tokens.ministry));
    expect(national.status).toBe(200);
    expect(national.body.scope).toBe('NATIONAL');
    expect(national.body.rows.some((r: { group: string }) => r.group === 'Prizren')).toBe(true);
    expect(JSON.stringify(national.body)).not.toMatch(/firstName|nationalId/);
  });
});
