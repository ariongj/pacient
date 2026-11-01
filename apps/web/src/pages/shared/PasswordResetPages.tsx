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
      <h1>Reset your password</h1>
      {sent ? (
        <Alert tone="success" title="Check your email">
          If an account exists for <strong>{email}</strong>, we have sent a link to reset the
          password. The link expires in one hour. <Link to="/login">Back to sign in</Link>
        </Alert>
      ) : (
        <form onSubmit={onSubmit}>
          <p className="muted">Enter the email address of your account.</p>
          <TextField
            label="Email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <ErrorAlert error={error} />
          <Button type="submit" loading={busy} className="btn-block">
            Send reset link
          </Button>
          <Link to="/login">Back to sign in</Link>
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
      setError(new Error('The two passwords do not match'));
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
      <h1>Choose a new password</h1>
      {!token && <Alert tone="danger" title="This reset link is incomplete." />}
      {done ? (
        <Alert tone="success" title="Your password was changed.">
          You have been signed out everywhere. <Link to="/login">Sign in with your new password</Link>
        </Alert>
      ) : (
        <form onSubmit={onSubmit}>
          <TextField
            label="New password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            hint="At least 12 characters. A passphrase of several words works well."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <TextField
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          <ErrorAlert error={error} />
          <Button type="submit" loading={busy} disabled={!token} className="btn-block">
            Set new password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
