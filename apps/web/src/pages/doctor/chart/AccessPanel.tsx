import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Dialog, ErrorAlert, TextAreaField } from '../../../components/ui';
import { useChartMutation } from './shared';

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
    <Card title="You are not in this patient’s care team">
      <p>
        Clinical records are available only to the doctors treating the patient. Choose how you need
        to access this record.
      </p>
      {!sameFacility && (
        <Alert tone="info">
          This patient is registered at another facility. Records are not shared across institutions
          from this workspace.
        </Alert>
      )}
      <ErrorAlert error={join.error} />
      <div className="row">
        {sameFacility && (
          <Button onClick={() => join.mutate(undefined)} loading={join.isPending}>
            Join care team
          </Button>
        )}
        {sameFacility && (
          <Button variant="danger" onClick={() => setOpen(true)}>
            Emergency access…
          </Button>
        )}
      </div>
      {sameFacility && (
        <p className="muted" style={{ marginTop: '0.75rem' }}>
          Joining the care team is recorded in the audit trail and is visible to the patient.
        </p>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title="Emergency (break-glass) access">
        <form onSubmit={onSubmit}>
          <Alert tone="danger" title="Use only when urgent care requires it">
            <ul>
              <li>Access expires automatically after 4 hours.</li>
              <li>The reason and every view are recorded in the audit trail.</li>
              <li>Your facility director reviews emergency access.</li>
              <li>The patient can see that you accessed their record and why.</li>
            </ul>
          </Alert>
          <TextAreaField
            label="Clinical reason"
            required
            minLength={10}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            hint="At least 10 characters, e.g. “Unconscious patient in ED, treating doctor unavailable”."
          />
          <ErrorAlert error={emergency.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              loading={emergency.isPending}
              disabled={reason.trim().length < 10}
            >
              Open record in emergency mode
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
