import { Link, useLocation } from 'react-router-dom';
import { useMySubscription } from '../api/subscriptions';
import { formatDate } from '../format';
import { t } from '../i18n';
import { Alert } from './ui';

const WEEK = 7 * 86_400_000;

/**
 * For directors: a notice when the facility's subscription needs attention (trial ending, unpaid
 * invoice, suspended, ending). Never blocks clinical work; nothing is shown otherwise.
 */
export function SubscriptionNotice() {
  const { pathname } = useLocation();
  const query = useMySubscription();
  const s = query.data?.subscription;
  if (!s || pathname.startsWith('/director/subscription')) return null;
  let tone: 'info' | 'warning' = 'info';
  let title: string;
  if (s.status === 'SUSPENDED') {
    tone = 'warning';
    title = t('Your facility’s subscription is suspended – new staff accounts cannot be added');
  } else if (s.status === 'PAST_DUE') {
    tone = 'warning';
    title = t('Your facility’s subscription has an overdue invoice');
  } else if (s.cancelAtPeriodEnd && (s.status === 'TRIAL' || s.status === 'ACTIVE')) {
    title = t('Your facility’s subscription will end on {date}', {
      date: formatDate(s.status === 'TRIAL' ? s.trialEndsAt : s.currentPeriodEnd),
    });
  } else if (
    s.status === 'TRIAL' &&
    s.trialEndsAt &&
    new Date(s.trialEndsAt).getTime() - Date.now() <= WEEK
  ) {
    title = t('Your facility’s trial ends on {date}', { date: formatDate(s.trialEndsAt) });
  } else {
    return null;
  }
  return (
    <div className="no-print" style={{ marginBottom: '1rem' }}>
      <Alert tone={tone} title={title}>
        {t('Clinical work is not affected.')}{' '}
        <Link to="/director/subscription">{t('Subscription and invoices')}</Link>
      </Alert>
    </div>
  );
}
