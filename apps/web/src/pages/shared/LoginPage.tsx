import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { Profile } from '../../api/types';
import {
  HOME_BY_ROLE,
  isChallenge,
  MFA_SETUP_PATH,
  needsMfaEnrollment,
  useAuth,
} from '../../auth/AuthContext';
import { Button, ErrorAlert, Loading, TextField } from '../../components/ui';

const DEMO = import.meta.env.DEV
  ? [
      ['Ministry', 'minister@pacient.local'],
      ['Director', 'director@pacient.local'],
      ['Doctor', 'doctor@pacient.local'],
      ['Patient', 'patient@pacient.local'],
    ]
  : [];

export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-page">
      <main className="auth-card" id="main">
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden="true">
            +
          </span>
          <strong>Pacient</strong>
        </div>
        {children}
      </main>
    </div>
  );
}

export function LoginPage() {
  const { status, user, login, verifyMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');

  if (status === 'loading') return <Loading label="Restoring your session…" />;
  if (user) {
    return (
      <Navigate to={needsMfaEnrollment(user) ? MFA_SETUP_PATH : HOME_BY_ROLE[user.role]} replace />
    );
  }

  function goHome(me: Profile) {
    if (needsMfaEnrollment(me)) {
      navigate(MFA_SETUP_PATH, { replace: true });
      return;
    }
    const from = (location.state as { from?: string } | null)?.from;
    navigate(from && from.startsWith(HOME_BY_ROLE[me.role]) ? from : HOME_BY_ROLE[me.role], {
      replace: true,
    });
  }

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(email, password);
      if (isChallenge(result)) setChallenge(result.mfaToken);
      else goHome(result);
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  async function onCode(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setBusy(true);
    setError(null);
    try {
      goHome(await verifyMfa(challenge, useRecovery ? { recoveryCode: code } : { code }));
    } catch (err) {
      setError(err);
      setCode('');
      if (
        (err as { status?: number }).status === 401 &&
        /expired/i.test(String((err as Error).message))
      ) {
        setChallenge(null);
      }
    } finally {
      setBusy(false);
    }
  }

  if (challenge) {
    return (
      <AuthCard>
        <h1>Two-step sign-in</h1>
        <p className="muted">
          {useRecovery
            ? 'Enter one of the recovery codes you saved when you set up two-step sign-in. Each code works once.'
            : 'Enter the 6-digit code from your authenticator app.'}
        </p>
        <form onSubmit={onCode}>
          <TextField
            label={useRecovery ? 'Recovery code' : 'Authentication code'}
            name="code"
            autoComplete="one-time-code"
            inputMode={useRecovery ? 'text' : 'numeric'}
            pattern={useRecovery ? undefined : '[0-9]{6}'}
            maxLength={useRecovery ? 20 : 6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.trim())}
          />
          <ErrorAlert error={error} />
          <Button type="submit" loading={busy} className="btn-block">
            Verify
          </Button>
        </form>
        <div className="row-between" style={{ marginTop: '1rem' }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setUseRecovery((v) => !v);
              setCode('');
              setError(null);
            }}
          >
            {useRecovery ? 'Use authenticator code' : 'Use a recovery code'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setChallenge(null);
              setPassword('');
              setCode('');
            }}
          >
            Start over
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <h1>Sign in</h1>
      <p className="muted">Patients, clinicians, facility directors and Ministry officials.</p>
      <form onSubmit={onPassword}>
        <TextField
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorAlert error={error} />
        <Button type="submit" loading={busy} className="btn-block">
          Sign in
        </Button>
      </form>
      <p style={{ marginTop: '1rem' }}>
        <Link to="/forgot-password">Forgot your password?</Link>
      </p>
      {DEMO.length > 0 && (
        <div className="demo-accounts">
          <p className="muted">
            Demo accounts (development only) — password <code>Pacient-Demo-2026</code>
          </p>
          <div className="demo-buttons">
            {DEMO.map(([label, addr]) => (
              <Button
                key={addr}
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEmail(addr!);
                  setPassword('Pacient-Demo-2026');
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      )}
    </AuthCard>
  );
}
