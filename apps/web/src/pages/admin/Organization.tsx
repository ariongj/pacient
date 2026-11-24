import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  cycleChangeText,
  cycleLabel,
  formatMoney,
  inTrialWindow,
  perCycle,
  periodEndLine,
  periodText,
  suspensionCauseText,
  useOrganization,
  usePlans,
  type OrganizationDetail,
  type SubscriptionSummary,
} from '../../api/subscriptions';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  Loading,
  PageHeader,
  QueryView,
} from '../../components/ui';
import { formatDate, humanize } from '../../format';
import { t } from '../../i18n';
import { SubscriptionHistory } from './billing/History';
import { InvoiceTable } from './billing/InvoiceTable';
import { SeatsMeter, SubscriptionBadge } from './billing/parts';
import {
  CancelForm,
  ChangeForm,
  ConfirmForm,
  currentPeriodText,
  ReasonForm,
  StartForm,
  termsText,
} from './billing/SubscriptionForms';

type Action =
  | 'start'
  | 'change'
  | 'activate'
  | 'suspend'
  | 'reactivate'
  | 'cancel'
  | 'withdraw'
  | 'note'
  | 'invoice';

const TITLES: Record<Action, () => string> = {
  start: () => t('Start subscription'),
  change: () => t('Change plan, cycle, seats or price'),
  activate: () => t('End the trial now'),
  suspend: () => t('Suspend subscription'),
  reactivate: () => t('Reactivate subscription'),
  cancel: () => t('Cancel subscription'),
  withdraw: () => t('Withdraw the cancellation'),
  note: () => t('Add an internal note'),
  invoice: () => t('Invoice the current period'),
};

const running = (s: SubscriptionSummary) =>
  s.status === 'TRIAL' || s.status === 'ACTIVE' || s.status === 'PAST_DUE';

function SubscriptionCard({
  detail,
  onAction,
}: {
  detail: OrganizationDetail;
  onAction: (a: Action) => void;
}) {
  const s = detail.subscription!;
  const ended = s.status === 'CANCELLED' || s.status === 'EXPIRED';
  const invoiced = detail.invoices.some(
    (i) => i.status !== 'VOID' && i.periodStart === s.currentPeriodStart,
  );
  const cycleChange = cycleChangeText(s);
  const items: [string, ReactNode][] = [
    [t('Plan'), s.plan.name],
    [t('Status'), <SubscriptionBadge key="s" status={s.status} />],
    [
      t('Billing cycle'),
      <>
        {cycleLabel(s.billingCycle)}
        {cycleChange && <div className="muted">{cycleChange}</div>}
      </>,
    ],
    [
      t('Price'),
      <>
        {formatMoney(s.priceCents, s.currency)} {perCycle(s.billingCycle)}
        {s.priceCents !==
          (s.billingCycle === 'YEARLY' ? s.plan.yearlyPriceCents : s.plan.monthlyPriceCents) && (
          <div className="muted">{t('Agreed price')}</div>
        )}
      </>,
    ],
  ];
  if (s.status === 'TRIAL') items.push([t('Trial ends'), formatDate(s.trialEndsAt)]);
  // A suspended subscription does not renew: its period is shown while it runs, and a new one
  // starts when the suspension is lifted.
  const periodRunning = new Date(s.currentPeriodEnd).getTime() > Date.now();
  if (!ended && s.status !== 'TRIAL' && (s.status !== 'SUSPENDED' || periodRunning)) {
    items.push([t('Current period'), currentPeriodText(s)]);
  }
  const endLine = periodEndLine(s);
  if (endLine) items.push(endLine);
  if (s.pastDueSince) items.push([t('Payment overdue since'), formatDate(s.pastDueSince)]);
  if (s.status === 'SUSPENDED') {
    items.push([t('Suspended since'), formatDate(s.suspendedAt)]);
    items.push([t('Cause of the suspension'), suspensionCauseText(s.suspensionCause, 'admin')]);
    // What reactivating does next (with a scheduled cancellation it ends as scheduled instead): a
    // trial that has not ended continues without an invoice, a running period keeps renewing on
    // its date, and only a period that has ended starts again on the day of reactivation.
    const trialRunning =
      inTrialWindow(s) && s.trialEndsAt !== null && new Date(s.trialEndsAt).getTime() > Date.now();
    if (!s.cancelAtPeriodEnd) {
      items.push([
        t('Next period'),
        trialRunning
          ? t('The trial continues if reactivated before {date}', {
              date: formatDate(s.trialEndsAt),
            })
          : periodRunning
            ? t('Renews on {date} if reactivated before then', {
                date: formatDate(s.currentPeriodEnd),
              })
            : t('Starts when the suspension is lifted, with its invoice'),
      ]);
    }
  }
  if (s.cancelledAt) items.push([t('Ended on'), formatDate(s.cancelledAt)]);
  items.push([t('Customer since'), formatDate(s.createdAt)]);

  return (
    <Card
      title={t('Subscription')}
      actions={
        ended ? (
          <Button onClick={() => onAction('start')}>{t('Start a new subscription')}</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => onAction('change')}>
              {t('Change')}
            </Button>
            {/* A facility that asked to leave after the trial is not billed: withdraw first. */}
            {s.status === 'TRIAL' && !s.cancelAtPeriodEnd && (
              <Button variant="secondary" onClick={() => onAction('activate')}>
                {t('End the trial now')}
              </Button>
            )}
            {s.status !== 'TRIAL' && !inTrialWindow(s) && !invoiced && (
              <Button variant="secondary" onClick={() => onAction('invoice')}>
                {t('Invoice the current period')}
              </Button>
            )}
            {s.status === 'SUSPENDED' ? (
              <Button onClick={() => onAction('reactivate')}>{t('Reactivate')}</Button>
            ) : (
              running(s) && (
                <Button variant="secondary" onClick={() => onAction('suspend')}>
                  {t('Suspend')}
                </Button>
              )
            )}
            {s.cancelAtPeriodEnd ? (
              <Button variant="secondary" onClick={() => onAction('withdraw')}>
                {t('Withdraw the cancellation')}
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => onAction('cancel')}>
              {t('Cancel subscription')}
            </Button>
          </>
        )
      }
    >
      <div className="stack">
        {s.status === 'SUSPENDED' && (
          <Alert tone="warning" title={t('New staff accounts cannot be added.')}>
            {t('Clinical work, sign-in and existing accounts are not affected.')}
          </Alert>
        )}
        {s.cancelAtPeriodEnd && (
          <Alert
            tone="info"
            title={t('Ends on {date}', {
              date: formatDate(s.status === 'TRIAL' ? s.trialEndsAt : s.currentPeriodEnd),
            })}
          >
            {s.status === 'TRIAL' &&
              t('To start the paid subscription instead, withdraw the cancellation first.')}
          </Alert>
        )}
        <DefinitionList items={items} />
        <SeatsMeter used={detail.seatsUsed} limit={detail.seatLimit} />
        {s.seats !== null && (
          <p className="muted">
            {t('Seats agreed for this facility instead of the plan’s limit.')}
          </p>
        )}
        <div>
          <Button variant="ghost" size="sm" onClick={() => onAction('note')}>
            {t('Add an internal note')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ActionForm({
  action,
  detail,
  onEnded,
  onDone,
}: {
  action: Action;
  detail: OrganizationDetail;
  /** Reactivating found the cancellation date passed: the subscription ended instead. */
  onEnded: () => void;
  onDone: () => void;
}) {
  const plans = usePlans();
  const s = detail.subscription;
  if (action === 'start' || action === 'change') {
    if (plans.isPending) return <Loading />;
    if (plans.error) return <ErrorAlert error={plans.error} />;
    return action === 'start' || !s ? (
      <StartForm facilityId={detail.facility.id} plans={plans.data} onDone={onDone} />
    ) : (
      <ChangeForm subscription={s} plans={plans.data} onDone={onDone} />
    );
  }
  if (!s) return null;
  switch (action) {
    case 'activate':
      return (
        <ConfirmForm
          subscriptionId={s.id}
          action="activate"
          submit={t('End the trial now')}
          onDone={onDone}
        >
          <p>
            {t('The subscription becomes active today and its first invoice is issued: {terms}.', {
              terms: termsText(s),
            })}
          </p>
        </ConfirmForm>
      );
    case 'invoice':
      return (
        <ConfirmForm
          subscriptionId={s.id}
          action="invoices"
          submit={t('Issue invoice')}
          onDone={onDone}
        >
          <p>
            {t('An invoice for {period} is issued now: {terms}, plus VAT.', {
              period: periodText(s.currentPeriodStart, s.currentPeriodEnd),
              terms: termsText(s),
            })}
          </p>
        </ConfirmForm>
      );
    case 'withdraw':
      return (
        <ConfirmForm
          subscriptionId={s.id}
          action="withdraw-cancellation"
          submit={t('Withdraw the cancellation')}
          onDone={onDone}
        >
          <p>{t('The subscription continues and renews as usual. The directors are told.')}</p>
        </ConfirmForm>
      );
    case 'suspend':
      return (
        <ReasonForm
          subscriptionId={s.id}
          action="suspend"
          field="reason"
          required
          label={t('Reason')}
          hint={t('Shown to the facility’s directors in the history.')}
          submit={t('Suspend')}
          danger
          onDone={onDone}
          intro={
            <Alert tone="warning" title={t('New staff accounts cannot be added while suspended.')}>
              {t('Clinical work, sign-in and existing accounts are not affected.')}
            </Alert>
          }
        />
      );
    case 'reactivate': {
      const endsInstead =
        s.cancelAtPeriodEnd && new Date(s.currentPeriodEnd).getTime() <= Date.now();
      return (
        <ReasonForm
          subscriptionId={s.id}
          action="reactivate"
          field="note"
          required={false}
          label={t('Note')}
          hint={t('Shown to the facility’s directors in the history.')}
          submit={t('Reactivate')}
          onResult={(r) => r.outcome === 'ENDED' && onEnded()}
          onDone={onDone}
          intro={
            <>
              <p>
                {t(
                  'A trial that has not ended is a trial again. With invoices still overdue, the subscription shows the overdue payment again with a new grace period. A period that ended meanwhile starts again today, with its invoice – unless a cancellation was scheduled for its end: then the subscription ends as scheduled.',
                )}
              </p>
              {endsInstead && (
                <Alert
                  tone="warning"
                  title={t(
                    'The cancellation date has passed: the subscription ends as scheduled instead of being reactivated.',
                  )}
                />
              )}
            </>
          }
        />
      );
    }
    case 'cancel':
      return <CancelForm subscription={s} invoices={detail.invoices} onDone={onDone} />;
    case 'note':
      return (
        <ReasonForm
          subscriptionId={s.id}
          action="notes"
          field="note"
          required
          label={t('Internal note')}
          hint={t('Only administrators see it; not shown to the facility.')}
          submit={t('Add note')}
          onDone={onDone}
        />
      );
    default:
      return null;
  }
}

/** Subscription, history and invoices of one facility. */
export function Organization() {
  const { facilityId } = useParams();
  const query = useOrganization(facilityId);
  const [action, setAction] = useState<Action | null>(null);
  const [endedInstead, setEndedInstead] = useState(false);
  const close = () => setAction(null);
  const open = (a: Action) => {
    setEndedInstead(false);
    setAction(a);
  };

  return (
    <QueryView query={query}>
      {(d) => (
        <>
          <PageHeader
            title={d.facility.name}
            subtitle={`${d.facility.code} · ${humanize(d.facility.type)} · ${d.facility.municipality}`}
            actions={
              <Link to={`/admin/invoices?facilityId=${d.facility.id}`}>{t('All invoices')}</Link>
            }
          />
          <div className="stack">
            {!d.facility.isActive && (
              <Alert tone="info" title={t('This facility is deactivated.')} />
            )}
            {endedInstead && (
              <Alert
                tone="info"
                title={t(
                  'The subscription was not reactivated: its cancellation date had passed, so it ended as scheduled.',
                )}
              />
            )}
            {d.subscription ? (
              <SubscriptionCard detail={d} onAction={open} />
            ) : (
              <Card title={t('Subscription')}>
                <EmptyState title={t('No subscription')}>
                  {t('Start one to bill this facility and to set its number of staff accounts.')}
                </EmptyState>
                <div className="form-actions">
                  <Button onClick={() => open('start')}>{t('Start subscription')}</Button>
                </div>
                <SeatsMeter used={d.seatsUsed} limit={null} />
              </Card>
            )}
            <Card title={t('Invoices')}>
              <InvoiceTable invoices={d.invoices} audience="admin" />
            </Card>
            <div className="two-col">
              <Card title={t('History')}>
                <SubscriptionHistory events={d.events} audience="admin" />
              </Card>
              <Card title={t('Directors')}>
                {d.directors.length === 0 ? (
                  <EmptyState title={t('No director yet')}>
                    {t('Invite one from the users page; the director invites the staff.')}
                  </EmptyState>
                ) : (
                  <ul className="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                    {d.directors.map((u) => (
                      <li key={u.id}>
                        <Link to={`/admin/users/${u.id}`}>{u.fullName}</Link>{' '}
                        {!u.isActive && <Badge>{t('Inactive')}</Badge>}
                        <div className="muted">{u.email}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
          <Dialog
            open={action !== null}
            onClose={close}
            title={action ? TITLES[action]() : ''}
            wide={action === 'change' || action === 'start'}
          >
            {action && (
              <ActionForm
                action={action}
                detail={d}
                onEnded={() => setEndedInstead(true)}
                onDone={close}
              />
            )}
          </Dialog>
        </>
      )}
    </QueryView>
  );
}
