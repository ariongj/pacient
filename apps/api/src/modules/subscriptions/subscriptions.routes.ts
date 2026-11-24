import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { facilities, invoices, subscriptionPlans, subscriptions } from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { parse, requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  eventsOf,
  invoiceLines,
  invoicesOf,
  presentInvoice,
  seatLimitOf,
  seatsUsed,
} from './subscriptions.service.js';

/**
 * A facility's own subscription, history and invoices (/subscription): its directors. The
 * operator's internal notes are not shown, and changes are attributed to "the service operator"
 * rather than to a named administrator.
 */
export const subscriptionRouter = Router();
subscriptionRouter.use(authenticate, requireRole('DIRECTOR'));

function ownFacility(req: Parameters<typeof requireAuth>[0]) {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  return ctx.facilityId;
}

subscriptionRouter.get('/', async (req, res) => {
  const facilityId = ownFacility(req);
  const [facility] = await db
    .select({ id: facilities.id, name: facilities.name, code: facilities.code })
    .from(facilities)
    .where(eq(facilities.id, facilityId));
  const [row] = await db
    .select({ subscription: subscriptions, plan: subscriptionPlans })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .where(eq(subscriptions.facilityId, facilityId));
  const events = row ? await eventsOf(row.subscription.id) : [];
  res.json({
    facility: facility ?? null,
    subscription: row
      ? {
          id: row.subscription.id,
          status: row.subscription.status,
          billingCycle: row.subscription.billingCycle,
          priceCents: row.subscription.priceCents,
          // A change of billing cycle from the next period, with the price per new cycle.
          nextBillingCycle: row.subscription.nextBillingCycle,
          nextPriceCents: row.subscription.nextPriceCents,
          currency: row.subscription.currency,
          seats: row.subscription.seats,
          trialEndsAt: row.subscription.trialEndsAt,
          currentPeriodStart: row.subscription.currentPeriodStart,
          currentPeriodEnd: row.subscription.currentPeriodEnd,
          cancelAtPeriodEnd: row.subscription.cancelAtPeriodEnd,
          pastDueSince: row.subscription.pastDueSince,
          suspendedAt: row.subscription.suspendedAt,
          suspensionCause: row.subscription.suspensionCause,
          cancelledAt: row.subscription.cancelledAt,
        }
      : null,
    plan: row
      ? {
          id: row.plan.id,
          name: row.plan.name,
          description: row.plan.description,
          seatLimit: row.plan.seatLimit,
          features: row.plan.features,
        }
      : null,
    seatsUsed: await seatsUsed(facilityId),
    seatLimit: row ? seatLimitOf(row.subscription) : null,
    // Internal notes stay with the operator; who changed what is "the service operator".
    events: events
      .filter((e) => e.type !== 'NOTE')
      .map((e) => ({
        ...e,
        actor: null,
        byOperator: e.actor !== null,
        data: e.type === 'REMINDER_SENT' ? { key: e.data.key } : e.data,
      })),
    invoices: await invoicesOf(facilityId),
  });
});

const IdParam = z.object({ id: z.string().uuid() });

subscriptionRouter.get('/invoices/:id', async (req, res) => {
  const facilityId = ownFacility(req);
  const { id } = parse(IdParam, req.params);
  const [row] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.id, id), eq(invoices.facilityId, facilityId)));
  if (!row) throw notFound('Invoice not found');
  const lines = await invoiceLines([id]);
  res.json(presentInvoice(row, lines.get(id) ?? null));
});
