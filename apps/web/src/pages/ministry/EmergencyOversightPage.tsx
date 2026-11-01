import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { EmergencyOversightRow } from '../../api/types';
import { Alert, Badge, Card, Grid, PageHeader, QueryView, Stat, Table } from '../../components/ui';
import { formatNumber } from '../../format';

function CountBadge({ value, tone }: { value: number; tone: 'warning' | 'danger' }) {
  return value > 0 ? <Badge tone={tone}>{formatNumber(value)}</Badge> : <>0</>;
}

export function EmergencyOversightPage() {
  const q = useQuery({
    queryKey: ['emergency-access', 'summary'],
    queryFn: () =>
      api<{ periodDays: number; items: EmergencyOversightRow[] }>('/emergency-access/summary'),
  });
  return (
    <>
      <PageHeader
        title="Emergency access oversight"
        subtitle="Break-glass use and review compliance across all facilities"
      />
      <Alert tone="info" title="Aggregate data only.">
        Facility directors review each emergency access. The Ministry sees counts per facility, with
        no identifiable patient data.
      </Alert>
      <QueryView query={q}>
        {(d) => {
          const sum = (k: keyof EmergencyOversightRow) =>
            d.items.reduce((acc, r) => acc + Number(r[k] ?? 0), 0);
          return (
            <div className="stack">
              <Grid min={180}>
                <Stat
                  label={`Emergency accesses (${d.periodDays} days)`}
                  value={formatNumber(sum('total'))}
                />
                <Stat
                  label="Awaiting review"
                  value={formatNumber(sum('unreviewed'))}
                  tone={sum('unreviewed') > 0 ? 'warning' : undefined}
                />
                <Stat
                  label="Overdue reviews (> 7 days)"
                  value={formatNumber(sum('overdueReviews'))}
                  tone={sum('overdueReviews') > 0 ? 'danger' : undefined}
                />
                <Stat
                  label="Judged inappropriate"
                  value={formatNumber(sum('inappropriate'))}
                  tone={sum('inappropriate') > 0 ? 'danger' : undefined}
                />
              </Grid>
              <Card title={`By facility (last ${d.periodDays} days)`}>
                <Table caption="Emergency access review compliance by facility">
                  <thead>
                    <tr>
                      <th>Facility</th>
                      <th>Region</th>
                      <th className="num">Total</th>
                      <th className="num">Awaiting review</th>
                      <th className="num">Overdue</th>
                      <th className="num">Inappropriate</th>
                      <th className="num">Needs follow-up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((r) => (
                      <tr key={r.facilityId}>
                        <td>
                          <Link to={`/ministry/facilities/${r.facilityId}`}>{r.facilityName}</Link>
                        </td>
                        <td>{r.region}</td>
                        <td className="num">{formatNumber(r.total)}</td>
                        <td className="num">
                          <CountBadge value={r.unreviewed} tone="warning" />
                        </td>
                        <td className="num">
                          <CountBadge value={r.overdueReviews} tone="danger" />
                        </td>
                        <td className="num">
                          <CountBadge value={r.inappropriate} tone="danger" />
                        </td>
                        <td className="num">
                          <CountBadge value={r.needsFollowUp} tone="warning" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
            </div>
          );
        }}
      </QueryView>
    </>
  );
}
