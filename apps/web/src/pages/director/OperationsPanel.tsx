import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { GenericReport } from '../../api/types';
import { Card, ErrorAlert, Grid, Loading, Stat } from '../../components/ui';
import { formatNumber } from '../../format';

const DAY = 86_400_000;
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const sum = (rows: GenericReport['rows'], key: string) => rows.reduce((a, r) => a + n(r[key]), 0);

/**
 * Workforce, security posture and pharmacy queue health – built from the aggregate report API,
 * so directors see their facility and the Ministry sees national totals.
 */
export function OperationsPanel({ reportsPath }: { reportsPath: string }) {
  const from = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const workforce = useQuery({
    queryKey: ['reports', 'workforce', {}],
    queryFn: () => api<GenericReport>('/reports/workforce'),
  });
  const pharmacy = useQuery({
    queryKey: ['reports', 'pharmacy', { from }],
    queryFn: () => api<GenericReport>('/reports/pharmacy', { query: { from } }),
  });

  if (workforce.isPending || pharmacy.isPending) return <Loading label="Loading operations…" />;
  if (workforce.error || pharmacy.error)
    return <ErrorAlert error={workforce.error ?? pharmacy.error} />;

  const w = workforce.data!.rows;
  const p = pharmacy.data!.rows;
  const staff = sum(w, 'activeStaff');
  const twoStep = w.reduce((a, r) => a + (n(r.twoStepPct) / 100) * n(r.activeStaff), 0);
  const adoption = staff ? Math.round((twoStep / staff) * 100) : 0;
  const prescriptions = sum(p, 'prescriptions');
  const returned = sum(p, 'returned');
  const awaiting = sum(p, 'awaitingVerification');
  const overdueTasks = sum(w, 'overdueCareTasks');

  return (
    <Card
      title="Workforce & operations"
      actions={
        <span className="row">
          <Link to="/channels">Team channels</Link>
          <Link to={reportsPath}>All reports</Link>
        </span>
      }
    >
      <Grid min={160}>
        <Stat label="Doctors" value={formatNumber(sum(w, 'doctors'))} />
        <Stat label="Nurses" value={formatNumber(sum(w, 'nurses'))} />
        <Stat label="Pharmacists" value={formatNumber(sum(w, 'pharmacists'))} />
        <Stat label="Reception" value={formatNumber(sum(w, 'reception'))} />
        <Stat
          label="Two-step sign-in"
          value={`${adoption}%`}
          tone={adoption >= 95 ? 'success' : adoption >= 60 ? 'warning' : 'danger'}
          hint={`${formatNumber(Math.round(twoStep))} of ${formatNumber(staff)} active staff`}
        />
        <Stat
          label="Awaiting pharmacy verification"
          value={formatNumber(awaiting)}
          tone={awaiting > 10 ? 'warning' : undefined}
          hint="Prescriptions, last 30 days"
        />
        <Stat
          label="Pharmacy return rate"
          value={prescriptions ? `${Math.round((returned / prescriptions) * 1000) / 10}%` : '—'}
          hint={`${formatNumber(returned)} returned to prescribers (30 days)`}
        />
        <Stat
          label="Overdue care tasks"
          value={formatNumber(overdueTasks)}
          tone={overdueTasks > 0 ? 'danger' : undefined}
        />
      </Grid>
    </Card>
  );
}
