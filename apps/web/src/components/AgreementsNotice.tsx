import { Link, useLocation } from 'react-router-dom';
import { useMyAgreements } from '../api/agreements';
import { t, useLocale } from '../i18n';
import { legalKindLabel } from '../pages/admin/platform/labels';
import { Alert } from './ui';

/**
 * A non-blocking banner for directors whose facility has not accepted the current service
 * agreement or data processing agreement, with a link to accept them. Only for a customer (a
 * facility whose subscription has not ended), the facilities the operator's list counts too: a
 * facility without a subscription, or whose subscription ended, is not asked (it may still accept
 * on the subscription page). Never blocks anything: when the check fails or is slow, nothing is
 * shown (H74). Placed in Layout for DIRECTOR only; not on the subscription page itself, which
 * shows the agreements.
 */
export function AgreementsNotice() {
  const { pathname } = useLocation();
  const { locale } = useLocale();
  const query = useMyAgreements(locale);
  const pending = query.data?.asked
    ? query.data.agreements.filter((a) => a.pending && a.document)
    : [];
  if (!pending.length || pathname.startsWith('/director/subscription')) return null;
  return (
    <div className="no-print" style={{ marginBottom: '1rem' }}>
      <Alert
        tone="info"
        title={t('Your facility has not yet accepted: {agreements}', {
          agreements: pending.map((a) => legalKindLabel(a.kind)).join(', '),
        })}
      >
        {t('One director accepts them for the facility. Nothing is blocked meanwhile.')}{' '}
        <Link to="/director/subscription#agreements">{t('Read and accept')}</Link>
      </Alert>
    </div>
  );
}
