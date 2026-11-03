import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

export type DoseState = 'GIVEN' | 'DUE' | 'OVERDUE' | 'UPCOMING' | 'NOT_APPLICABLE';

export interface ScheduleItem {
  id: string;
  code: string;
  vaccine: string;
  doseNumber: number;
  recommendedAgeDays: number;
  overdueAgeDays: number;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
}

export interface DoseStatus {
  scheduleItemId: string;
  code: string;
  vaccine: string;
  doseNumber: number;
  description?: string | null;
  recommendedAgeDays?: number;
  state: DoseState;
  dueDate: string;
  overdueDate: string;
  given?: {
    immunizationId: string;
    administeredAt: string;
    administeredBy: string | null;
    lotNumber: string | null;
    site: string | null;
    linked: boolean;
  } | null;
}

export interface VaccinationStatus {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    sex: string;
    temporaryIdentity: string | null;
  };
  ageDays: number;
  nextDueDate: string | null;
  clinical: boolean;
  doses: DoseStatus[];
  other?: {
    immunizationId: string;
    vaccine: string;
    doseNumber: number | null;
    administeredAt: string;
  }[];
}

export interface DueChild {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    nationalId: string;
    dateOfBirth: string;
    sex: string;
    temporaryIdentity: string | null;
  };
  ageDays: number;
  hasGuardian: boolean;
  hasContact: boolean;
  doses: {
    scheduleItemId: string;
    code: string;
    vaccine: string;
    doseNumber: number;
    state: 'DUE' | 'OVERDUE' | 'UPCOMING';
    dueDate: string;
  }[];
}

export interface DueList {
  items: DueChild[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: { children: number; overdue: number; due: number; upcoming: number };
}

export interface CoverageDose {
  code: string;
  vaccine: string;
  doseNumber: number;
  vaccinated: number | null;
  percent: number | null;
  lowCount: boolean;
}

export interface CoverageRow {
  facilityId: string;
  facilityName: string;
  region: string | null;
  children: number | null;
  suppressed: boolean;
  doses: CoverageDose[];
}

export interface Coverage {
  cohort: string;
  cohortLabel: string;
  asOf: string;
  threshold: number;
  scope: 'FACILITY' | 'NATIONAL';
  total: Omit<CoverageRow, 'facilityId' | 'facilityName' | 'region'>;
  rows: CoverageRow[];
  cohorts: { key: string; label: string }[];
}

export const VACCINATION_KEY = ['vaccination'] as const;

export function useSchedule() {
  return useQuery({
    queryKey: [...VACCINATION_KEY, 'schedule'],
    queryFn: () => api<{ items: ScheduleItem[] }>('/vaccination/schedule').then((r) => r.items),
    staleTime: 10 * 60_000,
  });
}

export function useVaccinationStatus(patientId: string | null | undefined) {
  return useQuery({
    queryKey: ['patient', patientId, 'vaccination-status'],
    queryFn: () => api<VaccinationStatus>(`/vaccination/patients/${patientId}/status`),
    enabled: Boolean(patientId),
  });
}

export function useRecordDose(patientId: string, onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      scheduleItemId: string;
      administeredAt?: string;
      lotNumber?: string;
      site?: string;
      notes?: string;
    }) => api(`/vaccination/patients/${patientId}/doses`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId] });
      void qc.invalidateQueries({ queryKey: VACCINATION_KEY });
      onDone?.();
    },
  });
}

export function useLinkDose(patientId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { immunizationId: string; scheduleItemId: string }) =>
      api(`/vaccination/patients/${patientId}/link`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId] });
      void qc.invalidateQueries({ queryKey: VACCINATION_KEY });
    },
  });
}

/** Readable age: "6 weeks", "4 months", "6 years". */
export function ageLabel(days: number): string {
  if (days <= 0) return t('At birth');
  if (days < 60) {
    const weeks = Math.round(days / 7);
    return weeks === 1 ? t('1 week') : t('{count} weeks', { count: weeks });
  }
  if (days < 730) {
    const months = Math.round(days / 30.44);
    return months === 1 ? t('1 month') : t('{count} months', { count: months });
  }
  const years = Math.round(days / 365.25);
  return t('{count} years', { count: years });
}

/** Current age in readable form from a date of birth. */
export function ageFromDob(dateOfBirth: string): string {
  const days = Math.floor(
    (Date.now() - new Date(`${dateOfBirth}T00:00:00Z`).getTime()) / 86_400_000,
  );
  return ageLabel(days);
}

export const DOSE_STATE_TONE: Record<
  DoseState,
  'success' | 'warning' | 'danger' | 'info' | 'neutral'
> = {
  GIVEN: 'success',
  DUE: 'warning',
  OVERDUE: 'danger',
  UPCOMING: 'info',
  NOT_APPLICABLE: 'neutral',
};

export function doseStateLabel(state: DoseState): string {
  switch (state) {
    case 'GIVEN':
      return t('Given');
    case 'DUE':
      return t('Due now');
    case 'OVERDUE':
      return t('Overdue');
    case 'UPCOMING':
      return t('Upcoming');
    default:
      return t('Not applicable');
  }
}

/** "DTaP-IPV-Hib-HepB · dose 2" */
export function doseName(d: { vaccine: string; doseNumber: number }): string {
  return t('{vaccine} · dose {dose}', { vaccine: d.vaccine, dose: d.doseNumber });
}
