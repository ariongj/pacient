import { t } from '../../i18n';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAuth, useUser } from '../../auth/AuthContext';
import { EmailPreferencesCard, SmsCard } from '../../components/AccountCards';
import { TwoStepCard } from '../../components/TwoStep';
import {
  Button,
  Card,
  DefinitionList,
  ErrorAlert,
  PageHeader,
  TextField,
} from '../../components/ui';
import { formatDateTime, humanize } from '../../format';

export function ChangePasswordCard() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    if (data.get('newPassword') !== data.get('confirm')) {
      setError(new Error(t('The new passwords do not match')));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: {
          currentPassword: data.get('currentPassword'),
          newPassword: data.get('newPassword'),
        },
      });
      // All sessions are revoked server-side; sign in again with the new password.
      await logout();
      navigate('/login', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('Change password')}>
      <form onSubmit={onSubmit} className="form-narrow">
        <TextField
          label={t('Current password')}
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
        <TextField
          label={t('New password')}
          name="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          hint={t('At least 12 characters. You will be signed out of all devices.')}
        />
        <TextField
          label={t('Confirm new password')}
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
        />
        <ErrorAlert error={error} />
        <Button type="submit" loading={busy}>
          {t('Change password')}
        </Button>
      </form>
    </Card>
  );
}

export function AccountPage() {
  const user = useUser();
  return (
    <>
      <PageHeader title={t('Account')} />
      <div className="stack">
        <Card title={t('Profile')}>
          <DefinitionList
            items={[
              [t('Name'), user.fullName],
              [t('Email'), user.email],
              [t('Role'), humanize(user.role)],
              [t('Facility'), user.facility?.name ?? '—'],
              [t('Last sign-in'), formatDateTime(user.lastLoginAt)],
            ]}
          />
        </Card>
        <TwoStepCard />
        <EmailPreferencesCard />
        <SmsCard />
        <ChangePasswordCard />
      </div>
    </>
  );
}
