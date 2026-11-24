import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { Role } from './types';
import { intlLocale } from '../i18n';

/* ------------------------------------------------------------------ types ------------------- */

export type LegalKind = 'TERMS' | 'PRIVACY';
export type LegalLocale = 'sq' | 'sr' | 'en';
export const LEGAL_KINDS: LegalKind[] = ['TERMS', 'PRIVACY'];
export const LEGAL_LOCALES: LegalLocale[] = ['sq', 'sr', 'en'];

export interface PlatformNotice {
  text: string;
  tone: 'INFO' | 'WARNING';
  until: string | null;
}

export interface PlatformInfo {
  operatorName: string | null;
  operatorAddress: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  privacyEmail: string | null;
  notice: PlatformNotice | null;
}

/** A published text as readers see it (operator details filled in). */
export interface LegalText {
  id: string;
  kind: LegalKind;
  version: string;
  locale: LegalLocale;
  title: string;
  body: string;
  publishedAt: string;
  requiresAcceptance: boolean;
}

export interface PublicLegalDocument extends LegalText {
  operator: {
    name: string | null;
    address: string | null;
    supportEmail: string | null;
    privacyEmail: string | null;
  };
}

export interface PlatformSettings {
  operatorName: string;
  operatorAddress: string;
  operatorFiscalNumber: string | null;
  operatorVatNumber: string | null;
  operatorIban: string | null;
  operatorBank: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  privacyEmail: string | null;
  invoicePrefix: string;
  paymentTermsDays: number;
  vatRateBp: number;
  trialDays: number;
  graceDays: number;
  noticeText: string | null;
  noticeTone: 'INFO' | 'WARNING';
  noticeUntil: string | null;
  updatedAt: string;
  /** False when the stored IBAN does not pass the check (stored before it was stricter). */
  operatorIbanValid: boolean;
}

export type SubscriptionStatus =
  'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED';

export interface AuditItem {
  id: string;
  occurredAt: string;
  action: string;
  outcome: string;
  actorId: string | null;
  actorName: string | null;
  actorRole: Role | null;
  resourceType: string | null;
  resourceId: string | null;
  /** Null for a patient's portal account, which is never named (targetPatientAccount). */
  targetName: string | null;
  targetPatientAccount: boolean;
  metadata: Record<string, unknown> | null;
}

export interface AdminOverview {
  generatedAt: string;
  facilities: {
    total: number;
    withSubscription: number;
    byStatus: Record<SubscriptionStatus, number>;
  };
  users: {
    activeStaff: number;
    pendingActivation: number;
    locked: number;
    staffWithoutTwoStep: number;
    patientAccounts: number;
    admins: number;
  };
  revenue: {
    currency: string;
    mrrCents: number;
    openCents: number;
    overdueCents: number;
    overdueCount: number;
  };
  renewals: {
    subscriptionId: string;
    facilityId: string;
    facilityName: string;
    planName: string;
    status: SubscriptionStatus;
    date: string;
    cancelAtPeriodEnd: boolean;
    priceCents: number;
    billingCycle: 'MONTHLY' | 'YEARLY';
    /** A change of billing cycle the next period applies, with its price. */
    nextBillingCycle: 'MONTHLY' | 'YEARLY' | null;
    nextPriceCents: number | null;
    currency: string;
  }[];
  recentEvents: {
    id: string;
    type: string;
    facilityId: string;
    facilityName: string;
    fromStatus: SubscriptionStatus | null;
    toStatus: SubscriptionStatus | null;
    note: string | null;
    actorName: string | null;
    createdAt: string;
  }[];
  recentActions: AuditItem[];
}

export interface LegalDocumentSummary {
  id: string;
  kind: LegalKind;
  version: string;
  locale: LegalLocale;
  title: string;
  requiresAcceptance: boolean;
  publishedAt: string | null;
  /** Published with its text as written (placeholders) kept beside the filled-in text. */
  hasSource: boolean;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
}

export interface LegalDocumentFull extends Omit<
  LegalDocumentSummary,
  'createdByName' | 'hasSource'
> {
  body: string;
  /** A published text as written, with its {placeholders}; null for drafts and older texts. */
  titleSource: string | null;
  bodySource: string | null;
}

export interface LegalAdminList {
  documents: LegalDocumentSummary[];
  current: Record<LegalKind, string | null>;
  acceptance: { kind: LegalKind; version: string; accepted: number }[];
  activeAccounts: number;
  missingSettings: string[];
}

export interface AcceptanceStats {
  kind: LegalKind;
  version: string;
  accepted: number;
  activeAccounts: number;
  /** userName is null for patient accounts: they are listed by role and time only. */
  latest: { id: string; userName: string | null; role: Role; locale: string; acceptedAt: string }[];
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/* ------------------------------------------------------------------ helpers ----------------- */

/** Money in cents, e.g. "1.490,00 €" in the reader's language. */
export const formatMoney = (cents: number, currency = 'EUR') =>
  new Intl.NumberFormat(intlLocale(), { style: 'currency', currency }).format(cents / 100);

/** The public page of a text (/privacy itself is the directors' data protection workspace). */
export const kindPath = (kind: LegalKind) => (kind === 'TERMS' ? '/legal/terms' : '/legal/privacy');

/* ------------------------------------------------------------------ public + signed-in ------- */

export const PLATFORM_KEY = ['platform'] as const;
export const LEGAL_STATUS_KEY = ['legal', 'status'] as const;

/**
 * Operator details and the notice to all users (public). Workstations stay signed in for a whole
 * shift: the notice is asked for again every few minutes and when the window gets focus, so a
 * maintenance notice set during the day reaches them.
 */
export function usePlatformInfo() {
  return useQuery({
    queryKey: [...PLATFORM_KEY, 'info'],
    queryFn: () => api<PlatformInfo>('/platform/info'),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
}

/** The current published terms of use or privacy notice in a language (public). */
export function useLegalDocument(kind: LegalKind, locale: string) {
  return useQuery({
    queryKey: ['legal', 'document', kind, locale],
    queryFn: () =>
      api<PublicLegalDocument>(`/legal/${kind === 'TERMS' ? 'terms' : 'privacy'}`, {
        query: { locale },
      }),
    retry: false,
  });
}

/** Versions the signed-in user still has to accept. */
export function useLegalStatus(userId: string | undefined, locale: string) {
  return useQuery({
    queryKey: [...LEGAL_STATUS_KEY, userId, locale],
    queryFn: () => api<{ pending: LegalText[] }>('/legal/status', { query: { locale } }),
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
    // Switching the language keeps the text on screen until its translation arrives.
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * How long recording an acceptance may take before the gate offers to continue without it: a
 * request that hangs (a database lock, a stalled connection) must not hold a clinician at the
 * gate until a proxy gives up.
 */
export const ACCEPT_TIMEOUT_MS = 10_000;

export function useAcceptLegal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { kind: LegalKind; version: string }) =>
      api<{ accepted: true; pending: LegalText[] }>('/legal/accept', {
        method: 'POST',
        body: v,
        timeoutMs: ACCEPT_TIMEOUT_MS,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: LEGAL_STATUS_KEY }),
    onError: (err) => {
      // A newer version was published meanwhile: show it at once instead of asking for a reload.
      if (err instanceof ApiError && err.status === 409) {
        void qc.invalidateQueries({ queryKey: LEGAL_STATUS_KEY });
      }
    },
  });
}

/* ------------------------------------------------------------------ administrator ----------- */

export const ADMIN_PLATFORM_KEY = ['admin', 'platform'] as const;

export function useAdminOverview() {
  return useQuery({
    queryKey: [...ADMIN_PLATFORM_KEY, 'overview'],
    queryFn: () => api<AdminOverview>('/admin/overview'),
    refetchInterval: 60_000,
  });
}

export function useAdminSettings() {
  return useQuery({
    queryKey: [...ADMIN_PLATFORM_KEY, 'settings'],
    queryFn: () => api<PlatformSettings>('/admin/settings'),
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<PlatformSettings>) =>
      api<PlatformSettings>('/admin/settings', { method: 'PUT', body }),
    onSuccess: (data) => {
      qc.setQueryData([...ADMIN_PLATFORM_KEY, 'settings'], data);
      void qc.invalidateQueries({ queryKey: PLATFORM_KEY });
      void qc.invalidateQueries({ queryKey: [...ADMIN_PLATFORM_KEY, 'legal'] });
    },
  });
}

export function useLegalAdmin() {
  return useQuery({
    queryKey: [...ADMIN_PLATFORM_KEY, 'legal'],
    queryFn: () => api<LegalAdminList>('/admin/legal'),
  });
}

export function useLegalDocumentAdmin(id: string | null) {
  return useQuery({
    queryKey: [...ADMIN_PLATFORM_KEY, 'legal', 'doc', id],
    queryFn: () => api<LegalDocumentFull>(`/admin/legal/${id}`),
    enabled: Boolean(id),
  });
}

export function useAcceptanceStats(kind: LegalKind, version: string | null) {
  return useQuery({
    queryKey: [...ADMIN_PLATFORM_KEY, 'legal', 'acceptances', kind, version],
    queryFn: () =>
      api<AcceptanceStats>('/admin/legal/acceptances', { query: { kind, version: version! } }),
    enabled: Boolean(version),
  });
}

export const fetchTemplate = (kind: LegalKind, locale: LegalLocale) =>
  api<{ kind: LegalKind; locale: LegalLocale; title: string; body: string }>(
    '/admin/legal/templates',
    { query: { kind, locale } },
  );

/** Create, edit, delete and publish legal documents; refreshes the list and the gate. */
export function useLegalMutation<TVars>(
  request: (vars: TVars) => {
    path: string;
    method: 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
  },
  onDone?: () => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => {
      const { path, ...opts } = request(vars);
      return api<LegalDocumentFull | undefined>(path, opts);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...ADMIN_PLATFORM_KEY, 'legal'] });
      void qc.invalidateQueries({ queryKey: ['legal'] });
      onDone?.();
    },
  });
}

export function useAdminAudit(category: string, page: number) {
  return useQuery({
    queryKey: [...ADMIN_PLATFORM_KEY, 'audit', category, page],
    queryFn: () =>
      api<Paged<AuditItem>>('/admin/audit', { query: { category, page, pageSize: 25 } }),
  });
}
