import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api/client';
import type { Facility, FacilityStats } from '../../api/types';
import { Alert, PageHeader, QueryView } from '../../components/ui';
import { humanize } from '../../format';
import { FacilityStatsView } from '../director/FacilityStatsView';

export function FacilityStatsPage() {
  const { facilityId = '' } = useParams();
  const facility = useQuery({
    queryKey: ['facilities', facilityId],
    queryFn: () => api<Facility>(`/facilities/${facilityId}`),
  });
  const stats = useQuery({
    queryKey: ['stats', 'facility', facilityId],
    queryFn: () => api<FacilityStats>('/stats/facility', { query: { facilityId } }),
  });
  const f = facility.data;
  return (
    <>
      <PageHeader
        title={f?.name ?? 'Facility'}
        subtitle={
          f
            ? `${f.code} · ${humanize(f.type)} · ${f.municipality}, ${f.region}${f.isActive ? '' : ' · inactive'}`
            : undefined
        }
        actions={
          <Link to="/ministry/facilities" className="btn btn-secondary btn-sm">
            ← All facilities
          </Link>
        }
      />
      <Alert tone="info">
        Aggregate data only. The Ministry has no access to identifiable patient records.
      </Alert>
      <QueryView query={stats}>{(s) => <FacilityStatsView stats={s} />}</QueryView>
    </>
  );
}
