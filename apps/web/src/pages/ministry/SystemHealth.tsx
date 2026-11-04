import { useState, type FormEvent } from 'react';
import { t, tn } from '../../i18n';
import {
  downloadAuditExport,
  useSystemHealth,
  type AuditExportFormat,
  type MonitoringIndicators,
} from '../../api/monitoring';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  ErrorAlert,
  Grid,
  PageHeader,
  QueryView,
  SelectField,
  Stat,
  TextField,
  type Tone,
} from '../../components/ui';
import { formatDateTime, formatNumber } from '../../format';

const GRAFANA_URL = (import.meta.env.VITE_GRAFANA_URL as string | undefined)?.trim() || null;
const MAX_EXPORT_DAYS = 31;

/** Compact human duration: 45 s, 12 min, 3 h 5 min, 2 d 4 h. */
function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t('{n} s', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('{n} min', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('{h} h {m} min', { h, m: m % 60 });
  return t('{d} d {h} h', { d: Math.floor(h / 24), h: h % 24 });
}

function megabytes(bytes: number): string {
  return t('{n} MB', { n: formatNumber(Math.round(bytes / 1_048_576)) });
}

/** Warning when anything is waiting, danger above the threshold. */
const toneFor = (value: number, dangerAt = 1): Tone | undefined =>
  value >= dangerAt ? 'danger' : value > 0 ? 'warning' : undefined;

function SafetyIndicators({ i }: { i: MonitoringIndicators }) {
  const items: { label: string; value: number; hint: string; tone?: Tone }[] = [
    {
      label: t('Critical results not acknowledged'),
      value: i.criticalResultsUnacknowledged,
      hint: tn(
        i.criticalResultsUnacknowledgedOver30m,
        '{count} older than 30 minutes',
        '{count} older than 30 minutes',
      ),
      tone: toneFor(i.criticalResultsUnacknowledged, 1),
    },
    {
      label: t('Escalated results pending'),
      value: i.escalatedResultsPending,
      hint: t('Escalated to the next clinician, not yet acknowledged'),
      tone: toneFor(i.escalatedResultsPending, 1),
    },
    {
      label: t('NEWS2 high risk not acknowledged'),
      value: i.news2HighUnacknowledged,
      hint: t('Emergency response expected'),
      tone: toneFor(i.news2HighUnacknowledged, 1),
    },
    {
      label: t('Emergency department waits beyond target'),
      value: i.edWaitingBeyondTarget,
      hint: t('Waiting longer than the triage category target'),
      tone: toneFor(i.edWaitingBeyondTarget, 5),
    },
    {
      label: t('Open transfusion requests'),
      value: i.transfusionRequestsOpen,
      hint: t('Requested, not yet issued'),
    },
    {
      label: t('Lab orders waiting'),
      value: i.labOrdersWaiting,
      hint: t('Ordered or collected, no final result yet'),
    },
    {
      label: t('Case report drafts older than 24 hours'),
      value: i.caseReportDraftsOver24h,
      hint: t('Notifiable disease reports not yet submitted'),
      tone: toneFor(i.caseReportDraftsOver24h, 5),
    },
    {
      label: t('Integration messages needing review'),
      value: i.integrationMessagesNeedingReview,
      hint: t('Inbound laboratory messages that could not be matched'),
      tone: toneFor(i.integrationMessagesNeedingReview, 10),
    },
    {
      label: t('Facilities in downtime'),
      value: i.facilitiesInDowntime,
      hint: t('Working on paper with the downtime kit'),
      tone: i.facilitiesInDowntime > 0 ? 'warning' : undefined,
    },
  ];
  return (
    <Card title={t('Clinical safety indicators')}>
      <Grid min={200}>
        {items.map((it) => (
          <Stat
            key={it.label}
            label={it.label}
            value={formatNumber(it.value)}
            hint={it.hint}
            tone={it.tone}
          />
        ))}
      </Grid>
    </Card>
  );
}

function Queues({ i }: { i: MonitoringIndicators }) {
  if (i.scope !== 'national') return null;
  const channel = (label: string, pending: number, failed: number, oldest: number) => (
    <Stat
      label={label}
      value={tn(pending, '{count} pending', '{count} pending')}
      hint={
        <>
          {failed > 0 ? (
            <Badge tone="danger">
              {tn(failed, '{count} failed in 7 days', '{count} failed in 7 days')}
            </Badge>
          ) : (
            <Badge tone="success">{t('No failures')}</Badge>
          )}{' '}
          {pending > 0 && t('Oldest waiting {age}', { age: duration(oldest) })}
        </>
      }
      tone={failed > 0 ? 'danger' : oldest > 900 ? 'warning' : undefined}
    />
  );
  return (
    <Card title={t('Notification queues')}>
      <Grid min={220}>
        {channel(t('Email'), i.emailPending, i.emailFailed, i.emailOldestPendingSeconds)}
        {channel(t('SMS'), i.smsPending, i.smsFailed, i.smsOldestPendingSeconds)}
      </Grid>
    </Card>
  );
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function AuditExport() {
  const today = new Date();
  const [from, setFrom] = useState(isoDate(new Date(today.getTime() - 7 * 86_400_000)));
  const [to, setTo] = useState(isoDate(today));
  const [format, setFormat] = useState<AuditExportFormat>('jsonl');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const days = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
  const invalid =
    !from || !to || Number.isNaN(days)
      ? t('Choose both dates.')
      : days < 0
        ? t('The end date must be after the start date.')
        : days + 1 > MAX_EXPORT_DAYS
          ? t('At most {days} days per export.', { days: MAX_EXPORT_DAYS })
          : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      // The end date is inclusive for the user: export up to the start of the following day.
      const end = isoDate(new Date(new Date(to).getTime() + 86_400_000));
      await downloadAuditExport(from, end, format);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('Audit export for the SIEM')}>
      <p className="muted">
        {t(
          'Download the audit trail as JSON lines or CEF for the security operations centre. Each export is itself recorded in the audit log.',
        )}
      </p>
      <form onSubmit={submit} className="stack">
        <Grid min={180}>
          <TextField
            label={t('From')}
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            required
          />
          <TextField
            label={t('To (inclusive)')}
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            required
            error={invalid}
          />
          <SelectField
            label={t('Format')}
            value={format}
            onChange={(e) => setFormat(e.target.value as AuditExportFormat)}
            options={[
              { value: 'jsonl', label: t('JSON lines (Loki, Elastic, Splunk)') },
              { value: 'cef', label: t('CEF (ArcSight, QRadar)') },
            ]}
          />
        </Grid>
        <ErrorAlert error={error} />
        <div>
          <Button type="submit" loading={busy} disabled={Boolean(invalid)}>
            {t('Download audit export')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function SystemHealth() {
  const q = useSystemHealth();
  return (
    <>
      <PageHeader
        title={t('System health')}
        subtitle={t(
          'Platform status, queues and clinical safety indicators. Refreshes every 30 seconds.',
        )}
        actions={
          GRAFANA_URL ? (
            <a
              className="btn btn-secondary btn-md"
              href={GRAFANA_URL}
              target="_blank"
              rel="noreferrer"
            >
              {t('Open Grafana dashboards')}
            </a>
          ) : undefined
        }
      />
      <QueryView query={q}>
        {(d) => (
          <div className="stack">
            {!d.database.up && (
              <Alert tone="danger" title={t('The database is not responding.')}>
                {t('Clinical systems may be unavailable. Follow the downtime procedure.')}
              </Alert>
            )}
            <Grid min={180}>
              <Stat
                label={t('API')}
                value={<Badge tone="success">{t('Running')}</Badge>}
                hint={t('Up for {time}', { time: duration(d.api.uptimeSeconds) })}
              />
              <Stat
                label={t('Database')}
                value={
                  d.database.up ? (
                    <Badge tone="success">{t('Available')}</Badge>
                  ) : (
                    <Badge tone="danger">{t('Unavailable')}</Badge>
                  )
                }
                hint={
                  d.database.latencyMs !== null
                    ? t('Response time {ms} ms', { ms: formatNumber(d.database.latencyMs) })
                    : undefined
                }
                tone={d.database.up ? undefined : 'danger'}
              />
              <Stat
                label={t('Database connections')}
                value={t('{busy} of {total} in use', {
                  busy: d.database.pool.total - d.database.pool.idle,
                  total: d.database.pool.total,
                })}
                hint={tn(
                  d.database.pool.waiting,
                  '{count} request waiting',
                  '{count} requests waiting',
                )}
                tone={d.database.pool.waiting > 0 ? 'warning' : undefined}
              />
              <Stat
                label={t('Server errors since start')}
                value={formatNumber(d.api.serverErrorsSinceStart)}
                hint={t('HTTP 5xx responses from this API instance')}
                tone={d.api.serverErrorsSinceStart > 0 ? 'warning' : undefined}
              />
            </Grid>
            <SafetyIndicators i={d.indicators} />
            <Queues i={d.indicators} />
            <Card title={t('Version')}>
              <DefinitionList
                items={[
                  [t('Application version'), d.api.version],
                  [t('Release'), d.api.release ?? '—'],
                  [t('Node.js'), d.api.node],
                  [t('Memory in use'), megabytes(d.api.memoryRssBytes)],
                  [t('Last updated'), formatDateTime(d.generatedAt)],
                ]}
              />
            </Card>
            <AuditExport />
          </div>
        )}
      </QueryView>
    </>
  );
}
