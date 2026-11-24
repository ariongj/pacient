import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client';
import { ADMIN_PLATFORM_KEY } from '../../../api/platform';
import { useUser } from '../../../auth/AuthContext';
import { Alert, DefinitionList } from '../../../components/ui';
import { formatDate, formatDateTime } from '../../../format';
import { t } from '../../../i18n';

/** GET /admin/settings/bank-change: the latest change of the IBAN or bank in the last 14 days. */
interface BankChange {
  changedAt: string;
  changedById: string | null;
  changedByName: string | null;
  fields: string[];
  operatorIban: string | null;
  operatorBank: string | null;
}

/**
 * Platform overview (AdminHome): "Bank details changed on …" for 14 days after the IBAN or bank was
 * changed, with who changed them and what they are now. Changing where customers pay is what a
 * stolen administrator session would do first; the other administrators are also told at once
 * (notification and e-mail), and this keeps it in front of everyone who opens the overview.
 * Renders nothing when there was no change, or when it cannot be loaded (the overview stays usable).
 */
export function BankChangeCard() {
  const me = useUser();
  const query = useQuery({
    queryKey: [...ADMIN_PLATFORM_KEY, 'bank-change'],
    queryFn: () => api<{ change: BankChange | null }>('/admin/settings/bank-change'),
    // Fresh whenever the overview opens (e.g. right after saving the settings), and while it stays open.
    staleTime: 0,
    refetchInterval: 60_000,
  });
  const change = query.data?.change;
  if (!change) return null;

  const time = formatDateTime(change.changedAt);
  const who =
    change.changedById === me.id
      ? t('You changed the bank details printed on invoices ({time}).', { time })
      : t('{name} changed the bank details printed on invoices ({time}).', {
          name: change.changedByName ?? t('An administrator'),
          time,
        });
  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <Alert
        tone="warning"
        title={t('Bank details changed on {date}', { date: formatDate(change.changedAt) })}
      >
        <p style={{ margin: '0 0 0.5rem' }}>{who}</p>
        <DefinitionList
          items={[
            [t('IBAN'), change.operatorIban ? <code>{change.operatorIban}</code> : null],
            [t('Bank'), change.operatorBank],
          ]}
        />
        <p style={{ margin: '0.5rem 0 0' }}>
          {t(
            'Customers pay to the account printed on their invoices. If nobody expected this change, correct it before the next invoice is issued.',
          )}{' '}
          <Link to="/admin/settings">{t('Check the operator settings')}</Link>
        </p>
      </Alert>
    </div>
  );
}
