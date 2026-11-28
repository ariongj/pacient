import { useEffect, useRef, useState, type FormEvent, type SyntheticEvent } from 'react';
import { errorCodeOf, setReauthHandler } from '../api/client';
import { t } from '../i18n';
import { Alert, Button, Dialog, TextField } from './ui';

interface Prompt {
  id: number;
  retry: (password: string) => Promise<Response>;
  refused: Response;
  resolve: (res: Response) => void;
  reject: (err: unknown) => void;
}

let nextPromptId = 1;

/**
 * The one dialog that asks for the password again when the server wants a sensitive action
 * re-confirmed (401 REAUTH_REQUIRED: bank details, administrator accounts, credit notes,
 * exports …). Mounted once in App; any request made through the api client can trigger it, so no
 * page needs its own password prompt. The request is sent once more with the password; a wrong
 * password keeps the dialog open, anything else (success or another error) goes back to the page
 * that made the request. Cancelling gives the page the original REAUTH_REQUIRED error – but not
 * while the password is on its way: the action may be going through, so Cancel, × and Esc wait
 * for the answer. Requests that need it at the same time are asked one after another; each
 * prompt is settled once and by its own identity, so nothing settles or drops another one.
 */
export function ReauthDialog() {
  const [queue, setQueue] = useState<Prompt[]>([]);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  /** A fresh dialog when the browser closed the shown one by itself (see onDialogClose). */
  const [generation, setGeneration] = useState(0);
  const settled = useRef(new WeakSet<Prompt>());
  const current = queue[0];

  useEffect(() => {
    setReauthHandler(
      ({ retry, refused }) =>
        new Promise<Response>((resolve, reject) => {
          const prompt = { id: nextPromptId++, retry, refused, resolve, reject };
          setQueue((q) => [...q, prompt]);
        }),
    );
    return () => setReauthHandler(null);
  }, []);

  const finish = (prompt: Prompt, settle: (p: Prompt) => void) => {
    if (settled.current.has(prompt)) return;
    settled.current.add(prompt);
    settle(prompt);
    setQueue((q) => q.filter((p) => p !== prompt));
    setPassword('');
    setWrong(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const prompt = current;
    if (!prompt || !password || busy) return;
    setBusy(true);
    try {
      const res = await prompt.retry(password);
      if (res.status === 401 && (await errorCodeOf(res)) === 'REAUTH_REQUIRED') {
        setWrong(true);
        setPassword('');
      } else {
        finish(prompt, (p) => p.resolve(res));
      }
    } catch (err) {
      finish(prompt, (p) => p.reject(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (current && !busy) finish(current, (p) => p.resolve(p.refused));
  };

  /**
   * The ui Dialog calls this for its × button, for Esc (the cancel event) and for its native close
   * event, told apart by the event's type. The close event follows any closing, ours included,
   * so it is never an answer. Esc is kept from closing the dialog itself: it closes when no
   * prompt is left. When the browser does not let Esc be refused (a second Esc without other
   * input), it closes the dialog anyway, so a fresh one shows whatever is still to be asked.
   */
  const onDialogClose = (e?: SyntheticEvent) => {
    if (e?.type === 'close') return;
    if (e?.type === 'cancel') {
      e.preventDefault();
      if (!e.cancelable) setGeneration((n) => n + 1);
    }
    cancel();
  };

  return (
    <Dialog
      key={generation}
      open={Boolean(current)}
      onClose={onDialogClose}
      title={t('Confirm it is you')}
    >
      {current && (
        <PasswordForm
          key={current.id}
          password={password}
          setPassword={setPassword}
          wrong={wrong}
          busy={busy}
          onSubmit={submit}
          onCancel={cancel}
        />
      )}
    </Dialog>
  );
}

function PasswordForm({
  password,
  setPassword,
  wrong,
  busy,
  onSubmit,
  onCancel,
}: {
  password: string;
  setPassword: (v: string) => void;
  wrong: boolean;
  busy: boolean;
  onSubmit: (e: FormEvent) => void;
  onCancel: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  // The password field gets the focus once the dialog is open – opening it focuses its first
  // control, the close button, which would win over autoFocus – and again after a wrong one.
  useEffect(() => {
    const timer = window.setTimeout(
      () => form.current?.querySelector<HTMLInputElement>('input[name="reauth-password"]')?.focus(),
      0,
    );
    return () => window.clearTimeout(timer);
  }, [wrong]);
  return (
    <form className="stack" onSubmit={onSubmit} ref={form}>
      <p style={{ margin: 0 }}>{t('This action needs your password again.')}</p>
      {wrong && <Alert tone="danger" title={t('The password is not correct. Try again.')} />}
      <TextField
        label={t('Password')}
        type="password"
        name="reauth-password"
        autoComplete="current-password"
        required
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div className="form-actions">
        <Button type="submit" loading={busy}>
          {t('Confirm')}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onCancel}>
          {t('Cancel')}
        </Button>
      </div>
    </form>
  );
}
