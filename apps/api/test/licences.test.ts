import express from 'express';
import request from 'supertest';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { auditLogs, notifications, professionalLicences, users } from '../src/db/schema.js';
import {
  assertLicensed,
  clearLicenceCache,
  effectiveStatus,
  licenceWarnings,
  namesMatch,
  resetLicenceAuditMemory,
  runLicenceRemindersOnce,
  setLicenceEnforcementForTests,
  todayIso,
  validateCsv,
} from '../src/modules/licences/licences.service.js';
import { api, bearer, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const seq = Math.floor(Math.random() * 1e6);
const num = (n: number) => `TL-${seq}-${n}`;
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const ministry = () => bearer(w.tokens.ministry);

async function register(n: number, extra: Record<string, unknown> = {}) {
  const res = await api()
    .post('/api/v1/licences')
    .set(ministry())
    .send({
      licenceNumber: num(n),
      holderName: 'Test Holder',
      profession: 'PHYSICIAN',
      issuedBy: 'Oda e Mjekëve të Kosovës',
      issuedOn: days(-400),
      validUntil: days(400),
      ...extra,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; licenceNumber: string };
}

async function linkTo(licenceId: string, userId: string) {
  const res = await api()
    .post(`/api/v1/licences/${licenceId}/link`)
    .set(ministry())
    .send({ userId });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const vitals = (token: string) =>
  api().post(`/api/v1/patients/${w.patient.id}/vitals`).set(bearer(token)).send({ heartRate: 80 });

beforeAll(async () => {
  w = await createWorld();
});

afterAll(() => {
  setLicenceEnforcementForTests(undefined);
  clearLicenceCache();
});

describe('licence rules', () => {
  it('derives the state from status and expiry', () => {
    const t = todayIso();
    expect(effectiveStatus({ status: 'ACTIVE', validUntil: t }, t)).toBe('VALID');
    expect(effectiveStatus({ status: 'ACTIVE', validUntil: days(-1) }, t)).toBe('EXPIRED');
    expect(effectiveStatus({ status: 'SUSPENDED', validUntil: days(100) }, t)).toBe('SUSPENDED');
    expect(effectiveStatus({ status: 'REVOKED', validUntil: days(-100) }, t)).toBe('REVOKED');
  });

  it('matches names loosely (titles, case and accents ignored)', () => {
    expect(namesMatch('Dr. Gëzim Shala', 'gezim shala')).toBe(true);
    expect(namesMatch('Arta Krasniqi', 'Arta Gashi-Krasniqi')).toBe(true);
    expect(namesMatch('Arta Krasniqi', 'Besa Krasniqi')).toBe(false);
  });
});

describe('the national register (Ministry)', () => {
  it('registers, validates and updates licences', async () => {
    const created = await register(1, { specialty: 'Kardiologji', cpdCredits: 12 });
    const duplicate = await api()
      .post('/api/v1/licences')
      .set(ministry())
      .send({
        licenceNumber: num(1),
        holderName: 'Someone Else',
        profession: 'NURSE',
        issuedBy: 'Oda',
        issuedOn: days(-1),
        validUntil: days(1),
      });
    expect(duplicate.status).toBe(409);
    const backwards = await api()
      .post('/api/v1/licences')
      .set(ministry())
      .send({
        licenceNumber: num(2),
        holderName: 'Test Holder',
        profession: 'NURSE',
        issuedBy: 'Oda e Infermierëve',
        issuedOn: days(10),
        validUntil: days(1),
      });
    expect(backwards.status).toBe(400);
    const renewed = await api()
      .patch(`/api/v1/licences/${created.id}`)
      .set(ministry())
      .send({ validUntil: days(1500), cpdCredits: 40 });
    expect(renewed.status).toBe(200);
    expect(renewed.body).toMatchObject({ validUntil: days(1500), cpdCredits: 40 });
    const list = await api()
      .get('/api/v1/licences')
      .query({ q: num(1) })
      .set(ministry());
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ effectiveStatus: 'VALID', account: null });
    const stats = await api().get('/api/v1/licences/stats').set(ministry());
    expect(stats.status).toBe(200);
    expect(
      stats.body.byProfession.find((p: { profession: string }) => p.profession === 'PHYSICIAN')
        .VALID,
    ).toBeGreaterThan(0);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, created.id), eq(auditLogs.action, 'licence.changed')));
    expect(audits.map((a) => (a.metadata as { change: string }).change).sort()).toEqual([
      'created',
      'updated',
    ]);
  });

  it('is maintained by the Ministry only', async () => {
    for (const token of [w.tokens.director, w.tokens.doctor, w.tokens.patient]) {
      expect((await api().get('/api/v1/licences').set(bearer(token))).status).toBe(403);
      expect(
        (
          await api()
            .post('/api/v1/licences')
            .set(bearer(token))
            .send({ licenceNumber: num(3) })
        ).status,
      ).toBe(403);
    }
  });

  it('links only a licence whose profession fits the role, once', async () => {
    const pharmacy = await register(4, { profession: 'PHARMACIST' });
    const mismatch = await api()
      .post(`/api/v1/licences/${pharmacy.id}/link`)
      .set(ministry())
      .send({ userId: w.users.colleague.id });
    expect(mismatch.status).toBe(400);
    const dentist = await register(5, { profession: 'DENTIST' });
    await linkTo(dentist.id, w.users.colleague.id);
    const again = await register(6);
    const second = await api()
      .post(`/api/v1/licences/${again.id}/link`)
      .set(ministry())
      .send({ userId: w.users.colleague.id });
    expect(second.status).toBe(409);
    const reception = await api()
      .post(`/api/v1/licences/${again.id}/link`)
      .set(ministry())
      .send({ userId: w.users.reception.id });
    expect(reception.status).toBe(400);
  });

  it('imports a CSV file: dry run, row errors, then creates and updates', async () => {
    const csv = [
      'licenceNumber,holderName,profession,specialty,issuedBy,issuedOn,validUntil,cpdCredits',
      `${num(20)},Dr. Ana Imp,PHYSICIAN,Pediatri,Oda e Mjekëve,2024-01-01,2029-01-01,10`,
      `${num(21)},"Berisha, Bujar",NURSE,,Oda e Infermierëve,2024-01-01,2029-01-01,`,
      `${num(22)},X,ASTRONAUT,,Oda,2024-01-01,2023-01-01,abc`,
      `${num(20)},Dr. Ana Imp,PHYSICIAN,,Oda e Mjekëve,2024-01-01,2029-01-01,10`,
    ].join('\n');
    expect(validateCsv('a,b\n1,2').errors[0]!.message).toMatch(/Missing columns/);
    const dry = await api().post('/api/v1/licences/import').set(ministry()).send({ csv });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, create: 2, update: 0 });
    expect(dry.body.errors.map((e: { line: number }) => e.line)).toEqual([4, 5]);
    expect(
      await db
        .select()
        .from(professionalLicences)
        .where(eq(professionalLicences.licenceNumber, num(20))),
    ).toHaveLength(0);
    const real = await api()
      .post('/api/v1/licences/import')
      .set(ministry())
      .send({ csv, dryRun: false });
    expect(real.body).toMatchObject({ dryRun: false, create: 2, update: 0 });
    const update = await api()
      .post('/api/v1/licences/import')
      .set(ministry())
      .send({
        csv: `licenceNumber,holderName,profession,issuedBy,issuedOn,validUntil\n${num(21)},"Berisha, Bujar",NURSE,Oda,2024-01-01,2031-01-01\n${num(20)},Dr. Ana Imp,NURSE,Oda,2024-01-01,2031-01-01`,
        dryRun: false,
      });
    expect(update.body).toMatchObject({ create: 0, update: 1 });
    expect(update.body.errors[0].message).toMatch(/another profession/);
    const [row] = await db
      .select()
      .from(professionalLicences)
      .where(eq(professionalLicences.licenceNumber, num(21)));
    expect(row).toMatchObject({ holderName: 'Berisha, Bujar', validUntil: '2031-01-01' });
  });
});

describe('enforcement on clinical entries', () => {
  let doctor: Awaited<ReturnType<typeof createUser>>;
  let token: string;
  let licenceId: string;

  beforeAll(async () => {
    doctor = await createUser('DOCTOR', w.facility.id);
    token = await login(doctor.email);
    // On the patient's care team, so only the licence decides.
    await api().post(`/api/v1/patients/${w.patient.id}/care-team`).set(bearer(token)).send({});
    setLicenceEnforcementForTests('on');
    resetLicenceAuditMemory();
  });
  afterAll(() => setLicenceEnforcementForTests(undefined));

  it('refuses entries without a licence, audits once an hour and never blocks reading', async () => {
    const first = await vitals(token);
    expect(first.status).toBe(403);
    expect(first.body.error).toMatchObject({
      code: 'LICENCE_INVALID',
      details: { state: 'MISSING' },
    });
    expect((await vitals(token)).status).toBe(403);
    const denied = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.actorUserId, doctor.id), eq(auditLogs.action, 'licence.check_failed')),
      );
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: 'DENIED', patientId: null });
    expect(
      (await api().get(`/api/v1/patients/${w.patient.id}/summary`).set(bearer(token))).status,
    ).toBe(200);
    // Roles without a licence requirement are unaffected by the check itself.
    expect(
      await assertLicensed({
        userId: w.users.reception.id,
        role: 'RECEPTION',
        facilityId: w.facility.id,
      }),
    ).toBe('VALID');
  });

  it('allows entries with a valid licence and refuses suspended, expired and revoked ones', async () => {
    const l = await register(30, { holderName: doctor.fullName });
    licenceId = l.id;
    await linkTo(licenceId, doctor.id);
    expect((await vitals(token)).status).toBe(201);

    const suspend = await api()
      .post(`/api/v1/licences/${licenceId}/status`)
      .set(ministry())
      .send({ status: 'SUSPENDED', reason: 'Disciplinary procedure' });
    expect(suspend.status).toBe(200);
    const suspended = await vitals(token);
    expect(suspended.status).toBe(403);
    expect(suspended.body.error.details.state).toBe('SUSPENDED');
    const told = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, doctor.id), eq(notifications.type, 'licence.status')));
    expect(told).toHaveLength(1);

    await api()
      .post(`/api/v1/licences/${licenceId}/status`)
      .set(ministry())
      .send({ status: 'ACTIVE', reason: 'Procedure closed' });
    expect((await vitals(token)).status).toBe(201);

    await db
      .update(professionalLicences)
      .set({ validUntil: days(-1), issuedOn: days(-500) })
      .where(eq(professionalLicences.id, licenceId));
    clearLicenceCache(doctor.id);
    const expired = await vitals(token);
    expect(expired.status).toBe(403);
    expect(expired.body.error.details.state).toBe('EXPIRED');

    await api()
      .post(`/api/v1/licences/${licenceId}/status`)
      .set(ministry())
      .send({ status: 'REVOKED', reason: 'Struck off the register' });
    const reinstate = await api()
      .post(`/api/v1/licences/${licenceId}/status`)
      .set(ministry())
      .send({ status: 'ACTIVE', reason: 'Trying to reopen it' });
    expect(reinstate.status).toBe(409);
    expect((await vitals(token)).body.error.details.state).toBe('REVOKED');
  });

  it('warn mode lets the entry through with a warning header; off ignores licences', async () => {
    setLicenceEnforcementForTests('warn');
    expect((await vitals(token)).status).toBe(201);
    const mini = express();
    mini.use(licenceWarnings);
    mini.get('/x', async (_req, res) => {
      const state = await assertLicensed({ userId: doctor.id, role: 'DOCTOR', facilityId: null });
      res.json({ state });
    });
    const res = await request(mini).get('/x');
    expect(res.headers['x-licence-warning']).toBe('REVOKED');
    expect(res.body.state).toBe('REVOKED');
    setLicenceEnforcementForTests('off');
    expect((await vitals(token)).status).toBe(201);
    setLicenceEnforcementForTests('on');
  });
});

describe('directors and staff lists', () => {
  it('shows the facility’s clinical staff with their licence state, scoped to the facility', async () => {
    const res = await api().get('/api/v1/licences/facility').set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(w.users.doctor.id);
    expect(ids).not.toContain(w.users.outsideDoctor.id);
    expect(ids).not.toContain(w.users.reception.id);
    expect(res.body.items.find((i: { id: string }) => i.id === w.users.doctor.id).state).toBe(
      'MISSING',
    );
    const other = await api().get('/api/v1/licences/facility').set(bearer(w.tokens.otherDirector));
    expect(other.body.items.map((i: { id: string }) => i.id)).not.toContain(w.users.doctor.id);
    expect((await api().get('/api/v1/licences/facility').set(ministry())).status).toBe(400);
    expect((await api().get('/api/v1/licences/facility').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
  });

  it('lets a director link only the licence named on the account, for their own staff', async () => {
    const nurse = await createUser('NURSE', w.facility.id, {
      fullName: 'Drita Gashi',
      licenseNumber: num(40),
    });
    const l = await register(40, { holderName: 'Drita Gashi', profession: 'NURSE' });
    const wrongName = await register(41, { holderName: 'Someone Else', profession: 'NURSE' });
    await db
      .update(users)
      .set({ licenseNumber: num(41) })
      .where(eq(users.id, w.users.nurse.id));
    const view = await api().get('/api/v1/licences/facility').set(bearer(w.tokens.director));
    expect(
      view.body.items.find((i: { id: string }) => i.id === nurse.id).linkCandidate,
    ).toMatchObject({ id: l.id });
    const refused = await api()
      .post(`/api/v1/licences/${wrongName.id}/link`)
      .set(bearer(w.tokens.director))
      .send({ userId: w.users.nurse.id });
    expect(refused.status).toBe(403);
    const otherFacility = await api()
      .post(`/api/v1/licences/${l.id}/link`)
      .set(bearer(w.tokens.otherDirector))
      .send({ userId: nurse.id });
    expect(otherFacility.status).toBe(404);
    const ok = await api()
      .post(`/api/v1/licences/${l.id}/link`)
      .set(bearer(w.tokens.director))
      .send({ userId: nurse.id });
    expect(ok.status).toBe(200);
    const staff = await api()
      .get('/api/v1/staff')
      .query({ search: 'Drita Gashi' })
      .set(bearer(w.tokens.director));
    expect(staff.body.items[0].licence).toMatchObject({ licenceNumber: num(40), state: 'VALID' });
    const me = await api()
      .get('/api/v1/licences/me')
      .set(bearer(await login(nurse.email)));
    expect(me.body).toMatchObject({ required: true, licence: { licenceNumber: num(40) } });
  });

  it('links the register entry automatically when a director invites the holder', async () => {
    const l = await register(50, { holderName: 'Ilir Morina' });
    const res = await api()
      .post('/api/v1/staff/invitations')
      .set(bearer(w.tokens.director))
      .send({
        email: `ilir.${seq}@test.local`,
        fullName: 'Dr. Ilir Morina',
        role: 'DOCTOR',
        licenseNumber: num(50),
      });
    expect(res.status).toBe(201);
    expect(res.body.licenceLinked).toBe(true);
    const [row] = await db
      .select()
      .from(professionalLicences)
      .where(eq(professionalLicences.id, l.id));
    expect(row!.userId).toBe(res.body.user.id);
  });
});

describe('public licence check', () => {
  it('shows only holder, profession, specialty, status and expiry, without sign-in', async () => {
    await register(60, { holderName: 'Dr. Public Check', specialty: 'Pediatri' });
    const res = await api().get(`/api/v1/licences/public/${num(60)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      licenceNumber: num(60),
      holderName: 'Dr. Public Check',
      profession: 'PHYSICIAN',
      specialty: 'Pediatri',
      status: 'VALID',
      validUntil: days(400),
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['ratelimit-policy'] ?? res.headers['ratelimit']).toBeDefined();
    expect((await api().get('/api/v1/licences/public/NO-SUCH-NUMBER-1')).status).toBe(404);
    expect((await api().get('/api/v1/licences/public/%20x')).status).toBe(404);
  });
});

describe('expiry reminders', () => {
  it('reminds the holder and the director once per stage and licence period', async () => {
    const holder = await createUser('PHARMACIST', w.facility.id);
    const l = await register(70, { profession: 'PHARMACIST', validUntil: days(20) });
    await linkTo(l.id, holder.id);
    const sentTo = async (userId: string) =>
      db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, userId),
            eq(notifications.type, 'licence.expiry'),
            like(notifications.link, `%lr=${l.id}:%`),
          ),
        );
    await runLicenceRemindersOnce();
    expect(await sentTo(holder.id)).toHaveLength(1);
    expect((await sentTo(w.users.director.id))[0]!.title).toMatch(/expires on/);
    await runLicenceRemindersOnce();
    expect(await sentTo(holder.id)).toHaveLength(1);

    await db
      .update(professionalLicences)
      .set({ validUntil: days(5) })
      .where(eq(professionalLicences.id, l.id));
    await runLicenceRemindersOnce();
    expect(await sentTo(holder.id)).toHaveLength(2);

    await db
      .update(professionalLicences)
      .set({ validUntil: days(-2) })
      .where(eq(professionalLicences.id, l.id));
    await runLicenceRemindersOnce();
    const all = await sentTo(holder.id);
    expect(all).toHaveLength(3);
    expect(all.some((n) => /has expired/.test(n.title))).toBe(true);
    // A licence far from expiry gets nothing.
    const far = await register(71, { validUntil: days(300) });
    await linkTo(far.id, (await createUser('DOCTOR', w.facility.id)).id);
    await runLicenceRemindersOnce();
    expect(
      await db
        .select()
        .from(notifications)
        .where(like(notifications.link, `%lr=${far.id}:%`)),
    ).toHaveLength(0);
  });
});
