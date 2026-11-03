import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { unitTypeLabel, useToday, useUnits, WARD_TYPES, type UnitType } from '../../api/hospital';
import type { GenericReport } from '../../api/types';
import { Card, EmptyState, Grid, QueryView, Stat } from '../../components/ui';
import { formatNumber } from '../../format';
import { t } from '../../i18n';
import './hospital.css';

function OccupancyRow({
  label,
  occupied,
  total,
}: {
  label: string;
  occupied: number;
  total: number;
}) {
  const pct = total ? Math.round((occupied / total) * 100) : 0;
  return (
    <li>
      <div className="row-between">
        <span>{label}</span>
        <span className="muted">{t('{occupied}/{total} · {pct}%', { occupied, total, pct })}</span>
      </div>
      <div
        className={`occupancy-bar ${pct >= 90 ? 'high' : ''}`}
        role="img"
        aria-label={t('{pct}% occupied', { pct })}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
    </li>
  );
}

/** Director dashboard: today's admissions/discharges and occupancy per ward. */
export function FacilityHospitalCard() {
  const today = useToday();
  const units = useUnits(WARD_TYPES);
  return (
    <Card
      title={t('Beds and admissions today')}
      actions={
        <span className="row">
          <Link to="/wards">{t('Bed board')}</Link>
          <Link to="/director/units">{t('Wards & units')}</Link>
        </span>
      }
    >
      <QueryView query={today}>
        {(d) =>
          d.beds === 0 ? (
            <EmptyState title={t('No wards yet')}>
              <Link to="/director/units">{t('Set up wards and beds')}</Link>
            </EmptyState>
          ) : (
            <div className="stack">
              <Grid min={150}>
                <Stat label={t('Inpatients')} value={formatNumber(d.inpatients)} />
                <Stat
                  label={t('Free beds')}
                  value={formatNumber(d.available)}
                  hint={t('of {count} beds', { count: d.beds })}
                  tone={
                    d.available === 0
                      ? 'danger'
                      : d.available < d.beds * 0.1
                        ? 'warning'
                        : undefined
                  }
                />
                <Stat label={t('Admitted today')} value={formatNumber(d.admissions)} />
                <Stat label={t('Discharged today')} value={formatNumber(d.discharges)} />
                <Stat
                  label={t('Discharges expected today')}
                  value={formatNumber(d.expectedToday)}
                  tone={d.expectedToday ? 'info' : undefined}
                />
              </Grid>
              <QueryView query={units}>
                {(items) => (
                  <ul className="list">
                    {items.map((u) => (
                      <OccupancyRow
                        key={u.id}
                        label={u.name}
                        occupied={u.occupied}
                        total={u.total}
                      />
                    ))}
                  </ul>
                )}
              </QueryView>
            </div>
          )
        }
      </QueryView>
    </Card>
  );
}

const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);

/** Ministry dashboard: national bed occupancy by unit type and births this month (aggregates). */
export function NationalHospitalCard() {
  const occupancy = useQuery({
    queryKey: ['reports', 'occupancy', {}],
    queryFn: () => api<GenericReport>('/reports/occupancy'),
  });
  const from = monthStart();
  const births = useQuery({
    queryKey: ['reports', 'births', { from }],
    queryFn: () => api<GenericReport>('/reports/births', { query: { from } }),
  });
  return (
    <Card
      title={t('Hospital capacity and births')}
      actions={<Link to="/ministry/reports">{t('Hospital reports')}</Link>}
    >
      <QueryView query={occupancy}>
        {(r) => {
          const byType = new Map<string, { occupied: number; total: number }>();
          for (const row of r.rows) {
            const key = String(row.unitType);
            const cur = byType.get(key) ?? { occupied: 0, total: 0 };
            cur.occupied += n(row.occupied);
            cur.total += n(row.beds) - n(row.outOfService);
            byType.set(key, cur);
          }
          const occupied = [...byType.values()].reduce((a, v) => a + v.occupied, 0);
          const total = [...byType.values()].reduce((a, v) => a + v.total, 0);
          const birthRows = births.data?.rows ?? [];
          const birthsTotal = birthRows.reduce((a, row) => a + n(row.births), 0);
          const suppressed = birthRows.some((row) => row.births === null);
          return (
            <div className="stack">
              <Grid min={150}>
                <Stat
                  label={t('National bed occupancy')}
                  value={total ? `${Math.round((occupied / total) * 100)}%` : '—'}
                  hint={t('{occupied} of {total} beds', {
                    occupied: formatNumber(occupied),
                    total: formatNumber(total),
                  })}
                />
                <Stat label={t('Free beds')} value={formatNumber(total - occupied)} />
                <Stat
                  label={t('Births this month')}
                  value={formatNumber(birthsTotal)}
                  hint={
                    suppressed
                      ? t('Facilities with fewer than 5 births are not counted')
                      : undefined
                  }
                />
              </Grid>
              {byType.size > 0 && (
                <ul className="list">
                  {[...byType.entries()].map(([type, v]) => (
                    <OccupancyRow
                      key={type}
                      label={unitTypeLabel(type as UnitType)}
                      occupied={v.occupied}
                      total={v.total}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        }}
      </QueryView>
    </Card>
  );
}
