import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { HOME_BY_ROLE, useAuth } from '../../auth/AuthContext';
import { Button, ErrorAlert, Loading, TextField } from '../../components/ui';

const DEMO = import.meta.env.DEV
  ? [
      ['Ministry', 'minister@pacient.local'],
      ['Director', 'director@pacient.local'],
      ['Doctor', 'doctor@pacient.local'],
      ['Patient', 'patient@pacient.local'],
    ]
  : [];

export function LoginPage() {
  const { status, user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  if (status === 'loading') return <Loading label="Restoring your session…" />;
  if (user) return <Navigate to={HOME_BY_ROLE[user.role]} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await login(email, password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith(HOME_BY_ROLE[me.role]) ? from : HOME_BY_ROLE[me.role], {
        replace: true,
      });
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <main className="auth-card" id="main">
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden="true">
            +
          </span>
          <strong>Pacient</strong>
        </div>
        <h1>Sign in</h1>
        <p className="muted">Patients, clinicians, facility directors and Ministry officials.</p>
        <form onSubmit={onSubmit} noValidate={false}>
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
      </main>
    </div>
  );
}
