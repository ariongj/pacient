import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client';
import type { ClinicalSummary, Facility, Referral } from '../../../api/types';
import { useUser } from '../../../auth/AuthContext';
import {
  Alert,
  Button,
  Dialog,
  ErrorAlert,
  formValues,
  QueryView,
  SelectField,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { humanize } from '../../../format';

/** Prefills the referral letter from the chart; the doctor edits it before sending. */
function summaryTemplate(s: ClinicalSummary): string {
  const problems = s.activeProblems.map((d) => `${d.description} (${d.icd10Code})`).join('; ');
  const meds = s.activeMedications
    .map((m) => `${m.medication} ${m.dosage} ${m.frequency}`)
    .join('; ');
  const allergies = s.allergies
    .filter((a) => a.verificationStatus === 'CONFIRMED' || a.verificationStatus === 'UNCONFIRMED')
    .map((a) => `${a.substance} (${humanize(a.severity)})`)
    .join('; ');
  return [
    `Active problems: ${problems || 'none recorded'}`,
    `Current medications: ${meds || 'none'}`,
    `Allergies: ${allergies || humanize(s.patient.allergyAssessment)}`,
    '',
    'History and reason for referral: ',
  ].join('\n');
}

export function ReferDialog({
  patientId,
  summary,
  open,
  onClose,
}: {
  patientId: string;
  summary: ClinicalSummary;
  open: boolean;
  onClose: () => void;
}) {
  const user = useUser();
  const qc = useQueryClient();
  const [sent, setSent] = useState<Referral | null>(null);
  const facilities = useQuery({
    queryKey: ['facilities', 'directory'],
    queryFn: () => api<{ items: Facility[] }>('/facilities'),
    enabled: open,
  });
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Referral>('/referrals', { method: 'POST', body }),
    onSuccess: (r) => {
      setSent(r);
      void qc.invalidateQueries({ queryKey: ['referrals'] });
    },
  });

  function close() {
    setSent(null);
    create.reset();
    onClose();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate({
      patientId,
      toFacilityId: v.toFacilityId,
      specialty: v.specialty,
      priority: v.priority,
      reason: v.reason,
      clinicalSummary: v.clinicalSummary,
    });
  }

  return (
    <Dialog open={open} onClose={close} title="Refer to another facility" wide>
      {sent ? (
        <div className="stack">
          <Alert tone="success" title="Referral sent">
            The receiving facility can now see your summary (not the full record). The patient has
            been notified. <Link to="/doctor/referrals">Track it under Referrals</Link>.
          </Alert>
          <div className="form-actions">
            <Button onClick={close}>Close</Button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit}>
          <Alert tone="info">
            Only this summary is shared while the referral is pending. If the receiving facility
            accepts, the assigned doctor joins the care team and can open the record. All steps are
            audited and visible to the patient.
          </Alert>
          <QueryView query={facilities}>
            {(d) => (
              <SelectField
                label="Receiving facility"
                name="toFacilityId"
                required
                placeholder="Choose a facility"
                options={d.items
                  .filter((f) => f.id !== user.facility?.id)
                  .map((f) => ({ value: f.id, label: `${f.name} (${f.region})` }))}
              />
            )}
          </QueryView>
          <div className="form-grid">
            <TextField label="Specialty" name="specialty" required minLength={2} maxLength={120} />
            <SelectField
              label="Priority"
              name="priority"
              defaultValue="ROUTINE"
              options={[
                { value: 'ROUTINE', label: 'Routine' },
                { value: 'URGENT', label: 'Urgent' },
              ]}
            />
          </div>
          <TextField label="Reason" name="reason" required minLength={5} maxLength={500} />
          <TextAreaField
            label="Clinical summary"
            name="clinicalSummary"
            required
            minLength={20}
            maxLength={10_000}
            rows={8}
            defaultValue={summaryTemplate(summary)}
            hint="Include only what the receiving clinician needs for this referral."
          />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Send referral
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
