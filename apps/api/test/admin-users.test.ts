import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careAssignments,
  coverArrangements,
  emailOutbox,
  facilities,
  imagingOrders,
  labResults,
  mfaRecoveryCodes,
  notifications,
  oneTimeTokens,
  patients,
  refreshTokens,
  users,
} from '../src/db/schema.js';
import { assertAnotherActiveAdmin } from '../src/modules/admin/users.service.js';
import { bootstrapAdmin } from '../src/ops/bootstrap-admin.js';
import {
  api,
  bearer,
  createFacility,
  createPatient,
  createUser,
  createWorld,
  login,
  PASSWORD,
} from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let admin: Awaited<ReturnType<typeof createUser>>;
let adminToken: string;
const tag = `zeta${randomUUID().slice(0, 6)}`;
const NEW_PASSWORD = 'Activated-Passw0rd-2026!';

const base = '/api/v1/admin/users';
const get = (path = '', token = adminToken) => api().get(`${base}${path}`).set(bearer(token));
const post = (path: string, body: object = {}, token = adminToken) =>
  api().post(`${base}${path}`).set(bearer(token)).send(body);
const patch = (path: string, body: object, token = adminToken) =>
  api().patch(`${base}${path}`).set(bearer(token)).send(body);
const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;

async function auditRows(action: string, userId: string) {
  return db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.resourceId, userId)));
}

/** A staff account named with this file's tag, so searches only find this file's accounts. */
async function staff(
  role: Parameters<typeof createUser>[0],
  facilityId: string | null,
  extra = {},
) {
  return createUser(role, facilityId, {
    fullName: `${tag} ${role} ${randomUUID().slice(0, 4)}`,
    ...extra,
  });
}

beforeAll(async () => {
  w = await createWorld();
  admin = await createUser('ADMIN', null, { fullName: `${tag} Admin` });
  adminToken = await login(admin.email);
});

describe('access', () => {
  it('is for the platform administrator only', async () => {
    const someone = await staff('NURSE', w.facility.id);
    for (const token of [
      w.tokens.ministry,
      w.tokens.director,
      w.tokens.doctor,
      w.tokens.nurse,
      w.tokens.pharmacist,
      w.tokens.reception,
      w.tokens.patient,
    ]) {
      expect((await get('', token)).status).toBe(403);
      expect((await get(`/${someone.id}`, token)).status).toBe(403);
      expect((await post('', { email: 'x@example.test' }, token)).status).toBe(403);
      expect(
        (await post(`/${someone.id}/disable`, { reason: 'Testing access' }, token)).status,
      ).toBe(403);
    }
    expect((await api().get(base)).status).toBe(401);
  });
});

describe('list', () => {
  it('searches, filters by role, facility and state, and counts the states', async () => {
    const facility = await createFacility();
    const doctor = await staff('DOCTOR', facility.id);
    const disabled = await staff('RECEPTION', facility.id, { isActive: false });
    const locked = await staff('NURSE', facility.id, {
      lockedUntil: new Date(Date.now() + 10 * 60_000),
      failedLoginAttempts: 5,
    });
    const pending = await staff('PHARMACIST', facility.id, {
      passwordHash: null,
      passwordChangedAt: null,
    });
    const withMfa = await staff('DIRECTOR', facility.id, { mfaEnabledAt: new Date() });

    const all = await get(`?q=${tag.toUpperCase()}&facilityId=${facility.id}&pageSize=50`);
    expect(all.status).toBe(200);
    const ids = all.body.items.map((u: { id: string }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([doctor.id, disabled.id, locked.id, pending.id]));
    expect(all.body.total).toBe(5);
    expect(all.body.counts).toEqual({ active: 3, disabled: 1, locked: 1, pending: 1, noMfa: 3 });

    const only = async (query: string) =>
      (await get(`?q=${tag}&facilityId=${facility.id}&${query}`)).body.items.map(
        (u: { id: string }) => u.id,
      );
    expect(await only('status=disabled')).toEqual([disabled.id]);
    expect(await only('status=locked')).toEqual([locked.id]);
    expect(await only('status=pending')).toEqual([pending.id]);
    expect((await only('status=no_mfa')).sort()).toEqual(
      [doctor.id, locked.id, disabled.id].sort(),
    );
    expect(await only('status=active')).not.toContain(disabled.id);
    expect(await only('status=active')).toContain(withMfa.id);
    expect(await only('role=DOCTOR')).toEqual([doctor.id]);

    const row = all.body.items.find((u: { id: string }) => u.id === locked.id);
    expect(row).toMatchObject({ locked: true, activated: true, isActive: true, mfaEnabled: false });
    expect(row.facilityName).toBe(facility.name);
    expect(Object.keys(row)).not.toContain('passwordHash');
  });

  it('finds a patient account only by its exact e-mail address, with account data only', async () => {
    const patientUser = await createUser('PATIENT', null, {
      fullName: `${tag} Patient`,
      email: `${tag}-patient@example.test`,
    });
    const patient = await createPatient(w.facility.id, { userId: patientUser.id });
    const ids = async (query: string) => {
      const res = await get(query);
      expect(res.status).toBe(200);
      return res.body.items.map((u: { id: string }) => u.id) as string[];
    };
    // Who is a patient of the national service is health data: no browsing by name or role.
    expect(await ids(`?q=${tag}&role=PATIENT`)).toEqual([]);
    expect(await ids('?role=PATIENT')).toEqual([]);
    expect(await ids(`?q=${tag}`)).not.toContain(patientUser.id);
    expect(await ids(`?q=${tag}-patient@example`)).toEqual([]);
    expect((await get(`?q=${tag}&role=PATIENT`)).body.counts).toEqual({
      active: 0,
      disabled: 0,
      locked: 0,
      pending: 0,
      noMfa: 0,
    });
    // A support case: the exact address (in any letter case) finds the one account.
    expect(await ids(`?q=${encodeURIComponent(patientUser.email.toUpperCase())}`)).toEqual([
      patientUser.id,
    ]);
    const res = await get(`?q=${encodeURIComponent(patientUser.email)}&role=PATIENT`);
    expect(res.body.items.map((u: { id: string }) => u.id)).toEqual([patientUser.id]);
    const detail = await get(`/${patientUser.id}`);
    expect(detail.status).toBe(200);
    const text = JSON.stringify([res.body, detail.body]);
    expect(text).not.toContain(patient.nationalId);
    expect(text).not.toContain(patient.id);
    expect(text).not.toContain(patient.dateOfBirth);
    expect(text).not.toMatch(/nationalId|patientId|passwordHash|mfaSecret|dateOfBirth/);
  });

  it('shows one account with sign-in history, sessions and administrative history', async () => {
    const nurse = await staff('NURSE', w.facility.id);
    const nurseToken = await login(nurse.email);
    // The person's own self-service change is audited but is not administrative history.
    await api()
      .patch('/api/v1/auth/me/preferences')
      .set(bearer(nurseToken))
      .send({ emailNotifications: 'IMPORTANT' })
      .expect(200);
    expect(await auditRows('user.email_preference.changed', nurse.id)).toHaveLength(1);
    await post(`/${nurse.id}/disable`, { reason: 'Left the hospital' });
    await post(`/${nurse.id}/enable`, {});
    const res = await get(`/${nurse.id}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: nurse.id, role: 'NURSE', isActive: true });
    expect(
      res.body.signIns.some((s: { action: string }) => s.action === 'auth.login.success'),
    ).toBe(true);
    const disabled = res.body.adminHistory.find(
      (h: { action: string }) => h.action === 'admin.user.disabled',
    );
    expect(disabled).toMatchObject({ reason: 'Left the hospital', actorName: admin.fullName });
    expect(res.body.adminHistory.map((h: { action: string }) => h.action)).toEqual([
      'admin.user.enabled',
      'admin.user.disabled',
    ]);
    expect((await get(`/${randomUUID()}`)).status).toBe(404);
  });
});

describe('patient accounts', () => {
  it('shows only what administrators and the system did, never who at a facility cared for them', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await db
      .update(patients)
      .set({ email: `${tag}-invited-${randomUUID().slice(0, 4)}@example.test` })
      .where(eq(patients.id, p.id));
    // The doctor invites the patient to the portal (audited with the patient).
    const invited = await api()
      .post(`/api/v1/patients/${p.id}/portal-invitation`)
      .set(bearer(w.tokens.doctor));
    expect(invited.status).toBe(201);
    const [linked] = await db
      .select({ userId: patients.userId })
      .from(patients)
      .where(eq(patients.id, p.id));
    const userId = linked!.userId!;
    // Facility staff acting on the account without a patient on the row, and the system.
    await db.insert(auditLogs).values([
      {
        action: 'user.deactivated',
        actorUserId: w.users.director.id,
        actorRole: 'DIRECTOR',
        resourceType: 'user',
        resourceId: userId,
      },
      {
        action: 'user.deactivated',
        resourceType: 'user',
        resourceId: userId,
        metadata: { source: 'death_registration' },
      },
    ]);
    expect((await post(`/${userId}/revoke-sessions`)).status).toBe(200);
    const page = await get(`/${userId}`);
    expect(page.status).toBe(200);
    expect(page.body.adminHistory.map((h: { action: string }) => h.action)).toEqual([
      'admin.user.sessions_revoked',
      'user.deactivated',
    ]);
    expect(page.body.adminHistory[1]).toMatchObject({
      actorName: null,
      actorRole: null,
      source: 'death_registration',
    });
    const text = JSON.stringify(page.body);
    expect(text).not.toContain(w.users.doctor.fullName);
    expect(text).not.toContain(w.users.director.fullName);
    expect(text).not.toContain(p.id);

    // On a staff account, too, nothing written about a patient is shown.
    const nurse = await staff('NURSE', w.facility.id);
    await db.insert(auditLogs).values({
      action: 'user.deactivated',
      actorUserId: w.users.director.id,
      actorRole: 'DIRECTOR',
      resourceType: 'user',
      resourceId: nurse.id,
      patientId: p.id,
    });
    expect((await get(`/${nurse.id}`)).body.adminHistory).toEqual([]);
  });

  it('never re-enables the portal account of a deceased patient', async () => {
    const patientUser = await createUser('PATIENT', null, { isActive: false });
    const p = await createPatient(w.facility.id, { userId: patientUser.id });
    await db.update(patients).set({ deceasedAt: new Date() }).where(eq(patients.id, p.id));
    const refused = await post(`/${patientUser.id}/enable`, { reason: 'Relative called support' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      'This account was closed when a death was registered. It comes back only if the death registration is withdrawn.',
    );
    const [still] = await db.select().from(users).where(eq(users.id, patientUser.id));
    expect(still!.isActive).toBe(false);
    expect(await auditRows('admin.user.enabled', patientUser.id)).toHaveLength(0);

    // A living patient's disabled account can be enabled again.
    const living = await createUser('PATIENT', null, { isActive: false });
    await createPatient(w.facility.id, { userId: living.id });
    expect((await post(`/${living.id}/enable`, { reason: 'Disabled by mistake' })).status).toBe(
      200,
    );
  });

  it('leaves two-step sign-in and invitations of patients to their facility', async () => {
    const patientUser = await createUser('PATIENT', null, {
      mfaEnabledAt: new Date(),
      mfaSecretEncrypted: 'encrypted-secret',
    });
    const reset = await post(`/${patientUser.id}/mfa-reset`, { reason: 'Caller says lost phone' });
    expect(reset.status).toBe(400);
    expect(reset.body.error.message).toBe(
      'A patient’s two-step sign-in is reset by their facility, which verifies their identity.',
    );
    const [u] = await db.select().from(users).where(eq(users.id, patientUser.id));
    expect(u!.mfaEnabledAt).not.toBeNull();

    const pending = await createUser('PATIENT', null, { passwordHash: null });
    const renew = await post(`/${pending.id}/resend-invitation`);
    expect(renew.status).toBe(400);
    expect(renew.body.error.message).toBe(
      'A patient’s portal invitation is renewed by their facility, which verifies their identity.',
    );
    expect(renew.body.activationUrl).toBeUndefined();
    const tokens = await db
      .select()
      .from(oneTimeTokens)
      .where(eq(oneTimeTokens.userId, pending.id));
    expect(tokens).toHaveLength(0);
  });
});

describe('invite', () => {
  it('validates role, facility and licence, and refuses patients and duplicates', async () => {
    const inactive = await createFacility({ isActive: false });
    const cases: [object, number][] = [
      [{ role: 'NURSE', licenseNumber: 'N-1' }, 400],
      [{ role: 'NURSE', licenseNumber: 'N-1', facilityId: inactive.id }, 400],
      [{ role: 'DOCTOR', facilityId: w.facility.id }, 400],
      [{ role: 'MINISTRY', facilityId: w.facility.id }, 400],
      [{ role: 'ADMIN', facilityId: w.facility.id }, 400],
      [{ role: 'PATIENT' }, 400],
      [{ role: 'NURSE', licenseNumber: 'N-1', facilityId: w.facility.id, email: admin.email }, 409],
    ];
    for (const [body, status] of cases) {
      const res = await post('', {
        email: `${randomUUID().slice(0, 8)}@example.test`,
        fullName: `${tag} Invitee`,
        ...body,
      });
      expect(res.status, JSON.stringify(body)).toBe(status);
    }
  });

  it('invites staff, Ministry officials and administrators, who activate their accounts', async () => {
    const email = `${tag}-nurse@example.test`;
    const res = await post('', {
      email,
      fullName: `${tag} Invited Nurse`,
      role: 'NURSE',
      facilityId: w.facility.id,
      licenseNumber: 'N-2026-77',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ emailQueued: true, expiresInHours: 72 });
    expect(res.body.user).toMatchObject({
      role: 'NURSE',
      facilityId: w.facility.id,
      activated: false,
    });
    const [mail] = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.userId, res.body.user.id), eq(emailOutbox.template, 'activation')));
    expect(mail).toBeTruthy();
    expect(await auditRows('admin.user.invited', res.body.user.id)).toHaveLength(1);

    const activated = await api()
      .post('/api/v1/auth/activate')
      .send({ token: tokenOf(res.body.activationUrl), password: NEW_PASSWORD });
    expect(activated.status).toBe(204);
    expect(await login(email, NEW_PASSWORD)).toBeTruthy();

    for (const role of ['MINISTRY', 'ADMIN'] as const) {
      const national = await post('', {
        email: `${tag}-${role.toLowerCase()}@example.test`,
        fullName: `${tag} ${role}`,
        role,
      });
      expect(national.status).toBe(201);
      expect(national.body.user).toMatchObject({ role, facilityId: null });
    }
  });
});

describe('disable and enable', () => {
  it('signs the person out and refuses sign-in until enabled again', async () => {
    const doctor = await staff('DOCTOR', w.facility.id);
    await login(doctor.email);
    expect((await post(`/${doctor.id}/disable`, {})).status).toBe(400);
    expect((await post(`/${doctor.id}/disable`, { reason: 'abc' })).status).toBe(400);
    const res = await post(`/${doctor.id}/disable`, { reason: 'Contract ended' });
    expect(res.status).toBe(200);
    expect(res.body.user.isActive).toBe(false);
    const open = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, doctor.id), isNull(refreshTokens.revokedAt)));
    expect(open).toHaveLength(0);
    expect(
      (await api().post('/api/v1/auth/login').send({ email: doctor.email, password: PASSWORD }))
        .status,
    ).not.toBe(200);
    expect((await post(`/${doctor.id}/disable`, { reason: 'Contract ended' })).status).toBe(409);

    expect((await post(`/${doctor.id}/enable`, {})).status).toBe(200);
    expect(await login(doctor.email)).toBeTruthy();
    expect((await post(`/${doctor.id}/enable`, {})).status).toBe(409);
    const [disabled] = await auditRows('admin.user.disabled', doctor.id);
    expect(disabled!.metadata).toMatchObject({ reason: 'Contract ended' });
    expect(disabled!.actorUserId).toBe(admin.id);
    expect(await auditRows('admin.user.enabled', doctor.id)).toHaveLength(1);
  });

  it('never acts on your own account and never removes the last active administrator', async () => {
    expect((await post(`/${admin.id}/disable`, { reason: 'Testing myself' })).status).toBe(403);
    expect((await post(`/${admin.id}/revoke-sessions`)).status).toBe(403);
    expect((await post(`/${admin.id}/mfa-reset`, { reason: 'Testing myself' })).status).toBe(403);
    expect(
      (await patch(`/${admin.id}`, { role: 'MINISTRY', reason: 'Testing myself' })).status,
    ).toBe(403);
    // Through the API the acting administrator is always another active one; the guard also
    // holds on its own (e.g. two administrators disabling each other at the same moment).
    const other = await createUser('ADMIN');
    await expect(assertAnotherActiveAdmin(other.id)).resolves.toBeUndefined();
    await expect(
      db.transaction(async (tx) => {
        await tx.update(users).set({ isActive: false }).where(eq(users.role, 'ADMIN'));
        await tx.update(users).set({ isActive: true }).where(eq(users.id, other.id));
        await assertAnotherActiveAdmin(other.id, tx);
      }),
    ).rejects.toThrow(/last active platform administrator/);
    const [still] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(still!.isActive).toBe(true);
  });
});

describe('the last active administrator', () => {
  it('stays when two administrators disable or demote each other at the same moment', async () => {
    // Exactly two active administrators for the duration of the test: the others are paused.
    const paused = await db
      .update(users)
      .set({ isActive: false })
      .where(and(eq(users.role, 'ADMIN'), eq(users.isActive, true)))
      .returning({ id: users.id });
    try {
      const pairs = async () => {
        const a = await createUser('ADMIN');
        const b = await createUser('ADMIN');
        return { a, b, tokenA: await login(a.email), tokenB: await login(b.email) };
      };
      const disable = (id: string, token: string) =>
        post(`/${id}/disable`, { reason: 'Leaves the company' }, token);
      const demote = (id: string, token: string) =>
        patch(`/${id}`, { role: 'MINISTRY', reason: 'Moves to the Ministry' }, token);
      const rounds: [typeof disable, typeof disable][] = [
        [disable, disable],
        [disable, disable],
        [demote, demote],
        [demote, demote],
        [disable, demote],
      ];
      for (const [first, second] of rounds) {
        const { a, b, tokenA, tokenB } = await pairs();
        const results = await Promise.all([first(b.id, tokenA), second(a.id, tokenB)]);
        // One wins; the other is refused (or finds itself signed out first).
        expect(results.filter((r) => r.status === 200)).toHaveLength(1);
        for (const r of results.filter((x) => x.status !== 200)) {
          expect([401, 403, 409]).toContain(r.status);
        }
        const left = await db
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              inArray(users.id, [a.id, b.id]),
              eq(users.role, 'ADMIN'),
              eq(users.isActive, true),
              isNotNull(users.passwordHash),
            ),
          );
        expect(left).toHaveLength(1);
        // Leave no active administrator of this round behind for the next one.
        await db
          .update(users)
          .set({ isActive: false })
          .where(inArray(users.id, [a.id, b.id]));
      }
    } finally {
      if (paused.length) {
        await db
          .update(users)
          .set({ isActive: true })
          .where(
            inArray(
              users.id,
              paused.map((r) => r.id),
            ),
          );
      }
    }
  });
});

describe('sign-in help', () => {
  it('unlocks a locked account', async () => {
    const nurse = await staff('NURSE', w.facility.id, {
      lockedUntil: new Date(Date.now() + 15 * 60_000),
      failedLoginAttempts: 5,
    });
    const res = await post(`/${nurse.id}/unlock`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ locked: false, failedLoginAttempts: 0 });
    expect(await login(nurse.email)).toBeTruthy();
    expect((await post(`/${nurse.id}/unlock`)).status).toBe(409);
    expect(await auditRows('admin.user.unlocked', nurse.id)).toHaveLength(1);
  });

  it('sends a password reset e-mail to activated accounts only', async () => {
    const reception = await staff('RECEPTION', w.facility.id);
    expect((await post(`/${reception.id}/password-reset`)).status).toBe(200);
    const [token] = await db
      .select()
      .from(oneTimeTokens)
      .where(
        and(eq(oneTimeTokens.userId, reception.id), eq(oneTimeTokens.purpose, 'PASSWORD_RESET')),
      );
    expect(token).toBeTruthy();
    const [mail] = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.userId, reception.id), eq(emailOutbox.template, 'password_reset')));
    expect(mail).toBeTruthy();
    const [sent] = await auditRows('admin.user.password_reset_sent', reception.id);
    // The administrator asked for it: recorded as theirs, never as the person's own request.
    expect(sent!.actorUserId).toBe(admin.id);
    expect(token!.createdById).toBe(admin.id);
    const own = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'auth.password.reset_requested'),
          eq(auditLogs.actorUserId, reception.id),
        ),
      );
    expect(own).toHaveLength(0);

    const pending = await staff('RECEPTION', w.facility.id, { passwordHash: null });
    expect((await post(`/${pending.id}/password-reset`)).status).toBe(409);
  });

  it('sends no reset that is not audited (one transaction)', async () => {
    const nurse = await staff('NURSE', w.facility.id);
    // The audit entry of this one reset fails: nothing of the reset may remain.
    await db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION test_fail_reset_audit() RETURNS trigger AS $$
        BEGIN
          IF NEW.action = 'admin.user.password_reset_sent' AND NEW.resource_id = '${nurse.id}' THEN
            RAISE EXCEPTION 'audit unavailable';
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql`),
    );
    await db.execute(
      sql.raw(`CREATE TRIGGER test_fail_reset_audit BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION test_fail_reset_audit()`),
    );
    try {
      expect((await post(`/${nurse.id}/password-reset`)).status).toBe(500);
    } finally {
      await db.execute(sql.raw('DROP TRIGGER test_fail_reset_audit ON audit_logs'));
      await db.execute(sql.raw('DROP FUNCTION test_fail_reset_audit()'));
    }
    const tokens = await db.select().from(oneTimeTokens).where(eq(oneTimeTokens.userId, nurse.id));
    expect(tokens).toHaveLength(0);
    const mails = await db.select().from(emailOutbox).where(eq(emailOutbox.userId, nurse.id));
    expect(mails).toHaveLength(0);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.resourceId, nurse.id)),
    ).toHaveLength(0);
  });

  it('resets two-step sign-in, signs the person out and tells them', async () => {
    const director = await staff('DIRECTOR', w.facility.id);
    await login(director.email);
    await db
      .update(users)
      .set({ mfaEnabledAt: new Date(), mfaSecretEncrypted: 'encrypted-secret' })
      .where(eq(users.id, director.id));
    await db.insert(mfaRecoveryCodes).values([
      { userId: director.id, codeHash: randomUUID().replace(/-/g, '') },
      { userId: director.id, codeHash: randomUUID().replace(/-/g, '') },
    ]);
    expect((await post(`/${director.id}/mfa-reset`, {})).status).toBe(400);
    const res = await post(`/${director.id}/mfa-reset`, { reason: 'Lost the phone' });
    expect(res.status).toBe(200);
    expect(res.body.user.mfaEnabled).toBe(false);
    const [u] = await db.select().from(users).where(eq(users.id, director.id));
    expect(u).toMatchObject({ mfaEnabledAt: null, mfaSecretEncrypted: null });
    expect(
      await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, director.id)),
    ).toHaveLength(0);
    const open = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, director.id), isNull(refreshTokens.revokedAt)));
    expect(open).toHaveLength(0);
    const [notice] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, director.id));
    expect(notice).toMatchObject({ link: '/account/security' });
    expect(notice!.title).toMatch(/two-step sign-in was reset/);
    const [entry] = await auditRows('admin.user.mfa_reset', director.id);
    expect(entry!.metadata).toMatchObject({ reason: 'Lost the phone' });
    // Nothing left to reset.
    expect((await post(`/${director.id}/mfa-reset`, { reason: 'Lost the phone' })).status).toBe(
      409,
    );
  });

  it('signs the person out of every device', async () => {
    const pharmacist = await staff('PHARMACIST', w.facility.id);
    await login(pharmacist.email);
    await login(pharmacist.email);
    expect((await get(`/${pharmacist.id}`)).body.sessions).toHaveLength(2);
    const res = await post(`/${pharmacist.id}/revoke-sessions`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(0);
    const [entry] = await auditRows('admin.user.sessions_revoked', pharmacist.id);
    expect(entry!.metadata).toMatchObject({ sessions: 2 });
  });
});

describe('role and facility', () => {
  it('waits until the person’s patients are handed over, then changes and signs out', async () => {
    const doctor = await staff('DOCTOR', w.facility.id);
    const patient = await createPatient(w.facility.id, { doctorId: doctor.id });
    await login(doctor.email);
    expect((await patch(`/${doctor.id}`, { role: 'NURSE' })).status).toBe(400);
    const refused = await patch(`/${doctor.id}`, { role: 'NURSE', reason: 'Now works as a nurse' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(
      /Hand over this person’s patients to colleagues first/,
    );
    expect((await get(`/${doctor.id}`)).body.user.activeCareTeams).toBe(1);

    await db
      .update(careAssignments)
      .set({ endedAt: new Date() })
      .where(
        and(eq(careAssignments.doctorId, doctor.id), eq(careAssignments.patientId, patient.id)),
      );
    const other = await createFacility();
    const res = await patch(`/${doctor.id}`, {
      role: 'NURSE',
      facilityId: other.id,
      reason: 'Now works as a nurse',
    });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ role: 'NURSE', facilityId: other.id });
    const open = await db
      .select()
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, doctor.id), isNull(refreshTokens.revokedAt)));
    expect(open).toHaveLength(0);
    const [entry] = await auditRows('admin.user.updated', doctor.id);
    expect(entry!.metadata).toMatchObject({
      changes: ['role', 'facilityId'],
      fromRole: 'DOCTOR',
      toRole: 'NURSE',
      reason: 'Now works as a nurse',
    });

    const official = await patch(`/${doctor.id}`, {
      role: 'MINISTRY',
      reason: 'Moved to the Ministry',
    });
    expect(official.status).toBe(200);
    expect(official.body.user).toMatchObject({ role: 'MINISTRY', facilityId: null });
  });

  it('waits until result cover and results awaiting review are handed over', async () => {
    const away = await staff('DOCTOR', w.facility.id);
    const covering = await staff('DOCTOR', w.facility.id);
    const other = await createFacility();
    const move = (id: string) =>
      patch(`/${id}`, { facilityId: other.id, reason: 'Moves to another hospital' });
    const HOUR = 3_600_000;
    const [cover] = await db
      .insert(coverArrangements)
      .values({
        doctorId: away.id,
        coverDoctorId: covering.id,
        facilityId: w.facility.id,
        startsAt: new Date(Date.now() - HOUR),
        endsAt: new Date(Date.now() + 14 * 24 * HOUR),
        createdById: away.id,
      })
      .returning();
    // Covering a colleague, and being covered while away, both count; so does cover to come.
    for (const who of [covering, away]) {
      const refused = await move(who.id);
      expect(refused.status).toBe(409);
      expect(refused.body.error.message).toMatch(/^Hand over first: this person has result cover/);
    }
    await db
      .update(coverArrangements)
      .set({ startsAt: new Date(Date.now() + 24 * HOUR) })
      .where(eq(coverArrangements.id, cover!.id));
    expect(
      (await patch(`/${covering.id}`, { role: 'NURSE', reason: 'Works as nurse' })).status,
    ).toBe(409);
    await db
      .update(coverArrangements)
      .set({ cancelledAt: new Date() })
      .where(eq(coverArrangements.id, cover!.id));

    // Results the person ordered that nobody has reviewed yet: laboratory and imaging.
    const patient = await createPatient(w.facility.id);
    const [lab] = await db
      .insert(labResults)
      .values({
        patientId: patient.id,
        orderedById: covering.id,
        testName: 'Potassium',
        value: '4.1',
        unit: 'mmol/L',
        flag: 'NORMAL',
        collectedAt: new Date(),
      })
      .returning();
    const [image] = await db
      .insert(imagingOrders)
      .values({
        accessionNumber: `A${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        patientId: patient.id,
        facilityId: w.facility.id,
        orderedById: covering.id,
        modality: 'XRAY',
        bodyPart: 'Thorax',
        clinicalQuestion: 'Pneumonia?',
        status: 'REPORTED',
        impression: 'No consolidation',
        reportedAt: new Date(),
      })
      .returning();
    const waiting = await move(covering.id);
    expect(waiting.status).toBe(409);
    expect(waiting.body.error.message).toMatch(/^Hand over first: results this person ordered/);
    await db
      .update(labResults)
      .set({ acknowledgedAt: new Date(), acknowledgedById: covering.id })
      .where(eq(labResults.id, lab!.id));
    expect((await move(covering.id)).status).toBe(409);
    await db
      .update(imagingOrders)
      .set({ acknowledgedAt: new Date(), acknowledgedById: covering.id })
      .where(eq(imagingOrders.id, image!.id));

    const moved = await move(covering.id);
    expect(moved.status).toBe(200);
    expect(moved.body.user.facilityId).toBe(other.id);
    expect((await move(away.id)).status).toBe(200);
  });

  it('checks licences and facilities and leaves patient accounts to their facility', async () => {
    const reception = await staff('RECEPTION', w.facility.id);
    expect(
      (await patch(`/${reception.id}`, { role: 'PHARMACIST', reason: 'Qualified as pharmacist' }))
        .status,
    ).toBe(400);
    expect(
      (
        await patch(`/${reception.id}`, {
          role: 'PHARMACIST',
          licenseNumber: 'PH-2026-1',
          reason: 'Qualified as pharmacist',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await patch(`/${reception.id}`, {
          facilityId: (await createFacility({ isActive: false })).id,
          reason: 'Moves facility',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await patch(`/${reception.id}`, {
          role: 'ADMIN',
          facilityId: w.facility.id,
          reason: 'Wrong',
        })
      ).status,
    ).toBe(400);
    expect((await patch(`/${reception.id}`, {})).status).toBe(400);

    const patientUser = await createUser('PATIENT');
    expect((await patch(`/${patientUser.id}`, { fullName: 'New Name' })).status).toBe(400);

    // Your own name you may change, and the change is in your administrative history.
    const renamed = await patch(`/${admin.id}`, { fullName: `${tag} Admin Renamed` });
    expect(renamed.status).toBe(200);
    expect(renamed.body.adminHistory[0]).toMatchObject({
      action: 'admin.user.updated',
      changes: ['fullName'],
    });
  });
});

describe('invitation renewal', () => {
  it('replaces the activation link; the old one stops working', async () => {
    const invited = await post('', {
      email: `${tag}-renew@example.test`,
      fullName: `${tag} Renewed`,
      role: 'RECEPTION',
      facilityId: w.facility.id,
    });
    expect(invited.status).toBe(201);
    const id = invited.body.user.id as string;
    const renewed = await post(`/${id}/resend-invitation`);
    expect(renewed.status).toBe(200);
    expect(renewed.body.activationUrl).toBeTruthy();
    expect(renewed.body.activationUrl).not.toBe(invited.body.activationUrl);
    const old = await api()
      .post('/api/v1/auth/activate')
      .send({ token: tokenOf(invited.body.activationUrl), password: NEW_PASSWORD });
    expect(old.status).toBe(400);
    const fresh = await api()
      .post('/api/v1/auth/activate')
      .send({ token: tokenOf(renewed.body.activationUrl), password: NEW_PASSWORD });
    expect(fresh.status).toBe(204);
    expect(await auditRows('admin.user.invitation_resent', id)).toHaveLength(1);
    expect((await post(`/${id}/resend-invitation`)).status).toBe(409);
  });
});

describe('facilities for the dialogs', () => {
  it('lists active facilities only', async () => {
    const inactive = await createFacility({ isActive: false });
    const res = await get('/facilities');
    expect(res.status).toBe(200);
    const ids = res.body.items.map((f: { id: string }) => f.id);
    expect(ids).toContain(w.facility.id);
    expect(ids).not.toContain(inactive.id);
    const [row] = await db.select().from(facilities).where(eq(facilities.id, w.facility.id));
    expect(res.body.items.find((f: { id: string }) => f.id === row!.id).name).toBe(row!.name);
  });
});

describe('the first administrator (deploy/first-admin.sh)', () => {
  /** A private folder for the activation file, as the deployment script provides. */
  async function privateFile() {
    const dir = await mkdtemp(path.join(tmpdir(), 'pacient-first-admin-'));
    return { dir, file: path.join(dir, 'invite.txt') };
  }

  it('refuses a first installation once accounts exist, and leaves no file behind', async () => {
    const { dir, file } = await privateFile();
    try {
      await expect(bootstrapAdmin(`${tag}-first@example.test`, file)).rejects.toThrow(
        /users already exist/,
      );
      expect(existsSync(file)).toBe(false);
      // While an active administrator exists, an existing installation gets no other one.
      await expect(
        bootstrapAdmin(`${tag}-first@example.test`, file, 'ADMIN', 'existing-installation'),
      ).rejects.toThrow(/active platform administrator already exists/);
      expect(existsSync(file)).toBe(false);
      await expect(
        bootstrapAdmin(`${tag}-first@example.test`, file, 'MINISTRY', 'existing-installation'),
      ).rejects.toThrow(/Only a platform administrator/);
      expect(existsSync(file)).toBe(false);
      const [created] = await db
        .select()
        .from(users)
        .where(eq(users.email, `${tag}-first@example.test`));
      expect(created).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('adds the platform administrator to an existing installation that has none', async () => {
    // An installation bootstrapped before the operator layer: accounts, but no administrator.
    const paused = await db
      .update(users)
      .set({ isActive: false })
      .where(and(eq(users.role, 'ADMIN'), eq(users.isActive, true)))
      .returning({ id: users.id });
    const { dir, file } = await privateFile();
    const email = `${tag}-operator@example.test`;
    try {
      // Never someone else's account turned into an administrator.
      await expect(
        bootstrapAdmin(w.users.ministry.email, file, 'ADMIN', 'existing-installation'),
      ).rejects.toThrow(/another account uses this e-mail address/);
      expect(existsSync(file)).toBe(false);

      await bootstrapAdmin(email, file, 'ADMIN', 'existing-installation');
      const first = (await readFile(file, 'utf8')).trim();
      await rm(file);
      const [operator] = await db.select().from(users).where(eq(users.email, email));
      expect(operator).toMatchObject({
        role: 'ADMIN',
        facilityId: null,
        isActive: true,
        passwordHash: null,
      });
      const [invited] = await auditRows('user.invited', operator!.id);
      expect(invited!.metadata).toMatchObject({ source: 'owner-authorized-existing-installation' });

      // A second run before activation renews the invitation; the earlier link stops working.
      await bootstrapAdmin(email, file, 'ADMIN', 'existing-installation');
      const second = (await readFile(file, 'utf8')).trim();
      await rm(file);
      expect(second).not.toBe(first);
      expect(
        (
          await api()
            .post('/api/v1/auth/activate')
            .send({ token: tokenOf(first), password: NEW_PASSWORD })
        ).status,
      ).toBe(400);
      expect(
        (
          await api()
            .post('/api/v1/auth/activate')
            .send({ token: tokenOf(second), password: NEW_PASSWORD })
        ).status,
      ).toBe(204);
      expect(await login(email, NEW_PASSWORD)).toBeTruthy();

      // Now there is an active administrator: refused, and nothing left behind.
      await expect(
        bootstrapAdmin(`${tag}-another@example.test`, file, 'ADMIN', 'existing-installation'),
      ).rejects.toThrow(/active platform administrator already exists/);
      expect(existsSync(file)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await db.update(users).set({ isActive: false }).where(eq(users.email, email));
      if (paused.length) {
        await db
          .update(users)
          .set({ isActive: true })
          .where(
            inArray(
              users.id,
              paused.map((r) => r.id),
            ),
          );
      }
    }
  });
});
