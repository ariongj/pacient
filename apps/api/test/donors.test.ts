import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  bloodDonations,
  bloodDonors,
  bloodUnits,
  careUnits,
  guardianships,
  notifications,
  patients,
  unitStaff,
} from '../src/db/schema.js';
import {
  deferralFrom,
  evaluateEligibility,
  nextEligibleDate,
  registrationProblem,
  SCREENING_DISCARD,
  type DonorFacts,
} from '../src/modules/donors/donors.service.js';
import { api, bearer, createUser, createWorld, login, nextNationalId } from './helpers.js';

const DAY = 86_400_000;
const NOW = new Date('2026-06-15T09:00:00Z');
const ago = (days: number, from = NOW) => new Date(from.getTime() - days * DAY);

const facts = (over: Partial<DonorFacts> = {}): DonorFacts => ({
  sex: 'MALE',
  dateOfBirth: '1990-01-01',
  status: 'ACTIVE',
  deferredUntil: null,
  donationDates: [],
  completedCount: 3,
  ...over,
});
const fine = { haemoglobin: 150, systolic: 120, diastolic: 80, pulse: 70, weightKg: 75 };
const codes = (f: DonorFacts, m = fine, answers = {}) =>
  evaluateEligibility(f, answers, m, NOW).map((p) => p.code);

describe('eligibility rules (illustrative, after Directive 2004/33/EC)', () => {
  it('registers donors aged 18–65 and first-time donors up to 60', () => {
    expect(registrationProblem({ dateOfBirth: '2008-07-01' }, 0, NOW)?.code).toBe('TOO_YOUNG');
    expect(registrationProblem({ dateOfBirth: '2008-06-01' }, 0, NOW)).toBeNull();
    expect(registrationProblem({ dateOfBirth: '1963-01-01' }, 0, NOW)?.code).toBe(
      'FIRST_DONATION_AGE',
    );
    expect(registrationProblem({ dateOfBirth: '1963-01-01' }, 5, NOW)).toBeNull();
    expect(registrationProblem({ dateOfBirth: '1960-01-01' }, 5, NOW)?.code).toBe('TOO_OLD');
  });

  it('keeps 12 weeks between donations for men and 16 for women', () => {
    expect(codes(facts({ donationDates: [ago(83)] }))).toContain('INTERVAL');
    expect(codes(facts({ donationDates: [ago(84)] }))).toEqual([]);
    const woman = { sex: 'FEMALE', donationDates: [ago(100)] };
    expect(codes(facts(woman), { ...fine, haemoglobin: 135 })).toContain('INTERVAL');
    expect(nextEligibleDate(facts(woman), NOW)).toBe('2026-06-27');
  });

  it('allows at most 4 donations a year for men and 3 for women', () => {
    const men = facts({ donationDates: [ago(90), ago(180), ago(270), ago(360)] });
    expect(codes(men)).toContain('INTERVAL');
    expect(nextEligibleDate(men, NOW)).toBe('2026-06-20');
    const women = facts({ sex: 'FEMALE', donationDates: [ago(120), ago(240), ago(360)] });
    expect(codes(women, { ...fine, haemoglobin: 130 })).toContain('INTERVAL');
    expect(codes(facts({ donationDates: [ago(120), ago(240), ago(370)] }))).toEqual([]);
  });

  it('checks haemoglobin by sex, blood pressure, pulse and weight', () => {
    expect(codes(facts(), { ...fine, haemoglobin: 130 })).toEqual(['HB_LOW']);
    expect(codes(facts({ sex: 'FEMALE' }), { ...fine, haemoglobin: 130 })).toEqual([]);
    expect(codes(facts({ sex: 'FEMALE' }), { ...fine, haemoglobin: 124 })).toEqual(['HB_LOW']);
    expect(codes(facts(), { ...fine, systolic: 185 })).toEqual(['BP_SYSTOLIC']);
    expect(codes(facts(), { ...fine, diastolic: 55 })).toEqual(['BP_DIASTOLIC']);
    expect(codes(facts(), { ...fine, pulse: 110 })).toEqual(['PULSE']);
    expect(codes(facts(), { ...fine, weightKg: 49 })).toEqual(['WEIGHT']);
  });

  it('turns questionnaire answers into deferrals: permanent wins, else the longest', () => {
    const p = evaluateEligibility(
      facts(),
      { FEELING_WELL: true, TATTOO_PIERCING: true, ANTIBIOTICS: true },
      fine,
      NOW,
    );
    expect(p.map((x) => x.code)).toEqual(['Q_ANTIBIOTICS', 'Q_TATTOO_PIERCING']);
    expect(deferralFrom(p, NOW)).toEqual({ status: 'DEFERRED', until: '2026-10-13' });
    const perm = evaluateEligibility(facts(), { INJECTED_DRUGS: true, ANTIBIOTICS: true }, {}, NOW);
    expect(deferralFrom(perm, NOW)).toEqual({ status: 'PERMANENTLY_DEFERRED', until: null });
    // The pregnancy question only applies to women.
    expect(codes(facts(), fine, { PREGNANCY: true })).toEqual([]);
    expect(
      codes(facts({ sex: 'FEMALE' }), { ...fine, haemoglobin: 130 }, { PREGNANCY: true }),
    ).toEqual(['Q_PREGNANCY']);
  });

  it('respects an existing deferral', () => {
    expect(codes(facts({ status: 'DEFERRED', deferredUntil: '2026-07-01' }))).toEqual(['DEFERRED']);
    expect(codes(facts({ status: 'DEFERRED', deferredUntil: '2026-06-01' }))).toEqual([]);
    expect(codes(facts({ status: 'PERMANENTLY_DEFERRED' }))).toEqual(['PERMANENTLY_DEFERRED']);
  });
});

/* ------------------------------------------------------------------ API ------------------- */

let w: Awaited<ReturnType<typeof createWorld>>;
let nurse: { id: string; token: string };
let doctor: { id: string; token: string };
let outsideStaff: string;

const send = (method: 'get' | 'post' | 'patch', path: string, token: string, body?: object) => {
  const r = api()[method](`/api/v1/blood-donors${path}`).set(bearer(token));
  return body ? r.send(body) : r;
};
const noAnswers = { FEELING_WELL: true };

async function person(
  sex: 'MALE' | 'FEMALE' = 'MALE',
  dateOfBirth = '1990-03-01',
  userId?: string,
) {
  const [p] = await db
    .insert(patients)
    .values({
      nationalId: nextNationalId(),
      firstName: 'Donor',
      lastName: `Test${Math.random().toString(36).slice(2, 7)}`,
      dateOfBirth,
      sex,
      primaryFacilityId: w.facility.id,
      userId: userId ?? null,
    })
    .returning();
  return p!;
}

async function register(patientId: string, contactConsent = true) {
  const res = await send('post', '/donors', nurse.token, { patientId, contactConsent });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function donate(donorId: string, extra: object = {}) {
  return send('post', `/donors/${donorId}/donations`, nurse.token, {
    answers: noAnswers,
    measurements: fine,
    outcome: 'COMPLETED',
    volumeMl: 450,
    ...extra,
  });
}

const negative = { hiv: 'NEGATIVE', hbv: 'NEGATIVE', hcv: 'NEGATIVE', syphilis: 'NEGATIVE' };

beforeAll(async () => {
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({ facilityId: w.facility.id, name: 'Blood bank', code: 'BBD', type: 'BLOOD_BANK' })
    .returning();
  const n = await createUser('NURSE', w.facility.id);
  const d = await createUser('DOCTOR', w.facility.id, { specialty: 'Transfusion medicine' });
  await db.insert(unitStaff).values([
    { unitId: unit!.id, userId: n.id },
    { unitId: unit!.id, userId: d.id },
  ]);
  nurse = { id: n.id, token: await login(n.email) };
  doctor = { id: d.id, token: await login(d.email) };
  const [otherUnit] = await db
    .insert(careUnits)
    .values({ facilityId: w.otherFacility.id, name: 'Blood bank', code: 'BBO', type: 'BLOOD_BANK' })
    .returning();
  const o = await createUser('NURSE', w.otherFacility.id);
  await db.insert(unitStaff).values({ unitId: otherUnit!.id, userId: o.id });
  outsideStaff = await login(o.email);
});

describe('register and access', () => {
  it('only blood bank staff work with donors', async () => {
    const p = await person();
    expect((await send('get', '/me', nurse.token)).body.isStaff).toBe(true);
    expect((await send('get', '/me', w.tokens.nurse)).body.isStaff).toBe(false);
    for (const token of [w.tokens.nurse, w.tokens.doctor, w.tokens.reception, w.tokens.patient]) {
      expect((await send('post', '/donors', token, { patientId: p.id })).status).toBe(403);
      expect((await send('get', '/testing-queue', token)).status).toBe(403);
    }
  });

  it('looks people up by national ID and refuses minors and duplicates', async () => {
    const p = await person();
    const look = await send('get', `/lookup?nationalId=${p.nationalId}`, nurse.token);
    expect(look.status).toBe(200);
    expect(look.body.donorId).toBeNull();
    const kid = await person('MALE', '2012-01-01');
    const kidLook = await send('get', `/lookup?nationalId=${kid.nationalId}`, nurse.token);
    expect(kidLook.body.registrationProblem.code).toBe('TOO_YOUNG');
    expect((await send('post', '/donors', nurse.token, { patientId: kid.id })).status).toBe(400);
    const id = await register(p.id);
    expect((await send('post', '/donors', nurse.token, { patientId: p.id })).status).toBe(409);
    const [log] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, id), eq(auditLogs.action, 'donors.donor')));
    expect(log).toBeTruthy();
  });

  it('audits the view of a donor record; other blood banks find donors only by national ID', async () => {
    const p = await person();
    const id = await register(p.id);
    const detail = await send('get', `/donors/${id}`, nurse.token);
    expect(detail.status).toBe(200);
    expect(detail.body.person.nationalId).toBe(p.nationalId);
    const views = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.patientId, p.id), eq(auditLogs.action, 'patient.record.viewed')));
    expect(views.length).toBeGreaterThan(0);
    const byName = await send('get', `/donors?q=${p.lastName}`, outsideStaff);
    expect(byName.body.items).toEqual([]);
    const byId = await send('get', `/donors?q=${p.nationalId}`, outsideStaff);
    expect(byId.body.items.map((x: { id: string }) => x.id)).toEqual([id]);
  });
});

describe('donation visits', () => {
  it('computes live eligibility without storing anything', async () => {
    const id = await register((await person()).id);
    const res = await send('post', `/donors/${id}/eligibility`, nurse.token, {
      answers: { FEELING_WELL: true, TATTOO_PIERCING: true },
      measurements: { haemoglobin: 128 },
    });
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
    expect(res.body.problems.map((p: { code: string }) => p.code)).toEqual([
      'Q_TATTOO_PIERCING',
      'HB_LOW',
    ]);
    expect(res.body.problems[1].vars).toEqual({ min: 135 });
    expect(res.body.deferral.status).toBe('DEFERRED');
    const rows = await db.select().from(bloodDonations).where(eq(bloodDonations.donorId, id));
    expect(rows).toEqual([]);
  });

  it('refuses to collect from an ineligible donor and enforces the volume', async () => {
    const id = await register((await person()).id);
    const low = await donate(id, { measurements: { ...fine, haemoglobin: 120 } });
    expect(low.status).toBe(409);
    expect(low.body.error.code).toBe('NOT_ELIGIBLE');
    expect((await donate(id, { volumeMl: 300 })).status).toBe(400);
    expect((await donate(id, { measurements: { haemoglobin: 150 } })).status).toBe(400);
  });

  it('defers by the rules and does not shorten a longer deferral', async () => {
    const id = await register((await person()).id);
    const res = await donate(id, {
      outcome: 'DEFERRED',
      answers: { FEELING_WELL: true, TATTOO_PIERCING: true },
      volumeMl: null,
    });
    expect(res.status).toBe(201);
    const [d1] = await db.select().from(bloodDonors).where(eq(bloodDonors.id, id));
    expect(d1!.status).toBe('DEFERRED');
    const until = d1!.deferredUntil!;
    expect(until > new Date(Date.now() + 119 * DAY).toISOString().slice(0, 10)).toBe(true);
    // A later, shorter manual deferral leaves the longer one.
    await donate(id, {
      outcome: 'DEFERRED',
      volumeMl: null,
      manualDeferral: { days: 3, reason: 'Feeling faint in the waiting room' },
    });
    const [d2] = await db.select().from(bloodDonors).where(eq(bloodDonors.id, id));
    expect(d2!.deferredUntil).toBe(until);
    // Deferral without any reason is refused.
    const p2 = await register((await person()).id);
    expect((await donate(p2, { outcome: 'DEFERRED', volumeMl: null })).status).toBe(400);
  });

  it('a completed donation has no unit until tested, then counts towards the interval', async () => {
    const u = await createUser('PATIENT');
    const p = await person('FEMALE', '1985-04-04', u.id);
    const id = await register(p.id);
    const res = await donate(id, { measurements: { ...fine, haemoglobin: 130 } });
    expect(res.status).toBe(201);
    expect(res.body.bloodUnitId).toBeNull();
    const queue = await send('get', '/testing-queue', nurse.token);
    expect(queue.body.items.map((x: { id: string }) => x.id)).toContain(res.body.id);
    const today = await send('get', '/today', nurse.token);
    expect(today.body.items.map((x: { id: string }) => x.id)).toContain(res.body.id);
    const again = await donate(id, { measurements: { ...fine, haemoglobin: 130 } });
    expect(again.status).toBe(409);
    expect(again.body.error.details.map((p: { code: string }) => p.code)).toContain('INTERVAL');
    const thanks = await db.select().from(notifications).where(eq(notifications.userId, u.id));
    expect(thanks.map((n) => n.title)).toContain('Thank you for donating blood today');
  });

  it('protects donations: only the unit link and the adverse reaction may change', async () => {
    const id = await register((await person()).id);
    const res = await donate(id);
    await expect(
      db.update(bloodDonations).set({ volumeMl: 300 }).where(eq(bloodDonations.id, res.body.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(bloodDonations).where(eq(bloodDonations.id, res.body.id)),
    ).rejects.toThrow();
    const r1 = await send('post', `/donations/${res.body.id}/adverse-reaction`, nurse.token, {
      description: 'Mild vasovagal reaction',
    });
    expect(r1.status).toBe(200);
    expect(r1.body.adverseReaction).toBe('Mild vasovagal reaction');
    const r2 = await send('post', `/donations/${res.body.id}/adverse-reaction`, nurse.token, {
      description: 'Another one',
    });
    expect(r2.status).toBe(409);
    expect(
      (
        await send('post', `/donations/${res.body.id}/adverse-reaction`, outsideStaff, {
          description: 'Other bank',
        })
      ).status,
    ).toBe(404);
  });
});

describe('testing and release', () => {
  it('releases a unit to stock when every marker is negative and confirms the group', async () => {
    const p = await person();
    const id = await register(p.id);
    const don = await donate(id);
    const res = await send('post', `/donations/${don.body.id}/tests`, nurse.token, {
      abo: 'A',
      rhD: 'NEG',
      ...negative,
    });
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(true);
    const [unit] = await db.select().from(bloodUnits).where(eq(bloodUnits.id, res.body.unit.id));
    expect(unit!.status).toBe('AVAILABLE');
    expect(unit!.unitNumber).toMatch(/^KSD\d{2}-\d{6}$/);
    expect(unit!.abo).toBe('A');
    const [donor] = await db.select().from(bloodDonors).where(eq(bloodDonors.id, id));
    expect([donor!.abo, donor!.rhD, donor!.donationCount]).toEqual(['A', 'NEG', 1]);
    // Tests are recorded once.
    const again = await send('post', `/donations/${don.body.id}/tests`, nurse.token, {
      abo: 'A',
      rhD: 'NEG',
      ...negative,
    });
    expect(again.status).toBe(409);
    const detail = await send('get', `/donors/${id}`, nurse.token);
    expect(detail.body.donations[0].testing).toBe('RELEASED');
    const results = await send('get', `/donations/${don.body.id}/tests`, nurse.token);
    expect(results.status).toBe(200);
    expect(results.body).toMatchObject({ hiv: 'NEGATIVE', abo: 'A', rhD: 'NEG' });
    // Kept as recorded.
    await expect(
      db.execute(
        sql`UPDATE donation_test_results SET hiv = 'REACTIVE' WHERE donation_id = ${don.body.id}`,
      ),
    ).rejects.toThrow();
  });

  it('asks for a retest when the group differs from the recorded one', async () => {
    const id = await register((await person()).id);
    await db.update(bloodDonors).set({ abo: 'O', rhD: 'POS' }).where(eq(bloodDonors.id, id));
    const don = await donate(id);
    const res = await send('post', `/donations/${don.body.id}/tests`, nurse.token, {
      abo: 'B',
      rhD: 'POS',
      ...negative,
    });
    expect(res.status).toBe(409);
    const [d] = await db.select().from(bloodDonations).where(eq(bloodDonations.id, don.body.id));
    expect(d!.bloodUnitId).toBeNull();
  });

  it('a reactive marker discards the unit, permanently defers and asks a doctor to counsel', async () => {
    const u = await createUser('PATIENT');
    const uToken = await login(u.email);
    const p = await person('MALE', '1988-02-02', u.id);
    const id = await register(p.id);
    const don = await donate(id);
    const res = await send('post', `/donations/${don.body.id}/tests`, nurse.token, {
      abo: 'O',
      rhD: 'POS',
      ...negative,
      hcv: 'REACTIVE',
    });
    expect(res.status).toBe(200);
    expect(res.body.released).toBe(false);
    const [unit] = await db.select().from(bloodUnits).where(eq(bloodUnits.id, res.body.unit.id));
    expect(unit!.status).toBe('DISCARDED');
    expect(unit!.discardReason).toBe(SCREENING_DISCARD);
    expect(unit!.discardReason).not.toMatch(/hepatitis|hcv/i);
    const [donor] = await db.select().from(bloodDonors).where(eq(bloodDonors.id, id));
    expect(donor!.status).toBe('PERMANENTLY_DEFERRED');
    expect(donor!.deferralReason).toMatch(/Hepatitis C/);
    const docNotes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, doctor.id));
    const note = docNotes.find((n) => n.type === 'blood_donor');
    expect(note?.title).toBe('A blood donor needs counselling after donation screening');
    expect(`${note?.title} ${note?.body ?? ''}`).not.toMatch(/hepatitis|Donor Test/i);
    const nurseNotes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, nurse.id), eq(notifications.type, 'blood_donor')));
    expect(nurseNotes).toEqual([]);
    // The audit trail does not name the marker.
    const logs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, don.body.id), eq(auditLogs.action, 'donors.donation')));
    expect(JSON.stringify(logs.map((l) => l.metadata))).not.toMatch(/hcv|hepatitis/i);
    expect((await send('get', `/donors/${id}`, nurse.token)).body.donations[0].testing).toBe(
      'NOT_PASSED',
    );

    // The portal card: no result, no reason – just "contact the blood bank".
    const mine = await send('get', '/mine', uToken);
    expect(mine.status).toBe(200);
    expect(mine.body.state).toBe('CONTACT_BLOOD_BANK');
    expect(mine.body.nextEligibleDate).toBeNull();
    expect(JSON.stringify(mine.body)).not.toMatch(/hepatitis|reactive|deferralReason|DISCARD/i);
    expect(mine.body.donations[0].outcome).toBe('COMPLETED');

    // Lifting a permanent deferral: a blood bank doctor only, with a reason.
    const lift = { lift: { reason: 'Confirmatory test negative (false reactive)' } };
    expect((await send('patch', `/donors/${id}`, nurse.token, lift)).status).toBe(403);
    expect((await send('patch', `/donors/${id}`, doctor.token, lift)).status).toBe(200);
  });
});

describe('portal', () => {
  it('is personal: a guardian acting for a child cannot see it', async () => {
    const parent = await createUser('PATIENT');
    const token = await login(parent.email);
    const child = await person('FEMALE', '2015-01-01');
    await db.insert(guardianships).values({
      patientId: child.id,
      guardianUserId: parent.id,
      relationship: 'PARENT',
      evidence: 'Birth certificate 1/2015',
      verifiedById: w.users.reception.id,
      validUntil: new Date('2033-01-01'),
    });
    const res = await api()
      .get('/api/v1/blood-donors/mine')
      .set({ ...bearer(token), 'X-Acting-For': child.id });
    expect(res.status).toBe(403);
    expect((await send('get', '/mine', nurse.token)).status).toBe(403);
  });

  it('shows a temporary deferral with its date and not-collected visits without reasons', async () => {
    const u = await createUser('PATIENT');
    const token = await login(u.email);
    const p = await person('MALE', '1992-02-02', u.id);
    const none = await send('get', '/mine', token);
    expect(none.body).toEqual({ registered: false });
    const id = await register(p.id, false);
    await donate(id, {
      outcome: 'DEFERRED',
      volumeMl: null,
      answers: { FEELING_WELL: true, MALARIA_TRAVEL: true },
    });
    const mine = await send('get', '/mine', token);
    expect(mine.body.state).toBe('TEMPORARILY_DEFERRED');
    expect(mine.body.deferredUntil).toBeTruthy();
    expect(mine.body.donations[0].outcome).toBe('NOT_COLLECTED');
    expect(JSON.stringify(mine.body)).not.toMatch(/MALARIA|Q_/);
    const consent = await send('patch', '/mine', token, { contactConsent: true });
    expect(consent.body).toEqual({ contactConsent: true });
    const [d] = await db.select().from(bloodDonors).where(eq(bloodDonors.id, id));
    expect(d!.contactConsent).toBe(true);
  });
});

describe('appeals', () => {
  it('reaches consenting, eligible donors of the group at most once in 4 weeks', async () => {
    const make = async (consent: boolean, eligible = true) => {
      const u = await createUser('PATIENT');
      const p = await person('MALE', '1991-01-01', u.id);
      const id = await register(p.id, consent);
      await db.update(bloodDonors).set({ abo: 'B', rhD: 'NEG' }).where(eq(bloodDonors.id, id));
      if (!eligible) {
        await db
          .update(bloodDonors)
          .set({ status: 'DEFERRED', deferredUntil: '2099-01-01' })
          .where(eq(bloodDonors.id, id));
      }
      return u.id;
    };
    const yes = await make(true);
    const noConsent = await make(false);
    const deferred = await make(true, false);
    const first = await send('post', '/appeals', nurse.token, { abo: 'B', rhD: 'NEG' });
    expect(first.status).toBe(200);
    expect(first.body.sent).toBeGreaterThanOrEqual(1);
    expect(first.body.notEligible).toBeGreaterThanOrEqual(1);
    const got = async (userId: string) =>
      (
        await db
          .select()
          .from(notifications)
          .where(and(eq(notifications.userId, userId), eq(notifications.type, 'blood_appeal')))
      ).map((n) => n.title);
    expect(await got(yes)).toEqual(['Blood group B− is needed – can you donate?']);
    expect(await got(noConsent)).toEqual([]);
    expect(await got(deferred)).toEqual([]);
    const second = await send('post', '/appeals', nurse.token, { abo: 'B', rhD: 'NEG' });
    expect(second.body.sent).toBe(0);
    expect(second.body.recentlyAsked).toBeGreaterThanOrEqual(1);
    expect(await got(yes)).toHaveLength(1);
    expect((await send('post', '/appeals', w.tokens.doctor, { abo: 'B' })).status).toBe(403);
  });
});

describe('statistics', () => {
  it('directors see their facility, the Ministry the country, small counts suppressed', async () => {
    const dir = await send('get', '/stats', w.tokens.director);
    expect(dir.status).toBe(200);
    expect(dir.body.scope).toBe('FACILITY');
    expect(dir.body.months.length).toBeGreaterThan(0);
    const total = dir.body.months.reduce(
      (s: number, m: { completed: number }) => s + m.completed,
      0,
    );
    expect(total).toBeGreaterThan(3);
    // Few deferrals per reason in this test world: hidden.
    for (const r of dir.body.deferralReasons) {
      expect(r.count === null || r.count >= 5).toBe(true);
    }
    expect(JSON.stringify(dir.body)).not.toMatch(/nationalId|firstName|lastName/);
    const min = await send('get', '/stats', w.tokens.ministry);
    expect(min.body.scope).toBe('NATIONAL');
    const other = await send('get', '/stats', w.tokens.otherDirector);
    expect(other.body.months).toEqual([]);
    expect((await send('get', '/stats', w.tokens.doctor)).status).toBe(403);
    expect((await send('get', '/stats', w.tokens.patient)).status).toBe(403);
  });
});
