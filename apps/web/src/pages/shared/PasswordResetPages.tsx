import { t } from '../../i18n';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { Alert, Button, ErrorAlert, TextField } from '../../components/ui';
import { AuthCard } from './LoginPage';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard>
      <h1>{t('Reset your password')}</h1>
      {sent ? (
        <Alert tone="success" title={t('Check your email')}>
          {t('If an account exists for')} <strong>{email}</strong>
          {t(', we have sent a link to reset the password. The link expires in one hour.')}{' '}
          <Link to="/login">{t('Back to sign in')}</Link>
        </Alert>
      ) : (
        <form onSubmit={onSubmit}>
          <p className="muted">{t('Enter the email address of your account.')}</p>
          <TextField
            label={t('Email')}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <ErrorAlert error={error} />
          <Button type="submit" loading={busy} className="btn-block">
            {t('Send reset link')}
          </Button>
          <Link to="/login">{t('Back to sign in')}</Link>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError(new Error(t('The two passwords do not match')));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard>
      <h1>{t('Choose a new password')}</h1>
      {!token && <Alert tone="danger" title={t('This reset link is incomplete.')} />}
      {done ? (
        <Alert tone="success" title={t('Your password was changed.')}>
          {t('You have been signed out everywhere.')}{' '}
          <Link to="/login">{t('Sign in with your new password')}</Link>
        </Alert>
      ) : (
        <form onSubmit={onSubmit}>
          <TextField
            label={t('New password')}
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            hint={t('At least 12 characters. A passphrase of several words works well.')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <TextField
            label={t('Confirm password')}
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <ErrorAlert error={error} />
          <Button type="submit" loading={busy} disabled={!token} className="btn-block">
            {t('Set new password')}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
