import { t } from '../i18n';
import { LanguageSwitcher } from '../i18n/LanguageSwitcher';
import { useEffect } from 'react';
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
import { Icon, type IconName } from './icons';
import { NotificationBell } from './Notifications';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
}
type NavSection = { title?: string; items: NavItem[] };

const COMMS: NavSection = {
  title: 'Communication',
  items: [{ to: '/channels', label: 'Team channels', icon: 'hash' }],
};

const NAV: Record<Role, NavSection[]> = {
  PATIENT: [
    {
      items: [
        { to: '/portal', label: 'Overview', icon: 'home', end: true },
        { to: '/portal/history', label: 'Medical history', icon: 'history' },
        { to: '/portal/results', label: 'Test results', icon: 'flask' },
        { to: '/portal/appointments', label: 'Appointments', icon: 'calendar' },
        { to: '/portal/vaccinations', label: 'Vaccinations', icon: 'syringe' },
        { to: '/portal/billing', label: 'Bills & payments', icon: 'clipboard' },
      ],
    },
    {
      title: 'My care',
      items: [
        { to: '/portal/messages', label: 'Messages', icon: 'message' },
        { to: '/portal/referrals', label: 'Referrals', icon: 'share' },
        { to: '/portal/stays', label: 'Hospital stays', icon: 'building' },
        { to: '/portal/imaging', label: 'Imaging', icon: 'eye' },
        { to: '/portal/documents', label: 'Documents', icon: 'clipboard' },
        { to: '/portal/consents', label: 'Privacy & consent', icon: 'shield' },
        { to: '/portal/access-log', label: 'Who viewed my record', icon: 'eye' },
        { to: '/portal/account', label: 'My details', icon: 'user' },
      ],
    },
  ],
  DOCTOR: [
    {
      title: 'Clinical',
      items: [
        { to: '/doctor', label: 'Worklist', icon: 'activity', end: true },
        { to: '/doctor/patients', label: 'Patients', icon: 'users' },
        { to: '/tasks', label: 'Care tasks', icon: 'clipboard' },
        { to: '/doctor/schedule', label: 'Schedule', icon: 'calendar' },
        { to: '/doctor/referrals', label: 'Referrals', icon: 'share' },
        { to: '/doctor/cover', label: 'Cover & absence', icon: 'users' },
        { to: '/doctor/availability', label: 'My consulting hours', icon: 'calendar' },
      ],
    },
    {
      title: 'Hospital',
      items: [
        { to: '/wards', label: 'Wards & beds', icon: 'building' },
        { to: '/ed', label: 'Emergency department', icon: 'alert' },
        { to: '/imaging', label: 'Imaging', icon: 'eye' },
        { to: '/theatre', label: 'Operating theatres', icon: 'activity' },
        { to: '/wards/early-warning', label: 'Early warning (NEWS2)', icon: 'alert' },
        { to: '/blood-bank', label: 'Blood bank', icon: 'flask' },
        { to: '/nutrition', label: 'Nutrition', icon: 'clipboard' },
        { to: '/tools/interactions', label: 'Interaction checker', icon: 'pill' },
        { to: '/births', label: 'Births', icon: 'user' },
        { to: '/identities', label: 'Temporary identities', icon: 'clipboard' },
      ],
    },
    {
      title: 'Communication',
      items: [{ to: '/messages', label: 'Patient messages', icon: 'message' }, ...COMMS.items],
    },
  ],
  NURSE: [
    {
      title: 'Nursing',
      items: [
        { to: '/nurse', label: 'Shift overview', icon: 'activity', end: true },
        { to: '/tasks', label: 'Care tasks', icon: 'clipboard' },
        { to: '/nurse/patients', label: 'Patients', icon: 'users' },
        { to: '/nurse/schedule', label: 'Clinic schedule', icon: 'calendar' },
        { to: '/vaccinations/due', label: 'Vaccinations due', icon: 'syringe' },
      ],
    },
    {
      title: 'Hospital',
      items: [
        { to: '/wards', label: 'Wards & beds', icon: 'building' },
        { to: '/ed', label: 'Emergency department', icon: 'alert' },
        { to: '/imaging', label: 'Imaging', icon: 'eye' },
        { to: '/theatre', label: 'Operating theatres', icon: 'activity' },
        { to: '/wards/early-warning', label: 'Early warning (NEWS2)', icon: 'alert' },
        { to: '/blood-bank', label: 'Blood bank', icon: 'flask' },
        { to: '/nutrition', label: 'Nutrition', icon: 'clipboard' },
        { to: '/tools/interactions', label: 'Interaction checker', icon: 'pill' },
        { to: '/births', label: 'Births', icon: 'user' },
        { to: '/identities', label: 'Temporary identities', icon: 'clipboard' },
      ],
    },
    {
      title: 'Communication',
      items: [{ to: '/messages', label: 'Patient messages', icon: 'message' }, ...COMMS.items],
    },
  ],
  PHARMACIST: [
    {
      title: 'Pharmacy',
      items: [
        { to: '/pharmacy', label: 'Verification queue', icon: 'pill', end: true },
        { to: '/pharmacy/stock', label: 'Stock', icon: 'clipboard' },
        { to: '/tools/interactions', label: 'Interaction checker', icon: 'alert' },
      ],
    },
    COMMS,
  ],
  RECEPTION: [
    {
      title: 'Front desk',
      items: [
        { to: '/reception', label: 'Today', icon: 'desk', end: true },
        { to: '/reception/patients', label: 'Patients', icon: 'users' },
        { to: '/reception/appointments', label: 'Appointments', icon: 'calendar' },
        { to: '/vaccinations/due', label: 'Vaccinations due', icon: 'syringe' },
        { to: '/billing', label: 'Billing & insurance', icon: 'clipboard' },
        { to: '/ed', label: 'Emergency arrivals', icon: 'alert' },
        { to: '/wards', label: 'Wards & beds', icon: 'building' },
        { to: '/births', label: 'Births', icon: 'user' },
        { to: '/identities', label: 'Temporary identities', icon: 'clipboard' },
      ],
    },
    COMMS,
  ],
  DIRECTOR: [
    {
      title: 'Facility',
      items: [
        { to: '/director', label: 'Dashboard', icon: 'chart', end: true },
        { to: '/director/reports', label: 'Reports', icon: 'activity' },
        { to: '/director/staff', label: 'Staff', icon: 'users' },
        { to: '/director/patients', label: 'Registered patients', icon: 'user' },
        { to: '/director/referrals', label: 'Referrals', icon: 'share' },
        { to: '/director/integrations', label: 'Lab connections', icon: 'flask' },
        { to: '/director/duplicates', label: 'Duplicate records', icon: 'user' },
        { to: '/director/units', label: 'Wards & units', icon: 'building' },
        { to: '/pharmacy/stock', label: 'Pharmacy stock', icon: 'pill' },
        { to: '/director/vaccination', label: 'Vaccination coverage', icon: 'syringe' },
        { to: '/billing', label: 'Billing & claims', icon: 'clipboard' },
        { to: '/surveillance', label: 'Notifiable diseases', icon: 'alert' },
        { to: '/blood-bank', label: 'Blood bank', icon: 'flask' },
        { to: '/wards', label: 'Bed board', icon: 'desk' },
        { to: '/identities', label: 'Temporary identities', icon: 'clipboard' },
      ],
    },
    {
      title: 'Oversight',
      items: [
        { to: '/director/emergency-access', label: 'Emergency access review', icon: 'alert' },
        { to: '/director/audit', label: 'Audit review', icon: 'shield' },
      ],
    },
    {
      title: 'Communication',
      items: [
        ...COMMS.items,
        { to: '/director/announcements', label: 'Announcements', icon: 'megaphone' },
      ],
    },
  ],
  MINISTRY: [
    {
      title: 'National',
      items: [
        { to: '/ministry', label: 'National overview', icon: 'chart', end: true },
        { to: '/ministry/reports', label: 'Reports', icon: 'activity' },
        { to: '/ministry/facilities', label: 'Facilities', icon: 'building' },
        { to: '/ministry/staff', label: 'Directors & officials', icon: 'users' },
        { to: '/ministry/stock', label: 'Medicine availability', icon: 'pill' },
        { to: '/ministry/vaccination', label: 'Vaccination coverage', icon: 'syringe' },
        { to: '/surveillance', label: 'Disease surveillance', icon: 'alert' },
        { to: '/ministry/partners', label: 'Partner systems (API)', icon: 'share' },
        { to: '/developers', label: 'API documentation', icon: 'settings' },
      ],
    },
    {
      title: 'Oversight',
      items: [
        { to: '/ministry/emergency-access', label: 'Emergency access', icon: 'alert' },
        { to: '/ministry/audit', label: 'Audit review', icon: 'shield' },
      ],
    },
    {
      title: 'Communication',
      items: [
        ...COMMS.items,
        { to: '/ministry/announcements', label: 'Announcements', icon: 'megaphone' },
      ],
    },
  ],
};

const ROLE_LABEL: Record<Role, string> = {
  PATIENT: 'Patient portal',
  DOCTOR: 'Clinical workspace',
  NURSE: 'Nursing workspace',
  PHARMACIST: 'Pharmacy',
  RECEPTION: 'Front desk',
  DIRECTOR: 'Facility management',
  MINISTRY: 'Ministry of Health',
};

const LIVE_TEXT = { live: 'Live', connecting: 'Connecting…', offline: 'Offline – retrying' };

/** Pages an appointments-only guardian may open. */
const APPOINTMENT_SCOPE_PATHS = ['/portal/appointments', '/portal/account', '/notifications'];

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

export function Layout() {
  const user = useUser();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const live = useLiveEvents(true);
  const { acting, dependants, setActing } = useAuth();
  const [params, setParams] = useSearchParams();
  const location = useLocation();

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
  const nav = NAV[user.role]
    .map((section) => ({
      ...section,
      items: appointmentsOnly
        ? section.items.filter((i) => APPOINTMENT_SCOPE_PATHS.includes(i.to))
        : section.items,
    }))
    .filter((section) => section.items.length);
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
        <nav className="sidenav" aria-label={t('Main')}>
          {user.role === 'PATIENT' && <RecordSwitcher />}
          {nav.map((section, i) => (
            <div key={section.title ?? i} className="nav-section">
              {section.title && <div className="nav-title">{t(section.title)}</div>}
              <ul>
                {section.items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.end}>
                      <Icon name={item.icon} />
                      <span>{t(item.label)}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <main id="main" tabIndex={-1}>
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
            <Outlet key={acting?.patientId ?? 'self'} />
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
