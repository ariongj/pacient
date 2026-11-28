import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { refreshSession } from '../api/client';
import { readLastInput, writeLastInput } from '../auth/adminIdle';
import { useAuth } from '../auth/AuthContext';
import { formatTime } from '../format';
import { t } from '../i18n';
import { Alert, Button, Dialog } from './ui';

/** Signed out after this long without keyboard, mouse or touch input. */
export const ADMIN_IDLE_MS = 30 * 60_000;
/** "Are you still there?" this long after the last input (five minutes before). */
export const ADMIN_IDLE_WARNING_MS = 25 * 60_000;
/** Input is noted at most this often (each note writes to storage). */
const NOTE_EVERY_MS = 5_000;
/**
 * While there is input, the session is refreshed at least this often: the server ends an
 * administrator's session that was not refreshed for 30 minutes (ADMIN_IDLE_MINUTES), and someone
 * writing a long text on one page sends no request that would refresh it.
 */
const KEEP_ALIVE_MS = 10 * 60_000;
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'];
/**
 * Set when this page signed the administrator out for inactivity, so the sign-in page can say why
 * (once). Not route state: signing out sends every workspace route to the sign-in page by itself,
 * before this component could pass anything along.
 */
let signedOutForInactivity = false;

const countdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Signs a platform administrator out after 30 minutes without input, with a warning at 25 minutes
 * and "Stay signed in". The operator's portal changes accounts, bank details and published texts:
 * a screen left signed in must not stay usable by whoever passes by. Input in any of the
 * administrator's tabs counts for all of them; while the warning is open only "Stay signed in"
 * does (a nudged mouse is not someone answering). The check runs again when the tab comes back
 * into view, so a computer that slept through the deadline signs out at once, and a page opened
 * again later – a reload, a reopened browser, a tab the browser discarded – reads the last input
 * before anything else and signs out at once when it is 30 minutes old (a fresh sign-in has just
 * written it: auth/adminIdle.ts). Signing out ends the session on the server too (logout revokes
 * it). The server itself refuses to refresh an administrator's session nobody used for 30 minutes
 * (ADMIN_IDLE_MINUTES), so a closed browser cannot bring one back, and ends it 12 hours after
 * signing in whatever the activity (ADMIN_SESSION_HOURS). Placed in Layout for ADMIN only; other
 * roles are never signed out for being idle.
 */
export function AdminIdleSignOut() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const lastInput = useRef(Date.now());
  /** When this page last refreshed the session for input (KEEP_ALIVE_MS). */
  const keptAlive = useRef(Date.now());
  /** Whether the warning is open; the dialog's close event must not count as an answer. */
  const warned = useRef(false);
  const signingOut = useRef(false);
  /** When the person will be signed out, while the warning is open. */
  const [signOutAt, setSignOutAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const path = useRef(location.pathname);
  useEffect(() => {
    path.current = location.pathname;
  }, [location.pathname]);

  const note = useCallback((at: number) => {
    lastInput.current = Math.max(lastInput.current, at);
    writeLastInput(lastInput.current);
    if (at - keptAlive.current >= KEEP_ALIVE_MS) {
      keptAlive.current = at;
      void refreshSession();
    }
  }, []);

  const signOut = useCallback(
    async (idle: boolean) => {
      if (signingOut.current) return;
      signingOut.current = true;
      warned.current = false;
      setSignOutAt(null);
      const from = path.current;
      signedOutForInactivity = idle;
      try {
        await logout();
      } catch {
        /* the server did not answer: this browser is signed out all the same */
      }
      // Back to the same page after signing in again.
      navigate('/login', { replace: true, state: { from } });
    },
    [logout, navigate],
  );

  /** "Stay signed in" (or Esc). Closing the dialog for any other reason is not an answer. */
  const stay = useCallback(() => {
    if (!warned.current) return;
    warned.current = false;
    setSignOutAt(null);
    note(Date.now());
  }, [note]);

  useEffect(() => {
    // Read before anything is written: a page opened again after the limit must not start anew.
    const stored = readLastInput();
    const start = Date.now();
    if (stored && start - stored >= ADMIN_IDLE_MS) {
      void signOut(true);
      return;
    }
    lastInput.current = stored ? Math.min(stored, start) : start;
    writeLastInput(lastInput.current);
    let noted = 0;
    const onInput = () => {
      if (warned.current) return;
      const at = Date.now();
      if (at - noted < NOTE_EVERY_MS) return;
      noted = at;
      note(at);
    };
    const check = () => {
      const at = Date.now();
      lastInput.current = Math.max(lastInput.current, readLastInput());
      const idle = at - lastInput.current;
      if (idle >= ADMIN_IDLE_MS) {
        void signOut(true);
      } else if (idle >= ADMIN_IDLE_WARNING_MS) {
        warned.current = true;
        setSignOutAt(lastInput.current + ADMIN_IDLE_MS);
        setNow(at);
      } else if (warned.current) {
        // Someone answered in another tab.
        warned.current = false;
        setSignOutAt(null);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    for (const e of INPUT_EVENTS)
      window.addEventListener(e, onInput, { passive: true, capture: true });
    window.addEventListener('storage', check);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(check, 1_000);
    return () => {
      for (const e of INPUT_EVENTS) window.removeEventListener(e, onInput, { capture: true });
      window.removeEventListener('storage', check);
      document.removeEventListener('visibilitychange', onVisible);
      window.clearInterval(timer);
    };
  }, [note, signOut]);

  return (
    <Dialog open={signOutAt !== null} onClose={stay} title={t('Are you still there?')}>
      {signOutAt !== null && (
        <Warning signOutAt={signOutAt} now={now} stay={stay} signOut={signOut} />
      )}
    </Dialog>
  );
}

function Warning({
  signOutAt,
  now,
  stay,
  signOut,
}: {
  signOutAt: number;
  now: number;
  stay: () => void;
  signOut: (idle: boolean) => Promise<void>;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The answer most people want gets the focus. After the dialog opened: opening it focuses its
  // first control (the close button), which would win over autoFocus.
  useEffect(() => {
    const timer = window.setTimeout(
      () => box.current?.querySelector<HTMLButtonElement>('[data-stay]')?.focus(),
      0,
    );
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className="stack" ref={box}>
      <p style={{ margin: 0 }}>
        {t(
          'For security, administrators are signed out after 30 minutes without activity. You will be signed out at {time} unless you stay signed in.',
          { time: formatTime(new Date(signOutAt).toISOString()) },
        )}
      </p>
      <p style={{ margin: 0 }} className="muted">
        {t('Time left:')}{' '}
        <strong role="timer" aria-atomic="true">
          {countdown(signOutAt - now)}
        </strong>
      </p>
      <div className="form-actions">
        <Button data-stay onClick={stay}>
          {t('Stay signed in')}
        </Button>
        <Button variant="secondary" onClick={() => void signOut(false)}>
          {t('Sign out now')}
        </Button>
      </div>
    </div>
  );
}

/**
 * On the sign-in page: why an administrator is there after being signed out for inactivity.
 * Renders nothing otherwise.
 */
export function IdleSignOutNotice() {
  const [shown] = useState(() => signedOutForInactivity);
  useEffect(() => {
    signedOutForInactivity = false;
  }, []);
  if (!shown) return null;
  return (
    <Alert tone="info" title={t('You were signed out after 30 minutes without activity.')}>
      {t('Sign in again to continue.')}
    </Alert>
  );
}
