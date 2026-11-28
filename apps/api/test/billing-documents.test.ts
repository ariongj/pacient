import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Test } from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// The operator alerts are another builder's; here only the calls matter.
vi.mock('../src/modules/platform/alerts.js', () => ({
  raiseOperatorAlert: vi.fn(async () => undefined),
  resolveOperatorAlert: vi.fn(async () => undefined),
}));

import { db } from '../src/db/client.js';
import {
  auditLogs,
  billingDeliveries,
  creditNotes,
  emailOutbox,
  facilities,
  invoices,
  platformSettings,
  subscriptionEvents,
  subscriptions,
  users,
} from '../src/db/schema.js';
import { render } from '../src/modules/email/templates.js';
import { processOutboxOnce } from '../src/modules/email/outbox.js';
import { sentEmails } from '../src/modules/email/transport.js';
import { raiseOperatorAlert, resolveOperatorAlert } from '../src/modules/platform/alerts.js';
import { categoryByName } from '../src/modules/privacy/retention.js';
import {
  creditNoteDocumentContent,
  documentMoney,
  invoiceDocumentContent,
  queueBillingDocument,
} from '../src/modules/subscriptions/billing-documents.js';
import {
  addCycle,
  runSubscriptionLifecycle,
} from '../src/modules/subscriptions/subscriptions.service.js';
import {
  api,
  bearer,
  createFacility,
  createUser,
  createWorld,
  login,
  PASSWORD,
} from './helpers.js';

/**
 * Invoices reach the customer: billing readiness, facilities' billing details, invoice and credit
 * note PDFs, and e-mailing them (round 2, B1).
 */
const DAY = 86_400_000;
const HOUR = 3_600_000;

let w: Awaited<ReturnType<typeof createWorld>>;
let admin: string;
let adminId: string;
let planId: string;

/** Complete operator settings (every test file sets its own: the database is shared). */
const READY = {
  operatorName: 'Operator Docs SH.P.K.',
  operatorAddress: 'Rr. Dokumentet 2, Prishtinë',
  operatorFiscalNumber: '810000009',
  operatorVatNumber: '330000009',
  operatorIban: 'XK05 1212 0123 4567 8906',
  operatorBank: 'Demo Bank',
  supportEmail: 'billing@operator.test',
  vatRateBp: 1800,
  paymentTermsDays: 14,
  trialDays: 30,
  graceDays: 30,
  invoicePrefix: 'DOC',
};
const setSettings = (values: Partial<typeof platformSettings.$inferInsert>) =>
  db.update(platformSettings).set(values).where(eq(platformSettings.id, 1));

const adminGet = (path: string) => api().get(`/api/v1/admin${path}`).set(bearer(admin));
const adminPost = (path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/admin${path}`).set(bearer(admin)).send(body);
/** Changing VAT or bank settings asks for the password again (re-authentication). */
const adminPut = (path: string, body: Record<string, unknown>) =>
  api()
    .put(`/api/v1/admin${path}`)
    .set(bearer(admin))
    .set('X-Reauth-Password', `b64:${Buffer.from(PASSWORD).toString('base64')}`)
    .send(body);

/** A response body as bytes (PDFs). */
const binary = (req: Test) =>
  req.buffer(true).parse((res, callback) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
  });

async function startPaid(facilityId: string) {
  const res = await adminPost(`/organizations/${facilityId}/subscription`, {
    planId,
    billingCycle: 'MONTHLY',
    trial: false,
  });
  expect(res.status).toBe(201);
  return res.body.invoices[0] as { id: string; number: string; dueAt: string };
}
const subOf = async (facilityId: string) =>
  (await db.select().from(subscriptions).where(eq(subscriptions.facilityId, facilityId)))[0]!;
const invoicesOf = (facilityId: string) =>
  db
    .select()
    .from(invoices)
    .where(eq(invoices.facilityId, facilityId))
    .orderBy(asc(invoices.issuedAt));
const deliveriesOf = (invoiceId: string) =>
  db
    .select({ delivery: billingDeliveries, outbox: emailOutbox })
    .from(billingDeliveries)
    .innerJoin(emailOutbox, eq(emailOutbox.id, billingDeliveries.emailOutboxId))
    .where(eq(billingDeliveries.invoiceId, invoiceId))
    .orderBy(asc(billingDeliveries.recipient));
const auditsOf = (action: string, resourceId: string) =>
  db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.resourceId, resourceId)));
/**
 * Runs `fn` while the audit entry `action` for `resourceId` cannot be written (a trigger refuses
 * it): the change it audits must not remain either.
 */
async function withFailingAudit(action: string, resourceId: string, fn: () => Promise<void>) {
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION test_fail_billing_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = '${action}' AND NEW.resource_id = '${resourceId}' THEN
          RAISE EXCEPTION 'audit unavailable';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`),
  );
  await db.execute(
    sql.raw(`CREATE TRIGGER test_fail_billing_audit BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION test_fail_billing_audit()`),
  );
  try {
    await fn();
  } finally {
    await db.execute(sql.raw('DROP TRIGGER test_fail_billing_audit ON audit_logs'));
    await db.execute(sql.raw('DROP FUNCTION test_fail_billing_audit()'));
  }
}
async function deliverAll() {
  while ((await processOutboxOnce()) > 0) {
    /* deliver everything due */
  }
}
const profileOf = (n: string) => ({
  legalName: `Klinika Đakovë Čačak ${n} SH.P.K.`,
  businessNumber: `81100${n}`,
  fiscalNumber: `60000${n}`,
  vatNumber: `33300${n}`,
  billingAddress: `Rr. Faturimi ${n}, 50000 Gjakovë`,
  billingEmails: [`accounts-${n}@clinic.test`],
  contactName: 'Arta Krasniqi',
  customerReference: `PO-${n}`,
});

beforeAll(async () => {
  w = await createWorld();
  const a = await createUser('ADMIN');
  adminId = a.id;
  admin = await login(a.email);
  await setSettings(READY);
  const plan = await adminPost('/plans', {
    code: `DOCS-${randomUUID().slice(0, 6)}`,
    name: 'Clinic',
    monthlyPriceCents: 10_000,
    yearlyPriceCents: 100_000,
  });
  expect(plan.status).toBe(201);
  planId = plan.body.id;
});

describe('billing readiness', () => {
  it('lists what the operator settings lack; only the administrator sees it', async () => {
    await setSettings({ operatorFiscalNumber: null, operatorIban: '  ', operatorVatNumber: null });
    const res = await adminGet('/billing-readiness');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ready: false,
      missing: [
        { field: 'operatorFiscalNumber', label: 'Fiscal number (NUI)' },
        { field: 'operatorIban', label: 'IBAN' },
        { field: 'operatorVatNumber', label: 'VAT number' },
      ],
      vatRateBp: 1800,
    });
    // Without VAT the VAT number is not needed.
    await setSettings({ vatRateBp: 0 });
    expect((await adminGet('/billing-readiness')).body.missing).toEqual([
      { field: 'operatorFiscalNumber', label: 'Fiscal number (NUI)' },
      { field: 'operatorIban', label: 'IBAN' },
    ]);
    for (const token of [w.tokens.director, w.tokens.doctor, w.tokens.ministry]) {
      expect((await api().get('/api/v1/admin/billing-readiness').set(bearer(token))).status).toBe(
        403,
      );
    }
    await setSettings(READY);
    expect((await adminGet('/billing-readiness')).body).toMatchObject({ ready: true, missing: [] });
  });

  it('refuses every action that issues an invoice, with the missing fields, and changes nothing', async () => {
    await setSettings({ operatorIban: null });
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);

    // A paid start: 409 with the missing fields, and no subscription, invoice or e-mail.
    const paid = await adminPost(`/organizations/${f.id}/subscription`, {
      planId,
      trial: false,
    });
    expect(paid.status).toBe(409);
    expect(paid.body.error).toMatchObject({
      code: 'BILLING_NOT_READY',
      details: [{ field: 'operatorIban', message: 'IBAN' }],
    });
    expect(await db.select().from(subscriptions).where(eq(subscriptions.facilityId, f.id))).toEqual(
      [],
    );
    expect(await invoicesOf(f.id)).toEqual([]);
    expect(await db.select().from(emailOutbox).where(eq(emailOutbox.userId, director.id))).toEqual(
      [],
    );

    // A new customer starting paid: nothing is created at all.
    const code = `NC-${randomUUID().slice(0, 6)}`.toUpperCase();
    const customer = await adminPost('/organizations', {
      facility: {
        code,
        name: 'New paying customer',
        type: 'FAMILY_MEDICINE_CENTER',
        region: 'Pejë',
        municipality: 'Pejë',
      },
      billingProfile: profileOf('901'),
      subscription: { planId, trial: false },
    });
    expect(customer.status).toBe(409);
    expect(customer.body.error.code).toBe('BILLING_NOT_READY');
    expect(await db.select().from(facilities).where(eq(facilities.code, code))).toEqual([]);

    // A trial needs no invoice; ending it early does.
    const trial = await adminPost(`/organizations/${f.id}/subscription`, { planId, trial: true });
    expect(trial.status).toBe(201);
    const s = await subOf(f.id);
    const activate = await adminPost(`/subscriptions/${s.id}/activate`);
    expect(activate.status).toBe(409);
    expect(activate.body.error.code).toBe('BILLING_NOT_READY');
    expect((await subOf(f.id)).status).toBe('TRIAL');

    // Invoicing the current period of a running subscription.
    const g = await createFacility();
    const now = new Date();
    const [active] = await db
      .insert(subscriptions)
      .values({
        facilityId: g.id,
        planId,
        status: 'ACTIVE',
        priceCents: 10_000,
        currentPeriodStart: now,
        currentPeriodEnd: addCycle(now, 'MONTHLY'),
        billingAnchor: now,
      })
      .returning();
    const invoice = await adminPost(`/subscriptions/${active!.id}/invoices`);
    expect(invoice.status).toBe(409);
    expect(invoice.body.error.code).toBe('BILLING_NOT_READY');
    expect(await invoicesOf(g.id)).toEqual([]);

    await setSettings(READY);
    expect((await adminPost(`/subscriptions/${active!.id}/invoices`)).status).toBe(201);
    expect(await invoicesOf(g.id)).toHaveLength(1);
    expect((await adminPost(`/subscriptions/${s.id}/activate`)).status).toBe(200);
    expect((await subOf(f.id)).status).toBe('ACTIVE');
  });

  it('PUT /admin/settings charges VAT only with a VAT number', async () => {
    await setSettings({ vatRateBp: 0, operatorVatNumber: null });
    const put = (body: Record<string, unknown>) => adminPut('/settings', body);
    const refused = await put({ vatRateBp: 1800 });
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([
      {
        path: 'operatorVatNumber',
        message: 'Enter the VAT number to charge VAT, or set the VAT rate to 0',
      },
    ]);
    // The settings page sends every field: an empty VAT number with VAT is refused too.
    expect((await put({ vatRateBp: 1800, operatorVatNumber: '' })).status).toBe(400);
    expect((await put({ vatRateBp: 1800, operatorVatNumber: '330000010' })).status).toBe(200);
    // Clearing the number while VAT is charged.
    expect((await put({ operatorVatNumber: null })).status).toBe(400);
    expect((await put({ vatRateBp: 0, operatorVatNumber: null })).status).toBe(200);

    // Settings stored before the check never hold up another change (an urgent notice); the
    // overview says that billing is not ready instead.
    await setSettings({ vatRateBp: 1800, operatorVatNumber: null });
    expect((await put({ vatRateBp: 1800, noticeText: 'Maintenance tonight' })).status).toBe(200);
    expect((await adminGet('/billing-readiness')).body.missing).toEqual([
      { field: 'operatorVatNumber', label: 'VAT number' },
    ]);
    await setSettings({ ...READY, noticeText: null });
  });

  it('lets the subscription worker wait, tells the operator, and catch up once complete', async () => {
    const raise = vi.mocked(raiseOperatorAlert);
    const resolve = vi.mocked(resolveOperatorAlert);
    const f = await createFacility({ name: 'Klinika e Fshehtë' });
    await adminPost(`/organizations/${f.id}/subscription`, { planId, trial: true });
    const trialEnd = (await subOf(f.id)).trialEndsAt!;
    const g = await createFacility();
    const first = await startPaid(g.id);
    const periodEnd = (await subOf(g.id)).currentPeriodEnd;
    expect(first.number).toMatch(/^DOC-\d{4}-\d{5}$/);

    await setSettings({ operatorFiscalNumber: null, operatorAddress: '' });
    raise.mockClear();
    resolve.mockClear();
    const late = new Date(Math.max(trialEnd.getTime(), periodEnd.getTime()) + HOUR);
    const waiting = await runSubscriptionLifecycle(late, { facilityIds: [f.id, g.id] });
    expect(waiting).toMatchObject({ activated: 0, renewed: 0, waiting: 2 });
    // Nothing about them changed: still on trial, still in the first period, no invoice.
    expect((await subOf(f.id)).status).toBe('TRIAL');
    expect((await subOf(g.id)).currentPeriodEnd).toEqual(periodEnd);
    expect(await invoicesOf(f.id)).toEqual([]);
    expect(await invoicesOf(g.id)).toHaveLength(1);
    expect(raise).toHaveBeenCalledTimes(1);
    const [key, alert] = raise.mock.calls[0]!;
    expect(key).toBe('billing.settings_incomplete');
    expect(alert.severity).toBe('CRITICAL');
    expect(alert.message).toContain('Operator address, Fiscal number (NUI)');
    expect(alert.message).toContain('2 subscription(s)');
    // Never which facility, let alone anything about patients.
    expect(alert.message).not.toContain('Fshehtë');
    expect(resolve).not.toHaveBeenCalled();

    await setSettings(READY);
    const caughtUp = await runSubscriptionLifecycle(late, { facilityIds: [f.id, g.id] });
    expect(caughtUp).toMatchObject({ activated: 1, renewed: 1, waiting: 0 });
    expect(await invoicesOf(f.id)).toHaveLength(1);
    expect(await invoicesOf(g.id)).toHaveLength(2);
    expect(resolve).toHaveBeenCalledWith('billing.settings_incomplete');
  });
});

describe('billing details', () => {
  it('are saved by the administrator, audited, and noted in the history', async () => {
    const f = await createFacility();
    await adminPost(`/organizations/${f.id}/subscription`, { planId, trial: true });
    const path = `/organizations/${f.id}/billing-profile`;
    expect((await adminGet(path)).body).toEqual({ profile: null });

    const bad = [
      { ...profileOf('1'), legalName: '' },
      { ...profileOf('1'), billingEmails: ['a@x.test', 'b@x.test', 'c@x.test', 'd@x.test'] },
      { ...profileOf('1'), billingEmails: ['not-an-address'] },
      { ...profileOf('1'), vatNumber: 'x'.repeat(41) },
      { ...profileOf('1'), unknown: 1 },
    ];
    for (const body of bad) expect((await adminPut(path, body)).status).toBe(400);
    expect(
      (await adminPut(`/organizations/${randomUUID()}/billing-profile`, profileOf('1'))).status,
    ).toBe(404);

    const saved = await adminPut(path, {
      ...profileOf('101'),
      billingEmails: ['Accounts@Clinic.test', 'accounts@clinic.test', 'finance@clinic.test'],
      fiscalNumber: '',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.profile).toMatchObject({
      legalName: 'Klinika Đakovë Čačak 101 SH.P.K.',
      fiscalNumber: null,
      billingEmails: ['accounts@clinic.test', 'finance@clinic.test'],
      customerReference: 'PO-101',
      updatedBy: { id: adminId },
    });
    const [audit] = await auditsOf('billing.profile_changed', f.id);
    expect(audit).toMatchObject({ actorUserId: adminId, resourceType: 'facility' });
    expect((audit!.metadata as { fields: string[] }).fields).toEqual(
      expect.arrayContaining(['legalName', 'billingEmails', 'customerReference']),
    );
    // Field names only, never the values.
    expect(JSON.stringify(audit!.metadata)).not.toContain('clinic.test');
    const notes = await db
      .select()
      .from(subscriptionEvents)
      .where(and(eq(subscriptionEvents.facilityId, f.id), eq(subscriptionEvents.type, 'NOTE')));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.data).toMatchObject({ reason: 'billing details changed' });
    expect(notes[0]!.actorId).toBe(adminId);

    // The same details again: nothing recorded.
    await adminPut(path, {
      ...profileOf('101'),
      billingEmails: ['accounts@clinic.test', 'finance@clinic.test'],
      fiscalNumber: null,
    });
    expect(await auditsOf('billing.profile_changed', f.id)).toHaveLength(1);
    // A change is recorded with the fields that changed.
    await adminPut(path, {
      ...profileOf('101'),
      billingEmails: ['finance@clinic.test'],
      fiscalNumber: null,
    });
    const audits = await auditsOf('billing.profile_changed', f.id);
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => (a.metadata as { fields: string[] }).fields)).toContainEqual([
      'billingEmails',
    ]);

    // Only the administrator.
    for (const token of [w.tokens.director, w.tokens.doctor]) {
      expect((await api().get(`/api/v1/admin${path}`).set(bearer(token))).status).toBe(403);
      expect(
        (await api().put(`/api/v1/admin${path}`).set(bearer(token)).send(profileOf('2'))).status,
      ).toBe(403);
    }
  });

  it('are not saved when their audit entry cannot be written', async () => {
    const f = await createFacility();
    await adminPost(`/organizations/${f.id}/subscription`, { planId, trial: true });
    await withFailingAudit('billing.profile_changed', f.id, async () => {
      const res = await adminPut(`/organizations/${f.id}/billing-profile`, profileOf('150'));
      expect(res.status).toBe(500);
    });
    expect((await adminGet(`/organizations/${f.id}/billing-profile`)).body).toEqual({
      profile: null,
    });
    const notes = await db
      .select()
      .from(subscriptionEvents)
      .where(and(eq(subscriptionEvents.facilityId, f.id), eq(subscriptionEvents.type, 'NOTE')));
    expect(notes).toEqual([]);
  });

  it('are read by the facility’s own directors only', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    const token = await login(director.email);
    expect(
      (await api().get('/api/v1/subscription/billing-profile').set(bearer(token))).body,
    ).toEqual({ profile: null });
    await adminPut(`/organizations/${f.id}/billing-profile`, profileOf('202'));
    const mine = await api().get('/api/v1/subscription/billing-profile').set(bearer(token));
    expect(mine.status).toBe(200);
    expect(mine.body.profile).toMatchObject({ legalName: 'Klinika Đakovë Čačak 202 SH.P.K.' });
    // Who at the operator changed them is not the facility's business.
    expect(mine.body.profile.updatedBy).toBeUndefined();
    // Another facility's director sees their own (none), never this one.
    const other = await api()
      .get('/api/v1/subscription/billing-profile')
      .set(bearer(w.tokens.director));
    expect(other.body.profile?.legalName).not.toBe('Klinika Đakovë Čačak 202 SH.P.K.');
    // Directors cannot change them; other roles cannot read them.
    expect(
      (
        await api()
          .put('/api/v1/subscription/billing-profile')
          .set(bearer(token))
          .send(profileOf('3'))
      ).status,
    ).toBe(404);
    expect(
      (await api().get('/api/v1/subscription/billing-profile').set(bearer(w.tokens.doctor))).status,
    ).toBe(403);
  });

  it('are copied into each invoice as they are when it is issued', async () => {
    const f = await createFacility({ name: 'Qendra e Mjekësisë Familjare Test' });
    await adminPut(`/organizations/${f.id}/billing-profile`, profileOf('303'));
    const first = await startPaid(f.id);
    const [row] = await db.select().from(invoices).where(eq(invoices.id, first.id));
    expect(row!.customer).toMatchObject({
      name: 'Qendra e Mjekësisë Familjare Test',
      code: f.code,
      legalName: 'Klinika Đakovë Čačak 303 SH.P.K.',
      businessNumber: '81100303',
      fiscalNumber: '60000303',
      vatNumber: '33300303',
      billingAddress: 'Rr. Faturimi 303, 50000 Gjakovë',
      customerReference: 'PO-303',
    });
    // A later change never alters the invoice; the next one uses it.
    await adminPut(`/organizations/${f.id}/billing-profile`, {
      ...profileOf('303'),
      legalName: 'Renamed SH.P.K.',
    });
    const shown = await adminGet(`/invoices/${first.id}`);
    expect(shown.body.customer.legalName).toBe('Klinika Đakovë Čačak 303 SH.P.K.');
    const content = await invoiceDocumentContent(first.id, 'en');
    expect(content.customer[0]).toBe('Klinika Đakovë Čačak 303 SH.P.K.');

    // A new customer entered with its billing details: the first invoice already carries them.
    const created = await adminPost('/organizations', {
      facility: {
        code: `NC-${randomUUID().slice(0, 6)}`.toUpperCase(),
        name: 'Paying from day one',
        type: 'SPECIALIZED_CLINIC',
        region: 'Prizren',
        municipality: 'Prizren',
      },
      billingProfile: profileOf('304'),
      subscription: { planId, trial: false },
    });
    expect(created.status).toBe(201);
    expect(created.body.invoices[0].customer).toMatchObject({
      legalName: 'Klinika Đakovë Čačak 304 SH.P.K.',
      customerReference: 'PO-304',
    });
    expect(await auditsOf('billing.profile_changed', created.body.facility.id)).toHaveLength(1);
  });
});

describe('e-mailing billing documents', () => {
  it('sends a new invoice to each billing address and active director once, PDF attached', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id, { locale: 'sr' });
    const gone = await createUser('DIRECTOR', f.id, { isActive: false });
    await adminPut(`/organizations/${f.id}/billing-profile`, {
      ...profileOf('404'),
      // The director's own address, in other letters, is the director's: one message.
      billingEmails: [director.email.toUpperCase(), 'accounts-404@clinic.test'],
    });
    const invoice = await startPaid(f.id);

    const rows = await deliveriesOf(invoice.id);
    expect(rows.map((r) => r.delivery.recipient).sort()).toEqual(
      ['accounts-404@clinic.test', director.email].sort(),
    );
    expect(rows.map((r) => r.delivery.recipient)).not.toContain(gone.email);
    for (const r of rows) {
      expect(r.delivery).toMatchObject({ kind: 'ISSUED', queuedById: adminId, creditNoteId: null });
      expect(r.outbox).toMatchObject({
        template: 'billing_document',
        attachmentKind: 'invoice',
        attachmentId: invoice.id,
        status: 'PENDING',
      });
    }
    const toDirector = rows.find((r) => r.delivery.recipient === director.email)!;
    expect(toDirector.outbox.userId).toBe(director.id);
    expect(rows.find((r) => r.delivery.recipient !== director.email)!.outbox.userId).toBeNull();
    // Not e-mailed yet.
    expect((await adminGet(`/invoices/${invoice.id}`)).body).toMatchObject({
      sentAt: null,
      sending: true,
    });

    sentEmails.length = 0;
    await deliverAll();
    const mails = sentEmails.filter((m) => m.attachments?.length);
    const accounts = mails.find((m) => m.to === 'accounts-404@clinic.test')!;
    const toSerbian = mails.find((m) => m.to === director.email)!;
    // A billing address without an account reads Albanian; the director their own language.
    expect(accounts.subject).toBe(`Fatura ${invoice.number} nga Operator Docs SH.P.K.`);
    expect(toSerbian.subject).toBe(`Faktura ${invoice.number} od Operator Docs SH.P.K.`);
    expect(accounts.text).toContain(documentMoney(11_800, 'EUR', 'sq'));
    expect(accounts.text).toContain('XK05 1212 0123 4567 8906');
    expect(accounts.text).toContain(`me referencën ${invoice.number}`);
    for (const m of [accounts, toSerbian]) {
      expect(m.attachments).toHaveLength(1);
      expect(m.attachments![0]!.filename).toBe(`${invoice.number}.pdf`);
      expect(m.attachments![0]!.contentType).toBe('application/pdf');
      expect(m.attachments![0]!.content.subarray(0, 5).toString()).toBe('%PDF-');
    }
    // Nothing PDF-shaped is kept: the delivered message keeps only what it carried.
    const [after] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.id, toDirector.outbox.id));
    expect(after).toMatchObject({ status: 'SENT', textSealed: null, attachmentKind: 'invoice' });

    // The invoice list and page say when it was sent; the deliveries list the messages.
    const shown = await adminGet(`/invoices/${invoice.id}`);
    expect(shown.body.sentAt).toBeTruthy();
    expect(shown.body.sending).toBe(false);
    const list = await adminGet(`/invoices?facilityId=${f.id}`);
    expect(list.body.items[0].sentAt).toBeTruthy();
    const deliveries = await adminGet(`/invoices/${invoice.id}/deliveries`);
    expect(deliveries.status).toBe(200);
    expect(deliveries.body.items).toHaveLength(2);
    expect(deliveries.body.items[0]).toMatchObject({
      kind: 'ISSUED',
      status: 'SENT',
      queuedBy: { id: adminId },
    });
    expect((await adminGet(`/invoices/${randomUUID()}/deliveries`)).status).toBe(404);
  });

  it('writes the e-mail in the recipient’s language, with no health information', () => {
    const base = {
      template: 'billing_document' as const,
      name: null,
      document: 'invoice' as const,
      kind: 'REMINDER' as const,
      number: 'DOC-2026-00042',
      operator: 'Operator Docs SH.P.K.',
      period: '01.12.2026 – 31.12.2026',
      total: '118,00 €',
      dueDate: '15.12.2026',
      iban: 'XK05 1212 0123 4567 8906',
      reference: 'DOC-2026-00042',
      owed: 'FULL' as const,
      balance: null,
      invoiceNumber: null,
    };
    const en = render({ ...base, locale: 'en' });
    expect(en.subject).toBe('Reminder: invoice DOC-2026-00042 is overdue');
    expect(en.text).toContain('Hello,');
    expect(en.text).toContain('Amount to pay: 118,00 €, due by 15.12.2026.');
    expect(en.text).toContain('IBAN XK05 1212 0123 4567 8906 with the reference DOC-2026-00042');
    expect(en.text).toContain('never contain health information');
    const sr = render({ ...base, locale: 'sr', kind: 'ISSUED', name: 'Dr. Test' });
    expect(sr.subject).toBe('Faktura DOC-2026-00042 od Operator Docs SH.P.K.');
    expect(sr.text).toContain('Poštovani/a Dr. Test,');
    const credit = render({
      ...base,
      locale: 'sq',
      document: 'credit_note',
      kind: 'ISSUED',
      number: 'DOC-CN-2026-00001',
      invoiceNumber: 'DOC-2026-00042',
      dueDate: null,
      iban: null,
      reference: null,
    });
    expect(credit.subject).toBe('Nota e kreditit DOC-CN-2026-00001 nga Operator Docs SH.P.K.');
    expect(credit.text).toContain('për faturën DOC-2026-00042');
    const free = render({ ...base, locale: 'en', kind: 'ISSUED', owed: 'NONE' });
    expect(free.text).toContain('There is nothing to pay');
    expect(free.text).not.toContain('IBAN');
  });

  it('states what is actually owed: the rest of a part-paid invoice, nothing on a paid one', () => {
    const base = {
      template: 'billing_document' as const,
      name: null,
      document: 'invoice' as const,
      number: 'DOC-2026-00043',
      operator: 'Operator Docs SH.P.K.',
      period: '01.12.2026 – 31.12.2026',
      total: '€118.00',
      dueDate: '15.12.2026',
      iban: 'XK05 1212 0123 4567 8906',
      reference: 'DOC-2026-00043',
      balance: null,
      invoiceNumber: null,
      locale: 'en' as const,
    };
    const rest = render({ ...base, kind: 'REMINDER', owed: 'REST', balance: '€18.00' });
    expect(rest.text).toContain('Still to pay: €18.00 of €118.00, due by 15.12.2026.');
    expect(rest.text).not.toContain('Amount to pay');
    expect(rest.text).toContain('IBAN XK05 1212 0123 4567 8906');
    const paid = render({ ...base, kind: 'RESEND', owed: 'PAID' });
    expect(paid.text).toContain('This invoice is paid – attached for your records.');
    expect(paid.text).not.toMatch(/Amount to pay|Still to pay|IBAN|Please pay/);
    // A credit note mentions a refund only when money is to be refunded.
    const credit = { ...base, document: 'credit_note' as const, kind: 'ISSUED' as const };
    const refund = render({
      ...credit,
      number: 'DOC-CN-2026-00002',
      invoiceNumber: 'DOC-2026-00043',
      owed: 'REFUND',
      balance: '€30.00',
    });
    expect(refund.text).toContain(
      'Invoice DOC-2026-00043 was already paid: €30.00 will be refunded',
    );
    const settled = render({ ...credit, invoiceNumber: 'DOC-2026-00043', owed: 'PAID' });
    expect(settled.text).toContain('is settled: there is nothing more to pay');
    expect(settled.text).not.toContain('refund');
    const owing = render({
      ...credit,
      invoiceNumber: 'DOC-2026-00043',
      owed: 'REST',
      balance: '€88.00',
    });
    expect(owing.text).toContain('Still to pay on invoice DOC-2026-00043: €88.00.');
    expect(owing.text).not.toContain('refund');
  });

  it('sends the overdue invoice again with the reminder, once, also without a director', async () => {
    const f = await createFacility();
    await adminPut(`/organizations/${f.id}/billing-profile`, profileOf('505'));
    const invoice = await startPaid(f.id);
    const overdue = new Date(new Date(invoice.dueAt).getTime() + DAY);
    const run = await runSubscriptionLifecycle(overdue, { facilityIds: [f.id] });
    expect(run).toMatchObject({ pastDue: 1, reminders: 1 });
    const reminders = (await deliveriesOf(invoice.id)).filter(
      (r) => r.delivery.kind === 'REMINDER',
    );
    expect(reminders.map((r) => r.delivery.recipient)).toEqual(['accounts-505@clinic.test']);
    expect(reminders[0]!.delivery.queuedById).toBeNull();
    const again = await runSubscriptionLifecycle(new Date(overdue.getTime() + HOUR), {
      facilityIds: [f.id],
    });
    expect(again.reminders).toBe(0);
    expect(
      (await deliveriesOf(invoice.id)).filter((r) => r.delivery.kind === 'REMINDER'),
    ).toHaveLength(1);
  });

  it('sends a document again on request, audited; refuses when there is nobody to send to', async () => {
    const f = await createFacility();
    await adminPut(`/organizations/${f.id}/billing-profile`, profileOf('606'));
    const invoice = await startPaid(f.id);
    const sent = await adminPost(`/invoices/${invoice.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.queued).toBe(1);
    expect(sent.body.items.map((d: { kind: string }) => d.kind).sort()).toEqual([
      'ISSUED',
      'RESEND',
    ]);
    const resend = (await deliveriesOf(invoice.id)).find((r) => r.delivery.kind === 'RESEND')!;
    expect(resend.delivery.queuedById).toBe(adminId);
    const [audit] = await auditsOf('billing.invoice_sent', invoice.id);
    expect(audit).toMatchObject({ actorUserId: adminId, resourceType: 'invoice' });
    expect(audit!.metadata).toMatchObject({ number: invoice.number, recipients: 1 });

    // Without its audit entry nothing is queued.
    await withFailingAudit('billing.invoice_sent', invoice.id, async () => {
      expect((await adminPost(`/invoices/${invoice.id}/send`)).status).toBe(500);
    });
    expect(
      (await deliveriesOf(invoice.id)).filter((r) => r.delivery.kind === 'RESEND'),
    ).toHaveLength(1);

    // Nobody to send to: refused, nothing queued and nothing audited.
    const g = await createFacility();
    const lonely = await startPaid(g.id);
    expect(await deliveriesOf(lonely.id)).toEqual([]);
    const nobody = await adminPost(`/invoices/${lonely.id}/send`);
    expect(nobody.status).toBe(409);
    expect(await auditsOf('billing.invoice_sent', lonely.id)).toEqual([]);
    expect((await adminPost(`/invoices/${randomUUID()}/send`)).status).toBe(404);
    for (const token of [w.tokens.director, w.tokens.doctor]) {
      expect(
        (await api().post(`/api/v1/admin/invoices/${invoice.id}/send`).set(bearer(token))).status,
      ).toBe(403);
    }

    // A voided invoice is no longer owed and is not sent.
    await db
      .update(invoices)
      .set({ status: 'VOID', voidedAt: new Date(), voidReason: 'Issued by mistake' })
      .where(eq(invoices.id, lonely.id));
    await adminPut(`/organizations/${g.id}/billing-profile`, profileOf('607'));
    expect((await adminPost(`/invoices/${lonely.id}/send`)).status).toBe(409);
  });

  it('queues credit notes like invoices, and refuses a call without exactly one document', async () => {
    const f = await createFacility();
    await adminPut(`/organizations/${f.id}/billing-profile`, profileOf('707'));
    const invoice = await startPaid(f.id);
    const creditNote = await newCreditNote(invoice.id);
    const sent = await adminPost(`/credit-notes/${creditNote.id}/send`);
    expect(sent.status).toBe(200);
    expect(sent.body.items).toEqual([
      expect.objectContaining({ kind: 'RESEND', recipient: 'accounts-707@clinic.test' }),
    ]);
    const [row] = await db
      .select()
      .from(billingDeliveries)
      .where(eq(billingDeliveries.creditNoteId, creditNote.id));
    const [outbox] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.id, row!.emailOutboxId));
    expect(outbox).toMatchObject({ attachmentKind: 'credit_note', attachmentId: creditNote.id });
    expect(await auditsOf('billing.invoice_sent', creditNote.id)).toEqual([
      expect.objectContaining({ resourceType: 'credit_note' }),
    ]);
    expect((await adminGet(`/credit-notes/${creditNote.id}/deliveries`)).body.items).toHaveLength(
      1,
    );
    expect((await adminPost(`/credit-notes/${randomUUID()}/send`)).status).toBe(404);

    await expect(
      db.transaction((tx) => queueBillingDocument(tx, { kind: 'ISSUED' })),
    ).rejects.toThrow();
    await expect(
      db.transaction((tx) => queueBillingDocument(tx, { invoiceId: randomUUID(), kind: 'ISSUED' })),
    ).rejects.toThrow('Invoice not found');
  });

  it('withdraws the e-mails of a voided invoice still waiting to be sent: none goes out', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    await adminPut(`/organizations/${f.id}/billing-profile`, profileOf('909'));
    const invoice = await startPaid(f.id);
    expect((await deliveriesOf(invoice.id)).map((r) => r.outbox.status)).toEqual([
      'PENDING',
      'PENDING',
    ]);
    const voided = await adminPost(`/invoices/${invoice.id}/void`, {
      reason: 'Issued by mistake',
    }).set('X-Reauth-Password', PASSWORD);
    expect(voided.status).toBe(200);
    // Withdrawn in the void's transaction, content erased; the deliveries stay.
    const rows = await deliveriesOf(invoice.id);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.outbox).toMatchObject({
        status: 'CANCELLED',
        lastError: 'Not sent: the invoice was voided',
        subjectSealed: null,
        textSealed: null,
        htmlSealed: null,
      });
    }
    sentEmails.length = 0;
    await deliverAll();
    const addresses = [director.email, 'accounts-909@clinic.test'];
    expect(sentEmails.filter((m) => addresses.includes(m.to))).toEqual([]);
    const listed = await adminGet(`/invoices/${invoice.id}/deliveries`);
    expect(listed.body.items.map((d: { status: string }) => d.status)).toEqual([
      'CANCELLED',
      'CANCELLED',
    ]);
    expect((await adminGet(`/invoices/${invoice.id}`)).body).toMatchObject({
      sentAt: null,
      sending: false,
    });
    const [audit] = await auditsOf('billing.invoice.voided', invoice.id);
    expect(audit!.metadata).toMatchObject({ emailsWithdrawn: 2 });
    // Not owed: its PDF asks for nothing.
    const content = await invoiceDocumentContent(invoice.id, 'en');
    expect(content.payment).toEqual([]);
    expect(content.status).toMatch(/^Voided on .* · Issued by mistake$/);
    // And it is never queued again.
    expect(
      await db.transaction((tx) =>
        queueBillingDocument(tx, { invoiceId: invoice.id, kind: 'REMINDER' }),
      ),
    ).toBe(0);
  });

  it('never sends a waiting e-mail whose invoice was voided otherwise (the e-mail worker checks)', async () => {
    const f = await createFacility();
    await adminPut(`/organizations/${f.id}/billing-profile`, profileOf('910'));
    const invoice = await startPaid(f.id);
    await db
      .update(invoices)
      .set({ status: 'VOID', voidedAt: new Date(), voidReason: 'Voided by hand' })
      .where(eq(invoices.id, invoice.id));
    sentEmails.length = 0;
    for (let i = 0; i < 20; i++) {
      const [row] = await deliveriesOf(invoice.id);
      if (row!.outbox.status !== 'PENDING') break;
      await processOutboxOnce();
    }
    expect(sentEmails.filter((m) => m.to === 'accounts-910@clinic.test')).toEqual([]);
    const [row] = await deliveriesOf(invoice.id);
    expect(row!.outbox).toMatchObject({
      status: 'CANCELLED',
      lastError: 'Not sent: the invoice was voided',
      textSealed: null,
    });
  });

  it('asks only for what is still owed: the rest after a part payment, nothing once paid', async () => {
    const f = await createFacility();
    await adminPut(`/organizations/${f.id}/billing-profile`, profileOf('911'));
    const invoice = await startPaid(f.id);
    await deliverAll();
    const pay = (body: Record<string, unknown>) =>
      adminPost(`/invoices/${invoice.id}/payments`, { method: 'BANK_TRANSFER', ...body });
    expect((await pay({ amountCents: 10_000 })).status).toBe(200);

    // The overdue reminder asks for the rest, with where to pay it.
    sentEmails.length = 0;
    const overdue = new Date(new Date(invoice.dueAt).getTime() + DAY);
    expect(await runSubscriptionLifecycle(overdue, { facilityIds: [f.id] })).toMatchObject({
      pastDue: 1,
      reminders: 1,
    });
    await deliverAll();
    const reminder = sentEmails.find((m) => m.to === 'accounts-911@clinic.test')!;
    expect(reminder.subject).toBe(`Kujtesë: fatura ${invoice.number} ka kaluar afatin`);
    expect(reminder.text).toContain(
      `Mbetet për pagesë: ${documentMoney(1_800, 'EUR', 'sq')} nga ${documentMoney(11_800, 'EUR', 'sq')}`,
    );
    expect(reminder.text).not.toContain('Shuma për pagesë');
    expect(reminder.text).toContain('XK05 1212 0123 4567 8906');
    expect((await invoiceDocumentContent(invoice.id, 'en')).payment[0]).toMatch(
      /^Still to pay: €18\.00 of €118\.00\. Please pay it by bank transfer by /,
    );

    // Paid in full: a copy sent again asks for nothing, and its PDF says it is paid.
    expect((await pay({})).status).toBe(200);
    sentEmails.length = 0;
    expect((await adminPost(`/invoices/${invoice.id}/send`)).status).toBe(200);
    await deliverAll();
    const copy = sentEmails.find((m) => m.to === 'accounts-911@clinic.test')!;
    expect(copy.text).toContain('Kjo faturë është paguar – e bashkëngjitur për evidencën tuaj.');
    expect(copy.text).not.toMatch(/Shuma për pagesë|Mbetet për pagesë|IBAN|paguani/);
    const en = await invoiceDocumentContent(invoice.id, 'en');
    expect(en.payment).toEqual(['This invoice is paid. There is nothing more to pay.']);
    expect(en.status).toMatch(/^Paid on /);
  });

  it('sends an invoice that becomes overdue later in the same overdue period as well', async () => {
    await setSettings({ graceDays: 90 });
    try {
      const f = await createFacility();
      await adminPut(`/organizations/${f.id}/billing-profile`, profileOf('912'));
      const first = await startPaid(f.id);
      const periodEnd = (await subOf(f.id)).currentPeriodEnd;
      const run = (at: Date) => runSubscriptionLifecycle(at, { facilityIds: [f.id] });
      const reminders = async (invoiceId: string) =>
        (await deliveriesOf(invoiceId)).filter((r) => r.delivery.kind === 'REMINDER').length;
      expect(await run(new Date(new Date(first.dueAt).getTime() + DAY))).toMatchObject({
        pastDue: 1,
        reminders: 1,
      });
      // Still past due when the period ends: renewed with the next invoice, overdue 14 days on.
      expect((await run(new Date(periodEnd.getTime() + HOUR))).renewed).toBe(1);
      const second = (await invoicesOf(f.id))[1]!;
      expect(await reminders(second.id)).toBe(0);
      const later = new Date(second.dueAt.getTime() + HOUR);
      expect(await run(later)).toMatchObject({ pastDue: 0, reminders: 1 });
      expect(await reminders(second.id)).toBe(1);
      expect(await reminders(first.id)).toBe(1);
      // Each once.
      expect((await run(new Date(later.getTime() + HOUR))).reminders).toBe(0);
      expect(await reminders(second.id)).toBe(1);
    } finally {
      await setSettings(READY);
    }
  });

  it('attaches the PDF in the language the e-mail was written in, even if the account changed since', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id, { locale: 'sr' });
    const invoice = await startPaid(f.id);
    const [row] = await deliveriesOf(invoice.id);
    expect(row!.outbox.attachmentLocale).toBe('sr');
    await db.update(users).set({ locale: 'en' }).where(eq(users.id, director.id));
    sentEmails.length = 0;
    await deliverAll();
    const mail = sentEmails.find((m) => m.to === director.email)!;
    expect(mail.subject).toBe(`Faktura ${invoice.number} od Operator Docs SH.P.K.`);
    const pdf = mail.attachments![0]!.content.toString('latin1');
    expect(pdf).toContain('/Lang (sr)');
    expect(pdf).toContain(`(FAKTURA ${invoice.number})`);
  });

  it('lets the retention job purge withdrawn messages like failed ones', async () => {
    const old = new Date(Date.now() - 400 * DAY);
    const rows = await db
      .insert(emailOutbox)
      .values(
        (['CANCELLED', 'FAILED', 'PENDING'] as const).map((status) => ({
          toEmail: `${status.toLowerCase()}@retention.test`,
          template: 'notification',
          status,
          createdAt: old,
        })),
      )
      .returning();
    try {
      const where = categoryByName('EMAIL_OUTBOX')!.where(new Date(Date.now() - 90 * DAY));
      const ids = sql.join(
        rows.map((r) => sql`${r.id}`),
        sql`, `,
      );
      const due = await db.execute<{ status: string }>(
        sql`SELECT status::text FROM email_outbox WHERE ${where} AND id IN (${ids}) ORDER BY 1`,
      );
      expect(due.rows.map((r) => r.status)).toEqual(['CANCELLED', 'FAILED']);
    } finally {
      await db.delete(emailOutbox).where(
        inArray(
          emailOutbox.id,
          rows.map((r) => r.id),
        ),
      );
    }
  });
});

/** A credit note as B2's route will issue it (written directly: that route is not this file's). */
async function newCreditNote(invoiceId: string) {
  const [invoice] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  const seq = Math.floor(Math.random() * 1e9);
  const [row] = await db
    .insert(creditNotes)
    .values({
      number: `DOC-CN-2099-${seq}`,
      year: 2099,
      seq,
      invoiceId,
      facilityId: invoice!.facilityId,
      subscriptionId: invoice!.subscriptionId,
      reason: 'Price agreed after issue',
      netCents: 1_000,
      taxCents: 180,
      totalCents: 1_180,
      vatRateBp: 1800,
      issuer: invoice!.issuer,
      customer: invoice!.customer,
      createdById: adminId,
    })
    .returning();
  return row!;
}

describe('PDFs', () => {
  let f: Awaited<ReturnType<typeof createFacility>>;
  let directorToken: string;
  let invoice: { id: string; number: string };
  let creditNoteId: string;

  beforeAll(async () => {
    f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    directorToken = await login(director.email);
    await adminPut(`/organizations/${f.id}/billing-profile`, profileOf('808'));
    invoice = await startPaid(f.id);
    creditNoteId = (await newCreditNote(invoice.id)).id;
  });

  it('are downloaded by the administrator, in the language asked for', async () => {
    for (const locale of ['', '?locale=sr', '?locale=en']) {
      const res = await binary(adminGet(`/invoices/${invoice.id}/pdf${locale}`));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="${invoice.number}.pdf"`,
      );
      expect(res.headers['cache-control']).toBe('no-store');
      const pdf = res.body as Buffer;
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      // The bundled font, which prints ë, ç, č, ć and đ.
      expect(pdf.toString('latin1')).toContain('DejaVuSans');
    }
    expect((await adminGet(`/invoices/${invoice.id}/pdf?locale=de`)).status).toBe(400);
    expect((await adminGet(`/invoices/${randomUUID()}/pdf`)).status).toBe(404);
    const credit = await binary(adminGet(`/credit-notes/${creditNoteId}/pdf`));
    expect(credit.status).toBe(200);
    expect((credit.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await adminGet(`/credit-notes/${randomUUID()}/pdf`)).status).toBe(404);
  });

  it('are downloaded by the facility’s own directors; any other answers 404', async () => {
    const mine = await binary(
      api().get(`/api/v1/subscription/invoices/${invoice.id}/pdf`).set(bearer(directorToken)),
    );
    expect(mine.status).toBe(200);
    expect((mine.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    const credit = await binary(
      api().get(`/api/v1/subscription/credit-notes/${creditNoteId}/pdf`).set(bearer(directorToken)),
    );
    expect(credit.status).toBe(200);
    // Another facility's director: as if it did not exist.
    for (const path of [`/invoices/${invoice.id}/pdf`, `/credit-notes/${creditNoteId}/pdf`]) {
      expect(
        (await api().get(`/api/v1/subscription${path}`).set(bearer(w.tokens.director))).status,
      ).toBe(404);
      expect(
        (await api().get(`/api/v1/subscription${path}`).set(bearer(w.tokens.doctor))).status,
      ).toBe(403);
    }
    expect(
      (await api().get(`/api/v1/admin/invoices/${invoice.id}/pdf`).set(bearer(directorToken)))
        .status,
    ).toBe(403);
    // The list to download from: this facility's documents only.
    const docs = await api().get('/api/v1/subscription/documents').set(bearer(directorToken));
    expect(docs.status).toBe(200);
    expect(docs.body.invoices.map((i: { id: string }) => i.id)).toEqual([invoice.id]);
    expect(docs.body.creditNotes).toEqual([
      expect.objectContaining({ id: creditNoteId, invoiceNumber: invoice.number }),
    ]);
    const others = await api().get('/api/v1/subscription/documents').set(bearer(w.tokens.director));
    expect(others.body.invoices.map((i: { id: string }) => i.id)).not.toContain(invoice.id);
  });

  it('print the operator, the customer as frozen, the lines, VAT and how to pay', async () => {
    const en = await invoiceDocumentContent(invoice.id, 'en');
    expect(en.title).toBe('INVOICE');
    expect(en.filename).toBe(`${invoice.number}.pdf`);
    expect(en.issuer).toEqual([
      'Operator Docs SH.P.K.',
      'Rr. Dokumentet 2, Prishtinë',
      'Fiscal number (NUI): 810000009',
      'VAT number: 330000009',
      'billing@operator.test',
    ]);
    expect(en.meta.map(([label]) => label)).toEqual([
      'No.',
      'Issued',
      'Due date',
      'Service period',
    ]);
    expect(en.customer).toEqual(
      expect.arrayContaining([
        'Klinika Đakovë Čačak 808 SH.P.K.',
        'Rr. Faturimi 808, 50000 Gjakovë',
        'Business number (NUI): 81100808',
        'Fiscal number: 60000808',
        'VAT number: 33300808',
        'Your reference: PO-808',
      ]),
    );
    expect(en.table.rows[0]![0]).toBe('Subscription to the Pacient service: Clinic plan – monthly');
    expect(en.totals).toEqual([
      ['Amount without VAT', '€100.00'],
      ['VAT 18 %', '€18.00'],
      ['Total to pay', '€118.00'],
    ]);
    // What is still owed: the credit note of 11,80 € on it is taken into account.
    expect(en.payment).toEqual([
      expect.stringContaining(
        'Still to pay: €106.20 of €118.00. Please pay it by bank transfer by',
      ),
      'Bank: Demo Bank',
      'IBAN: XK05 1212 0123 4567 8906',
      `Payment reference: ${invoice.number}`,
    ]);
    expect(en.status).toBeNull();

    const sq = await invoiceDocumentContent(invoice.id, 'sq');
    expect(sq.title).toBe('FATURË');
    expect(sq.totals[2]).toEqual(['Gjithsej për pagesë', '118,00 €']);
    const sr = await invoiceDocumentContent(invoice.id, 'sr');
    expect(sr.title).toBe('FAKTURA');
    expect(sr.totals[1]![0]).toBe('PDV 18 %');

    const credit = await creditNoteDocumentContent(creditNoteId, 'en');
    expect(credit.title).toBe('CREDIT NOTE');
    expect(credit.intro).toEqual([
      `Credit note for invoice ${invoice.number}`,
      'Reason: Price agreed after issue',
    ]);
    expect(credit.totals.at(-1)).toEqual(['Total credited', '€11.80']);
  });

  it('say "Not registered for VAT" instead of VAT 0 %', async () => {
    await setSettings({ vatRateBp: 0, operatorVatNumber: null });
    try {
      const g = await createFacility();
      const free = await startPaid(g.id);
      const en = await invoiceDocumentContent(free.id, 'en');
      expect(en.totals).toEqual([
        ['Not registered for VAT', ''],
        ['Total to pay', '€100.00'],
      ]);
      expect(JSON.stringify(en)).not.toMatch(/VAT 0/);
      expect((await invoiceDocumentContent(free.id, 'sr')).totals[0]![0]).toBe(
        'Nije u sistemu PDV-a',
      );
      expect((await invoiceDocumentContent(free.id, 'sq')).totals[0]![0]).toBe(
        'Jo i regjistruar për TVSH',
      );
      const res = await binary(adminGet(`/invoices/${free.id}/pdf`));
      expect(res.status).toBe(200);
    } finally {
      await setSettings(READY);
    }
  });

  it('say "VAT 0 %" with the VAT number for a registered operator that charges no VAT', async () => {
    await setSettings({ vatRateBp: 0, operatorVatNumber: '330000019' });
    try {
      const g = await createFacility();
      const zero = await startPaid(g.id);
      const en = await invoiceDocumentContent(zero.id, 'en');
      expect(en.issuer).toContain('VAT number: 330000019');
      expect(en.totals).toEqual([
        ['Amount without VAT', '€100.00'],
        ['VAT 0 %', '€0.00'],
        ['Total to pay', '€100.00'],
      ]);
      expect(JSON.stringify(en)).not.toContain('Not registered for VAT');
      const note = await adminPost(`/invoices/${zero.id}/credit-notes`, {
        amountCents: 1_000,
        reason: 'Discount agreed later',
      }).set('X-Reauth-Password', PASSWORD);
      expect(note.status).toBe(201);
      const credit = await creditNoteDocumentContent(note.body.id, 'en');
      expect(credit.totals).toEqual([
        ['Amount without VAT', '€10.00'],
        ['VAT 0 %', '€0.00'],
        ['Total credited', '€10.00'],
      ]);
    } finally {
      await setSettings(READY);
    }
  });

  it('formats amounts as each language writes them', () => {
    expect(documentMoney(123_450, 'EUR', 'en')).toBe('€1,234.50');
    expect(documentMoney(123_450, 'EUR', 'sq')).toBe('1 234,50 €');
    expect(documentMoney(123_450, 'EUR', 'sr')).toBe('1.234,50 €');
    expect(documentMoney(-500, 'EUR', 'en')).toBe('-€5.00');
  });
});
