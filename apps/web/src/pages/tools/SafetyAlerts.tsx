import type { ReactNode } from 'react';
import {
  kindLabel,
  severityLabel,
  severityTone,
  type SafetyAlert,
  type StoredAlert,
} from '../../api/safety';
import { Badge, TextAreaField } from '../../components/ui';
import { t } from '../../i18n';
import './safety.css';

export function SeverityBadge({ alert }: { alert: Pick<SafetyAlert, 'severity'> }) {
  return <Badge tone={severityTone(alert.severity)}>{severityLabel(alert.severity)}</Badge>;
}

/**
 * Safety alerts with severity, explanation and advice. When `reasons` is given, each blocking
 * alert gets a required "reason to proceed" field (the override recorded with the prescription).
 */
export function SafetyAlertList({
  alerts,
  reasons,
  onReason,
  footer,
}: {
  alerts: SafetyAlert[];
  reasons?: Record<string, string>;
  onReason?: (code: string, reason: string) => void;
  footer?: ReactNode;
}) {
  if (!alerts.length) return null;
  return (
    <ul className="safety-alerts" aria-label={t('Safety alerts')}>
      {alerts.map((a) => (
        <li key={a.code} className={`safety-alert safety-${a.severity.toLowerCase()}`}>
          <div className="row">
            <SeverityBadge alert={a} />
            <strong>{kindLabel(a.kind)}</strong>
          </div>
          <p>{a.message}</p>
          {a.management && <p className="muted">{a.management}</p>}
          {a.blocking && onReason && (
            <TextAreaField
              label={t('Reason to proceed despite this alert')}
              required
              minLength={10}
              maxLength={500}
              rows={2}
              value={reasons?.[a.code] ?? ''}
              onChange={(e) => onReason(a.code, e.target.value)}
              hint={t('Recorded with the prescription and shown to the pharmacist.')}
            />
          )}
        </li>
      ))}
      {footer}
    </ul>
  );
}

/** Compact badges for stored alerts, with override reasons in a details element. */
export function StoredAlertSummary({ alerts }: { alerts?: StoredAlert[] }) {
  if (!alerts?.length) return null;
  return (
    <details className="stored-alerts">
      <summary>
        <span className="row">
          {alerts.map((a) => (
            <Badge key={a.id} tone={severityTone(a.severity)}>
              {kindLabel(a.kind)}
            </Badge>
          ))}
        </span>
      </summary>
      <ul className="list">
        {alerts.map((a) => (
          <li key={a.id}>
            <SeverityBadge alert={a} /> {a.message}
            {a.overrideReason && (
              <div className="muted">
                {t('Overridden by {name}: {reason}', {
                  name: a.overriddenBy ?? '—',
                  reason: a.overrideReason,
                })}
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
