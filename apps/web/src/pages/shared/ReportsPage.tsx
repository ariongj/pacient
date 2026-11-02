import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, downloadFile } from '../../api/client';
import type { Facility, GenericReport, ReportName } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  QueryView,
  SelectField,
  Stat,
  Table,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import {
  columnLabel,
  formatCell,
  isTextColumn,
  REPORT_DEFS,
  reportDef,
  type Row,
} from './reports/reportDefs';

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

type Preset = '30' | '90' | '365' | 'ytd' | 'custom';
const PRESETS: { value: Preset; label: string }[] = [
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
  { value: 'ytd', label: 'Year to date' },
  { value: 'custom', label: 'Custom period' },
];

function periodFor(preset: Preset, customFrom: string, customTo: string) {
  const today = new Date();
  if (preset === 'custom') return { from: customFrom, to: customTo };
  if (preset === 'ytd') return { from: `${today.getFullYear()}-01-01`, to: isoDay(today) };
  return { from: isoDay(new Date(today.getTime() - Number(preset) * DAY)), to: isoDay(today) };
}

function validatePeriod(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both a start and an end date.';
  const f = new Date(from).getTime();
  const t = new Date(to).getTime();
  if (Number.isNaN(f) || Number.isNaN(t)) return 'Enter valid dates.';
  if (f > t) return 'The start date must be before the end date.';
  if (t - f > 2 * 366 * DAY) return 'Reports can cover at most two years. Shorten the period.';
  return null;
}

function DataTable({ name, report }: { name: ReportName; report: GenericReport }) {
  const columns = report.columns.filter((c) => c !== 'code');
  const hasFacility = report.columns.includes('name');
  return (
    <Table caption={`${reportDef(name).title} – full data`}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} scope="col" className={isTextColumn(c) ? undefined : 'num'}>
              {columnLabel(c)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {report.rows.map((r: Row, i) => (
          <tr key={`${String(r.code ?? '')}-${i}`}>
            {columns.map((c) => {
              const formatted = formatCell(c, r[c]);
              return (
                <td key={c} className={isTextColumn(c) ? undefined : 'num'}>
                  {formatted === null ? (
                    <abbr
                      title={`Fewer than ${report.smallCellThreshold} – hidden to protect privacy`}
                    >
                      &lt;{report.smallCellThreshold}
                    </abbr>
                  ) : c === 'name' && hasFacility ? (
                    <>
                      {formatted} {r.code ? <code>{String(r.code)}</code> : null}
                    </>
                  ) : (
                    formatted
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function ReportView({ name, report }: { name: ReportName; report: GenericReport }) {
  const def = reportDef(name);
  if (!report.rows.length) {
    return (
      <EmptyState title="No data for these filters">
        Try a longer period or a different region.
      </EmptyState>
    );
  }
  const kpis = def.kpis(report.rows);
  const charts = def.charts(report.rows);
  const anySuppressed = report.rows.some(
    (r) => r.suppressed || r.uniquePatients === null || r.patients === null || r.people === null,
  );
  return (
    <div className="stack">
      <div className="kpi-grid">
        {kpis.map((k) => (
          <Stat key={k.label} label={k.label} value={k.value} hint={k.hint} tone={k.tone} />
        ))}
      </div>
      <Grid min={360}>
        {charts.map((c) => (
          <Card key={c.title} title={c.title}>
            {c.node}
          </Card>
        ))}
      </Grid>
      <Card title="Data">
        <DataTable name={name} report={report} />
        {anySuppressed && (
          <p className="muted" style={{ marginTop: '0.75rem' }}>
            Patient counts below {report.smallCellThreshold} are shown as “&lt;
            {report.smallCellThreshold}” so that individuals cannot be identified, including in CSV
            downloads.
          </p>
        )}
      </Card>
    </div>
  );
}

export function ReportsPage() {
  const user = useUser();
  const isMinistry = user.role === 'MINISTRY';
  const [name, setName] = useState<ReportName>('activity');
  const [preset, setPreset] = useState<Preset>('90');
  const [customFrom, setCustomFrom] = useState(isoDay(new Date(Date.now() - 90 * DAY)));
  const [customTo, setCustomTo] = useState(isoDay(new Date()));
  const [region, setRegion] = useState('');
  const [facilityId, setFacilityId] = useState('');
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const [downloading, setDownloading] = useState(false);

  const def = reportDef(name);
  const { from, to } = periodFor(preset, customFrom, customTo);
  const periodError = def.pointInTime ? null : validatePeriod(from, to);

  const facilities = useQuery({
    queryKey: ['facilities', { includeInactive: true }],
    queryFn: () => api<{ items: Facility[] }>('/facilities', { query: { includeInactive: true } }),
    enabled: isMinistry,
  });
  const regions = useMemo(
    () => [...new Set((facilities.data?.items ?? []).map((f) => f.region))].sort(),
    [facilities.data],
  );
  const facilityOptions = (facilities.data?.items ?? []).filter(
    (f) => !region || f.region === region,
  );

  const filters = {
    ...(def.pointInTime ? {} : { from, to }),
    ...(isMinistry && region ? { region } : {}),
    ...(isMinistry && facilityId ? { facilityId } : {}),
  };
  const report = useQuery({
    queryKey: ['reports', name, filters],
    queryFn: () => api<GenericReport>(`/reports/${name}`, { query: filters }),
    enabled: !periodError,
  });

  const selectedFacility = facilities.data?.items.find((f) => f.id === facilityId);
  const scopeText = !isMinistry
    ? (user.facility?.name ?? 'Your facility')
    : selectedFacility
      ? selectedFacility.name
      : region
        ? `${region} region`
        : 'All facilities nationally';

  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadFile(
        `/reports/${name}/export`,
        `pacient-${name}-${from}-to-${to}.csv`,
        filters,
      );
    } catch (err) {
      setDownloadError(err);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={
          isMinistry
            ? 'National health network performance – aggregate data only'
            : `${user.facility?.name ?? 'Facility'} – aggregate and operational data`
        }
        actions={
          <>
            <Button
              variant="secondary"
              onClick={download}
              loading={downloading}
              disabled={Boolean(periodError)}
            >
              Download CSV
            </Button>
            <Button variant="secondary" onClick={() => window.print()} disabled={!report.data}>
              Print / Save as PDF
            </Button>
          </>
        }
      />

      <div className="print-only" style={{ marginBottom: '1rem' }}>
        <h1>Pacient – {def.title}</h1>
        <p>
          Scope: {scopeText}
          <br />
          Period:{' '}
          {def.pointInTime ? 'Point in time (current)' : `${formatDate(from)} – ${formatDate(to)}`}
          <br />
          Generated {formatDateTime(new Date().toISOString())} by {user.fullName}. Aggregate data;
          small counts suppressed.
        </p>
      </div>

      <Alert tone="info">
        Reports contain counts only – never identifiable patient data. Patient counts below 5 are
        hidden to protect privacy. Every CSV download is recorded in the audit log.
      </Alert>

      <div className="split">
        <Card title="Report" className="no-print">
          <ul className="list" aria-label="Available reports">
            {REPORT_DEFS.map((d) => (
              <li key={d.name} style={{ padding: 0, border: 0 }}>
                <button
                  type="button"
                  aria-pressed={d.name === name}
                  onClick={() => setName(d.name)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '0.6rem 0.7rem',
                    marginBottom: 4,
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid',
                    borderColor: d.name === name ? 'var(--primary)' : 'transparent',
                    background: d.name === name ? 'var(--primary-soft)' : 'transparent',
                    color: 'inherit',
                    font: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  <strong>{d.title}</strong>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>
                    {d.description}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="stack">
          <Card className="no-print">
            <div className="form-grid">
              <SelectField
                label="Period"
                value={preset}
                onChange={(e) => setPreset(e.target.value as Preset)}
                options={PRESETS}
                disabled={def.pointInTime}
                hint={def.pointInTime ? 'This report shows the current situation.' : undefined}
              />
              {preset === 'custom' && !def.pointInTime && (
                <>
                  <TextField
                    label="From"
                    type="date"
                    value={customFrom}
                    max={customTo}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                  <TextField
                    label="To"
                    type="date"
                    value={customTo}
                    min={customFrom}
                    max={isoDay(new Date())}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </>
              )}
              {isMinistry && (
                <>
                  <SelectField
                    label="Region"
                    value={region}
                    onChange={(e) => {
                      setRegion(e.target.value);
                      setFacilityId('');
                    }}
                    placeholder="All regions"
                    options={regions.map((r) => ({ value: r, label: r }))}
                  />
                  <SelectField
                    label="Facility"
                    value={facilityId}
                    onChange={(e) => setFacilityId(e.target.value)}
                    placeholder="All facilities"
                    options={facilityOptions.map((f) => ({
                      value: f.id,
                      label: `${f.name} (${f.code})`,
                    }))}
                  />
                </>
              )}
            </div>
          </Card>

          <div className="row-between">
            <div>
              <h2>{def.title}</h2>
              <p className="muted" style={{ margin: 0 }}>
                {scopeText} ·{' '}
                {def.pointInTime ? 'current situation' : `${formatDate(from)} – ${formatDate(to)}`}
              </p>
            </div>
          </div>

          {periodError && <Alert tone="warning" title={periodError} />}
          <ErrorAlert error={downloadError} />
          {!periodError && (
            <QueryView query={report}>
              {(data) => <ReportView name={name} report={data} />}
            </QueryView>
          )}
        </div>
      </div>
    </>
  );
}
