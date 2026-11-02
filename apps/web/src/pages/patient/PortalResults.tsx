import { t } from '../../i18n';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { LabResult } from '../../api/types';
import {
  Alert,
  Card,
  EmptyState,
  PageHeader,
  QueryView,
  StatusBadge,
  Table,
} from '../../components/ui';
import { formatDate } from '../../format';
import { usePatientId } from './shared';

export function PortalResults() {
  const id = usePatientId();
  const q = useQuery({
    queryKey: ['patient', id, 'lab-results'],
    queryFn: () => api<{ items: LabResult[] }>(`/patients/${id}/lab-results`),
  });
  return (
    <>
      <PageHeader title={t('Test results')} />
      <Alert tone="info">
        {t(
          'Results appear here after your doctor has reviewed them. A result outside the reference range does not always mean something is wrong — your doctor will explain what it means for you. If you have questions, book an appointment.',
        )}
      </Alert>
      <Card>
        <QueryView query={q}>
          {(d) =>
            d.items.length ? (
              <Table caption={t('Released laboratory results')}>
                <thead>
                  <tr>
                    <th>{t('Test')}</th>
                    <th className="num">{t('Result')}</th>
                    <th>{t('Reference range')}</th>
                    <th>{t('Flag')}</th>
                    <th>{t('Status')}</th>
                    <th>{t('Collected')}</th>
                    <th>{t('Requested by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((r) => (
                    <tr key={r.id}>
                      <td>{r.testName}</td>
                      <td className="num">
                        <strong>{r.value}</strong> {r.unit}
                      </td>
                      <td>{r.referenceRange ?? '—'}</td>
                      <td>
                        <StatusBadge value={r.flag} />
                      </td>
                      <td>
                        <StatusBadge value={r.status} />
                      </td>
                      <td>{formatDate(r.collectedAt)}</td>
                      <td>{r.orderedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title={t('No results released yet')} />
            )
          }
        </QueryView>
      </Card>
    </>
  );
}
