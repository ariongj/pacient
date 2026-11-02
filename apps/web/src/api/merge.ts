import { api } from './client';

/** Duplicate patient records: types and calls for the director's merge workflow. */
export interface MergeDemographics {
  id: string;
  nationalId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: string;
  bloodType: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  municipality: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  hasPortalAccount: boolean;
  mergedIntoId: string | null;
  createdAt: string;
}

export interface DuplicateCandidate {
  a: MergeDemographics;
  b: MergeDemographics;
  score: number;
  reasons: string[];
}

export interface CompareSide extends MergeDemographics {
  guardians: string[];
  counts: Record<string, number>;
  totalRecords: number;
}

export interface CompareResult {
  a: CompareSide;
  b: CompareSide;
  /** table → English label */
  sections: Record<string, string>;
}

export type ChoosableField =
  'phone' | 'email' | 'address' | 'municipality' | 'emergencyContact' | 'bloodType';

export interface MergeHistoryItem {
  id: string;
  survivor: Brief;
  merged: Brief;
  reason: string;
  movedCount: number;
  changedFields: string[];
  accountMoved: boolean;
  mergedAt: string;
  mergedBy: string | null;
  unmergedAt: string | null;
  unmergedBy: string | null;
  unmergeReason: string | null;
}
interface Brief {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  nationalId: string;
}

export const mergeApi = {
  candidates: () => api<{ items: DuplicateCandidate[] }>('/patient-merges/candidates'),
  compare: (a: string, b: string) =>
    api<CompareResult>('/patient-merges/compare', { query: { a, b } }),
  history: () => api<{ items: MergeHistoryItem[] }>('/patient-merges'),
  merge: (body: {
    survivorId: string;
    mergedId: string;
    reason: string;
    fieldChoices: Partial<Record<ChoosableField, 'survivor' | 'merged'>>;
  }) =>
    api<{ id: string; moved: Record<string, number> }>('/patient-merges', {
      method: 'POST',
      body,
    }),
  unmerge: (id: string, reason: string) =>
    api<{ id: string }>(`/patient-merges/${id}/unmerge`, { method: 'POST', body: { reason } }),
};
