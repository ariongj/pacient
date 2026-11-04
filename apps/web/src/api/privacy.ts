import { t } from '../i18n';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

export type RequestKind =
  'ACCESS' | 'RECTIFICATION' | 'RESTRICTION' | 'ERASURE' | 'OBJECTION' | 'PORTABILITY';
export type RequestStatus = 'RECEIVED' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED';
export type ReceivedVia = 'PORTAL' | 'IN_PERSON' | 'POST' | 'EMAIL';

export interface RetentionPolicy {
  id: string;
  category: string;
  description: string;
  retainDays: number;
  defaultDays: number | null;
  action: 'PURGE' | 'ANONYMISE';
  legalBasis: string;
  isActive: boolean;
  lastRunAt: string | null;
  lastRunCount: number | null;
  updatedAt: string;
}

export interface RetentionResult {
  dryRun: boolean;
  ranAt: string;
  categories: { category: string; action: string; retainDays: number; count: number }[];
  total: number;
}

export interface DataSubjectRequest {
  id: string;
  patientId: string;
  kind: RequestKind;
  status: RequestStatus;
  details: string | null;
  receivedVia: ReceivedVia;
  receivedAt: string;
  dueAt: string;
  completedAt: string | null;
  outcome: string | null;
  overdue: boolean;
  patientName?: string;
  nationalId?: string;
  facilityName?: string | null;
  handledBy?: string | null;
}

export interface LegalHold {
  id: string;
  patientId: string;
  reason: string;
  createdAt: string;
  releasedAt: string | null;
  patientName: string;
  nationalId: string;
  createdBy: string | null;
}

const KEY = ['privacy'];

/* ---------------------------------------------------------------- retention */

export const useRetention = () =>
  useQuery({
    queryKey: [...KEY, 'retention'],
    queryFn: () => api<{ items: RetentionPolicy[]; canEdit: boolean }>('/privacy/retention'),
  });

export function useUpdateRetention(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ category, ...body }: { category: string } & Record<string, unknown>) =>
      api<RetentionPolicy>(`/privacy/retention/${category}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, 'retention'] });
      onDone?.();
    },
  });
}

export const useRetentionPreview = () =>
  useMutation({
    mutationFn: () => api<RetentionResult>('/privacy/retention/preview', { method: 'POST' }),
  });

export function useRunRetention() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<RetentionResult>('/privacy/retention/run', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY, 'retention'] }),
  });
}

/* ---------------------------------------------------------------- requests */

export const useMyRequests = (enabled = true) =>
  useQuery({
    queryKey: [...KEY, 'mine'],
    queryFn: () => api<{ items: DataSubjectRequest[] }>('/privacy/my-requests'),
    enabled,
  });

export function useCreateMyRequest(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { kind: RequestKind; details?: string }) =>
      api<DataSubjectRequest>('/privacy/my-requests', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, 'mine'] });
      onDone?.();
    },
  });
}

export interface RequestFilters {
  page: number;
  status?: RequestStatus | '';
  kind?: RequestKind | '';
  overdue?: boolean;
}

export const useRequests = (f: RequestFilters) =>
  useQuery({
    queryKey: [...KEY, 'requests', f],
    queryFn: () =>
      api<{
        items: DataSubjectRequest[];
        page: number;
        totalPages: number;
        total: number;
        overdueCount: number;
      }>('/privacy/requests', {
        query: { page: f.page, status: f.status, kind: f.kind, overdue: f.overdue ? 'true' : '' },
      }),
  });

export function useCreateRequest(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<DataSubjectRequest>('/privacy/requests', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, 'requests'] });
      onDone?.();
    },
  });
}

export function useUpdateRequest(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; status: string; outcome?: string }) =>
      api<DataSubjectRequest>(`/privacy/requests/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, 'requests'] });
      onDone?.();
    },
  });
}

/* ---------------------------------------------------------------- legal holds */

export const useHolds = (active: boolean) =>
  useQuery({
    queryKey: [...KEY, 'holds', active],
    queryFn: () =>
      api<{ items: LegalHold[] }>('/privacy/holds', { query: { active: String(active) } }),
  });

export function usePlaceHold(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/privacy/holds', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, 'holds'] });
      onDone?.();
    },
  });
}

export function useReleaseHold(onDone?: () => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api(`/privacy/holds/${id}/release`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...KEY, 'holds'] });
      onDone?.();
    },
  });
}

/* ---------------------------------------------------------------- labels */

// Getters so labels follow a language switch.
export const KIND_LABELS: Record<RequestKind, string> = {
  get ACCESS() {
    return t('Copy of my data (access)');
  },
  get RECTIFICATION() {
    return t('Correction (rectification)');
  },
  get RESTRICTION() {
    return t('Restrict processing');
  },
  get ERASURE() {
    return t('Erasure');
  },
  get OBJECTION() {
    return t('Objection to processing');
  },
  get PORTABILITY() {
    return t('Data portability');
  },
};

export const STATUS_LABELS: Record<RequestStatus, string> = {
  get RECEIVED() {
    return t('Received');
  },
  get IN_PROGRESS() {
    return t('In progress');
  },
  get COMPLETED() {
    return t('Completed');
  },
  get REJECTED() {
    return t('Rejected');
  },
};

export const VIA_LABELS: Record<ReceivedVia, string> = {
  get PORTAL() {
    return t('Online (portal)');
  },
  get IN_PERSON() {
    return t('In person');
  },
  get POST() {
    return t('By post');
  },
  get EMAIL() {
    return t('By email');
  },
};

export const statusTone = (s: RequestStatus, overdue: boolean) =>
  overdue ? 'danger' : s === 'COMPLETED' ? 'success' : s === 'REJECTED' ? 'neutral' : 'warning';
