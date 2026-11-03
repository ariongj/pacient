import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import {
  isPasskeyCancel,
  passkeysSupported,
  registerPasskey,
  suggestedDeviceName,
  type ActiveSession,
  type Passkey,
  type SecurityEvent,
  type SecurityProfile,
} from '../../api/security';
import { useAuth, useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  Pagination,
  QueryView,
  Table,
  TextField,
} from '../../components/ui';
import { actionLabel, formatDateTime } from '../../format';
import { t } from '../../i18n';

const KEY = ['security'] as const;
const needsReauth = (err: unknown) => err instanceof ApiError && err.code === 'REAUTH_REQUIRED';

/** Labels for security events the shared audit labels do not cover yet. */
function eventLabel(action: string): string {
  const own: Record<string, string> = {
    'auth.passkey.registered': t('Passkey added'),
    'auth.passkey.removed': t('Passkey removed'),
    'auth.passkey.login': t('Signed in with a passkey'),
    'auth.session.revoked': t('Signed out a device'),
    'auth.new_device': t('Sign-in from a new device'),
  };
  return own[action] ?? actionLabel(action);
}

function reasonLabel(reason: string | null): string | null {
  switch (reason) {
    case 'bad_password':
      return t('Wrong password');
    case 'bad_passkey':
      return t('Passkey not accepted');
    case 'passkey_counter_regression':
      return t('Passkey refused (it may have been copied)');
    case 'inactive_account':
      return t('Account disabled');
    default:
      return null;
  }
}

/** "Add a passkey" with a device name; asks for the password when the server wants it. */
export function AddPasskeyButton({
  onAdded,
  variant = 'primary',
  label,
}: {
  onAdded?: () => void;
  variant?: 'primary' | 'secondary';
  label?: string;
}) {
  const { reloadProfile } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [askPassword, setAskPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (!passkeysSupported()) return null;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await registerPasskey(
        String(f.get('deviceName') ?? '').trim() || suggestedDeviceName(),
        askPassword ? String(f.get('password') ?? '') : undefined,
      );
      await reloadProfile();
      void qc.invalidateQueries({ queryKey: KEY });
      setOpen(false);
      setAskPassword(false);
      onAdded?.();
    } catch (err) {
      if (needsReauth(err)) setAskPassword(true);
      else if (!isPasskeyCancel(err)) setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        {label ?? t('Add a passkey')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Add a passkey')}>
        <form onSubmit={onSubmit} className="stack">
          <p className="muted">
            {t(
              'Your device will ask for your fingerprint, face or screen lock. Pacient never receives your biometrics – only a key that works for this site alone, so it cannot be phished.',
            )}
          </p>
          <TextField
            label={t('Name for this passkey')}
            name="deviceName"
            defaultValue={suggestedDeviceName()}
            maxLength={100}
            required
          />
          {askPassword && (
            <>
              <Alert tone="info">{t('For your security, confirm your password first.')}</Alert>
              <TextField
                label={t('Password')}
                name="password"
                type="password"
                autoComplete="current-password"
                required
                autoFocus
              />
            </>
          )}
          <ErrorAlert error={error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('Continue')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function PasskeysCard() {
  const user = useUser() as ReturnType<typeof useUser> & SecurityProfile;
  const { reloadProfile } = useAuth();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: [...KEY, 'passkeys'],
    queryFn: () => api<{ items: Passkey[] }>('/auth/security/passkeys').then((r) => r.items),
  });
  const [renaming, setRenaming] = useState<Passkey | null>(null);
  const [removing, setRemoving] = useState<Passkey | null>(null);
  const [askPassword, setAskPassword] = useState(false);

  const rename = useMutation({
    mutationFn: (v: { id: string; deviceName: string }) =>
      api(`/auth/security/passkeys/${v.id}`, {
        method: 'PATCH',
        body: { deviceName: v.deviceName },
      }),
    onSuccess: () => {
      setRenaming(null);
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const remove = useMutation({
    mutationFn: (v: { id: string; password?: string }) =>
      api(`/auth/security/passkeys/${v.id}`, {
        method: 'DELETE',
        body: v.password ? { password: v.password } : {},
      }),
    onSuccess: async () => {
      setRemoving(null);
      setAskPassword(false);
      await reloadProfile();
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (err) => {
      if (needsReauth(err)) setAskPassword(true);
    },
  });

  return (
    <Card title={t('Passkeys')} actions={<AddPasskeyButton />}>
      <p className="muted">
        {t(
          'Sign in with your fingerprint, face or device screen lock instead of a password and code. Passkeys cannot be phished and also count as two-step sign-in.',
        )}
      </p>
      {!passkeysSupported() && (
        <Alert tone="info">{t('This browser does not support passkeys.')}</Alert>
      )}
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No passkeys yet')} />
          ) : (
            <Table caption={t('Passkeys')}>
              <thead>
                <tr>
                  <th>{t('Name')}</th>
                  <th>{t('Added')}</th>
                  <th>{t('Last used')}</th>
                  <th>
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.deviceName}</strong>{' '}
                      {p.backedUp && <Badge tone="info">{t('Synced')}</Badge>}
                    </td>
                    <td>{formatDateTime(p.createdAt)}</td>
                    <td>{p.lastUsedAt ? formatDateTime(p.lastUsedAt) : t('Never')}</td>
                    <td>
                      <div className="row">
                        <Button size="sm" variant="secondary" onClick={() => setRenaming(p)}>
                          {t('Rename')}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            remove.reset();
                            setAskPassword(false);
                            setRemoving(p);
                          }}
                        >
                          {t('Remove')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      {user.mfaRequired && (user.passkeyCount ?? 0) <= 1 && !user.totpEnabled && (
        <p className="muted">
          {t(
            'Staff accounts must keep a second factor: add another passkey or an authenticator app before removing your last passkey.',
          )}
        </p>
      )}
      <Dialog
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title={t('Rename passkey')}
      >
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get('deviceName') ?? '').trim();
            if (renaming && name) rename.mutate({ id: renaming.id, deviceName: name });
          }}
        >
          <TextField
            label={t('Name for this passkey')}
            name="deviceName"
            defaultValue={renaming?.deviceName}
            maxLength={100}
            required
            autoFocus
          />
          <ErrorAlert error={rename.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setRenaming(null)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={rename.isPending}>
              {t('Save')}
            </Button>
          </div>
        </form>
      </Dialog>
      <Dialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={t('Remove passkey')}
      >
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const password = String(new FormData(e.currentTarget).get('password') ?? '');
            if (removing) remove.mutate({ id: removing.id, password: password || undefined });
          }}
        >
          <p>
            {t('Remove the passkey "{name}"? You will no longer be able to sign in with it.', {
              name: removing?.deviceName ?? '',
            })}
          </p>
          {askPassword && (
            <TextField
              label={t('Password')}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              hint={t('For your security, confirm your password first.')}
            />
          )}
          {!needsReauth(remove.error) && <ErrorAlert error={remove.error} />}
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" variant="danger" loading={remove.isPending}>
              {t('Remove')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}

function SessionsCard() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: [...KEY, 'sessions'],
    queryFn: () => api<{ items: ActiveSession[] }>('/auth/security/sessions').then((r) => r.items),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: KEY });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/auth/security/sessions/${id}/revoke`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const revokeOthers = useMutation({
    mutationFn: () => api('/auth/security/sessions/revoke-others', { method: 'POST' }),
    onSuccess: refresh,
  });

  return (
    <Card
      title={t('Signed-in devices')}
      actions={
        <Button
          variant="secondary"
          loading={revokeOthers.isPending}
          onClick={() => {
            if (window.confirm(t('Sign out on all other devices?'))) revokeOthers.mutate();
          }}
        >
          {t('Sign out all other devices')}
        </Button>
      }
    >
      <p className="muted">
        {t(
          'Devices stay signed in for up to 7 days. If you see one you do not recognise, sign it out and change your password. A signed-out device may keep access for up to 15 minutes.',
        )}
      </p>
      <ErrorAlert error={revoke.error ?? revokeOthers.error} />
      {revokeOthers.isSuccess && (
        <Alert tone="success" title={t('Other devices were signed out')} />
      )}
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No active sessions')} />
          ) : (
            <Table caption={t('Signed-in devices')}>
              <thead>
                <tr>
                  <th>{t('Device')}</th>
                  <th>{t('Network')}</th>
                  <th>{t('Signed in')}</th>
                  <th>{t('Last active')}</th>
                  <th>
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.device}</strong>{' '}
                      {s.current && <Badge tone="success">{t('This device')}</Badge>}
                    </td>
                    <td>
                      <code>{s.network ?? '—'}</code>
                    </td>
                    <td>{formatDateTime(s.startedAt)}</td>
                    <td>{formatDateTime(s.lastUsedAt)}</td>
                    <td>
                      {!s.current && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={revoke.isPending && revoke.variables === s.id}
                          onClick={() => revoke.mutate(s.id)}
                        >
                          {t('Sign out')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
    </Card>
  );
}

function HistoryCard() {
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: [...KEY, 'history', page],
    queryFn: () =>
      api<{ items: SecurityEvent[]; totalPages: number }>('/auth/security/history', {
        query: { page, pageSize: 15 },
      }),
  });
  return (
    <Card title={t('Sign-in history')}>
      <p className="muted">
        {t('Sign-ins and security changes on your account in the last 90 days.')}
      </p>
      <QueryView query={history}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No events yet')} />
          ) : (
            <>
              <Table caption={t('Sign-in history')}>
                <thead>
                  <tr>
                    <th>{t('When')}</th>
                    <th>{t('Event')}</th>
                    <th>{t('Device')}</th>
                    <th>{t('Network')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((e) => (
                    <tr key={e.id}>
                      <td>{formatDateTime(e.occurredAt)}</td>
                      <td>
                        {eventLabel(e.action)}{' '}
                        {e.outcome !== 'SUCCESS' && (
                          <Badge tone="danger">{reasonLabel(e.reason) ?? t('Failed')}</Badge>
                        )}
                        {e.factors?.includes('passkey') && e.action === 'auth.login.success' && (
                          <Badge tone="info">{t('Passkey')}</Badge>
                        )}
                      </td>
                      <td>{e.device ?? '—'}</td>
                      <td>
                        <code>{e.network ?? '—'}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={page} totalPages={data.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
    </Card>
  );
}

/** Passkeys, signed-in devices and sign-in history for the signed-in user (every role). */
export function SecurityPage() {
  const user = useUser() as ReturnType<typeof useUser> & SecurityProfile;
  const accountPath = user.role === 'PATIENT' ? '/portal/account' : '/account';
  return (
    <>
      <PageHeader
        title={t('Security & sign-in')}
        subtitle={t('Passkeys, the devices signed in to your account and recent sign-ins.')}
      />
      <div className="stack">
        <PasskeysCard />
        <Card title={t('Two-step sign-in')}>
          <p>
            {user.mfaEnabled ? <Badge tone="success">{t('On')}</Badge> : <Badge>{t('Off')}</Badge>}{' '}
            {user.totpEnabled
              ? t('Authenticator app set up.')
              : t('No authenticator app is set up.')}{' '}
            {(user.passkeyCount ?? 0) > 0 &&
              t('{count} passkey(s) also count as two-step sign-in.', {
                count: user.passkeyCount ?? 0,
              })}
          </p>
          <Link to={accountPath}>{t('Manage the authenticator app and recovery codes')}</Link>
        </Card>
        <SessionsCard />
        <HistoryCard />
      </div>
    </>
  );
}
