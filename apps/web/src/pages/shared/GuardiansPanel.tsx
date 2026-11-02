import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { GuardianRelationship, Guardianship, ProxyScope } from '../../api/types';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  SelectField,
  Table,
  TextAreaField,
  TextField,
  formValues,
} from '../../components/ui';
import { age, formatDate, humanize } from '../../format';

const RELATIONSHIPS: { value: GuardianRelationship; label: string }[] = [
  { value: 'PARENT', label: 'Parent' },
  { value: 'LEGAL_GUARDIAN', label: 'Legal guardian (court-appointed)' },
  { value: 'FOSTER_CARER', label: 'Foster carer' },
  { value: 'OTHER_AUTHORISED', label: 'Other authorised person' },
];

const SCOPES: { value: ProxyScope; label: string }[] = [
  { value: 'FULL', label: 'Full – health record, appointments and messages' },
  { value: 'APPOINTMENTS', label: 'Appointments only – scheduling and contact details' },
];

function statusOf(g: Guardianship): { tone: 'success' | 'neutral' | 'danger'; label: string } {
  if (g.revokedAt) return { tone: 'danger', label: 'Revoked' };
  if (g.active) return { tone: 'success', label: 'Active' };
  return { tone: 'neutral', label: 'Expired' };
}

const sortGuardians = (items: Guardianship[]) =>
  [...items].sort((a, b) => Number(b.active) - Number(a.active));

function AddGuardianForm({
  patientId,
  patientDateOfBirth,
  onDone,
}: {
  patientId: string;
  patientDateOfBirth?: string;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const isAdult = patientDateOfBirth ? age(patientDateOfBirth) >= 18 : false;
  const mutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ guardianship: Guardianship; activationUrl?: string }>(
        `/patients/${patientId}/guardians`,
        { method: 'POST', body },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['guardians', patientId] });
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    mutation.mutate({
      email: v.email,
      fullName: v.fullName,
      relationship: v.relationship,
      scope: v.scope,
      evidence: v.evidence,
      ...(v.validUntil ? { validUntil: v.validUntil } : {}),
    });
  }

  if (mutation.isSuccess) {
    return (
      <div className="stack">
        <Alert tone="success" title="Guardian added">
          They can now act for this patient from their own portal account.
        </Alert>
        {mutation.data.activationUrl && (
          <Alert tone="info" title="Portal activation link">
            <p>
              The guardian has no Pacient account yet. Give them this single-use link to choose a
              password. In production it is delivered by email and not shown here.
            </p>
            <code style={{ wordBreak: 'break-all' }}>{mutation.data.activationUrl}</code>
          </Alert>
        )}
        <div className="form-actions">
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <Alert tone="info">
        Check original documents before adding a guardian (for example a birth certificate or court
        order). Staff accounts cannot be guardians — use the guardian’s personal email address.
      </Alert>
      <div className="form-grid">
        <TextField label="Guardian’s full name" name="fullName" required minLength={2} />
        <TextField label="Guardian’s email" name="email" type="email" required />
        <SelectField
          label="Relationship"
          name="relationship"
          required
          defaultValue={isAdult ? 'LEGAL_GUARDIAN' : 'PARENT'}
          options={RELATIONSHIPS}
        />
        <SelectField
          label="Access"
          name="scope"
          required
          defaultValue="FULL"
          options={SCOPES}
          hint="Appointments-only guardians never see clinical information."
        />
      </div>
      <TextAreaField
        label="Evidence checked"
        name="evidence"
        required
        minLength={5}
        maxLength={300}
        rows={2}
        hint="Document type and number, e.g. “Birth certificate 4411/2016”."
      />
      <TextField
        label="Access ends on"
        name="validUntil"
        type="date"
        required={isAdult}
        hint={
          isAdult
            ? 'Required for adults: the end date from the court order (at most 5 years ahead).'
            : 'Optional. For children, access ends automatically on their 18th birthday.'
        }
      />
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          Add guardian
        </Button>
      </div>
    </form>
  );
}

function RevokeForm({
  patientId,
  guardianship,
  onDone,
}: {
  patientId: string;
  guardianship: Guardianship;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: (reason: string) =>
      api(`/patients/${patientId}/guardians/${guardianship.id}/revoke`, {
        method: 'POST',
        body: { reason },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['guardians', patientId] });
      onDone();
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(formValues(e.currentTarget).reason ?? '');
      }}
    >
      <p>
        <strong>{guardianship.guardianName}</strong> will lose access immediately, including any
        session they have open.
      </p>
      <TextAreaField
        label="Reason"
        name="reason"
        required
        minLength={3}
        maxLength={300}
        rows={2}
        hint="e.g. custody arrangement changed, request of the patient."
      />
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="danger" loading={mutation.isPending}>
          Revoke access
        </Button>
      </div>
    </form>
  );
}

/**
 * Guardians (proxy access) of a patient. Front-desk staff and directors manage them; clinicians
 * see them read-only.
 */
export function GuardiansPanel({
  patientId,
  patientDateOfBirth,
  canManage,
}: {
  patientId: string;
  patientDateOfBirth?: string;
  canManage: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<Guardianship | null>(null);
  const q = useQuery({
    queryKey: ['guardians', patientId],
    queryFn: () => api<{ items: Guardianship[] }>(`/patients/${patientId}/guardians`),
  });

  return (
    <div className="stack">
      <div className="row-between">
        <p className="muted" style={{ margin: 0 }}>
          Guardians act for the patient from their own portal account. Every view is audited and
          appears in the patient’s access log; revocation takes effect immediately.
        </p>
        {canManage && <Button onClick={() => setAdding(true)}>Add guardian</Button>}
      </div>
      <QueryView query={q}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title="No guardians registered" />
          ) : (
            <Table caption="Guardians with proxy access to this patient">
              <thead>
                <tr>
                  <th scope="col">Guardian</th>
                  <th scope="col">Relationship</th>
                  <th scope="col">Access</th>
                  <th scope="col">Valid until</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">Status</th>
                  {canManage && (
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {sortGuardians(d.items).map((g) => {
                  const status = statusOf(g);
                  return (
                    <tr key={g.id}>
                      <td>
                        <strong>{g.guardianName}</strong>
                        {g.guardianEmail && <div className="muted">{g.guardianEmail}</div>}
                        {!g.guardianActivated && <Badge tone="warning">Invitation pending</Badge>}
                      </td>
                      <td>{humanize(g.relationship)}</td>
                      <td>{g.scope === 'FULL' ? 'Full record' : 'Appointments only'}</td>
                      <td>{formatDate(g.validUntil)}</td>
                      <td>
                        {g.evidence}
                        <div className="muted">Verified by {g.verifiedBy}</div>
                      </td>
                      <td>
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {g.revokedAt && (
                          <div className="muted">
                            {formatDate(g.revokedAt)}
                            {g.revokeReason ? ` – ${g.revokeReason}` : ''}
                          </div>
                        )}
                      </td>
                      {canManage && (
                        <td>
                          {g.active && (
                            <Button size="sm" variant="secondary" onClick={() => setRevoking(g)}>
                              Revoke
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      {canManage && (
        <>
          <Dialog open={adding} onClose={() => setAdding(false)} title="Add guardian" wide>
            {adding && (
              <AddGuardianForm
                patientId={patientId}
                patientDateOfBirth={patientDateOfBirth}
                onDone={() => setAdding(false)}
              />
            )}
          </Dialog>
          <Dialog
            open={revoking !== null}
            onClose={() => setRevoking(null)}
            title="Revoke guardian access"
          >
            {revoking && (
              <RevokeForm
                patientId={patientId}
                guardianship={revoking}
                onDone={() => setRevoking(null)}
              />
            )}
          </Dialog>
        </>
      )}
    </div>
  );
}
