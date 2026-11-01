import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { EmergencyAccessEvent, FacilityStats, Referral } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import { AnnouncementsCard } from '../../components/Announcements';
import { Alert, PageHeader, QueryView } from '../../components/ui';
import { FacilityStatsView } from './FacilityStatsView';

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
  const unreviewed = emergency.data?.items.length ?? 0;
  const pending = referrals.data?.items ?? [];
  const urgent = pending.filter((r) => r.priority === 'URGENT').length;
  if (!unreviewed && !pending.length) return null;
  return (
    <>
      {unreviewed > 0 && (
        <Alert tone="danger" title={`${unreviewed} emergency access event(s) awaiting your review`}>
          <Link to="/director/emergency-access">Review emergency access</Link>
        </Alert>
      )}
      {pending.length > 0 && (
        <Alert
          tone="warning"
          title={`${pending.length} incoming referral(s) awaiting a decision${urgent ? ` (${urgent} urgent)` : ''}`}
        >
          <Link to="/director/referrals">Open referrals</Link>
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
        title="Facility dashboard"
        subtitle={`${user.facility?.name ?? ''} · aggregate and operational data only, no clinical records`}
      />
      <ActionAlerts />
      <div className="stack">
        <QueryView query={query}>
          {(stats) => <FacilityStatsView stats={stats} auditPath="/director/audit" />}
        </QueryView>
        <AnnouncementsCard />
      </div>
    </>
  );
}
