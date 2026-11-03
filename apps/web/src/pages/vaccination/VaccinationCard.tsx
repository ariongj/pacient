import type { ReactNode } from 'react';
import {
  ageLabel,
  DOSE_STATE_TONE,
  doseStateLabel,
  type DoseStatus,
  type VaccinationStatus,
} from '../../api/vaccination';
import { Badge, Button } from '../../components/ui';
import { formatDate } from '../../format';
import { t } from '../../i18n';

/** Groups the schedule doses by the age at which they are recommended. */
function byAge(doses: DoseStatus[]) {
  const groups = new Map<number, DoseStatus[]>();
  for (const d of doses) {
    const key = d.recommendedAgeDays ?? 0;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * The child's vaccination card: every dose of the national calendar by age, with its state.
 * `actions` renders per-dose buttons (e.g. "Record this dose" in the chart).
 */
export function VaccinationTimeline({
  status,
  actions,
  showNotApplicable = false,
}: {
  status: VaccinationStatus;
  actions?: (dose: DoseStatus) => ReactNode;
  showNotApplicable?: boolean;
}) {
  const doses = showNotApplicable
    ? status.doses
    : status.doses.filter((d) => d.state !== 'NOT_APPLICABLE' || d.given);
  if (!doses.length)
    return <p className="muted">{t('No doses of the calendar apply at this age.')}</p>;
  return (
    <ol className="vacc-timeline">
      {byAge(doses).map(([age, items]) => (
        <li key={age} className="vacc-age">
          <div className="vacc-age-label">
            <strong>{ageLabel(age)}</strong>
            <span className="muted">{formatDate(items[0]!.dueDate)}</span>
          </div>
          <ul className="vacc-doses">
            {items.map((d) => (
              <li key={d.scheduleItemId} className={`vacc-dose vacc-${d.state.toLowerCase()}`}>
                <div className="vacc-dose-main">
                  <span>
                    <strong>{d.vaccine}</strong>{' '}
                    <span className="muted">{t('dose {dose}', { dose: d.doseNumber })}</span>
                  </span>
                  <Badge tone={DOSE_STATE_TONE[d.state]}>{doseStateLabel(d.state)}</Badge>
                </div>
                {d.description && <div className="muted small">{t(d.description)}</div>}
                <div className="muted small">
                  {d.given
                    ? t('Given on {date}', { date: formatDate(d.given.administeredAt) }) +
                      (d.given.administeredBy ? ` · ${d.given.administeredBy}` : '')
                    : d.state === 'OVERDUE'
                      ? t('Was due by {date}', { date: formatDate(d.overdueDate) })
                      : d.state === 'NOT_APPLICABLE'
                        ? t('No longer offered at this age')
                        : t('Due from {date}', { date: formatDate(d.dueDate) })}
                </div>
                {actions && <div className="vacc-dose-actions">{actions(d)}</div>}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/** Summary line: how many doses are overdue / due and the next due date. */
export function VaccinationSummary({ status }: { status: VaccinationStatus }) {
  const overdue = status.doses.filter((d) => d.state === 'OVERDUE').length;
  const due = status.doses.filter((d) => d.state === 'DUE').length;
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
      {overdue > 0 && <Badge tone="danger">{t('{count} overdue', { count: overdue })}</Badge>}
      {due > 0 && <Badge tone="warning">{t('{count} due now', { count: due })}</Badge>}
      {overdue === 0 && due === 0 && <Badge tone="success">{t('Up to date')}</Badge>}
      {status.nextDueDate && (
        <span className="muted">
          {t('Next dose from {date}', { date: formatDate(status.nextDueDate) })}
        </span>
      )}
    </div>
  );
}

export function PrintButton() {
  return (
    <Button variant="secondary" size="sm" onClick={() => window.print()}>
      {t('Print vaccination booklet')}
    </Button>
  );
}
