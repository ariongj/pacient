/**
 * Operator alerts: conditions the operator of the service must look at, one per condition key
 * (operator_alerts). Declared by the round 2 scaffold so that every module can raise them; builder
 * S2 implements them (and the watchdog that raises most of them). The contracts below are binding.
 *
 * Known keys: 'billing.settings_incomplete' (raised by the subscription worker when it cannot
 * invoice), 'worker.stale:<worker name>', 'email.failing', 'email.backlog', 'sms.failing',
 * 'sms.backlog', 'backup.stale', 'tls.expiring'. A key is a stable, short identifier (≤ 120
 * characters) of the condition, never of a person or a record.
 */

export type OperatorAlertSeverity = 'WARNING' | 'CRITICAL';

export interface OperatorAlertInput {
  severity: OperatorAlertSeverity;
  /**
   * What is wrong and what to do, in plain English (≤ 500 characters), for the operator. Never
   * patient data, names of patients or record contents; counts, worker names and settings
   * field names are fine.
   */
  message: string;
}

/**
 * Raises (or keeps raised) the alert for `key`: creates it, or updates its severity, message and
 * last-seen time; reopens it if it was resolved. Every active ADMIN is notified (important
 * notification and e-mail) at most once per key per 6 hours. Audited as platform.alert_raised when
 * it is created or reopened. Runs on its own (not in the caller's transaction) and never throws:
 * a failure is logged, so a worker that raises an alert is never broken by it.
 *
 * Scaffold stub: does nothing.
 */
export async function raiseOperatorAlert(_key: string, _alert: OperatorAlertInput): Promise<void> {
  return;
}

/**
 * Resolves the open alert for `key` (sets resolved_at; audited as platform.alert_resolved). Does
 * nothing when there is no open alert for it. Never throws, like raiseOperatorAlert.
 *
 * Scaffold stub: does nothing.
 */
export async function resolveOperatorAlert(_key: string): Promise<void> {
  return;
}
