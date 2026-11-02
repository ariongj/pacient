import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { EmailPreference, Guardianship } from '../api/types';
import { useAuth, useUser } from '../auth/AuthContext';
import { age, formatDate, humanize } from '../format';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  TextAreaField,
} from './ui';

const EMAIL_OPTIONS: { value: EmailPreference; label: string; help: string }[] = [
  { value: 'ALL', label: 'Every notification', help: 'An email for each new notification.' },
  {
    value: 'IMPORTANT',
    label: 'Important only',
    help: 'Results, appointment changes, messages, referrals, medication ready, urgent alerts.',
  },
  { value: 'OFF', label: 'Off', help: 'Notifications stay in the app only.' },
];

/** Email notification preference. Security emails (activation, password reset) are always sent. */
export function EmailPreferencesCard() {
  const user = useUser();
  const { reloadProfile } = useAuth();
  const mutation = useMutation({
    mutationFn: (emailNotifications: EmailPreference) =>
      api('/auth/me/preferences', { method: 'PATCH', body: { emailNotifications } }),
    onSuccess: () => reloadProfile(),
  });
  return (
    <Card title="Email notifications">
      <p className="muted">
        Emails tell you that something happened and link to Pacient. For your privacy they never
        include health information. They go to <strong>{user.email}</strong>.
      </p>
      <fieldset>
        <legend>Send me emails for</legend>
        <div className="stack" style={{ gap: '0.5rem' }}>
          {EMAIL_OPTIONS.map((o) => (
            <label key={o.value} className="checkbox" style={{ alignItems: 'flex-start' }}>
              <input
                type="radio"
                name="emailNotifications"
                value={o.value}
                checked={user.emailNotifications === o.value}
                disabled={mutation.isPending}
                onChange={() => mutation.mutate(o.value)}
                style={{ marginTop: '0.3rem' }}
              />
              <span>
                <strong>{o.label}</strong>
                <span className="muted" style={{ display: 'block', fontWeight: 400 }}>
                  {o.help}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <ErrorAlert error={mutation.error} />
      {mutation.isSuccess && <Alert tone="success" title="Saved" />}
    </Card>
  );
}

/** Records this account may open as a guardian. */
export function DependantsCard() {
  const { dependants, setActing } = useAuth();
  const navigate = useNavigate();
  if (!dependants.length) return null;
  return (
    <Card title="Family members I look after">
      <p className="muted">
        You were registered as a guardian after your facility checked your documents. Access to a
        child’s record ends on their 18th birthday.
      </p>
      <ul className="list">
        {dependants.map((d) => (
          <li key={d.patientId} className="row-between">
            <span>
              <strong>
                {d.firstName} {d.lastName}
              </strong>{' '}
              <span className="muted">
                {age(d.dateOfBirth)} y · {humanize(d.relationship)} ·{' '}
                {d.scope === 'FULL' ? 'full record' : 'appointments only'} · until{' '}
                {formatDate(d.validUntil)}
              </span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setActing(d.patientId);
                navigate(d.scope === 'FULL' ? '/portal' : '/portal/appointments');
              }}
            >
              Open record
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Who may act on this patient's behalf. Adults can revoke; minors ask their facility. */
export function MyGuardiansCard({
  patientId,
  dateOfBirth,
}: {
  patientId: string;
  dateOfBirth: string;
}) {
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState<Guardianship | null>(null);
  const isAdult = age(dateOfBirth) >= 18;
  const q = useQuery({
    queryKey: ['guardians', patientId],
    queryFn: () => api<{ items: Guardianship[] }>(`/patients/${patientId}/guardians`),
  });
  const revoke = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api(`/patients/${patientId}/guardians/${id}/revoke`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['guardians', patientId] });
      setRevoking(null);
    },
  });
  return (
    <Card title="People who can act for you">
      <QueryView query={q}>
        {(d) => {
          const active = d.items.filter((g) => g.active);
          return active.length ? (
            <>
              <p className="muted">
                These people can open your record on your behalf. Every time they do, it appears in
                “Who viewed my record”.
                {!isAdult && ' To change this, contact your health facility.'}
              </p>
              <ul className="list">
                {active.map((g) => (
                  <li key={g.id} className="row-between">
                    <span>
                      <strong>{g.guardianName}</strong>{' '}
                      <Badge tone="info">{humanize(g.relationship)}</Badge>{' '}
                      <span className="muted">
                        {g.scope === 'FULL' ? 'Full record' : 'Appointments only'} · until{' '}
                        {formatDate(g.validUntil)}
                      </span>
                    </span>
                    {isAdult && (
                      <Button size="sm" variant="secondary" onClick={() => setRevoking(g)}>
                        Remove access
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <EmptyState title="Nobody else can act on your behalf" />
          );
        }}
      </QueryView>
      <Dialog open={Boolean(revoking)} onClose={() => setRevoking(null)} title="Remove access">
        {revoking && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
              revoke.mutate({ id: revoking.id, reason });
            }}
          >
            <p>
              {revoking.guardianName} will immediately lose access to your record. This is recorded.
            </p>
            <TextAreaField label="Reason" name="reason" required minLength={3} maxLength={300} />
            <ErrorAlert error={revoke.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setRevoking(null)}>
                Cancel
              </Button>
              <Button type="submit" variant="danger" loading={revoke.isPending}>
                Remove access
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Card>
  );
}
