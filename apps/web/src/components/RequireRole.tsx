import { t } from '../i18n';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { Role } from '../api/types';
import { HOME_BY_ROLE, MFA_SETUP_PATH, needsMfaEnrollment, useAuth } from '../auth/AuthContext';
import { Loading } from './ui';

/**
 * UI route guard. This only controls navigation; every permission is enforced again by the API.
 */
export function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Loading label={t('Restoring your session…')} />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (needsMfaEnrollment(user)) return <Navigate to={MFA_SETUP_PATH} replace />;
  if (!roles.includes(user.role)) {
    // Doctors and nurses share the patient list and chart under their own workspace: a link
    // written for one workspace opens the same page in the other, section included.
    const chart = /^\/(doctor|nurse)(\/patients(?:\/(?!new$)[^/]+)?)$/.exec(location.pathname);
    if (chart && (user.role === 'DOCTOR' || user.role === 'NURSE')) {
      const base = user.role === 'DOCTOR' ? '/doctor' : '/nurse';
      return <Navigate to={`${base}${chart[2]}${location.search}`} replace />;
    }
    return <Navigate to={HOME_BY_ROLE[user.role]} replace />;
  }
  return <>{children}</>;
}
