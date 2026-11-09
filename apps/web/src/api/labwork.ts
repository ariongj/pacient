import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/** API client and types for laboratory work (worklist, specimens, manual results). */

export type LabPriority = 'ROUTINE' | 'URGENT' | 'STAT';
export type LabOrderStatus = 'ORDERED' | 'RECEIVED' | 'IN_PROGRESS' | 'RESULTED' | 'CANCELLED';
export type LabFlag = 'NORMAL' | 'LOW' | 'HIGH' | 'CRITICAL';
export type SpecimenEvent = 'COLLECTED' | 'RECEIVED' | 'REJECTED' | 'RESULT_ENTERED' | 'VALIDATED';
export type WorklistView = 'open' | 'validation' | 'done';

export const REJECTION_REASONS = [
  'HAEMOLYSED',
  'CLOTTED',
  'MISLABELLED',
  'INSUFFICIENT',
  'WRONG_CONTAINER',
  'DELAYED_TRANSPORT',
  'OTHER',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export interface WorklistItem {
  id: string;
  placerOrderNumber: string;
  testCode: string;
  testName: string;
  specimen: string | null;
  priority: LabPriority;
  status: LabOrderStatus;
  clinicalNotes: string | null;
  createdAt: string;
  receivedAt: string | null;
  resultedAt: string | null;
  orderedBy: string;
  lisManaged: boolean;
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    sex: string;
    nationalId: string;
    temporaryIdentity: string | null;
  };
  barcode: string | null;
  lastEvent: { event: SpecimenEvent; reason: string | null; at: string } | null;
  result: {
    id: string;
    value: string;
    unit: string | null;
    referenceRange: string | null;
    flag: LabFlag;
    status: 'PRELIMINARY' | 'FINAL' | 'CORRECTED';
    enteredById: string | null;
    enteredByName: string | null;
    canValidate: boolean;
  } | null;
}

export interface LabLabel {
  placerOrderNumber: string;
  barcode: string;
  testName: string;
  specimen: string | null;
  priority: LabPriority;
  collectedAt: string | null;
  patient: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    nationalId: string;
    sex: string;
    temporaryIdentity: string | null;
  };
}

export interface LabStats {
  days: number;
  turnaround: { priority: LabPriority; count: number; median: number | null; p90: number | null }[];
  resulted: number;
  resultedByLis: number;
  rejections: { reason: string; count: number }[];
  open: Record<'ORDERED' | 'RECEIVED' | 'IN_PROGRESS', number>;
}

/* ---------------------------------------------------------------------------- labels -- */

export const priorityLabel = (p: LabPriority) =>
  ({ ROUTINE: t('Routine'), URGENT: t('Urgent'), STAT: t('STAT (immediately)') })[p];

export const rejectionLabel = (r: string) =>
  ({
    HAEMOLYSED: t('Haemolysed'),
    CLOTTED: t('Clotted'),
    MISLABELLED: t('Mislabelled or unlabelled'),
    INSUFFICIENT: t('Insufficient volume'),
    WRONG_CONTAINER: t('Wrong container'),
    DELAYED_TRANSPORT: t('Delayed transport'),
    OTHER: t('Other|reason'),
  })[r] ?? r;

export const eventLabel = (e: SpecimenEvent) =>
  ({
    COLLECTED: t('Specimen taken'),
    RECEIVED: t('Received in the laboratory'),
    REJECTED: t('Specimen rejected'),
    RESULT_ENTERED: t('Result entered'),
    VALIDATED: t('Validated'),
  })[e];

export const flagLabel = (f: LabFlag) =>
  ({ NORMAL: t('Normal'), LOW: t('Low'), HIGH: t('High'), CRITICAL: t('Critical') })[f];

/* ----------------------------------------------------------------------------- hooks -- */

const KEY = ['lab-work'] as const;

export function useLabMe() {
  return useQuery({
    queryKey: [...KEY, 'me'],
    queryFn: () => api<{ labStaff: boolean; canSeeStats: boolean }>('/lab-work/me'),
  });
}

export function useWorklist(
  query: { view: WorklistView; priority?: string; q?: string; page: number },
  enabled = true,
) {
  return useQuery({
    queryKey: [...KEY, 'worklist', query],
    queryFn: () =>
      api<{ items: WorklistItem[]; page: number; totalPages: number; total: number }>(
        '/lab-work/worklist',
        { query: { ...query, priority: query.priority || undefined, q: query.q || undefined } },
      ),
    enabled,
    refetchInterval: 60_000,
  });
}

export function useLabStats(days: number, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'stats', days],
    queryFn: () => api<LabStats>('/lab-work/stats', { query: { days } }),
    enabled,
  });
}

export function useLabLabel(orderId: string | null) {
  return useQuery({
    queryKey: [...KEY, 'label', orderId],
    queryFn: () => api<LabLabel>(`/lab-work/orders/${orderId}/label`),
    enabled: Boolean(orderId),
  });
}

export type LabAction =
  | { kind: 'collect'; orderId: string; barcode?: string }
  | { kind: 'receive'; orderId: string; barcode: string }
  | { kind: 'reject'; orderId: string; reason: RejectionReason; note?: string }
  | { kind: 'result'; orderId: string; value: string; critical?: boolean }
  | { kind: 'validate'; resultId: string };

export function useLabAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: LabAction) => {
      if (a.kind === 'validate') {
        return api<unknown>(`/lab-work/results/${a.resultId}/validate`, {
          method: 'POST',
          body: {},
        });
      }
      const { kind, orderId, ...body } = a;
      return api<unknown>(`/lab-work/orders/${orderId}/${kind}`, { method: 'POST', body });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
