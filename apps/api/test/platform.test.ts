import { and, eq, max } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  invoices,
  legalAcceptances,
  legalDocuments,
  platformSettings,
  subscriptionEvents,
  subscriptionPlans,
  subscriptions,
} from '../src/db/schema.js';
import { audit, AuditAction } from '../src/modules/audit/audit.service.js';
import { api, bearer, createFacility, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let admin: { id: string; token: string };

beforeAll(async () => {
  w = await createWorld();
  const a = await createUser('ADMIN');
  admin = { id: a.id, token: await login(a.email) };
});

const asAdmin = () => bearer(admin.token);
const putSettings = (body: Record<string, unknown>, token = admin.token) =>
  api().put('/api/v1/admin/settings').set(bearer(token)).send(body);
const createDoc = (body: Record<string, unknown>) =>
  api().post('/api/v1/admin/legal').set(asAdmin()).send(body);
const publish = (id: string) =>
  api().post(`/api/v1/admin/legal/${id}/publish`).set(asAdmin()).send({});
const status = (token: string, locale?: string) =>
  api()
    .get('/api/v1/legal/status')
    .query(locale ? { locale } : {})
    .set(bearer(token));
const accept = (token: string, kind: string, version: string) =>
  api().post('/api/v1/legal/accept').set(bearer(token)).send({ kind, version });
const LONG = 'A text that is long enough to be a legal document body for the test.';

describe('access', () => {
  it('keeps the administrator endpoints to the platform administrator', async () => {
    const paths = ['/overview', '/settings', '/legal', '/audit'];
    for (const token of [w.tokens.ministry, w.tokens.director, w.tokens.doctor, w.tokens.patient]) {
      for (const p of paths) {
        expect((await api().get(`/api/v1/admin${p}`).set(bearer(token))).status).toBe(403);
      }
      expect((await putSettings({ operatorName: 'X' }, token)).status).toBe(403);
    }
    expect((await api().get('/api/v1/admin/overview')).status).toBe(401);
    expect((await api().get('/api/v1/legal/status')).status).toBe(401);
  });
});

describe('operator settings and the notice to users', () => {
  it('validates, saves only what changed and audits the field names', async () => {
    const bad = [
      { supportEmail: 'not-an-email' },
      { operatorIban: '12 3456' },
      { invoicePrefix: 'P A C' },
      { vatRateBp: 6000 },
      { paymentTermsDays: -1 },
      { noticeTone: 'LOUD' },
      { unknownField: 1 },
    ];
    for (const body of bad) expect((await putSettings(body)).status).toBe(400);

    // Other test files share this database and may have set the same values: start from empty.
    await db
      .update(platformSettings)
      .set({
        operatorName: '',
        operatorAddress: '',
        operatorIban: null,
        invoicePrefix: 'PAC',
        supportEmail: null,
        privacyEmail: null,
        vatRateBp: 0,
      })
      .where(eq(platformSettings.id, 1));
    const settingsAudits = () =>
      db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, AuditAction.PLATFORM_SETTINGS_UPDATED),
            eq(auditLogs.actorUserId, admin.id),
          ),
        );

    const res = await putSettings({
      operatorName: 'Operator Test SH.P.K.',
      operatorAddress: 'Rr. Testi 1, Prishtinë',
      operatorIban: 'xk05 1212 0123 4567 8906',
      invoicePrefix: 'tst',
      supportEmail: 'Support@Example.org',
      privacyEmail: 'privacy@example.org',
      vatRateBp: 1800,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      operatorIban: 'XK05 1212 0123 4567 8906',
      invoicePrefix: 'TST',
      supportEmail: 'support@example.org',
      vatRateBp: 1800,
      updatedById: admin.id,
    });
    const [row] = await settingsAudits();
    expect((row!.metadata as { fields: string[] }).fields).toEqual(
      expect.arrayContaining(['operatorName', 'operatorIban', 'invoicePrefix', 'vatRateBp']),
    );
    // Sending the same values again changes nothing and is not audited again.
    expect((await putSettings({ vatRateBp: 1800 })).status).toBe(200);
    expect(await settingsAudits()).toHaveLength(1);
  });

  it('shows the operator and the notice publicly, only while the notice is valid', async () => {
    const info = () => api().get('/api/v1/platform/info');
    expect((await info()).body).toMatchObject({
      operatorName: 'Operator Test SH.P.K.',
      supportEmail: 'support@example.org',
      notice: null,
    });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    await putSettings({
      noticeText: 'Maintenance on Sunday 22:00–23:00',
      noticeTone: 'WARNING',
      noticeUntil: until,
    });
    expect((await info()).body.notice).toMatchObject({
      text: 'Maintenance on Sunday 22:00–23:00',
      tone: 'WARNING',
    });
    await putSettings({ noticeUntil: new Date(Date.now() - 60_000).toISOString() });
    expect((await info()).body.notice).toBeNull();
    await putSettings({ noticeUntil: null });
    expect((await info()).body.notice).not.toBeNull();
    await putSettings({ noticeText: '' });
    expect((await info()).body.notice).toBeNull();
    const [s] = await db.select().from(platformSettings);
    expect(s!.noticeText).toBeNull();
  });
});

describe('terms of use and privacy notice', () => {
  let termsSq: string;

  it('starts with nothing published and no pending acceptance', async () => {
    expect((await api().get('/api/v1/legal/terms')).status).toBe(404);
    expect((await status(w.tokens.doctor)).body.pending).toEqual([]);
  });

  it('creates, edits and deletes drafts', async () => {
    const template = await api()
      .get('/api/v1/admin/legal/templates')
      .query({ kind: 'TERMS', locale: 'sq' })
      .set(asAdmin());
    expect(template.body.title).toBe('Kushtet e përdorimit');
    expect(template.body.body).toContain('{operatorName}');

    const created = await createDoc({
      kind: 'TERMS',
      version: '1.0',
      locale: 'sq',
      title: template.body.title,
      body: template.body.body,
    });
    expect(created.status).toBe(201);
    termsSq = created.body.id;
    expect(
      (await createDoc({ kind: 'TERMS', version: '1.0', locale: 'sq', title: 'Dup', body: LONG }))
        .status,
    ).toBe(409);
    expect(
      (await createDoc({ kind: 'TERMS', version: 'v 1', locale: 'sq', title: 'Bad', body: LONG }))
        .status,
    ).toBe(400);
    const edited = await api()
      .patch(`/api/v1/admin/legal/${termsSq}`)
      .set(asAdmin())
      .send({ title: 'Kushtet e përdorimit të Pacient' });
    expect(edited.body.title).toBe('Kushtet e përdorimit të Pacient');

    const scratch = await createDoc({
      kind: 'PRIVACY',
      version: '0.9',
      locale: 'en',
      title: 'Scratch',
      body: LONG,
    });
    expect(
      (await api().delete(`/api/v1/admin/legal/${scratch.body.id}`).set(asAdmin())).status,
    ).toBe(204);
    const saved = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AuditAction.LEGAL_DOCUMENT_SAVED));
    expect(saved.map((r) => (r.metadata as { change: string }).change).sort()).toEqual([
      'created',
      'created',
      'deleted',
      'edited',
    ]);
  });

  it('publishes only when the operator details the text refers to are filled in', async () => {
    await putSettings({ privacyEmail: null });
    const refused = await publish(termsSq);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([{ path: 'privacyEmail', message: 'Not set' }]);
    await putSettings({ privacyEmail: 'privacy@example.org' });
    const ok = await publish(termsSq);
    expect(ok.status).toBe(200);
    expect(ok.body.publishedAt).toBeTruthy();
    expect((await publish(termsSq)).status).toBe(409);
  });

  it('keeps a published document fixed (API and database)', async () => {
    expect(
      (
        await api()
          .patch(`/api/v1/admin/legal/${termsSq}`)
          .set(asAdmin())
          .send({ title: 'Changed later' })
      ).status,
    ).toBe(409);
    expect((await api().delete(`/api/v1/admin/legal/${termsSq}`).set(asAdmin())).status).toBe(409);
    await expect(
      db
        .update(legalDocuments)
        .set({ body: 'Changed behind the API' })
        .where(eq(legalDocuments.id, termsSq)),
    ).rejects.toThrow();
    await expect(db.delete(legalDocuments).where(eq(legalDocuments.id, termsSq))).rejects.toThrow();
  });

  it('serves the current text publicly with language fallback and operator details', async () => {
    const en = await api().get('/api/v1/legal/terms').query({ locale: 'en' });
    expect(en.status).toBe(200);
    // Only Albanian is published: English readers get the Albanian text for now.
    expect(en.body).toMatchObject({ kind: 'TERMS', version: '1.0', locale: 'sq' });
    expect(en.body.body).toContain('Operator Test SH.P.K.');
    expect(en.body.body).not.toContain('{operatorName}');
    expect(en.body.operator).toMatchObject({ name: 'Operator Test SH.P.K.' });

    const tpl = await api()
      .get('/api/v1/admin/legal/templates')
      .query({ kind: 'TERMS', locale: 'en' })
      .set(asAdmin());
    const termsEn = await createDoc({ kind: 'TERMS', version: '1.0', locale: 'en', ...tpl.body });
    await publish(termsEn.body.id);
    const enNow = await api().get('/api/v1/legal/terms').query({ locale: 'en' });
    expect(enNow.body).toMatchObject({ locale: 'en', title: 'Terms of use' });
    expect((await api().get('/api/v1/legal/privacy')).status).toBe(404);
    expect((await api().get('/api/v1/legal/cookies')).status).toBe(400);
  });

  it('asks every user to accept the current version once', async () => {
    const pending = await status(w.tokens.doctor);
    expect(pending.body.pending).toHaveLength(1);
    expect(pending.body.pending[0]).toMatchObject({ kind: 'TERMS', version: '1.0', locale: 'en' });
    expect(pending.body.pending[0].body).toContain('Operator Test SH.P.K.');
    // The page can ask for its language.
    expect((await status(w.tokens.doctor, 'sq')).body.pending[0].locale).toBe('sq');

    expect((await accept(w.tokens.doctor, 'TERMS', '0.1')).status).toBe(409);
    expect((await accept(w.tokens.doctor, 'TERMS', '1.0')).status).toBe(200);
    expect((await accept(w.tokens.doctor, 'TERMS', '1.0')).body.pending).toEqual([]);
    expect((await status(w.tokens.doctor)).body.pending).toEqual([]);
    const rows = await db
      .select()
      .from(legalAcceptances)
      .where(eq(legalAcceptances.userId, w.users.doctor.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'TERMS', version: '1.0', locale: 'en' });
    const audited = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, AuditAction.LEGAL_ACCEPTED),
          eq(auditLogs.actorUserId, w.users.doctor.id),
        ),
      );
    expect(audited).toHaveLength(1);
    // Patients accept too.
    expect((await status(w.tokens.patient)).body.pending).toHaveLength(1);
  });

  it('asks again when a new version is published, but not for one without acceptance', async () => {
    const v2 = await createDoc({
      kind: 'TERMS',
      version: '2.0',
      locale: 'sq',
      title: 'Kushtet e përdorimit 2',
      body: `${LONG} Pyetje: {supportEmail}.`,
    });
    await publish(v2.body.id);
    const again = (await status(w.tokens.doctor)).body.pending;
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ version: '2.0', locale: 'sq' });
    // The operator's administrators publish the texts; they are not asked to accept them.
    expect((await api().get('/api/v1/legal/status').set(asAdmin())).body.pending).toEqual([]);
    // The old version can no longer be accepted.
    expect((await accept(w.tokens.patient, 'TERMS', '1.0')).status).toBe(409);
    expect((await accept(w.tokens.doctor, 'TERMS', '2.0')).status).toBe(200);

    // A late translation of an older version does not make it current again.
    const lateSr = await createDoc({
      kind: 'TERMS',
      version: '1.0',
      locale: 'sr',
      title: 'Uslovi korišćenja',
      body: LONG,
    });
    await publish(lateSr.body.id);
    expect((await api().get('/api/v1/legal/terms')).body.version).toBe('2.0');
    expect((await status(w.tokens.doctor)).body.pending).toEqual([]);

    const privacy = await createDoc({
      kind: 'PRIVACY',
      version: '1.0',
      locale: 'en',
      title: 'Privacy notice',
      body: `${LONG} Contact: {privacyEmail}.`,
      requiresAcceptance: false,
    });
    await publish(privacy.body.id);
    expect((await api().get('/api/v1/legal/privacy')).body.body).toContain('privacy@example.org');
    expect((await status(w.tokens.doctor)).body.pending).toEqual([]);
  });

  it('keeps acceptances append-only and counts them for the administrator', async () => {
    await expect(
      db
        .update(legalAcceptances)
        .set({ version: '9.9' })
        .where(eq(legalAcceptances.userId, w.users.doctor.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(legalAcceptances).where(eq(legalAcceptances.userId, w.users.doctor.id)),
    ).rejects.toThrow();

    const list = await api().get('/api/v1/admin/legal').set(asAdmin());
    expect(list.body.current).toEqual({ TERMS: '2.0', PRIVACY: '1.0' });
    expect(list.body.missingSettings).toEqual([]);
    expect(list.body.documents.every((d: Record<string, unknown>) => !('body' in d))).toBe(true);
    expect(list.body.acceptance).toEqual(
      expect.arrayContaining([{ kind: 'TERMS', version: '2.0', accepted: 1 }]),
    );
    const who = await api()
      .get('/api/v1/admin/legal/acceptances')
      .query({ kind: 'TERMS', version: '2.0' })
      .set(asAdmin());
    expect(who.body).toMatchObject({ accepted: 1 });
    expect(who.body.latest[0]).toMatchObject({ userName: w.users.doctor.fullName, role: 'DOCTOR' });
    expect(who.body.activeAccounts).toBeGreaterThan(5);
  });
});

describe('overview', () => {
  it('counts facilities, accounts, revenue and renewals from the rows', async () => {
    const before = (await api().get('/api/v1/admin/overview').set(asAdmin())).body;

    const facility = await createFacility();
    const other = await createFacility();
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        code: `P-${Date.now()}`,
        name: 'Clinic',
        monthlyPriceCents: 14900,
        yearlyPriceCents: 149000,
      })
      .returning();
    const now = Date.now();
    const [active] = await db
      .insert(subscriptions)
      .values({
        facilityId: facility.id,
        planId: plan!.id,
        status: 'ACTIVE',
        billingCycle: 'YEARLY',
        priceCents: 120000,
        currentPeriodStart: new Date(now - 300 * 86_400_000),
        currentPeriodEnd: new Date(now + 10 * 86_400_000),
      })
      .returning();
    await db.insert(subscriptions).values({
      facilityId: other.id,
      planId: plan!.id,
      status: 'PAST_DUE',
      priceCents: 4900,
      currentPeriodStart: new Date(now - 10 * 86_400_000),
      currentPeriodEnd: new Date(now + 20 * 86_400_000),
    });
    const invoice = (number: string, total: number, dueInDays: number) => ({
      number,
      facilityId: facility.id,
      subscriptionId: active!.id,
      periodStart: new Date(now - 30 * 86_400_000),
      periodEnd: new Date(now),
      description: 'Plan Clinic',
      netCents: total,
      totalCents: total,
      dueAt: new Date(now + dueInDays * 86_400_000),
      issuer: { name: 'Operator' },
      customer: { name: facility.name },
    });
    await db
      .insert(invoices)
      .values([invoice(`T-${now}-1`, 5000, -3), invoice(`T-${now}-2`, 7000, 10)]);
    // The newest entry of the history, whatever other test files wrote (some simulate later dates).
    const [newest] = await db
      .select({ at: max(subscriptionEvents.createdAt) })
      .from(subscriptionEvents);
    await db.insert(subscriptionEvents).values({
      subscriptionId: active!.id,
      facilityId: facility.id,
      type: 'ACTIVATED',
      toStatus: 'ACTIVE',
      actorId: admin.id,
      createdAt: new Date(Math.max(now, newest?.at?.getTime() ?? 0) + 1000),
    });
    await createUser('NURSE', facility.id, { passwordHash: null });
    await createUser('DOCTOR', facility.id, { mfaEnabledAt: null });

    const after = (await api().get('/api/v1/admin/overview').set(asAdmin())).body;
    expect(after.facilities.total - before.facilities.total).toBe(2);
    expect(after.facilities.withSubscription - before.facilities.withSubscription).toBe(2);
    expect(after.facilities.byStatus.ACTIVE - before.facilities.byStatus.ACTIVE).toBe(1);
    expect(after.facilities.byStatus.PAST_DUE - before.facilities.byStatus.PAST_DUE).toBe(1);
    // Yearly 1 200 € counts as 100 €/month; the past-due monthly 49 € still counts.
    expect(after.revenue.mrrCents - before.revenue.mrrCents).toBe(10000 + 4900);
    expect(after.revenue.openCents - before.revenue.openCents).toBe(12000);
    expect(after.revenue.overdueCents - before.revenue.overdueCents).toBe(5000);
    expect(after.revenue.overdueCount - before.revenue.overdueCount).toBe(1);
    expect(after.users.pendingActivation - before.users.pendingActivation).toBe(1);
    expect(after.users.activeStaff - before.users.activeStaff).toBe(1);
    expect(after.users.staffWithoutTwoStep - before.users.staffWithoutTwoStep).toBe(1);
    expect(after.users.admins).toBeGreaterThanOrEqual(1);
    expect(after.renewals.map((r: { facilityId: string }) => r.facilityId)).toEqual(
      expect.arrayContaining([facility.id, other.id]),
    );
    expect(after.recentEvents[0]).toMatchObject({
      type: 'ACTIVATED',
      facilityName: facility.name,
    });
    // Nothing clinical in the overview.
    expect(JSON.stringify(after)).not.toMatch(/diagnos|nationalId|dateOfBirth/i);
  });
});

describe('administrative audit', () => {
  it('lists administrative actions by category with actor and target names', async () => {
    const ctx = { userId: admin.id, role: 'ADMIN' as const, facilityId: null };
    await audit({
      action: AuditAction.ADMIN_USER_DISABLED,
      actor: ctx,
      resourceType: 'user',
      resourceId: w.users.nurse.id,
      metadata: { reason: 'Left the facility' },
    });
    await audit({
      action: AuditAction.INVOICE_PAID,
      actor: ctx,
      resourceType: 'facility',
      resourceId: w.facility.id,
    });
    await audit({
      action: AuditAction.USER_INVITED,
      actor: ctx,
      resourceType: 'user',
      resourceId: w.users.doctor.id,
    });
    // The front desk taking a patient's co-payment is patient billing, not administration.
    await audit({
      action: AuditAction.PAYMENT_RECEIVED,
      actor: { userId: w.users.reception.id, role: 'RECEPTION', facilityId: w.facility.id },
      resourceType: 'patient',
      resourceId: w.patient.id,
      metadata: { amountCents: 500 },
    });

    const get = (category: string) =>
      api().get('/api/v1/admin/audit').query({ category, pageSize: 100 }).set(asAdmin());
    const users = (await get('users')).body;
    expect(users.items.map((i: { action: string }) => i.action)).toEqual(
      expect.arrayContaining([AuditAction.ADMIN_USER_DISABLED, AuditAction.USER_INVITED]),
    );
    expect(users.items.every((i: { action: string }) => !i.action.startsWith('billing.'))).toBe(
      true,
    );
    const disabled = users.items.find(
      (i: { action: string }) => i.action === AuditAction.ADMIN_USER_DISABLED,
    );
    expect(disabled).toMatchObject({
      actorName: expect.any(String),
      targetName: w.users.nurse.fullName,
    });

    const billing = (await get('billing')).body;
    expect(
      billing.items.every((i: { action: string }) =>
        /^billing\.(plan|subscription|invoice)\./.test(i.action),
      ),
    ).toBe(true);
    expect(
      billing.items.some(
        (i: { action: string; targetName: string | null }) =>
          i.action === AuditAction.INVOICE_PAID && i.targetName === w.facility.name,
      ),
    ).toBe(true);

    const platform = (await get('platform')).body.items.map((i: { action: string }) => i.action);
    expect(platform).toEqual(
      expect.arrayContaining([
        AuditAction.PLATFORM_SETTINGS_UPDATED,
        AuditAction.LEGAL_DOCUMENT_SAVED,
        AuditAction.LEGAL_DOCUMENT_PUBLISHED,
      ]),
    );
    // A user accepting the terms is not an administrative action.
    const all = (await get('all')).body;
    expect(all.items.some((i: { action: string }) => i.action === AuditAction.LEGAL_ACCEPTED)).toBe(
      false,
    );
    expect(all.items.length).toBe(Math.min(all.total, 100));
    expect(
      all.items.some((i: { action: string }) => i.action === AuditAction.PAYMENT_RECEIVED),
    ).toBe(false);
    const overview = (await api().get('/api/v1/admin/overview').set(asAdmin())).body;
    const recent = overview.recentActions.map((i: { action: string }) => i.action);
    expect(recent).toContain(AuditAction.INVOICE_PAID);
    expect(recent).not.toContain(AuditAction.PAYMENT_RECEIVED);
    expect((await get('nonsense')).status).toBe(400);
  });
});
