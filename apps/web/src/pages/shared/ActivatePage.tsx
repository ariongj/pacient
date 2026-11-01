import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { Alert, Button, ErrorAlert, TextField } from '../../components/ui';

/** Invited users choose their own password; administrators never know it. */
export function ActivatePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
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
      await api('/auth/activate', { method: 'POST', body: { token, password } });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <main className="auth-card" id="main">
        <h1>Activate your account</h1>
        {!token && <Alert tone="danger" title="This activation link is incomplete." />}
        {done ? (
          <Alert tone="success" title="Your account is ready.">
            <Link to="/login">Continue to sign in</Link>
          </Alert>
        ) : (
          <form onSubmit={onSubmit}>
            <p className="muted">
              Choose a password of at least 12 characters. A memorable passphrase of several words
              works well.
            </p>
            <TextField
              label="New password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
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
              Activate account
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}
