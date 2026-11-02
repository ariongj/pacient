import { t } from '../../i18n';
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
        title={t('Emergency access oversight')}
        subtitle={t('Break-glass use and review compliance across all facilities')}
      />
      <Alert tone="info" title={t('Aggregate data only.')}>
        {t(
          'Facility directors review each emergency access. The Ministry sees counts per facility, with no identifiable patient data.',
        )}
      </Alert>
      <QueryView query={q}>
        {(d) => {
          const sum = (k: keyof EmergencyOversightRow) =>
            d.items.reduce((acc, r) => acc + Number(r[k] ?? 0), 0);
          return (
            <div className="stack">
              <Grid min={180}>
                <Stat
                  label={t('Emergency accesses ({days} days)', { days: d.periodDays })}
                  value={formatNumber(sum('total'))}
                />
                <Stat
                  label={t('Awaiting review')}
                  value={formatNumber(sum('unreviewed'))}
                  tone={sum('unreviewed') > 0 ? 'warning' : undefined}
                />
                <Stat
                  label={t('Overdue reviews (> 7 days)')}
                  value={formatNumber(sum('overdueReviews'))}
                  tone={sum('overdueReviews') > 0 ? 'danger' : undefined}
                />
                <Stat
                  label={t('Judged inappropriate')}
                  value={formatNumber(sum('inappropriate'))}
                  tone={sum('inappropriate') > 0 ? 'danger' : undefined}
                />
              </Grid>
              <Card title={t('By facility (last {days} days)', { days: d.periodDays })}>
                <Table caption={t('Emergency access review compliance by facility')}>
                  <thead>
                    <tr>
                      <th>{t('Facility')}</th>
                      <th>{t('Region')}</th>
                      <th className="num">{t('Total')}</th>
                      <th className="num">{t('Awaiting review')}</th>
                      <th className="num">{t('Overdue')}</th>
                      <th className="num">{t('Inappropriate')}</th>
                      <th className="num">{t('Needs follow-up')}</th>
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
