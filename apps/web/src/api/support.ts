import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';
import type { Role } from './types';

/** API client and types for the IT support desk. */

export const TICKET_KINDS = [
  'ACCOUNT_LOCKED',
  'PASSWORD_RESET',
  'MFA_RESET',
  'ACCESS_CHANGE',
  'DEVICE',
  'OTHER',
] as const;
export type TicketKind = (typeof TICKET_KINDS)[number];
export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'AWAITING_APPROVAL' | 'RESOLVED' | 'REJECTED';
export type TicketFilter = 'open' | 'approval' | 'closed' | 'all';

export interface AccountState {
  id: string;
  fullName: string;
  role: Role;
  email?: string;
  isActive?: boolean;
  activated?: boolean;
  locked?: boolean;
  lockedUntil?: string | null;
  failedLoginAttempts?: number;
  twoStepEnabled?: boolean;
  lastLoginAt?: string | null;
}

export interface Ticket {
  id: string;
  reference: string;
  kind: TicketKind;
  status: TicketStatus;
  description: string;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  approvedAt: string | null;
  requesterName: string | null;
  assigneeName: string | null;
  approverName: string | null;
  assignedToMe: boolean;
  needsApproval: boolean;
  subject: AccountState | null;
}

export interface SupportMe {
  desk: boolean;
  approves: boolean;
  national: boolean;
  canRequest: boolean;
}

export interface SupportStats {
  facilities: {
    facilityId: string;
    facilityName: string;
    open: number;
    awaitingApproval: number;
    resolved30d: number;
    medianHours: number | null;
  }[];
  byKind: { kind: TicketKind; count: number }[];
}

/* ---------------------------------------------------------------------------- labels -- */

export const kindLabel = (k: TicketKind) =>
  ({
    ACCOUNT_LOCKED: t('Account locked'),
    PASSWORD_RESET: t('Forgotten password'),
    MFA_RESET: t('Lost two-step sign-in (phone or key)'),
    ACCESS_CHANGE: t('Access change (role, unit, facility)'),
    DEVICE: t('Computer, printer or scanner'),
    OTHER: t('Other|request'),
  })[k];

export const statusLabel = (s: TicketStatus) =>
  ({
    OPEN: t('Open|request'),
    IN_PROGRESS: t('In progress'),
    AWAITING_APPROVAL: t('Waiting for the director'),
    RESOLVED: t('Resolved'),
    REJECTED: t('Closed without a change'),
  })[s];

export const statusTone = (s: TicketStatus) =>
  (
    ({
      OPEN: 'warning',
      IN_PROGRESS: 'info',
      AWAITING_APPROVAL: 'warning',
      RESOLVED: 'success',
      REJECTED: 'neutral',
    }) as const
  )[s];

/* ----------------------------------------------------------------------------- hooks -- */

const KEY = ['support'] as const;

export function useSupportMe() {
  return useQuery({ queryKey: [...KEY, 'me'], queryFn: () => api<SupportMe>('/support/me') });
}

export function useTickets(status: TicketFilter, page: number, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'tickets', status, page],
    queryFn: () =>
      api<{ items: Ticket[]; page: number; totalPages: number; total: number }>(
        '/support/tickets',
        { query: { status, page } },
      ),
    enabled,
  });
}

export function useTicket(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'ticket', id],
    queryFn: () => api<Ticket>(`/support/tickets/${id}`),
    enabled: Boolean(id),
  });
}

export function useColleagues(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'colleagues'],
    queryFn: () =>
      api<{ items: { id: string; fullName: string; role: Role }[] }>('/support/colleagues').then(
        (r) => r.items,
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSupportStats(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'stats'],
    queryFn: () => api<SupportStats>('/support/stats'),
    enabled,
  });
}

export function useOpenTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { kind: TicketKind; description: string; subjectUserId?: string }) =>
      api<Ticket>('/support/tickets', { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export type TicketAction =
  | 'assign'
  | 'request-approval'
  | 'approve'
  | 'reject-approval'
  | 'unlock'
  | 'password-reset'
  | 'mfa-reset'
  | 'resolve'
  | 'reject';

export function useTicketAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: TicketAction;
      body?: Record<string, unknown>;
    }) => api<Ticket>(`/support/tickets/${id}/${action}`, { method: 'POST', body: body ?? {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
