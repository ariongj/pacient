import { t } from '../i18n';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';
import { Suspense, useEffect, useState } from 'react';
import {
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import type { Role } from '../api/types';
import { useAuth, useUser } from '../auth/AuthContext';
import { useLiveEvents } from '../auth/useLiveEvents';
import { formatDate, humanize } from '../format';
import { DOWNTIME_STATUS_ROLES, useDowntimeStatus } from '../api/downtime';
import { Icon } from './icons';
import { NotificationBell } from './Notifications';
import { APPOINTMENT_SCOPE_PATHS, Breadcrumb, SideNav } from './SideNav';
import { Loading } from './ui';

const ROLE_LABEL: Record<Role, string> = {
  PATIENT: 'Patient portal',
  DOCTOR: 'Clinical workspace',
  NURSE: 'Nursing workspace',
  PHARMACIST: 'Pharmacy',
  RECEPTION: 'Front desk',
  LAB_TECHNICIAN: 'Laboratory',
  IT_SUPPORT: 'IT support',
  DIRECTOR: 'Facility management',
  MINISTRY: 'Ministry of Health',
};

const LIVE_TEXT = { live: 'Live', connecting: 'Connecting…', offline: 'Offline – retrying' };

const RELATIONSHIP: Record<string, string> = {
  PARENT: 'parent',
  LEGAL_GUARDIAN: 'legal guardian',
  FOSTER_CARER: 'foster carer',
  OTHER_AUTHORISED: 'authorised representative',
};

/** Lets a guardian switch between their own record and the records they may act for. */
function RecordSwitcher() {
  const user = useUser();
  const { dependants, acting, setActing } = useAuth();
  const navigate = useNavigate();
  if (!dependants.length) return null;
  return (
    <div className="record-switcher">
      <label htmlFor="record-switcher">{t('Viewing the record of')}</label>
      <select
        id="record-switcher"
        value={acting?.patientId ?? ''}
        onChange={(e) => {
          setActing(e.target.value || null);
          navigate('/portal');
        }}
      >
        {user.patientId && <option value="">{t('Me – {name}', { name: user.fullName })}</option>}
        {dependants.map((d) => (
          <option key={d.patientId} value={d.patientId}>
            {d.firstName} {d.lastName}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Red banner while the user's facility has declared downtime procedures (see /downtime). */
function DowntimeBanner({ role, hasFacility }: { role: Role; hasFacility: boolean }) {
  const status = useDowntimeStatus(hasFacility && DOWNTIME_STATUS_ROLES.includes(role));
  if (!status.data?.active) return null;
  return (
    <div className="alert alert-danger" role="alert">
      <strong>{t('Downtime procedures in effect – record on paper; back-enter afterwards')}</strong>
      {status.data.note && <div>{status.data.note}</div>}
      {role !== 'PHARMACIST' && (
        <div>
          <NavLink to="/downtime">{t('Open the downtime kit')}</NavLink>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const user = useUser();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const live = useLiveEvents(true);
  const { acting, dependants, setActing } = useAuth();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  // On small screens the menu is a panel opened from the top bar; it closes after navigating.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [location.pathname]);

  // Notification links for guardians carry ?for=<patientId>: open that record.
  const forParam = params.get('for');
  useEffect(() => {
    if (!forParam || user.role !== 'PATIENT') return;
    if (dependants.some((d) => d.patientId === forParam) && acting?.patientId !== forParam) {
      setActing(forParam);
    }
    const next = new URLSearchParams(params);
    next.delete('for');
    setParams(next, { replace: true });
  }, [forParam, dependants, acting, setActing, params, setParams, user.role]);

  const appointmentsOnly = acting?.scope === 'APPOINTMENTS';
  if (
    appointmentsOnly &&
    location.pathname.startsWith('/portal') &&
    !APPOINTMENT_SCOPE_PATHS.includes(location.pathname)
  ) {
    return <Navigate to="/portal/appointments" replace />;
  }
  const initials = user.fullName
    .replace(/^(Dr\.|Mr\.|Mrs\.|Ms\.)\s*/, '')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('');

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        {t('Skip to main content')}
      </a>
      <header className="topbar">
        <button
          type="button"
          className="btn btn-secondary btn-sm menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="sidenav"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <Icon name="menu" size={16} /> <span>{t('Menu')}</span>
        </button>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            +
          </span>
          <span>
            <strong>{t('Pacient')}</strong>
            <span className="brand-sub">{t(ROLE_LABEL[user.role])}</span>
          </span>
        </div>
        <div className="topbar-user">
          <span className={`live live-${live}`} role="status" title={t('Real-time updates')}>
            <span className="live-dot" aria-hidden="true" />
            <span className="live-text">{t(LIVE_TEXT[live])}</span>
          </span>
          <LanguageSwitcher compact />
          <NotificationBell />
          <span className="avatar" aria-hidden="true">
            {initials}
          </span>
          <span className="user-meta">
            <strong>{user.fullName}</strong>
            <span className="muted">
              {user.facility ? user.facility.name : humanize(user.role)}
              {user.specialty ? ` · ${t(user.specialty)}` : ''}
            </span>
          </span>
          {user.role !== 'PATIENT' && (
            <NavLink
              to="/account"
              className="btn btn-ghost btn-sm"
              aria-label={t('Account settings')}
            >
              <Icon name="settings" size={16} />
            </NavLink>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-label={t('Sign out')}
            onClick={async () => {
              await logout();
              navigate('/login', { replace: true });
            }}
          >
            <Icon name="logout" size={16} /> <span className="hide-sm">{t('Sign out')}</span>
          </button>
        </div>
      </header>
      <div className="body">
        <SideNav id="sidenav" open={menuOpen}>
          {user.role === 'PATIENT' && <RecordSwitcher />}
        </SideNav>
        <main id="main" tabIndex={-1}>
          <Breadcrumb />
          <DowntimeBanner role={user.role} hasFacility={Boolean(user.facility)} />
          {acting && (
            <div className="acting-banner" role="status">
              <div>
                <strong>
                  {t('Viewing {name}’s record', {
                    name: `${acting.firstName} ${acting.lastName}`,
                  })}
                </strong>{' '}
                {t('as their {relationship}', {
                  relationship: t(RELATIONSHIP[acting.relationship] ?? 'guardian'),
                })}
                {acting.scope === 'APPOINTMENTS' ? ` ${t('(appointments only)')}` : ''}.{' '}
                <span className="muted">
                  {t('Everything you open is recorded in their access log.')}{' '}
                  {t('Your access ends {date}.', { date: formatDate(acting.validUntil) })}
                </span>
              </div>
              {user.patientId && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setActing(null);
                    navigate('/portal');
                  }}
                >
                  {t('Back to my record')}
                </button>
              )}
            </div>
          )}
          {user.role === 'PATIENT' && !user.patientId && !acting ? (
            <div className="empty">
              <strong>{t('No health record is linked to this account yet')}</strong>
              <p className="muted">
                {t(
                  'If you look after a child or another person, ask their health facility to register you as their guardian.',
                )}
              </p>
            </div>
          ) : (
            <Suspense fallback={<Loading label={t('Loading…')} />}>
              <Outlet key={acting?.patientId ?? 'self'} />
            </Suspense>
          )}
        </main>
      </div>
      <footer className="footer muted">
        Pacient · {t('Access to health records is logged and audited.')}
        {user.role === 'PATIENT' &&
          ` ${t('In an emergency call 112 — this portal is not monitored around the clock.')}`}
      </footer>
    </div>
  );
}
