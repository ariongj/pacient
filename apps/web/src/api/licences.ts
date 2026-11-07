import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { t } from '../i18n';
import type { Page } from './types';

/** API client and types for professional licences. */

export const PROFESSIONS = ['PHYSICIAN', 'DENTIST', 'NURSE', 'MIDWIFE', 'PHARMACIST'] as const;
export type Profession = (typeof PROFESSIONS)[number];
export type LicenceStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
export type EffectiveStatus = 'VALID' | 'EXPIRED' | 'SUSPENDED' | 'REVOKED';
/** What a staff list shows: EXPIRING = valid but expires within 60 days; MISSING = no licence. */
export type LicenceState = EffectiveStatus | 'EXPIRING' | 'MISSING';
export const LIST_STATES = ['VALID', 'EXPIRING', 'EXPIRED', 'SUSPENDED', 'REVOKED'] as const;

export interface Licence {
  id: string;
  licenceNumber: string;
  holderName: string;
  profession: Profession;
  specialty: string | null;
  issuedBy: string;
  issuedOn: string;
  validUntil: string;
  status: LicenceStatus;
  statusReason: string | null;
  cpdCredits: number;
  userId: string | null;
  effectiveStatus: EffectiveStatus;
  daysToExpiry: number;
  expiringSoon: boolean;
}

export interface LicenceWithAccount extends Licence {
  account: {
    id: string;
    fullName: string;
    email: string;
    role: string;
    facilityName: string | null;
  } | null;
}

export interface FacilityStaffLicence {
  id: string;
  fullName: string;
  email: string;
  role: 'DOCTOR' | 'NURSE' | 'PHARMACIST';
  specialty: string | null;
  licenseNumber: string | null;
  isActive: boolean;
  state: LicenceState;
  licence: Licence | null;
  linkCandidate: { id: string; licenceNumber: string; holderName: string } | null;
}

export interface LicenceStats {
  byProfession: ({ profession: Profession } & Record<Exclude<LicenceState, 'MISSING'>, number>)[];
  linked: number;
  clinicalAccountsWithoutLicence: number;
  expiring: {
    id: string;
    licenceNumber: string;
    holderName: string;
    profession: Profession;
    validUntil: string;
    daysToExpiry: number;
  }[];
  expiryWarningDays: number;
}

export interface ImportResult {
  dryRun: boolean;
  create: number;
  update: number;
  errors: { line: number; message: string }[];
}

export interface LicenceInput {
  licenceNumber?: string;
  holderName: string;
  profession: Profession;
  specialty?: string | null;
  issuedBy: string;
  issuedOn: string;
  validUntil: string;
  cpdCredits?: number;
}

export function professionLabel(p: string): string {
  switch (p) {
    case 'PHYSICIAN':
      return t('Physician');
    case 'DENTIST':
      return t('Dentist');
    case 'NURSE':
      return t('Nurse|profession');
    case 'MIDWIFE':
      return t('Midwife');
    case 'PHARMACIST':
      return t('Pharmacist|profession');
    default:
      return p;
  }
}

export function stateLabel(s: LicenceState): string {
  switch (s) {
    case 'VALID':
      return t('Valid|licence');
    case 'EXPIRING':
      return t('Expires soon|licence');
    case 'EXPIRED':
      return t('Expired|licence');
    case 'SUSPENDED':
      return t('Suspended|licence');
    case 'REVOKED':
      return t('Revoked|licence');
    case 'MISSING':
      return t('No licence linked');
  }
}

export const stateTone = (s: LicenceState): 'success' | 'warning' | 'danger' | 'neutral' =>
  s === 'VALID' ? 'success' : s === 'EXPIRING' ? 'warning' : s === 'MISSING' ? 'neutral' : 'danger';

/** State shown for a licence row (VALID becomes EXPIRING within the warning period). */
export const licenceState = (l: Pick<Licence, 'effectiveStatus' | 'expiringSoon'>): LicenceState =>
  l.expiringSoon ? 'EXPIRING' : l.effectiveStatus;

export interface RegisterQuery {
  q?: string;
  profession?: string;
  state?: string;
  linked?: string;
  page: number;
}

export const useLicenceRegister = (query: RegisterQuery) =>
  useQuery({
    queryKey: ['licences', 'register', query],
    queryFn: () =>
      api<Page<LicenceWithAccount>>('/licences', {
        query: { ...query, pageSize: 25 } as Record<string, string | number>,
      }),
  });

export const useLicenceStats = () =>
  useQuery({
    queryKey: ['licences', 'stats'],
    queryFn: () => api<LicenceStats>('/licences/stats'),
  });

export const useFacilityLicences = (facilityId?: string) =>
  useQuery({
    queryKey: ['licences', 'facility', facilityId ?? 'own'],
    queryFn: () =>
      api<{
        items: FacilityStaffLicence[];
        summary: Record<LicenceState, number>;
        expiryWarningDays: number;
      }>('/licences/facility', { query: { facilityId } }),
  });

export const useLicenceHistory = (id: string | null) =>
  useQuery({
    queryKey: ['licences', 'history', id],
    enabled: Boolean(id),
    queryFn: () =>
      api<{
        items: {
          at: string;
          actor: string | null;
          change: string;
          reason?: string;
          from?: string;
          to?: string;
        }[];
      }>(`/licences/${id}/history`),
  });

export const useAccountSearch = (q: string) =>
  useQuery({
    queryKey: ['licences', 'accounts', q],
    enabled: q.trim().length >= 2,
    queryFn: () =>
      api<{
        items: {
          id: string;
          fullName: string;
          email: string;
          role: string;
          licenseNumber: string | null;
          facilityName: string | null;
          linkedLicenceId: string | null;
        }[];
      }>('/licences/accounts', { query: { q } }),
  });

export const useMyLicence = (enabled: boolean) =>
  useQuery({
    queryKey: ['licences', 'me'],
    enabled,
    queryFn: () => api<{ required: boolean; licence: Licence | null }>('/licences/me'),
  });

function useLicenceMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['licences'] });
      void qc.invalidateQueries({ queryKey: ['staff'] });
    },
  });
}

export const useCreateLicence = () =>
  useLicenceMutation((body: LicenceInput) => api<Licence>('/licences', { method: 'POST', body }));
export const useUpdateLicence = () =>
  useLicenceMutation(({ id, ...body }: Partial<LicenceInput> & { id: string }) =>
    api<Licence>(`/licences/${id}`, { method: 'PATCH', body }),
  );
export const useLicenceStatus = () =>
  useLicenceMutation(({ id, ...body }: { id: string; status: LicenceStatus; reason: string }) =>
    api<Licence>(`/licences/${id}/status`, { method: 'POST', body }),
  );
export const useLinkLicence = () =>
  useLicenceMutation(({ id, userId }: { id: string; userId: string }) =>
    api<Licence>(`/licences/${id}/link`, { method: 'POST', body: { userId } }),
  );
export const useUnlinkLicence = () =>
  useLicenceMutation(({ id, reason }: { id: string; reason: string }) =>
    api<Licence>(`/licences/${id}/unlink`, { method: 'POST', body: { reason } }),
  );
export const useImportLicences = () =>
  useLicenceMutation((body: { csv: string; dryRun: boolean }) =>
    api<ImportResult>('/licences/import', { method: 'POST', body }),
  );
