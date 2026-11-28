import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pool } from '../src/db/client.js';
import {
  auditLogs,
  billingDeliveries,
  creditNotes,
  emailOutbox,
  invoicePayments,
  invoices,
  notifications,
  platformSettings,
  subscriptionEvents,
  subscriptions,
} from '../src/db/schema.js';
import {
  issueInvoice,
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

/*
 * Round 2, B2: payments with amounts and their reversal, credit notes, voiding only a fresh
 * mistake, and the accountant's exports. Every test makes its own facilities and invoices;
 * exports are checked through the rows of this file's documents only.
 */

const DAY = 86_400_000;
const REAUTH = 'X-Reauth-Password';
/** The password as that header carries it: b64: and the base64 of its UTF-8 bytes. */
const encoded = (password: string) => `b64:${Buffer.from(password).toString('base64')}`;

let w: Awaited<ReturnType<typeof createWorld>>;
let admin: string;
let adminId: string;
let adminName: string;
let planId: string;
let settingsBefore: typeof platformSettings.$inferSelect;

const adminGet = (path: string) => api().get(`/api/v1/admin${path}`).set(bearer(admin));
const adminPost = (path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/admin${path}`).set(bearer(admin)).send(body);
/** The same, with the password confirmed again (requireRecentAuth). */
const adminPostSure = (path: string, body: Record<string, unknown> = {}) =>
  adminPost(path, body).set(REAUTH, encoded(PASSWORD));
const pay = (invoiceId: string, body: Record<string, unknown> = {}) =>
  adminPost(`/invoices/${invoiceId}/payments`, { method: 'BANK_TRANSFER', ...body });
const reverse = (paymentId: string, reason = 'The bank returned the transfer') =>
  adminPostSure(`/payments/${paymentId}/reverse`, { reason });
const credit = (invoiceId: string, amountCents: number, reason = 'Price agreed after issue') =>
  adminPostSure(`/invoices/${invoiceId}/credit-notes`, { amountCents, reason });
const voidInvoice = (invoiceId: string, reason = 'Issued with the wrong price') =>
  adminPostSure(`/invoices/${invoiceId}/void`, { reason });
const account = async (invoiceId: string) =>
  (await adminGet(`/invoices/${invoiceId}/account`)).body;
const invoiceRow = async (id: string) =>
  (await db.select().from(invoices).where(eq(invoices.id, id)))[0]!;
const subOf = async (facilityId: string) =>
  (await db.select().from(subscriptions).where(eq(subscriptions.facilityId, facilityId)))[0]!;
const paymentsOf = (invoiceId: string) =>
  db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoiceId))
    .orderBy(asc(invoicePayments.createdAt));
const auditOf = (action: string, resourceId: string) =>
  db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.resourceId, resourceId)))
    .orderBy(asc(auditLogs.occurredAt));
const titlesOf = async (userId: string) =>
  (await db.select().from(notifications).where(eq(notifications.userId, userId))).map(
    (n) => n.title,
  );
/** How often an invoice was e-mailed to an address as an overdue reminder. */
const reminderDeliveries = async (invoiceId: string, recipient: string) =>
  (
    await db
      .select()
      .from(billingDeliveries)
      .where(
        and(
          eq(billingDeliveries.invoiceId, invoiceId),
          eq(billingDeliveries.kind, 'REMINDER'),
          eq(billingDeliveries.recipient, recipient),
        ),
      )
  ).length;

/** A facility with a director and an active subscription whose first invoice is 118,00 €. */
async function customer(facility?: { id: string }) {
  const f = facility ?? (await createFacility());
  const director = await createUser('DIRECTOR', f.id);
  const res = await adminPost(`/organizations/${f.id}/subscription`, {
    planId,
    billingCycle: 'MONTHLY',
    trial: false,
  });
  expect(res.status).toBe(201);
  const [invoice] = await db.select().from(invoices).where(eq(invoices.facilityId, f.id));
  return { facility: f, director, invoice: invoice!, subscription: await subOf(f.id) };
}

/** Another invoice of the subscription, as issued `daysAgo` days ago (overdue after 14 days). */
async function earlierInvoice(subscriptionId: string, daysAgo: number) {
  const [s] = await db.select().from(subscriptions).where(eq(subscriptions.id, subscriptionId));
  const at = new Date(Date.now() - daysAgo * DAY);
  return db.transaction((tx) =>
    issueInvoice(
      tx,
      s!,
      { start: at, end: new Date(at.getTime() + 30 * DAY) },
      { actor: null, now: at },
    ),
  );
}

beforeAll(async () => {
  w = await createWorld();
  const a = await createUser('ADMIN');
  adminId = a.id;
  adminName = a.fullName;
  admin = await login(a.email);
  settingsBefore = (await db.select().from(platformSettings).where(eq(platformSettings.id, 1)))[0]!;
  // Complete billing settings: 18 % VAT, 14 days to pay, 30 days of grace.
  await db
    .update(platformSettings)
    .set({
      operatorName: 'Operator B2 SH.P.K.',
      operatorAddress: 'Rr. Test 2, Prishtinë',
      operatorFiscalNumber: '811111111',
      operatorVatNumber: '330111111',
      operatorIban: 'XK051212012345678906',
      operatorBank: 'Test Bank',
      invoicePrefix: 'BC2',
      vatRateBp: 1800,
      paymentTermsDays: 14,
      trialDays: 30,
      graceDays: 30,
    })
    .where(eq(platformSettings.id, 1));
  const plan = await adminPost('/plans', {
    code: 'B2-CLINIC',
    name: 'B2 Clinic',
    monthlyPriceCents: 10_000,
    yearlyPriceCents: 100_000,
  });
  expect(plan.status).toBe(201);
  planId = plan.body.id;
});

afterAll(async () => {
  const { id: _id, ...rest } = settingsBefore;
  await db.update(platformSettings).set(rest).where(eq(platformSettings.id, 1));
});

describe('access', () => {
  it('is for the administrator; a director sees the own facility only', async () => {
    const { invoice } = await customer(w.otherFacility);
    const paymentId = crypto.randomUUID();
    for (const token of [w.tokens.otherDirector, w.tokens.ministry, w.tokens.doctor]) {
      const as = (r: ReturnType<ReturnType<typeof api>['get']>) => r.set(bearer(token));
      expect((await as(api().get(`/api/v1/admin/invoices/${invoice.id}/account`))).status).toBe(
        403,
      );
      expect((await as(api().get('/api/v1/admin/credit-notes'))).status).toBe(403);
      expect(
        (await as(api().get('/api/v1/admin/exports/invoices.csv?from=2026-01-01&to=2026-01-31')))
          .status,
      ).toBe(403);
      expect(
        (
          await api()
            .post(`/api/v1/admin/payments/${paymentId}/reverse`)
            .set(bearer(token))
            .set(REAUTH, encoded(PASSWORD))
            .send({ reason: 'Not mine to reverse' })
        ).status,
      ).toBe(403);
      expect(
        (
          await api()
            .post(`/api/v1/admin/invoices/${invoice.id}/credit-notes`)
            .set(bearer(token))
            .set(REAUTH, encoded(PASSWORD))
            .send({ amountCents: 100, reason: 'Not mine to credit' })
        ).status,
      ).toBe(403);
    }
    expect(
      (await api().get('/api/v1/subscription/credit-notes').set(bearer(w.tokens.doctor))).status,
    ).toBe(403);

    expect((await pay(invoice.id, { amountCents: 1_000 })).status).toBe(200);
    const mine = await api()
      .get(`/api/v1/subscription/invoices/${invoice.id}/account`)
      .set(bearer(w.tokens.otherDirector));
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({ paidCents: 1_000, balanceCents: 10_800 });
    // What the operator did, but not who; nothing about voiding.
    expect(mine.body.payments[0]).not.toHaveProperty('recordedBy');
    expect(mine.body).not.toHaveProperty('voidBlock');
    const theirs = await api()
      .get(`/api/v1/subscription/invoices/${invoice.id}/account`)
      .set(bearer(w.tokens.director));
    expect(theirs.status).toBe(404);
    const operator = await account(invoice.id);
    expect(operator.payments[0].recordedBy).toBe(adminName);
  });

  it('gives the directors their invoices without anything only the operator needs', async () => {
    const { director, invoice } = await customer();
    await pay(invoice.id, { amountCents: 1_000 });
    const token = await login(director.email);
    const mine = await api().get('/api/v1/subscription').set(bearer(token));
    expect(mine.status).toBe(200);
    const [shown] = mine.body.invoices;
    expect(shown.account).toMatchObject({ paidCents: 1_000, balanceCents: 10_800 });
    // Neither whether it may still be voided nor how far its e-mailing has got.
    expect(shown.account).not.toHaveProperty('voidBlock');
    expect(shown).not.toHaveProperty('sentAt');
    expect(shown).not.toHaveProperty('sending');
    const one = await api().get(`/api/v1/subscription/invoices/${invoice.id}`).set(bearer(token));
    expect(one.status).toBe(200);
    expect(one.body).not.toHaveProperty('sending');
    // The administrator's views keep them.
    expect((await adminGet(`/invoices/${invoice.id}`)).body.account).toHaveProperty('voidBlock');
  });
});

describe('payments with amounts', () => {
  it('records part of an invoice, keeps it open with a balance, and settles it with the rest', async () => {
    const { facility, invoice } = await customer();
    expect(invoice.totalCents).toBe(11_800);
    const part = await pay(invoice.id, { amountCents: 4_000, reference: 'BANK-1' });
    expect(part.status).toBe(200);
    expect(part.body).toMatchObject({
      status: 'OPEN',
      paidAt: null,
      account: { paidCents: 4_000, balanceCents: 7_800, toRefundCents: 0 },
    });
    const list = await adminGet(`/invoices?facilityId=${facility.id}`);
    expect(list.body.totals).toMatchObject({ openCents: 7_800, openCount: 1 });
    expect(list.body.items[0].account.balanceCents).toBe(7_800);

    // Without an amount: everything still owed.
    const paidAt = new Date(Date.now() - 2 * DAY).toISOString();
    const rest = await pay(invoice.id, { method: 'CASH', reference: 'RCPT-2', paidAt });
    expect(rest.body).toMatchObject({
      status: 'PAID',
      paymentMethod: 'CASH',
      paymentReference: 'RCPT-2',
      paidAt,
      account: { paidCents: 11_800, balanceCents: 0 },
    });
    expect((await pay(invoice.id)).status).toBe(409);
    expect((await paymentsOf(invoice.id)).map((p) => p.amountCents)).toEqual([4_000, 7_800]);

    const audited = await auditOf('billing.payment_recorded', invoice.id);
    expect(audited.map((a) => a.metadata)).toMatchObject([
      { amountCents: 4_000, settled: false, method: 'BANK_TRANSFER' },
      { amountCents: 7_800, settled: true, method: 'CASH' },
    ]);
    expect(audited.every((a) => a.actorUserId === adminId)).toBe(true);
    const events = await db
      .select({ data: subscriptionEvents.data })
      .from(subscriptionEvents)
      .where(
        and(
          eq(subscriptionEvents.facilityId, facility.id),
          eq(subscriptionEvents.type, 'PAYMENT_RECORDED'),
        ),
      )
      .orderBy(asc(subscriptionEvents.createdAt));
    expect(events.map((e) => e.data)).toMatchObject([
      { amountCents: 4_000, balanceCents: 7_800, settled: false },
      { amountCents: 7_800, balanceCents: 0, settled: true },
    ]);
  });

  it('refuses more than the balance and leaves nothing behind', async () => {
    const { invoice } = await customer();
    await pay(invoice.id, { amountCents: 10_000 });
    const over = await pay(invoice.id, { amountCents: 1_801 });
    expect(over.status).toBe(409);
    expect(over.body.error.message).toMatch(/more than what is still owed/);
    expect((await pay(invoice.id, { amountCents: 0 })).status).toBe(400);
    expect(await paymentsOf(invoice.id)).toHaveLength(1);
    expect(await auditOf('billing.payment_recorded', invoice.id)).toHaveLength(1);
    expect((await invoiceRow(invoice.id)).status).toBe('OPEN');
  });

  it('keeps an overdue invoice overdue until it is paid in full; then the standing is restored', async () => {
    const { facility, subscription } = await customer();
    const invoice = await earlierInvoice(subscription.id, 20);
    await runSubscriptionLifecycle(new Date(), { facilityIds: [facility.id] });
    expect((await subOf(facility.id)).status).toBe('PAST_DUE');
    const part = await pay(invoice.id, { amountCents: 5_000 });
    expect(part.body).toMatchObject({ status: 'OPEN', overdue: true });
    expect((await subOf(facility.id)).status).toBe('PAST_DUE');
    await pay(invoice.id);
    expect((await subOf(facility.id)).status).toBe('ACTIVE');
  });
});

describe('reversing a payment', () => {
  it('needs the password again and changes nothing without it', async () => {
    const { invoice } = await customer();
    await pay(invoice.id);
    const [payment] = await paymentsOf(invoice.id);
    const none = await adminPost(`/payments/${payment!.id}/reverse`, { reason: 'Bounced back' });
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('REAUTH_REQUIRED');
    const wrong = await adminPost(`/payments/${payment!.id}/reverse`, {
      reason: 'Bounced back',
    }).set(REAUTH, encoded('not-the-password'));
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.message).toBe('Password is incorrect');
    expect((await paymentsOf(invoice.id))[0]!.reversedAt).toBeNull();
    expect((await invoiceRow(invoice.id)).status).toBe('PAID');
    expect((await reverse(crypto.randomUUID())).status).toBe(404);
    expect((await adminPostSure(`/payments/${payment!.id}/reverse`, { reason: 'x' })).status).toBe(
      400,
    );
  });

  it('reopens a settled invoice and records who, when and why – once', async () => {
    const { invoice } = await customer();
    await pay(invoice.id, { reference: 'BANK-9' });
    const [payment] = await paymentsOf(invoice.id);
    const res = await reverse(payment!.id, 'Transfer returned by the bank');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'OPEN',
      paidCents: 0,
      balanceCents: 11_800,
      voidable: false,
      voidBlock: 'PAYMENTS',
    });
    expect(res.body.payments[0]).toMatchObject({
      reversalReason: 'Transfer returned by the bank',
      reversedBy: adminName,
    });
    expect(res.body.payments[0].reversedAt).toBeTruthy();
    expect(await invoiceRow(invoice.id)).toMatchObject({
      status: 'OPEN',
      paidAt: null,
      paymentMethod: null,
      paymentReference: null,
    });
    const again = await reverse(payment!.id);
    expect(again.status).toBe(409);
    const audited = await auditOf('billing.payment_reversed', invoice.id);
    expect(audited).toHaveLength(1);
    expect(audited[0]!.metadata).toEqual({
      paymentId: payment!.id,
      number: invoice.number,
      facilityId: invoice.facilityId,
      amountCents: 11_800,
      reopened: true,
    });
    // The record of the payment stays as it was.
    await expect(
      db
        .update(invoicePayments)
        .set({ reversalReason: 'rewritten' })
        .where(eq(invoicePayments.id, payment!.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(invoicePayments).where(eq(invoicePayments.id, payment!.id)),
    ).rejects.toThrow();
  });

  it('opens a paid invoice only together with a reversal (database trigger)', async () => {
    const { invoice } = await customer();
    await pay(invoice.id);
    await expect(
      db
        .update(invoices)
        .set({ status: 'OPEN', paidAt: null, paymentMethod: null, paymentReference: null })
        .where(eq(invoices.id, invoice.id)),
    ).rejects.toThrow();
    expect((await invoiceRow(invoice.id)).status).toBe('PAID');
    // Nor with a payment inserted already reversed, which never counted (migration 0029).
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(invoicePayments).values({
          invoiceId: invoice.id,
          amountCents: 1,
          paidAt: new Date(),
          method: 'OTHER',
          recordedById: adminId,
          reversedAt: new Date(),
          reversedById: adminId,
          reversalReason: 'Inserted reversed',
        });
        await tx
          .update(invoices)
          .set({ status: 'OPEN', paidAt: null, paymentMethod: null, paymentReference: null })
          .where(eq(invoices.id, invoice.id));
      }),
    ).rejects.toThrow();
    expect((await invoiceRow(invoice.id)).status).toBe('PAID');
    expect(await paymentsOf(invoice.id)).toHaveLength(1);
  });

  it('reverses part of an open invoice: it stays open with the larger balance', async () => {
    const { invoice } = await customer();
    await pay(invoice.id, { amountCents: 3_000 });
    await pay(invoice.id, { amountCents: 2_000 });
    const [first] = await paymentsOf(invoice.id);
    const res = await reverse(first!.id);
    expect(res.body).toMatchObject({ status: 'OPEN', paidCents: 2_000, balanceCents: 9_800 });
    expect((await auditOf('billing.payment_reversed', invoice.id))[0]!.metadata).toMatchObject({
      reopened: false,
    });
  });

  it('makes an active subscription with the reopened invoice overdue "payment overdue" – never suspended', async () => {
    const { facility, director, subscription } = await customer(w.facility);
    const old = await earlierInvoice(subscription.id, 60);
    await pay(old.id);
    expect((await subOf(facility.id)).status).toBe('ACTIVE');
    const [payment] = await paymentsOf(old.id);
    expect((await reverse(payment!.id)).status).toBe(200);
    const s = await subOf(facility.id);
    // Overdue for longer than the grace period, yet not suspended by the reversal itself.
    expect(s.status).toBe('PAST_DUE');
    expect(s.pastDueSince!.toISOString()).toBe(old.dueAt.toISOString());
    const marked = await db
      .select()
      .from(subscriptionEvents)
      .where(
        and(
          eq(subscriptionEvents.subscriptionId, s.id),
          eq(subscriptionEvents.type, 'MARKED_PAST_DUE'),
        ),
      );
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({
      actorId: adminId,
      fromStatus: 'ACTIVE',
      toStatus: 'PAST_DUE',
      data: { invoices: [old.number], reason: 'payment reversed' },
    });
    expect(await titlesOf(director.id)).toContain(
      'Your facility’s subscription has an overdue invoice',
    );
    // The reopened invoice is e-mailed again as an overdue reminder (once).
    expect(await reminderDeliveries(old.id, director.email)).toBe(1);
    // The worker suspends as for any overdue invoice – and the notice is not sent twice.
    const r = await runSubscriptionLifecycle(new Date(), { facilityIds: [facility.id] });
    expect(r).toMatchObject({ suspended: 1, reminders: 1 });
    expect((await subOf(facility.id)).status).toBe('SUSPENDED');
    // H74: the facility's clinicians keep working.
    const summary = await api()
      .get(`/api/v1/patients/${w.patient.id}/summary`)
      .set(bearer(w.tokens.doctor));
    expect(summary.status).toBe(200);
    expect(await login(w.users.doctor.email)).toBeTruthy();
    expect(await reminderDeliveries(old.id, director.email)).toBe(1);
  });

  it('tells the directors again and resends the invoice when a reversal reopens one they were told was overdue', async () => {
    const { facility, director, subscription } = await customer();
    const old = await earlierInvoice(subscription.id, 20);
    const notices = async () =>
      (await titlesOf(director.id)).filter(
        (t) => t === 'Your facility’s subscription has an overdue invoice',
      ).length;
    // Overdue: the worker tells the directors and e-mails the invoice as a reminder.
    await runSubscriptionLifecycle(new Date(), { facilityIds: [facility.id] });
    expect((await subOf(facility.id)).status).toBe('PAST_DUE');
    expect(await notices()).toBe(1);
    expect(await reminderDeliveries(old.id, director.email)).toBe(1);
    // Paid late, then the bank returns the transfer: past due again, in the same period.
    await pay(old.id);
    expect((await subOf(facility.id)).status).toBe('ACTIVE');
    const [payment] = await paymentsOf(old.id);
    expect((await reverse(payment!.id)).status).toBe(200);
    const s = await subOf(facility.id);
    expect(s.status).toBe('PAST_DUE');
    expect(s.pastDueSince!.toISOString()).toBe(old.dueAt.toISOString());
    expect(await notices()).toBe(2);
    expect(await reminderDeliveries(old.id, director.email)).toBe(2);
    // The worker repeats neither.
    expect(
      (await runSubscriptionLifecycle(new Date(), { facilityIds: [facility.id] })).reminders,
    ).toBe(0);
    expect(await notices()).toBe(2);
    expect(await reminderDeliveries(old.id, director.email)).toBe(2);
  });

  it('keeps an invoice still settled by a credit note paid, described by the credit note', async () => {
    const { invoice } = await customer();
    await pay(invoice.id);
    const note = await credit(invoice.id, 11_800, 'Service not delivered this month');
    expect(note.status).toBe(201);
    expect((await account(invoice.id)).toRefundCents).toBe(11_800);
    const [payment] = await paymentsOf(invoice.id);
    const res = await reverse(payment!.id, 'Refunded by the bank directly');
    expect(res.body).toMatchObject({ status: 'PAID', balanceCents: 0, toRefundCents: 0 });
    expect(await invoiceRow(invoice.id)).toMatchObject({
      status: 'PAID',
      paymentMethod: 'CREDIT_NOTE',
      paymentReference: note.body.number,
    });
  });
});

describe('credit notes', () => {
  it('needs the password again and refuses more than is left to credit', async () => {
    const { invoice } = await customer();
    const none = await adminPost(`/invoices/${invoice.id}/credit-notes`, {
      amountCents: 1_000,
      reason: 'Discount agreed',
    });
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('REAUTH_REQUIRED');
    expect((await credit(invoice.id, 11_801)).status).toBe(409);
    expect((await credit(invoice.id, 0)).status).toBe(400);
    expect((await credit(invoice.id, 100, 'x')).status).toBe(400);
    expect(
      await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, invoice.id)),
    ).toEqual([]);
    expect((await credit(crypto.randomUUID(), 100)).status).toBe(404);
  });

  it('numbers them without gaps, copies the invoice’s parties and splits the VAT at its rate', async () => {
    const { facility, invoice } = await customer();
    // Today's settings never reach an issued document.
    await db
      .update(platformSettings)
      .set({ operatorName: 'Renamed Operator', vatRateBp: 800 })
      .where(eq(platformSettings.id, 1));
    try {
      const first = await credit(invoice.id, 5_000);
      expect(first.status).toBe(201);
      const year = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Belgrade',
        year: 'numeric',
      }).format(new Date());
      expect(first.body.number).toMatch(new RegExp(`^BC2-CN-${year}-\\d{5}$`));
      expect(first.body).toMatchObject({
        invoiceId: invoice.id,
        vatRateBp: 1800,
        netCents: 4_237,
        taxCents: 763,
        totalCents: 5_000,
        issuer: { name: 'Operator B2 SH.P.K.' },
        customer: invoice.customer,
        invoice: { number: invoice.number },
      });
      // The rest: exactly what is left of the invoice's net and VAT.
      const second = await credit(invoice.id, 6_800);
      expect(second.body).toMatchObject({ netCents: 5_763, taxCents: 1_037 });
      const seq = (n: string) => Number(n.split('-').pop());
      expect(seq(second.body.number)).toBe(seq(first.body.number) + 1);
      expect((await credit(invoice.id, 1)).status).toBe(409);
      // Credited in full: settled by the credit note that completed it.
      expect(await invoiceRow(invoice.id)).toMatchObject({
        status: 'PAID',
        paymentMethod: 'CREDIT_NOTE',
        paymentReference: second.body.number,
      });
      const listed = await adminGet(`/credit-notes?facilityId=${facility.id}`);
      expect(listed.body.items.map((c: { number: string }) => c.number)).toEqual([
        second.body.number,
        first.body.number,
      ]);
      expect(listed.body.items[0]).toMatchObject({ invoiceNumber: invoice.number });
      const audited = await auditOf('billing.credit_note_issued', first.body.id);
      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({ resourceType: 'credit_note', actorUserId: adminId });
      expect(audited[0]!.metadata).toMatchObject({ totalCents: 5_000, settled: false });
      // The history shows it as a credit note, not as another invoice of the period.
      const detail = await adminGet(`/organizations/${facility.id}`);
      const issued = detail.body.events.filter(
        (e: { type: string; data: { creditNote?: boolean } }) =>
          e.type === 'INVOICE_ISSUED' && e.data.creditNote,
      );
      expect(issued).toHaveLength(2);
      expect(detail.body.invoices[0].line).toMatchObject({ planName: 'B2 Clinic' });
    } finally {
      await db
        .update(platformSettings)
        .set({ operatorName: 'Operator B2 SH.P.K.', vatRateBp: 1800 })
        .where(eq(platformSettings.id, 1));
    }
  });

  it('cannot be changed or deleted', async () => {
    const { invoice } = await customer();
    const note = await credit(invoice.id, 1_000);
    await expect(
      db.update(creditNotes).set({ reason: 'rewritten' }).where(eq(creditNotes.id, note.body.id)),
    ).rejects.toThrow();
    await expect(db.delete(creditNotes).where(eq(creditNotes.id, note.body.id))).rejects.toThrow();
  });

  it('settles an open invoice it brings to 0 and lifts "payment overdue"', async () => {
    const { facility, subscription } = await customer();
    const invoice = await earlierInvoice(subscription.id, 20);
    await runSubscriptionLifecycle(new Date(), { facilityIds: [facility.id] });
    expect((await subOf(facility.id)).status).toBe('PAST_DUE');
    await pay(invoice.id, { amountCents: 5_000 });
    const note = await credit(invoice.id, 6_800, 'Two weeks without service');
    expect(note.status).toBe(201);
    expect(await invoiceRow(invoice.id)).toMatchObject({
      status: 'PAID',
      paymentMethod: 'CREDIT_NOTE',
      paymentReference: note.body.number,
    });
    expect(await account(invoice.id)).toMatchObject({ balanceCents: 0, toRefundCents: 0 });
    const s = await subOf(facility.id);
    expect(s.status).toBe('ACTIVE');
    const [reactivated] = await db
      .select()
      .from(subscriptionEvents)
      .where(
        and(
          eq(subscriptionEvents.subscriptionId, s.id),
          eq(subscriptionEvents.type, 'REACTIVATED'),
        ),
      );
    expect(reactivated!.data).toMatchObject({ reason: 'credited' });
  });

  it('leaves a paid invoice paid with the amount to refund', async () => {
    const { invoice } = await customer();
    await pay(invoice.id, { reference: 'BANK-7' });
    const before = await invoiceRow(invoice.id);
    const note = await credit(invoice.id, 3_000);
    expect(note.status).toBe(201);
    const after = await invoiceRow(invoice.id);
    expect(after).toMatchObject({
      status: 'PAID',
      paymentMethod: 'BANK_TRANSFER',
      paymentReference: 'BANK-7',
    });
    expect(after.paidAt!.toISOString()).toBe(before.paidAt!.toISOString());
    expect(await account(invoice.id)).toMatchObject({
      paidCents: 11_800,
      creditedCents: 3_000,
      toRefundCents: 3_000,
      creditableCents: 8_800,
    });
    // Paid in part and credited beyond the rest: settled, with the excess to refund.
    const other = await customer();
    await pay(other.invoice.id, { amountCents: 10_000 });
    await credit(other.invoice.id, 3_000);
    expect(await account(other.invoice.id)).toMatchObject({
      status: 'PAID',
      balanceCents: 0,
      toRefundCents: 1_200,
    });
  });

  it('numbers credit notes issued at the same time without gaps or duplicates', async () => {
    const all = await Promise.all([customer(), customer(), customer()]);
    const issued = await Promise.all(all.map(({ invoice }) => credit(invoice.id, 500)));
    expect(issued.map((r) => r.status)).toEqual([201, 201, 201]);
    const seqs = issued
      .map((r) => Number(String(r.body.number).split('-').pop()))
      .sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(3);
    expect(seqs[2]! - seqs[0]!).toBe(2);
  });

  it('is refused for a voided invoice', async () => {
    const { invoice } = await customer();
    expect((await voidInvoice(invoice.id)).status).toBe(200);
    const refused = await credit(invoice.id, 1_000);
    expect(refused.status).toBe(409);
  });

  it('tells the directors and is shown to their facility only', async () => {
    const { facility, director, invoice } = await customer();
    const note = await credit(invoice.id, 1_180);
    expect(await titlesOf(director.id)).toContain(
      `Your facility’s subscription: credit note ${note.body.number} was issued`,
    );
    const token = await login(director.email);
    const mine = await api().get('/api/v1/subscription/credit-notes').set(bearer(token));
    expect(mine.body.items.map((c: { id: string }) => c.id)).toEqual([note.body.id]);
    const one = await api()
      .get(`/api/v1/subscription/credit-notes/${note.body.id}`)
      .set(bearer(token));
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ number: note.body.number, facilityId: facility.id });
    const theirs = await api()
      .get(`/api/v1/subscription/credit-notes/${note.body.id}`)
      .set(bearer(w.tokens.otherDirector));
    expect(theirs.status).toBe(404);
    const theirList = await api()
      .get('/api/v1/subscription/credit-notes')
      .set(bearer(w.tokens.otherDirector));
    expect(theirList.body.items.some((c: { id: string }) => c.id === note.body.id)).toBe(false);
  });
});

describe('voiding', () => {
  it('needs the password again; a fresh mistake can be voided', async () => {
    const { invoice } = await customer();
    expect((await account(invoice.id)).voidable).toBe(true);
    const none = await adminPost(`/invoices/${invoice.id}/void`, { reason: 'Wrong price' });
    expect(none.status).toBe(401);
    expect((await invoiceRow(invoice.id)).status).toBe('OPEN');
    const done = await voidInvoice(invoice.id);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'VOID', account: { balanceCents: 0 } });
  });

  it('is refused once anything happened to the invoice: issue a credit note instead', async () => {
    // A payment, even one reversed since.
    const paid = await customer();
    await pay(paid.invoice.id, { amountCents: 100 });
    await reverse((await paymentsOf(paid.invoice.id))[0]!.id);
    const withPayment = await voidInvoice(paid.invoice.id);
    expect(withPayment.status).toBe(409);
    expect(withPayment.body.error.message).toMatch(/payments cannot be voided.*credit note/);

    const credited = await customer();
    await credit(credited.invoice.id, 100);
    expect((await voidInvoice(credited.invoice.id)).body.error.message).toMatch(
      /credit notes cannot be voided/,
    );

    // Issued in an earlier month in Kosovo.
    const old = await customer();
    const earlier = await earlierInvoice(old.subscription.id, 40);
    expect((await account(earlier.id)).voidBlock).toBe('NOT_THIS_MONTH');
    expect((await voidInvoice(earlier.id)).body.error.message).toMatch(/issued this month/);

    // E-mailed to the customer: a delivery whose message went out.
    const sent = await customer();
    const queue = async (invoiceId: string, status: 'PENDING' | 'SENT') => {
      const [message] = await db
        .insert(emailOutbox)
        .values({
          toEmail: 'billing@example.test',
          template: 'billing_document',
          status,
          attachmentKind: 'invoice',
          attachmentId: invoiceId,
          ...(status === 'SENT' ? { sentAt: new Date() } : {}),
        })
        .returning();
      await db.insert(billingDeliveries).values({
        invoiceId,
        kind: 'ISSUED',
        recipient: 'billing@example.test',
        emailOutboxId: message!.id,
      });
    };
    await queue(sent.invoice.id, 'SENT');
    expect((await account(sent.invoice.id)).voidBlock).toBe('EMAILED');
    expect((await voidInvoice(sent.invoice.id)).body.error.message).toMatch(/already e-mailed/);
    // Still waiting to be sent: not e-mailed yet – and withdrawn by the void, never sent.
    const pending = await customer();
    await queue(pending.invoice.id, 'PENDING');
    expect((await voidInvoice(pending.invoice.id)).status).toBe(200);
    const waiting = await db
      .select({ status: emailOutbox.status, lastError: emailOutbox.lastError })
      .from(emailOutbox)
      .innerJoin(billingDeliveries, eq(billingDeliveries.emailOutboxId, emailOutbox.id))
      .where(eq(billingDeliveries.invoiceId, pending.invoice.id));
    // The one queued above and the one to the director on issue.
    expect(waiting).toEqual([
      { status: 'CANCELLED', lastError: 'Not sent: the invoice was voided' },
      { status: 'CANCELLED', lastError: 'Not sent: the invoice was voided' },
    ]);

    for (const c of [paid, credited, sent]) {
      expect((await invoiceRow(c.invoice.id)).status).toBe('OPEN');
    }
  });
});

describe('money received while billing is not ready', () => {
  it('is recorded and lifts the suspension; the worker starts and invoices the new period later', async () => {
    const { facility, director, subscription } = await customer();
    const old = await earlierInvoice(subscription.id, 60);
    // Suspended for non-payment, its period over.
    const periodStart = new Date(Date.now() - 31 * DAY);
    await db
      .update(subscriptions)
      .set({
        status: 'SUSPENDED',
        suspensionCause: 'NON_PAYMENT',
        suspendedAt: new Date(Date.now() - 2 * DAY),
        pastDueSince: old.dueAt,
        currentPeriodStart: periodStart,
        currentPeriodEnd: new Date(Date.now() - DAY),
        billingAnchor: periodStart,
      })
      .where(eq(subscriptions.id, subscription.id));
    const count = async () =>
      (await db.select().from(invoices).where(eq(invoices.facilityId, facility.id))).length;
    const before = await count();
    await db.update(platformSettings).set({ operatorIban: null }).where(eq(platformSettings.id, 1));
    let lifted: Date;
    try {
      const res = await pay(old.id);
      expect(res.status).toBe(200);
      expect(await paymentsOf(old.id)).toHaveLength(1);
      const s = await subOf(facility.id);
      expect(s).toMatchObject({ status: 'ACTIVE', suspendedAt: null, suspensionCause: null });
      // The ended period is closed now; nothing is invoiced yet.
      lifted = s.currentPeriodEnd;
      expect(Math.abs(lifted.getTime() - Date.now())).toBeLessThan(60_000);
      expect(s.billingAnchor!.toISOString()).toBe(lifted.toISOString());
      expect(await count()).toBe(before);
      expect(await titlesOf(director.id)).toContain('Your facility’s subscription is active again');
      // The worker waits for the settings.
      const waiting = await runSubscriptionLifecycle(new Date(), { facilityIds: [facility.id] });
      expect(waiting).toMatchObject({ renewed: 0, waiting: 1 });
    } finally {
      await db
        .update(platformSettings)
        .set({ operatorIban: 'XK051212012345678906' })
        .where(eq(platformSettings.id, 1));
    }
    // Once billing is ready the new period starts where the suspension was lifted, invoiced.
    const ready = await runSubscriptionLifecycle(new Date(), { facilityIds: [facility.id] });
    expect(ready).toMatchObject({ renewed: 1, waiting: 0 });
    expect(await count()).toBe(before + 1);
    const s = await subOf(facility.id);
    expect(s.currentPeriodStart.toISOString()).toBe(lifted!.toISOString());
    const [newest] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.facilityId, facility.id))
      .orderBy(desc(invoices.issuedAt))
      .limit(1);
    expect(newest!.periodStart.toISOString()).toBe(lifted!.toISOString());
  });
});

describe('changes of the same invoice at once', () => {
  it('record only one of two payments that together are more than what is owed', async () => {
    const { invoice } = await customer();
    const results = await Promise.all([
      pay(invoice.id, { amountCents: 8_000 }),
      pay(invoice.id, { amountCents: 8_000 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await paymentsOf(invoice.id)).map((p) => p.amountCents)).toEqual([8_000]);
    expect(await account(invoice.id)).toMatchObject({ paidCents: 8_000, balanceCents: 3_800 });
  });

  it('end a payment and a reversal at once with the same figures, whichever goes first', async () => {
    const { invoice } = await customer();
    await pay(invoice.id, { amountCents: 5_000 });
    const [first] = await paymentsOf(invoice.id);
    const [reversed, paid] = await Promise.all([
      reverse(first!.id),
      pay(invoice.id, { amountCents: 6_800 }),
    ]);
    expect([reversed.status, paid.status]).toEqual([200, 200]);
    expect(await account(invoice.id)).toMatchObject({
      status: 'OPEN',
      paidCents: 6_800,
      balanceCents: 5_000,
    });
    expect(await invoiceRow(invoice.id)).toMatchObject({ status: 'OPEN', paidAt: null });
  });

  it('wait for the subscription worker sending an overdue reminder instead of deadlocking', async () => {
    const { facility, director, subscription } = await customer();
    const old = await earlierInvoice(subscription.id, 20);
    /** The backend that waits for a lock `pid` holds. */
    const waitingFor = async (pid: number) => {
      for (let i = 0; i < 400; i++) {
        const r = await db.execute<{ pid: number }>(
          sql`SELECT pid FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`,
        );
        if (r.rows[0]) return Number(r.rows[0].pid);
        await new Promise((done) => setTimeout(done, 25));
      }
      throw new Error(`Nothing waited for backend ${pid}`);
    };
    // Holding the director's account row stops the worker at its notice, with the subscription
    // (and the invoices) locked and the reminder's insert still to come.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [director.id]);
      const holderPid = Number((await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      const worker = runSubscriptionLifecycle(new Date(), { facilityIds: [facility.id] });
      const workerPid = await waitingFor(holderPid);
      // The payment of the overdue invoice comes in meanwhile and waits for the worker.
      const payment = pay(old.id).then((r) => r);
      await waitingFor(workerPid);
      await holder.query('ROLLBACK');
      const [run, paid] = await Promise.all([worker, payment]);
      expect(run).toMatchObject({ pastDue: 1, reminders: 1 });
      expect(paid.status).toBe(200);
      expect(await reminderDeliveries(old.id, director.email)).toBe(1);
      expect((await invoiceRow(old.id)).status).toBe('PAID');
      expect((await subOf(facility.id)).status).toBe('ACTIVE');
    } finally {
      holder.release();
    }
  });
});

describe('refunds', () => {
  it('records a refund of what is to refund, with the password, and shows it to the facility', async () => {
    const { director, invoice, subscription } = await customer();
    await pay(invoice.id);
    await credit(invoice.id, 3_000);
    expect(await account(invoice.id)).toMatchObject({ toRefundCents: 3_000, refundedCents: 0 });
    const path = `/invoices/${invoice.id}/refunds`;
    const none = await adminPost(path, { amountCents: 1_000 });
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('REAUTH_REQUIRED');
    expect((await adminPostSure(path, { amountCents: 3_001 })).status).toBe(409);
    const future = new Date(Date.now() + 3 * DAY).toISOString();
    expect((await adminPostSure(path, { amountCents: 1_000, refundedAt: future })).status).toBe(
      400,
    );
    const part = await adminPostSure(path, { amountCents: 1_000, reference: 'REFUND-1' });
    expect(part.status).toBe(200);
    expect(part.body).toMatchObject({ refundedCents: 1_000, toRefundCents: 2_000 });
    expect(part.body.refunds).toEqual([
      expect.objectContaining({ amountCents: 1_000, reference: 'REFUND-1', recordedBy: adminName }),
    ]);
    // Without an amount: everything still to refund.
    const rest = await adminPostSure(path, {});
    expect(rest.body).toMatchObject({ refundedCents: 3_000, toRefundCents: 0 });
    expect((await adminPostSure(path, { amountCents: 1 })).status).toBe(409);
    // The invoice and its payments do not change.
    expect(await invoiceRow(invoice.id)).toMatchObject({ status: 'PAID' });
    expect(await paymentsOf(invoice.id)).toHaveLength(1);
    // Audited with the change, and noted in the history.
    const audited = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'billing.subscription.changed'),
          eq(auditLogs.resourceId, subscription.id),
          sql`${auditLogs.metadata}->>'event' = 'REFUND_RECORDED'`,
        ),
      );
    expect(audited.map((a) => a.metadata)).toMatchObject([
      { refundCents: 1_000, invoiceId: invoice.id },
      { refundCents: 2_000, invoiceId: invoice.id },
    ]);
    // The facility sees when it was refunded, not who recorded it; never the internal note.
    const token = await login(director.email);
    const mine = await api()
      .get(`/api/v1/subscription/invoices/${invoice.id}/account`)
      .set(bearer(token));
    expect(mine.body).toMatchObject({ refundedCents: 3_000, toRefundCents: 0 });
    expect(mine.body.refunds).toHaveLength(2);
    expect(mine.body.refunds[0]).not.toHaveProperty('recordedBy');
    expect(mine.body.refunds[0].refundedAt).toBeTruthy();
    const sub = await api().get('/api/v1/subscription').set(bearer(token));
    const listed = sub.body.invoices.find((i: { id: string }) => i.id === invoice.id);
    expect(listed.account).toMatchObject({ refundedCents: 3_000, toRefundCents: 0 });
    expect(sub.body.events.some((e: { type: string }) => e.type === 'NOTE')).toBe(false);
    // Only the administrator records one.
    expect(
      (
        await api()
          .post(`/api/v1/admin${path}`)
          .set(bearer(token))
          .set(REAUTH, PASSWORD)
          .send({ amountCents: 1 })
      ).status,
    ).toBe(403);
  });

  it('is refused when nothing is to be refunded', async () => {
    const { invoice } = await customer();
    expect((await adminPostSure(`/invoices/${invoice.id}/refunds`, {})).status).toBe(409);
    await pay(invoice.id);
    expect((await adminPostSure(`/invoices/${invoice.id}/refunds`, {})).status).toBe(409);
  });
});

/* ------------------------------------------------------------------ exports ------------------ */

/** Cells of a CSV in which every cell is quoted. */
function parseCsv(text: string) {
  return text
    .replace(/^\uFEFF/, '')
    .split('\r\n')
    .filter(Boolean)
    .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"')));
}
const kosovoDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
/** Yesterday to tomorrow: everything this file does today, whatever the time of day. */
const PERIOD = {
  from: kosovoDay(new Date(Date.now() - DAY)),
  to: kosovoDay(new Date(Date.now() + DAY)),
};
const exportCsv = (
  name: string,
  period: { from?: string; to?: string } = PERIOD,
  reauth = true,
) => {
  const req = api()
    .get(`/api/v1/admin/exports/${name}`)
    .query(period)
    .set(bearer(admin))
    .buffer(true)
    .parse((res, cb) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => cb(null, data));
    });
  return reauth ? req.set(REAUTH, encoded(PASSWORD)) : req;
};

describe('exports for the accountant', () => {
  it('need the password again, the administrator and a period of at most a year', async () => {
    const none = await exportCsv('invoices.csv', PERIOD, false);
    expect(none.status).toBe(401);
    const director = await api()
      .get('/api/v1/admin/exports/sales-book.csv')
      .query(PERIOD)
      .set(bearer(w.tokens.director))
      .set(REAUTH, encoded(PASSWORD));
    expect(director.status).toBe(403);
    for (const period of [
      { from: '2026-02-01', to: '2026-01-31' },
      { from: '2025-01-01', to: '2026-01-01' },
      { from: '2026-02-30', to: '2026-03-01' },
      { from: '1.1.2026', to: '2026-03-01' },
      { from: '2026-01-01' },
    ]) {
      expect((await exportCsv('payments.csv', period)).status).toBe(400);
    }
    // A whole leap year is one year.
    expect(
      (await exportCsv('credit-notes.csv', { from: '2028-01-01', to: '2028-12-31' })).status,
    ).toBe(200);
  });

  it('export invoices, payments and credit notes as quoted, formula-safe CSV with a BOM', async () => {
    const f = await createFacility({ name: '=HYPERLINK("http://example.test")' });
    const { invoice } = await customer(f);
    await pay(invoice.id, { amountCents: 5_000, reference: '+38344111222' });
    const [payment] = await paymentsOf(invoice.id);
    await reverse(payment!.id, 'Wrong invoice');
    await pay(invoice.id, { amountCents: 2_000, method: 'CASH' });
    const note = await credit(invoice.id, 1_180, 'Discount for a late start');

    const res = await exportCsv('invoices.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="pacient-invoices-${PERIOD.from}-to-${PERIOD.to}.csv"`,
    );
    const text = res.body as string;
    expect(text.startsWith('\uFEFF"Invoice number","Issue date",')).toBe(true);
    const rows = parseCsv(text);
    const header = rows[0]!;
    const row = rows.find((r) => r[0] === invoice.number)!;
    const col = (name: string) => row[header.indexOf(name)];
    // A text that would run as a formula stays text.
    expect(col('Customer')).toBe(`'=HYPERLINK("http://example.test")`);
    expect(text).toContain(`"'=HYPERLINK(""http://example.test"")"`);
    expect(col('Issue date')).toBe(kosovoDay(invoice.issuedAt));
    expect(col('Net amount')).toBe('100.00');
    expect(col('VAT rate (%)')).toBe('18');
    expect(col('VAT amount')).toBe('18.00');
    expect(col('Total amount')).toBe('118.00');
    expect(col('Invoice status')).toBe('Open');
    expect(col('Paid amount')).toBe('20.00');
    expect(col('Credited amount')).toBe('11.80');
    expect(col('Balance')).toBe('86.20');

    const payments = parseCsv((await exportCsv('payments.csv')).body as string);
    // In the order things happened: the payment, its reversal (on the day reversed), the next.
    const mine = payments.filter((r) => r[2] === invoice.number);
    expect(mine.map((r) => [r[1], r[4], r[6], r[8]])).toEqual([
      ['Payment received', 'Bank transfer', '50.00', ''],
      ['Payment reversed', 'Bank transfer', '-50.00', 'Wrong invoice'],
      ['Payment received', 'Cash', '20.00', ''],
    ]);
    expect(mine[1]![0]).toBe(kosovoDay(new Date()));
    // A reference starting with "+" stays text; negative amounts stay numbers.
    expect(mine[0]![5]).toBe(`'+38344111222`);

    const notes = parseCsv((await exportCsv('credit-notes.csv')).body as string);
    const noteRow = notes.find((r) => r[0] === note.body.number)!;
    expect(noteRow.slice(2, 3)).toEqual([invoice.number]);
    expect(noteRow.slice(7)).toEqual([
      'Discount for a late start',
      '10.00',
      '18',
      '1.80',
      '11.80',
      'EUR',
    ]);

    // Audited with the export and its period only.
    const audited = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'billing.exported'), eq(auditLogs.actorUserId, adminId)));
    expect(audited.map((a) => a.metadata)).toEqual(
      expect.arrayContaining([
        { export: 'invoices', from: PERIOD.from, to: PERIOD.to },
        { export: 'payments', from: PERIOD.from, to: PERIOD.to },
        { export: 'credit-notes', from: PERIOD.from, to: PERIOD.to },
      ]),
    );
    // Business data only: nothing about patients.
    for (const t of [text, (await exportCsv('sales-book.csv')).body as string]) {
      expect(t).not.toContain(w.patient.lastName);
      expect(t).not.toContain(w.patient.nationalId);
    }
  });

  it('keep a sales book in Albanian: credit notes negative, voided invoices empty, totals per VAT rate', async () => {
    const { invoice, subscription } = await customer();
    const note = await credit(invoice.id, 5_000);
    const voided = await customer();
    await voidInvoice(voided.invoice.id);
    await db.update(platformSettings).set({ vatRateBp: 0 }).where(eq(platformSettings.id, 1));
    let untaxed: Awaited<ReturnType<typeof earlierInvoice>>;
    try {
      untaxed = await earlierInvoice(subscription.id, 0);
    } finally {
      await db.update(platformSettings).set({ vatRateBp: 1800 }).where(eq(platformSettings.id, 1));
    }

    const res = await exportCsv('sales-book.csv');
    expect(res.status).toBe(200);
    const rows = parseCsv(res.body as string);
    expect(rows[0]).toEqual([
      'Nr. rendor',
      'Data',
      'Numri i dokumentit',
      'Lloji i dokumentit',
      'Fatura e lidhur',
      'Blerësi',
      'NUI i blerësit',
      'Numri fiskal i blerësit',
      'Numri i TVSH-së i blerësit',
      'Vlera pa TVSH',
      'Norma e TVSH-së (%)',
      'TVSH',
      'Vlera me TVSH',
      'Shënim',
    ]);
    const byNumber = (n: string) => rows.find((r) => r[2] === n)!;
    expect(byNumber(invoice.number).slice(3, 4).concat(byNumber(invoice.number).slice(9))).toEqual([
      'Faturë',
      '100.00',
      '18',
      '18.00',
      '118.00',
      '',
    ]);
    expect(
      byNumber(note.body.number).slice(3, 5).concat(byNumber(note.body.number).slice(9)),
    ).toEqual(['Notë krediti', invoice.number, '-42.37', '18', '-7.63', '-50.00', '']);
    expect(byNumber(voided.invoice.number).slice(9)).toEqual([
      '0.00',
      '18',
      '0.00',
      '0.00',
      'E anuluar',
    ]);
    expect(byNumber(untaxed!.number).slice(9, 13)).toEqual(['100.00', '0', '0.00', '100.00']);

    // The documents first (numbered 1, 2, …), invoices before credit notes, each by number.
    const blank = rows.findIndex((r) => r.every((c) => c === ''));
    const documents = rows.slice(1, blank);
    expect(documents.map((r) => Number(r[0]))).toEqual(documents.map((_, i) => i + 1));
    const kinds = documents.map((r) => r[3]);
    expect(kinds.lastIndexOf('Faturë')).toBeLessThan(kinds.indexOf('Notë krediti'));
    // Totals per rate, then the grand total – adding up to the documents above.
    const cents = (s: string) => Math.round(Number(s) * 100);
    const totals = rows.slice(blank + 1);
    const grand = totals.pop()!;
    expect(grand[5]).toBe('Gjithsej');
    for (const rate of ['0', '18']) {
      const line = totals.find((r) => r[5] === `Gjithsej me normë TVSH ${rate}%`)!;
      const of = documents.filter((r) => r[10] === rate);
      for (const i of [9, 11, 12]) {
        expect(cents(line[i]!)).toBe(of.reduce((sum, r) => sum + cents(r[i]!), 0));
      }
    }
    for (const i of [9, 11, 12]) {
      expect(cents(grand[i]!)).toBe(documents.reduce((sum, r) => sum + cents(r[i]!), 0));
    }
  });

  it('date documents and payments by the calendar day in Kosovo, across midnight and the clocks', async () => {
    const { subscription } = await customer();
    // 31 March 2026, 22:30 UTC is already 1 April, 00:30 in Kosovo (summer time).
    const aprilFirst = new Date('2026-03-31T22:30:00Z');
    const invoice = await db.transaction(async (tx) =>
      issueInvoice(
        tx,
        (await tx.select().from(subscriptions).where(eq(subscriptions.id, subscription.id)))[0]!,
        { start: aprilFirst, end: new Date('2026-04-30T22:00:00Z') },
        { actor: null, now: aprilFirst },
      ),
    );
    const payments = {
      // 29 March 2026 has 23 hours: the clocks go forward from 02:00 to 03:00.
      startOf29March: '2026-03-28T23:30:00Z', // 29 March, 00:30 (winter time)
      endOf29March: '2026-03-29T21:30:00Z', // 29 March, 23:30 (summer time)
      startOf30March: '2026-03-29T22:30:00Z', // 30 March, 00:30
      aprilFirst: aprilFirst.toISOString(), // 1 April, 00:30
      // 25 October 2026 has 25 hours: the clocks go back from 03:00 to 02:00.
      startOf25October: '2026-10-24T22:30:00Z', // 25 October, 00:30 (summer time)
      endOf25October: '2026-10-25T22:30:00Z', // 25 October, 23:30 (winter time)
      startOf26October: '2026-10-25T23:30:00Z', // 26 October, 00:30
    };
    for (const [reference, paidAt] of Object.entries(payments)) {
      expect((await pay(invoice.id, { amountCents: 100, paidAt, reference })).status).toBe(200);
    }
    const paid = async (from: string, to: string) =>
      parseCsv((await exportCsv('payments.csv', { from, to })).body as string)
        .filter((r) => r[2] === invoice.number)
        .map((r) => [r[0], r[5]]);
    expect(await paid('2026-03-29', '2026-03-29')).toEqual([
      ['2026-03-29', 'startOf29March'],
      ['2026-03-29', 'endOf29March'],
    ]);
    expect(await paid('2026-03-30', '2026-03-31')).toEqual([['2026-03-30', 'startOf30March']]);
    expect(await paid('2026-04-01', '2026-04-30')).toEqual([['2026-04-01', 'aprilFirst']]);
    expect(await paid('2026-10-25', '2026-10-25')).toEqual([
      ['2026-10-25', 'startOf25October'],
      ['2026-10-25', 'endOf25October'],
    ]);
    expect(await paid('2026-10-26', '2026-10-26')).toEqual([['2026-10-26', 'startOf26October']]);
    // The invoice belongs to April, as its issue date says – not to March.
    const issued = async (from: string, to: string) =>
      parseCsv((await exportCsv('invoices.csv', { from, to })).body as string)
        .filter((r) => r[0] === invoice.number)
        .map((r) => r[1]);
    expect(await issued('2026-03-01', '2026-03-31')).toEqual([]);
    expect(await issued('2026-04-01', '2026-04-30')).toEqual(['2026-04-01']);
  });
});

describe('totals of the invoices page', () => {
  it('count what is still owed as open and money received this year as paid', async () => {
    const { facility, invoice } = await customer();
    await pay(invoice.id, { amountCents: 3_000 });
    await credit(invoice.id, 1_000);
    const res = await adminGet(`/invoices?facilityId=${facility.id}`);
    expect(res.body.totals).toMatchObject({ openCents: 7_800, paidThisYearCents: 3_000 });
    const [p] = await paymentsOf(invoice.id);
    await reverse(p!.id);
    const after = await adminGet(`/invoices?facilityId=${facility.id}`);
    expect(after.body.totals).toMatchObject({ openCents: 10_800, paidThisYearCents: 0 });
    // The administrator's overview counts what is owed the same way.
    const overview = await adminGet('/overview');
    const all = await adminGet('/invoices');
    expect(overview.body.revenue.openCents).toBe(all.body.totals.openCents);
    expect(overview.body.revenue.overdueCents).toBe(all.body.totals.overdueCents);
  });
});
