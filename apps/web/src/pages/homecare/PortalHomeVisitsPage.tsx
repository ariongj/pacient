import { useMyHomeCare, visitStatusLabel } from '../../api/homecare';
import { useAuth } from '../../auth/AuthContext';
import {
  Alert,
  Card,
  DefinitionList,
  EmptyState,
  PageHeader,
  QueryView,
  Table,
} from '../../components/ui';
import { formatDate, formatDayHeading, formatTime } from '../../format';
import { t } from '../../i18n';
import { usePatientId } from '../patient/shared';
import { EpisodeStatusBadge, taskList } from './HomeCareComponents';

/**
 * The patient's home care: who comes and when, what the visits are for, and recent visits.
 * Guardians with appointments-only access see the visit times only.
 */
export function PortalHomeVisitsPage() {
  const { acting } = useAuth();
  const patientId = usePatientId();
  const query = useMyHomeCare(patientId);
  return (
    <>
      <PageHeader
        title={t('My home visits')}
        subtitle={
          acting
            ? t('Visits of the community nurses to your family member at home.')
            : t('Visits of the community nurses at your home.')
        }
      />
      <QueryView query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <Card>
              <EmptyState title={t('No home care')}>
                {t(
                  'If you need care at home, your family doctor can refer you to the community nurses.',
                )}
              </EmptyState>
            </Card>
          ) : (
            <div className="stack">
              {data.limited && (
                <Alert tone="info">
                  {t(
                    'Your access covers appointments only: you see the visit times, not the care plan.',
                  )}
                </Alert>
              )}
              {data.items.map((e) => (
                <Card
                  key={e.id}
                  title={e.teamName}
                  actions={<EpisodeStatusBadge status={e.status} />}
                >
                  <div className="stack">
                    <DefinitionList
                      items={[
                        [t('Team'), `${e.teamName} – ${e.teamFacilityName}`],
                        [t('Address for visits'), e.visitAddress],
                        ...(e.startedAt
                          ? ([[t('Since'), formatDate(e.startedAt)]] as [string, string][])
                          : []),
                        ...(e.endedAt
                          ? ([[t('Ended'), formatDate(e.endedAt)]] as [string, string][])
                          : []),
                        ...(e.carePlan
                          ? ([
                              [t('Goals of care'), e.carePlan.goals || '—'],
                              [t('Care at home'), taskList(e.carePlan.tasks)],
                            ] as [string, string][])
                          : []),
                      ]}
                    />
                    <h3>{t('Upcoming visits')}</h3>
                    {e.upcoming.length === 0 ? (
                      <p className="muted">
                        {e.status === 'REFERRED'
                          ? t('The team will contact you to agree the first visit.')
                          : t('No visits planned at the moment.')}
                      </p>
                    ) : (
                      <Table caption={t('Upcoming visits')}>
                        <thead>
                          <tr>
                            <th>{t('Day')}</th>
                            <th>{t('Time')}</th>
                            <th>{t('Nurse')}</th>
                            {!data.limited && <th>{t('Care')}</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {e.upcoming.map((v) => (
                            <tr key={v.id}>
                              <td>{formatDayHeading(new Date(v.scheduledFor))}</td>
                              <td>{formatTime(v.scheduledFor)}</td>
                              <td>{v.nurse ?? t('To be confirmed')}</td>
                              {!data.limited && <td>{taskList(v.tasks)}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    )}
                    {e.recent.length > 0 && (
                      <>
                        <h3>{t('Recent visits')}</h3>
                        <ul>
                          {e.recent.map((v) => (
                            <li key={v.id}>
                              {formatDate(v.date)} – {visitStatusLabel(v.status)}
                              {v.nurse ? ` (${v.nurse})` : ''}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                </Card>
              ))}
              <p className="muted">
                {t(
                  'To change a visit, call the community nursing team or tell the nurse at the next visit.',
                )}
              </p>
            </div>
          )
        }
      </QueryView>
    </>
  );
}
