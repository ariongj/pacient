import { t } from '../i18n';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import { useAuth, useUser } from '../auth/AuthContext';
import { Alert, Button, Card, ErrorAlert, TextField } from './ui';

/** QR code rendered locally – the secret never leaves the browser for a third-party service. */
function QrImage({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(value, { margin: 1, width: 200, errorCorrectionLevel: 'M' })
      .then(setSrc)
      .catch(() => setSrc(null));
  }, [value]);
  return src ? (
    <img
      src={src}
      width={200}
      height={200}
      alt={t('QR code to add Pacient to your authenticator app')}
    />
  ) : null;
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <Alert tone="warning" title={t('Save your recovery codes now')}>
      <p>
        {t(
          'Each code can be used once if you lose your phone. They will not be shown again. Store them somewhere safe (for example, printed in a locked drawer).',
        )}
      </p>
      <ul className="recovery-codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ul>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}
      >
        {t('Copy codes')}
      </Button>
    </Alert>
  );
}

/** Enrollment flow: generate secret → scan → confirm with a code → show recovery codes. */
export function TwoStepEnrollment({ onDone }: { onDone?: () => void }) {
  const { reloadProfile } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api('/auth/mfa/setup', { method: 'POST' }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ recoveryCodes: string[] }>('/auth/mfa/enable', {
        method: 'POST',
        body: { code },
      });
      setCodes(res.recoveryCodes);
    } catch (err) {
      setError(err);
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <div className="stack">
        <Alert tone="success" title={t('Two-step sign-in is on.')} />
        <RecoveryCodes codes={codes} />
        <div>
          <Button
            onClick={async () => {
              await reloadProfile();
              onDone?.();
            }}
          >
            {t('I have saved my codes')}
          </Button>
        </div>
      </div>
    );
  }

  if (!setup) {
    return (
      <div className="stack">
        <p>
          {t(
            'Two-step sign-in protects health records even if your password is stolen. You will need an authenticator app such as Google Authenticator, Microsoft Authenticator or Aegis.',
          )}
        </p>
        <ErrorAlert error={error} />
        <div>
          <Button onClick={start} loading={busy}>
            {t('Set up two-step sign-in')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={confirm}>
      <ol className="steps">
        <li>
          {t('Open your authenticator app and scan this code:')}
          <div className="qr">
            <QrImage value={setup.otpauthUrl} />
          </div>
          <details>
            <summary>{t('Can’t scan? Enter the key manually')}</summary>
            <code className="secret">{setup.secret.match(/.{1,4}/g)?.join(' ')}</code>
          </details>
        </li>
        <li>{t('Enter the 6-digit code the app shows to confirm.')}</li>
      </ol>
      <TextField
        label={t('Authentication code')}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        value={code}
        onChange={(e) => setCode(e.target.value.trim())}
      />
      <ErrorAlert error={error} />
      <div>
        <Button type="submit" loading={busy}>
          {t('Confirm and turn on')}
        </Button>
      </div>
    </form>
  );
}

/** Account settings card: status, recovery-code regeneration, and (patients only) turning it off. */
export function TwoStepCard() {
  const user = useUser();
  const { reloadProfile } = useAuth();
  const [mode, setMode] = useState<'idle' | 'regenerate' | 'disable'>('idle');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      if (mode === 'regenerate') {
        const res = await api<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', {
          method: 'POST',
          body: { code: f.get('code') },
        });
        setCodes(res.recoveryCodes);
      } else {
        await api('/auth/mfa/disable', {
          method: 'POST',
          body: { code: f.get('code'), password: f.get('password') },
        });
        await reloadProfile();
      }
      setMode('idle');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('Two-step sign-in')}>
      {!user.mfaEnabled ? (
        <TwoStepEnrollment />
      ) : (
        <div className="stack">
          <p>
            <strong>{t('On.')}</strong>{' '}
            {t('You are asked for a code from your authenticator app each time you sign in.')}
          </p>
          {codes && <RecoveryCodes codes={codes} />}
          {mode === 'idle' ? (
            <div className="row">
              <Button variant="secondary" onClick={() => setMode('regenerate')}>
                {t('New recovery codes')}
              </Button>
              {!user.mfaRequired && (
                <Button variant="secondary" onClick={() => setMode('disable')}>
                  {t('Turn off')}
                </Button>
              )}
            </div>
          ) : (
            <form onSubmit={onSubmit} className="form-narrow">
              {mode === 'disable' && (
                <TextField
                  label={t('Password')}
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              )}
              <TextField
                label={t('Current authentication code')}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
              <ErrorAlert error={error} />
              <div className="row">
                <Button
                  type="submit"
                  loading={busy}
                  variant={mode === 'disable' ? 'danger' : 'primary'}
                >
                  {mode === 'disable' ? t('Turn off two-step sign-in') : t('Generate new codes')}
                </Button>
                <Button variant="secondary" onClick={() => setMode('idle')}>
                  {t('Cancel')}
                </Button>
              </div>
            </form>
          )}
          {user.mfaRequired && (
            <p className="muted">{t('Two-step sign-in is mandatory for staff accounts.')}</p>
          )}
        </div>
      )}
    </Card>
  );
}
