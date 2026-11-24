import { and, asc, desc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  facilities,
  invoices,
  platformSettings,
  subscriptionEvents,
  subscriptionPlans,
  subscriptions,
  users,
  type Role,
  type subscriptionEventTypeEnum,
  type subscriptionStatusEnum,
} from '../../db/schema.js';
import { conflict } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { recordRun, registerWorker } from '../../lib/worker-runs.js';

/*
 * Subscriptions of facilities to the service.
 *
 * Safety rule (see docs/CLINICAL-SAFETY.md): the subscription status NEVER restricts clinical
 * access, sign-in or existing accounts. A lapsed or suspended subscription only stops new staff
 * accounts from being added (seat check below) and shows notices to the facility's directors.
 * Nothing in this module may be used to lock clinicians out of patient records.
 */

export type SubscriptionStatus = (typeof subscriptionStatusEnum.enumValues)[number];
export type SubscriptionEventType = (typeof subscriptionEventTypeEnum.enumValues)[number];
export type BillingCycle = 'MONTHLY' | 'YEARLY';
export type Subscription = typeof subscriptions.$inferSelect;
export type Plan = typeof subscriptionPlans.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
type Actor = Pick<AuthContext, 'userId' | 'role' | 'facilityId'> | null;

const TZ = 'Europe/Belgrade';
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Reminders before the end of a trial or a period. */
const REMINDER_DAYS = 7;
/** Statuses in which no new staff account may be added. */
const CLOSED_STATUSES: SubscriptionStatus[] = ['SUSPENDED', 'CANCELLED', 'EXPIRED'];
const DIRECTOR_LINK = '/director/subscription';

/* ------------------------------------------------------------------ periods and money -------- */

/*
 * Periods, due dates and years follow the calendar in Kosovo (Europe/Belgrade), not UTC: a period
 * that starts on the 31st at 00:30 local time starts on the 30th in UTC, and a day is 23 or 25
 * hours long when the clocks change.
 */
const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** Wall-clock date and time of an instant in Kosovo (month 1–12). */
function localParts(at: Date) {
  const p = Object.fromEntries(partsFormat.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    mi: Number(p.minute),
    s: Number(p.second),
    ms: at.getUTCMilliseconds(),
  };
}

/** Offset of Kosovo time from UTC at an instant, in milliseconds (CET +1 h, CEST +2 h). */
function offsetAt(at: Date) {
  const p = localParts(at);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s, p.ms) - at.getTime();
}

/**
 * The instant of a wall-clock time in Kosovo. Month and day may overflow (day 0 is the last day of
 * the month before). A time skipped when the clocks go forward falls just after the gap; a time
 * that occurs twice when they go back is the first one.
 */
export function localInstant(y: number, month: number, day: number, h = 0, mi = 0, s = 0, ms = 0) {
  const wall = Date.UTC(y, month - 1, day, h, mi, s, ms);
  const before = offsetAt(new Date(wall - 12 * HOUR));
  const after = offsetAt(new Date(wall + 12 * HOUR));
  const fits = [wall - before, wall - after].filter((t) => offsetAt(new Date(t)) === wall - t);
  return new Date(fits.length ? Math.min(...fits) : wall - before);
}

/**
 * `months` calendar months after `from` (before, when negative) in Kosovo time, on the anchor's
 * day of the month – clamped to the month's last day – and at the anchor's time of day.
 */
export function addMonths(from: Date, months: number, anchor: Date = from): Date {
  const f = localParts(from);
  const a = localParts(anchor);
  const first = new Date(Date.UTC(f.y, f.m - 1 + months, 1));
  const y = first.getUTCFullYear();
  const m = first.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return localInstant(y, m, Math.min(a.d, lastDay), a.h, a.mi, a.s, a.ms);
}

/**
 * End of a billing period that starts at `start`: one or twelve months on, on the day of the month
 * and at the time of day of the billing anchor (the start of the first period of the run). Chaining
 * renewals from the anchor rather than from the previous end keeps the billing day after a short
 * month: 31 Jan → 28 Feb → 31 Mar, not → 28 Mar.
 */
export function addCycle(start: Date, cycle: BillingCycle, anchor: Date = start): Date {
  return addMonths(start, cycle === 'YEARLY' ? 12 : 1, anchor);
}

/** `days` calendar days after `from` in Kosovo time, at the same time of day (a trial). */
export function addLocalDays(from: Date, days: number): Date {
  const f = localParts(from);
  return localInstant(f.y, f.m, f.d + days, f.h, f.mi, f.s, f.ms);
}

/**
 * Due date of an invoice issued at `issuedAt`: the last moment of the day `termsDays` days later in
 * Kosovo (0 = the issue day). The invoice shows that date, and is overdue only once it has fully
 * passed – never on the day the customer was told to pay by.
 */
export function invoiceDueAt(issuedAt: Date, termsDays: number): Date {
  const p = localParts(issuedAt);
  return new Date(localInstant(p.y, p.m, p.d + termsDays + 1).getTime() - 1);
}

/**
 * The last day of a period: the Kosovo calendar day before the one it ends on (the next period
 * starts that day), as its midday – never "end − 24 h", which is the wrong day across a change of
 * the clocks or for a period that ends shortly after midnight.
 */
export function lastDayOf(end: Date): Date {
  const p = localParts(end);
  return localInstant(p.y, p.m, p.d - 1, 12);
}

/** Start of the calendar year of an instant in Kosovo (1 January, 00:00 local time). */
export const yearStartOf = (at: Date) => localInstant(yearOf(at), 1, 1);

/** The current period is (still) the free trial: it is never invoiced. */
export const inTrialWindow = (s: Pick<Subscription, 'trialEndsAt' | 'currentPeriodEnd'>) =>
  s.trialEndsAt !== null && s.currentPeriodEnd.getTime() <= s.trialEndsAt.getTime();

/**
 * The current period is as long as one cycle of the subscription's billing cycle (28–31 days or a
 * year, with an hour either way for a change of the clocks), so an invoice for it at the price per
 * cycle is right. Periods started before billing-cycle changes waited for the renewal may not be.
 */
export function periodMatchesCycle(
  s: Pick<Subscription, 'billingCycle' | 'currentPeriodStart' | 'currentPeriodEnd'>,
) {
  const days = (s.currentPeriodEnd.getTime() - s.currentPeriodStart.getTime()) / DAY;
  return s.billingCycle === 'YEARLY' ? days > 364.9 && days < 366.1 : days > 27.9 && days < 31.1;
}

/** Price per cycle of a plan. */
export const planPrice = (plan: Plan, cycle: BillingCycle) =>
  cycle === 'YEARLY' ? plan.yearlyPriceCents : plan.monthlyPriceCents;

/** Monthly recurring revenue of a subscription in cents (yearly prices spread over 12 months). */
export const monthlyValueCents = (s: Pick<Subscription, 'billingCycle' | 'priceCents'>) =>
  s.billingCycle === 'YEARLY' ? Math.round(s.priceCents / 12) : s.priceCents;

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
/** "01.12.2026" in Kosovo time. */
const dayOf = (d: Date) => dayFormat.format(d).replace(/\//g, '.');
const yearOf = (d: Date) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric' }).format(d));

/** "Clinic plan, monthly: 01.12.2026 – 31.12.2026" (end dates are exclusive: the last day is shown). */
export const invoiceDescription = (
  planName: string,
  cycle: BillingCycle,
  period: { start: Date; end: Date },
) =>
  `${planName} plan, ${cycle === 'YEARLY' ? 'yearly' : 'monthly'}: ${dayOf(period.start)} – ${dayOf(lastDayOf(period.end))}`;

/**
 * The fields of a new period starting at `start`. A change of billing cycle scheduled for it takes
 * effect, with its price. A renewal keeps the billing anchor; a period started afresh (the end of a
 * trial, an activation, a reactivation after the period ended) anchors on its own start.
 */
export function periodFrom(s: Subscription, start: Date, opts: { renewal: boolean }) {
  const cycle = s.nextBillingCycle ?? s.billingCycle;
  const anchor = opts.renewal ? (s.billingAnchor ?? s.currentPeriodStart) : start;
  return {
    billingCycle: cycle,
    priceCents: s.nextBillingCycle ? (s.nextPriceCents ?? s.priceCents) : s.priceCents,
    nextBillingCycle: null,
    nextPriceCents: null,
    billingAnchor: anchor,
    currentPeriodStart: start,
    currentPeriodEnd: addCycle(start, cycle, anchor),
  };
}

/** History entry when a new period took up a scheduled change of billing cycle. */
export async function recordScheduledCycle(
  executor: Executor,
  before: Subscription,
  after: Subscription,
  at: Date,
) {
  if (!before.nextBillingCycle) return;
  await recordEvent(executor, {
    subscription: after,
    type: 'CYCLE_CHANGED',
    actor: null,
    data: {
      from: before.billingCycle,
      to: after.billingCycle,
      priceCents: after.priceCents,
      currency: after.currency,
      applied: true,
    },
    at,
  });
}

/* ------------------------------------------------------------------ settings and seats ------- */

export async function settingsOf(executor: Executor = db) {
  const [row] = await executor.select().from(platformSettings).where(eq(platformSettings.id, 1));
  // The migration inserts the row; defaults keep billing working if it was ever removed.
  return (
    row ?? {
      operatorName: '',
      operatorAddress: '',
      operatorFiscalNumber: null,
      operatorVatNumber: null,
      operatorIban: null,
      operatorBank: null,
      supportEmail: null,
      supportPhone: null,
      invoicePrefix: 'PAC',
      paymentTermsDays: 14,
      vatRateBp: 0,
      trialDays: 30,
      graceDays: 30,
    }
  );
}

/** Active staff accounts (seats) of a facility; patients never count, pending invitations do. */
export async function seatsUsed(facilityId: string, executor: Executor = db): Promise<number> {
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.isActive, true), ne(users.role, 'PATIENT')),
    );
  return row?.n ?? 0;
}

/**
 * Seats available to a subscription: purchased seats, else the plan's limit as it was when the
 * subscription started or changed plan (a later edit of the plan does not change it); null =
 * unlimited.
 */
export const seatLimitOf = (s: Pick<Subscription, 'seats' | 'planSeatLimit'>) =>
  s.seats ?? s.planSeatLimit;

/**
 * Refuses a NEW staff account when the facility's subscription is suspended, cancelled or expired,
 * or all its seats are used. A facility without a subscription (e.g. a public facility run by the
 * Ministry) has no limit. Inside a transaction, concurrent checks for the same facility are
 * serialised.
 *
 * Re-enabling an EXISTING account (`reactivation`) is never refused because of the subscription's
 * status (hazard H74: the status never affects existing accounts); it only needs a free seat, and a
 * director needs not even that – a facility must always be able to get its director back.
 */
export async function assertSeatAvailable(
  facilityId: string,
  executor: Executor = db,
  opts: { reactivation?: { role: Role } } = {},
): Promise<void> {
  if (opts.reactivation?.role === 'DIRECTOR') return;
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`seats:${facilityId}`}))`);
  const [subscription] = await executor
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.facilityId, facilityId));
  if (!subscription) return;
  if (!opts.reactivation && CLOSED_STATUSES.includes(subscription.status)) {
    throw conflict(
      'The facility’s subscription is suspended or has ended, so new staff accounts cannot be added. Existing accounts keep working. Contact the service operator.',
    );
  }
  const limit = seatLimitOf(subscription);
  if (limit === null) return;
  if ((await seatsUsed(facilityId, executor)) >= limit) {
    throw conflict(
      'This facility has used all the staff accounts (seats) of its subscription. Disable an account or ask for more seats.',
    );
  }
}

/* ------------------------------------------------------------------ history ------------------ */

/**
 * Entries written together (one transaction, one lifecycle run) would share a timestamp; each is
 * placed at least a millisecond after the previous entry of the same subscription, so the history
 * always reads in the order things happened.
 */
const lastEventAt = new Map<string, number>();
function eventTime(subscriptionId: string, at: Date | undefined) {
  const base = (at ?? new Date()).getTime();
  const previous = lastEventAt.get(subscriptionId);
  const ms =
    previous !== undefined && base <= previous && base > previous - 1000 ? previous + 1 : base;
  if (lastEventAt.size > 10_000) lastEventAt.clear();
  lastEventAt.set(subscriptionId, ms);
  return new Date(ms);
}

export async function recordEvent(
  executor: Executor,
  e: {
    subscription: Pick<Subscription, 'id' | 'facilityId'>;
    type: SubscriptionEventType;
    actor: Actor;
    fromStatus?: SubscriptionStatus | null;
    toStatus?: SubscriptionStatus | null;
    fromPlanId?: string | null;
    toPlanId?: string | null;
    data?: Record<string, unknown>;
    note?: string | null;
    at?: Date;
  },
) {
  await executor.insert(subscriptionEvents).values({
    subscriptionId: e.subscription.id,
    facilityId: e.subscription.facilityId,
    type: e.type,
    fromStatus: e.fromStatus ?? null,
    toStatus: e.toStatus ?? null,
    fromPlanId: e.fromPlanId ?? null,
    toPlanId: e.toPlanId ?? null,
    data: e.data ?? {},
    note: e.note ?? null,
    actorId: e.actor?.userId ?? null,
    createdAt: eventTime(e.subscription.id, e.at),
  });
}

/** Audit entry for a subscription change, in the same transaction. */
export async function auditChange(
  executor: Executor,
  actor: Actor,
  subscription: Pick<Subscription, 'id' | 'facilityId'>,
  metadata: Record<string, unknown>,
  meta?: RequestMeta,
) {
  await audit(
    {
      action: AuditAction.SUBSCRIPTION_CHANGED,
      actor,
      resourceType: 'subscription',
      resourceId: subscription.id,
      meta,
      metadata: { facilityId: subscription.facilityId, ...metadata },
    },
    executor,
  );
}

/** The facility's active directors – they receive the subscription notices. */
export async function directorsOf(facilityId: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR'), eq(users.isActive, true)),
    );
  return rows.map((r) => r.id);
}

/** Tells the facility's active directors; returns how many were told (0: it has none yet). */
export async function notifyDirectors(
  executor: Executor,
  facilityId: string,
  title: string,
  vars?: Record<string, string | number | Date>,
  important = false,
): Promise<number> {
  const ids = await directorsOf(facilityId, executor);
  if (!ids.length) return 0;
  await notifyUsers(
    ids,
    { type: 'subscription', title, vars, link: DIRECTOR_LINK, important },
    executor,
  );
  return ids.length;
}

/* ------------------------------------------------------------------ invoices ----------------- */

/** Payment reference of an invoice with nothing to pay (issued as paid). */
export const NO_CHARGE = 'No charge';

/** Next invoice number of the year: the counter row stays locked until the transaction ends. */
export async function nextInvoiceNumber(executor: Executor, prefix: string, at: Date) {
  const year = yearOf(at);
  const result = await executor.execute<{ last: number }>(sql`
    INSERT INTO invoice_counters (year, last) VALUES (${year}, 1)
    ON CONFLICT (year) DO UPDATE SET last = invoice_counters.last + 1
    RETURNING last`);
  const seq = Number(result.rows[0]!.last);
  return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
}

/**
 * Issues the invoice for one period of a subscription: gapless number, amounts with VAT from the
 * operator settings, issuer and customer details frozen at the time of issue (database trigger).
 * Writes the history entry and the audit entry and tells the facility's directors.
 */
export async function issueInvoice(
  executor: Executor,
  subscription: Subscription,
  period: { start: Date; end: Date },
  opts: { actor: Actor; meta?: RequestMeta; now?: Date },
) {
  const now = opts.now ?? new Date();
  const settings = await settingsOf(executor);
  const [plan] = await executor
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, subscription.planId));
  const [facility] = await executor
    .select()
    .from(facilities)
    .where(eq(facilities.id, subscription.facilityId));
  if (!plan || !facility) throw new Error('Subscription without plan or facility');
  const number = await nextInvoiceNumber(executor, settings.invoicePrefix, now);
  const netCents = subscription.priceCents;
  const taxCents = Math.round((netCents * settings.vatRateBp) / 10_000);
  // Nothing to pay (a free plan or price): issued as paid, so it never becomes overdue.
  const free = netCents + taxCents === 0;
  const [invoice] = await executor
    .insert(invoices)
    .values({
      number,
      facilityId: subscription.facilityId,
      subscriptionId: subscription.id,
      periodStart: period.start,
      periodEnd: period.end,
      description: invoiceDescription(plan.name, subscription.billingCycle, period),
      netCents,
      taxRateBp: settings.vatRateBp,
      taxCents,
      totalCents: netCents + taxCents,
      currency: subscription.currency,
      status: free ? 'PAID' : 'OPEN',
      ...(free ? { paidAt: now, paymentMethod: 'OTHER', paymentReference: NO_CHARGE } : {}),
      issuedAt: now,
      dueAt: invoiceDueAt(now, settings.paymentTermsDays),
      issuer: {
        name: settings.operatorName || null,
        address: settings.operatorAddress || null,
        fiscalNumber: settings.operatorFiscalNumber,
        vatNumber: settings.operatorVatNumber,
        iban: settings.operatorIban,
        bank: settings.operatorBank,
        email: settings.supportEmail,
        phone: settings.supportPhone,
      },
      customer: {
        name: facility.name,
        code: facility.code,
        address: facility.address,
        municipality: facility.municipality,
        region: facility.region,
      },
      createdById: opts.actor?.userId ?? null,
    })
    .returning();
  await recordEvent(executor, {
    subscription,
    type: 'INVOICE_ISSUED',
    actor: opts.actor,
    data: {
      invoiceId: invoice!.id,
      number,
      totalCents: invoice!.totalCents,
      currency: invoice!.currency,
      planId: plan.id,
      planName: plan.name,
      cycle: subscription.billingCycle,
    },
    at: now,
  });
  await audit(
    {
      action: AuditAction.INVOICE_ISSUED,
      actor: opts.actor,
      resourceType: 'invoice',
      resourceId: invoice!.id,
      meta: opts.meta,
      metadata: {
        number,
        facilityId: subscription.facilityId,
        subscriptionId: subscription.id,
        totalCents: invoice!.totalCents,
      },
    },
    executor,
  );
  await notifyDirectors(
    executor,
    subscription.facilityId,
    'Your facility’s subscription: invoice {number} was issued',
    { number },
  );
  return invoice!;
}

/**
 * An open invoice is overdue once its due date (the end of that day in Kosovo) has passed. An
 * invoice with nothing to pay never is.
 */
export const overdueWhere = (now: Date) =>
  and(eq(invoices.status, 'OPEN'), gt(invoices.totalCents, 0), lt(invoices.dueAt, now))!;

export const isOverdue = (inv: Pick<Invoice, 'status' | 'totalCents' | 'dueAt'>, now: Date) =>
  inv.status === 'OPEN' && inv.totalCents > 0 && inv.dueAt < now;

/** Open invoices of a subscription whose due date has passed, oldest due date first. */
export async function overdueInvoices(executor: Executor, subscriptionId: string, now: Date) {
  return executor
    .select()
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, subscriptionId), overdueWhere(now)))
    .orderBy(asc(invoices.dueAt));
}

/** The later of two dates (null counts as "none"). */
const laterOf = (a: Date | null, b: Date) => (a && a > b ? a : b);

/** A cancellation scheduled for the end of the period (or of the trial) whose date has come. */
export const cancellationDue = (
  s: Pick<Subscription, 'cancelAtPeriodEnd' | 'currentPeriodEnd'>,
  now: Date,
) => s.cancelAtPeriodEnd && s.currentPeriodEnd <= now;

/**
 * Ends a subscription (status CANCELLED) at `at`: no new period and no invoice. Open invoices stay
 * open – they are still owed. Writes the history entry (and the audit entry for an administrator's
 * action) and tells the directors.
 */
export async function endSubscription(
  executor: Executor,
  s: Subscription,
  opts: {
    at: Date;
    actor: Actor;
    meta?: RequestMeta;
    now?: Date;
    reason?: string;
    note?: string | null;
  },
) {
  const [updated] = await executor
    .update(subscriptions)
    .set({
      status: 'CANCELLED',
      cancelledAt: opts.at,
      cancelAtPeriodEnd: false,
      nextBillingCycle: null,
      nextPriceCents: null,
      pastDueSince: null,
      suspendedAt: null,
      suspensionCause: null,
    })
    .where(eq(subscriptions.id, s.id))
    .returning();
  await recordEvent(executor, {
    subscription: s,
    type: 'CANCELLED',
    actor: opts.actor,
    fromStatus: s.status,
    toStatus: 'CANCELLED',
    data: opts.reason ? { reason: opts.reason } : {},
    note: opts.note ?? null,
    at: opts.now,
  });
  if (opts.actor) {
    // An administrator's own words are kept next to the cause of an end as scheduled.
    await auditChange(
      executor,
      opts.actor,
      s,
      {
        event: 'CANCELLED',
        reason: opts.reason ?? opts.note ?? null,
        ...(opts.reason && opts.note ? { note: opts.note } : {}),
      },
      opts.meta,
    );
  }
  await notifyDirectors(executor, s.facilityId, 'Your facility’s subscription has ended');
  return updated!;
}

/**
 * A scheduled cancellation takes effect: the subscription ends with its period, as agreed. `note`
 * is the administrator's, when their action (e.g. reactivating) found the date already passed.
 */
export const endAsScheduled = (
  executor: Executor,
  s: Subscription,
  opts: { actor: Actor; meta?: RequestMeta; now: Date; note?: string | null },
) =>
  endSubscription(executor, s, {
    ...opts,
    at: s.currentPeriodEnd,
    reason: 'cancelled at the end of the period',
  });

/**
 * After a payment or a void (`reason`), for a past-due subscription or one suspended for
 * non-payment:
 *  - a cancellation scheduled for a date that has passed takes effect (no new period, no invoice);
 *  - with nothing overdue any more it is active again. A suspended one whose period ended starts a
 *    new period now, with its invoice (no back-billing); a past-due one keeps its period and the
 *    subscription worker renews it where it ended;
 *  - with invoices still overdue the grace period counts from the oldest of them (or from a fresh
 *    grace period an administrator gave on reactivating, if later), and a suspended subscription
 *    whose grace period is then not over is back to "payment overdue".
 * Only a suspension for non-payment is lifted this way. One by an administrator – or one whose
 * cause is not recorded, which is treated the same way – is lifted only by reactivating it.
 */
export async function restoreStanding(
  executor: Executor,
  subscription: Subscription,
  opts: { actor: Actor; meta?: RequestMeta; now?: Date; reason: 'paid' | 'voided' },
) {
  const now = opts.now ?? new Date();
  const s = subscription;
  if (s.status !== 'PAST_DUE' && s.status !== 'SUSPENDED') return;
  if (cancellationDue(s, now)) {
    await endAsScheduled(executor, s, { actor: opts.actor, meta: opts.meta, now });
    return;
  }
  if (s.status === 'SUSPENDED' && s.suspensionCause !== 'NON_PAYMENT') return;
  const overdue = await overdueInvoices(executor, s.id, now);
  const since = overdue.length ? laterOf(s.pastDueSince, overdue[0]!.dueAt) : null;
  const settings = await settingsOf(executor);
  const graceOver = since !== null && since.getTime() + settings.graceDays * DAY <= now.getTime();
  if ((s.status === 'PAST_DUE' && since) || (s.status === 'SUSPENDED' && graceOver)) {
    if (since!.getTime() !== s.pastDueSince?.getTime()) {
      await executor
        .update(subscriptions)
        .set({ pastDueSince: since })
        .where(eq(subscriptions.id, s.id));
    }
    return;
  }
  const status = since ? 'PAST_DUE' : 'ACTIVE';
  const newPeriod = s.status === 'SUSPENDED' && s.currentPeriodEnd <= now;
  const [updated] = await executor
    .update(subscriptions)
    .set({
      status,
      pastDueSince: since,
      suspendedAt: null,
      suspensionCause: null,
      ...(newPeriod ? periodFrom(s, now, { renewal: false }) : {}),
    })
    .where(eq(subscriptions.id, s.id))
    .returning();
  await recordEvent(executor, {
    subscription: s,
    type: 'REACTIVATED',
    actor: opts.actor,
    fromStatus: s.status,
    toStatus: status,
    data: { reason: opts.reason },
    at: now,
  });
  await auditChange(executor, opts.actor, s, { event: 'REACTIVATED', status }, opts.meta);
  await notifyLifted(executor, updated!, now);
  if (newPeriod) {
    await recordScheduledCycle(executor, s, updated!, now);
    await issueInvoice(
      executor,
      updated!,
      { start: updated!.currentPeriodStart, end: updated!.currentPeriodEnd },
      opts,
    );
  }
}

/* ------------------------------------------------------------------ lifecycle ---------------- */

/** Key of the notice of an overdue invoice: once per past-due period (by when it started). */
const pastDueKey = (since: Date) => `past-due:${since.toISOString()}`;
const PAST_DUE_NOTICE = 'Your facility’s subscription has an overdue invoice';

/**
 * Tells the directors that a suspension was lifted (by a payment or by the administrator). Only
 * an active subscription is "active again"; a trial is told its trial continues; with an invoice
 * still overdue it is "payment overdue", and the notice says so. That notice also counts as the overdue notice of this past-due period,
 * so the subscription worker does not send a second one.
 */
export async function notifyLifted(executor: Executor, s: Subscription, now: Date) {
  if (s.status === 'TRIAL') {
    await notifyDirectors(executor, s.facilityId, 'Your facility’s trial is no longer suspended');
    return;
  }
  if (s.status !== 'PAST_DUE') {
    await notifyDirectors(executor, s.facilityId, 'Your facility’s subscription is active again');
    return;
  }
  const title = 'Your facility’s subscription is no longer suspended, but an invoice is overdue';
  const told = await notifyDirectors(executor, s.facilityId, title, {}, true);
  if (!s.pastDueSince) return;
  const key = pastDueKey(s.pastDueSince);
  if (told && !(await reminderSent(executor, s.id, key))) {
    await recordEvent(executor, {
      subscription: s,
      type: 'REMINDER_SENT',
      actor: null,
      data: { key, title },
      at: now,
    });
  }
}

async function reminderSent(executor: Executor, subscriptionId: string, key: string) {
  const [row] = await executor
    .select({ id: subscriptionEvents.id })
    .from(subscriptionEvents)
    .where(
      and(
        eq(subscriptionEvents.subscriptionId, subscriptionId),
        eq(subscriptionEvents.type, 'REMINDER_SENT'),
        sql`${subscriptionEvents.data}->>'key' = ${key}`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Sends a reminder to the facility's directors once per key (REMINDER_SENT in the history). A
 * reminder that reached no one – the facility has no active director yet – is not recorded, so a
 * later run sends it once there is one.
 */
async function remindOnce(
  executor: Executor,
  subscription: Subscription,
  key: string,
  title: string,
  vars: Record<string, string | number | Date>,
  now: Date,
  important = false,
) {
  if (await reminderSent(executor, subscription.id, key)) return false;
  if (!(await notifyDirectors(executor, subscription.facilityId, title, vars, important))) {
    return false;
  }
  await recordEvent(executor, {
    subscription,
    type: 'REMINDER_SENT',
    actor: null,
    data: { key, title },
    at: now,
  });
  return true;
}

export interface LifecycleResult {
  checked: number;
  activated: number;
  renewed: number;
  pastDue: number;
  suspended: number;
  cancelled: number;
  reminders: number;
}

/** Most periods caught up in one run for one subscription (e.g. after a long outage). */
const MAX_RENEWALS_PER_RUN = 24;

async function advance(subscriptionId: string, now: Date, result: LifecycleResult) {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`subscription:${subscriptionId}`}))`,
    );
    const [locked] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .for('update');
    if (!locked) return;
    let s: Subscription = locked;
    const update = async (set: Partial<typeof subscriptions.$inferInsert>) => {
      const [row] = await tx
        .update(subscriptions)
        .set(set)
        .where(eq(subscriptions.id, s.id))
        .returning();
      s = row!;
      return s;
    };
    const settings = await settingsOf(tx);
    const system = { actor: null, now };
    const event = (
      type: SubscriptionEventType,
      extra: Omit<Parameters<typeof recordEvent>[1], 'subscription' | 'type' | 'actor'> = {},
    ) => recordEvent(tx, { subscription: s, type, actor: null, at: now, ...extra });

    // 1. End of a trial: the subscription starts (first invoice), unless it was cancelled.
    if (s.status === 'TRIAL' && s.trialEndsAt && s.trialEndsAt <= now) {
      if (s.cancelAtPeriodEnd) {
        await endSubscription(tx, s, {
          at: s.trialEndsAt,
          actor: null,
          now,
          reason: 'trial ended with a scheduled cancellation',
        });
        result.cancelled++;
        return;
      }
      const before = s;
      await update({ status: 'ACTIVE', ...periodFrom(s, s.trialEndsAt, { renewal: false }) });
      await event('ACTIVATED', {
        fromStatus: 'TRIAL',
        toStatus: 'ACTIVE',
        data: { reason: 'trial ended' },
      });
      await recordScheduledCycle(tx, before, s, now);
      await issueInvoice(tx, s, { start: s.currentPeriodStart, end: s.currentPeriodEnd }, system);
      result.activated++;
    }

    // 2. End of a period: end a scheduled cancellation – also while suspended: a cancellation
    //    survives a suspension – or renew where the period ended (next invoice).
    if (s.status !== 'TRIAL' && cancellationDue(s, now)) {
      await endAsScheduled(tx, s, { actor: null, now });
      result.cancelled++;
      return;
    }
    let renewals = 0;
    while (
      (s.status === 'ACTIVE' || s.status === 'PAST_DUE') &&
      s.currentPeriodEnd <= now &&
      renewals < MAX_RENEWALS_PER_RUN
    ) {
      const before = s;
      await update(periodFrom(s, s.currentPeriodEnd, { renewal: true }));
      await event('RENEWED', {
        data: { periodStart: s.currentPeriodStart, periodEnd: s.currentPeriodEnd },
      });
      await recordScheduledCycle(tx, before, s, now);
      await issueInvoice(tx, s, { start: s.currentPeriodStart, end: s.currentPeriodEnd }, system);
      result.renewed++;
      renewals++;
    }

    // 3. An unpaid invoice past its due date: past due (the grace period counts from the due date).
    if (s.status === 'ACTIVE') {
      const overdue = await overdueInvoices(tx, s.id, now);
      if (overdue.length) {
        await update({ status: 'PAST_DUE', pastDueSince: overdue[0]!.dueAt });
        await event('MARKED_PAST_DUE', {
          fromStatus: 'ACTIVE',
          toStatus: 'PAST_DUE',
          data: { invoices: overdue.map((i) => i.number) },
        });
        result.pastDue++;
      }
    }

    // 4. The notice of an overdue invoice, once per past-due period – before a suspension in
    //    the same run (e.g. after an outage longer than the grace period), so the directors are
    //    always told of the overdue invoice first. Repeated at a later run if no director could
    //    be told yet.
    if (
      s.status === 'PAST_DUE' &&
      s.pastDueSince &&
      (await remindOnce(tx, s, pastDueKey(s.pastDueSince), PAST_DUE_NOTICE, {}, now, true))
    ) {
      result.reminders++;
    }

    // 5. Past due for longer than the grace period: suspended for non-payment (no new staff
    //    accounts; nothing else). A payment lifts it.
    if (
      s.status === 'PAST_DUE' &&
      s.pastDueSince &&
      s.pastDueSince.getTime() + settings.graceDays * DAY <= now.getTime()
    ) {
      await update({ status: 'SUSPENDED', suspendedAt: now, suspensionCause: 'NON_PAYMENT' });
      await event('SUSPENDED', {
        fromStatus: 'PAST_DUE',
        toStatus: 'SUSPENDED',
        data: {
          reason: 'unpaid after the grace period',
          cause: 'NON_PAYMENT',
          graceDays: settings.graceDays,
        },
      });
      result.suspended++;
    }

    // 6. The notice of a suspension for non-payment, once – repeated at a later run if no
    //    director could be told yet.
    if (
      s.status === 'SUSPENDED' &&
      s.suspensionCause === 'NON_PAYMENT' &&
      s.suspendedAt &&
      (await remindOnce(
        tx,
        s,
        `suspended:${s.suspendedAt.toISOString()}`,
        'Your facility’s subscription is suspended – new staff accounts cannot be added',
        {},
        now,
        true,
      ))
    ) {
      result.reminders++;
    }

    // 7. Reminders a week before the end of a trial or a renewal.
    const soon = now.getTime() + REMINDER_DAYS * DAY;
    if (
      s.status === 'TRIAL' &&
      s.trialEndsAt &&
      !s.cancelAtPeriodEnd &&
      s.trialEndsAt > now &&
      s.trialEndsAt.getTime() <= soon &&
      (await remindOnce(
        tx,
        s,
        `trial-ending:${s.trialEndsAt.toISOString()}`,
        'Your facility’s trial ends on {date}',
        { date: s.trialEndsAt },
        now,
      ))
    ) {
      result.reminders++;
    }
    if (
      s.status === 'ACTIVE' &&
      !s.cancelAtPeriodEnd &&
      s.currentPeriodEnd > now &&
      s.currentPeriodEnd.getTime() <= soon &&
      (await remindOnce(
        tx,
        s,
        `renewal:${s.currentPeriodEnd.toISOString()}`,
        'Your facility’s subscription renews on {date}',
        { date: s.currentPeriodEnd },
        now,
      ))
    ) {
      result.reminders++;
    }
  });
}

/**
 * One pass of the subscription lifecycle: trial ends, renewals with their invoices, scheduled
 * cancellations (also of suspended subscriptions), overdue invoices (past due), the grace period
 * (suspended), and reminders – each subscription in its own transaction under an advisory lock, so
 * several instances can run it at once. Idempotent: running it again at the same `now` changes
 * nothing and sends no reminder twice.
 */
export async function runSubscriptionLifecycle(
  now = new Date(),
  opts: { facilityIds?: string[] } = {},
): Promise<LifecycleResult> {
  const result: LifecycleResult = {
    checked: 0,
    activated: 0,
    renewed: 0,
    pastDue: 0,
    suspended: 0,
    cancelled: 0,
    reminders: 0,
  };
  const rows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        inArray(subscriptions.status, ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED']),
        opts.facilityIds ? inArray(subscriptions.facilityId, opts.facilityIds) : undefined,
      ),
    )
    .orderBy(asc(subscriptions.currentPeriodEnd));
  for (const { id } of rows) {
    result.checked++;
    try {
      await advance(id, now, result);
    } catch (err) {
      // One broken subscription must not stop the others.
      logger.error({ err, subscriptionId: id }, 'Subscription lifecycle step failed');
    }
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

function runSafely() {
  void recordRun('subscriptions', () => runSubscriptionLifecycle()).then(
    (r) =>
      r &&
      (r.activated || r.renewed || r.pastDue || r.suspended || r.cancelled || r.reminders) &&
      logger.info(r, 'Subscription lifecycle'),
  );
}

/** Every six hours (first run five minutes after start). Not started in tests. */
export function startSubscriptionsWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 5 * 60_000);
  first.unref();
  registerWorker('subscriptions', 6 * 60 * 60_000);
  timer = setInterval(runSafely, 6 * 60 * 60_000);
  timer.unref();
}

export function stopSubscriptionsWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}

/* ------------------------------------------------------------------ reading ------------------ */

/** History of a subscription, newest first, with the names of actors and plans. */
export async function eventsOf(subscriptionId: string, executor: Executor = db) {
  const rows = await executor
    .select({
      event: subscriptionEvents,
      actorName: users.fullName,
    })
    .from(subscriptionEvents)
    .leftJoin(users, eq(users.id, subscriptionEvents.actorId))
    .where(eq(subscriptionEvents.subscriptionId, subscriptionId))
    .orderBy(desc(subscriptionEvents.createdAt), desc(subscriptionEvents.id));
  const planIds = [
    ...new Set(
      rows.flatMap((r) => [r.event.fromPlanId, r.event.toPlanId]).filter((x): x is string => !!x),
    ),
  ];
  const plans = planIds.length
    ? await executor
        .select({ id: subscriptionPlans.id, name: subscriptionPlans.name })
        .from(subscriptionPlans)
        .where(inArray(subscriptionPlans.id, planIds))
    : [];
  const planName = new Map(plans.map((p) => [p.id, p.name]));
  return rows.map(({ event, actorName }) => ({
    id: event.id,
    type: event.type,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    fromPlan: event.fromPlanId
      ? { id: event.fromPlanId, name: planName.get(event.fromPlanId) ?? '' }
      : null,
    toPlan: event.toPlanId
      ? { id: event.toPlanId, name: planName.get(event.toPlanId) ?? '' }
      : null,
    data: event.data,
    note: event.note,
    actor: event.actorId ? { id: event.actorId, fullName: actorName ?? '' } : null,
    createdAt: event.createdAt,
  }));
}

/** An invoice for display: overdue flag and the plan/cycle it was issued for (from the history). */
export function presentInvoice(
  inv: Invoice,
  line: { planName?: unknown; cycle?: unknown } | null,
  now = new Date(),
  facilityName?: string | null,
) {
  return {
    ...inv,
    facilityName: facilityName ?? (inv.customer.name as string | null) ?? null,
    overdue: isOverdue(inv, now),
    line:
      line && typeof line.planName === 'string'
        ? { planName: line.planName, cycle: line.cycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY' }
        : null,
  };
}

/** The plan and cycle each invoice was issued for, from its INVOICE_ISSUED history entry. */
export async function invoiceLines(invoiceIds: string[], executor: Executor = db) {
  if (!invoiceIds.length) return new Map<string, { planName?: unknown; cycle?: unknown }>();
  const rows = await executor
    .select({ data: subscriptionEvents.data })
    .from(subscriptionEvents)
    .where(
      and(
        eq(subscriptionEvents.type, 'INVOICE_ISSUED'),
        inArray(sql<string>`${subscriptionEvents.data}->>'invoiceId'`, invoiceIds),
      ),
    );
  return new Map(
    rows.map((r) => [String(r.data.invoiceId), r.data as { planName?: unknown; cycle?: unknown }]),
  );
}

/** Invoices of a subscription (or facility), newest first, ready for display. */
export async function invoicesOf(facilityId: string, executor: Executor = db, now = new Date()) {
  const rows = await executor
    .select()
    .from(invoices)
    .where(eq(invoices.facilityId, facilityId))
    .orderBy(desc(invoices.issuedAt), desc(invoices.number));
  const lines = await invoiceLines(
    rows.map((r) => r.id),
    executor,
  );
  return rows.map((r) => presentInvoice(r, lines.get(r.id) ?? null, now));
}
