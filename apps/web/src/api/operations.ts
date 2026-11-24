import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/**
 * Operations for the operator of the service (ADMIN): open operator alerts, the test e-mail and
 * recent e-mail delivery failures (/admin/platform). Worker and backup status come with
 * GET /monitoring/health (api/monitoring.ts).
 */

export type AlertSeverity = 'WARNING' | 'CRITICAL';

export interface OperatorAlert {
  id: string;
  /** e.g. 'worker.stale:email', 'email.backlog', 'backup.stale', 'billing.settings_incomplete'. */
  conditionKey: string;
  severity: AlertSeverity;
  /** What is wrong and what to do, in English (technical text for the operator). */
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastNotifiedAt: string | null;
}

export interface EmailFailure {
  id: string;
  /** Masked: "a***@domain". */
  recipient: string;
  template: string;
  status: 'FAILED' | 'RETRYING';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  failedAt: string | null;
  nextAttemptAt: string | null;
}

export interface EmailFailures {
  failedLast24h: number;
  retrying: number;
  maxAttempts: number;
  items: EmailFailure[];
}

export const OPERATIONS_KEY = ['admin', 'operations'] as const;

/** Open operator alerts, critical first (AdminHome). */
export function useOperatorAlerts() {
  return useQuery({
    queryKey: [...OPERATIONS_KEY, 'alerts'],
    queryFn: () => api<{ items: OperatorAlert[] }>('/admin/platform/alerts'),
    staleTime: 0,
    refetchInterval: 60_000,
  });
}

export function useEmailFailures(enabled: boolean) {
  return useQuery({
    queryKey: [...OPERATIONS_KEY, 'email-failures'],
    queryFn: () => api<EmailFailures>('/admin/platform/email-failures'),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useSendTestEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ to: string; deliveryConfigured: boolean }>('/admin/platform/test-email', {
        method: 'POST',
        body: {},
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: OPERATIONS_KEY }),
  });
}

/** The interval workers of the API, by their stable name (lib/worker-runs.ts on the server). */
const WORKER_LABELS: Record<string, () => string> = {
  email: () => t('E-mail delivery'),
  sms: () => t('SMS delivery'),
  'cover-escalation': () => t('Escalation of unanswered results'),
  'appointment-reminders': () => t('Appointment reminders'),
  'vaccination-reminders': () => t('Vaccination reminders'),
  'early-warning': () => t('Early warning scores'),
  retention: () => t('Data retention'),
  'downtime-packs': () => t('Downtime packs'),
  'waiting-lists': () => t('Waiting list warnings'),
  registers: () => t('Disease registers'),
  complaints: () => t('Complaint deadlines'),
  licences: () => t('Licence expiry'),
  subscriptions: () => t('Subscriptions and invoices'),
  maternity: () => t('Antenatal reminders'),
  screening: () => t('Screening invitations'),
  sepsis: () => t('Sepsis escalation'),
  equipment: () => t('Equipment maintenance'),
  infection: () => t('Infection control'),
  'remote-monitoring': () => t('Remote monitoring digests'),
  dialysis: () => t('Dialysis sessions'),
  'mental-health': () => t('Mental health deadlines'),
  proms: () => t('Questionnaire reminders'),
  'access-reviews': () => t('Access reviews'),
  'charge-capture': () => t('Charge capture'),
  surveillance: () => t('Disease surveillance'),
  watchdog: () => t('Watchdog'),
};

export const workerLabel = (name: string) => WORKER_LABELS[name]?.() ?? name;

/** The condition of an alert in the reader's language; the message gives the details. */
export function alertTitle(key: string): string {
  if (key.startsWith('worker.stale:')) {
    return t('The background job {worker} has stopped', {
      worker: workerLabel(key.slice('worker.stale:'.length)),
    });
  }
  switch (key) {
    case 'email.failing':
      return t('E-mails could not be delivered');
    case 'email.backlog':
      return t('E-mails are waiting to be sent');
    case 'sms.failing':
      return t('Text messages could not be delivered');
    case 'sms.backlog':
      return t('Text messages are waiting to be sent');
    case 'backup.stale':
      return t('No recent database backup');
    case 'billing.settings_incomplete':
      return t('Invoices cannot be issued: operator settings are incomplete');
    case 'tls.expiring':
      return t('The HTTPS certificate expires soon');
    default:
      return t('Pacient needs the operator’s attention');
  }
}

/** Where the operator acts on an alert. */
export function alertLink(key: string): { to: string; label: string } | null {
  if (key.startsWith('worker.stale:') || key.startsWith('email.') || key.startsWith('sms.')) {
    return { to: '/admin/health', label: t('Open System health') };
  }
  if (key === 'backup.stale') return { to: '/admin/health', label: t('Open System health') };
  if (key === 'billing.settings_incomplete') {
    return { to: '/admin/settings', label: t('Open the operator settings') };
  }
  return null;
}
