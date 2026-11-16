import { useEffect, useId, useState, type ReactNode } from 'react';
import { kindPath, useAcceptLegal, useLegalStatus, type LegalText } from '../api/platform';
import { useAuth } from '../auth/AuthContext';
import { getLocale, t } from '../i18n';
import { LegalText as LegalTextView } from '../pages/admin/platform/LegalText';
import { Button, Card, ErrorAlert, Loading } from './ui';

/** How long the workspace waits for the acceptance check before opening anyway. */
const WAIT_MS = 1500;

/**
 * Before the workspace opens: the signed-in user accepts the current terms of use and privacy
 * notice when a new version requires it. Never locks anyone out: if the check fails or is slow,
 * the workspace opens (fail open) – acceptance is a legal formality, care must not wait for it.
 */
export function LegalGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const status = useLegalStatus(user?.id, getLocale());
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWaited(true), WAIT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  if (!user) return <>{children}</>;
  if (status.isPending && !waited) return <Loading />;
  const pending = status.data?.pending ?? [];
  if (status.error || pending.length === 0) return <>{children}</>;
  return (
    <AcceptDocument
      key={`${pending[0]!.kind}-${pending[0]!.version}`}
      doc={pending[0]!}
      remaining={pending.length}
    />
  );
}

function AcceptDocument({ doc, remaining }: { doc: LegalText; remaining: number }) {
  const { logout } = useAuth();
  const accept = useAcceptLegal();
  const [checked, setChecked] = useState(false);
  const textId = useId();
  const checkId = useId();
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
      <div className="form-actions">
        <Button variant="secondary" onClick={() => void logout()}>
          {t('Sign out')}
        </Button>
        <Button
          disabled={!checked}
          loading={accept.isPending}
          onClick={() => accept.mutate({ kind: doc.kind, version: doc.version })}
        >
          {t('Accept and continue')}
        </Button>
      </div>
    </Card>
  );
}
