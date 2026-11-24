import { useEffect, useId, useReducer, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { kindPath, useAcceptLegal, useLegalStatus, type LegalText } from '../api/platform';
import { useAuth } from '../auth/AuthContext';
import { getLocale, t } from '../i18n';
import { LegalText as LegalTextView } from '../pages/admin/platform/LegalText';
import { Button, Card, ErrorAlert, Loading } from './ui';

/** How long the workspace waits for the acceptance check before opening anyway. */
const WAIT_MS = 1500;

/**
 * What the gate decided during this page load, for the signed-in account: whether the workspace
 * has been opened, and which texts could not be recorded as accepted. It lives outside the
 * component so that leaving the workspace (a public page) and coming back changes nothing; it is
 * forgotten at sign-out (LegalGateReset) and on a full page load, which ask again.
 */
const session = { userId: null as string | null, open: false, deferred: new Set<string>() };

function forgetSession() {
  session.userId = null;
  session.open = false;
  session.deferred = new Set();
}

function sessionOf(userId: string) {
  if (session.userId !== userId) {
    forgetSession();
    session.userId = userId;
  }
  return session;
}

/** True once the acceptance check has been running for longer than WAIT_MS. */
function useSlow(pending: boolean) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const timer = window.setTimeout(() => setSlow(true), WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);
  return pending && slow;
}

const docKey = (doc: LegalText) => `${doc.kind}-${doc.version}`;

/**
 * Before the workspace opens: the signed-in user accepts the current terms of use and privacy
 * notice when a new version requires it. Never locks anyone out (hazard H75): if the check fails
 * or is slow, or the acceptance cannot be recorded (an error, no answer within
 * ACCEPT_TIMEOUT_MS, or a conflict that asking again does not resolve), the workspace opens (fail
 * open) – acceptance is a legal formality, care must not wait for it. Once the workspace is open
 * it stays open until the next sign-in or page load, whatever a late answer or a newly published
 * version says: replacing it would throw away whatever the user had started (a note, an
 * administration). Checked in a browser by `npm run check:legal-gate`.
 */
export function LegalGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const status = useLegalStatus(user?.id, getLocale());
  const slow = useSlow(status.isPending);
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  if (!user) return <>{children}</>;
  const gate = sessionOf(user.id);
  const pending = (status.data?.pending ?? []).filter((d) => !gate.deferred.has(docKey(d)));
  if (!gate.open) {
    if (status.isPending && !slow) return <Loading />;
    // Opening is idempotent, so it is safe to decide here while rendering.
    if (status.isPending || status.error || pending.length === 0) gate.open = true;
  }
  if (gate.open) return <>{children}</>;
  return (
    <AcceptDocument
      key={docKey(pending[0]!)}
      doc={pending[0]!}
      remaining={pending.length}
      refreshing={status.isFetching}
      onDefer={() => {
        gate.deferred.add(docKey(pending[0]!));
        rerender();
      }}
    />
  );
}

/** Forgets the gate's decisions at sign-out, so the next sign-in asks again (mounted in App). */
export function LegalGateReset() {
  const { user } = useAuth();
  useEffect(() => {
    if (!user) forgetSession();
  }, [user]);
  return null;
}

const isConflict = (err: unknown) => err instanceof ApiError && err.status === 409;

/**
 * One text to accept. Mounted per kind and version (keyed), so its state is about this version.
 * `refreshing`: the acceptance status is being fetched again.
 */
function AcceptDocument({
  doc,
  remaining,
  refreshing,
  onDefer,
}: {
  doc: LegalText;
  remaining: number;
  refreshing: boolean;
  onDefer: () => void;
}) {
  const { logout } = useAuth();
  const accept = useAcceptLegal();
  const [checked, setChecked] = useState(false);
  // Conflicts (409) on accepting this version, and whether one is waiting for the status asked
  // for again.
  const [conflicts, setConflicts] = useState(0);
  const [rechecked, setRechecked] = useState(false);
  const textId = useId();
  const checkId = useId();
  // A 409 normally means a newer version was published meanwhile: the status is fetched again
  // and shows it, which replaces this card. If it still shows this version (a stale read, or a
  // conflict of another kind), or this version is refused twice, asking again cannot help:
  // offer to continue, as for any other failure.
  const superseded = isConflict(accept.error) && conflicts < 2 && (!rechecked || refreshing);
  const canContinue = accept.error !== null && !superseded;
  return (
    <Card title={doc.title}>
      <p>
        {t('Before you continue, please read and accept this text.')}{' '}
        <span className="muted">
          {t('Version {version}', { version: doc.version })}
          {remaining > 1 && ` · ${t('{count} texts to accept', { count: remaining })}`}
        </span>
      </p>
      <div
        id={textId}
        role="region"
        aria-label={doc.title}
        tabIndex={0}
        style={{
          maxHeight: '55vh',
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: '0.75rem 1rem',
          background: 'var(--surface-2)',
        }}
      >
        <LegalTextView body={doc.body} level={3} />
      </div>
      <p>
        <a href={kindPath(doc.kind)} target="_blank" rel="noreferrer">
          {t('Open in a new tab')}
        </a>
      </p>
      <div className="checkbox" style={{ margin: '0.75rem 0' }}>
        <input
          id={checkId}
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          aria-describedby={textId}
        />{' '}
        <label htmlFor={checkId}>{t('I have read and accept this text')}</label>
      </div>
      <ErrorAlert error={accept.error} />
      {canContinue && (
        <p>
          {t(
            'Your acceptance could not be recorded. You can work as usual; you will be asked again the next time you sign in.',
          )}
        </p>
      )}
      <div className="form-actions">
        <Button variant="secondary" onClick={() => void logout()}>
          {t('Sign out')}
        </Button>
        {canContinue && (
          <Button variant="secondary" onClick={onDefer}>
            {t('Continue – you will be asked again next time')}
          </Button>
        )}
        <Button
          disabled={!checked}
          loading={accept.isPending}
          onClick={() =>
            accept.mutate(
              { kind: doc.kind, version: doc.version },
              {
                onError: (err) => {
                  if (!isConflict(err)) return;
                  setConflicts((n) => n + 1);
                  setRechecked(true);
                },
              },
            )
          }
        >
          {t('Accept and continue')}
        </Button>
      </div>
    </Card>
  );
}
