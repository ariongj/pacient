import { useState } from 'react';
import { useIncident } from '../../api/ems';
import { riskLabel } from '../../api/news';
import { Badge, Button } from '../../components/ui';
import { formatTime } from '../../format';
import { t } from '../../i18n';
import { careText, KIND_LABEL } from './careRecord';
import { IncidentPanel } from './IncidentPanel';

const RISK_TONE = {
  LOW: 'success',
  LOW_MEDIUM: 'warning',
  MEDIUM: 'warning',
  HIGH: 'danger',
} as const;

/**
 * What the ambulance crew found and did, at a glance: the latest observations with the early
 * warning score, and every medicine and intervention given before hospital (so nothing is given
 * twice). The full record opens from here. For triage and for the chart after the handover.
 */
export function PreHospitalSummary({ incidentId }: { incidentId: string }) {
  const incident = useIncident(incidentId);
  const [open, setOpen] = useState(false);
  const d = incident.data;
  if (!d) return null;
  const observations = d.careRecords.filter((r) => r.kind === 'OBSERVATION');
  const latest = observations[observations.length - 1];
  const given = d.careRecords.filter((r) => r.kind === 'MEDICATION' || r.kind === 'INTERVENTION');
  return (
    <section className="prehospital" aria-label={t('From the ambulance crew')}>
      <div className="row-between" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
        <strong>
          {t('From the ambulance crew')} · {d.reference}
          {d.vehicle ? ` · ${d.vehicle.callSign}` : ''}
        </strong>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {t('Pre-hospital record')}
        </Button>
      </div>
      {latest ? (
        <p className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', margin: '0.35rem 0 0' }}>
          <span className="muted">{formatTime(latest.recordedAt)}</span>
          <span>{careText(latest)}</span>
          {d.earlyWarning && (
            <Badge tone={RISK_TONE[d.earlyWarning.risk]}>
              {`${d.earlyWarning.scale} ${d.earlyWarning.score} – ${riskLabel(d.earlyWarning.risk)}`}
            </Badge>
          )}
        </p>
      ) : (
        <p className="muted" style={{ margin: '0.35rem 0 0' }}>
          {t('No observations recorded by the crew.')}
        </p>
      )}
      {given.length > 0 && (
        <ul className="prehospital-given">
          {given.map((r) => (
            <li key={r.id}>
              <span className="muted">{formatTime(r.recordedAt)}</span> {t(KIND_LABEL[r.kind])}:{' '}
              {careText(r)}
            </li>
          ))}
        </ul>
      )}
      {open && <IncidentPanel id={incidentId} vehicles={[]} onClose={() => setOpen(false)} />}
    </section>
  );
}
