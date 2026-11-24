import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../../../api/client';
import {
  centsToInput,
  cycleLabel,
  formatMoney,
  inputToCents,
  inTrialWindow,
  perCycle,
  periodText,
  subscriptionAction,
  useBillingMutation,
  type BillingCycle,
  type Invoice,
  type OrganizationDetail,
  type Plan,
  type SubscriptionAction,
  type SubscriptionActionResult,
  type SubscriptionSummary,
} from '../../../api/subscriptions';
import {
  Alert,
  Button,
  ErrorAlert,
  formValues,
  SelectField,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDate, formatNumber } from '../../../format';
import { t } from '../../../i18n';
import { BillingNotReadyNote, useBillingNotReady } from '../home/BillingReadinessCard';

export const CYCLE_OPTIONS = () =>
  (['MONTHLY', 'YEARLY'] as const).map((c) => ({ value: c, label: cycleLabel(c) }));

const planPrice = (plan: Plan | undefined, cycle: BillingCycle) =>
  plan ? (cycle === 'YEARLY' ? plan.yearlyPriceCents : plan.monthlyPriceCents) : 0;

export const planOption = (p: Plan) => ({
  value: p.id,
  label: `${p.name} · ${formatMoney(p.monthlyPriceCents, p.currency)} ${t('per month')}`,
});

/** The plan's seat limit that applies when no seats are agreed (null = no limit). */
const seatHint = (limit: number | null | undefined) =>
  limit
    ? t('Empty: as in the plan ({count})', { count: formatNumber(limit) })
    : t('Empty: as in the plan (no limit)');

function Actions({
  onDone,
  pending,
  submit,
  danger,
}: {
  onDone: () => void;
  pending: boolean;
  submit: string;
  danger?: boolean;
}) {
  return (
    <div className="form-actions">
      <Button variant="secondary" onClick={onDone}>
        {t('Cancel')}
      </Button>
      <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={pending}>
        {submit}
      </Button>
    </div>
  );
}

/** Plan, cycle, trial, seats and an agreed price: the fields of a new subscription. */
export function StartFields({ plans }: { plans: Plan[] }) {
  const billingNotReady = useBillingNotReady();
  const noteId = useId();
  const offered = plans.filter((p) => p.isActive);
  const [planId, setPlanId] = useState(offered[0]?.id ?? '');
  const [cycle, setCycle] = useState<BillingCycle>('MONTHLY');
  const plan = offered.find((p) => p.id === planId);
  return (
    <>
      <div className="form-grid">
        <SelectField
          label={t('Plan')}
          name="planId"
          required
          value={planId}
          onChange={(e) => setPlanId(e.target.value)}
          options={offered.map(planOption)}
        />
        <SelectField
          label={t('Billing cycle')}
          name="billingCycle"
          value={cycle}
          onChange={(e) => setCycle(e.target.value as BillingCycle)}
          options={CYCLE_OPTIONS()}
        />
        <TextField
          label={t('Staff accounts (seats)')}
          name="seats"
          type="number"
          min={1}
          max={100000}
          hint={seatHint(plan?.seatLimit)}
        />
        <TextField
          label={t('Agreed price per cycle (€)')}
          name="price"
          type="number"
          min={0}
          step="0.01"
          hint={t('Empty: the plan price, {price}', {
            price: `${formatMoney(planPrice(plan, cycle))} ${perCycle(cycle)}`,
          })}
        />
      </div>
      {/* Starting paid issues the first invoice now: not offered while billing is not ready. */}
      <label className="checkbox">
        <input
          // Remounted (checked again) when billing turns out not to be ready.
          key={billingNotReady ? 'trial-only' : 'trial-or-paid'}
          type="checkbox"
          name="trial"
          value="yes"
          defaultChecked
          disabled={billingNotReady}
          aria-describedby={billingNotReady ? `${noteId}-billing` : undefined}
        />
        {t('Start with a free trial (no invoice until it ends)')}
      </label>
      {billingNotReady && (
        <>
          {/* A disabled checkbox is not submitted: the trial is sent all the same. */}
          <input type="hidden" name="trial" value="yes" />
          <BillingNotReadyNote id={`${noteId}-billing`} />
        </>
      )}
    </>
  );
}

/** Reads the fields of StartFields; null when a price is not a valid amount. */
export function readStart(v: Record<string, string>) {
  const price = inputToCents(v.price ?? '');
  if (Number.isNaN(price)) return null;
  return {
    planId: v.planId,
    billingCycle: v.billingCycle || 'MONTHLY',
    trial: v.trial === 'yes',
    ...(v.seats ? { seats: Number(v.seats) } : {}),
    ...(price !== null ? { priceCents: price } : {}),
    ...(v.note ? { note: v.note } : {}),
  };
}

export function StartForm({
  facilityId,
  plans,
  onDone,
}: {
  facilityId: string;
  plans: Plan[];
  onDone: () => void;
}) {
  const [invalid, setInvalid] = useState(false);
  const mutation = useBillingMutation((body: Record<string, unknown>) =>
    api<OrganizationDetail>(`/admin/organizations/${facilityId}/subscription`, {
      method: 'POST',
      body,
    }),
  );
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = readStart(formValues(e.currentTarget));
    setInvalid(!body);
    if (body) mutation.mutate(body, { onSuccess: onDone });
  }
  if (!plans.some((p) => p.isActive)) {
    return <Alert tone="warning" title={t('No plan is offered. Create a plan first.')} />;
  }
  return (
    <form onSubmit={onSubmit}>
      <StartFields plans={plans} />
      <TextAreaField
        label={t('Note')}
        name="note"
        maxLength={1000}
        rows={2}
        hint={t('Shown to the facility’s directors in the history.')}
      />
      <p className="muted">
        {t(
          'Without a trial the subscription is active now and its first invoice is issued at once.',
        )}
      </p>
      {invalid && <Alert tone="danger" title={t('Enter the price as an amount, e.g. 149.00')} />}
      <ErrorAlert error={mutation.error} />
      <Actions onDone={onDone} pending={mutation.isPending} submit={t('Start subscription')} />
    </form>
  );
}

/**
 * Change plan, cycle, seats or price. Plan, seats and price take effect now (the next invoice uses
 * them); a new billing cycle takes effect at the renewal – the current period keeps its cycle and
 * price – and choosing the current cycle again withdraws it. A trial changes its cycle at once.
 */
export function ChangeForm({
  subscription: s,
  plans,
  onDone,
}: {
  subscription: SubscriptionSummary;
  plans: Plan[];
  onDone: () => void;
}) {
  const choices = plans.filter((p) => p.isActive || p.id === s.plan.id);
  // The cycle the subscription renews with, and its price (a change may already be scheduled).
  const upcoming = s.nextBillingCycle ?? s.billingCycle;
  const agreedPrice = (c: BillingCycle) =>
    c === s.nextBillingCycle && s.nextPriceCents !== null
      ? s.nextPriceCents
      : c === s.billingCycle
        ? s.priceCents
        : null;
  const [planId, setPlanId] = useState(s.plan.id);
  const [cycle, setCycle] = useState<BillingCycle>(upcoming);
  const [price, setPrice] = useState(centsToInput(agreedPrice(upcoming)));
  const [problem, setProblem] = useState<string | null>(null);
  const plan = plans.find((p) => p.id === planId);
  const mutation = useBillingMutation(subscriptionAction);
  const atRenewal = !inTrialWindow(s) && cycle !== s.billingCycle;

  // A new plan or cycle proposes its catalogue price; the field can still be changed.
  const choose = (nextPlan: string, nextCycle: BillingCycle) => {
    setPlanId(nextPlan);
    setCycle(nextCycle);
    const p = plans.find((x) => x.id === nextPlan);
    const agreed = nextPlan === s.plan.id ? agreedPrice(nextCycle) : null;
    setPrice(centsToInput(agreed ?? planPrice(p, nextCycle)));
  };

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const cents = inputToCents(price);
    if (cents === null || Number.isNaN(cents)) {
      setProblem(t('Enter the price as an amount, e.g. 149.00'));
      return;
    }
    const seats = v.seats ? Number(v.seats) : null;
    const body: Record<string, unknown> = {};
    if (planId !== s.plan.id) body.planId = planId;
    if (cycle !== upcoming) body.billingCycle = cycle;
    if (seats !== s.seats) body.seats = seats;
    if (cents !== agreedPrice(cycle) || body.planId || body.billingCycle) body.priceCents = cents;
    if (Object.keys(body).length === 0) {
      setProblem(t('Nothing to change'));
      return;
    }
    if (v.note) body.note = v.note;
    setProblem(null);
    mutation.mutate({ id: s.id, action: 'change', body }, { onSuccess: onDone });
  }

  return (
    <form onSubmit={onSubmit}>
      <div className="form-grid">
        <SelectField
          label={t('Plan')}
          name="planId"
          value={planId}
          onChange={(e) => choose(e.target.value, cycle)}
          options={choices.map(planOption)}
        />
        <SelectField
          label={t('Billing cycle')}
          name="billingCycle"
          value={cycle}
          onChange={(e) => choose(planId, e.target.value as BillingCycle)}
          options={CYCLE_OPTIONS()}
        />
        <TextField
          label={t('Staff accounts (seats)')}
          name="seats"
          type="number"
          min={1}
          max={100000}
          defaultValue={s.seats ?? ''}
          hint={seatHint(planId === s.plan.id ? s.planSeatLimit : plan?.seatLimit)}
        />
        <TextField
          label={t('Agreed price per cycle (€)')}
          name="price"
          type="number"
          min={0}
          step="0.01"
          required
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          hint={t('Plan price: {price}', {
            price: `${formatMoney(planPrice(plan, cycle))} ${perCycle(cycle)}`,
          })}
        />
      </div>
      <TextAreaField
        label={t('Note')}
        name="note"
        maxLength={1000}
        rows={2}
        hint={t('Shown to the facility’s directors in the history.')}
      />
      <p className="muted">
        {t(
          'Plan, seats and price take effect now; the current invoice stays as issued and the next one uses the new terms.',
        )}{' '}
        {atRenewal &&
          t(
            'The new billing cycle starts with the next period, on {date}; the current period keeps its cycle and price. Choose the current cycle again to withdraw it.',
            { date: formatDate(s.currentPeriodEnd) },
          )}
      </p>
      {problem && <Alert tone="danger" title={problem} />}
      <ErrorAlert error={mutation.error} />
      <Actions onDone={onDone} pending={mutation.isPending} submit={t('Save changes')} />
    </form>
  );
}

/** A reason or note, then one subscription action (suspend, cancel, reactivate, note). */
export function ReasonForm({
  subscriptionId,
  action,
  field,
  required,
  label,
  hint,
  intro,
  submit,
  danger,
  extra,
  onResult,
  onDone,
}: {
  subscriptionId: string;
  action: SubscriptionAction;
  field: 'reason' | 'note';
  required: boolean;
  label: string;
  hint?: string;
  intro?: ReactNode;
  submit: string;
  danger?: boolean;
  extra?: (v: Record<string, string>) => Record<string, unknown>;
  /** Sees the answer before the form closes (e.g. what reactivating did). */
  onResult?: (result: SubscriptionActionResult) => void;
  onDone: () => void;
}) {
  const mutation = useBillingMutation(subscriptionAction);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    const body: Record<string, unknown> = { ...(extra?.(v) ?? {}) };
    if (v[field]) body[field] = v[field];
    mutation.mutate(
      { id: subscriptionId, action, body },
      {
        onSuccess: (result) => {
          onResult?.(result);
          onDone();
        },
      },
    );
  }
  return (
    <form onSubmit={onSubmit}>
      {intro}
      <TextAreaField
        label={label}
        name={field}
        required={required}
        minLength={required ? (field === 'reason' ? 5 : 2) : undefined}
        maxLength={1000}
        rows={3}
        hint={hint}
      />
      <ErrorAlert error={mutation.error} />
      <Actions onDone={onDone} pending={mutation.isPending} submit={submit} danger={danger} />
    </form>
  );
}

/**
 * Cancel now or at the end of the period (a suspended subscription only now). Open invoices – also
 * the one of the current period – stay open after cancelling: the form says so.
 */
export function CancelForm({
  subscription: s,
  invoices,
  onDone,
}: {
  subscription: SubscriptionSummary;
  invoices: Invoice[];
  onDone: () => void;
}) {
  const end = s.status === 'TRIAL' ? (s.trialEndsAt ?? s.currentPeriodEnd) : s.currentPeriodEnd;
  const canWait = s.status !== 'SUSPENDED' && !s.cancelAtPeriodEnd;
  const open = invoices.filter((i) => i.status === 'OPEN');
  const current = open.find((i) => i.periodStart === s.currentPeriodStart);
  return (
    <ReasonForm
      subscriptionId={s.id}
      action="cancel"
      field="reason"
      required
      label={t('Reason')}
      hint={t('Shown to the facility’s directors in the history.')}
      submit={t('Cancel subscription')}
      danger
      extra={(v) => ({ atPeriodEnd: v.when !== 'now' })}
      onDone={onDone}
      intro={
        <fieldset>
          <legend>{t('When')}</legend>
          <div className="stack" style={{ gap: '0.5rem' }}>
            {canWait && (
              <label className="checkbox">
                <input type="radio" name="when" value="end" defaultChecked />
                {t('At the end of the period, on {date} (no further invoice)', {
                  date: formatDate(end),
                })}
              </label>
            )}
            <label className="checkbox">
              <input type="radio" name="when" value="now" defaultChecked={!canWait} />
              {t('Now')}
            </label>
          </div>
          <p className="muted">
            {t(
              'Ending the subscription never blocks clinical work or existing accounts; it only stops new staff accounts and invoices.',
            )}
          </p>
          {current && (
            <Alert
              tone="info"
              title={t('The invoice of the current period, {number}, stays open.', {
                number: current.number,
              })}
            >
              {t(
                'Cancelling now does not void it: record its payment, or void it if the facility owes nothing for this period.',
              )}
            </Alert>
          )}
          {open.length > 0 && (
            <p className="muted">
              {t(
                'A new subscription can be started for this facility only when none of its invoices is open.',
              )}
            </p>
          )}
        </fieldset>
      }
    />
  );
}

/** A one-click action with an explanation (activate, withdraw a cancellation, invoice now). */
export function ConfirmForm({
  subscriptionId,
  action,
  children,
  submit,
  onDone,
}: {
  subscriptionId: string;
  action: SubscriptionAction;
  children: ReactNode;
  submit: string;
  onDone: () => void;
}) {
  const mutation = useBillingMutation(subscriptionAction);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    mutation.mutate({ id: subscriptionId, action }, { onSuccess: onDone });
  }
  return (
    <form onSubmit={onSubmit}>
      {children}
      <ErrorAlert error={mutation.error} />
      <Actions onDone={onDone} pending={mutation.isPending} submit={submit} />
    </form>
  );
}

/** "Clinic plan – €149.00 per month" for confirmations. */
export const termsText = (s: SubscriptionSummary) =>
  `${s.plan.name} · ${formatMoney(s.priceCents, s.currency)} ${perCycle(s.billingCycle)}`;

export const currentPeriodText = (s: SubscriptionSummary) =>
  periodText(s.currentPeriodStart, s.currentPeriodEnd);
