import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import type { Role } from '../api/types';
import { useUser, useAuth } from '../auth/AuthContext';
import { humanize } from '../format';
import { NotificationBell } from './Notifications';

const NAV: Record<Role, { to: string; label: string; end?: boolean }[]> = {
  PATIENT: [
    { to: '/portal', label: 'Overview', end: true },
    { to: '/portal/history', label: 'Medical history' },
    { to: '/portal/results', label: 'Test results' },
    { to: '/portal/appointments', label: 'Appointments' },
    { to: '/portal/messages', label: 'Messages' },
    { to: '/portal/referrals', label: 'Referrals' },
    { to: '/portal/access-log', label: 'Who viewed my record' },
    { to: '/portal/account', label: 'My details' },
  ],
  DOCTOR: [
    { to: '/doctor', label: 'Worklist', end: true },
    { to: '/doctor/patients', label: 'Patients' },
    { to: '/doctor/schedule', label: 'Schedule' },
    { to: '/doctor/messages', label: 'Messages' },
    { to: '/doctor/referrals', label: 'Referrals' },
  ],
  DIRECTOR: [
    { to: '/director', label: 'Facility dashboard', end: true },
    { to: '/director/staff', label: 'Staff' },
    { to: '/director/patients', label: 'Registered patients' },
    { to: '/director/referrals', label: 'Referrals' },
    { to: '/director/emergency-access', label: 'Emergency access review' },
    { to: '/director/reports', label: 'Reports' },
    { to: '/director/announcements', label: 'Announcements' },
    { to: '/director/audit', label: 'Audit review' },
  ],
  MINISTRY: [
    { to: '/ministry', label: 'National overview', end: true },
    { to: '/ministry/facilities', label: 'Facilities' },
    { to: '/ministry/staff', label: 'Directors & officials' },
    { to: '/ministry/reports', label: 'Reports' },
    { to: '/ministry/emergency-access', label: 'Emergency access oversight' },
    { to: '/ministry/announcements', label: 'Announcements' },
    { to: '/ministry/audit', label: 'Audit review' },
  ],
};

const ROLE_LABEL: Record<Role, string> = {
  PATIENT: 'Patient portal',
  DOCTOR: 'Clinical workspace',
  DIRECTOR: 'Facility management',
  MINISTRY: 'Ministry of Health',
};

export function Layout() {
  const user = useUser();
  const { logout } = useAuth();
  const navigate = useNavigate();

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
          <span className="user-meta">
            <strong>{user.fullName}</strong>
            <span className="muted">
              {user.facility ? user.facility.name : humanize(user.role)}
              {user.specialty ? ` · ${user.specialty}` : ''}
            </span>
          </span>
          <NotificationBell />
          {user.role !== 'PATIENT' && (
            <NavLink to="/account" className="btn btn-ghost btn-sm">
              Account
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
            Sign out
          </button>
        </div>
      </header>
      <div className="body">
        <nav className="sidenav" aria-label="Main">
          <ul>
            {NAV[user.role].map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
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
