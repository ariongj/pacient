import { useQuery } from '@tanstack/react-query';
import { type FormEvent } from 'react';
import { api } from '../../../api/client';
import type { Page, Referral, StaffMember } from '../../../api/types';
import {
  Button,
  Dialog,
  ErrorAlert,
  formValues,
  QueryView,
  SelectField,
  TextAreaField,
} from '../../../components/ui';

/** Director: choose the receiving doctor before accepting. */
export function AcceptAssignDialog({
  referral,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  referral: Referral | null;
  busy: boolean;
  error: unknown;
  onSubmit: (body: { doctorId: string; responseNote?: string }) => void;
  onClose: () => void;
}) {
  const doctors = useQuery({
    queryKey: ['staff', { role: 'DOCTOR', pageSize: 100 }],
    queryFn: () => api<Page<StaffMember>>('/staff', { query: { role: 'DOCTOR', pageSize: 100 } }),
    enabled: Boolean(referral),
  });
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    onSubmit({
      doctorId: v.doctorId!,
      ...(v.responseNote ? { responseNote: v.responseNote } : {}),
    });
  }
  return (
    <Dialog open={Boolean(referral)} onClose={onClose} title="Accept referral and assign a doctor">
      {referral && (
        <form onSubmit={submit}>
          <p className="muted">
            The doctor you assign joins {referral.patientName}’s care team and gains access to the
            record. This is audited and visible to the patient.
          </p>
          <QueryView query={doctors}>
            {(d) => (
              <SelectField
                label="Receiving doctor"
                name="doctorId"
                required
                defaultValue={referral.toDoctorId ?? ''}
                placeholder="Choose a doctor"
                options={d.items
                  .filter((s) => s.isActive)
                  .map((s) => ({
                    value: s.id,
                    label: `${s.fullName}${s.specialty ? ` — ${s.specialty}` : ''}`,
                  }))}
              />
            )}
          </QueryView>
          <TextAreaField
            label="Note to the referring doctor (optional)"
            name="responseNote"
            maxLength={2000}
            rows={2}
          />
          <ErrorAlert error={error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy}>
              Accept and assign
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Decline or complete: both require a response note for the referring doctor. */
export function ResponseNoteDialog({
  referral,
  kind,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  referral: Referral | null;
  kind: 'decline' | 'complete';
  busy: boolean;
  error: unknown;
  onSubmit: (body: { responseNote: string }) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={Boolean(referral)}
      onClose={onClose}
      title={kind === 'decline' ? 'Decline referral' : 'Complete referral'}
    >
      {referral && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit({ responseNote: formValues(e.currentTarget).responseNote ?? '' });
          }}
        >
          <TextAreaField
            label={kind === 'decline' ? 'Reason for declining' : 'Outcome for the referring doctor'}
            name="responseNote"
            required
            minLength={3}
            maxLength={2000}
            hint={
              kind === 'decline'
                ? 'Suggest where the patient could be referred instead, if possible.'
                : 'Summarise findings and the follow-up plan.'
            }
          />
          <ErrorAlert error={error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy}
              variant={kind === 'decline' ? 'danger' : 'primary'}
            >
              {kind === 'decline' ? 'Decline referral' : 'Mark completed'}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
