import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  accountBadges,
  roleLabel,
  useAccount,
  type AccountAction,
  type AccountPage,
} from '../../api/adminUsers';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  DefinitionList,
  EmptyState,
  PageHeader,
  QueryView,
  Table,
} from '../../components/ui';
import { actionLabel, formatDateTime } from '../../format';
import { t } from '../../i18n';
import { ActionDialog } from './users/ActionDialog';
import { ChangeDialog } from './users/ChangeDialog';

/** Names of changed fields in the administrative history, in words. */
const FIELD_LABEL: Record<string, () => string> = {
  fullName: () => t('name'),
  role: () => t('role'),
  facilityId: () => t('facility'),
  specialty: () => t('specialty'),
  licenseNumber: () => t('licence number'),
};

/** What caused an automatic change in the administrative history, in words. */
const SOURCE_LABEL: Record<string, () => string> = {
  death_registration: () => t('Closed when a death was registered'),
  death_registration_withdrawn: () => t('Reopened when the death registration was withdrawn'),
  access_review: () => t('Revoked in an access review'),
  // deploy/recover-admin.sh: an administrator who lost the password and the authenticator.
  'owner-authorized-recovery': () => t('Recovered on the server by the owner of the installation'),
};

/** Sessions listed before "Show all": a busy account can have dozens on many devices. */
const SESSIONS_SHOWN = 10;

/** One account for the platform administrator: details, actions and history. */
export function AdminUser() {
  const { id } = useParams<{ id: string }>();
  const account = useAccount(id!);
  return <QueryView query={account}>{(page) => <AccountView page={page} />}</QueryView>;
}

function AccountView({ page }: { page: AccountPage }) {
  const me = useUser();
  const u = page.user;
  const self = me.id === u.id;
  const patient = u.role === 'PATIENT';
  const [action, setAction] = useState<AccountAction | null>(null);
  const [changing, setChanging] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [allSessions, setAllSessions] = useState(false);
  const sessions = allSessions ? page.sessions : page.sessions.slice(0, SESSIONS_SHOWN);
  const when = (d: string | null) => (d ? formatDateTime(d) : '—');

  const buttons: { action: AccountAction; label: string; show: boolean; danger?: boolean }[] = [
    // A patient's invitation and two-step sign-in stay with their facility, which verifies who
    // they are; the operator cannot do that remotely.
    {
      action: 'resend-invitation',
      label: t('Renew activation link'),
      show: !patient && !u.activated && u.isActive,
    },
    {
      action: 'password-reset',
      label: t('Send password reset e-mail'),
      show: u.activated && u.isActive,
    },
    { action: 'unlock', label: t('Unlock account'), show: u.locked || u.failedLoginAttempts > 0 },
    {
      action: 'mfa-reset',
      label: t('Reset two-step sign-in'),
      show: !self && !patient && u.mfaEnabled,
    },
    {
      action: 'revoke-sessions',
      label: t('Sign out everywhere'),
      show: !self && page.sessions.length > 0,
    },
    { action: 'enable', label: t('Enable account'), show: !u.isActive },
    { action: 'disable', label: t('Disable account'), show: !self && u.isActive, danger: true },
  ];

  return (
    <>
      <PageHeader
        title={u.fullName}
        subtitle={[roleLabel(u.role), u.facilityName].filter(Boolean).join(' · ')}
        actions={
          <Link className="btn btn-secondary" to="/admin/users">
            ← {t('All users')}
          </Link>
        }
      />
      <div className="row" style={{ gap: '0.35rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        {accountBadges(u).map((b) => (
          <Badge key={b.label} tone={b.tone}>
            {b.label}
          </Badge>
        ))}
      </div>
      {done && (
        <Alert tone="success">
          <span role="status">{done}</span>
        </Alert>
      )}
      {self && (
        <Alert tone="info">
          {t(
            'This is your own account. Your password, two-step sign-in and devices are on your own security page.',
          )}{' '}
          <Link to="/account/security">{t('Open my security page')}</Link>
        </Alert>
      )}
      {patient && (
        <Alert tone="info">
          {t(
            'A patient account. The patient’s details and health record are kept by their facility; here you can only help with signing in.',
          )}{' '}
          {t(
            'If their invitation link expired or they lost their two-step sign-in, reception or a director of their facility verifies their identity in person and, on the patient’s page, sends the invitation again or resets the two-step sign-in.',
          )}
        </Alert>
      )}

      <div className="split">
        <Card title={t('Account')}>
          <DefinitionList
            items={[
              [t('Email'), u.email],
              [t('Role'), roleLabel(u.role)],
              ...(patient ? [] : ([[t('Facility'), u.facilityName ?? '—']] as [string, string][])),
              ...(u.specialty ? ([[t('Specialty'), u.specialty]] as [string, string][]) : []),
              ...(u.licenseNumber
                ? ([[t('Professional licence number'), u.licenseNumber]] as [string, string][])
                : []),
              [t('Invited or registered'), when(u.createdAt)],
              [t('Password set'), u.activated ? when(u.passwordChangedAt) : t('Not activated yet')],
              [t('Two-step sign-in'), u.mfaEnabled ? t('On') : t('Off')],
              [t('Last sign-in'), u.lastLoginAt ? when(u.lastLoginAt) : t('Never')],
              [t('Failed sign-in attempts'), String(u.failedLoginAttempts)],
              ...(u.locked
                ? ([[t('Locked until'), when(u.lockedUntil)]] as [string, string][])
                : []),
              ...(patient
                ? []
                : ([[t('Care teams'), String(u.activeCareTeams)]] as [string, string][])),
            ]}
          />
        </Card>
        <Card title={t('Actions')}>
          <div className="stack">
            {!patient && (
              <Button variant="secondary" onClick={() => setChanging(true)}>
                {t('Change details')}
              </Button>
            )}
            {buttons
              .filter((b) => b.show)
              .map((b) => (
                <Button
                  key={b.action}
                  variant={b.danger ? 'danger' : 'secondary'}
                  onClick={() => {
                    setDone(null);
                    setAction(b.action);
                  }}
                >
                  {b.label}
                </Button>
              ))}
          </div>
        </Card>
      </div>

      <Card title={t('Active sessions')}>
        {page.sessions.length === 0 ? (
          <EmptyState title={t('Not signed in on any device')} />
        ) : (
          <>
            <Table caption={t('Active sessions')}>
              <thead>
                <tr>
                  <th scope="col">{t('Device')}</th>
                  <th scope="col">{t('Network')}</th>
                  <th scope="col">{t('Signed in')}</th>
                  <th scope="col">{t('Last active')}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{s.device}</td>
                    <td>{s.network ?? '—'}</td>
                    <td>{formatDateTime(s.startedAt)}</td>
                    <td>{formatDateTime(s.lastUsedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {page.sessions.length > SESSIONS_SHOWN && (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={allSessions}
                onClick={() => setAllSessions((v) => !v)}
              >
                {allSessions
                  ? t('Show fewer')
                  : t('Show all {count}', { count: page.sessions.length })}
              </Button>
            )}
          </>
        )}
      </Card>

      <Card title={t('Sign-in history')}>
        {page.signIns.length === 0 ? (
          <EmptyState title={t('No sign-ins in the last 90 days')} />
        ) : (
          <Table caption={t('Sign-in history')}>
            <thead>
              <tr>
                <th scope="col">{t('Time')}</th>
                <th scope="col">{t('Event')}</th>
                <th scope="col">{t('Device')}</th>
                <th scope="col">{t('Network')}</th>
              </tr>
            </thead>
            <tbody>
              {page.signIns.map((s) => (
                <tr key={s.id}>
                  <td>{formatDateTime(s.occurredAt)}</td>
                  <td>
                    {actionLabel(s.action)}
                    {s.outcome !== 'SUCCESS' && (
                      <>
                        {' '}
                        <Badge tone="warning">{t('Refused')}</Badge>
                      </>
                    )}
                  </td>
                  <td>{s.device ?? '—'}</td>
                  <td>{s.network ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title={t('Administrative history')}>
        {page.adminHistory.length === 0 ? (
          <EmptyState title={t('No administrative changes yet')} />
        ) : (
          <Table caption={t('Administrative history')}>
            <thead>
              <tr>
                <th scope="col">{t('Time')}</th>
                <th scope="col">{t('What')}</th>
                <th scope="col">{t('By')}</th>
                <th scope="col">{t('Reason')}</th>
              </tr>
            </thead>
            <tbody>
              {page.adminHistory.map((h) => (
                <tr key={h.id}>
                  <td>{formatDateTime(h.occurredAt)}</td>
                  <td>
                    {actionLabel(h.action)}
                    {h.changes.length > 0 && (
                      <div className="muted">
                        {h.changes.map((c) => (FIELD_LABEL[c] ? FIELD_LABEL[c]() : c)).join(', ')}
                      </div>
                    )}
                    {h.source && SOURCE_LABEL[h.source] && (
                      <div className="muted">{SOURCE_LABEL[h.source]!()}</div>
                    )}
                  </td>
                  <td>
                    {h.actorName ?? t('The system')}
                    {h.actorRole && <div className="muted">{roleLabel(h.actorRole)}</div>}
                  </td>
                  <td>{h.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <ActionDialog user={u} action={action} onClose={() => setAction(null)} onDone={setDone} />
      <ChangeDialog user={u} open={changing} onClose={() => setChanging(false)} onDone={setDone} />
    </>
  );
}
