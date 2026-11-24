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
  issueInvoice,
  runSubscriptionLifecycle,
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
    expect(inv!.dueAt.getTime() - inv!.issuedAt.getTime()).toBe(14 * DAY);
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

    // Running again at the same moment changes nothing.
    const again = await run(new Date(s.suspendedAt!.getTime()), f.id);
    expect(again).toMatchObject({ checked: 0 });
  });

  it('needs every overdue invoice paid before a suspended subscription is active again', async () => {
    const f = await createFacility();
    await subscribe(f.id, { trial: false });
    let s = await subOf(f.id);
    const now = Date.now();
    // Two invoices from earlier periods, overdue by the real clock.
    for (const daysAgo of [60, 40]) {
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
