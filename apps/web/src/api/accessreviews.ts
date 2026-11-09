import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api, downloadFile } from './client';
import type { Tone } from '../components/ui';
import type { Role } from './types';

/** API client and types for access reviews (periodic recertification of staff accounts). */

export type ReviewStatus = 'OPEN' | 'COMPLETED';
export type Decision = 'KEEP' | 'CHANGE' | 'REVOKE';
export type ReviewFlag =
  'DORMANT' | 'NEVER_SIGNED_IN' | 'LICENCE_INVALID' | 'NO_TWO_STEP' | 'FREQUENT_EMERGENCY_ACCESS';

export interface ReviewMeta {
  currentPeriod: string;
  currentDueDate: string;
  reviewDays: number;
  scope: 'FACILITY' | 'MINISTRY';
  facilityRoles: Role[];
}

export interface ReviewSummary {
  id: string;
  facilityId: string | null;
  facilityName: string | null;
  scope: 'FACILITY' | 'MINISTRY';
  period: string;
  status: ReviewStatus;
  dueDate: string;
  openedAt: string;
  completedAt: string | null;
  overdue: boolean;
  total: number;
  decided: number;
  revoked: number;
}

export interface AccountSnapshot {
  fullName: string;
  email: string;
  role: Role;
  facilityId: string | null;
  facilityName: string | null;
  specialty: string | null;
  units: string[];
  createdAt: string;
  lastLoginAt: string | null;
  twoStep: boolean;
  licence: string | null;
  emergencyAccessCount: number;
  flags: ReviewFlag[];
}

export interface ReviewItem {
  id: string;
  userId: string;
  snapshot: AccountSnapshot;
  decision: Decision | null;
  note: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  current: { isActive: boolean; role: Role; facilityId: string | null };
  isMe: boolean;
}

export interface ReviewDetail extends ReviewSummary {
  canDecide: boolean;
  canComplete: boolean;
  items: ReviewItem[];
}

export interface ComplianceRow {
  facilityId: string;
  facilityName: string;
  municipality: string | null;
  directors: number;
  reviewId: string | null;
  status: ReviewStatus | 'NOT_OPENED';
  dueDate: string | null;
  overdue: boolean;
  total: number;
  decided: number;
  revoked: number;
}

export interface Compliance {
  period: string;
  ministry: ReviewSummary | null;
  summary: {
    facilities: number;
    completed: number;
    overdue: number;
    notOpened: number;
    revoked: number;
  };
  items: ComplianceRow[];
}

/* ------------------------------------------------------------------------------ labels -- */

export const flagLabel = (f: ReviewFlag) =>
  ({
    DORMANT: t('No sign-in for 90 days'),
    NEVER_SIGNED_IN: t('Never signed in'),
    LICENCE_INVALID: t('Licence not valid'),
    NO_TWO_STEP: t('No two-step sign-in'),
    FREQUENT_EMERGENCY_ACCESS: t('Frequent emergency access'),
  })[f];

/** Serious flags call for a closer look; a missing two-step sign-in is a reminder only. */
export const flagTone = (f: ReviewFlag): Tone =>
  f === 'NO_TWO_STEP'
    ? 'neutral'
    : f === 'LICENCE_INVALID' || f === 'DORMANT'
      ? 'danger'
      : 'warning';

export const decisionLabel = (d: Decision) =>
  ({ KEEP: t('Keep'), CHANGE: t('Change needed'), REVOKE: t('Revoke') })[d];

export const decisionTone = (d: Decision): Tone =>
  d === 'KEEP' ? 'success' : d === 'CHANGE' ? 'warning' : 'danger';

export const licenceLabel = (l: string | null) =>
  l === null
    ? t('Not required')
    : ({
        VALID: t('Valid|licence'),
        EXPIRED: t('Expired|licence'),
        SUSPENDED: t('Suspended|licence'),
        REVOKED: t('Revoked|licence'),
        MISSING: t('No licence on record'),
      }[l] ?? l);

export const reviewStatusLabel = (s: ReviewStatus | 'NOT_OPENED', overdue = false) =>
  s === 'COMPLETED'
    ? t('Completed|review')
    : s === 'NOT_OPENED'
      ? t('Not opened')
      : overdue
        ? t('Overdue|review')
        : t('Open|review');

export const reviewStatusTone = (s: ReviewStatus | 'NOT_OPENED', overdue = false): Tone =>
  s === 'COMPLETED' ? 'success' : s === 'NOT_OPENED' || overdue ? 'danger' : 'info';

/* ------------------------------------------------------------------------------- hooks -- */

const KEY = ['access-reviews'] as const;

export function useReviewMeta() {
  return useQuery({
    queryKey: [...KEY, 'meta'],
    queryFn: () => api<ReviewMeta>('/access-reviews/meta'),
  });
}

export function useReviews() {
  return useQuery({
    queryKey: [...KEY, 'list'],
    queryFn: () => api<{ items: ReviewSummary[] }>('/access-reviews').then((r) => r.items),
  });
}

export function useReview(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'review', id],
    queryFn: () => api<ReviewDetail>(`/access-reviews/${id}`),
    enabled: Boolean(id),
  });
}

export function useCompliance(period: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'compliance', period],
    queryFn: () =>
      api<Compliance>('/access-reviews/compliance', { query: { period: period ?? undefined } }),
    enabled,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: KEY });
}

export function useOpenReview() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: () => api<ReviewSummary>('/access-reviews/open', { method: 'POST' }),
    onSuccess: done,
  });
}

export function useDecide(reviewId: string) {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ itemId, ...body }: { itemId: string; decision: Decision; note?: string }) =>
      api<{ id: string; decision: Decision; deactivated: boolean }>(
        `/access-reviews/${reviewId}/items/${itemId}/decision`,
        { method: 'POST', body },
      ),
    onSuccess: done,
  });
}

export function useCompleteReview(reviewId: string) {
  const done = useInvalidate();
  return useMutation({
    mutationFn: () =>
      api<ReviewSummary>(`/access-reviews/${reviewId}/complete`, { method: 'POST' }),
    onSuccess: done,
  });
}

export const downloadAttestation = (r: Pick<ReviewSummary, 'id' | 'period'>) =>
  downloadFile(`/access-reviews/${r.id}/export.csv`, `pacient-access-review-${r.period}.csv`);
