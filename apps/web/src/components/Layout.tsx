import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import type { Role } from '../api/types';
import { useAuth, useUser } from '../auth/AuthContext';
import { useLiveEvents } from '../auth/useLiveEvents';
import { humanize } from '../format';
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
      ],
    },
    {
      title: 'My care',
      items: [
        { to: '/portal/messages', label: 'Messages', icon: 'message' },
        { to: '/portal/referrals', label: 'Referrals', icon: 'share' },
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
      ],
    },
    { title: 'Communication', items: [{ to: '/messages', label: 'Patient messages', icon: 'message' }, ...COMMS.items] },
  ],
  NURSE: [
    {
      title: 'Nursing',
      items: [
        { to: '/nurse', label: 'Shift overview', icon: 'activity', end: true },
        { to: '/tasks', label: 'Care tasks', icon: 'clipboard' },
        { to: '/nurse/patients', label: 'Patients', icon: 'users' },
        { to: '/nurse/schedule', label: 'Clinic schedule', icon: 'calendar' },
      ],
    },
    { title: 'Communication', items: [{ to: '/messages', label: 'Patient messages', icon: 'message' }, ...COMMS.items] },
  ],
  PHARMACIST: [
    {
      title: 'Pharmacy',
      items: [{ to: '/pharmacy', label: 'Verification queue', icon: 'pill', end: true }],
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
      items: [...COMMS.items, { to: '/director/announcements', label: 'Announcements', icon: 'megaphone' }],
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
      items: [...COMMS.items, { to: '/ministry/announcements', label: 'Announcements', icon: 'megaphone' }],
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

export function Layout() {
  const user = useUser();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const live = useLiveEvents(true);
  const initials = user.fullName
    .replace(/^(Dr\.|Mr\.|Mrs\.|Ms\.)\s*/, '')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('');

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            +
          </span>
          <span>
            <strong>Pacient</strong>
            <span className="brand-sub">{ROLE_LABEL[user.role]}</span>
          </span>
        </div>
        <div className="topbar-user">
          <span className={`live live-${live}`} role="status" title="Real-time updates">
            <span className="live-dot" aria-hidden="true" />
            <span className="live-text">{LIVE_TEXT[live]}</span>
          </span>
          <NotificationBell />
          <span className="avatar" aria-hidden="true">
            {initials}
          </span>
          <span className="user-meta">
            <strong>{user.fullName}</strong>
            <span className="muted">
              {user.facility ? user.facility.name : humanize(user.role)}
              {user.specialty ? ` · ${user.specialty}` : ''}
            </span>
          </span>
          {user.role !== 'PATIENT' && (
            <NavLink to="/account" className="btn btn-ghost btn-sm" aria-label="Account settings">
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
            <Icon name="logout" size={16} /> <span className="hide-sm">Sign out</span>
          </button>
        </div>
      </header>
      <div className="body">
        <nav className="sidenav" aria-label="Main">
          {NAV[user.role].map((section, i) => (
            <div key={section.title ?? i} className="nav-section">
              {section.title && <div className="nav-title">{section.title}</div>}
              <ul>
                {section.items.map((item) => (
                  <li key={item.to}>
                    <NavLink to={item.to} end={item.end}>
                      <Icon name={item.icon} />
                      <span>{item.label}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <footer className="footer muted">
        Pacient · Access to health records is logged and audited.
        {user.role === 'PATIENT' &&
          ' In an emergency call 112 — this portal is not monitored around the clock.'}
      </footer>
    </div>
  );
}
