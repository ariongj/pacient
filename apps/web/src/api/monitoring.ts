import { useQuery } from '@tanstack/react-query';
import { api, downloadFile } from './client';

/** Operational health for the Ministry "System health" page (directors get their facility). */
export interface MonitoringIndicators {
  scope: 'national' | 'facility';
  emailPending: number;
  emailFailed: number;
  emailOldestPendingSeconds: number;
  smsPending: number;
  smsFailed: number;
  smsOldestPendingSeconds: number;
  criticalResultsUnacknowledged: number;
  criticalResultsUnacknowledgedOver30m: number;
  escalatedResultsPending: number;
  news2HighUnacknowledged: number;
  edWaitingBeyondTarget: number;
  transfusionRequestsOpen: number;
  integrationMessagesNeedingReview: number;
  labOrdersWaiting: number;
  caseReportDraftsOver24h: number;
  facilitiesInDowntime: number;
}

export interface SystemHealthReport {
  generatedAt: string;
  scope: 'national' | 'facility';
  api: {
    version: string;
    release: string | null;
    node: string;
    uptimeSeconds: number;
    memoryRssBytes: number;
    serverErrorsSinceStart: number;
  };
  database: {
    up: boolean;
    latencyMs: number | null;
    pool: { total: number; idle: number; waiting: number };
  };
  indicators: MonitoringIndicators;
  /** Background workers (national view only; null for a director's facility view). */
  workers: WorkerStatus[] | null;
  /** The last backup reported by deploy/backup.sh (national view only). */
  backups: BackupStatus | null;
}

export interface WorkerStatus {
  name: string;
  /** Started by the API process that answered (switched-off workers are not). */
  running: boolean;
  intervalSeconds: number | null;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastOkAt: string | null;
  /** The most recent failure in the last 7 days. */
  lastError: { at: string; text: string | null } | null;
  /** No successful run for three intervals. */
  stale: boolean;
}

export interface BackupStatus {
  /** OPS_HEARTBEAT_TOKEN is configured: backups report to the API and are watched. */
  monitored: boolean;
  lastOkAt: string | null;
  detail: { sizeBytes?: number; durationSeconds?: number } | null;
  stale: boolean;
  maxAgeHours: number;
}

export const HEALTH_REFRESH_MS = 30_000;

export function useSystemHealth() {
  return useQuery({
    queryKey: ['monitoring', 'health'],
    queryFn: () => api<SystemHealthReport>('/monitoring/health'),
    refetchInterval: HEALTH_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}

export type AuditExportFormat = 'jsonl' | 'cef';

/** Download the audit trail for a SIEM (max 31 days; the export itself is audited). */
export function downloadAuditExport(from: string, to: string, format: AuditExportFormat) {
  return downloadFile('/monitoring/audit-export', `pacient-audit-${from}_${to}.${format}`, {
    from,
    to,
    format,
  });
}
