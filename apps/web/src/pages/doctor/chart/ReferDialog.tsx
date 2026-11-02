import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../../api/client';
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
  // Set when the patient has withdrawn consent to sharing with other facilities: the doctor must
  // confirm the patient's agreement before the referral can be sent.
  const [pending, setPending] = useState<Record<string, unknown> | null>(null);
  const [consentMethod, setConsentMethod] = useState<'IN_PERSON' | 'WRITTEN'>('IN_PERSON');
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Referral>('/referrals', { method: 'POST', body }),
    onSuccess: (r) => {
      setSent(r);
      setPending(null);
      void qc.invalidateQueries({ queryKey: ['referrals'] });
      void qc.invalidateQueries({ queryKey: ['patient', patientId, 'consents'] });
    },
    onError: (err, body) => {
      if (err instanceof ApiError && err.code === 'CONSENT_WITHDRAWN') {
        const { consentConfirmed: _c, ...rest } = body;
        setPending(rest);
      }
    },
  });
  const consentForms = useQuery({
    queryKey: ['patient', patientId, 'documents'],
    queryFn: () =>
      api<{ items: { id: string; title: string; category: string; status: string }[] }>(
        `/patients/${patientId}/documents`,
      ).then((r) => r.items.filter((d) => d.category === 'CONSENT_FORM' && d.status === 'CURRENT')),
    enabled: Boolean(pending) && consentMethod === 'WRITTEN',
    retry: false,
  });
  const consentBlocked =
    create.error instanceof ApiError && create.error.code === 'CONSENT_WITHDRAWN';

  function close() {
    setSent(null);
    setPending(null);
    create.reset();
    onClose();
  }

  function onConfirmConsent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!pending) return;
    const v = formValues(e.currentTarget);
    create.mutate({
      ...pending,
      consentConfirmed: {
        method: consentMethod,
        note: v.consentNote,
        documentId: consentMethod === 'WRITTEN' ? v.documentId : undefined,
      },
    });
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
        <>
          {pending && (
            <form onSubmit={onConfirmConsent}>
              <Alert tone="warning" title="The patient has withdrawn consent to sharing">
                This patient asked that their record is not shared with other facilities. Discuss
                this referral with them. If they agree, record how they agreed – this is added to
                their consent history and the referral is sent.
              </Alert>
              <SelectField
                label="How did the patient agree?"
                name="consentMethod"
                required
                value={consentMethod}
                onChange={(e) => setConsentMethod(e.currentTarget.value as 'IN_PERSON' | 'WRITTEN')}
                options={[
                  { value: 'IN_PERSON', label: 'In person (verbal)' },
                  { value: 'WRITTEN', label: 'Signed form' },
                ]}
              />
              {consentMethod === 'WRITTEN' && (
                <SelectField
                  label="Signed consent form"
                  name="documentId"
                  required
                  placeholder={
                    consentForms.isLoading
                      ? 'Loading documents…'
                      : consentForms.data?.length
                        ? 'Choose the signed form'
                        : 'No consent forms uploaded'
                  }
                  options={(consentForms.data ?? []).map((d) => ({ value: d.id, label: d.title }))}
                />
              )}
              <TextAreaField
                label="What was discussed"
                name="consentNote"
                required
                minLength={10}
                maxLength={1000}
                rows={3}
                hint="e.g. “Discussed in clinic; patient agrees to sharing for this cardiology referral.”"
              />
              {!consentBlocked && <ErrorAlert error={create.error} />}
              <div className="form-actions">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPending(null);
                    create.reset();
                  }}
                >
                  Back
                </Button>
                <Button type="submit" loading={create.isPending}>
                  Confirm agreement and send referral
                </Button>
              </div>
            </form>
          )}
          <form onSubmit={onSubmit} style={pending ? { display: 'none' } : undefined}>
            <Alert tone="info">
              Only this summary is shared while the referral is pending. If the receiving facility
              accepts, the assigned doctor joins the care team and can open the record. All steps
              are audited and visible to the patient.
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
              <TextField
                label="Specialty"
                name="specialty"
                required
                minLength={2}
                maxLength={120}
              />
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
        </>
      )}
    </Dialog>
  );
}
