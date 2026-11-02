import { t } from '../../i18n';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { AccessLogEntry, Page } from '../../api/types';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  QueryView,
  Table,
} from '../../components/ui';
import { actionLabel, formatDateTime, humanize } from '../../format';

const basisText = (basis: string): string | undefined =>
  ({ CARE_TEAM: t('Member of your care team'), EMERGENCY: t('Emergency access') })[basis];

/**
 * Transparency for patients: every access to, or change of, their record by someone else.
 */
export function PortalAccessLog() {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['portal', 'access-log', page],
    queryFn: () =>
      api<Page<AccessLogEntry>>('/portal/access-log', { query: { page, pageSize: 25 } }),
  });
  return (
    <>
      <PageHeader
        title={t('Who viewed my record')}
        subtitle={t(
          'Every time a health professional opens or changes your record, it is logged here.',
        )}
      />
      <Alert tone="info">
        {t(
          'Doctors can open your record when they are part of your care team. In an emergency, a doctor at your facility may use',
        )}{' '}
        <strong>{t('emergency access')}</strong>
        {t(
          ': they must give a reason, access expires automatically, and it is reviewed by the facility director. If you see access you do not recognise, contact your facility or the Ministry of Health.',
        )}
      </Alert>
      <Card>
        <QueryView query={q}>
          {(d) =>
            d.items.length ? (
              <>
                <Table caption={t('Access to your health record')}>
                  <thead>
                    <tr>
                      <th>{t('When')}</th>
                      <th>{t('Who')}</th>
                      <th>{t('What')}</th>
                      <th>{t('Why')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((e) => (
                      <tr key={e.id}>
                        <td>{formatDateTime(e.occurredAt)}</td>
                        <td>
                          <strong>{e.actorName ?? t('System')}</strong>
                          <div className="muted">
                            {[
                              e.actorSpecialty ?? (e.actorRole ? humanize(e.actorRole) : null),
                              e.facilityName,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        </td>
                        <td>
                          {actionLabel(e.action)}
                          {e.section && (
                            <div className="muted">
                              {t('Section: {section}', { section: humanize(e.section) })}
                            </div>
                          )}
                        </td>
                        <td>
                          {e.action === 'care.emergency_access.granted' ||
                          e.basis === 'EMERGENCY' ? (
                            <Badge tone="danger">{t('Emergency access')}</Badge>
                          ) : e.basis ? (
                            <Badge tone="info">{basisText(e.basis) ?? humanize(e.basis)}</Badge>
                          ) : (
                            '—'
                          )}
                          {e.emergencyReason && (
                            <div className="muted">
                              {t('Reason: “{reason}”', { reason: e.emergencyReason })}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                <Pagination page={d.page} totalPages={d.totalPages} onChange={setPage} />
              </>
            ) : (
              <EmptyState title={t('Nobody else has accessed your record yet')} />
            )
          }
        </QueryView>
      </Card>
    </>
  );
}
