import { Link } from 'react-router-dom';
import { useOrganizationAgreements } from '../../../api/agreements';
import type { OrganizationDetail } from '../../../api/subscriptions';
import { Card, EmptyState, QueryView, Table } from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { LOCALES, t } from '../../../i18n';
import { AgreementBadge } from '../../director/subscription/AgreementsCard';
import { legalKindLabel } from '../platform/labels';

const languageLabel = (l: string) => LOCALES.find((x) => x.value === l)?.label ?? l;

/**
 * Facility page of the administrator (Organization): the facility's acceptances of the service
 * agreement and the data processing agreement – who signed which version, with which title, when.
 * Round 2, builder G.
 */
export function OrganizationAgreementsCard({ detail }: { detail: OrganizationDetail }) {
  const query = useOrganizationAgreements(detail.facility.id);
  return (
    <Card
      title={t('Agreements')}
      actions={<Link to="/admin/legal?kind=SERVICE_AGREEMENT">{t('The agreement texts')}</Link>}
    >
      <QueryView query={query}>
        {(d) => {
          const history = d.agreements.flatMap((a) => a.acceptances);
          return (
            <div className="stack">
              <ul
                className="stack"
                style={{ listStyle: 'none', padding: 0, margin: 0, gap: '0.4rem' }}
              >
                {d.agreements.map((a) => (
                  <li key={a.kind} className="row">
                    <strong>{legalKindLabel(a.kind)}</strong>
                    {a.currentVersion && (
                      <span className="muted">
                        {t('Version {version}', { version: a.currentVersion })}
                      </span>
                    )}
                    <AgreementBadge a={a} />
                  </li>
                ))}
              </ul>
              {d.pending > 0 && (
                <p className="muted" style={{ margin: 0 }}>
                  {t(
                    'The facility’s directors see a notice until one of them accepts. Nothing is blocked meanwhile.',
                  )}
                </p>
              )}
              {history.length === 0 ? (
                <EmptyState title={t('No agreement accepted yet')} />
              ) : (
                <Table caption={t('Acceptances of the agreements')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Agreement')}</th>
                      <th scope="col">{t('Signed by')}</th>
                      <th scope="col">{t('Director’s account')}</th>
                      <th scope="col">{t('Accepted')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td>
                          {legalKindLabel(h.kind)}
                          <div className="muted">
                            {t('Version {version}', { version: h.version })} ·{' '}
                            {languageLabel(h.locale)}
                          </div>
                        </td>
                        <td>
                          {h.signerName}
                          <div className="muted">{h.signerTitle}</div>
                        </td>
                        <td>{h.acceptedByName ?? '—'}</td>
                        <td>{formatDateTime(h.acceptedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          );
        }}
      </QueryView>
    </Card>
  );
}
