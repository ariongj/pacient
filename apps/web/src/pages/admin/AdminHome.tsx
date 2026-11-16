import { Link } from 'react-router-dom';
import { formatMoney, useAdminOverview, type AdminOverview } from '../../api/platform';
import {
  Badge,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  QueryView,
  Stat,
  Table,
} from '../../components/ui';
import { actionLabel, formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';
import {
  auditTarget,
  SUBSCRIPTION_TONE,
  subscriptionEventLabel,
  subscriptionStatusLabel,
} from './platform/labels';

const LINKS: { to: string; label: () => string; hint: () => string }[] = [
  {
    to: '/admin/organizations',
    label: () => t('Facilities and subscriptions'),
    hint: () => t('Plans, seats, renewals and the history of each facility.'),
  },
  {
    to: '/admin/invoices',
    label: () => t('Invoices and payments'),
    hint: () => t('Record payments; see what is open or overdue.'),
  },
  {
    to: '/admin/plans',
    label: () => t('Plans'),
    hint: () => t('What facilities can subscribe to.'),
  },
  {
    to: '/admin/users',
    label: () => t('Users'),
    hint: () => t('Invite, disable, unlock; reset sign-in.'),
  },
  {
    to: '/admin/settings',
    label: () => t('Operator settings'),
    hint: () => t('Company details, billing rules and the notice to all users.'),
  },
  {
    to: '/admin/legal',
    label: () => t('Terms and privacy'),
    hint: () => t('Publish versions; see who accepted them.'),
  },
  {
    to: '/admin/health',
    label: () => t('System health'),
    hint: () => t('E-mail and SMS queues, integrations, response times.'),
  },
  {
    to: '/admin/audit',
    label: () => t('Administrative audit'),
    hint: () => t('Every administrative action, with who and when.'),
  },
];

/** The platform administrator's home: the state of the service at a glance. */
export function AdminHome() {
  const overview = useAdminOverview();
  return (
    <>
      <PageHeader
        title={t('Platform overview')}
        subtitle={t('Facilities, subscriptions, users and the health of the service.')}
      />
      <QueryView query={overview}>{(o) => <Overview o={o} />}</QueryView>
      <Card title={t('Administration')}>
        <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {LINKS.map((l) => (
            <li key={l.to}>
              <Link to={l.to}>
                <strong>{l.label()}</strong>
              </Link>{' '}
              <span className="muted">– {l.hint()}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

function Overview({ o }: { o: AdminOverview }) {
  const s = o.facilities.byStatus;
  const money = (cents: number) => formatMoney(cents, o.revenue.currency);
  return (
    <>
      <Grid min={190}>
        <Stat
          label={t('Facilities')}
          value={o.facilities.total}
          hint={t('{count} with a subscription', { count: o.facilities.withSubscription })}
        />
        <Stat
          label={t('Active subscriptions')}
          value={s.ACTIVE}
          hint={t('{trial} on trial · {overdue} with payment overdue', {
            trial: s.TRIAL,
            overdue: s.PAST_DUE,
          })}
        />
        <Stat
          label={t('Suspended subscriptions')}
          value={s.SUSPENDED}
          tone={s.SUSPENDED > 0 ? 'danger' : undefined}
        />
        <Stat
          label={t('Monthly recurring revenue')}
          value={money(o.revenue.mrrCents)}
          hint={t('Active and overdue subscriptions; yearly plans counted per month.')}
        />
        <Stat
          label={t('Overdue invoices')}
          value={money(o.revenue.overdueCents)}
          hint={t('{count} overdue · {open} open in total', {
            count: o.revenue.overdueCount,
            open: money(o.revenue.openCents),
          })}
          tone={o.revenue.overdueCount > 0 ? 'warning' : undefined}
        />
        <Stat
          label={t('Active staff accounts')}
          value={o.users.activeStaff}
          hint={t('{count} waiting for activation', { count: o.users.pendingActivation })}
        />
        <Stat
          label={t('Staff without two-step sign-in')}
          value={o.users.staffWithoutTwoStep}
          tone={o.users.staffWithoutTwoStep > 0 ? 'warning' : undefined}
        />
        <Stat
          label={t('Locked accounts')}
          value={o.users.locked}
          tone={o.users.locked > 0 ? 'warning' : undefined}
        />
        <Stat label={t('Patients with a portal account')} value={o.users.patientAccounts} />
      </Grid>

      <Card title={t('Renewals in the next 30 days')}>
        {o.renewals.length === 0 ? (
          <EmptyState title={t('No renewals in the next 30 days')} />
        ) : (
          <Table caption={t('Renewals in the next 30 days')}>
            <thead>
              <tr>
                <th scope="col">{t('Facility')}</th>
                <th scope="col">{t('Plan')}</th>
                <th scope="col">{t('Status')}</th>
                <th scope="col">{t('Date')}</th>
                <th scope="col">{t('Price')}</th>
              </tr>
            </thead>
            <tbody>
              {o.renewals.map((r) => (
                <tr key={r.subscriptionId}>
                  <td>
                    <Link to={`/admin/organizations/${r.facilityId}`}>{r.facilityName}</Link>
                  </td>
                  <td>{r.planName}</td>
                  <td>
                    <Badge tone={SUBSCRIPTION_TONE[r.status]}>
                      {subscriptionStatusLabel(r.status)}
                    </Badge>
                    {r.cancelAtPeriodEnd && (
                      <div className="muted">{t('Ends on this date (cancelled)')}</div>
                    )}
                  </td>
                  <td>
                    {formatDate(r.date)}
                    {r.status === 'TRIAL' && <div className="muted">{t('Trial ends')}</div>}
                  </td>
                  <td>
                    {formatMoney(r.priceCents, r.currency)}{' '}
                    <span className="muted">
                      {r.billingCycle === 'YEARLY' ? t('per year') : t('per month')}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Grid min={320}>
        <Card title={t('Recent subscription events')}>
          {o.recentEvents.length === 0 ? (
            <EmptyState title={t('No subscription events yet')} />
          ) : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {o.recentEvents.map((e) => (
                <li key={e.id}>
                  <strong>{subscriptionEventLabel(e.type)}</strong> ·{' '}
                  <Link to={`/admin/organizations/${e.facilityId}`}>{e.facilityName}</Link>
                  <div className="muted">
                    {formatDateTime(e.createdAt)} · {e.actorName ?? t('Automatic')}
                    {e.toStatus && ` · ${subscriptionStatusLabel(e.toStatus)}`}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title={t('Recent administrative actions')}
          actions={<Link to="/admin/audit">{t('All actions')}</Link>}
        >
          {o.recentActions.length === 0 ? (
            <EmptyState title={t('No administrative actions yet')} />
          ) : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {o.recentActions.map((a) => (
                <li key={a.id}>
                  <strong>{actionLabel(a.action)}</strong>
                  {auditTarget(a) && <> · {auditTarget(a)}</>}
                  <div className="muted">
                    {formatDateTime(a.occurredAt)} · {a.actorName ?? t('Automatic')}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Grid>
    </>
  );
}
