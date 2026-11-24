import { and, asc, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  invoices,
  notifications,
  platformSettings,
  subscriptionEvents,
  subscriptions,
  users,
} from '../src/db/schema.js';
import {
  addCycle,
  invoiceDescription,
  issueInvoice,
  localInstant,
  restoreStanding,
  runSubscriptionLifecycle,
  yearStartOf,
} from '../src/modules/subscriptions/subscriptions.service.js';
import { api, bearer, createFacility, createUser, createWorld, login } from './helpers.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

let w: Awaited<ReturnType<typeof createWorld>>;
let admin: string;
let adminId: string;
let clinic: { id: string; monthlyPriceCents: number; yearlyPriceCents: number };
let hospital: { id: string; monthlyPriceCents: number };
let small: { id: string };

const adminGet = (path: string) => api().get(`/api/v1/admin${path}`).set(bearer(admin));
const adminPost = (path: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/v1/admin${path}`).set(bearer(admin)).send(body);

async function subscribe(facilityId: string, body: Record<string, unknown> = {}) {
  const res = await adminPost(`/organizations/${facilityId}/subscription`, {
    planId: clinic.id,
    billingCycle: 'MONTHLY',
    trial: true,
    ...body,
  });
  expect(res.status).toBe(201);
  return res.body;
}
const subOf = async (facilityId: string) =>
  (await db.select().from(subscriptions).where(eq(subscriptions.facilityId, facilityId)))[0]!;
const eventTypes = async (subscriptionId: string) =>
  (
    await db
      .select({ type: subscriptionEvents.type })
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.subscriptionId, subscriptionId))
      .orderBy(asc(subscriptionEvents.createdAt))
  ).map((e) => e.type);
const invoicesOf = (facilityId: string) =>
  db
    .select()
    .from(invoices)
    .where(eq(invoices.facilityId, facilityId))
    .orderBy(asc(invoices.issuedAt), asc(invoices.number));
const run = (now: Date, facilityId: string) =>
  runSubscriptionLifecycle(now, { facilityIds: [facilityId] });
/** A lifecycle run that changed nothing. */
const NOTHING = { activated: 0, renewed: 0, pastDue: 0, suspended: 0, cancelled: 0, reminders: 0 };
const localFormat = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Belgrade', ...opts });
/** "24/11/2026" and "23:59:59" in Kosovo. */
const localDate = (d: Date) =>
  localFormat({ day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
const localTime = (d: Date) =>
  localFormat({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(
    d,
  );

beforeAll(async () => {
  w = await createWorld();
  const a = await createUser('ADMIN');
  adminId = a.id;
  admin = await login(a.email);
  await db
    .update(platformSettings)
    .set({
      operatorName: 'Operator Test SH.P.K.',
      operatorAddress: 'Rr. Test 1, Prishtinë',
      operatorIban: 'XK051212012345678906',
      vatRateBp: 1800,
      paymentTermsDays: 14,
      trialDays: 30,
      graceDays: 30,
      invoicePrefix: 'TST',
    })
    .where(eq(platformSettings.id, 1));
  clinic = (
    await adminPost('/plans', {
      code: 'clinic',
      name: 'Clinic',
      monthlyPriceCents: 14_900,
      yearlyPriceCents: 149_000,
      seatLimit: 40,
      features: ['Up to 40 staff accounts'],
    })
  ).body;
  hospital = (
    await adminPost('/plans', {
      code: 'HOSPITAL',
      name: 'Hospital',
      monthlyPriceCents: 99_000,
      yearlyPriceCents: 990_000,
      seatLimit: null,
    })
  ).body;
  small = (
    await adminPost('/plans', {
      code: 'SMALL',
      name: 'Small',
      monthlyPriceCents: 4_900,
      yearlyPriceCents: 49_000,
      seatLimit: 2,
    })
  ).body;
});

describe('access', () => {
  it('is for the platform administrator only; directors see their own subscription', async () => {
    for (const token of [w.tokens.director, w.tokens.ministry, w.tokens.doctor, w.tokens.patient]) {
      for (const path of ['/plans', '/organizations', '/invoices']) {
        expect((await api().get(`/api/v1/admin${path}`).set(bearer(token))).status).toBe(403);
      }
    }
    expect((await api().get('/api/v1/subscription').set(bearer(w.tokens.doctor))).status).toBe(403);
    const mine = await api().get('/api/v1/subscription').set(bearer(w.tokens.director));
    expect(mine.status).toBe(200);
    expect(mine.body.subscription).toBeNull();
  });
});

describe('plans', () => {
  it('validates plans and keeps codes unique', async () => {
    expect(clinic.id).toBeTruthy();
    const bad = [
      { code: 'X1', name: 'Bad', monthlyPriceCents: -1, yearlyPriceCents: 0 },
      { code: 'X2', name: 'Bad', monthlyPriceCents: 1, yearlyPriceCents: 1, seatLimit: 0 },
      {
        code: 'X3',
        name: 'Bad',
        monthlyPriceCents: 1,
        yearlyPriceCents: 1,
        features: Array.from({ length: 11 }, (_, i) => `f${i}`),
      },
      { code: 'X4', name: 'Bad', monthlyPriceCents: 1, yearlyPriceCents: 1, currency: 'USD' },
    ];
    for (const body of bad) expect((await adminPost('/plans', body)).status).toBe(400);
    const dup = await adminPost('/plans', {
      code: 'CLINIC',
      name: 'Again',
      monthlyPriceCents: 1,
      yearlyPriceCents: 1,
    });
    expect(dup.status).toBe(409);
    const patched = await api()
      .patch(`/api/v1/admin/plans/${small.id}`)
      .set(bearer(admin))
      .send({ description: 'For small practices' });
    expect(patched.body.description).toBe('For small practices');
    // A partial update leaves the other fields alone.
    expect(patched.body).toMatchObject({ seatLimit: 2, monthlyPriceCents: 4_900, isActive: true });
    const list = await adminGet('/plans');
    expect(list.body.items.map((p: { code: string }) => p.code)).toEqual(
      expect.arrayContaining(['CLINIC', 'HOSPITAL', 'SMALL']),
    );
    const saved = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'billing.plan.saved'), eq(auditLogs.actorUserId, adminId)));
    expect(saved.length).toBeGreaterThanOrEqual(4);
  });
});

describe('starting a subscription', () => {
  it('starts a trial without an invoice, and only one subscription per facility', async () => {
    const f = await createFacility();
    const before = Date.now();
    const body = await subscribe(f.id);
    expect(body.subscription).toMatchObject({ status: 'TRIAL', billingCycle: 'MONTHLY' });
    const s = await subOf(f.id);
    const days = (s.trialEndsAt!.getTime() - before) / DAY;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(s.priceCents).toBe(14_900);
    expect(await eventTypes(s.id)).toEqual(['CREATED', 'TRIAL_STARTED']);
    expect(await invoicesOf(f.id)).toHaveLength(0);
    const again = await adminPost(`/organizations/${f.id}/subscription`, { planId: clinic.id });
    expect(again.status).toBe(409);
  });

  it('starts an active subscription with its first invoice: VAT, number, due date, snapshots', async () => {
    const f = await createFacility({ address: 'Rr. Klinika 3' });
    const director = await createUser('DIRECTOR', f.id);
    await subscribe(f.id, { trial: false, billingCycle: 'YEARLY' });
    const [inv] = await invoicesOf(f.id);
    expect(inv!.number).toMatch(/^TST-\d{4}-\d{5}$/);
    expect(inv!.netCents).toBe(149_000);
    expect(inv!.taxRateBp).toBe(1800);
    expect(inv!.taxCents).toBe(26_820);
    expect(inv!.totalCents).toBe(175_820);
    // Due at the end of the 14th day after the issue day in Kosovo.
    expect(localDate(inv!.dueAt)).toBe(localDate(new Date(inv!.issuedAt.getTime() + 14 * DAY)));
    expect(localTime(inv!.dueAt)).toBe('23:59:59');
    expect(inv!.issuer).toMatchObject({
      name: 'Operator Test SH.P.K.',
      iban: 'XK051212012345678906',
    });
    expect(inv!.customer).toMatchObject({ name: f.name, code: f.code, address: 'Rr. Klinika 3' });
    const s = await subOf(f.id);
    expect(s.status).toBe('ACTIVE');
    expect(await eventTypes(s.id)).toEqual(['CREATED', 'INVOICE_ISSUED']);
    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, director.id), eq(notifications.type, 'subscription')));
    expect(notes.map((n) => n.title).join(' ')).toContain(inv!.number);
  });
});

describe('lifecycle', () => {
  it('converts a trial, marks unpaid invoices past due, renews and suspends after the grace period', async () => {
    const f = await createFacility();
    await createUser('DIRECTOR', f.id);
    await subscribe(f.id);
    let s = await subOf(f.id);
    const trialEnd = s.trialEndsAt!;

    const r1 = await run(new Date(trialEnd.getTime() + HOUR), f.id);
    expect(r1.activated).toBe(1);
    s = await subOf(f.id);
    expect(s.status).toBe('ACTIVE');
    expect(s.currentPeriodStart.toISOString()).toBe(trialEnd.toISOString());
    let inv = await invoicesOf(f.id);
    expect(inv).toHaveLength(1);

    await run(new Date(inv[0]!.dueAt.getTime() + HOUR), f.id);
    s = await subOf(f.id);
    expect(s.status).toBe('PAST_DUE');
    expect(s.pastDueSince!.toISOString()).toBe(inv[0]!.dueAt.toISOString());

    // The period ends while past due: renewed with its invoice, still past due.
    const r3 = await run(new Date(s.currentPeriodEnd.getTime() + HOUR), f.id);
    expect(r3.renewed).toBe(1);
    s = await subOf(f.id);
    expect(s.status).toBe('PAST_DUE');
    inv = await invoicesOf(f.id);
    expect(inv).toHaveLength(2);

    await run(new Date(s.pastDueSince!.getTime() + 30 * DAY + HOUR), f.id);
    s = await subOf(f.id);
    expect(s.status).toBe('SUSPENDED');
    expect(await eventTypes(s.id)).toEqual(
      expect.arrayContaining([
        'ACTIVATED',
        'INVOICE_ISSUED',
        'MARKED_PAST_DUE',
        'RENEWED',
        'SUSPENDED',
        'REMINDER_SENT',
      ]),
    );

    // Running again at the same moment changes nothing and sends nothing.
    const again = await run(new Date(s.suspendedAt!.getTime()), f.id);
    expect(again).toMatchObject(NOTHING);
  });

  it('needs every overdue invoice paid before a suspended subscription is active again', async () => {
    const f = await createFacility();
    await subscribe(f.id, { trial: false });
    let s = await subOf(f.id);
    const now = Date.now();
    // Two invoices from earlier periods, both overdue for longer than the grace period.
    for (const daysAgo of [90, 60]) {
      await db.transaction((tx) =>
        issueInvoice(
          tx,
          s,
          {
            start: new Date(now - (daysAgo + 30) * DAY),
            end: new Date(now - daysAgo * DAY),
          },
          { actor: null, now: new Date(now - daysAgo * DAY) },
        ),
      );
    }
    const r = await run(new Date(), f.id);
    expect(r.pastDue).toBe(1);
    expect(r.suspended).toBe(1);
    s = await subOf(f.id);
    expect(s.status).toBe('SUSPENDED');

    const overdue = (await invoicesOf(f.id)).filter((i) => i.dueAt.getTime() < now);
    expect(overdue).toHaveLength(2);
    const pay = (id: string) =>
      adminPost(`/invoices/${id}/payments`, { method: 'BANK_TRANSFER', reference: 'BANK-123' });
    const first = await pay(overdue[0]!.id);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'PAID', paymentMethod: 'BANK_TRANSFER' });
    expect((await subOf(f.id)).status).toBe('SUSPENDED');
    expect((await pay(overdue[0]!.id)).status).toBe(409);
    await pay(overdue[1]!.id);
    s = await subOf(f.id);
    expect(s.status).toBe('ACTIVE');
    expect(s.pastDueSince).toBeNull();
    expect(await eventTypes(s.id)).toEqual(
      expect.arrayContaining(['PAYMENT_RECORDED', 'REACTIVATED']),
    );
  });

  it('tells the directors of the overdue invoice before a suspension in the same run', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    await subscribe(f.id, { trial: false });
    const s = await subOf(f.id);
    const [inv] = await invoicesOf(f.id);
    // The worker was down for longer than the grace period: past due and suspended in one run.
    const r = await run(new Date(inv!.dueAt.getTime() + 31 * DAY), f.id);
    expect(r).toMatchObject({ pastDue: 1, suspended: 1, reminders: 2 });
    const titles = await titlesOf(director.id);
    expect(titles).toContain('Your facility’s subscription has an overdue invoice');
    expect(titles).toContain(
      'Your facility’s subscription is suspended – new staff accounts cannot be added',
    );
    // First the overdue invoice, then the suspension.
    const order = (
      await db
        .select({ type: subscriptionEvents.type, data: subscriptionEvents.data })
        .from(subscriptionEvents)
        .where(eq(subscriptionEvents.subscriptionId, s.id))
        .orderBy(asc(subscriptionEvents.createdAt))
    )
      .filter((e) => e.type === 'REMINDER_SENT' || e.type === 'SUSPENDED')
      .map((e) =>
        e.type === 'SUSPENDED' ? e.type : String((e.data as { key: string }).key).split(':')[0],
      );
    expect(order).toEqual(['past-due', 'SUSPENDED', 'suspended']);
    expect((await run(new Date(inv!.dueAt.getTime() + 31 * DAY), f.id)).reminders).toBe(0);
  });

  it('reminds the directors once before the end of a trial', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    await subscribe(f.id);
    const s = await subOf(f.id);
    const at = new Date(s.trialEndsAt!.getTime() - 3 * DAY);
    expect((await run(at, f.id)).reminders).toBe(1);
    expect((await run(new Date(at.getTime() + DAY), f.id)).reminders).toBe(0);
    const reminders = (await eventTypes(s.id)).filter((t) => t === 'REMINDER_SENT');
    expect(reminders).toHaveLength(1);
    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, director.id), eq(notifications.type, 'subscription')));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.link).toBe('/director/subscription');
  });

  it('ends a subscription cancelled at the end of its period, without a new invoice', async () => {
    const f = await createFacility();
    await subscribe(f.id, { trial: false });
    let s = await subOf(f.id);
    const cancel = await adminPost(`/subscriptions/${s.id}/cancel`, {
      atPeriodEnd: true,
      reason: 'The clinic closes at the end of the month',
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body.subscription.cancelAtPeriodEnd).toBe(true);
    expect(
      (
        await adminPost(`/subscriptions/${s.id}/cancel`, {
          atPeriodEnd: true,
          reason: 'Twice is once too many',
        })
      ).status,
    ).toBe(409);
    const r = await run(new Date(s.currentPeriodEnd.getTime() + HOUR), f.id);
    expect(r.cancelled).toBe(1);
    s = await subOf(f.id);
    expect(s.status).toBe('CANCELLED');
    expect(await invoicesOf(f.id)).toHaveLength(1);
    expect(await eventTypes(s.id)).toEqual(
      expect.arrayContaining(['CANCELLATION_SCHEDULED', 'CANCELLED']),
    );
  });
});

describe('administrator actions', () => {
  it('changes plan, seats and cycle, activates a trial, notes, issues and voids', async () => {
    const f = await createFacility();
    const body = await subscribe(f.id);
    const id = body.subscription.id as string;
    const change = await adminPost(`/subscriptions/${id}/change`, {
      planId: hospital.id,
      seats: 25,
      note: 'Grew into a hospital',
    });
    expect(change.status).toBe(200);
    expect(change.body.subscription).toMatchObject({
      priceCents: hospital.monthlyPriceCents,
      seats: 25,
    });
    expect(change.body.seatLimit).toBe(25);
    expect((await adminPost(`/subscriptions/${id}/change`, {})).status).toBe(400);
    expect((await adminPost(`/subscriptions/${id}/invoices`)).status).toBe(409);
    const activated = await adminPost(`/subscriptions/${id}/activate`);
    expect(activated.body.subscription.status).toBe('ACTIVE');
    expect(activated.body.invoices).toHaveLength(1);
    expect((await adminPost(`/subscriptions/${id}/invoices`)).status).toBe(409);
    await adminPost(`/subscriptions/${id}/notes`, { note: 'Called the director about payment' });
    const invoiceId = activated.body.invoices[0].id as string;
    expect((await adminPost(`/invoices/${invoiceId}/void`, { reason: 'x' })).status).toBe(400);
    const voided = await adminPost(`/invoices/${invoiceId}/void`, {
      reason: 'Issued with the wrong price',
    });
    expect(voided.body).toMatchObject({
      status: 'VOID',
      voidReason: 'Issued with the wrong price',
    });
    const reissued = await adminPost(`/subscriptions/${id}/invoices`);
    expect(reissued.status).toBe(201);
    expect(reissued.body.invoices).toHaveLength(2);
    const detail = await adminGet(`/organizations/${f.id}`);
    const types = detail.body.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'PLAN_CHANGED',
        'SEATS_CHANGED',
        'PRICE_CHANGED',
        'ACTIVATED',
        'NOTE',
        'INVOICE_VOIDED',
      ]),
    );
    const planChange = detail.body.events.find((e: { type: string }) => e.type === 'PLAN_CHANGED');
    expect(planChange).toMatchObject({
      fromPlan: { name: 'Clinic' },
      toPlan: { name: 'Hospital' },
      note: 'Grew into a hospital',
    });
    expect(planChange.actor.fullName).toBeTruthy();
  });

  it('onboards a new customer: facility, trial and the first director', async () => {
    const res = await adminPost('/organizations', {
      facility: {
        code: 'klinika-test',
        name: 'Klinika Test',
        type: 'SPECIALIZED_CLINIC',
        region: 'Prishtinë',
        municipality: 'Prishtinë',
      },
      director: { email: 'new.director@example.test', fullName: 'Drita Director' },
      subscription: { planId: clinic.id, billingCycle: 'MONTHLY', trial: true },
    });
    expect(res.status).toBe(201);
    expect(res.body.facility.code).toBe('KLINIKA-TEST');
    expect(res.body.subscription.status).toBe('TRIAL');
    expect(res.body.invitedDirector.activationUrl).toContain('/activate?token=');
    expect(res.body.seatsUsed).toBe(1);
    expect(res.body.directors[0].email).toBe('new.director@example.test');
    const dup = await adminPost('/organizations', {
      facility: {
        code: 'KLINIKA-TEST',
        name: 'Again',
        type: 'SPECIALIZED_CLINIC',
        region: 'Prishtinë',
        municipality: 'Prishtinë',
      },
    });
    expect(dup.status).toBe(409);
    const list = await adminGet('/organizations?status=TRIAL');
    expect(
      list.body.items.some(
        (o: { facility: { code: string } }) => o.facility.code === 'KLINIKA-TEST',
      ),
    ).toBe(true);
    expect(list.body.kpis.byStatus.TRIAL).toBeGreaterThanOrEqual(1);
    const none = await adminGet('/organizations?status=NONE');
    expect(none.body.items.every((o: { subscription: unknown }) => o.subscription === null)).toBe(
      true,
    );
  });
});

describe('invoice integrity', () => {
  it('numbers invoices without gaps or duplicates, also when issued at the same time', async () => {
    const subs = [];
    for (let i = 0; i < 5; i++) {
      const f = await createFacility();
      await subscribe(f.id);
      subs.push(await subOf(f.id));
    }
    const issued = await Promise.all(
      subs.map((s) =>
        db.transaction((tx) =>
          issueInvoice(
            tx,
            s,
            { start: s.currentPeriodStart, end: s.currentPeriodEnd },
            {
              actor: null,
            },
          ),
        ),
      ),
    );
    const numbers = issued.map((i) => i.number);
    expect(new Set(numbers).size).toBe(5);
    const all = await db.select({ number: invoices.number }).from(invoices);
    const year = String(new Date().getFullYear());
    const seqs = all
      .map((r) => r.number)
      .filter((n) => n.includes(`-${year}-`))
      .map((n) => Number(n.split('-').pop()))
      .sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it('keeps issued invoices and the history unchangeable in the database', async () => {
    const f = await createFacility();
    await subscribe(f.id, { trial: false });
    const [inv] = await invoicesOf(f.id);
    await expect(
      db.update(invoices).set({ netCents: 1 }).where(eq(invoices.id, inv!.id)),
    ).rejects.toThrow();
    await expect(db.delete(invoices).where(eq(invoices.id, inv!.id))).rejects.toThrow();
    await adminPost(`/invoices/${inv!.id}/payments`, { method: 'CASH' });
    await expect(
      db
        .update(invoices)
        .set({ status: 'VOID', voidReason: 'after payment' })
        .where(eq(invoices.id, inv!.id)),
    ).rejects.toThrow();
    expect(
      (await adminPost(`/invoices/${inv!.id}/void`, { reason: 'Paid by mistake' })).status,
    ).toBe(409);
    const s = await subOf(f.id);
    await expect(
      db
        .update(subscriptionEvents)
        .set({ note: 'rewritten' })
        .where(eq(subscriptionEvents.subscriptionId, s.id)),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`DELETE FROM subscription_events WHERE subscription_id = ${s.id}`),
    ).rejects.toThrow();
  });
});

describe('seats and access', () => {
  it('refuses staff accounts beyond the seats, and allows one again after disabling another', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    const doctor = await createUser('DOCTOR', f.id);
    const token = await login(director.email);
    await subscribe(f.id, { planId: small.id, trial: false });
    const invite = (email: string) =>
      api()
        .post('/api/v1/staff/invitations')
        .set(bearer(token))
        .send({ email, fullName: 'Front Desk', role: 'RECEPTION' });
    const refused = await invite('desk1@example.test');
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/used all the staff accounts/);
    const disabled = await api()
      .patch(`/api/v1/staff/${doctor.id}/status`)
      .set(bearer(token))
      .send({ isActive: false });
    expect(disabled.status).toBe(204);
    expect((await invite('desk2@example.test')).status).toBe(201);
    const reenable = await api()
      .patch(`/api/v1/staff/${doctor.id}/status`)
      .set(bearer(token))
      .send({ isActive: true });
    expect(reenable.status).toBe(409);
    // Facilities without a subscription have no limit.
    expect(
      (
        await api()
          .post('/api/v1/staff/invitations')
          .set(bearer(w.tokens.director))
          .send({ email: 'free@example.test', fullName: 'No Limit', role: 'RECEPTION' })
      ).status,
    ).toBe(201);
  });

  it('never restricts clinical access: a suspended facility’s doctor still reads the record', async () => {
    const body = await subscribe(w.facility.id, { trial: false });
    const suspended = await adminPost(`/subscriptions/${body.subscription.id}/suspend`, {
      reason: 'Unpaid for three months',
    });
    expect(suspended.body.subscription.status).toBe('SUSPENDED');
    expect(await login(w.users.doctor.email)).toBeTruthy();
    const summary = await api()
      .get(`/api/v1/patients/${w.patient.id}/summary`)
      .set(bearer(w.tokens.doctor));
    expect(summary.status).toBe(200);
    // …but no new staff accounts.
    const invite = await api()
      .post('/api/v1/staff/invitations')
      .set(bearer(w.tokens.director))
      .send({ email: 'blocked@example.test', fullName: 'Blocked', role: 'RECEPTION' });
    expect(invite.status).toBe(409);
    const back = await adminPost(`/subscriptions/${body.subscription.id}/reactivate`, {});
    expect(back.body.subscription.status).toBe('ACTIVE');
  });

  it('never stops a disabled clinician or director from being re-enabled because of the status', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    const doctor = await createUser('DOCTOR', f.id);
    const token = await login(director.email);
    const body = await subscribe(f.id, { planId: small.id, trial: false });
    const status = (id: string, isActive: boolean, t = token) =>
      api().patch(`/api/v1/staff/${id}/status`).set(bearer(t)).send({ isActive });
    expect((await status(doctor.id, false)).status).toBe(204);
    await adminPost(`/subscriptions/${body.subscription.id}/suspend`, { reason: 'Unpaid invoice' });
    // A suspended facility gets no NEW accounts, but its disabled doctor comes back.
    expect((await status(doctor.id, true)).status).toBe(204);
    // The only director, disabled by mistake, can be re-enabled by the platform administrator
    // even with every seat used.
    expect((await status(director.id, false, w.tokens.ministry)).status).toBe(204);
    await db.update(users).set({ isActive: true }).where(eq(users.id, doctor.id));
    const enabled = await adminPost(`/users/${director.id}/enable`, {
      reason: 'Disabled by mistake',
    });
    expect(enabled.status).toBe(200);
  });

  it('shows directors their own subscription and invoices only, without internal notes', async () => {
    const s = await subOf(w.facility.id);
    await adminPost(`/subscriptions/${s.id}/notes`, { note: 'Internal: slow payer' });
    const mine = await api().get('/api/v1/subscription').set(bearer(w.tokens.director));
    expect(mine.status).toBe(200);
    expect(mine.body.subscription.id).toBe(s.id);
    expect(mine.body.events.some((e: { type: string }) => e.type === 'NOTE')).toBe(false);
    expect(mine.body.events.every((e: { actor: unknown }) => e.actor === null)).toBe(true);
    const own = mine.body.invoices[0].id as string;
    expect(
      (await api().get(`/api/v1/subscription/invoices/${own}`).set(bearer(w.tokens.director)))
        .status,
    ).toBe(200);
    const other = await api()
      .get(`/api/v1/subscription/invoices/${own}`)
      .set(bearer(w.tokens.otherDirector));
    expect(other.status).toBe(404);
  });
});

/* ------------------------------------------------------------ operator review: billing fixes -- */

/** Sets fields of a subscription directly (time travel for the lifecycle). */
const setSub = (id: string, set: Partial<typeof subscriptions.$inferInsert>) =>
  db.update(subscriptions).set(set).where(eq(subscriptions.id, id));
const titlesOf = async (userId: string) =>
  (
    await db
      .select({ title: notifications.title })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, 'subscription')))
  ).map((n) => n.title);
const pay = (invoiceId: string, body: Record<string, unknown> = {}) =>
  adminPost(`/invoices/${invoiceId}/payments`, { method: 'BANK_TRANSFER', ...body });
const invite = (token: string, email: string) =>
  api()
    .post('/api/v1/staff/invitations')
    .set(bearer(token))
    .send({ email, fullName: 'Front Desk', role: 'RECEPTION' });

describe('a cancellation scheduled before a suspension', () => {
  it('ends a suspended subscription at the end of its period, without a new invoice', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    await subscribe(f.id, { trial: false, billingCycle: 'YEARLY' });
    let s = await subOf(f.id);
    await adminPost(`/subscriptions/${s.id}/cancel`, {
      atPeriodEnd: true,
      reason: 'Does not renew next year',
    });
    const [inv] = await invoicesOf(f.id);
    await run(new Date(inv!.dueAt.getTime() + HOUR), f.id);
    s = await subOf(f.id);
    await run(new Date(s.pastDueSince!.getTime() + 30 * DAY + HOUR), f.id);
    s = await subOf(f.id);
    expect(s).toMatchObject({
      status: 'SUSPENDED',
      suspensionCause: 'NON_PAYMENT',
      cancelAtPeriodEnd: true,
    });

    const r = await run(new Date(s.currentPeriodEnd.getTime() + HOUR), f.id);
    expect(r.cancelled).toBe(1);
    const ended = await subOf(f.id);
    expect(ended).toMatchObject({
      status: 'CANCELLED',
      cancelAtPeriodEnd: false,
      suspensionCause: null,
      suspendedAt: null,
    });
    expect(ended.cancelledAt!.toISOString()).toBe(s.currentPeriodEnd.toISOString());
    expect(await invoicesOf(f.id)).toHaveLength(1);
    expect(await titlesOf(director.id)).toContain('Your facility’s subscription has ended');
  });

  it('a payment after the end of the period ends it as scheduled instead of billing a new one', async () => {
    const f = await createFacility();
    await subscribe(f.id);
    const s = await subOf(f.id);
    const now = Date.now();
    const start = new Date(now - 400 * DAY);
    const end = new Date(now - 35 * DAY);
    await setSub(s.id, {
      status: 'ACTIVE',
      billingCycle: 'YEARLY',
      priceCents: 149_000,
      trialEndsAt: null,
      currentPeriodStart: start,
      currentPeriodEnd: end,
    });
    const old = await db.transaction(async (tx) =>
      issueInvoice(tx, await subOf(f.id), { start, end }, { actor: null, now: start }),
    );
    await adminPost(`/subscriptions/${s.id}/cancel`, {
      atPeriodEnd: true,
      reason: 'Leaves at the end of the contract',
    });
    await setSub(s.id, {
      status: 'SUSPENDED',
      suspensionCause: 'NON_PAYMENT',
      suspendedAt: new Date(now - 300 * DAY),
      pastDueSince: old.dueAt,
    });

    expect((await pay(old.id)).status).toBe(200);
    const after = await subOf(f.id);
    expect(after).toMatchObject({ status: 'CANCELLED', cancelAtPeriodEnd: false });
    expect(after.cancelledAt!.toISOString()).toBe(end.toISOString());
    expect(after.currentPeriodEnd.toISOString()).toBe(end.toISOString());
    expect(await invoicesOf(f.id)).toHaveLength(1);
  });

  it('reactivating after the date ends it as scheduled; suspending keeps the cancellation', async () => {
    const f = await createFacility();
    const body = await subscribe(f.id, { trial: false });
    const id = body.subscription.id as string;
    await adminPost(`/subscriptions/${id}/cancel`, {
      atPeriodEnd: true,
      reason: 'Closing the practice',
    });
    const suspended = await adminPost(`/subscriptions/${id}/suspend`, {
      reason: 'Contract dispute under review',
    });
    expect(suspended.body.subscription).toMatchObject({
      status: 'SUSPENDED',
      cancelAtPeriodEnd: true,
      suspensionCause: 'MANUAL',
    });
    const now = Date.now();
    await setSub(id, {
      currentPeriodStart: new Date(now - 40 * DAY),
      currentPeriodEnd: new Date(now - 10 * DAY),
    });
    const back = await adminPost(`/subscriptions/${id}/reactivate`, { note: 'Dispute settled' });
    expect(back.status).toBe(200);
    // The answer says the subscription ended instead of being reactivated.
    expect(back.body.outcome).toBe('ENDED');
    expect(back.body.subscription).toMatchObject({ status: 'CANCELLED', cancelAtPeriodEnd: false });
    expect(back.body.invoices).toHaveLength(1);
    const cancelled = back.body.events.find((e: { type: string }) => e.type === 'CANCELLED');
    expect(cancelled.data).toMatchObject({ reason: 'cancelled at the end of the period' });
    // The administrator's note is kept in the history and in the audit entry.
    expect(cancelled.note).toBe('Dispute settled');
    const [entry, ...more] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, id), sql`${auditLogs.metadata}->>'event' = 'CANCELLED'`));
    expect(more).toHaveLength(0);
    expect(entry!.actorUserId).toBe(adminId);
    expect(entry!.metadata).toMatchObject({
      event: 'CANCELLED',
      reason: 'cancelled at the end of the period',
      note: 'Dispute settled',
    });
  });
});

describe('a change of billing cycle', () => {
  it('takes effect at the renewal; the current period keeps its cycle and price, also re-issued', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    const body = await subscribe(f.id, { trial: false });
    const id = body.subscription.id as string;
    const change = await adminPost(`/subscriptions/${id}/change`, { billingCycle: 'YEARLY' });
    expect(change.status).toBe(200);
    expect(change.body.subscription).toMatchObject({
      billingCycle: 'MONTHLY',
      priceCents: 14_900,
      nextBillingCycle: 'YEARLY',
      nextPriceCents: 149_000,
    });
    const mine = await api()
      .get('/api/v1/subscription')
      .set(bearer(await login(director.email)));
    expect(mine.body.subscription).toMatchObject({
      nextBillingCycle: 'YEARLY',
      nextPriceCents: 149_000,
    });

    // Re-issued for the current period: still monthly, at the monthly price.
    const [first] = await invoicesOf(f.id);
    await adminPost(`/invoices/${first!.id}/void`, { reason: 'Re-issue with the new terms' });
    expect((await adminPost(`/subscriptions/${id}/invoices`)).status).toBe(201);
    const reissued = (await invoicesOf(f.id))[1]!;
    expect(reissued.netCents).toBe(14_900);
    expect(reissued.description).toMatch(/^Clinic plan, monthly: /);

    const s = await subOf(f.id);
    const r = await run(new Date(s.currentPeriodEnd.getTime() + HOUR), f.id);
    expect(r.renewed).toBe(1);
    const renewed = await subOf(f.id);
    expect(renewed).toMatchObject({
      billingCycle: 'YEARLY',
      priceCents: 149_000,
      nextBillingCycle: null,
      nextPriceCents: null,
    });
    expect(renewed.currentPeriodStart.toISOString()).toBe(s.currentPeriodEnd.toISOString());
    expect(renewed.currentPeriodEnd.toISOString()).toBe(
      addCycle(s.currentPeriodEnd, 'YEARLY', s.billingAnchor!).toISOString(),
    );
    const third = (await invoicesOf(f.id))[2]!;
    expect(third.netCents).toBe(149_000);
    expect(third.description).toMatch(/^Clinic plan, yearly: /);
    const cycleEvents = await db
      .select({ data: subscriptionEvents.data })
      .from(subscriptionEvents)
      .where(
        and(
          eq(subscriptionEvents.subscriptionId, id),
          eq(subscriptionEvents.type, 'CYCLE_CHANGED'),
        ),
      )
      .orderBy(asc(subscriptionEvents.createdAt));
    expect(cycleEvents.map((e) => e.data)).toMatchObject([
      { from: 'MONTHLY', to: 'YEARLY', scheduled: true, priceCents: 149_000 },
      { from: 'MONTHLY', to: 'YEARLY', applied: true },
    ]);
  });

  it('is withdrawn by choosing the current cycle again; a trial changes its cycle at once', async () => {
    const f = await createFacility();
    const body = await subscribe(f.id, { trial: false });
    const id = body.subscription.id as string;
    await adminPost(`/subscriptions/${id}/change`, { billingCycle: 'YEARLY', priceCents: 120_000 });
    const back = await adminPost(`/subscriptions/${id}/change`, { billingCycle: 'MONTHLY' });
    expect(back.body.subscription).toMatchObject({
      billingCycle: 'MONTHLY',
      priceCents: 14_900,
      nextBillingCycle: null,
      nextPriceCents: null,
    });
    const withdrawn = back.body.events.find((e: { type: string }) => e.type === 'CYCLE_CHANGED');
    expect(withdrawn.data).toMatchObject({ withdrawn: true });

    const g = await createFacility();
    const trial = await subscribe(g.id);
    const changed = await adminPost(`/subscriptions/${trial.subscription.id}/change`, {
      billingCycle: 'YEARLY',
    });
    expect(changed.body.subscription).toMatchObject({
      billingCycle: 'YEARLY',
      priceCents: 149_000,
      nextBillingCycle: null,
    });
  });
});

describe('suspensions', () => {
  it('keeps a suspension by the administrator when a payment is recorded or an invoice voided', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    const token = await login(director.email);
    const body = await subscribe(f.id, { trial: false });
    const id = body.subscription.id as string;
    await adminPost(`/subscriptions/${id}/suspend`, {
      reason: 'Breach of the data processing agreement',
    });
    const [current] = await invoicesOf(f.id);
    expect((await pay(current!.id)).status).toBe(200);
    expect(await subOf(f.id)).toMatchObject({ status: 'SUSPENDED', suspensionCause: 'MANUAL' });
    const s = await subOf(f.id);
    const extra = await db.transaction((tx) =>
      issueInvoice(
        tx,
        s,
        { start: s.currentPeriodStart, end: s.currentPeriodEnd },
        { actor: null },
      ),
    );
    await adminPost(`/invoices/${extra.id}/void`, { reason: 'Issued twice by mistake' });
    expect((await subOf(f.id)).status).toBe('SUSPENDED');
    expect((await invite(token, `desk-${id}@example.test`)).status).toBe(409);
    const director2 = await api().get('/api/v1/subscription').set(bearer(token));
    expect(director2.body.subscription).toMatchObject({
      status: 'SUSPENDED',
      suspensionCause: 'MANUAL',
    });

    const back = await adminPost(`/subscriptions/${id}/reactivate`, {});
    expect(back.body.subscription).toMatchObject({ status: 'ACTIVE', suspensionCause: null });
    expect(back.body.outcome).toBe('REACTIVATED');
  });

  it('counts the grace period from the oldest invoice still overdue after a payment', async () => {
    const f = await createFacility();
    await subscribe(f.id, { trial: false });
    const s = await subOf(f.id);
    const now = Date.now();
    // A fell due 50 days ago, B 10 days ago (14-day payment terms).
    const issued = [];
    for (const daysAgo of [64, 24]) {
      issued.push(
        await db.transaction((tx) =>
          issueInvoice(
            tx,
            s,
            { start: new Date(now - (daysAgo + 30) * DAY), end: new Date(now - daysAgo * DAY) },
            { actor: null, now: new Date(now - daysAgo * DAY) },
          ),
        ),
      );
    }
    const [older, newer] = issued as [(typeof issued)[0], (typeof issued)[0]];
    const r = await run(new Date(), f.id);
    expect(r).toMatchObject({ pastDue: 1, suspended: 1 });

    expect((await pay(older.id)).status).toBe(200);
    let after = await subOf(f.id);
    expect(after).toMatchObject({ status: 'PAST_DUE', suspensionCause: null, suspendedAt: null });
    expect(after.pastDueSince!.toISOString()).toBe(newer.dueAt.toISOString());
    expect(await run(new Date(), f.id)).toMatchObject({ suspended: 0 });

    // The grace period of B ends 30 days after its due date.
    await run(new Date(newer.dueAt.getTime() + 30 * DAY - HOUR), f.id);
    expect((await subOf(f.id)).status).toBe('PAST_DUE');
    await run(new Date(newer.dueAt.getTime() + 30 * DAY + HOUR), f.id);
    after = await subOf(f.id);
    expect(after).toMatchObject({ status: 'SUSPENDED', suspensionCause: 'NON_PAYMENT' });
  });

  it('tells the directors an invoice is still overdue, never "active again", until it is', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    await subscribe(f.id, { trial: false });
    const s = await subOf(f.id);
    const now = Date.now();
    const issued = [];
    for (const daysAgo of [64, 24]) {
      issued.push(
        await db.transaction((tx) =>
          issueInvoice(
            tx,
            s,
            { start: new Date(now - (daysAgo + 30) * DAY), end: new Date(now - daysAgo * DAY) },
            { actor: null, now: new Date(now - daysAgo * DAY) },
          ),
        ),
      );
    }
    const [older, newer] = issued as [(typeof issued)[0], (typeof issued)[0]];
    expect(await run(new Date(), f.id)).toMatchObject({ pastDue: 1, suspended: 1, reminders: 2 });
    const OVERDUE = 'Your facility’s subscription has an overdue invoice';
    const LIFTED = 'Your facility’s subscription is no longer suspended, but an invoice is overdue';
    const ACTIVE_AGAIN = 'Your facility’s subscription is active again';
    const count = async (title: string) =>
      (await titlesOf(director.id)).filter((t) => t === title).length;

    // A payment leaves the newer invoice overdue: payment overdue, not active.
    expect((await pay(older.id)).status).toBe(200);
    expect((await subOf(f.id)).status).toBe('PAST_DUE');
    expect(await count(LIFTED)).toBe(1);
    expect(await count(ACTIVE_AGAIN)).toBe(0);
    // That notice told them of the overdue invoice: the worker does not repeat it.
    expect(await run(new Date(), f.id)).toMatchObject(NOTHING);
    expect(await count(OVERDUE)).toBe(1);

    // Nothing overdue any more: active again.
    expect((await pay(newer.id)).status).toBe(200);
    expect((await subOf(f.id)).status).toBe('ACTIVE');
    expect(await count(ACTIVE_AGAIN)).toBe(1);

    // The same when the administrator reactivates with an invoice still overdue.
    await db.transaction((tx) =>
      issueInvoice(
        tx,
        s,
        { start: new Date(now - 50 * DAY), end: new Date(now - 20 * DAY) },
        { actor: null, now: new Date(now - 20 * DAY) },
      ),
    );
    await adminPost(`/subscriptions/${s.id}/suspend`, { reason: 'Contract dispute' });
    const back = await adminPost(`/subscriptions/${s.id}/reactivate`, {});
    expect(back.body.subscription.status).toBe('PAST_DUE');
    expect(await count(LIFTED)).toBe(2);
    expect(await count(ACTIVE_AGAIN)).toBe(1);
    expect(await run(new Date(), f.id)).toMatchObject(NOTHING);
    expect(await count(OVERDUE)).toBe(1);
  });

  it('lifts on payment only a suspension recorded as for non-payment', async () => {
    const f = await createFacility();
    await subscribe(f.id, { trial: false });
    const s = await subOf(f.id);
    await setSub(s.id, {
      status: 'SUSPENDED',
      suspensionCause: 'NON_PAYMENT',
      suspendedAt: new Date(),
    });
    const suspended = await subOf(f.id);
    const restore = (sub: typeof suspended) =>
      db.transaction((tx) => restoreStanding(tx, sub, { actor: null, reason: 'paid' }));
    // A suspension without a recorded cause is treated like the administrator's: it stays.
    await restore({ ...suspended, suspensionCause: null });
    expect(await subOf(f.id)).toMatchObject({
      status: 'SUSPENDED',
      suspensionCause: 'NON_PAYMENT',
    });
    expect(await eventTypes(s.id)).not.toContain('REACTIVATED');
    await restore({ ...suspended, suspensionCause: 'MANUAL' });
    expect((await subOf(f.id)).status).toBe('SUSPENDED');
    // For non-payment, with nothing overdue, it is lifted.
    await restore(suspended);
    expect(await subOf(f.id)).toMatchObject({ status: 'ACTIVE', suspensionCause: null });
    expect(await eventTypes(s.id)).toContain('REACTIVATED');
  });
});

describe('seat limits', () => {
  it('keeps the seat limit a subscription started with when the plan is edited', async () => {
    const team = (
      await adminPost('/plans', {
        code: 'TEAM',
        name: 'Team',
        monthlyPriceCents: 2_000,
        yearlyPriceCents: 20_000,
        seatLimit: 40,
      })
    ).body;
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    await createUser('DOCTOR', f.id);
    const token = await login(director.email);
    const body = await subscribe(f.id, { planId: team.id, trial: false });
    const edited = await api()
      .patch(`/api/v1/admin/plans/${team.id}`)
      .set(bearer(admin))
      .send({ seatLimit: 2 });
    expect(edited.status).toBe(200);
    expect((await adminGet(`/organizations/${f.id}`)).body.seatLimit).toBe(40);
    expect((await invite(token, 'team-desk@example.test')).status).toBe(201);

    // A plan change brings the new plan's limit: unlimited, then the edited one.
    const id = body.subscription.id as string;
    const toHospital = await adminPost(`/subscriptions/${id}/change`, { planId: hospital.id });
    expect(toHospital.body.seatLimit).toBeNull();
    const toTeam = await adminPost(`/subscriptions/${id}/change`, { planId: team.id });
    expect(toTeam.body.seatLimit).toBe(2);
    expect(toTeam.body.subscription.planSeatLimit).toBe(2);
  });
});

describe('trials', () => {
  it('returns a suspended trial to the trial; never invoices or counts the trial period', async () => {
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    const body = await subscribe(f.id);
    const id = body.subscription.id as string;
    await adminPost(`/subscriptions/${id}/suspend`, { reason: 'Paused on request' });
    const back = await adminPost(`/subscriptions/${id}/reactivate`, {});
    expect(back.body.subscription.status).toBe('TRIAL');
    expect(back.body.invoices).toHaveLength(0);
    // The directors are told the trial continues – not that a subscription is "active again".
    const titles = await titlesOf(director.id);
    expect(titles).toContain('Your facility’s trial is no longer suspended');
    expect(titles).not.toContain('Your facility’s subscription is active again');
    expect((await adminPost(`/subscriptions/${id}/invoices`)).status).toBe(409);
    const list = await adminGet(`/organizations?q=${f.code}`);
    expect(list.body.items[0].monthlyValueCents).toBe(0);

    // A trial that ended while suspended starts its first paid period on reactivation.
    await adminPost(`/subscriptions/${id}/suspend`, { reason: 'Paused again on request' });
    const now = Date.now();
    await setSub(id, {
      currentPeriodStart: new Date(now - 40 * DAY),
      currentPeriodEnd: new Date(now - 10 * DAY),
      trialEndsAt: new Date(now - 10 * DAY),
    });
    const started = await adminPost(`/subscriptions/${id}/reactivate`, {});
    expect(started.body.subscription.status).toBe('ACTIVE');
    expect(started.body.invoices).toHaveLength(1);
    expect(new Date(started.body.subscription.currentPeriodStart).getTime()).toBeGreaterThan(
      now - 60_000,
    );
  });

  it('refuses to end a trial early while a cancellation is scheduled', async () => {
    const f = await createFacility();
    const body = await subscribe(f.id);
    const id = body.subscription.id as string;
    await adminPost(`/subscriptions/${id}/cancel`, {
      atPeriodEnd: true,
      reason: 'Does not want to continue after the trial',
    });
    const refused = await adminPost(`/subscriptions/${id}/activate`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/Withdraw the cancellation first/);
    expect(await invoicesOf(f.id)).toHaveLength(0);
    await adminPost(`/subscriptions/${id}/withdraw-cancellation`);
    const activated = await adminPost(`/subscriptions/${id}/activate`);
    expect(activated.body.subscription.status).toBe('ACTIVE');
    expect(await eventTypes(id)).toEqual(
      expect.arrayContaining(['CANCELLATION_SCHEDULED', 'CANCELLATION_WITHDRAWN', 'ACTIVATED']),
    );
  });
});

describe('due dates and periods', () => {
  it('makes an invoice overdue only after its due date has fully passed (0-day terms: the issue day)', async () => {
    await db
      .update(platformSettings)
      .set({ paymentTermsDays: 0 })
      .where(eq(platformSettings.id, 1));
    try {
      const f = await createFacility();
      await createUser('DIRECTOR', f.id);
      await subscribe(f.id);
      const s = await subOf(f.id);
      const r = await run(new Date(s.trialEndsAt!.getTime() + HOUR), f.id);
      expect(r).toMatchObject({ activated: 1, pastDue: 0 });
      const [inv] = await invoicesOf(f.id);
      expect(localDate(inv!.dueAt)).toBe(localDate(inv!.issuedAt));
      expect(localTime(inv!.dueAt)).toBe('23:59:59');
      expect((await run(new Date(inv!.dueAt.getTime()), f.id)).pastDue).toBe(0);
      expect((await run(new Date(inv!.dueAt.getTime() + 1000), f.id)).pastDue).toBe(1);
    } finally {
      await db
        .update(platformSettings)
        .set({ paymentTermsDays: 14 })
        .where(eq(platformSettings.id, 1));
    }
  });

  it('computes periods on the Kosovo calendar and keeps the billing day after a short month', async () => {
    const periods = (anchorIso: string, n: number) => {
      const anchor = new Date(anchorIso);
      const out: string[] = [];
      for (let i = 0, start = anchor; i < n; i++) {
        const end = addCycle(start, 'MONTHLY', anchor);
        out.push(invoiceDescription('X', 'MONTHLY', { start, end }).slice(-23));
        start = end;
      }
      return out;
    };
    // Across the change to summer time, near midnight: no day missing, none twice.
    expect(periods('2027-02-28T22:15:00Z', 2)).toEqual([
      '28.02.2027 – 27.03.2027',
      '28.03.2027 – 27.04.2027',
    ]);
    expect(periods('2026-09-25T22:30:00Z', 2)).toEqual([
      '26.09.2026 – 25.10.2026',
      '26.10.2026 – 25.11.2026',
    ]);
    // 1 February 00:30 in Kosovo is still 31 January in UTC: the billing day stays the 1st.
    expect(periods('2026-01-31T23:30:00Z', 3)).toEqual([
      '01.02.2026 – 28.02.2026',
      '01.03.2026 – 31.03.2026',
      '01.04.2026 – 30.04.2026',
    ]);

    // Renewals keep the anchor day: 31 Jan → 28 Feb → 31 Mar.
    const f = await createFacility();
    await subscribe(f.id, { trial: false });
    const [first] = await invoicesOf(f.id);
    await adminPost(`/invoices/${first!.id}/void`, { reason: 'Moved to the contract date' });
    const s = await subOf(f.id);
    const anchor = localInstant(2027, 1, 31, 10);
    await setSub(s.id, {
      currentPeriodStart: anchor,
      currentPeriodEnd: addCycle(anchor, 'MONTHLY'),
      billingAnchor: anchor,
    });
    await run(new Date(localInstant(2027, 2, 28, 11)), f.id);
    await run(new Date(localInstant(2027, 3, 31, 11)), f.id);
    const after = await subOf(f.id);
    expect(after.currentPeriodStart.toISOString()).toBe(
      localInstant(2027, 3, 31, 10).toISOString(),
    );
    expect(after.currentPeriodEnd.toISOString()).toBe(localInstant(2027, 4, 30, 10).toISOString());
    expect((await invoicesOf(f.id)).slice(-2).map((i) => i.description)).toEqual([
      'Clinic plan, monthly: 28.02.2027 – 30.03.2027',
      'Clinic plan, monthly: 31.03.2027 – 29.04.2027',
    ]);
  });

  it('counts payments as "paid this year" by the year in Kosovo', async () => {
    const f = await createFacility();
    await subscribe(f.id);
    const s = await subOf(f.id);
    const yearStart = yearStartOf(new Date());
    const issue = (at: Date) =>
      db.transaction((tx) =>
        issueInvoice(tx, s, { start: at, end: addCycle(at, 'MONTHLY') }, { actor: null, now: at }),
      );
    const lastYear = await issue(new Date(yearStart.getTime() - 2 * DAY));
    const thisYear = await issue(new Date(yearStart.getTime() + 10 * 60_000));
    // 31 December 23:30 and 1 January 00:30 in Kosovo – both still 31 December in UTC.
    await pay(lastYear.id, { paidAt: new Date(yearStart.getTime() - 30 * 60_000).toISOString() });
    await pay(thisYear.id, { paidAt: new Date(yearStart.getTime() + 30 * 60_000).toISOString() });
    const res = await adminGet(`/invoices?facilityId=${f.id}`);
    expect(res.body.totals.paidThisYearCents).toBe(thisYear.totalCents);
  });
});

describe('invoices with nothing to pay, restarts and notices', () => {
  it('issues an invoice with nothing to pay as paid; it never becomes overdue', async () => {
    const pilot = (
      await adminPost('/plans', {
        code: 'PILOT',
        name: 'Pilot',
        monthlyPriceCents: 0,
        yearlyPriceCents: 0,
        seatLimit: 5,
      })
    ).body;
    const f = await createFacility();
    const director = await createUser('DIRECTOR', f.id);
    const token = await login(director.email);
    await subscribe(f.id, { planId: pilot.id, trial: false });
    const [inv] = await invoicesOf(f.id);
    expect(inv).toMatchObject({
      totalCents: 0,
      status: 'PAID',
      paymentMethod: 'OTHER',
      paymentReference: 'No charge',
    });
    const r = await run(new Date(inv!.dueAt.getTime() + 31 * DAY), f.id);
    expect(r).toMatchObject({ pastDue: 0, suspended: 0, renewed: 1 });
    expect((await subOf(f.id)).status).toBe('ACTIVE');
    expect((await adminGet(`/organizations/${f.id}`)).body.invoices[0].overdue).toBe(false);
    expect((await invite(token, 'pilot-desk@example.test')).status).toBe(201);
  });

  it('starts a new subscription only when the earlier invoices are settled', async () => {
    const f = await createFacility();
    await createUser('DIRECTOR', f.id);
    const body = await subscribe(f.id, { trial: false });
    const id = body.subscription.id as string;
    const cancelled = await adminPost(`/subscriptions/${id}/cancel`, {
      atPeriodEnd: false,
      reason: 'Contract terminated',
    });
    expect(cancelled.body.subscription.status).toBe('CANCELLED');
    const [open] = await invoicesOf(f.id);
    expect(open!.status).toBe('OPEN');
    const refused = await adminPost(`/organizations/${f.id}/subscription`, {
      planId: clinic.id,
      trial: false,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/still open/);
    await adminPost(`/invoices/${open!.id}/void`, { reason: 'Contract terminated early' });
    await subscribe(f.id, { trial: false });
    const r = await run(new Date(), f.id);
    expect(r).toMatchObject({ pastDue: 0, suspended: 0 });
    expect((await subOf(f.id)).status).toBe('ACTIVE');
  });

  it('tells the first director of a new customer about the first invoice', async () => {
    const res = await adminPost('/organizations', {
      facility: {
        code: 'klinika-paid',
        name: 'Klinika Paid',
        type: 'SPECIALIZED_CLINIC',
        region: 'Prishtinë',
        municipality: 'Prishtinë',
      },
      director: { email: 'paid.director@example.test', fullName: 'Besa Director' },
      subscription: { planId: clinic.id, billingCycle: 'MONTHLY', trial: false },
    });
    expect(res.status).toBe(201);
    const number = res.body.invoices[0].number as string;
    expect((await titlesOf(res.body.invitedDirector.id)).join(' ')).toContain(number);
  });

  it('records a reminder as sent only once a director received it', async () => {
    const f = await createFacility();
    await subscribe(f.id);
    const s = await subOf(f.id);
    const at = (daysBeforeEnd: number) => new Date(s.trialEndsAt!.getTime() - daysBeforeEnd * DAY);
    expect((await run(at(5), f.id)).reminders).toBe(0);
    expect(await eventTypes(s.id)).not.toContain('REMINDER_SENT');
    const director = await createUser('DIRECTOR', f.id);
    expect((await run(at(4), f.id)).reminders).toBe(1);
    expect((await run(at(3), f.id)).reminders).toBe(0);
    const titles = await titlesOf(director.id);
    expect(titles).toHaveLength(1);
    expect(titles[0]).toMatch(/^Your facility’s trial ends on /);
  });
});
