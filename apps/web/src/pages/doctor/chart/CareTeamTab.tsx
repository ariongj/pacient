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
import { formatDate, humanize } from '../../../format';
import { GuardiansPanel } from '../../shared/GuardiansPanel';
import { useChartMutation, useChartRole } from './shared';
import { t } from '../../../i18n';

export function CareTeamTab({ patientId }: { patientId: string }) {
  const user = useUser();
  const navigate = useNavigate();
  const { base } = useChartRole();
  const team = useQuery({
    queryKey: ['patient', patientId, 'care-team'],
    queryFn: () =>
      api<{ items: CareTeamMember[] }>(`/patients/${patientId}/care-team`).then((r) => r.items),
  });
  const leave = useChartMutation(
    patientId,
    () => ({ path: `/care-team/${user.id}`, method: 'DELETE' }),
    () => navigate(`${base}/patients`),
  );

  return (
    <div className="stack">
      <Card title={t('Care team')}>
        <ErrorAlert error={leave.error} />
        <QueryView query={team}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState title={t('No clinicians assigned')} />
            ) : (
              <Table caption={t('Care team')}>
                <thead>
                  <tr>
                    <th>{t('Clinician')}</th>
                    <th>{t('Role')}</th>
                    <th>{t('Specialty')}</th>
                    <th>{t('Since')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((m) => (
                    <tr key={m.doctorId}>
                      <td>
                        {m.fullName}{' '}
                        {m.doctorId === user.id && <Badge tone="info">{t('You')}</Badge>}
                      </td>
                      <td>{humanize(m.role ?? 'DOCTOR')}</td>
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
                                  t('Leave this care team? You will lose access to the record.'),
                                )
                              ) {
                                leave.mutate(undefined);
                              }
                            }}
                          >
                            {t('Leave care team')}
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
      <Card title={t('Guardians (proxy access)')}>
        <GuardiansPanel patientId={patientId} canManage={false} />
      </Card>
    </div>
  );
}
