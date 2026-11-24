/**
 * Demo plans, subscriptions with their history, and invoices (development seed only).
 *
 *  - QKUK (UCC-PR): active on "Hospital" (unlimited seats, so nothing in the demo is blocked),
 *    monthly; earlier invoices paid, the current one open.
 *  - Prizren (RH-PZ): "Clinic", monthly, started with a trial; an invoice is overdue (past due).
 *  - Pejë (FMC-PE): trial of "Family practice" that ends in five days (reminder already sent).
 *  - Poliklinika Dardania (PRIV-DRD, a private clinic added here): "Clinic", yearly, paid.
 *  - Gjilan (FMC-GJ): no subscription – a public facility.
 *
 * Runs once: skipped when plans exist (also against an already seeded database). Uses the
 * operator settings present at the time for VAT, payment terms and the issuer on invoices, so
 * it should run after the platform settings are seeded.
 */
import { eq } from 'drizzle-orm';
import { db, type Executor } from './client.js';
import {
  facilities,
  invoicePayments,
  invoices,
  subscriptionPlans,
  subscriptions,
  type facilityTypeEnum,
} from './schema.js';
import { ensureDefaultChannels } from '../modules/channels/channels.routes.js';
import {
  addCycle,
  addMonths,
  invoiceDescription,
  invoiceDueAt,
  nextInvoiceNumber,
  notifyDirectors,
  recordEvent,
  settingsOf,
  type BillingCycle,
  type Plan,
  type Subscription,
} from '../modules/subscriptions/subscriptions.service.js';

const DAY = 86_400_000;

/** `months` calendar months before `d` in Kosovo (same day of the month where it exists). */
const monthsBefore = (d: Date, months: number) => addMonths(d, -months);

interface InvoiceSpec {
  subscription: Subscription;
  plan: Plan;
  facility: typeof facilities.$inferSelect;
  start: Date;
  end: Date;
  issuedAt: Date;
  paidAt?: Date;
  method?: 'BANK_TRANSFER' | 'CASH' | 'CARD' | 'OTHER';
  reference?: string;
  byAdmin: boolean;
}

export async function seedSubscriptions(opts: { adminId: string }) {
  const [anyPlan] = await db.select({ id: subscriptionPlans.id }).from(subscriptionPlans).limit(1);
  if (anyPlan) {
    console.log('Subscription plans already exist – skipping the subscription seed.');
    return;
  }
  const now = new Date();
  const admin = { userId: opts.adminId, role: 'ADMIN' as const, facilityId: null };

  await db.transaction(async (tx) => {
    const settings = await settingsOf(tx);
    const plan = async (values: typeof subscriptionPlans.$inferInsert) =>
      (await tx.insert(subscriptionPlans).values(values).returning())[0]!;
    const family = await plan({
      code: 'FAMILY',
      name: 'Family practice',
      description: 'For a family medicine practice or a small health centre.',
      monthlyPriceCents: 4_900,
      yearlyPriceCents: 49_000,
      seatLimit: 10,
      features: ['Up to 10 staff accounts', 'Patient portal', 'E-mail support'],
      sortOrder: 1,
    });
    const clinic = await plan({
      code: 'CLINIC',
      name: 'Clinic',
      description: 'For a polyclinic or a specialised clinic.',
      monthlyPriceCents: 14_900,
      yearlyPriceCents: 149_000,
      seatLimit: 40,
      features: ['Up to 40 staff accounts', 'Laboratory and imaging', 'Priority support'],
      sortOrder: 2,
    });
    const hospital = await plan({
      code: 'HOSPITAL',
      name: 'Hospital',
      description: 'For a hospital: every module, unlimited staff accounts.',
      monthlyPriceCents: 99_000,
      yearlyPriceCents: 990_000,
      seatLimit: null,
      features: ['Unlimited staff accounts', 'Wards, emergency and theatres', '24/7 support'],
      sortOrder: 3,
    });

    const byCode = async (code: string) =>
      (await tx.select().from(facilities).where(eq(facilities.code, code)))[0];
    const ucc = await byCode('UCC-PR');
    const prizren = await byCode('RH-PZ');
    const peja = await byCode('FMC-PE');
    // A private clinic as a paying customer of the service.
    const dardania =
      (await byCode('PRIV-DRD')) ??
      (
        await tx
          .insert(facilities)
          .values({
            code: 'PRIV-DRD',
            name: 'Poliklinika Dardania',
            type: 'SPECIALIZED_CLINIC' satisfies (typeof facilityTypeEnum.enumValues)[number],
            region: 'Prishtinë',
            municipality: 'Prishtinë',
            address: 'Rr. Bill Clinton 22, Prishtinë',
            phone: '+383 38 600 600',
          })
          .returning()
      )[0]!;
    await ensureDefaultChannels(dardania.id, tx);

    const invoicesToIssue: InvoiceSpec[] = [];
    const subscribe = async (
      facility: typeof facilities.$inferSelect,
      p: Plan,
      values: {
        status: Subscription['status'];
        cycle: BillingCycle;
        createdAt: Date;
        periodStart: Date;
        periodEnd: Date;
        /** Start of the first paid period: renewals keep its day of the month. */
        billingAnchor?: Date;
        trialEndsAt?: Date;
        pastDueSince?: Date;
      },
    ) => {
      const [s] = await tx
        .insert(subscriptions)
        .values({
          facilityId: facility.id,
          planId: p.id,
          status: values.status,
          billingCycle: values.cycle,
          priceCents: values.cycle === 'YEARLY' ? p.yearlyPriceCents : p.monthlyPriceCents,
          currency: p.currency,
          planSeatLimit: p.seatLimit,
          trialEndsAt: values.trialEndsAt ?? null,
          currentPeriodStart: values.periodStart,
          currentPeriodEnd: values.periodEnd,
          billingAnchor: values.billingAnchor ?? null,
          pastDueSince: values.pastDueSince ?? null,
          createdById: opts.adminId,
          createdAt: values.createdAt,
        })
        .returning();
      await recordEvent(tx, {
        subscription: s!,
        type: 'CREATED',
        actor: admin,
        toStatus: values.trialEndsAt ? 'TRIAL' : 'ACTIVE',
        toPlanId: p.id,
        data: { billingCycle: values.cycle, priceCents: s!.priceCents, seats: null },
        at: values.createdAt,
      });
      if (values.trialEndsAt) {
        await recordEvent(tx, {
          subscription: s!,
          type: 'TRIAL_STARTED',
          actor: admin,
          toStatus: 'TRIAL',
          data: { trialEndsAt: values.trialEndsAt, days: 30 },
          at: values.createdAt,
        });
      }
      return s!;
    };

    // QKUK: active on Hospital for four months; the current period started three days ago.
    if (ucc) {
      const current = new Date(now.getTime() - 3 * DAY);
      const first = monthsBefore(current, 3);
      const s = await subscribe(ucc, hospital, {
        status: 'ACTIVE',
        cycle: 'MONTHLY',
        createdAt: first,
        periodStart: current,
        periodEnd: addCycle(current, 'MONTHLY'),
        // The earlier periods were counted back from the current one: its day of the month.
        billingAnchor: current,
      });
      for (let i = 3; i >= 0; i--) {
        const start = monthsBefore(current, i);
        const end = addCycle(start, 'MONTHLY', current);
        if (i < 3) {
          await recordEvent(tx, {
            subscription: s,
            type: 'RENEWED',
            actor: null,
            data: { periodStart: start, periodEnd: end },
            at: start,
          });
        }
        invoicesToIssue.push({
          subscription: s,
          plan: hospital,
          facility: ucc,
          start,
          end,
          issuedAt: start,
          ...(i > 0
            ? {
                paidAt: new Date(start.getTime() + (5 + i) * DAY),
                method: 'BANK_TRANSFER' as const,
                reference: `MSH-${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
              }
            : {}),
          byAdmin: i === 3,
        });
      }
    }

    // Prizren: a trial, then Clinic monthly; the second invoice is six days overdue.
    if (prizren) {
      const renewal = new Date(now.getTime() - 20 * DAY);
      const activation = monthsBefore(renewal, 1);
      const trialStart = new Date(activation.getTime() - 30 * DAY);
      const dueAt = invoiceDueAt(renewal, settings.paymentTermsDays);
      const overdue = dueAt < now;
      const s = await subscribe(prizren, clinic, {
        status: overdue ? 'PAST_DUE' : 'ACTIVE',
        cycle: 'MONTHLY',
        createdAt: trialStart,
        periodStart: renewal,
        periodEnd: addCycle(renewal, 'MONTHLY'),
        billingAnchor: renewal,
        trialEndsAt: activation,
        pastDueSince: overdue ? dueAt : undefined,
      });
      await recordEvent(tx, {
        subscription: s,
        type: 'REMINDER_SENT',
        actor: null,
        data: {
          key: `trial-ending:${activation.toISOString()}`,
          title: 'Your facility’s trial ends on {date}',
        },
        at: new Date(activation.getTime() - 7 * DAY),
      });
      await recordEvent(tx, {
        subscription: s,
        type: 'ACTIVATED',
        actor: null,
        fromStatus: 'TRIAL',
        toStatus: 'ACTIVE',
        data: { reason: 'trial ended' },
        at: activation,
      });
      invoicesToIssue.push({
        subscription: s,
        plan: clinic,
        facility: prizren,
        start: activation,
        end: renewal,
        issuedAt: activation,
        paidAt: new Date(activation.getTime() + 6 * DAY),
        method: 'BANK_TRANSFER',
        reference: 'SRP-0412',
        byAdmin: false,
      });
      await recordEvent(tx, {
        subscription: s,
        type: 'RENEWED',
        actor: null,
        data: { periodStart: renewal, periodEnd: addCycle(renewal, 'MONTHLY') },
        at: renewal,
      });
      invoicesToIssue.push({
        subscription: s,
        plan: clinic,
        facility: prizren,
        start: renewal,
        end: addCycle(renewal, 'MONTHLY'),
        issuedAt: renewal,
        byAdmin: false,
      });
      if (overdue) {
        const markedAt = new Date(dueAt.getTime() + 6 * 3_600_000);
        await recordEvent(tx, {
          subscription: s,
          type: 'MARKED_PAST_DUE',
          actor: null,
          fromStatus: 'ACTIVE',
          toStatus: 'PAST_DUE',
          data: {},
          at: markedAt,
        });
        await recordEvent(tx, {
          subscription: s,
          type: 'REMINDER_SENT',
          actor: null,
          data: {
            key: `past-due:${dueAt.toISOString()}`,
            title: 'Your facility’s subscription has an overdue invoice',
          },
          at: markedAt,
        });
        await notifyDirectors(
          tx,
          prizren.id,
          'Your facility’s subscription has an overdue invoice',
          {},
          true,
        );
      }
    }

    // Pejë: a 30-day trial of Family practice that ends in five days.
    if (peja) {
      const trialEnds = new Date(now.getTime() + 5 * DAY);
      const start = new Date(trialEnds.getTime() - 30 * DAY);
      const s = await subscribe(peja, family, {
        status: 'TRIAL',
        cycle: 'MONTHLY',
        createdAt: start,
        periodStart: start,
        periodEnd: trialEnds,
        trialEndsAt: trialEnds,
      });
      await recordEvent(tx, {
        subscription: s,
        type: 'REMINDER_SENT',
        actor: null,
        data: {
          key: `trial-ending:${trialEnds.toISOString()}`,
          title: 'Your facility’s trial ends on {date}',
        },
        at: new Date(trialEnds.getTime() - 7 * DAY),
      });
      await notifyDirectors(tx, peja.id, 'Your facility’s trial ends on {date}', {
        date: trialEnds,
      });
    }

    // Poliklinika Dardania: Clinic, paid for the year.
    {
      const start = new Date(now.getTime() - 130 * DAY);
      const s = await subscribe(dardania, clinic, {
        status: 'ACTIVE',
        cycle: 'YEARLY',
        createdAt: start,
        periodStart: start,
        periodEnd: addCycle(start, 'YEARLY'),
        billingAnchor: start,
      });
      await recordEvent(tx, {
        subscription: s,
        type: 'NOTE',
        actor: admin,
        note: 'Contract signed for twelve months; paid in advance.',
        at: new Date(start.getTime() + 3_600_000),
      });
      invoicesToIssue.push({
        subscription: s,
        plan: clinic,
        facility: dardania,
        start,
        end: addCycle(start, 'YEARLY'),
        issuedAt: start,
        paidAt: new Date(start.getTime() + 4 * DAY),
        method: 'BANK_TRANSFER',
        reference: 'PD-2026-001',
        byAdmin: true,
      });
    }

    // Invoices in the order they were issued, so the numbers follow the dates.
    invoicesToIssue.sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime());
    for (const spec of invoicesToIssue) await issueSeedInvoice(tx, spec, settings, admin);
  });
  console.log('Subscriptions seeded: plans, four facilities on plans, one without.');
}

async function issueSeedInvoice(
  tx: Executor,
  spec: InvoiceSpec,
  settings: Awaited<ReturnType<typeof settingsOf>>,
  admin: { userId: string; role: 'ADMIN'; facilityId: null },
) {
  const { subscription: s, plan, facility } = spec;
  const number = await nextInvoiceNumber(tx, settings.invoicePrefix, spec.issuedAt);
  const netCents = s.priceCents;
  const taxCents = Math.round((netCents * settings.vatRateBp) / 10_000);
  const [invoice] = await tx
    .insert(invoices)
    .values({
      number,
      facilityId: facility.id,
      subscriptionId: s.id,
      periodStart: spec.start,
      periodEnd: spec.end,
      description: invoiceDescription(plan.name, s.billingCycle, spec),
      netCents,
      taxRateBp: settings.vatRateBp,
      taxCents,
      totalCents: netCents + taxCents,
      currency: s.currency,
      status: spec.paidAt ? 'PAID' : 'OPEN',
      issuedAt: spec.issuedAt,
      dueAt: invoiceDueAt(spec.issuedAt, settings.paymentTermsDays),
      paidAt: spec.paidAt ?? null,
      paymentMethod: spec.method ?? null,
      paymentReference: spec.reference ?? null,
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
      createdById: spec.byAdmin ? admin.userId : null,
      createdAt: spec.issuedAt,
    })
    .returning();
  await recordEvent(tx, {
    subscription: s,
    type: 'INVOICE_ISSUED',
    actor: spec.byAdmin ? admin : null,
    data: {
      invoiceId: invoice!.id,
      number,
      totalCents: invoice!.totalCents,
      currency: invoice!.currency,
      planId: plan.id,
      planName: plan.name,
      cycle: s.billingCycle,
    },
    at: spec.issuedAt,
  });
  if (spec.paidAt) {
    // A paid invoice has its payment as a row of its own, as one recorded by the administrator.
    if (invoice!.totalCents > 0) {
      await tx.insert(invoicePayments).values({
        invoiceId: invoice!.id,
        amountCents: invoice!.totalCents,
        paidAt: spec.paidAt,
        method: spec.method ?? 'OTHER',
        reference: spec.reference ?? null,
        recordedById: admin.userId,
        createdAt: spec.paidAt,
      });
    }
    await recordEvent(tx, {
      subscription: s,
      type: 'PAYMENT_RECORDED',
      actor: admin,
      data: {
        invoiceId: invoice!.id,
        number,
        totalCents: invoice!.totalCents,
        currency: invoice!.currency,
        method: spec.method,
        paidAt: spec.paidAt,
      },
      at: spec.paidAt,
    });
  }
}
