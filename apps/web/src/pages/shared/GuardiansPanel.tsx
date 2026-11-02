import { t } from '../../i18n';
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

const relationships = (): { value: GuardianRelationship; label: string }[] => [
  { value: 'PARENT', label: t('Parent') },
  { value: 'LEGAL_GUARDIAN', label: t('Legal guardian (court-appointed)') },
  { value: 'FOSTER_CARER', label: t('Foster carer') },
  { value: 'OTHER_AUTHORISED', label: t('Other authorised person') },
];

const scopes = (): { value: ProxyScope; label: string }[] => [
  { value: 'FULL', label: t('Full – health record, appointments and messages') },
  { value: 'APPOINTMENTS', label: t('Appointments only – scheduling and contact details') },
];

function statusOf(g: Guardianship): { tone: 'success' | 'neutral' | 'danger'; label: string } {
  if (g.revokedAt) return { tone: 'danger', label: t('Revoked') };
  if (g.active) return { tone: 'success', label: t('Active') };
  return { tone: 'neutral', label: t('Expired') };
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
        <Alert tone="success" title={t('Guardian added')}>
          {t('They can now act for this patient from their own portal account.')}
        </Alert>
        {mutation.data.activationUrl && (
          <Alert tone="info" title={t('Portal activation link')}>
            <p>
              {t(
                'The guardian has no Pacient account yet. Give them this single-use link to choose a password. In production it is delivered by email and not shown here.',
              )}
            </p>
            <code style={{ wordBreak: 'break-all' }}>{mutation.data.activationUrl}</code>
          </Alert>
        )}
        <div className="form-actions">
          <Button onClick={onDone}>{t('Done')}</Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit}>
      <Alert tone="info">
        {t(
          'Check original documents before adding a guardian (for example a birth certificate or court order). Staff accounts cannot be guardians — use the guardian’s personal email address.',
        )}
      </Alert>
      <div className="form-grid">
        <TextField label={t('Guardian’s full name')} name="fullName" required minLength={2} />
        <TextField label={t('Guardian’s email')} name="email" type="email" required />
        <SelectField
          label={t('Relationship')}
          name="relationship"
          required
          defaultValue={isAdult ? 'LEGAL_GUARDIAN' : 'PARENT'}
          options={relationships()}
        />
        <SelectField
          label={t('Access')}
          name="scope"
          required
          defaultValue="FULL"
          options={scopes()}
          hint={t('Appointments-only guardians never see clinical information.')}
        />
      </div>
      <TextAreaField
        label={t('Evidence checked')}
        name="evidence"
        required
        minLength={5}
        maxLength={300}
        rows={2}
        hint={t('Document type and number, e.g. “Birth certificate 4411/2016”.')}
      />
      <TextField
        label={t('Access ends on')}
        name="validUntil"
        type="date"
        required={isAdult}
        hint={
          isAdult
            ? t('Required for adults: the end date from the court order (at most 5 years ahead).')
            : t('Optional. For children, access ends automatically on their 18th birthday.')
        }
      />
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          {t('Add guardian')}
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
        <strong>{guardianship.guardianName}</strong>{' '}
        {t('will lose access immediately, including any session they have open.')}
      </p>
      <TextAreaField
        label={t('Reason')}
        name="reason"
        required
        minLength={3}
        maxLength={300}
        rows={2}
        hint={t('e.g. custody arrangement changed, request of the patient.')}
      />
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onDone}>
          {t('Cancel')}
        </Button>
        <Button type="submit" variant="danger" loading={mutation.isPending}>
          {t('Revoke access')}
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
          {t(
            'Guardians act for the patient from their own portal account. Every view is audited and appears in the patient’s access log; revocation takes effect immediately.',
          )}
        </p>
        {canManage && <Button onClick={() => setAdding(true)}>{t('Add guardian')}</Button>}
      </div>
      <QueryView query={q}>
        {(d) =>
          d.items.length === 0 ? (
            <EmptyState title={t('No guardians registered')} />
          ) : (
            <Table caption={t('Guardians with proxy access to this patient')}>
              <thead>
                <tr>
                  <th scope="col">{t('Guardian')}</th>
                  <th scope="col">{t('Relationship')}</th>
                  <th scope="col">{t('Access')}</th>
                  <th scope="col">{t('Valid until')}</th>
                  <th scope="col">{t('Evidence')}</th>
                  <th scope="col">{t('Status')}</th>
                  {canManage && (
                    <th scope="col">
                      <span className="sr-only">{t('Actions')}</span>
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
                        {!g.guardianActivated && (
                          <Badge tone="warning">{t('Invitation pending')}</Badge>
                        )}
                      </td>
                      <td>{humanize(g.relationship)}</td>
                      <td>{g.scope === 'FULL' ? t('Full record') : t('Appointments only')}</td>
                      <td>{formatDate(g.validUntil)}</td>
                      <td>
                        {g.evidence}
                        <div className="muted">
                          {t('Verified by {name}', { name: g.verifiedBy })}
                        </div>
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
                              {t('Revoke')}
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
          <Dialog open={adding} onClose={() => setAdding(false)} title={t('Add guardian')} wide>
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
            title={t('Revoke guardian access')}
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
