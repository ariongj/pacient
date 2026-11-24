import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';
import type { Role } from './types';

/** API client and labels for account management by the platform administrator (/admin/users). */

export const ACCOUNT_STATUSES = ['active', 'disabled', 'locked', 'pending', 'no_mfa'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** Roles the administrator can invite or assign (never patients: facilities register them). */
export const INVITABLE_ROLES = [
  'DIRECTOR',
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
  'LAB_TECHNICIAN',
  'IT_SUPPORT',
  'MINISTRY',
  'ADMIN',
] as const satisfies readonly Role[];
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const FACILITY_ROLES: Role[] = [
  'DIRECTOR',
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
  'LAB_TECHNICIAN',
  'IT_SUPPORT',
];
export const LICENSED_ROLES: Role[] = ['DOCTOR', 'NURSE', 'PHARMACIST'];
export const ALL_ROLES: Role[] = [...INVITABLE_ROLES, 'PATIENT'];

export interface AccountSummary {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  facilityId: string | null;
  facilityName: string | null;
  isActive: boolean;
  activated: boolean;
  locked: boolean;
  lockedUntil: string | null;
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AccountDetail extends AccountSummary {
  specialty: string | null;
  licenseNumber: string | null;
  failedLoginAttempts: number;
  passwordChangedAt: string | null;
  /** Patients whose care team includes this person: a role or facility change waits for 0. */
  activeCareTeams: number;
}

export interface AccountSession {
  id: string;
  device: string;
  network: string | null;
  startedAt: string;
  lastUsedAt: string;
}

export interface SignInEvent {
  id: string;
  occurredAt: string;
  action: string;
  outcome: string;
  device: string | null;
  network: string | null;
  factors: string[] | null;
  reason: string | null;
}

export interface AdminHistoryEntry {
  id: string;
  occurredAt: string;
  action: string;
  outcome: string;
  actorName: string | null;
  actorRole: Role | null;
  reason: string | null;
  changes: string[];
  /** What caused an automatic change, e.g. death_registration or access_review. */
  source: string | null;
}

export interface AccountPage {
  user: AccountDetail;
  sessions: AccountSession[];
  signIns: SignInEvent[];
  adminHistory: AdminHistoryEntry[];
}

export interface AccountList {
  items: AccountSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: { active: number; disabled: number; locked: number; pending: number; noMfa: number };
}

export interface AccountFilters {
  q?: string;
  role?: Role | '';
  facilityId?: string;
  status?: AccountStatus | '';
  page: number;
}

export interface InviteInput {
  email: string;
  fullName: string;
  role: InvitableRole;
  facilityId?: string | null;
  specialty?: string | null;
  licenseNumber?: string | null;
}

export interface InviteResult {
  user: AccountSummary;
  emailQueued: boolean;
  /** Outside production only; in production the person receives the link by e-mail. */
  activationUrl: string | null;
  expiresInHours: number;
  licenceLinked: boolean;
}

/* ---------------------------------------------------------------------------- labels -- */

export const roleLabel = (r: Role) =>
  ({
    ADMIN: t('Platform administrator'),
    MINISTRY: t('Ministry official'),
    DIRECTOR: t('Director'),
    DOCTOR: t('Doctor'),
    NURSE: t('Nurse'),
    PHARMACIST: t('Pharmacist'),
    RECEPTION: t('Reception'),
    LAB_TECHNICIAN: t('Laboratory technician'),
    IT_SUPPORT: t('IT support'),
    PATIENT: t('Patient'),
  })[r];

export const statusLabel = (s: AccountStatus) =>
  ({
    active: t('Active|account'),
    disabled: t('Disabled|account'),
    locked: t('Locked|account'),
    pending: t('Not activated yet'),
    no_mfa: t('No two-step sign-in'),
  })[s];

/** The states of one account as badges (an account can be locked and lack two-step sign-in). */
export function accountBadges(a: AccountSummary) {
  const badges: { label: string; tone: 'success' | 'neutral' | 'warning' | 'danger' | 'info' }[] =
    [];
  if (!a.isActive) badges.push({ label: statusLabel('disabled'), tone: 'neutral' });
  else if (!a.activated) badges.push({ label: statusLabel('pending'), tone: 'info' });
  else badges.push({ label: statusLabel('active'), tone: 'success' });
  if (a.locked) badges.push({ label: statusLabel('locked'), tone: 'danger' });
  if (a.activated && !a.mfaEnabled && a.role !== 'PATIENT') {
    badges.push({ label: statusLabel('no_mfa'), tone: 'warning' });
  }
  return badges;
}

/* ----------------------------------------------------------------------------- hooks -- */

const KEY = ['admin', 'users'] as const;

export function useAccounts(filters: AccountFilters) {
  return useQuery({
    queryKey: [...KEY, 'list', filters],
    queryFn: () =>
      api<AccountList>('/admin/users', {
        query: {
          q: filters.q || undefined,
          role: filters.role || undefined,
          facilityId: filters.facilityId || undefined,
          status: filters.status || undefined,
          page: filters.page,
        },
      }),
    placeholderData: (previous) => previous,
  });
}

export function useAccount(id: string) {
  return useQuery({
    queryKey: [...KEY, 'one', id],
    queryFn: () => api<AccountPage>(`/admin/users/${id}`),
  });
}

export function useFacilityOptions() {
  return useQuery({
    queryKey: [...KEY, 'facilities'],
    queryFn: () =>
      api<{ items: { id: string; name: string }[] }>('/admin/users/facilities').then(
        (r) => r.items,
      ),
    staleTime: 5 * 60_000,
  });
}

export function useInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: InviteInput) => api<InviteResult>('/admin/users', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, 'list'] }),
  });
}

export type AccountAction =
  | 'disable'
  | 'enable'
  | 'unlock'
  | 'password-reset'
  | 'mfa-reset'
  | 'revoke-sessions'
  | 'resend-invitation';

/** One of the account actions; the response is the refreshed account page. */
export function useAccountAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, reason }: { action: AccountAction; reason?: string }) =>
      api<AccountPage & { activationUrl?: string | null; emailQueued?: boolean }>(
        `/admin/users/${id}/${action}`,
        { method: 'POST', body: reason ? { reason } : {} },
      ),
    onSuccess: (page) => {
      qc.setQueryData([...KEY, 'one', id], page);
      void qc.invalidateQueries({ queryKey: [...KEY, 'list'] });
    },
  });
}

export interface AccountChange {
  fullName?: string;
  role?: InvitableRole;
  facilityId?: string | null;
  specialty?: string | null;
  licenseNumber?: string | null;
  reason?: string;
}

export interface AccountChangeResult extends AccountPage {
  /** Doctors, nurses and pharmacists: whether a register licence of their profession is linked. */
  licenceLinked: boolean | null;
  /** The licence of the old profession was unlinked (a change of role). */
  licenceUnlinked: boolean;
}

export function useUpdateAccount(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AccountChange) =>
      api<AccountChangeResult>(`/admin/users/${id}`, { method: 'PATCH', body }),
    onSuccess: (page) => {
      qc.setQueryData([...KEY, 'one', id], page);
      void qc.invalidateQueries({ queryKey: [...KEY, 'list'] });
    },
  });
}
