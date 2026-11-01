import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../../../api/client';
import type { CareTeamMember } from '../../../api/types';
import { useUser } from '../../../auth/AuthContext';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  QueryView,
  Table,
} from '../../../components/ui';
import { formatDate } from '../../../format';
import { useChartMutation } from './shared';

export function CareTeamTab({ patientId }: { patientId: string }) {
  const user = useUser();
  const navigate = useNavigate();
  const team = useQuery({
    queryKey: ['patient', patientId, 'care-team'],
    queryFn: () =>
      api<{ items: CareTeamMember[] }>(`/patients/${patientId}/care-team`).then((r) => r.items),
  });
  const leave = useChartMutation(
    patientId,
    () => ({ path: `/care-team/${user.id}`, method: 'DELETE' }),
    () => navigate('/doctor/patients'),
  );

  return (
    <Card title="Care team">
      <ErrorAlert error={leave.error} />
      <QueryView query={team}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title="No doctors assigned" />
          ) : (
            <Table caption="Care team">
              <thead>
                <tr>
                  <th>Doctor</th>
                  <th>Specialty</th>
                  <th>Since</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.doctorId}>
                    <td>
                      {m.fullName} {m.doctorId === user.id && <Badge tone="info">You</Badge>}
                    </td>
                    <td>{m.specialty ?? '—'}</td>
                    <td>{formatDate(m.startedAt)}</td>
                    <td>
                      {m.doctorId === user.id && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={leave.isPending}
                          onClick={() => {
                            if (
                              window.confirm(
                                'Leave this care team? You will lose access to the record.',
                              )
                            ) {
                              leave.mutate(undefined);
                            }
                          }}
                        >
                          Leave care team
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
    </Card>
  );
}
