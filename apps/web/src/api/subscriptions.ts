import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tone } from '../components/ui';
import { formatDate, formatNumber } from '../format';
import { intlLocale, t } from '../i18n';
import { formatMoney as formatEuro } from './billing';
import { api } from './client';
import type { Facility } from './types';

/*
 * Plans, facilities' subscriptions, their history, invoices and payments. Money is in integer
 * cents everywhere; a period ends where the next one starts, so its last day is the day before –
 * on the calendar in Kosovo, where billing happens. The subscription status never restricts
 * clinical work: it only limits new staff accounts.
 */

export const SUBSCRIPTION_STATUSES = [
  'TRIAL',
  'ACTIVE',
  'PAST_DUE',
  'SUSPENDED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export type BillingCycle = 'MONTHLY' | 'YEARLY';
/** Why a subscription is suspended: unpaid (a payment lifts it) or by an administrator. */
export type SuspensionCause = 'NON_PAYMENT' | 'MANUAL';
export type InvoiceStatus = 'OPEN' | 'PAID' | 'VOID';
export const PAYMENT_METHODS = ['BANK_TRANSFER', 'CASH', 'CARD', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type InvoiceFilter = 'open' | 'overdue' | 'paid' | 'void' | 'all';
export type SubscriptionEventType =
  | 'CREATED'
  | 'TRIAL_STARTED'
  | 'ACTIVATED'
  | 'PLAN_CHANGED'
  | 'SEATS_CHANGED'
  | 'PRICE_CHANGED'
  | 'CYCLE_CHANGED'
  | 'RENEWED'
  | 'INVOICE_ISSUED'
  | 'PAYMENT_RECORDED'
  | 'INVOICE_VOIDED'
  | 'MARKED_PAST_DUE'
  | 'SUSPENDED'
  | 'REACTIVATED'
  | 'CANCELLATION_SCHEDULED'
  | 'CANCELLATION_WITHDRAWN'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REMINDER_SENT'
  | 'NOTE';

export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  currency: string;
  /** Staff accounts included; null = unlimited. */
  seatLimit: number | null;
  features: string[];
  isActive: boolean;
  sortOrder: number;
  /** Running subscriptions on this plan (list only). */
  subscribers?: number;
}

export interface PlanInput {
  code: string;
  name: string;
  description: string | null;
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  seatLimit: number | null;
  features: string[];
  isActive: boolean;
  sortOrder: number;
}

/** The subscription fields both the administrator and the facility's directors see. */
export interface SubscriptionState {
  id: string;
  status: SubscriptionStatus;
  billingCycle: BillingCycle;
  /** Agreed price per billing cycle (of the current period). */
  priceCents: number;
  /** A change of billing cycle from the next period, with the price per new cycle. */
  nextBillingCycle: BillingCycle | null;
  nextPriceCents: number | null;
  currency: string;
  /** Seats bought; null = the plan's limit as agreed. */
  seats: number | null;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  /** Exclusive: the next period starts here. */
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  pastDueSince: string | null;
  suspendedAt: string | null;
  suspensionCause: SuspensionCause | null;
  cancelledAt: string | null;
}

export interface SubscriptionSummary extends SubscriptionState {
  /** The plan's seat limit agreed when the subscription started or changed plan; null = none. */
  planSeatLimit: number | null;
  notes: string | null;
  createdAt: string;
  plan: {
    id: string;
    code: string;
    name: string;
    seatLimit: number | null;
    monthlyPriceCents: number;
    yearlyPriceCents: number;
  };
}

export interface OrganizationRow {
  facility: Pick<
    Facility,
    'id' | 'code' | 'name' | 'type' | 'region' | 'municipality' | 'isActive'
  >;
  subscription: SubscriptionSummary | null;
  seatsUsed: number;
  /** null = unlimited (or no subscription). */
  seatLimit: number | null;
  openInvoices: number;
  overdueInvoices: number;
  monthlyValueCents: number;
}

export interface OrganizationList {
  items: OrganizationRow[];
  kpis: {
    mrrCents: number;
    currency: string;
    facilities: number;
    none: number;
    byStatus: Record<SubscriptionStatus, number>;
  };
}

export interface SubscriptionEvent {
  id: string;
  type: SubscriptionEventType;
  fromStatus: SubscriptionStatus | null;
  toStatus: SubscriptionStatus | null;
  fromPlan: { id: string; name: string } | null;
  toPlan: { id: string; name: string } | null;
  data: Record<string, unknown>;
  note: string | null;
  /** Who made the change; null = automatic (and always null in the facility's own view). */
  actor: { id: string; fullName: string } | null;
  /** Facility's own view: the change was made by the service operator. */
  byOperator?: boolean;
  createdAt: string;
}

export interface Invoice {
  id: string;
  number: string;
  facilityId: string;
  subscriptionId: string;
  periodStart: string;
  periodEnd: string;
  description: string;
  netCents: number;
  /** Basis points: 1800 = 18 %. */
  taxRateBp: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  status: InvoiceStatus;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  paymentMethod: PaymentMethod | null;
  paymentReference: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  /** The operator's details when the invoice was issued. */
  issuer: {
    name?: string | null;
    address?: string | null;
    fiscalNumber?: string | null;
    vatNumber?: string | null;
    iban?: string | null;
    bank?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  /** The facility's details when the invoice was issued. */
  customer: {
    name?: string | null;
    code?: string | null;
    address?: string | null;
    municipality?: string | null;
    region?: string | null;
  };
  facilityName: string | null;
  overdue: boolean;
  /** The plan and cycle the invoice was issued for. */
  line: { planName: string; cycle: BillingCycle } | null;
}

export interface InvoiceList {
  items: Invoice[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  totals: {
    openCents: number;
    openCount: number;
    overdueCents: number;
    overdueCount: number;
    paidThisYearCents: number;
    currency: string;
  };
}

export interface OrganizationDetail {
  facility: Facility;
  subscription: SubscriptionSummary | null;
  seatsUsed: number;
  seatLimit: number | null;
  events: SubscriptionEvent[];
  invoices: Invoice[];
  directors: { id: string; fullName: string; email: string; isActive: boolean }[];
}

export interface NewCustomerResult extends OrganizationDetail {
  invitedDirector: { id: string; email: string; activationUrl?: string } | null;
  activationEmailed: boolean;
  /** Outside production the activation link is returned once, to hand over. */
  activationLinkShown: boolean;
}

export interface MySubscription {
  facility: { id: string; name: string; code: string } | null;
  subscription: SubscriptionState | null;
  plan: {
    id: string;
    name: string;
    description: string | null;
    seatLimit: number | null;
    features: string[];
  } | null;
  seatsUsed: number;
  seatLimit: number | null;
  events: SubscriptionEvent[];
  invoices: Invoice[];
}

/* ------------------------------------------------------------------ queries ------------------ */

const KEY = ['subscriptions'] as const;

export function usePlans() {
  return useQuery({
    queryKey: [...KEY, 'plans'],
    queryFn: () => api<{ items: Plan[] }>('/admin/plans').then((r) => r.items),
  });
}

export function useOrganizations(filters: { q: string; status: string }) {
  return useQuery({
    queryKey: [...KEY, 'organizations', filters],
    queryFn: () =>
      api<OrganizationList>('/admin/organizations', {
        query: { q: filters.q, status: filters.status },
      }),
    placeholderData: (previous) => previous,
  });
}

export function useOrganization(facilityId: string | undefined) {
  return useQuery({
    queryKey: [...KEY, 'organization', facilityId],
    queryFn: () => api<OrganizationDetail>(`/admin/organizations/${facilityId}`),
    enabled: Boolean(facilityId),
  });
}

export function useInvoices(filters: { status: InvoiceFilter; facilityId: string; page: number }) {
  return useQuery({
    queryKey: [...KEY, 'invoices', filters],
    queryFn: () =>
      api<InvoiceList>('/admin/invoices', {
        query: { ...filters, pageSize: 25 },
      }),
    placeholderData: (previous) => previous,
  });
}

/** One invoice: the administrator's view, or a director's invoice of their own facility. */
export function useInvoice(id: string | undefined, scope: 'admin' | 'director') {
  return useQuery({
    queryKey: [...KEY, 'invoice', scope, id],
    queryFn: () =>
      api<Invoice>(scope === 'admin' ? `/admin/invoices/${id}` : `/subscription/invoices/${id}`),
    enabled: Boolean(id),
  });
}

/**
 * The signed-in director's facility subscription. It stays mounted for the whole session (the
 * notice in the layout), so it is fetched again when the window gets the focus back and every few
 * minutes: a recorded payment or a new status shows without signing out.
 */
export function useMySubscription(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'mine'],
    queryFn: () => api<MySubscription>('/subscription'),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    refetchInterval: 5 * 60_000,
  });
}

/* ------------------------------------------------------------------ changes ------------------ */

/**
 * A change to plans, subscriptions or invoices. Afterwards every subscription view, the
 * administrator's overview and facility lists are refreshed.
 */
export function useBillingMutation<V, R>(fn: (vars: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ['admin'] });
      void qc.invalidateQueries({ queryKey: ['facilities'] });
    },
  });
}

export const savePlan = ({ id, body }: { id?: string; body: Partial<PlanInput> }) =>
  id
    ? api<Plan>(`/admin/plans/${id}`, { method: 'PATCH', body })
    : api<Plan>('/admin/plans', { method: 'POST', body });

export type SubscriptionAction =
  | 'change'
  | 'activate'
  | 'suspend'
  | 'reactivate'
  | 'cancel'
  | 'withdraw-cancellation'
  | 'notes'
  | 'invoices';

export const subscriptionAction = ({
  id,
  action,
  body,
}: {
  id: string;
  action: SubscriptionAction;
  body?: Record<string, unknown>;
}) =>
  api<OrganizationDetail>(`/admin/subscriptions/${id}/${action}`, {
    method: 'POST',
    body: body ?? {},
  });

/* ------------------------------------------------------------------ wording ------------------ */

/**
 * Money from cents: "1 234,50 €" (Albanian), "1.234,50 €" (Serbian), "€1,234.50" (English). Euro
 * amounts use the app's own formatter (it does not depend on the browser's locale data).
 */
export function formatMoney(cents: number | null | undefined, currency = 'EUR'): string {
  if (currency === 'EUR') return formatEuro(cents);
  return new Intl.NumberFormat(intlLocale(), { style: 'currency', currency }).format(
    Number(cents ?? 0) / 100,
  );
}

/** "149,00" for a price field (the field takes euros; the API takes cents). */
export const centsToInput = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);

/** Euros typed in a field → cents; null when empty, NaN when not a valid amount. */
export function inputToCents(value: string): number | null {
  const v = value.replace(/\s|€/g, '').replace(',', '.');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN;
}

/** VAT rate from basis points: "18 %". */
export const formatRate = (bp: number) => `${formatNumber(bp / 100)} %`;

const kosovoParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Belgrade',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

/**
 * The calendar day of an instant in Kosovo (`days` later), as midday UTC of that day – shown as
 * that day in any time zone of Europe.
 */
function kosovoDay(iso: string, days = 0) {
  const p = Object.fromEntries(
    kosovoParts.formatToParts(new Date(iso)).map((x) => [x.type, Number(x.value)]),
  );
  return new Date(Date.UTC(p.year!, p.month! - 1, p.day! + days, 12)).toISOString();
}

/**
 * The last day of a period: the day before the one it ends on (the next period starts then) in
 * Kosovo – not "end − 24 hours", which is the wrong day across a change of the clocks.
 */
export const lastDayOf = (periodEnd: string) => kosovoDay(periodEnd, -1);

/** "12 Nov 2026 – 11 Dec 2026". */
export const periodText = (start: string, end: string) =>
  `${formatDate(kosovoDay(start))} – ${formatDate(lastDayOf(end))}`;

/** The current period is (still) the free trial: it is never invoiced. */
export const inTrialWindow = (s: Pick<SubscriptionState, 'trialEndsAt' | 'currentPeriodEnd'>) =>
  s.trialEndsAt !== null && new Date(s.currentPeriodEnd) <= new Date(s.trialEndsAt);

/**
 * The next date of the current period that matters, for the subscription's page: when it renews
 * (only an active or overdue subscription renews by itself), or when a scheduled cancellation ends
 * it (also while suspended). Null when neither applies – e.g. a suspended subscription starts a new
 * period only when the suspension is lifted.
 */
export function periodEndLine(
  s: Pick<SubscriptionState, 'status' | 'cancelAtPeriodEnd' | 'currentPeriodEnd'>,
): [string, string] | null {
  const running = s.status === 'ACTIVE' || s.status === 'PAST_DUE';
  if (s.cancelAtPeriodEnd && (running || s.status === 'SUSPENDED')) {
    return [t('Ends on'), formatDate(s.currentPeriodEnd)];
  }
  return running ? [t('Renews on'), formatDate(s.currentPeriodEnd)] : null;
}

/**
 * "Changes to yearly on 1 Dec 2026: €1,490.00 per year" for a scheduled change of cycle. A
 * suspended subscription does not renew on a date: the change comes with its next period.
 */
export function cycleChangeText(
  s: Pick<
    SubscriptionState,
    | 'status'
    | 'nextBillingCycle'
    | 'nextPriceCents'
    | 'currentPeriodEnd'
    | 'currency'
    | 'cancelAtPeriodEnd'
  >,
): string | null {
  if (!s.nextBillingCycle || s.cancelAtPeriodEnd) return null;
  const vars = {
    date: formatDate(s.currentPeriodEnd),
    price: formatMoney(s.nextPriceCents, s.currency),
  };
  const yearly = s.nextBillingCycle === 'YEARLY';
  if (s.status === 'SUSPENDED') {
    return yearly
      ? t('Changes to yearly with the next period: {price} per year', vars)
      : t('Changes to monthly with the next period: {price} per month', vars);
  }
  return yearly
    ? t('Changes to yearly on {date}: {price} per year', vars)
    : t('Changes to monthly on {date}: {price} per month', vars);
}

/** Why a subscription is suspended, for the administrator or for the facility's directors. */
export function suspensionCauseText(
  cause: SuspensionCause | null,
  audience: 'admin' | 'director',
): string {
  if (cause === 'NON_PAYMENT') {
    return t('An invoice remained unpaid after the grace period; paying it lifts the suspension.');
  }
  return audience === 'admin'
    ? t('Suspended by an administrator; only reactivating lifts it.')
    : t('Suspended by the service operator.');
}

/** Subscription states in plain words (the context keeps them apart from other "Active"s). */
export const subscriptionStatusLabel = (s: SubscriptionStatus) =>
  ({
    TRIAL: t('Trial|subscription status'),
    ACTIVE: t('Active|subscription status'),
    PAST_DUE: t('Payment overdue|subscription status'),
    SUSPENDED: t('Suspended|subscription status'),
    CANCELLED: t('Cancelled|subscription status'),
    EXPIRED: t('Expired|subscription status'),
  })[s] ?? s;

export const SUBSCRIPTION_TONE: Record<SubscriptionStatus, Tone> = {
  TRIAL: 'info',
  ACTIVE: 'success',
  PAST_DUE: 'warning',
  SUSPENDED: 'danger',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
};

export const cycleLabel = (c: BillingCycle) => (c === 'YEARLY' ? t('Yearly') : t('Monthly'));
/** "per month" / "per year" after a price. */
export const perCycle = (c: BillingCycle) => (c === 'YEARLY' ? t('per year') : t('per month'));

/** "Open", "Overdue", "Paid" or "Voided" – overdue is an open invoice past its due date. */
export function invoiceStateLabel(i: Pick<Invoice, 'status' | 'overdue'>): string {
  if (i.status === 'PAID') return t('Paid|invoice');
  if (i.status === 'VOID') return t('Voided|invoice');
  return i.overdue ? t('Overdue|invoice') : t('Open|invoice');
}

export function invoiceTone(i: Pick<Invoice, 'status' | 'overdue'>): Tone {
  if (i.status === 'PAID') return 'success';
  if (i.status === 'VOID') return 'neutral';
  return i.overdue ? 'danger' : 'warning';
}

export const paymentMethodLabel = (m: string | null | undefined) => {
  const labels: Record<string, string> = {
    BANK_TRANSFER: t('Bank transfer'),
    CASH: t('Cash'),
    CARD: t('Card'),
    OTHER: t('Other'),
  };
  return m ? (labels[m] ?? m) : '—';
};

/** Payment reference of an invoice with nothing to pay (issued as paid by the server). */
const NO_CHARGE = 'No charge';

/** An invoice with nothing to pay: issued as paid, never overdue. */
export const isNoCharge = (i: Pick<Invoice, 'paymentReference' | 'totalCents'>) =>
  i.totalCents === 0 && i.paymentReference === NO_CHARGE;

/** "Clinic plan – monthly" for an invoice line (from the plan and cycle it was issued for). */
export const invoiceLineText = (i: Pick<Invoice, 'line' | 'description'>) =>
  i.line
    ? i.line.cycle === 'YEARLY'
      ? t('{plan} plan – yearly', { plan: i.line.planName })
      : t('{plan} plan – monthly', { plan: i.line.planName })
    : i.description;

/** "12 of 40" or "12 (unlimited)". */
export const seatsText = (used: number, limit: number | null) =>
  limit === null
    ? t('{used} (no limit)', { used: formatNumber(used) })
    : t('{used} of {limit}', { used: formatNumber(used), limit: formatNumber(limit) });

/** Title of a history entry. */
export const eventLabel = (type: SubscriptionEventType) =>
  ({
    CREATED: t('Subscription created'),
    TRIAL_STARTED: t('Trial started'),
    ACTIVATED: t('Subscription activated'),
    PLAN_CHANGED: t('Plan changed'),
    SEATS_CHANGED: t('Number of staff accounts changed'),
    PRICE_CHANGED: t('Price changed'),
    CYCLE_CHANGED: t('Billing cycle changed'),
    RENEWED: t('Subscription renewed'),
    INVOICE_ISSUED: t('Invoice issued'),
    PAYMENT_RECORDED: t('Payment recorded'),
    INVOICE_VOIDED: t('Invoice voided'),
    MARKED_PAST_DUE: t('Payment overdue|subscription event'),
    SUSPENDED: t('Subscription suspended'),
    REACTIVATED: t('Subscription reactivated'),
    CANCELLATION_SCHEDULED: t('Cancellation scheduled'),
    CANCELLATION_WITHDRAWN: t('Cancellation withdrawn'),
    CANCELLED: t('Subscription cancelled'),
    EXPIRED: t('Subscription expired'),
    REMINDER_SENT: t('Reminder sent'),
    NOTE: t('Internal note'),
  })[type] ?? type;

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const seatWord = (v: unknown) =>
  num(v) === null ? t('as in the plan') : formatNumber(num(v) as number);
const cycleOf = (v: unknown) => (v === 'YEARLY' || v === 'MONTHLY' ? cycleLabel(v) : '—');

/** Why the system did something, for entries written by the subscription worker. */
const reasonText = (reason: string) =>
  ({
    'trial ended': t('The trial ended'),
    'activated before the end of the trial': t('Activated before the end of the trial'),
    'trial ended with a scheduled cancellation': t('The trial ended; the cancellation took effect'),
    'cancelled at the end of the period': t('Ended at the end of the period, as scheduled'),
    'unpaid after the grace period': t('An invoice remained unpaid after the grace period'),
    paid: t('The overdue invoices were settled'),
    voided: t('No invoice is overdue any more after a voided invoice'),
  })[reason] ?? reason;

/** What a history entry says, in one line (besides its title and note). */
export function describeEvent(e: SubscriptionEvent): string | null {
  const d = e.data ?? {};
  const reason = str(d.reason);
  switch (e.type) {
    case 'CREATED': {
      const parts = [
        e.toPlan ? t('{plan} plan', { plan: e.toPlan.name }) : null,
        cycleOf(d.billingCycle),
        num(d.priceCents) !== null ? formatMoney(num(d.priceCents)) : null,
      ].filter(Boolean);
      return `${d.restarted ? `${t('Started again')} · ` : ''}${parts.join(' · ')}`;
    }
    case 'TRIAL_STARTED':
      return str(d.trialEndsAt)
        ? t('Trial until {date}', { date: formatDate(str(d.trialEndsAt)) })
        : null;
    case 'PLAN_CHANGED':
      return `${e.fromPlan?.name ?? '—'} → ${e.toPlan?.name ?? '—'}`;
    case 'CYCLE_CHANGED': {
      if (d.withdrawn) {
        return t('The scheduled change to {cycle} was withdrawn', { cycle: cycleOf(d.from) });
      }
      const price =
        num(d.priceCents) !== null && (d.to === 'YEARLY' || d.to === 'MONTHLY')
          ? `${formatMoney(num(d.priceCents), str(d.currency) ?? 'EUR')} ${perCycle(d.to)}`
          : null;
      const when =
        d.scheduled && str(d.effectiveAt)
          ? t('from the renewal on {date}', { date: formatDate(str(d.effectiveAt)) })
          : null;
      return [`${cycleOf(d.from)} → ${cycleOf(d.to)}`, when, price].filter(Boolean).join(' · ');
    }
    case 'SEATS_CHANGED':
      return `${seatWord(d.from)} → ${seatWord(d.to)}`;
    case 'PRICE_CHANGED':
      return `${formatMoney(num(d.from))} → ${formatMoney(num(d.to))}`;
    case 'RENEWED':
      return str(d.periodStart) && str(d.periodEnd)
        ? t('New period: {period}', { period: periodText(str(d.periodStart)!, str(d.periodEnd)!) })
        : null;
    case 'INVOICE_ISSUED':
    case 'PAYMENT_RECORDED':
    case 'INVOICE_VOIDED': {
      const parts = [
        str(d.number),
        num(d.totalCents) !== null
          ? formatMoney(num(d.totalCents), str(d.currency) ?? 'EUR')
          : null,
        e.type === 'PAYMENT_RECORDED' ? paymentMethodLabel(str(d.method)) : null,
        e.type === 'PAYMENT_RECORDED' && str(d.paidAt)
          ? t('paid on {date}', { date: formatDate(str(d.paidAt)) })
          : null,
      ].filter(Boolean);
      return parts.join(' · ');
    }
    case 'MARKED_PAST_DUE': {
      const numbers = Array.isArray(d.invoices)
        ? d.invoices.filter((x) => typeof x === 'string')
        : [];
      return numbers.length ? t('Overdue: {invoices}', { invoices: numbers.join(', ') }) : null;
    }
    case 'CANCELLATION_SCHEDULED':
      return str(d.endsAt) ? t('Ends on {date}', { date: formatDate(str(d.endsAt)) }) : null;
    case 'REACTIVATED':
      if (reason) return reasonText(reason);
      return e.toStatus === 'PAST_DUE'
        ? t('Invoices are still overdue: a new grace period starts')
        : null;
    case 'REMINDER_SENT': {
      const key = str(d.key) ?? '';
      const at = key.slice(key.indexOf(':') + 1);
      if (key.startsWith('trial-ending:'))
        return t('The trial ends on {date}', { date: formatDate(at) });
      if (key.startsWith('renewal:'))
        return t('The subscription renews on {date}', { date: formatDate(at) });
      if (key.startsWith('past-due:')) return t('An invoice is overdue');
      if (key.startsWith('suspended:')) return t('New staff accounts cannot be added');
      return null;
    }
    default:
      return reason ? reasonText(reason) : null;
  }
}
