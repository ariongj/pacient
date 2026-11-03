import { t } from '../../i18n';
import { LanguageSwitcher } from '../../i18n/LanguageSwitcher';
import { useEffect, useRef, useState, type FormEvent } from 'react';
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
import {
  completeMfaWithPasskey,
  isPasskeyCancel,
  passkeyAutofillSupported,
  passkeyMfaOptions,
  passkeysSupported,
  signInWithPasskey,
} from '../../api/security';

const DEMO = import.meta.env.DEV
  ? [
      ['Ministry', 'minister@pacient.local'],
      ['Director', 'director@pacient.local'],
      ['Doctor', 'doctor@pacient.local'],
      ['Nurse', 'nurse@pacient.local'],
      ['Pharmacist', 'pharmacist@pacient.local'],
      ['Reception', 'reception@pacient.local'],
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
          <span style={{ marginLeft: 'auto' }}>
            <LanguageSwitcher />
          </span>
        </div>
        {children}
      </main>
    </div>
  );
}

export function LoginPage() {
  const { status, user, login, verifyMfa, reloadProfile } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  /** Passkey options for the second step, when the account has a passkey. */
  const [mfaPasskey, setMfaPasskey] = useState<Awaited<ReturnType<typeof passkeyMfaOptions>>>(null);
  const autofillStarted = useRef(false);

  // Conditional UI: the browser offers saved passkeys in the email field's autofill.
  useEffect(() => {
    if (status !== 'anonymous' || autofillStarted.current) return;
    autofillStarted.current = true;
    let active = true;
    void (async () => {
      if (!(await passkeyAutofillSupported())) return;
      try {
        await signInWithPasskey({ autofill: true });
        if (active) goHome(await reloadProfile());
      } catch {
        /* cancelled, superseded by the button, or not available */
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // When a password sign-in needs a second step, offer the passkey if the account has one.
  useEffect(() => {
    setMfaPasskey(null);
    if (!challenge || !passkeysSupported()) return;
    let active = true;
    void passkeyMfaOptions(challenge).then((o) => {
      if (active) setMfaPasskey(o);
    });
    return () => {
      active = false;
    };
  }, [challenge]);

  async function onPasskey() {
    setPasskeyBusy(true);
    setError(null);
    try {
      await signInWithPasskey();
      goHome(await reloadProfile());
    } catch (err) {
      if (!isPasskeyCancel(err)) setError(err);
    } finally {
      setPasskeyBusy(false);
    }
  }

  async function onMfaPasskey() {
    if (!challenge || !mfaPasskey) return;
    setPasskeyBusy(true);
    setError(null);
    try {
      await completeMfaWithPasskey(challenge, mfaPasskey);
      goHome(await reloadProfile());
    } catch (err) {
      if (!isPasskeyCancel(err)) setError(err);
      // Challenges are single-use: fetch a fresh one for the next attempt.
      setMfaPasskey(await passkeyMfaOptions(challenge));
    } finally {
      setPasskeyBusy(false);
    }
  }

  if (status === 'loading') return <Loading label={t('Restoring your session…')} />;
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
        <h1>{t('Two-step sign-in')}</h1>
        {mfaPasskey && (
          <div className="stack" style={{ marginBottom: '1rem' }}>
            <Button onClick={onMfaPasskey} loading={passkeyBusy} className="btn-block">
              {t('Use a passkey')}
            </Button>
            <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
              {t('or enter a code')}
            </p>
          </div>
        )}
        <p className="muted">
          {useRecovery
            ? t(
                'Enter one of the recovery codes you saved when you set up two-step sign-in. Each code works once.',
              )
            : t('Enter the 6-digit code from your authenticator app.')}
        </p>
        <form onSubmit={onCode}>
          <TextField
            label={useRecovery ? t('Recovery code') : t('Authentication code')}
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
            {t('Verify')}
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
            {useRecovery ? t('Use authenticator code') : t('Use a recovery code')}
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
            {t('Start over')}
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <h1>{t('Sign in')}</h1>
      <p className="muted">
        {t(
          'Patients, clinicians, pharmacy and front-desk teams, facility directors and the Ministry.',
        )}
      </p>
      <form onSubmit={onPassword}>
        <TextField
          label={t('Email')}
          type="email"
          name="email"
          autoComplete="username webauthn"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label={t('Password')}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorAlert error={error} />
        <Button type="submit" loading={busy} className="btn-block">
          {t('Sign in')}
        </Button>
      </form>
      {passkeysSupported() && (
        <Button
          variant="secondary"
          className="btn-block"
          loading={passkeyBusy}
          onClick={onPasskey}
          style={{ marginTop: '0.75rem' }}
        >
          {t('Sign in with a passkey')}
        </Button>
      )}
      <p style={{ marginTop: '1rem' }}>
        <Link to="/forgot-password">{t('Forgot your password?')}</Link>
      </p>
      {DEMO.length > 0 && (
        <div className="demo-accounts">
          <p className="muted">
            {t('Demo accounts (development only) — password')} <code>Pacient-Demo-2026</code>
          </p>
          <div className="demo-buttons">
            {DEMO.map(([role, addr]) => (
              <Button
                key={addr}
                variant="secondary"
                size="sm"
                onClick={() => {
                  setEmail(addr!);
                  setPassword('Pacient-Demo-2026');
                }}
              >
                {t(role!)}
              </Button>
            ))}
          </div>
        </div>
      )}
    </AuthCard>
  );
}
