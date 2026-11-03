import { t, tn } from '../../i18n';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { coverState, waited, type CoverArrangement, type EscalatedResult } from '../../api/cover';
import type { EmergencyAccessEvent, FacilityStats, Referral } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import { AnnouncementsCard } from '../../components/Announcements';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  QueryView,
  Table,
} from '../../components/ui';
import { ArrangeCoverDialog, CoverTable } from '../doctor/DoctorCover';
import { FacilityStatsView } from './FacilityStatsView';
import { OperationsPanel } from './OperationsPanel';
import { FacilityHospitalCard } from '../hospital/HospitalCards';

const useEscalations = () =>
  useQuery({
    queryKey: ['cover', 'escalations'],
    queryFn: () => api<{ items: EscalatedResult[] }>('/cover/escalations').then((r) => r.items),
    refetchInterval: 60_000,
  });

/**
 * Critical results nobody has reviewed yet. Directors do not read records, so this shows only who
 * owns each result and how long it has waited – enough to phone the right doctor.
 */
function CriticalResultsCard() {
  const q = useEscalations();
  return (
    <Card title={t('Critical results awaiting review')}>
      <QueryView query={q}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('Nothing waiting')}>
              {t('Every critical result at your facility has been reviewed within 30 minutes.')}
            </EmptyState>
          ) : (
            <>
              <p className="muted">
                {t(
                  'Critical results not acknowledged after 30 minutes. Patient details are only visible to the care team – contact the doctor (or their cover) directly.',
                )}
              </p>
              <Table caption={t('Critical results awaiting review')}>
                <thead>
                  <tr>
                    <th>{t('Ordering doctor')}</th>
                    <th>{t('Waiting')}</th>
                    <th>{t('Escalation')}</th>
                    <th>{t('Covered by')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.orderingDoctor}</strong>
                      </td>
                      <td>{waited(r.minutesWaiting)}</td>
                      <td>
                        {r.level >= 2 ? (
                          <Badge tone="danger">{t('Level 2 · director notified')}</Badge>
                        ) : r.level === 1 ? (
                          <Badge tone="warning">{t('Level 1 · care team notified')}</Badge>
                        ) : (
                          <Badge tone="warning">{t('Pending')}</Badge>
                        )}
                      </td>
                      <td>{r.coveredBy.length ? r.coveredBy.join(', ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </>
          )
        }
      </QueryView>
    </Card>
  );
}

/** Who is away and who covers their results, with a way to arrange cover for any doctor. */
function CoverCard() {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['cover', 'facility'],
    queryFn: () => api<{ items: CoverArrangement[] }>('/cover').then((r) => r.items),
  });
  return (
    <Card
      title={t('Result cover')}
      actions={
        <Button size="sm" onClick={() => setOpen(true)}>
          {t('Arrange cover')}
        </Button>
      }
    >
      <QueryView query={q}>
        {(items) => {
          const live = items.filter((a) => {
            const s = coverState(a);
            return s === 'CURRENT' || s === 'UPCOMING';
          });
          return live.length === 0 ? (
            <EmptyState title={t('No doctors away')}>
              {t('When a doctor is absent, arrange a colleague to receive their results.')}
            </EmptyState>
          ) : (
            <CoverTable items={live} show="both" caption={t('Current and upcoming cover')} />
          );
        }}
      </QueryView>
      <ArrangeCoverDialog open={open} onClose={() => setOpen(false)} forDoctor />
    </Card>
  );
}

/** Items that need the director's action, shown above the statistics. */
function ActionAlerts() {
  const emergency = useQuery({
    queryKey: ['emergency-access', 'unreviewed'],
    queryFn: () =>
      api<{ items: EmergencyAccessEvent[] }>('/emergency-access', {
        query: { status: 'unreviewed' },
      }),
  });
  const referrals = useQuery({
    queryKey: ['referrals', 'incoming', 'PENDING'],
    queryFn: () =>
      api<{ items: Referral[] }>('/referrals', {
        query: { direction: 'incoming', status: 'PENDING' },
      }),
  });
  const escalated = useEscalations().data ?? [];
  const unreviewed = emergency.data?.items.length ?? 0;
  const pending = referrals.data?.items ?? [];
  const urgent = pending.filter((r) => r.priority === 'URGENT').length;
  const overdue = escalated.filter((r) => r.level >= 2).length;
  if (!unreviewed && !pending.length && !overdue) return null;
  return (
    <>
      {overdue > 0 && (
        <Alert
          tone="danger"
          title={tn(
            overdue,
            '{count} critical result unreviewed for more than 2 hours',
            '{count} critical results unreviewed for more than 2 hours',
          )}
        >
          {t('See “Critical results awaiting review” below and contact the doctors concerned.')}
        </Alert>
      )}
      {unreviewed > 0 && (
        <Alert
          tone="warning"
          title={tn(
            unreviewed,
            '{count} emergency access event awaiting your review',
            '{count} emergency access events awaiting your review',
          )}
        >
          <Link to="/director/emergency-access">{t('Review emergency access')}</Link>
        </Alert>
      )}
      {pending.length > 0 && (
        <Alert
          tone="warning"
          title={`${tn(
            pending.length,
            '{count} incoming referral awaiting a decision',
            '{count} incoming referrals awaiting a decision',
          )}${urgent ? ` ${t('({count} urgent)', { count: urgent })}` : ''}`}
        >
          <Link to="/director/referrals">{t('Open referrals')}</Link>
        </Alert>
      )}
    </>
  );
}

export function DirectorDashboard() {
  const user = useUser();
  const query = useQuery({
    queryKey: ['stats', 'facility', user.facility?.id],
    queryFn: () => api<FacilityStats>('/stats/facility'),
  });
  return (
    <>
      <PageHeader
        title={t('Facility dashboard')}
        subtitle={`${user.facility?.name ?? ''} · ${t('aggregate and operational data only, no clinical records')}`}
      />
      <ActionAlerts />
      <div className="stack">
        <CriticalResultsCard />
        <FacilityHospitalCard />
        <CoverCard />
        <OperationsPanel reportsPath="/director/reports" />
        <QueryView query={query}>
          {(stats) => <FacilityStatsView stats={stats} auditPath="/director/audit" />}
        </QueryView>
        <AnnouncementsCard />
      </div>
    </>
  );
}
