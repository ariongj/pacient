import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tone } from '../components/ui';
import { t } from '../i18n';
import { api } from './client';
import type { Paged } from './platform';

/**
 * Requests from a facility's directors and IT support to the operator of the service, and the
 * administrators' inbox. Never about a patient: the server refuses a 10-digit number.
 */

export const REQUEST_CATEGORIES = [
  'BILLING',
  'ACCOUNT',
  'TECHNICAL',
  'DATA_PROTECTION',
  'SECURITY_INCIDENT',
  'OTHER',
] as const;
export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];
export const REQUEST_STATUSES = ['OPEN', 'WAITING_CUSTOMER', 'RESOLVED'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Subjects up to 200 characters, messages up to 4000 (as the server checks). */
export const SUBJECT_MAX = 200;
export const BODY_MAX = 4000;

export interface OperatorRequestSummary {
  id: string;
  reference: string;
  facilityId: string;
  facilityName: string;
  category: RequestCategory;
  subject: string;
  status: RequestStatus;
  priority: 'NORMAL' | 'HIGH';
  requesterId: string;
  requesterName: string;
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  /** Number of messages in the conversation. */
  messages: number;
}

export interface RequestMessage {
  id: string;
  body: string;
  createdAt: string;
  fromOperator: boolean;
  /** Null for the operator's answers as the facility sees them. */
  authorId: string | null;
  authorName: string | null;
}

export interface OperatorRequestDetail extends Omit<OperatorRequestSummary, 'messages'> {
  messages: RequestMessage[];
}

export interface RequestInbox extends Paged<OperatorRequestSummary> {
  counts: { OPEN: number; WAITING_CUSTOMER: number; RESOLVED: number; highOpen: number };
  facilities: { id: string; name: string }[];
}

/* ------------------------------------------------------------------ labels ------------------- */

export const categoryLabel = (c: RequestCategory) =>
  ({
    BILLING: t('Billing and invoices|request category'),
    ACCOUNT: t('Accounts and access|request category'),
    TECHNICAL: t('Technical problem|request category'),
    DATA_PROTECTION: t('Data protection|request category'),
    SECURITY_INCIDENT: t('Security incident|request category'),
    OTHER: t('Something else|request category'),
  })[c] ?? c;

export const statusLabel = (s: RequestStatus, audience: 'admin' | 'facility') =>
  ({
    OPEN: t('Open|request status'),
    WAITING_CUSTOMER:
      audience === 'facility'
        ? t('Waiting for your answer|request status')
        : t('Waiting for the facility|request status'),
    RESOLVED: t('Resolved|request status'),
  })[s] ?? s;

export const STATUS_TONE: Record<RequestStatus, Tone> = {
  OPEN: 'info',
  WAITING_CUSTOMER: 'warning',
  RESOLVED: 'success',
};

/**
 * The client-side twin of the server's check: ten digits in a row, not part of a longer number,
 * look like a personal number. Shown before sending; the server refuses it anyway.
 */
export const looksLikePersonalNumber = (text: string) => /(?<!\d)\d{10}(?!\d)/.test(text);

/* ------------------------------------------------------------------ facility ----------------- */

const KEY = ['operator-requests'] as const;

export function useMyRequests(status: RequestStatus | '', page: number) {
  return useQuery({
    queryKey: [...KEY, 'mine', status, page],
    queryFn: () =>
      api<Paged<OperatorRequestSummary>>('/operator-requests', {
        query: { status, page, pageSize: 20 },
      }),
    placeholderData: keepPreviousData,
  });
}

export function useMyRequest(id: string) {
  return useQuery({
    queryKey: [...KEY, 'mine', 'one', id],
    queryFn: () => api<OperatorRequestDetail>(`/operator-requests/${id}`),
    refetchInterval: 60_000,
  });
}

export function useCreateRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { category: RequestCategory; subject: string; body: string }) =>
      api<OperatorRequestDetail>('/operator-requests', { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useReply(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      api<OperatorRequestDetail>(`/operator-requests/${id}/messages`, {
        method: 'POST',
        body: { body },
      }),
    onSuccess: (data) => {
      qc.setQueryData([...KEY, 'mine', 'one', id], data);
      void qc.invalidateQueries({ queryKey: [...KEY, 'mine'] });
    },
  });
}

/* ------------------------------------------------------------------ administrator ------------ */

const ADMIN_KEY = ['admin', 'requests'] as const;

export interface InboxFilters {
  status: RequestStatus | 'UNRESOLVED' | '';
  category: RequestCategory | '';
  facilityId: string;
}

export function useRequestInbox(filters: InboxFilters, page: number, pageSize = 25) {
  return useQuery({
    queryKey: [...ADMIN_KEY, 'list', filters, page, pageSize],
    queryFn: () => api<RequestInbox>('/admin/requests', { query: { ...filters, page, pageSize } }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export function useAdminRequest(id: string) {
  return useQuery({
    queryKey: [...ADMIN_KEY, 'one', id],
    queryFn: () => api<OperatorRequestDetail>(`/admin/requests/${id}`),
    refetchInterval: 60_000,
  });
}

export function useAnswer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { body: string; status?: RequestStatus }) =>
      api<OperatorRequestDetail>(`/admin/requests/${id}/messages`, { method: 'POST', body }),
    onSuccess: (data) => {
      qc.setQueryData([...ADMIN_KEY, 'one', id], data);
      void qc.invalidateQueries({ queryKey: [...ADMIN_KEY, 'list'] });
    },
  });
}

export function useSetRequestStatus(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: RequestStatus) =>
      api<OperatorRequestDetail>(`/admin/requests/${id}/status`, {
        method: 'POST',
        body: { status },
      }),
    onSuccess: (data) => {
      qc.setQueryData([...ADMIN_KEY, 'one', id], data);
      void qc.invalidateQueries({ queryKey: [...ADMIN_KEY, 'list'] });
    },
  });
}
