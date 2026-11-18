import { and, asc, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm';
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
  type subscriptionEventTypeEnum,
  type subscriptionStatusEnum,
} from '../../db/schema.js';
import { conflict } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

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
const DAY = 86_400_000;
/** Reminders before the end of a trial or a period. */
const REMINDER_DAYS = 7;
/** Statuses in which no new staff account may be added. */
const CLOSED_STATUSES: SubscriptionStatus[] = ['SUSPENDED', 'CANCELLED', 'EXPIRED'];
const DIRECTOR_LINK = '/director/subscription';

/* ------------------------------------------------------------------ periods and money -------- */

/** Start + one billing cycle, keeping the day of the month (31 Jan + 1 month = 28/29 Feb). */
export function addCycle(start: Date, cycle: BillingCycle): Date {
  const months = cycle === 'YEARLY' ? 12 : 1;
  const target = new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() + months,
      1,
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return target;
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
/** "01.12.2026" in Kosovo time (end dates are exclusive: the last day is shown). */
const dayOf = (d: Date) => dayFormat.format(d).replace(/\//g, '.');
const yearOf = (d: Date) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric' }).format(d));

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

/** Seats available to a subscription: purchased seats, else the plan's limit; null = unlimited. */
export const seatLimitOf = (s: Pick<Subscription, 'seats'>, plan: Pick<Plan, 'seatLimit'>) =>
  s.seats ?? plan.seatLimit;

/**
 * Refuses a new (or re-enabled) staff account when the facility's subscription is suspended,
 * cancelled or expired, or all its seats are used. A facility without a subscription (e.g. a
 * public facility run by the Ministry) has no limit. Never touches existing accounts or access.
 * Inside a transaction, concurrent checks for the same facility are serialised.
 */
export async function assertSeatAvailable(
  facilityId: string,
  executor: Executor = db,
): Promise<void> {
  await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`seats:${facilityId}`}))`);
  const [row] = await executor
    .select({ subscription: subscriptions, plan: subscriptionPlans })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .where(eq(subscriptions.facilityId, facilityId));
  if (!row) return;
  if (CLOSED_STATUSES.includes(row.subscription.status)) {
    throw conflict(
      'The facility’s subscription is suspended or has ended, so new staff accounts cannot be added. Existing accounts keep working. Contact the service operator.',
    );
  }
  const limit = seatLimitOf(row.subscription, row.plan);
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

export async function notifyDirectors(
  executor: Executor,
  facilityId: string,
  title: string,
  vars?: Record<string, string | number | Date>,
  important = false,
) {
  const ids = await directorsOf(facilityId, executor);
  if (!ids.length) return;
  await notifyUsers(
    ids,
    { type: 'subscription', title, vars, link: DIRECTOR_LINK, important },
    executor,
  );
}

/* ------------------------------------------------------------------ invoices ----------------- */

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
  const cycleWord = subscription.billingCycle === 'YEARLY' ? 'yearly' : 'monthly';
  // The period ends when the next one starts; its last day is the day before.
  const lastDay = new Date(period.end.getTime() - DAY);
  const [invoice] = await executor
    .insert(invoices)
    .values({
      number,
      facilityId: subscription.facilityId,
      subscriptionId: subscription.id,
      periodStart: period.start,
      periodEnd: period.end,
      description: `${plan.name} plan, ${cycleWord}: ${dayOf(period.start)} – ${dayOf(lastDay)}`,
      netCents,
      taxRateBp: settings.vatRateBp,
      taxCents,
      totalCents: netCents + taxCents,
      currency: subscription.currency,
      status: 'OPEN',
      issuedAt: now,
      dueAt: new Date(now.getTime() + settings.paymentTermsDays * DAY),
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

/** Open invoices of a subscription whose due date has passed. */
export async function overdueInvoices(executor: Executor, subscriptionId: string, now: Date) {
  return executor
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.subscriptionId, subscriptionId),
        eq(invoices.status, 'OPEN'),
        lte(invoices.dueAt, now),
      ),
    )
    .orderBy(asc(invoices.dueAt));
}

/**
 * After a payment or a void: a past-due or suspended subscription with nothing overdue any more is
 * active again. A suspended one whose period ended starts a new period now (no back-billing).
 */
export async function restoreStanding(
  executor: Executor,
  subscription: Subscription,
  opts: { actor: Actor; meta?: RequestMeta; now?: Date },
) {
  const now = opts.now ?? new Date();
  if (subscription.status !== 'PAST_DUE' && subscription.status !== 'SUSPENDED') return;
  if ((await overdueInvoices(executor, subscription.id, now)).length) return;
  const newPeriod = subscription.currentPeriodEnd <= now;
  const [updated] = await executor
    .update(subscriptions)
    .set({
      status: 'ACTIVE',
      pastDueSince: null,
      suspendedAt: null,
      ...(newPeriod
        ? {
            currentPeriodStart: now,
            currentPeriodEnd: addCycle(now, subscription.billingCycle),
          }
        : {}),
    })
    .where(eq(subscriptions.id, subscription.id))
    .returning();
  await recordEvent(executor, {
    subscription,
    type: 'REACTIVATED',
    actor: opts.actor,
    fromStatus: subscription.status,
    toStatus: 'ACTIVE',
    data: { reason: 'paid' },
    at: now,
  });
  await auditChange(executor, opts.actor, subscription, { event: 'REACTIVATED' }, opts.meta);
  await notifyDirectors(
    executor,
    subscription.facilityId,
    'Your facility’s subscription is active again',
  );
  if (newPeriod) {
    await issueInvoice(
      executor,
      updated!,
      { start: updated!.currentPeriodStart, end: updated!.currentPeriodEnd },
      opts,
    );
  }
}

/* ------------------------------------------------------------------ lifecycle ---------------- */

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

/** Sends a reminder to the facility's directors once per key (REMINDER_SENT in the history). */
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
  await notifyDirectors(executor, subscription.facilityId, title, vars, important);
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
        await update({ status: 'CANCELLED', cancelledAt: s.trialEndsAt, cancelAtPeriodEnd: false });
        await event('CANCELLED', {
          fromStatus: 'TRIAL',
          toStatus: 'CANCELLED',
          data: { reason: 'trial ended with a scheduled cancellation' },
        });
        await notifyDirectors(tx, s.facilityId, 'Your facility’s subscription has ended');
        result.cancelled++;
        return;
      }
      const start = s.trialEndsAt;
      await update({
        status: 'ACTIVE',
        currentPeriodStart: start,
        currentPeriodEnd: addCycle(start, s.billingCycle),
      });
      await event('ACTIVATED', {
        fromStatus: 'TRIAL',
        toStatus: 'ACTIVE',
        data: { reason: 'trial ended' },
      });
      await issueInvoice(tx, s, { start: s.currentPeriodStart, end: s.currentPeriodEnd }, system);
      result.activated++;
    }

    // 2. End of a period: renew (next invoice) or end a scheduled cancellation.
    let renewals = 0;
    while (
      (s.status === 'ACTIVE' || s.status === 'PAST_DUE') &&
      s.currentPeriodEnd <= now &&
      renewals < MAX_RENEWALS_PER_RUN
    ) {
      if (s.cancelAtPeriodEnd) {
        const from = s.status;
        await update({
          status: 'CANCELLED',
          cancelledAt: s.currentPeriodEnd,
          cancelAtPeriodEnd: false,
        });
        await event('CANCELLED', {
          fromStatus: from,
          toStatus: 'CANCELLED',
          data: { reason: 'cancelled at the end of the period' },
        });
        await notifyDirectors(tx, s.facilityId, 'Your facility’s subscription has ended');
        result.cancelled++;
        return;
      }
      const start = s.currentPeriodEnd;
      await update({
        currentPeriodStart: start,
        currentPeriodEnd: addCycle(start, s.billingCycle),
      });
      await event('RENEWED', {
        data: { periodStart: s.currentPeriodStart, periodEnd: s.currentPeriodEnd },
      });
      await issueInvoice(tx, s, { start: s.currentPeriodStart, end: s.currentPeriodEnd }, system);
      result.renewed++;
      renewals++;
    }

    // 3. An unpaid invoice past its due date: past due (the grace period counts from the due date).
    if (s.status === 'ACTIVE') {
      const overdue = await overdueInvoices(tx, s.id, now);
      if (overdue.length) {
        const since = overdue[0]!.dueAt;
        await update({ status: 'PAST_DUE', pastDueSince: since });
        await event('MARKED_PAST_DUE', {
          fromStatus: 'ACTIVE',
          toStatus: 'PAST_DUE',
          data: { invoices: overdue.map((i) => i.number) },
        });
        const key = `past-due:${since.toISOString()}`;
        if (
          await remindOnce(
            tx,
            s,
            key,
            'Your facility’s subscription has an overdue invoice',
            {},
            now,
            true,
          )
        ) {
          result.reminders++;
        }
        result.pastDue++;
      }
    }

    // 4. Past due for longer than the grace period: suspended (no new staff accounts; nothing else).
    if (
      s.status === 'PAST_DUE' &&
      s.pastDueSince &&
      s.pastDueSince.getTime() + settings.graceDays * DAY <= now.getTime()
    ) {
      await update({ status: 'SUSPENDED', suspendedAt: now });
      await event('SUSPENDED', {
        fromStatus: 'PAST_DUE',
        toStatus: 'SUSPENDED',
        data: { reason: 'unpaid after the grace period', graceDays: settings.graceDays },
      });
      const key = `suspended:${now.toISOString()}`;
      if (
        await remindOnce(
          tx,
          s,
          key,
          'Your facility’s subscription is suspended – new staff accounts cannot be added',
          {},
          now,
          true,
        )
      ) {
        result.reminders++;
      }
      result.suspended++;
    }

    // 5. Reminders a week before the end of a trial or a renewal.
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
 * One pass of the subscription lifecycle: trial ends, renewals with their invoices, overdue
 * invoices (past due), the grace period (suspended), and reminders – each subscription in its own
 * transaction under an advisory lock, so several instances can run it at once. Idempotent: running
 * it again at the same `now` changes nothing and sends no reminder twice.
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
        inArray(subscriptions.status, ['TRIAL', 'ACTIVE', 'PAST_DUE']),
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
  runSubscriptionLifecycle().then(
    (r) =>
      (r.activated || r.renewed || r.pastDue || r.suspended || r.cancelled || r.reminders) &&
      logger.info(r, 'Subscription lifecycle'),
    (err: unknown) => logger.error({ err }, 'Subscription lifecycle failed'),
  );
}

/** Every six hours (first run five minutes after start). Not started in tests. */
export function startSubscriptionsWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 5 * 60_000);
  first.unref();
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
    overdue: inv.status === 'OPEN' && inv.dueAt <= now,
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
