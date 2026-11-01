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
      <PageHeader title="Test results" />
      <Alert tone="info">
        Results appear here after your doctor has reviewed them. A result outside the reference
        range does not always mean something is wrong — your doctor will explain what it means for
        you. If you have questions, book an appointment.
      </Alert>
      <Card>
        <QueryView query={q}>
          {(d) =>
            d.items.length ? (
              <Table caption="Released laboratory results">
                <thead>
                  <tr>
                    <th>Test</th>
                    <th className="num">Result</th>
                    <th>Reference range</th>
                    <th>Flag</th>
                    <th>Status</th>
                    <th>Collected</th>
                    <th>Requested by</th>
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
              <EmptyState title="No results released yet" />
            )
          }
        </QueryView>
      </Card>
    </>
  );
}
