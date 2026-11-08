import { useState } from 'react';
import { usePatientMentalHealth } from '../../../api/mentalhealth';
import { ApiError } from '../../../api/client';
import { useUser } from '../../../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Loading,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import {
  InvoluntaryPanel,
  RestrictivePanel,
  StartInvoluntaryForm,
  StartRestrictiveForm,
} from '../../mentalhealth/MentalHealthComponents';

/**
 * Involuntary admission and restrictive interventions for one patient. Only the care team and the
 * staff of the ward where the patient is admitted can open it; each opening is in the patient's
 * access log.
 */
export function MentalHealthTab({ patientId }: { patientId: string }) {
  const user = useUser();
  const query = usePatientMentalHealth(patientId);
  const [dialog, setDialog] = useState<'INVOLUNTARY' | 'RESTRICTIVE' | null>(null);
  if (query.isPending) return <Loading />;
  if (query.error) {
    return query.error instanceof ApiError && query.error.status === 403 ? (
      <Alert tone="info" title={t('Not visible to you')}>
        {t(
          'Mental health safeguards are visible only to the patient’s care team and the staff of the ward where the patient is admitted.',
        )}
      </Alert>
    ) : (
      <ErrorAlert error={query.error} />
    );
  }
  const data = query.data;
  const active = data.involuntary.find((x) => x.status === 'ACTIVE');
  const past = data.involuntary.filter((x) => x !== active);
  const running = data.restrictive.filter((r) => !r.endedAt || !r.debriefAt);
  const finished = data.restrictive.filter((r) => r.endedAt && r.debriefAt);
  const canAct = user.role === 'DOCTOR' || user.role === 'NURSE';
  return (
    <div className="stack">
      <p className="muted">
        {t(
          'Visible only to the care team and the ward staff. Every opening is shown in the patient’s access log.',
        )}
      </p>
      <Card
        title={t('Involuntary admission')}
        actions={
          data.canStartInvoluntary ? (
            <Button size="sm" variant="secondary" onClick={() => setDialog('INVOLUNTARY')}>
              {t('Record an involuntary admission')}
            </Button>
          ) : undefined
        }
      >
        {active ? (
          <InvoluntaryPanel ia={active} patientId={patientId} maxDays={data.maxAuthorisationDays} />
        ) : (
          <p className="muted">
            {data.admission
              ? t('The patient is in hospital voluntarily ({unit}, since {time}).', {
                  unit: data.admission.unitName,
                  time: formatDateTime(data.admission.admittedAt),
                })
              : t('No involuntary admission in force.')}
          </p>
        )}
        {user.role === 'DOCTOR' &&
          !active &&
          data.admission &&
          data.admission.unitType !== 'PSYCHIATRIC' && (
            <p className="muted">
              {t('An involuntary admission is recorded on a psychiatric ward.')}
            </p>
          )}
      </Card>
      <Card
        title={t('Restrictive interventions')}
        actions={
          canAct && data.canStartRestrictive ? (
            <Button size="sm" variant="secondary" onClick={() => setDialog('RESTRICTIVE')}>
              {t('Record a restrictive intervention')}
            </Button>
          ) : undefined
        }
      >
        {running.length === 0 ? (
          <p className="muted">{t('Nothing in progress or waiting for a debrief.')}</p>
        ) : (
          <div className="stack">
            {running.map((r) => (
              <RestrictivePanel key={r.id} r={r} patientId={patientId} canAct={canAct} />
            ))}
          </div>
        )}
      </Card>
      <Card title={t('History')}>
        {past.length === 0 && finished.length === 0 ? (
          <EmptyState title={t('No earlier records')} />
        ) : (
          <div className="stack">
            {past.map((ia) => (
              <InvoluntaryPanel
                key={ia.id}
                ia={ia}
                patientId={patientId}
                maxDays={data.maxAuthorisationDays}
              />
            ))}
            {finished.map((r) => (
              <RestrictivePanel key={r.id} r={r} patientId={patientId} canAct={false} />
            ))}
          </div>
        )}
      </Card>
      <Dialog
        open={dialog !== null}
        onClose={() => setDialog(null)}
        wide
        title={
          dialog === 'INVOLUNTARY'
            ? t('Record an involuntary admission')
            : t('Record a restrictive intervention')
        }
      >
        {dialog === 'INVOLUNTARY' && (
          <StartInvoluntaryForm patientId={patientId} onDone={() => setDialog(null)} />
        )}
        {dialog === 'RESTRICTIVE' && (
          <StartRestrictiveForm
            patientId={patientId}
            administrations={data.recentAdministrations}
            onDone={() => setDialog(null)}
          />
        )}
      </Dialog>
    </div>
  );
}
