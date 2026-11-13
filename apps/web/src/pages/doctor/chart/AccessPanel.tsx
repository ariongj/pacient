import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Dialog, ErrorAlert, TextAreaField } from '../../../components/ui';
import { useChartMutation, useChartRole } from './shared';
import { t } from '../../../i18n';

/**
 * Shown when the doctor may see demographics but not the clinical record. Offers the two
 * legitimate routes in: joining the care team (same facility) or audited emergency access.
 */
export function AccessPanel({
  patientId,
  sameFacility,
}: {
  patientId: string;
  sameFacility: boolean;
}) {
  const { isDoctor } = useChartRole();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const join = useChartMutation(patientId, () => ({
    path: '/care-team',
    method: 'POST',
    body: {},
  }));
  const emergency = useChartMutation(
    patientId,
    (r: string) => ({ path: '/emergency-access', method: 'POST', body: { reason: r } }),
    () => setOpen(false),
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    emergency.mutate(reason.trim());
  }

  return (
    <Card title={t('You are not in this patient’s care team')}>
      <p>
        {t(
          'Clinical records are available only to the patient’s care team. Choose how you need to access this record.',
        )}
      </p>
      {!sameFacility && (
        <Alert tone="info">
          {t(
            'This patient is registered at another facility. Records are not shared across institutions from this workspace.',
          )}
        </Alert>
      )}
      <ErrorAlert error={join.error} />
      <div className="row">
        {sameFacility && (
          <Button onClick={() => join.mutate(undefined)} loading={join.isPending}>
            {t('Join care team')}
          </Button>
        )}
        {sameFacility && isDoctor && (
          <Button variant="danger" onClick={() => setOpen(true)}>
            {t('Emergency access…')}
          </Button>
        )}
      </div>
      {sameFacility && (
        <p className="muted" style={{ marginTop: '0.75rem' }}>
          {t('Joining the care team is recorded in the audit trail and is visible to the patient.')}
          {!isDoctor && ` ${t('In an emergency, ask a doctor to use emergency access.')}`}
        </p>
      )}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('Emergency (break-glass) access')}
      >
        <form onSubmit={onSubmit}>
          <Alert tone="danger" title={t('Use only when urgent care requires it')}>
            <ul>
              <li>{t('Access expires automatically after 4 hours.')}</li>
              <li>{t('The reason and every view are recorded in the audit trail.')}</li>
              <li>{t('Your facility director reviews emergency access.')}</li>
              <li>{t('The patient can see that you accessed their record and why.')}</li>
            </ul>
          </Alert>
          <TextAreaField
            label={t('Clinical reason')}
            required
            minLength={10}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            hint={t(
              'At least 10 characters, e.g. “Unconscious patient in ED, treating doctor unavailable”.',
            )}
          />
          <ErrorAlert error={emergency.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button
              type="submit"
              variant="danger"
              loading={emergency.isPending}
              disabled={reason.trim().length < 10}
            >
              {t('Open record in emergency mode')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

/**
 * Shown when a clinician reads the record through their unit (ward, emergency, radiology…) or a
 * colleague's cover rather than as a member of the care team. That access ends on its own, so a
 * clinician who keeps caring for the patient joins the care team explicitly – never silently.
 */
export function TemporaryAccessNote({ patientId }: { patientId: string }) {
  const join = useChartMutation(patientId, () => ({
    path: '/care-team',
    method: 'POST',
    body: {},
  }));
  return (
    <Alert tone="info">
      <div className="row-between" style={{ gap: '0.75rem', flexWrap: 'wrap' }}>
        <span>
          <strong>{t('Temporary access')}</strong> –{' '}
          {t(
            'through your unit or a colleague’s cover. It ends on its own, for example when the patient leaves the unit.',
          )}
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => join.mutate(undefined)}
          loading={join.isPending}
          title={t(
            'Joining the care team is recorded in the audit trail and is visible to the patient.',
          )}
        >
          {t('Join care team')}
        </Button>
      </div>
      <ErrorAlert error={join.error} />
    </Alert>
  );
}
