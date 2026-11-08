import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ageBandLabel,
  priorityLabel,
  priorityTone,
  useIncidentAction,
  useIncoming,
  type IncomingAmbulance,
} from '../../api/ems';
import { riskLabel } from '../../api/news';
import {
  Badge,
  Button,
  Card,
  Dialog,
  ErrorAlert,
  formValues,
  SelectField,
  TextField,
} from '../../components/ui';
import { t } from '../../i18n';
import { IncidentPanel } from './IncidentPanel';

const sexLabel = (s: string | null) =>
  s === 'MALE' ? t('Man') : s === 'FEMALE' ? t('Woman') : t('Sex unknown');

const since = (iso: string | null) =>
  iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)) : null;

/**
 * Pre-alert strip on the emergency department board: ambulances on their way. Names are never
 * shown before the handover; the big-screen view hides the complaint too.
 */
export function IncomingAmbulances({ big }: { big: boolean }) {
  const incoming = useIncoming(true);
  const [viewing, setViewing] = useState<string | null>(null);
  const [handing, setHanding] = useState<IncomingAmbulance | null>(null);
  const items = incoming.data?.items ?? [];
  if (!items.length) return null;
  const canAct = incoming.data?.canTakeHandover && !big;
  return (
    <Card title={t('Incoming ambulances')}>
      <ul className="stack" aria-label={t('Incoming ambulances')}>
        {items.map((i) => {
          const left = since(i.leftSceneAt);
          return (
            <li key={i.id} className="row-between">
              <span className="row">
                <Badge tone={priorityTone(i.priority)}>
                  {big ? i.priority : priorityLabel(i.priority)}
                </Badge>
                <strong>{i.callSign ?? '—'}</strong>
                {!big && <span>{i.complaint}</span>}
                <span className="muted">
                  {sexLabel(i.sex)}, {ageBandLabel(i.ageBand)}
                </span>
                {i.earlyWarning && (
                  <Badge
                    tone={
                      i.earlyWarning.risk === 'HIGH'
                        ? 'danger'
                        : i.earlyWarning.risk === 'LOW'
                          ? 'success'
                          : 'warning'
                    }
                  >
                    {`${i.earlyWarning.scale} ${i.earlyWarning.score} – ${riskLabel(i.earlyWarning.risk)}`}
                  </Badge>
                )}
                <span className="muted">
                  {i.atHospitalAt
                    ? t('Arrived – waiting for handover')
                    : left !== null
                      ? t('Left the scene {minutes} min ago', { minutes: left })
                      : ''}
                </span>
              </span>
              {canAct && (
                <span className="row">
                  <Button size="sm" variant="secondary" onClick={() => setViewing(i.id)}>
                    {t('Pre-hospital record')}
                    <span className="sr-only"> {i.reference}</span>
                  </Button>
                  <Button size="sm" onClick={() => setHanding(i)}>
                    {t('Take handover')}
                    <span className="sr-only"> {i.reference}</span>
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {viewing && <IncidentPanel id={viewing} vehicles={[]} onClose={() => setViewing(null)} />}
      {handing && <HandoverDialog item={handing} onClose={() => setHanding(null)} />}
    </Card>
  );
}

function HandoverDialog({ item, onClose }: { item: IncomingAmbulance; onClose: () => void }) {
  const act = useIncidentAction();
  const qc = useQueryClient();
  const unidentified = item.sex === null;
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    act.mutate(
      {
        id: item.id,
        action: 'handover',
        body: unidentified ? { sex: v.sex, estimatedAge: Number(v.estimatedAge) } : {},
      },
      {
        onSuccess: () => {
          // The new attendance appears on the board straight away.
          void qc.invalidateQueries({ queryKey: ['ed'] });
          onClose();
        },
      },
    );
  }
  return (
    <Dialog open onClose={onClose} title={t('Take handover')}>
      <form onSubmit={onSubmit} className="stack">
        <p>
          {t(
            'The patient is registered as arrived by ambulance and joins the waiting list for triage.',
          )}
        </p>
        {unidentified && (
          <div className="form-grid">
            <SelectField
              label={t('Sex')}
              name="sex"
              required
              options={[
                { value: 'MALE', label: t('Male') },
                { value: 'FEMALE', label: t('Female') },
                { value: 'UNKNOWN', label: t('Unknown') },
              ]}
            />
            <TextField
              label={t('Estimated age')}
              name="estimatedAge"
              type="number"
              min={0}
              max={120}
              required
              hint={t('The crew did not identify the patient: a temporary record is created.')}
            />
          </div>
        )}
        <ErrorAlert error={act.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={act.isPending}>
            {t('Take handover')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
