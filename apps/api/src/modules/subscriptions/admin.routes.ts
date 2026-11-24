import { Router, type Request } from 'express';
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { isProd } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  facilities,
  invoicePayments,
  invoices,
  subscriptionPlans,
  subscriptions,
  subscriptionStatusEnum,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { createInvitedUser } from '../auth/invitations.js';
import { ensureDefaultChannels } from '../channels/channels.routes.js';
import { FacilityInput } from '../facilities/facilities.routes.js';
import { BillingProfileInput, saveBillingProfile } from './profile.routes.js';
import {
  addCycle,
  addLocalDays,
  assertSeatAvailable,
  auditChange,
  cancellationDue,
  endAsScheduled,
  endSubscription,
  eventsOf,
  inTrialWindow,
  invoiceLines,
  invoicesOf,
  issueInvoice,
  monthlyValueCents,
  notifyDirectors,
  notifyLifted,
  overdueInvoices,
  overdueWhere,
  periodFrom,
  periodMatchesCycle,
  planPrice,
  presentInvoice,
  recordEvent,
  recordScheduledCycle,
  restoreStanding,
  seatLimitOf,
  seatsUsed,
  settingsOf,
  yearStartOf,
  type Plan,
  type Subscription,
} from './subscriptions.service.js';

/**
 * Plans, subscriptions, history and invoices for the platform administrator (mounted on /admin,
 * ADMIN only): /plans, /organizations, /subscriptions/:id/…, /invoices. Every change writes the
 * subscription history and the audit trail in the same transaction.
 */
export const adminBillingRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const FacilityParam = z.object({ facilityId: z.string().uuid() });
const Cycle = z.enum(['MONTHLY', 'YEARLY']);
const Cents = z.number().int().min(0).max(100_000_000);
const Seats = z.number().int().min(1).max(100_000).nullable();
const Reason = z.string().trim().min(5).max(1000);

/* ------------------------------------------------------------------ plans -------------------- */

const PlanFields = {
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,40}$/, 'Code may contain letters, digits and dashes'),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(1000).optional().nullable(),
  monthlyPriceCents: Cents,
  yearlyPriceCents: Cents,
  currency: z.literal('EUR'),
  seatLimit: Seats,
  features: z.array(z.string().trim().min(1).max(120)).max(10),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(1000),
};
const PlanInput = z.object({
  ...PlanFields,
  currency: PlanFields.currency.default('EUR'),
  seatLimit: PlanFields.seatLimit.default(null),
  features: PlanFields.features.default([]),
  isActive: PlanFields.isActive.default(true),
  sortOrder: PlanFields.sortOrder.default(0),
});
// No defaults here: Zod applies defaults inside optional fields, which would reset a plan.
const PlanPatch = z.object(PlanFields).partial();

adminBillingRouter.get('/plans', async (_req, res) => {
  const rows = await db
    .select({
      plan: subscriptionPlans,
      subscribers: sql<number>`(SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = ${subscriptionPlans.id} AND s.status IN ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'))`,
    })
    .from(subscriptionPlans)
    .orderBy(asc(subscriptionPlans.sortOrder), asc(subscriptionPlans.monthlyPriceCents));
  res.json({ items: rows.map((r) => ({ ...r.plan, subscribers: r.subscribers })) });
});

async function assertPlanCodeFree(code: string, exceptId?: string) {
  const [taken] = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.code, code));
  if (taken && taken.id !== exceptId) throw conflict('Another plan already has this code');
}

adminBillingRouter.post('/plans', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(PlanInput, req.body);
  await assertPlanCodeFree(input.code);
  const plan = await db.transaction(async (tx) => {
    const [row] = await tx.insert(subscriptionPlans).values(input).returning();
    await audit(
      {
        action: AuditAction.PLAN_SAVED,
        actor: ctx,
        resourceType: 'subscription_plan',
        resourceId: row!.id,
        meta: requestMeta(req),
        metadata: { code: row!.code, created: true },
      },
      tx,
    );
    return row!;
  });
  res.status(201).json(plan);
});

adminBillingRouter.patch('/plans/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const patch = parse(PlanPatch, req.body);
  if (patch.code) await assertPlanCodeFree(patch.code, id);
  const plan = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(subscriptionPlans)
      .set(patch)
      .where(eq(subscriptionPlans.id, id))
      .returning();
    if (!row) throw notFound('Plan not found');
    await audit(
      {
        action: AuditAction.PLAN_SAVED,
        actor: ctx,
        resourceType: 'subscription_plan',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { code: row.code, fields: Object.keys(patch) },
      },
      tx,
    );
    return row;
  });
  res.json(plan);
});

/* ------------------------------------------------------------------ organizations ------------ */

const OrgQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum([...subscriptionStatusEnum.enumValues, 'NONE']).optional(),
});

/** Seats used per facility (active staff accounts; patients never count). */
async function seatsByFacility(facilityIds: string[]) {
  if (!facilityIds.length) return new Map<string, number>();
  const rows = await db
    .select({ facilityId: users.facilityId, n: count() })
    .from(users)
    .where(
      and(
        inArray(users.facilityId, facilityIds),
        eq(users.isActive, true),
        sql`${users.role} <> 'PATIENT'`,
      ),
    )
    .groupBy(users.facilityId);
  return new Map(rows.map((r) => [r.facilityId!, r.n]));
}

function subscriptionSummary(s: Subscription, plan: Plan) {
  return {
    id: s.id,
    status: s.status,
    billingCycle: s.billingCycle,
    priceCents: s.priceCents,
    nextBillingCycle: s.nextBillingCycle,
    nextPriceCents: s.nextPriceCents,
    currency: s.currency,
    seats: s.seats,
    planSeatLimit: s.planSeatLimit,
    trialEndsAt: s.trialEndsAt,
    currentPeriodStart: s.currentPeriodStart,
    currentPeriodEnd: s.currentPeriodEnd,
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    pastDueSince: s.pastDueSince,
    suspendedAt: s.suspendedAt,
    suspensionCause: s.suspensionCause,
    cancelledAt: s.cancelledAt,
    notes: s.notes,
    createdAt: s.createdAt,
    plan: {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      seatLimit: plan.seatLimit,
      monthlyPriceCents: plan.monthlyPriceCents,
      yearlyPriceCents: plan.yearlyPriceCents,
    },
  };
}

adminBillingRouter.get('/organizations', async (req, res) => {
  const q = parse(OrgQuery, req.query);
  const now = new Date();
  const filters: SQL[] = [];
  if (q.q) {
    filters.push(or(ilike(facilities.name, `%${q.q}%`), ilike(facilities.code, `%${q.q}%`))!);
  }
  const rows = await db
    .select({
      facility: {
        id: facilities.id,
        code: facilities.code,
        name: facilities.name,
        type: facilities.type,
        region: facilities.region,
        municipality: facilities.municipality,
        isActive: facilities.isActive,
      },
      subscription: subscriptions,
      plan: subscriptionPlans,
      openInvoices: sql<number>`(SELECT count(*)::int FROM invoices i WHERE i.facility_id = ${facilities.id} AND i.status = 'OPEN')`,
      overdueInvoices: sql<number>`(SELECT count(*)::int FROM invoices i WHERE i.facility_id = ${facilities.id} AND i.status = 'OPEN' AND i.total_cents > 0 AND i.due_at < ${now})`,
    })
    .from(facilities)
    .leftJoin(subscriptions, eq(subscriptions.facilityId, facilities.id))
    .leftJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(facilities.name));
  const seats = await seatsByFacility(rows.map((r) => r.facility.id));
  const all = rows.map((r) => ({
    facility: r.facility,
    subscription: r.subscription && r.plan ? subscriptionSummary(r.subscription, r.plan) : null,
    seatsUsed: seats.get(r.facility.id) ?? 0,
    seatLimit: r.subscription ? seatLimitOf(r.subscription) : null,
    openInvoices: r.openInvoices,
    overdueInvoices: r.overdueInvoices,
    monthlyValueCents:
      r.subscription && (r.subscription.status === 'ACTIVE' || r.subscription.status === 'PAST_DUE')
        ? monthlyValueCents(r.subscription)
        : 0,
  }));
  const kpis = {
    mrrCents: all.reduce((sum, o) => sum + o.monthlyValueCents, 0),
    currency: 'EUR',
    facilities: all.length,
    none: all.filter((o) => !o.subscription).length,
    byStatus: Object.fromEntries(
      subscriptionStatusEnum.enumValues.map((s) => [
        s,
        all.filter((o) => o.subscription?.status === s).length,
      ]),
    ),
  };
  const items =
    q.status === 'NONE'
      ? all.filter((o) => !o.subscription)
      : q.status
        ? all.filter((o) => o.subscription?.status === q.status)
        : all;
  res.json({ items, kpis });
});

/** Everything about one facility's subscription. */
async function organizationDetail(facilityId: string) {
  const [facility] = await db.select().from(facilities).where(eq(facilities.id, facilityId));
  if (!facility) throw notFound('Facility not found');
  const [row] = await db
    .select({ subscription: subscriptions, plan: subscriptionPlans })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .where(eq(subscriptions.facilityId, facilityId));
  const directors = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      isActive: users.isActive,
    })
    .from(users)
    .where(and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR')))
    .orderBy(asc(users.fullName));
  return {
    facility,
    subscription: row ? subscriptionSummary(row.subscription, row.plan) : null,
    seatsUsed: await seatsUsed(facilityId),
    seatLimit: row ? seatLimitOf(row.subscription) : null,
    events: row ? await eventsOf(row.subscription.id) : [],
    invoices: await invoicesOf(facilityId),
    directors,
  };
}

adminBillingRouter.get('/organizations/:facilityId', async (req, res) => {
  const { facilityId } = parse(FacilityParam, req.params);
  res.json(await organizationDetail(facilityId));
});

async function loadPlan(executor: Executor, planId: string, mustBeActive = true) {
  const [plan] = await executor
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, planId));
  if (!plan) throw badRequest('Plan not found');
  if (mustBeActive && !plan.isActive) throw badRequest('This plan is no longer offered');
  return plan;
}

const StartInput = z.object({
  planId: z.string().uuid(),
  billingCycle: Cycle.default('MONTHLY'),
  trial: z.boolean().default(true),
  seats: Seats.optional(),
  priceCents: Cents.optional(),
  note: z.string().trim().max(1000).optional().nullable(),
});

/**
 * Starts a facility's subscription (or restarts a cancelled or expired one): a trial for the number
 * of days in the operator settings, or an active subscription whose first invoice is issued now.
 * The plan's seat limit is agreed with it: a later edit of the plan does not change it.
 *
 * A restart reuses the facility's subscription, so invoices of the earlier contract that are still
 * open would count against the new one (overdue at once, suspended in the first run): they are
 * settled – paid or voided – first.
 */
async function startSubscription(
  tx: Executor,
  ctx: AuthContext,
  facilityId: string,
  input: z.infer<typeof StartInput>,
  meta: ReturnType<typeof requestMeta>,
) {
  const plan = await loadPlan(tx, input.planId);
  const settings = await settingsOf(tx);
  const now = new Date();
  const [existing] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.facilityId, facilityId))
    .for('update');
  if (existing && !['CANCELLED', 'EXPIRED'].includes(existing.status)) {
    throw conflict('This facility already has a subscription. Change its plan instead.');
  }
  if (existing) {
    const [open] = await tx
      .select({ n: count() })
      .from(invoices)
      .where(and(eq(invoices.subscriptionId, existing.id), eq(invoices.status, 'OPEN')));
    if (open && open.n > 0) {
      throw conflict(
        'Invoices of the earlier subscription are still open. Record their payment or void them before starting a new subscription.',
      );
    }
  }
  const trial = input.trial && settings.trialDays > 0;
  const periodEnd = trial
    ? addLocalDays(now, settings.trialDays)
    : addCycle(now, input.billingCycle);
  const values = {
    facilityId,
    planId: plan.id,
    status: trial ? ('TRIAL' as const) : ('ACTIVE' as const),
    billingCycle: input.billingCycle,
    priceCents: input.priceCents ?? planPrice(plan, input.billingCycle),
    nextBillingCycle: null,
    nextPriceCents: null,
    currency: plan.currency,
    seats: input.seats ?? null,
    planSeatLimit: plan.seatLimit,
    trialEndsAt: trial ? periodEnd : null,
    currentPeriodStart: now,
    currentPeriodEnd: periodEnd,
    billingAnchor: trial ? null : now,
    cancelAtPeriodEnd: false,
    pastDueSince: null,
    suspendedAt: null,
    suspensionCause: null,
    cancelledAt: null,
    createdById: ctx.userId,
  };
  const [subscription] = existing
    ? await tx
        .update(subscriptions)
        .set(values)
        .where(eq(subscriptions.id, existing.id))
        .returning()
    : await tx.insert(subscriptions).values(values).returning();
  const s = subscription!;
  await recordEvent(tx, {
    subscription: s,
    type: 'CREATED',
    actor: ctx,
    fromStatus: existing?.status ?? null,
    toStatus: s.status,
    toPlanId: plan.id,
    data: {
      billingCycle: s.billingCycle,
      priceCents: s.priceCents,
      seats: s.seats,
      restarted: Boolean(existing),
    },
    note: input.note ?? null,
  });
  if (trial) {
    await recordEvent(tx, {
      subscription: s,
      type: 'TRIAL_STARTED',
      actor: ctx,
      toStatus: 'TRIAL',
      data: { trialEndsAt: s.trialEndsAt, days: settings.trialDays },
    });
  }
  await auditChange(tx, ctx, s, { event: 'CREATED', planId: plan.id, status: s.status }, meta);
  if (!trial) {
    await issueInvoice(
      tx,
      s,
      { start: s.currentPeriodStart, end: s.currentPeriodEnd },
      { actor: ctx, meta },
    );
  }
  return s;
}

adminBillingRouter.post('/organizations/:facilityId/subscription', async (req, res) => {
  const ctx = requireAuth(req);
  const { facilityId } = parse(FacilityParam, req.params);
  const input = parse(StartInput, req.body);
  const [facility] = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.id, facilityId));
  if (!facility) throw notFound('Facility not found');
  await db.transaction((tx) => startSubscription(tx, ctx, facilityId, input, requestMeta(req)));
  res.status(201).json(await organizationDetail(facilityId));
});

const NewCustomerInput = z.object({
  facility: FacilityInput,
  director: z
    .object({
      email: z.string().trim().email().max(254),
      fullName: z.string().trim().min(2).max(200),
    })
    .optional()
    .nullable(),
  subscription: StartInput.optional().nullable(),
  billingProfile: BillingProfileInput.optional().nullable(),
});

/**
 * A new customer in one step: the facility, its billing details, its subscription (trial or
 * active) and, optionally, the first director's invitation (activation link shown once outside
 * production; e-mailed always). Starting a paid subscription needs the operator settings to be
 * complete (409 BILLING_NOT_READY otherwise, and nothing is created).
 */
adminBillingRouter.post('/organizations', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(NewCustomerInput, req.body);
  const meta = requestMeta(req);
  const [codeTaken] = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(eq(facilities.code, input.facility.code));
  if (codeTaken) throw conflict('Another facility already has this code');
  if (input.director) {
    const [emailTaken] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${input.director.email.toLowerCase()}`);
    if (emailTaken) throw conflict('An account with this e-mail address already exists');
  }
  const result = await db.transaction(async (tx) => {
    const [facility] = await tx.insert(facilities).values(input.facility).returning();
    const f = facility!;
    await ensureDefaultChannels(f.id, tx);
    await audit(
      {
        action: AuditAction.FACILITY_CREATED,
        actor: ctx,
        resourceType: 'facility',
        resourceId: f.id,
        meta,
        metadata: { code: f.code, source: 'admin' },
      },
      tx,
    );
    // The billing details before the first invoice, which copies them.
    if (input.billingProfile) {
      await saveBillingProfile(tx, f.id, input.billingProfile, ctx, meta);
    }
    // The director first, so the notice of the first invoice reaches them.
    let director: { id: string; email: string; activationUrl?: string } | null = null;
    if (input.director) {
      await assertSeatAvailable(f.id, tx);
      const invited = await createInvitedUser(
        tx,
        { ...input.director, role: 'DIRECTOR', facilityId: f.id },
        ctx.userId,
      );
      await audit(
        {
          action: AuditAction.ADMIN_USER_INVITED,
          actor: ctx,
          resourceType: 'user',
          resourceId: invited.user.id,
          meta,
          metadata: { role: 'DIRECTOR', facilityId: f.id, source: 'new customer' },
        },
        tx,
      );
      director = {
        id: invited.user.id,
        email: invited.user.email,
        activationUrl: invited.activationUrl,
      };
    }
    if (input.subscription) await startSubscription(tx, ctx, f.id, input.subscription, meta);
    return { facilityId: f.id, director };
  });
  res.status(201).json({
    ...(await organizationDetail(result.facilityId)),
    invitedDirector: result.director,
    // In production the link is only e-mailed, never shown.
    activationEmailed: Boolean(result.director),
    activationLinkShown: Boolean(result.director?.activationUrl) && !isProd,
  });
});

/* ------------------------------------------------------------------ subscription actions ----- */

/** Runs a change on a subscription under a row lock, then answers with the organisation view. */
async function withSubscription(
  req: Request,
  change: (
    tx: Executor,
    s: Subscription,
    ctx: AuthContext,
    meta: ReturnType<typeof requestMeta>,
  ) => Promise<void>,
) {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const facilityId = await db.transaction(async (tx) => {
    const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).for('update');
    if (!s) throw notFound('Subscription not found');
    await change(tx, s, ctx, meta);
    return s.facilityId;
  });
  return organizationDetail(facilityId);
}

const ChangeInput = z
  .object({
    planId: z.string().uuid().optional(),
    billingCycle: Cycle.optional(),
    seats: Seats.optional(),
    priceCents: Cents.optional(),
    note: z.string().trim().max(1000).optional().nullable(),
  })
  .refine(
    (v) =>
      v.planId !== undefined ||
      v.billingCycle !== undefined ||
      v.seats !== undefined ||
      v.priceCents !== undefined,
    'Nothing to change',
  );

/**
 * Plan, seats and price change now (the next invoice uses them). A new billing cycle waits for
 * the renewal: the running period was invoiced with its cycle and price and keeps them – also when
 * its invoice is voided and issued again. It is stored as a scheduled change with the price per
 * new cycle, and choosing the current cycle again withdraws it. A trial has no invoiced period, so
 * its cycle changes at once.
 */
adminBillingRouter.post('/subscriptions/:id/change', async (req, res) => {
  const input = parse(ChangeInput, req.body);
  res.json(
    await withSubscription(req, async (tx, s, ctx, meta) => {
      if (s.status === 'CANCELLED' || s.status === 'EXPIRED') {
        throw conflict('This subscription has ended. Start a new one instead.');
      }
      const planChanged = input.planId !== undefined && input.planId !== s.planId;
      const plan = await loadPlan(tx, input.planId ?? s.planId, planChanged);
      // The cycle the subscription renews with (a change may already be scheduled).
      const upcoming = s.nextBillingCycle ?? s.billingCycle;
      const target = input.billingCycle ?? upcoming;
      const trial = inTrialWindow(s);
      const scheduled = !trial && target !== s.billingCycle;
      // The price field is the price per the chosen cycle. A new plan or cycle takes the catalogue
      // price unless a price was agreed.
      let billingCycle = s.billingCycle;
      let price = s.priceCents;
      let nextBillingCycle: Subscription['nextBillingCycle'] = null;
      let nextPriceCents: number | null = null;
      if (scheduled) {
        nextBillingCycle = target;
        nextPriceCents =
          input.priceCents ??
          (planChanged || target !== upcoming || s.nextPriceCents === null
            ? planPrice(plan, target)
            : s.nextPriceCents);
        if (planChanged) price = planPrice(plan, s.billingCycle);
      } else {
        billingCycle = target;
        price =
          input.priceCents ??
          (planChanged || target !== s.billingCycle ? planPrice(plan, target) : s.priceCents);
      }
      const seats = input.seats !== undefined ? input.seats : s.seats;
      // A new plan brings its seat limit; the one agreed with the old plan no longer applies.
      const planSeatLimit = planChanged ? plan.seatLimit : s.planSeatLimit;
      const set = {
        planId: plan.id,
        billingCycle,
        priceCents: price,
        nextBillingCycle,
        nextPriceCents,
        seats,
        planSeatLimit,
      };
      await tx.update(subscriptions).set(set).where(eq(subscriptions.id, s.id));
      const note = input.note ?? null;
      // The note goes with the first history entry of the change.
      let noted = false;
      const once = () => {
        const n = noted ? null : note;
        noted = true;
        return n;
      };
      if (planChanged) {
        await recordEvent(tx, {
          subscription: s,
          type: 'PLAN_CHANGED',
          actor: ctx,
          fromPlanId: s.planId,
          toPlanId: plan.id,
          note: once(),
        });
      }
      if (billingCycle !== s.billingCycle) {
        await recordEvent(tx, {
          subscription: s,
          type: 'CYCLE_CHANGED',
          actor: ctx,
          data: { from: s.billingCycle, to: billingCycle },
          note: once(),
        });
      } else if (
        nextBillingCycle !== s.nextBillingCycle ||
        (nextBillingCycle && nextPriceCents !== s.nextPriceCents)
      ) {
        await recordEvent(tx, {
          subscription: s,
          type: 'CYCLE_CHANGED',
          actor: ctx,
          data: nextBillingCycle
            ? {
                from: s.billingCycle,
                to: nextBillingCycle,
                priceCents: nextPriceCents,
                currency: s.currency,
                effectiveAt: s.currentPeriodEnd,
                scheduled: true,
              }
            : { from: s.nextBillingCycle, to: s.billingCycle, withdrawn: true },
          note: once(),
        });
      }
      if (seats !== s.seats) {
        await recordEvent(tx, {
          subscription: s,
          type: 'SEATS_CHANGED',
          actor: ctx,
          data: { from: s.seats, to: seats, used: await seatsUsed(s.facilityId, tx) },
          note: once(),
        });
      }
      if (price !== s.priceCents) {
        await recordEvent(tx, {
          subscription: s,
          type: 'PRICE_CHANGED',
          actor: ctx,
          data: { from: s.priceCents, to: price, currency: s.currency },
          note: once(),
        });
      }
      await auditChange(tx, ctx, s, { event: 'CHANGED', ...set }, meta);
      if (planChanged) {
        await notifyDirectors(tx, s.facilityId, 'Your facility’s subscription was changed');
      }
    }),
  );
});

adminBillingRouter.post('/subscriptions/:id/activate', async (req, res) => {
  res.json(
    await withSubscription(req, async (tx, s, ctx, meta) => {
      if (s.status !== 'TRIAL') throw conflict('Only a trial can be activated');
      // The facility asked to leave after the trial: starting to bill it needs that withdrawn
      // first, visibly in the history and told to the directors.
      if (s.cancelAtPeriodEnd) {
        throw conflict(
          'A cancellation is scheduled for the end of the trial. Withdraw the cancellation first.',
        );
      }
      const now = new Date();
      const [updated] = await tx
        .update(subscriptions)
        .set({ status: 'ACTIVE', trialEndsAt: now, ...periodFrom(s, now, { renewal: false }) })
        .where(eq(subscriptions.id, s.id))
        .returning();
      await recordEvent(tx, {
        subscription: s,
        type: 'ACTIVATED',
        actor: ctx,
        fromStatus: 'TRIAL',
        toStatus: 'ACTIVE',
        data: { reason: 'activated before the end of the trial' },
      });
      await auditChange(tx, ctx, s, { event: 'ACTIVATED' }, meta);
      await issueInvoice(
        tx,
        updated!,
        { start: updated!.currentPeriodStart, end: updated!.currentPeriodEnd },
        { actor: ctx, meta },
      );
    }),
  );
});

const ReasonInput = z.object({ reason: Reason });

adminBillingRouter.post('/subscriptions/:id/suspend', async (req, res) => {
  const { reason } = parse(ReasonInput, req.body);
  res.json(
    await withSubscription(req, async (tx, s, ctx, meta) => {
      if (!['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(s.status)) {
        throw conflict('Only a running subscription can be suspended');
      }
      // Suspended by hand: a payment does not lift it, only reactivating does. A scheduled
      // cancellation stays and still takes effect at the end of the period.
      await tx
        .update(subscriptions)
        .set({ status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' })
        .where(eq(subscriptions.id, s.id));
      await recordEvent(tx, {
        subscription: s,
        type: 'SUSPENDED',
        actor: ctx,
        fromStatus: s.status,
        toStatus: 'SUSPENDED',
        data: { cause: 'MANUAL' },
        note: reason,
      });
      await auditChange(tx, ctx, s, { event: 'SUSPENDED', reason }, meta);
      await notifyDirectors(
        tx,
        s.facilityId,
        'Your facility’s subscription is suspended – new staff accounts cannot be added',
        {},
        true,
      );
    }),
  );
});

const NoteInput = z.object({ note: z.string().trim().max(1000).optional().nullable() });

/**
 * Reactivates a suspended subscription. A trial whose end date has not passed is a trial again.
 * With invoices still overdue it becomes "past due" with a fresh grace period (the administrator's
 * decision to give more time); otherwise active. A period that ended while suspended starts again
 * now, with its invoice (no back-billing) – unless a cancellation was scheduled for its end: then
 * the subscription ends as scheduled, without a new period or invoice, with the administrator's
 * note in the history, and the answer says so (`outcome: 'ENDED'`).
 */
adminBillingRouter.post('/subscriptions/:id/reactivate', async (req, res) => {
  const { note } = parse(NoteInput, req.body ?? {});
  let outcome: 'REACTIVATED' | 'ENDED' = 'REACTIVATED';
  const detail = await withSubscription(req, async (tx, s, ctx, meta) => {
    if (s.status !== 'SUSPENDED')
      throw conflict('Only a suspended subscription can be reactivated');
    const now = new Date();
    if (cancellationDue(s, now)) {
      await endAsScheduled(tx, s, { actor: ctx, meta, now, note: note ?? null });
      outcome = 'ENDED';
      return;
    }
    const overdue = (await overdueInvoices(tx, s.id, now)).length;
    const trial = inTrialWindow(s) && s.trialEndsAt! > now;
    const status = trial ? 'TRIAL' : overdue ? 'PAST_DUE' : 'ACTIVE';
    const newPeriod = !trial && s.currentPeriodEnd <= now;
    const [updated] = await tx
      .update(subscriptions)
      .set({
        status,
        suspendedAt: null,
        suspensionCause: null,
        pastDueSince: status === 'PAST_DUE' ? now : null,
        ...(newPeriod ? periodFrom(s, now, { renewal: false }) : {}),
      })
      .where(eq(subscriptions.id, s.id))
      .returning();
    await recordEvent(tx, {
      subscription: s,
      type: 'REACTIVATED',
      actor: ctx,
      fromStatus: 'SUSPENDED',
      toStatus: status,
      data: { overdueInvoices: overdue },
      note: note ?? null,
    });
    await auditChange(tx, ctx, s, { event: 'REACTIVATED', status }, meta);
    await notifyLifted(tx, updated!, now);
    if (newPeriod) {
      await recordScheduledCycle(tx, s, updated!, now);
      await issueInvoice(
        tx,
        updated!,
        { start: updated!.currentPeriodStart, end: updated!.currentPeriodEnd },
        { actor: ctx, meta },
      );
    }
  });
  // The cancellation date had passed: the subscription ended instead of being reactivated.
  res.json({ ...detail, outcome });
});

const CancelInput = z.object({ atPeriodEnd: z.boolean(), reason: Reason });

adminBillingRouter.post('/subscriptions/:id/cancel', async (req, res) => {
  const input = parse(CancelInput, req.body);
  res.json(
    await withSubscription(req, async (tx, s, ctx, meta) => {
      if (s.status === 'CANCELLED' || s.status === 'EXPIRED') {
        throw conflict('This subscription has already ended');
      }
      if (input.atPeriodEnd) {
        if (s.status === 'SUSPENDED') {
          throw conflict('A suspended subscription can only be cancelled now');
        }
        if (s.cancelAtPeriodEnd) throw conflict('The cancellation is already scheduled');
        await tx
          .update(subscriptions)
          .set({ cancelAtPeriodEnd: true })
          .where(eq(subscriptions.id, s.id));
        const endsAt =
          s.status === 'TRIAL' ? (s.trialEndsAt ?? s.currentPeriodEnd) : s.currentPeriodEnd;
        await recordEvent(tx, {
          subscription: s,
          type: 'CANCELLATION_SCHEDULED',
          actor: ctx,
          data: { endsAt },
          note: input.reason,
        });
        await auditChange(
          tx,
          ctx,
          s,
          { event: 'CANCELLATION_SCHEDULED', reason: input.reason },
          meta,
        );
        await notifyDirectors(tx, s.facilityId, 'Your facility’s subscription will end on {date}', {
          date: endsAt,
        });
        return;
      }
      // Open invoices – also the one of the current period – stay open: they are still owed, and
      // are paid or voided before the facility can subscribe again.
      await endSubscription(tx, s, { at: new Date(), actor: ctx, meta, note: input.reason });
    }),
  );
});

adminBillingRouter.post('/subscriptions/:id/withdraw-cancellation', async (req, res) => {
  res.json(
    await withSubscription(req, async (tx, s, ctx, meta) => {
      if (!s.cancelAtPeriodEnd) throw conflict('No cancellation is scheduled');
      await tx
        .update(subscriptions)
        .set({ cancelAtPeriodEnd: false })
        .where(eq(subscriptions.id, s.id));
      await recordEvent(tx, { subscription: s, type: 'CANCELLATION_WITHDRAWN', actor: ctx });
      await auditChange(tx, ctx, s, { event: 'CANCELLATION_WITHDRAWN' }, meta);
      await notifyDirectors(tx, s.facilityId, 'Your facility’s subscription will continue');
    }),
  );
});

const NoteRequired = z.object({ note: z.string().trim().min(2).max(1000) });

/** An internal note in the history (not shown to the facility). */
adminBillingRouter.post('/subscriptions/:id/notes', async (req, res) => {
  const { note } = parse(NoteRequired, req.body);
  res.json(
    await withSubscription(req, async (tx, s, ctx, meta) => {
      await recordEvent(tx, { subscription: s, type: 'NOTE', actor: ctx, note });
      await auditChange(tx, ctx, s, { event: 'NOTE' }, meta);
    }),
  );
});

/**
 * Issues the invoice for the current period, if it has none yet (e.g. after a price change), with
 * the period's billing cycle and the price per that cycle. Never for a trial period.
 */
adminBillingRouter.post('/subscriptions/:id/invoices', async (req, res) => {
  res.status(201).json(
    await withSubscription(req, async (tx, s, ctx, meta) => {
      if (s.status === 'TRIAL' || inTrialWindow(s)) throw conflict('A trial is not invoiced');
      if (s.status === 'CANCELLED' || s.status === 'EXPIRED') {
        throw conflict('This subscription has ended');
      }
      if (!periodMatchesCycle(s)) {
        throw conflict(
          'The current period does not match the billing cycle, so it cannot be invoiced at the price per cycle. The next period is invoiced as usual.',
        );
      }
      const [existing] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(
          and(
            eq(invoices.subscriptionId, s.id),
            eq(invoices.periodStart, s.currentPeriodStart),
            sql`${invoices.status} <> 'VOID'`,
          ),
        );
      if (existing) throw conflict('The current period already has an invoice');
      await issueInvoice(
        tx,
        s,
        { start: s.currentPeriodStart, end: s.currentPeriodEnd },
        { actor: ctx, meta },
      );
    }),
  );
});

/* ------------------------------------------------------------------ invoices ----------------- */

const InvoiceQuery = PaginationSchema.extend({
  status: z.enum(['open', 'overdue', 'paid', 'void', 'all']).default('all'),
  facilityId: z.string().uuid().optional(),
});

adminBillingRouter.get('/invoices', async (req, res) => {
  const q = parse(InvoiceQuery, req.query);
  const now = new Date();
  const filters: SQL[] = [];
  if (q.facilityId) filters.push(eq(invoices.facilityId, q.facilityId));
  if (q.status === 'open') filters.push(eq(invoices.status, 'OPEN'));
  if (q.status === 'overdue') filters.push(overdueWhere(now));
  if (q.status === 'paid') filters.push(eq(invoices.status, 'PAID'));
  if (q.status === 'void') filters.push(eq(invoices.status, 'VOID'));
  const where = filters.length ? and(...filters) : undefined;
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(invoices)
    .where(where);
  const rows = await db
    .select({ invoice: invoices, facilityName: facilities.name })
    .from(invoices)
    .innerJoin(facilities, eq(facilities.id, invoices.facilityId))
    .where(where)
    .orderBy(desc(invoices.issuedAt), desc(invoices.number))
    .limit(toOffset(q).limit)
    .offset(toOffset(q).offset);
  const lines = await invoiceLines(rows.map((r) => r.invoice.id));
  // The year in Kosovo, as in invoice numbers.
  const yearStart = yearStartOf(now);
  const [totals] = await db
    .select({
      openCents: sql<number>`coalesce(sum(${invoices.totalCents}) FILTER (WHERE ${invoices.status} = 'OPEN'), 0)::int`,
      openCount: sql<number>`count(*) FILTER (WHERE ${invoices.status} = 'OPEN')::int`,
      overdueCents: sql<number>`coalesce(sum(${invoices.totalCents}) FILTER (WHERE ${overdueWhere(now)}), 0)::int`,
      overdueCount: sql<number>`count(*) FILTER (WHERE ${overdueWhere(now)})::int`,
      paidThisYearCents: sql<number>`coalesce(sum(${invoices.totalCents}) FILTER (WHERE ${invoices.status} = 'PAID' AND ${invoices.paidAt} >= ${yearStart}), 0)::int`,
    })
    .from(invoices)
    .where(q.facilityId ? eq(invoices.facilityId, q.facilityId) : undefined);
  res.json({
    ...paginated(
      rows.map((r) =>
        presentInvoice(r.invoice, lines.get(r.invoice.id) ?? null, now, r.facilityName),
      ),
      total,
      q,
    ),
    totals: { ...totals, currency: 'EUR' },
  });
});

async function loadInvoice(id: string) {
  const [row] = await db
    .select({ invoice: invoices, facilityName: facilities.name })
    .from(invoices)
    .innerJoin(facilities, eq(facilities.id, invoices.facilityId))
    .where(eq(invoices.id, id));
  if (!row) throw notFound('Invoice not found');
  const lines = await invoiceLines([id]);
  return presentInvoice(row.invoice, lines.get(id) ?? null, new Date(), row.facilityName);
}

adminBillingRouter.get('/invoices/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await loadInvoice(id));
});

const PaymentInput = z.object({
  paidAt: z.coerce.date().optional(),
  method: z.enum(['BANK_TRANSFER', 'CASH', 'CARD', 'OTHER']),
  reference: z.string().trim().max(120).optional().nullable(),
});

/** Runs a change on an open invoice and its subscription, both locked. */
async function withOpenInvoice(
  req: Request,
  change: (
    tx: Executor,
    invoice: typeof invoices.$inferSelect,
    s: Subscription,
    ctx: AuthContext,
    meta: ReturnType<typeof requestMeta>,
  ) => Promise<void>,
) {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  await db.transaction(async (tx) => {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('update');
    if (!invoice) throw notFound('Invoice not found');
    if (invoice.status !== 'OPEN') {
      throw conflict(
        invoice.status === 'PAID'
          ? 'This invoice is already paid'
          : 'This invoice was voided and cannot be changed',
      );
    }
    const [s] = await tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, invoice.subscriptionId))
      .for('update');
    await change(tx, invoice, s!, ctx, meta);
  });
  return loadInvoice(id);
}

adminBillingRouter.post('/invoices/:id/payments', async (req, res) => {
  const input = parse(PaymentInput, req.body);
  const now = new Date();
  const paidAt = input.paidAt ?? now;
  if (paidAt.getTime() > now.getTime() + 86_400_000) {
    throw badRequest('The payment date cannot be in the future');
  }
  res.json(
    await withOpenInvoice(req, async (tx, invoice, s, ctx, meta) => {
      if (paidAt < new Date(invoice.issuedAt.getTime() - 86_400_000 * 365)) {
        throw badRequest('The payment date is too far before the invoice date');
      }
      // The payment settles the invoice in full (partial payments come with amounts). It is
      // also kept as a row of its own, so that it can be reversed; an invoice with nothing to
      // pay has no payment.
      if (invoice.totalCents > 0) {
        await tx.insert(invoicePayments).values({
          invoiceId: invoice.id,
          amountCents: invoice.totalCents,
          paidAt,
          method: input.method,
          reference: input.reference ?? null,
          recordedById: ctx.userId,
        });
      }
      await tx
        .update(invoices)
        .set({
          status: 'PAID',
          paidAt,
          paymentMethod: input.method,
          paymentReference: input.reference ?? null,
        })
        .where(eq(invoices.id, invoice.id));
      await recordEvent(tx, {
        subscription: s,
        type: 'PAYMENT_RECORDED',
        actor: ctx,
        data: {
          invoiceId: invoice.id,
          number: invoice.number,
          totalCents: invoice.totalCents,
          currency: invoice.currency,
          method: input.method,
          paidAt,
        },
      });
      await audit(
        {
          action: AuditAction.INVOICE_PAID,
          actor: ctx,
          resourceType: 'invoice',
          resourceId: invoice.id,
          meta,
          metadata: {
            number: invoice.number,
            method: input.method,
            facilityId: invoice.facilityId,
            totalCents: invoice.totalCents,
          },
        },
        tx,
      );
      await restoreStanding(tx, s, { actor: ctx, meta, now, reason: 'paid' });
    }),
  );
});

adminBillingRouter.post('/invoices/:id/void', async (req, res) => {
  const { reason } = parse(ReasonInput, req.body);
  res.json(
    await withOpenInvoice(req, async (tx, invoice, s, ctx, meta) => {
      await tx
        .update(invoices)
        .set({ status: 'VOID', voidedAt: new Date(), voidReason: reason })
        .where(eq(invoices.id, invoice.id));
      await recordEvent(tx, {
        subscription: s,
        type: 'INVOICE_VOIDED',
        actor: ctx,
        data: { invoiceId: invoice.id, number: invoice.number, totalCents: invoice.totalCents },
        note: reason,
      });
      await audit(
        {
          action: AuditAction.INVOICE_VOIDED,
          actor: ctx,
          resourceType: 'invoice',
          resourceId: invoice.id,
          meta,
          metadata: { number: invoice.number, reason, facilityId: invoice.facilityId },
        },
        tx,
      );
      await restoreStanding(tx, s, { actor: ctx, meta, reason: 'voided' });
    }),
  );
});
