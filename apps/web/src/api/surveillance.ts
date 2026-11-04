import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

export type CaseStatus = 'DRAFT' | 'SUBMITTED' | 'REVIEWED';
export type CaseClassification = 'SUSPECTED' | 'PROBABLE' | 'CONFIRMED' | 'DISCARDED';
export type Urgency = 'IMMEDIATE' | 'WEEKLY';

export interface NotifiableDisease {
  id: string;
  code: string;
  name: string;
  icd10Prefixes: string[];
  urgency: Urgency;
  isActive: boolean;
}

export interface CaseDetails {
  symptoms?: string[];
  hospitalised?: boolean;
  travelHistory?: string;
  contactsCount?: number;
  vaccinationStatus?: 'VACCINATED' | 'PARTIALLY' | 'NOT_VACCINATED' | 'UNKNOWN';
  labConfirmation?: string;
  outbreakSuspected?: boolean;
  notes?: string;
  discardReason?: string;
}

export interface CaseReport {
  id: string;
  status: CaseStatus;
  classification: CaseClassification;
  onsetDate: string | null;
  details: CaseDetails;
  createdAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  reportedById: string | null;
  reporterName: string | null;
  facilityId: string;
  facilityName: string;
  diagnosisId: string | null;
  icd10Code: string | null;
  disease: { id: string; code: string; name: string; urgency: Urgency };
  /** Directors get only age, sex and municipality. */
  patient: {
    id?: string;
    name?: string;
    nationalId?: string;
    dateOfBirth?: string;
    age: number;
    sex: string;
    municipality: string | null;
  };
}

export interface PatientCase {
  id: string;
  diagnosisId: string | null;
  status: CaseStatus;
  classification: CaseClassification;
  diseaseName: string;
  urgency: Urgency;
  reportedById: string | null;
}

export interface Dashboard {
  scope: 'NATIONAL' | 'FACILITY';
  weeks: string[];
  currentWeek: string;
  diseases: { code: string; name: string; urgency: Urgency; total: number; counts: number[] }[];
  municipalities: {
    municipality: string;
    counts: Record<string, number | null>;
    total: number | null;
  }[];
  alerts: {
    diseaseCode: string;
    diseaseName: string;
    kind: 'IMMEDIATE' | 'INCREASE';
    week: string;
    count: number;
    baseline: number | null;
  }[];
  suppressionThreshold: number;
  timeliness: {
    drafts: number;
    overdueDrafts: number;
    submitted: number;
    submittedOnTime: number;
    onTimePct: number | null;
  };
}

const KEY = ['surveillance'] as const;

/** Disease names are stored in English and translated here. */
export const diseaseName = (name: string) => t(name);

export const classificationLabel = (c: CaseClassification) =>
  ({
    SUSPECTED: t('Suspected'),
    PROBABLE: t('Probable'),
    CONFIRMED: t('Confirmed'),
    DISCARDED: t('Discarded'),
  })[c];

export const caseStatusLabel = (s: CaseStatus) =>
  ({ DRAFT: t('Draft'), SUBMITTED: t('Submitted'), REVIEWED: t('Reviewed') })[s];

export const urgencyLabel = (u: Urgency) =>
  u === 'IMMEDIATE' ? t('Report within 24 hours') : t('Weekly reporting');

export function useMyCases(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'mine'],
    queryFn: () => api<{ items: CaseReport[]; drafts: number }>('/surveillance/my-cases'),
    enabled,
  });
}

export function usePatientCases(patientId: string, enabled = true) {
  return useQuery({
    queryKey: ['patient', patientId, 'case-reports'],
    queryFn: () =>
      api<{ items: PatientCase[] }>(`/surveillance/patients/${patientId}/cases`).then(
        (r) => r.items,
      ),
    enabled,
  });
}

export function useCases(query: Record<string, string | number | undefined>) {
  return useQuery({
    queryKey: [...KEY, 'cases', query],
    queryFn: () =>
      api<{ items: CaseReport[]; page: number; totalPages: number; total: number }>(
        '/surveillance/cases',
        { query },
      ),
  });
}

export function useDashboard(weeks: number) {
  return useQuery({
    queryKey: [...KEY, 'dashboard', weeks],
    queryFn: () => api<Dashboard>('/surveillance/dashboard', { query: { weeks } }),
  });
}

export function useDiseases() {
  return useQuery({
    queryKey: [...KEY, 'diseases'],
    queryFn: () => api<{ items: NotifiableDisease[] }>('/surveillance/diseases').then((r) => r.items),
    staleTime: 10 * 60_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ['patient'] });
  };
}

export function useUpdateCase() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<CaseReport>(`/surveillance/cases/${id}`, { method: 'PATCH', body }),
    onSuccess: done,
  });
}

export function useCaseAction() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: 'submit' | 'discard' | 'review';
      body?: Record<string, unknown>;
    }) => api<CaseReport>(`/surveillance/cases/${id}/${action}`, { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useSaveDisease() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Record<string, unknown> }) =>
      id
        ? api<NotifiableDisease>(`/surveillance/diseases/${id}`, { method: 'PATCH', body })
        : api<NotifiableDisease>('/surveillance/diseases', { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY, 'diseases'] }),
  });
}
