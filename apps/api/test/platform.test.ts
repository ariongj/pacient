import { and, eq, max } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  invoices,
  legalAcceptances,
  legalDocuments,
  patients,
  platformSettings,
  subscriptionEvents,
  subscriptionPlans,
  subscriptions,
} from '../src/db/schema.js';
import { audit, AuditAction } from '../src/modules/audit/audit.service.js';
import {
  api,
  bearer,
  createFacility,
  createPatient,
  createUser,
  createWorld,
  login,
} from './helpers.js';

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
      // Too short for Kosovo, a swapped pair of digits, one digit missing: all caught.
      { operatorIban: 'XK00 1' },
      { operatorIban: 'XK05 1212 0123 4567 8960' },
      { operatorIban: 'XK05 1212 0123 4567 890' },
      { operatorIban: 'DE89 3704 0044 0532 0130 01' },
      // Check digits are 02–98: 01 and 00 pass the sum where 98 and 97 are right.
      { operatorIban: 'XK01 1212 0123 4500 0075' },
      { operatorIban: 'XK00 1212 0123 4500 0093' },
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
    // Other countries' IBANs pass with their own length and check digits.
    const albanian = await putSettings({ operatorIban: 'AL47 2121 1009 0000 0002 3569 8741' });
    expect(albanian.status).toBe(200);
    expect((await putSettings({ operatorIban: 'XK98 1212 0123 4500 0075' })).status).toBe(200);
    expect((await putSettings({ operatorIban: 'XK05 1212 0123 4567 8906' })).status).toBe(200);
  });

  it('checks the IBAN only when it changes, and says when the stored one fails the check', async () => {
    // Stored before the check was stricter (two digits swapped).
    await db
      .update(platformSettings)
      .set({ operatorIban: 'XK05 1212 0123 4567 8960' })
      .where(eq(platformSettings.id, 1));
    const page = await api().get('/api/v1/admin/settings').set(asAdmin());
    expect(page.body).toMatchObject({
      operatorIban: 'XK05 1212 0123 4567 8960',
      operatorIbanValid: false,
    });
    // The settings page sends every field back: an urgent notice is saved all the same.
    const saved = await putSettings({
      operatorIban: 'xk05 1212 0123 4567  8960',
      noticeText: 'Maintenance tonight',
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      noticeText: 'Maintenance tonight',
      operatorIban: 'XK05 1212 0123 4567 8960',
      operatorIbanValid: false,
    });
    // A new IBAN is checked; a valid one clears the warning.
    const refused = await putSettings({ operatorIban: 'XK01 1212 0123 4500 0075' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([
      { path: 'operatorIban', message: 'This IBAN is not valid: check its length and digits' },
    ]);
    const fixed = await putSettings({ operatorIban: 'XK05 1212 0123 4567 8906', noticeText: null });
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ operatorIbanValid: true, noticeText: null });
    expect((await putSettings({ operatorIban: null })).body.operatorIbanValid).toBe(true);
    await putSettings({ operatorIban: 'XK05 1212 0123 4567 8906' });
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

  it('writes the operator details into a text when it is published', async () => {
    const privacy = await api().get('/api/v1/legal/privacy');
    const [stored] = await db
      .select()
      .from(legalDocuments)
      .where(eq(legalDocuments.id, privacy.body.id));
    expect(stored!.body).toContain('Contact: privacy@example.org.');
    expect(stored!.body).not.toMatch(/\{\w+\}/);

    // Changing (or clearing) the operator details later does not change what users read and
    // accepted, and cannot undo the "fill in first" rule for a published text.
    expect((await putSettings({ privacyEmail: null, operatorName: 'Someone Else' })).status).toBe(
      200,
    );
    const after = await api().get('/api/v1/legal/privacy');
    expect(after.body).toMatchObject({ version: '1.0', body: privacy.body.body });
    expect(after.body.body).toContain('privacy@example.org');
    expect(after.body.body).not.toContain('—');
    // The contact block next to the text is the operator as of today.
    expect(after.body.operator).toMatchObject({ name: 'Someone Else', privacyEmail: null });
    await putSettings({
      privacyEmail: 'privacy@example.org',
      operatorName: 'Operator Test SH.P.K.',
    });

    // A title that no longer fits once the details are filled in is refused, not cut.
    const long = await createDoc({
      kind: 'PRIVACY',
      version: '1.1-draft',
      locale: 'sq',
      title: `${'T'.repeat(186)}{operatorName}`,
      body: LONG,
    });
    expect(long.status).toBe(201);
    expect((await publish(long.body.id)).status).toBe(400);
    await api().delete(`/api/v1/admin/legal/${long.body.id}`).set(asAdmin());
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

    // Patient accounts are listed by role and time only: no name.
    expect((await accept(w.tokens.patient, 'TERMS', '2.0')).status).toBe(200);
    const withPatient = await api()
      .get('/api/v1/admin/legal/acceptances')
      .query({ kind: 'TERMS', version: '2.0' })
      .set(asAdmin());
    expect(withPatient.body.accepted).toBe(2);
    const patientRow = withPatient.body.latest.find((a: { role: string }) => a.role === 'PATIENT');
    expect(patientRow).toMatchObject({ userName: null, acceptedAt: expect.any(String) });
    expect(JSON.stringify(withPatient.body)).not.toContain(w.users.patientUser.fullName);
  });

  it('keeps asking users who never accepted when a newer version needs no acceptance', async () => {
    // 2.1 only corrects a typo and does not ask for acceptance.
    const v21 = await createDoc({
      kind: 'TERMS',
      version: '2.1',
      locale: 'sq',
      title: 'Kushtet e përdorimit 2.1',
      body: LONG,
      requiresAcceptance: false,
    });
    expect((await publish(v21.body.id)).status).toBe(200);
    const terms = async (token: string) =>
      ((await status(token)).body.pending as { kind: string; version: string }[]).filter(
        (p) => p.kind === 'TERMS',
      );

    // Accepted 2.0, the latest version that asked: nothing more to do.
    expect(await terms(w.tokens.doctor)).toEqual([]);
    // Never accepted any version, or only one older than 2.0: asked to accept the current one.
    expect(await terms(w.tokens.nurse)).toMatchObject([{ version: '2.1' }]);
    const newcomer = await createUser('DOCTOR', w.facility.id);
    const newcomerToken = await login(newcomer.email);
    expect(await terms(newcomerToken)).toMatchObject([{ version: '2.1' }]);
    const oldTimer = await createUser('NURSE', w.facility.id);
    await db
      .insert(legalAcceptances)
      .values({ userId: oldTimer.id, kind: 'TERMS', version: '1.0', locale: 'sq' });
    expect(await terms(await login(oldTimer.email))).toMatchObject([{ version: '2.1' }]);

    // Accepting the current version satisfies it, also for later versions without acceptance.
    expect((await accept(w.tokens.nurse, 'TERMS', '2.1')).status).toBe(200);
    expect(await terms(w.tokens.nurse)).toEqual([]);
    const v22 = await createDoc({
      kind: 'TERMS',
      version: '2.2',
      locale: 'sq',
      title: 'Kushtet e përdorimit 2.2',
      body: LONG,
      requiresAcceptance: false,
    });
    await publish(v22.body.id);
    expect(await terms(w.tokens.nurse)).toEqual([]);
    expect(await terms(w.tokens.doctor)).toEqual([]);
    expect(await terms(newcomerToken)).toMatchObject([{ version: '2.2' }]);
  });

  it('keeps the text as written, so a new version starts from its placeholders', async () => {
    const privacy = await api().get('/api/v1/legal/privacy');
    const doc = await api().get(`/api/v1/admin/legal/${privacy.body.id}`).set(asAdmin());
    expect(doc.body).toMatchObject({
      title: 'Privacy notice',
      body: privacy.body.body,
      titleSource: 'Privacy notice',
      bodySource: `${LONG} Contact: {privacyEmail}.`,
    });
    const list = await api().get('/api/v1/admin/legal').set(asAdmin());
    const listed = (id: string) =>
      list.body.documents.find((d: { id: string }) => d.id === id) as { hasSource: boolean };
    expect(listed(privacy.body.id).hasSource).toBe(true);
    // The database keeps the source fixed with the text, and only a published text has one.
    await expect(
      db
        .update(legalDocuments)
        .set({ bodySource: `${LONG} Changed behind the API.` })
        .where(eq(legalDocuments.id, privacy.body.id)),
    ).rejects.toThrow();
    await expect(
      db.insert(legalDocuments).values({
        kind: 'PRIVACY',
        version: 'draft-src',
        locale: 'sq',
        title: 'Draft',
        body: LONG,
        titleSource: 'Draft',
        bodySource: LONG,
      }),
    ).rejects.toThrow();
  });

  it('never fills a published text in again; only older texts without a source are', async () => {
    const read = async () =>
      (await api().get('/api/v1/legal/privacy').query({ locale: 'en' })).body as {
        version: string;
        body: string;
      };
    // A value that looks like a placeholder is written in as typed, and stays so.
    expect((await putSettings({ operatorName: 'Op {privacyEmail}' })).status).toBe(200);
    const v11 = await createDoc({
      kind: 'PRIVACY',
      version: '1.1',
      locale: 'en',
      title: 'Privacy notice',
      body: `${LONG} Controller: {operatorName}.`,
      requiresAcceptance: false,
    });
    expect((await publish(v11.body.id)).status).toBe(200);
    expect(await read()).toMatchObject({
      version: '1.1',
      body: `${LONG} Controller: Op {privacyEmail}.`,
    });
    await putSettings({ privacyEmail: 'new@example.org' });
    expect((await read()).body).toBe(`${LONG} Controller: Op {privacyEmail}.`);
    expect((await status(w.tokens.nurse)).body.pending).toEqual([]);

    // A text published before the details were written in still holds its placeholders: they
    // are filled in from the current settings when it is read.
    const [legacy] = await db
      .insert(legalDocuments)
      .values({
        kind: 'PRIVACY',
        version: '1.2',
        locale: 'en',
        title: 'Privacy notice',
        body: `${LONG} Write to {privacyEmail}.`,
        requiresAcceptance: false,
        publishedAt: new Date(),
      })
      .returning();
    expect(await read()).toMatchObject({
      version: '1.2',
      body: `${LONG} Write to new@example.org.`,
    });
    const list = await api().get('/api/v1/admin/legal').set(asAdmin());
    expect(list.body.documents.find((d: { id: string }) => d.id === legacy!.id)).toMatchObject({
      hasSource: false,
    });
    await putSettings({
      operatorName: 'Operator Test SH.P.K.',
      privacyEmail: 'privacy@example.org',
    });
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

  it('shows what a renewal bills, what a scheduled cancellation ends, and no zero totals as overdue', async () => {
    const before = (await api().get('/api/v1/admin/overview').set(asAdmin())).body;
    const [plan] = await db
      .insert(subscriptionPlans)
      .values({
        code: `R-${Date.now()}`,
        name: 'Renewals',
        monthlyPriceCents: 14900,
        yearlyPriceCents: 149000,
      })
      .returning();
    const now = Date.now();
    const period = (endInDays: number) => ({
      currentPeriodStart: new Date(now - 20 * 86_400_000),
      currentPeriodEnd: new Date(now + endInDays * 86_400_000),
    });
    const [toYearly, ending, suspended] = [
      await createFacility(),
      await createFacility(),
      await createFacility(),
    ];
    const [yearlySub] = await db
      .insert(subscriptions)
      .values({
        facilityId: toYearly.id,
        planId: plan!.id,
        status: 'ACTIVE',
        billingCycle: 'MONTHLY',
        priceCents: 14900,
        nextBillingCycle: 'YEARLY',
        nextPriceCents: 149000,
        ...period(3),
      })
      .returning();
    await db.insert(subscriptions).values([
      {
        facilityId: ending.id,
        planId: plan!.id,
        status: 'SUSPENDED',
        suspensionCause: 'MANUAL',
        suspendedAt: new Date(now - 86_400_000),
        cancelAtPeriodEnd: true,
        priceCents: 14900,
        ...period(4),
      },
      // Suspended without a scheduled end: it neither renews nor ends on that date.
      {
        facilityId: suspended.id,
        planId: plan!.id,
        status: 'SUSPENDED',
        suspensionCause: 'NON_PAYMENT',
        suspendedAt: new Date(now - 86_400_000),
        priceCents: 14900,
        ...period(4),
      },
    ]);
    // An open invoice with nothing to pay is never overdue.
    await db.insert(invoices).values({
      number: `Z-${now}`,
      facilityId: toYearly.id,
      subscriptionId: yearlySub!.id,
      periodStart: new Date(now - 20 * 86_400_000),
      periodEnd: new Date(now + 3 * 86_400_000),
      description: 'Plan Renewals (discounted to zero)',
      netCents: 0,
      totalCents: 0,
      dueAt: new Date(now - 5 * 86_400_000),
      issuer: { name: 'Operator' },
      customer: { name: toYearly.name },
    });

    const after = (await api().get('/api/v1/admin/overview').set(asAdmin())).body;
    expect(after.revenue.overdueCount).toBe(before.revenue.overdueCount);
    expect(after.revenue.overdueCents).toBe(before.revenue.overdueCents);
    type Renewal = { facilityId: string };
    const renewal = (id: string) => after.renewals.find((r: Renewal) => r.facilityId === id);
    expect(renewal(toYearly.id)).toMatchObject({
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      priceCents: 14900,
      nextBillingCycle: 'YEARLY',
      nextPriceCents: 149000,
      cancelAtPeriodEnd: false,
    });
    expect(renewal(ending.id)).toMatchObject({ status: 'SUSPENDED', cancelAtPeriodEnd: true });
    expect(renewal(suspended.id)).toBeUndefined();
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

    // Customers (facilities the administrator created) and the operator's billing.
    const billing = (await get('billing')).body;
    expect(
      billing.items.every((i: { action: string }) =>
        /^(billing\.(plan|subscription|invoice)|facility)\./.test(i.action),
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

  it('never shows what facility staff did, so never who is whose patient', async () => {
    // A doctor invites their patient to the portal: the row names the patient and the doctor.
    const patient = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    await db
      .update(patients)
      .set({ email: `p-${patient.id.slice(0, 8)}@test.local` })
      .where(eq(patients.id, patient.id));
    const invited = await api()
      .post(`/api/v1/patients/${patient.id}/portal-invitation`)
      .set(bearer(w.tokens.doctor))
      .send({});
    expect(invited.status).toBe(201);
    const [linked] = await db
      .select({ userId: patients.userId })
      .from(patients)
      .where(eq(patients.id, patient.id));
    // A director closing a colleague's account, the Ministry registering a facility.
    await audit({
      action: AuditAction.USER_DEACTIVATED,
      actor: { userId: w.users.director.id, role: 'DIRECTOR', facilityId: w.facility.id },
      resourceType: 'user',
      resourceId: w.users.colleague.id,
    });
    await audit({
      action: AuditAction.FACILITY_CREATED,
      actor: { userId: w.users.ministry.id, role: 'MINISTRY', facilityId: null },
      resourceType: 'facility',
      resourceId: w.otherFacility.id,
    });

    const get = (category: string) =>
      api().get('/api/v1/admin/audit').query({ category, pageSize: 100 }).set(asAdmin());
    type Item = { action: string; actorId: string | null; actorRole: string | null };
    for (const category of ['all', 'users', 'billing']) {
      const items: Item[] = (await get(category)).body.items;
      expect(items.every((i) => i.actorRole === 'ADMIN' || i.actorId === null)).toBe(true);
    }
    const overview = (await api().get('/api/v1/admin/overview').set(asAdmin())).body;
    const shown = [...(await get('all')).body.items, ...overview.recentActions];
    const text = JSON.stringify(shown);
    expect(text).not.toContain(linked!.userId!);
    expect(text).not.toContain(patient.lastName);
    const staff = [w.users.doctor.id, w.users.director.id, w.users.ministry.id];
    expect(shown.filter((i: Item) => staff.includes(i.actorId ?? ''))).toEqual([]);
    // The invitation is audited all the same, for the patient's access log and the facility.
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, linked!.userId!));
    expect(rows.map((r) => r.action)).toContain(AuditAction.USER_INVITED);
  });

  it('never lists what the system did to a patient’s portal account, nor names one', async () => {
    // A patient with a portal account dies; their doctor signs the certificate (the real flow),
    // which closes the account. The Ministry then withdraws it, which opens the account again.
    const portal = await createUser('PATIENT');
    const patient = await createPatient(w.facility.id, {
      doctorId: w.users.doctor.id,
      userId: portal.id,
    });
    await db
      .update(patients)
      .set({ dateOfBirth: '1940-03-01', sex: 'MALE' })
      .where(eq(patients.id, patient.id));
    const draft = await api()
      .post(`/api/v1/deaths/patients/${patient.id}`)
      .set(bearer(w.tokens.doctor))
      .send({
        placeOfDeath: 'HOSPITAL',
        mannerOfDeath: 'NATURAL',
        diedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        causes: [
          { line: 'a', text: 'Acute myocardial infarction', icd10: 'I21.9', interval: '2 hours' },
          { line: 'b', text: 'Coronary atherosclerosis', icd10: 'I25.1', interval: '10 years' },
        ],
        underlyingCauseIcd10: 'I25.1',
      });
    expect(draft.status).toBe(201);
    const signed = await api()
      .post(`/api/v1/deaths/${draft.body.id}/sign`)
      .set(bearer(w.tokens.doctor))
      .send({});
    expect(signed.status).toBe(200);
    expect(signed.body.effects.portalDisabled).toBe(true);

    const get = (category: string) =>
      api().get('/api/v1/admin/audit').query({ category, pageSize: 100 }).set(asAdmin());
    type Item = {
      action: string;
      resourceId: string | null;
      targetName: string | null;
      targetPatientAccount: boolean;
      metadata: Record<string, unknown> | null;
    };
    const shown = async () => {
      const overview = (await api().get('/api/v1/admin/overview').set(asAdmin())).body;
      return [
        ...((await get('users')).body.items as Item[]),
        ...((await get('all')).body.items as Item[]),
        ...(overview.recentActions as Item[]),
      ];
    };
    const notListed = async () => {
      const items = await shown();
      expect(items.filter((i) => i.resourceId === portal.id)).toEqual([]);
      const text = JSON.stringify(items);
      expect(text).not.toContain(portal.fullName);
      expect(text).not.toContain(patient.lastName);
      expect(text).not.toMatch(/death_registration/);
    };
    await notListed();

    const withdrawn = await api()
      .post(`/api/v1/deaths/${draft.body.id}/withdraw`)
      .set(bearer(w.tokens.ministry))
      .send({ reason: 'Certified for the wrong person by mistake (identity mix-up)' });
    expect(withdrawn.status).toBe(200);
    await notListed();

    // Both rows stay in the trail and in the account's own history.
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, portal.id));
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([AuditAction.USER_DEACTIVATED, AuditAction.USER_REACTIVATED]),
    );
    const page = await api().get(`/api/v1/admin/users/${portal.id}`).set(asAdmin());
    expect(page.body.adminHistory.map((h: { source: string }) => h.source)).toEqual(
      expect.arrayContaining(['death_registration', 'death_registration_withdrawn']),
    );

    // What an administrator does to a patient account is listed, without the patient's name.
    await audit({
      action: AuditAction.ADMIN_SESSIONS_REVOKED,
      actor: { userId: admin.id, role: 'ADMIN', facilityId: null },
      resourceType: 'user',
      resourceId: w.users.otherPatientUser.id,
      metadata: { reason: 'Lost phone – patient account audit check' },
    });
    const items = await shown();
    const revoked = items.filter(
      (i) => i.metadata?.reason === 'Lost phone – patient account audit check',
    );
    expect(revoked).toHaveLength(3);
    for (const i of revoked) {
      // Neither named nor identified: the id would resolve to the name on the account page.
      expect(i).toMatchObject({
        action: AuditAction.ADMIN_SESSIONS_REVOKED,
        resourceId: null,
        targetName: null,
        targetPatientAccount: true,
      });
    }
    expect(JSON.stringify(items)).not.toContain(w.users.otherPatientUser.fullName);
    expect(JSON.stringify(items)).not.toContain(w.users.otherPatientUser.id);
    // Staff accounts keep their names.
    expect(items.find((i) => i.resourceId === w.users.nurse.id)).toMatchObject({
      targetName: w.users.nurse.fullName,
      targetPatientAccount: false,
    });
  });

  it('lists the facilities the administrator creates for a customer', async () => {
    const code = `C-${Date.now()}`;
    const created = await api()
      .post('/api/v1/admin/organizations')
      .set(asAdmin())
      .send({
        facility: {
          code,
          name: `Customer ${code}`,
          type: 'REGIONAL_HOSPITAL',
          region: 'Prishtinë',
          municipality: 'Prishtinë',
        },
      });
    expect(created.status).toBe(201);
    for (const category of ['all', 'billing']) {
      const items = (
        await api().get('/api/v1/admin/audit').query({ category, pageSize: 100 }).set(asAdmin())
      ).body.items as { action: string; targetName: string | null; actorId: string }[];
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: AuditAction.FACILITY_CREATED,
            actorId: admin.id,
            targetName: `Customer ${code}`,
          }),
        ]),
      );
    }
    const recent = (await api().get('/api/v1/admin/overview').set(asAdmin())).body.recentActions;
    expect(recent.map((i: { action: string }) => i.action)).toContain(AuditAction.FACILITY_CREATED);
  });
});
