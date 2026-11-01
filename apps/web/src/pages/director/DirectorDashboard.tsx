import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { FacilityStats } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import { PageHeader, QueryView } from '../../components/ui';
import { FacilityStatsView } from './FacilityStatsView';

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
      <QueryView query={query}>
        {(stats) => <FacilityStatsView stats={stats} auditPath="/director/audit" />}
      </QueryView>
    </>
  );
}
