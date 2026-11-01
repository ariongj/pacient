import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, downloadFile } from '../../api/client';
import type { ActivityReportRow, DiagnosesReportRow, Facility, Report } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  TabPanel,
  Table,
  Tabs,
  TextField,
} from '../../components/ui';
import { formatNumber } from '../../format';

type ReportType = 'activity' | 'diagnoses';

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function Cell({ value }: { value: number | null }) {
  return value === null ? (
    <abbr title="Suppressed to protect privacy">&lt;5</abbr>
  ) : (
    <>{formatNumber(value)}</>
  );
}

function ActivityTable({ report }: { report: Report<ActivityReportRow> }) {
  if (!report.rows.length) return <EmptyState title="No facilities match these filters" />;
  const total = (k: keyof ActivityReportRow) =>
    report.rows.reduce((acc, r) => acc + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0);
  const numeric: [keyof ActivityReportRow, string][] = [
    ['encounters', 'Encounters'],
    ['uniquePatients', 'Unique patients'],
    ['appointmentsCompleted', 'Appointments completed'],
    ['noShows', 'No-shows'],
    ['referralsSent', 'Referrals sent'],
    ['referralsReceived', 'Referrals received'],
    ['vaccinations', 'Vaccinations'],
    ['emergencyAccess', 'Emergency access'],
  ];
  return (
    <Table caption="Activity by facility">
      <thead>
        <tr>
          <th>Facility</th>
          <th>Region</th>
          {numeric.map(([, label]) => (
            <th key={label} className="num">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {report.rows.map((r) => (
          <tr key={r.code}>
            <td>
              {r.name} <code>{r.code}</code>
            </td>
            <td>{r.region}</td>
            {numeric.map(([k]) => (
              <td key={k} className="num">
                <Cell value={r[k] as number | null} />
              </td>
            ))}
          </tr>
        ))}
        {report.rows.length > 1 && (
          <tr>
            <th scope="row" colSpan={2}>
              Total
            </th>
            {numeric.map(([k]) => (
              <td key={k} className="num">
                <strong>{k === 'uniquePatients' ? '—' : formatNumber(total(k))}</strong>
              </td>
            ))}
          </tr>
        )}
      </tbody>
    </Table>
  );
}

function DiagnosesTable({ report }: { report: Report<DiagnosesReportRow> }) {
  if (!report.rows.length) return <EmptyState title="No diagnoses recorded in this period" />;
  return (
    <Table caption="Diagnoses by region">
      <thead>
        <tr>
          <th>Region</th>
          <th>ICD-10</th>
          <th>Diagnosis</th>
          <th className="num">Patients</th>
        </tr>
      </thead>
      <tbody>
        {report.rows.map((r) => (
          <tr key={`${r.region}-${r.icd10Code}`}>
            <td>{r.region}</td>
            <td>
              <code>{r.icd10Code}</code>
            </td>
            <td>{r.description}</td>
            <td className="num">
              <Cell value={r.patients} />
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function ReportsPage() {
  const user = useUser();
  const ministry = user.role === 'MINISTRY';
  const [type, setType] = useState<ReportType>('activity');
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 90 * DAY)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [region, setRegion] = useState('');
  const [facilityId, setFacilityId] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<unknown>(null);

  const facilities = useQuery({
    queryKey: ['facilities', 'all'],
    queryFn: () => api<{ items: Facility[] }>('/facilities', { query: { includeInactive: true } }),
    enabled: ministry,
  });
  const regions = useMemo(
    () => [...new Set((facilities.data?.items ?? []).map((f) => f.region))].sort(),
    [facilities.data],
  );
  const facilityOptions = (facilities.data?.items ?? []).filter(
    (f) => !region || f.region === region,
  );

  const rangeError =
    !from || !to
      ? 'Choose a start and end date.'
      : from > to
        ? 'The start date must be before the end date.'
        : new Date(to).getTime() - new Date(from).getTime() > 2 * 366 * DAY
          ? 'The period may not be longer than two years.'
          : null;

  const query = { from, to, ...(ministry ? { region, facilityId } : {}) };
  const report = useQuery({
    queryKey: ['reports', type, query],
    queryFn: () =>
      api<Report<ActivityReportRow | DiagnosesReportRow>>(`/reports/${type}`, { query }),
    enabled: !rangeError,
  });

  async function download() {
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadFile(`/reports/${type}/export`, `pacient-${type}-${from}-to-${to}.csv`, query);
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
          ministry
            ? 'Aggregate reports across the national health network'
            : `Aggregate reports for ${user.facility?.name ?? 'your facility'}`
        }
        actions={
          <Button
            variant="secondary"
            onClick={download}
            loading={downloading}
            disabled={Boolean(rangeError)}
          >
            Download CSV
          </Button>
        }
      />
      <Alert tone="info">
        Reports contain counts only. Patient counts below 5 are shown as “&lt;5” to protect privacy.
        Every CSV download is recorded in the audit log.
      </Alert>
      <ErrorAlert error={downloadError} />
      <Card>
        <div className="search-bar">
          <TextField
            label="From"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField
            label="To"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
          {ministry && (
            <>
              <SelectField
                label="Region"
                value={region}
                placeholder="All regions"
                options={regions.map((r) => ({ value: r, label: r }))}
                onChange={(e) => {
                  setRegion(e.target.value);
                  setFacilityId('');
                }}
              />
              <SelectField
                label="Facility"
                value={facilityId}
                placeholder="All facilities"
                options={facilityOptions.map((f) => ({ value: f.id, label: f.name }))}
                onChange={(e) => setFacilityId(e.target.value)}
              />
            </>
          )}
        </div>
        {rangeError && <Alert tone="warning">{rangeError}</Alert>}
        <Tabs
          label="Report type"
          active={type}
          onChange={setType}
          tabs={[
            { id: 'activity', label: 'Activity by facility' },
            { id: 'diagnoses', label: 'Diagnoses by region' },
          ]}
        />
        <TabPanel id={type}>
          {!rangeError && (
            <QueryView query={report}>
              {(d) =>
                type === 'activity' ? (
                  <ActivityTable report={d as Report<ActivityReportRow>} />
                ) : (
                  <DiagnosesTable report={d as Report<DiagnosesReportRow>} />
                )
              }
            </QueryView>
          )}
          {report.data && (
            <p className="muted" style={{ marginTop: '0.75rem' }}>
              Counts below {report.data.smallCellThreshold} are suppressed.
            </p>
          )}
        </TabPanel>
      </Card>
    </>
  );
}
