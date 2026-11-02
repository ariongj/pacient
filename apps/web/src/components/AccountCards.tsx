import { t } from '../i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { EmailPreference, Guardianship, SmsPreference } from '../api/types';
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
  TextField,
} from './ui';

const emailOptions = (): { value: EmailPreference; label: string; help: string }[] => [
  { value: 'ALL', label: t('Every notification'), help: t('An email for each new notification.') },
  {
    value: 'IMPORTANT',
    label: t('Important only'),
    help: t('Results, appointment changes, messages, referrals, medication ready, urgent alerts.'),
  },
  { value: 'OFF', label: t('Off'), help: t('Notifications stay in the app only.') },
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
    <Card title={t('Email notifications')}>
      <p className="muted">
        {t(
          'Emails tell you that something happened and link to Pacient. For your privacy they never include health information. They go to',
        )}{' '}
        <strong>{user.email}</strong>.
      </p>
      <fieldset>
        <legend>{t('Send me emails for')}</legend>
        <div className="stack" style={{ gap: '0.5rem' }}>
          {emailOptions().map((o) => (
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
      {mutation.isSuccess && <Alert tone="success" title={t('Saved')} />}
    </Card>
  );
}

/** Records this account may open as a guardian. */
export function DependantsCard() {
  const { dependants, setActing } = useAuth();
  const navigate = useNavigate();
  if (!dependants.length) return null;
  return (
    <Card title={t('Family members I look after')}>
      <p className="muted">
        {t(
          'You were registered as a guardian after your facility checked your documents. Access to a child’s record ends on their 18th birthday.',
        )}
      </p>
      <ul className="list">
        {dependants.map((d) => (
          <li key={d.patientId} className="row-between">
            <span>
              <strong>
                {d.firstName} {d.lastName}
              </strong>{' '}
              <span className="muted">
                {t('{age} y', { age: age(d.dateOfBirth) })} · {humanize(d.relationship)} ·{' '}
                {d.scope === 'FULL' ? t('full record') : t('appointments only')} ·{' '}
                {t('until {date}', { date: formatDate(d.validUntil) })}
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
              {t('Open record')}
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
    <Card title={t('People who can act for you')}>
      <QueryView query={q}>
        {(d) => {
          const active = d.items.filter((g) => g.active);
          return active.length ? (
            <>
              <p className="muted">
                {t(
                  'These people can open your record on your behalf. Every time they do, it appears in “Who viewed my record”.',
                )}
                {!isAdult && ` ${t('To change this, contact your health facility.')}`}
              </p>
              <ul className="list">
                {active.map((g) => (
                  <li key={g.id} className="row-between">
                    <span>
                      <strong>{g.guardianName}</strong>{' '}
                      <Badge tone="info">{humanize(g.relationship)}</Badge>{' '}
                      <span className="muted">
                        {g.scope === 'FULL' ? t('Full record') : t('Appointments only')} ·{' '}
                        {t('until {date}', { date: formatDate(g.validUntil) })}
                      </span>
                    </span>
                    {isAdult && (
                      <Button size="sm" variant="secondary" onClick={() => setRevoking(g)}>
                        {t('Remove access')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <EmptyState title={t('Nobody else can act on your behalf')} />
          );
        }}
      </QueryView>
      <Dialog open={Boolean(revoking)} onClose={() => setRevoking(null)} title={t('Remove access')}>
        {revoking && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
              revoke.mutate({ id: revoking.id, reason });
            }}
          >
            <p>
              {t('{name} will immediately lose access to your record. This is recorded.', {
                name: revoking.guardianName,
              })}
            </p>
            <TextAreaField
              label={t('Reason')}
              name="reason"
              required
              minLength={3}
              maxLength={300}
            />
            <ErrorAlert error={revoke.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setRevoking(null)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" variant="danger" loading={revoke.isPending}>
                {t('Remove access')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </Card>
  );
}

/**
 * Mobile number and SMS alerts. A number is used only after the owner enters the code sent to it.
 * Texts are reserved for important events and never contain health information.
 */
export function SmsCard() {
  const user = useUser();
  const { reloadProfile } = useAuth();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const request = useMutation({
    mutationFn: (phone: string) =>
      api<{ phone: string; expiresInMinutes: number }>('/auth/me/phone', {
        method: 'POST',
        body: { phone },
      }),
    onSuccess: (r) => setSentTo(r.phone),
  });
  const verify = useMutation({
    mutationFn: (code: string) => api('/auth/me/phone/verify', { method: 'POST', body: { code } }),
    onSuccess: async () => {
      setSentTo(null);
      setEditing(false);
      await reloadProfile();
    },
  });
  const remove = useMutation({
    mutationFn: () => api('/auth/me/phone', { method: 'DELETE' }),
    onSuccess: () => reloadProfile(),
  });
  const pref = useMutation({
    mutationFn: (smsNotifications: SmsPreference) =>
      api('/auth/me/preferences', { method: 'PATCH', body: { smsNotifications } }),
    onSuccess: () => reloadProfile(),
  });

  const showNumberForm = !sentTo && (!user.phone || editing);

  return (
    <Card title={t('SMS alerts')}>
      <p className="muted">
        {t(
          'Text messages are sent only for important events – such as a critical result, an appointment change or a medication ready to collect – and only say that something needs your attention. No health information is ever sent by SMS. Non-urgent texts wait until morning.',
        )}
      </p>

      {user.phone && !editing && !sentTo && (
        <div className="stack" style={{ gap: '0.75rem' }}>
          <div className="row-between">
            <span>
              {t('Mobile number')} <strong>{user.phone}</strong>{' '}
              <Badge tone="success">{t('Verified')}</Badge>
            </span>
            <span className="row" style={{ gap: '0.5rem' }}>
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                {t('Change')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                loading={remove.isPending}
                onClick={() => {
                  if (window.confirm(t('Remove your mobile number and stop all SMS alerts?')))
                    remove.mutate();
                }}
              >
                {t('Remove')}
              </Button>
            </span>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={user.smsNotifications === 'IMPORTANT'}
              disabled={pref.isPending}
              onChange={(e) => pref.mutate(e.currentTarget.checked ? 'IMPORTANT' : 'OFF')}
            />
            <span>{t('Text me about important events')}</span>
          </label>
        </div>
      )}

      {showNumberForm && (
        <form
          className="stack"
          style={{ gap: '0.75rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            const phone = new FormData(e.currentTarget).get('phone');
            if (typeof phone === 'string') request.mutate(phone);
          }}
        >
          <TextField
            label={t('Mobile number')}
            name="phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            required
            minLength={6}
            maxLength={30}
            placeholder="+383 44 123 456"
            hint={t('Kosovo numbers can be entered without the country code, e.g. 044 123 456.')}
          />
          <div className="form-actions">
            {editing && (
              <Button variant="secondary" onClick={() => setEditing(false)}>
                {t('Cancel')}
              </Button>
            )}
            <Button type="submit" loading={request.isPending}>
              {t('Send verification code')}
            </Button>
          </div>
        </form>
      )}

      {sentTo && (
        <form
          className="stack"
          style={{ gap: '0.75rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            const code = new FormData(e.currentTarget).get('code');
            if (typeof code === 'string') verify.mutate(code.trim());
          }}
        >
          <Alert tone="info" title={t('We sent a 6-digit code to {phone}', { phone: sentTo })}>
            {t('It expires in 10 minutes. Never share it with anyone, including Pacient staff.')}
          </Alert>
          <TextField
            label={t('Verification code')}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            required
            maxLength={6}
          />
          <div className="form-actions">
            <Button
              variant="secondary"
              onClick={() => {
                setSentTo(null);
                verify.reset();
              }}
            >
              {t('Use another number')}
            </Button>
            <Button type="submit" loading={verify.isPending}>
              {t('Verify number')}
            </Button>
          </div>
        </form>
      )}

      <ErrorAlert error={request.error ?? verify.error ?? remove.error ?? pref.error} />
      {(verify.isSuccess || pref.isSuccess) && !sentTo && (
        <Alert tone="success" title={t('Saved')} />
      )}
    </Card>
  );
}
