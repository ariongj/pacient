import { useEffect, useState, type FormEvent } from 'react';
import { errorCodeOf, setReauthHandler } from '../api/client';
import { t } from '../i18n';
import { Alert, Button, Dialog, TextField } from './ui';

interface Prompt {
  retry: (password: string) => Promise<Response>;
  refused: Response;
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
}

/**
 * The one dialog that asks for the password again when the server wants a sensitive action
 * re-confirmed (401 REAUTH_REQUIRED: bank details, administrator accounts, credit notes,
 * exports …). Mounted once in App; any request made through the api client can trigger it, so no
 * page needs its own password prompt. The request is sent once more with the password; a wrong
 * password keeps the dialog open, anything else (success or another error) goes back to the page
 * that made the request. Cancelling gives the page the original REAUTH_REQUIRED error. Requests
 * that need it at the same time are asked one after another.
 */
export function ReauthDialog() {
  const [queue, setQueue] = useState<Prompt[]>([]);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = queue[0];

  useEffect(() => {
    setReauthHandler(
      ({ retry, refused }) =>
        new Promise<Response>((resolve, reject) => {
          setQueue((q) => [...q, { retry, refused, resolve, reject }]);
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  const finish = (settle: (p: Prompt) => void) => {
    if (!current) return;
    settle(current);
    setQueue((q) => q.slice(1));
    setPassword('');
    setWrong(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!current || !password) return;
    setBusy(true);
    try {
      const res = await current.retry(password);
      if (res.status === 401 && (await errorCodeOf(res)) === 'REAUTH_REQUIRED') {
        setWrong(true);
        setPassword('');
      } else {
        finish((p) => p.resolve(res));
      }
    } catch (err) {
      finish((p) => p.reject(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={Boolean(current)}
      onClose={() => finish((p) => p.resolve(p.refused))}
      title={t('Confirm it is you')}
    >
      <form className="stack" onSubmit={submit}>
        <p style={{ margin: 0 }}>{t('This action needs your password again.')}</p>
        {wrong && <Alert tone="danger" title={t('The password is not correct. Try again.')} />}
        <TextField
          label={t('Password')}
          type="password"
          name="reauth-password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <div className="form-actions">
          <Button type="submit" loading={busy}>
            {t('Confirm')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => finish((p) => p.resolve(p.refused))}
          >
            {t('Cancel')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
