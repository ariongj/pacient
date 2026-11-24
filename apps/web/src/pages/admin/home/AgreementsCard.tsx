import { Link } from 'react-router-dom';
import { useAgreementsOverview } from '../../../api/agreements';
import { Card, Table } from '../../../components/ui';
import { t } from '../../../i18n';
import { legalKindLabel, subscriptionStatusLabel } from '../platform/labels';
import type { SubscriptionStatus } from '../../../api/platform';

const SHOWN = 10;

/**
 * Platform overview (AdminHome): customer facilities without the current service agreement or
 * data processing agreement, or – while neither is published – a reminder to publish them.
 * Fetches its own data and renders nothing when there is nothing to show (no customers, or all up
 * to date); it sits between other cards of the page, so it has its own bottom margin. Round 2,
 * builder G.
 */
export function AgreementsCard() {
  const query = useAgreementsOverview();
  const d = query.data;
  if (!d || d.customers === 0) return null;
  const unpublished = d.kinds.filter((k) => !k.currentVersion);
  if (!d.items.length && !unpublished.length) return null;
  return (
    <div style={{ marginBottom: '1rem' }}>
      <Card
        title={t('Facilities without the current agreements')}
        actions={<Link to="/admin/legal?kind=SERVICE_AGREEMENT">{t('The agreement texts')}</Link>}
      >
        {unpublished.length > 0 && (
          <p>
            {t('Not published yet: {agreements}.', {
              agreements: unpublished.map((k) => legalKindLabel(k.kind)).join(', '),
            })}{' '}
            <span className="muted">
              {t(
                'Publish them under Terms and privacy; then the directors are asked to accept them.',
              )}
            </span>
          </p>
        )}
        {d.items.length > 0 && (
          <>
            <p className="muted">
              {t(
                '{count} of {customers} customer facilities have not accepted everything yet. Their directors see a notice; nothing is blocked.',
                { count: d.items.length, customers: d.customers },
              )}
            </p>
            <Table caption={t('Facilities without the current agreements')}>
              <thead>
                <tr>
                  <th scope="col">{t('Facility')}</th>
                  <th scope="col">{t('Not accepted yet')}</th>
                  <th scope="col">{t('Subscription')}</th>
                </tr>
              </thead>
              <tbody>
                {d.items.slice(0, SHOWN).map((f) => (
                  <tr key={f.facilityId}>
                    <td>
                      <Link to={`/admin/organizations/${f.facilityId}`}>{f.facilityName}</Link>
                    </td>
                    <td>{f.missing.map(legalKindLabel).join(', ')}</td>
                    <td>{subscriptionStatusLabel(f.subscriptionStatus as SubscriptionStatus)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {d.items.length > SHOWN && (
              <p className="muted">{t('and {count} more', { count: d.items.length - SHOWN })}</p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
