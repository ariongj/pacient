import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/** API client and types for patient complaints and anonymous feedback. */

export type ComplaintCategory =
  | 'CARE_QUALITY'
  | 'COMMUNICATION'
  | 'WAITING_TIME'
  | 'STAFF_ATTITUDE'
  | 'BILLING'
  | 'PRIVACY'
  | 'FACILITIES'
  | 'OTHER';
export type ComplaintChannel = 'PORTAL' | 'IN_PERSON' | 'PHONE' | 'LETTER';
export type ComplaintStatus =
  'RECEIVED' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'RESPONDED' | 'CLOSED' | 'ESCALATED';
export type ResponseOutcome = 'UPHELD' | 'PARTLY_UPHELD' | 'NOT_UPHELD';
export type ComplaintOutcome = ResponseOutcome | 'WITHDRAWN';
export type FeedbackSetting = 'OUTPATIENT' | 'INPATIENT' | 'EMERGENCY' | 'VIDEO';
export type FeedbackItem = 'waiting' | 'communication' | 'cleanliness' | 'respect' | 'explanation';

export const COMPLAINT_CATEGORIES: ComplaintCategory[] = [
  'CARE_QUALITY',
  'COMMUNICATION',
  'WAITING_TIME',
  'STAFF_ATTITUDE',
  'BILLING',
  'PRIVACY',
  'FACILITIES',
  'OTHER',
];
export const RESPONSE_OUTCOMES: ResponseOutcome[] = ['UPHELD', 'PARTLY_UPHELD', 'NOT_UPHELD'];
export const FEEDBACK_ITEMS: FeedbackItem[] = [
  'waiting',
  'communication',
  'cleanliness',
  'respect',
  'explanation',
];

export interface ComplaintsMeta {
  smallCellThreshold: number;
  staff: { id: string; fullName: string; role: string }[];
  canRecord: boolean;
  canManage: boolean;
  isMinistry: boolean;
}

interface Timing {
  acknowledgeOverdue: boolean;
  responseOverdue: boolean;
  escalateUntil: string | null;
  canEscalate: boolean;
  canWithdraw: boolean;
}

export interface ComplaintSummary extends Timing {
  id: string;
  reference: string;
  facilityName: string;
  channel: ComplaintChannel;
  category: ComplaintCategory;
  status: ComplaintStatus;
  createdAt: string;
  acknowledgeDueAt: string;
  responseDueAt: string;
  acknowledgedAt: string | null;
  respondedAt: string | null;
  outcome: ComplaintOutcome | null;
  escalatedAt: string | null;
  ministryDecided: boolean;
  assignedTo: string | null;
}

export interface ComplaintDetail extends Timing {
  id: string;
  reference: string;
  facilityName: string | null;
  patientName: string | null;
  patientNationalId: string | null;
  patientPhone: string | null;
  submittedBy: string | null;
  channel: ComplaintChannel;
  category: ComplaintCategory;
  description: string;
  desiredOutcome: string | null;
  status: ComplaintStatus;
  assignedToId: string | null;
  assignedTo: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgeDueAt: string;
  responseDueAt: string;
  response: string | null;
  respondedAt: string | null;
  respondedBy: string | null;
  outcome: ComplaintOutcome | null;
  escalatedAt: string | null;
  escalationReason: string | null;
  ministryDecision: string | null;
  closedAt: string | null;
  hadRecentCare: boolean;
  access?: 'director' | 'assignee' | 'ministry';
}

export interface PortalComplaint {
  id: string;
  reference: string;
  facilityName: string;
  channel: ComplaintChannel;
  category: ComplaintCategory;
  description: string;
  desiredOutcome: string | null;
  status: ComplaintStatus;
  createdAt: string;
  acknowledgedAt: string | null;
  responseDueAt: string;
  response: string | null;
  respondedAt: string | null;
  outcome: ComplaintOutcome | null;
  escalatedAt: string | null;
  escalationReason: string | null;
  ministryDecision: string | null;
  closedAt: string | null;
  canEscalate: boolean;
  escalateUntil: string | null;
  canWithdraw: boolean;
}

export interface CountCell {
  key: string;
  label: string | null;
  count: number | null;
  suppressed: boolean;
}

export interface ComplaintDashboard {
  months: number;
  smallCellThreshold: number;
  open: number;
  escalatedPending: number;
  timeliness: {
    acknowledgedOnTimePct: number | null;
    acknowledgementsDue: number;
    respondedOnTimePct: number | null;
    responsesDue: number;
  };
  byCategory: CountCell[];
  byStatus: CountCell[];
  byOutcome: CountCell[];
  byMonth: CountCell[];
  byFacility: CountCell[];
  overdue: (Timing & {
    id: string;
    reference: string;
    category: ComplaintCategory;
    status: ComplaintStatus;
    acknowledgeDueAt: string;
    responseDueAt: string;
    acknowledgedAt: string | null;
    respondedAt: string | null;
  })[];
}

export interface FeedbackGroup {
  key: string;
  label?: string;
  responses: number | null;
  overall: number | null;
  items: Record<FeedbackItem, number | null>;
  recommendPct: number | null;
  suppressed: boolean;
}

export interface FeedbackDashboard {
  months: number;
  smallCellThreshold: number;
  overall: FeedbackGroup | null;
  byMonth: FeedbackGroup[];
  bySetting: FeedbackGroup[];
  byUnit: FeedbackGroup[];
  byFacility: FeedbackGroup[];
  comments: { month: string; setting: FeedbackSetting; overall: number; comment: string }[];
}

export interface RateableVisit {
  setting: FeedbackSetting;
  visitId: string;
  facilityName: string;
  unitName: string | null;
  endedAt: string;
}

/* ------------------------------------------------------------------------------ labels -- */

export function categoryLabel(c: ComplaintCategory): string {
  return {
    CARE_QUALITY: t('Quality of care'),
    COMMUNICATION: t('Communication and information'),
    WAITING_TIME: t('Waiting times'),
    STAFF_ATTITUDE: t('Staff attitude'),
    BILLING: t('Billing and payments'),
    PRIVACY: t('Privacy and confidentiality'),
    FACILITIES: t('Buildings and cleanliness'),
    OTHER: t('Something else'),
  }[c];
}

export function channelLabel(c: ComplaintChannel): string {
  return {
    PORTAL: t('Online (portal)'),
    IN_PERSON: t('In person'),
    PHONE: t('By phone'),
    LETTER: t('By letter'),
  }[c];
}

export function complaintStatusLabel(s: ComplaintStatus): string {
  return {
    RECEIVED: t('Received|complaint'),
    ACKNOWLEDGED: t('Acknowledged|complaint'),
    INVESTIGATING: t('Being investigated'),
    RESPONDED: t('Answered|complaint'),
    CLOSED: t('Closed|complaint'),
    ESCALATED: t('With the Ministry'),
  }[s];
}

export function complaintStatusTone(
  s: ComplaintStatus,
): 'info' | 'success' | 'warning' | 'danger' | 'neutral' {
  if (s === 'RECEIVED') return 'warning';
  if (s === 'ACKNOWLEDGED' || s === 'INVESTIGATING') return 'info';
  if (s === 'RESPONDED') return 'success';
  if (s === 'ESCALATED') return 'danger';
  return 'neutral';
}

export function outcomeLabel(o: ComplaintOutcome | 'NONE'): string {
  return {
    UPHELD: t('Upheld'),
    PARTLY_UPHELD: t('Partly upheld'),
    NOT_UPHELD: t('Not upheld'),
    WITHDRAWN: t('Withdrawn by the complainant'),
    NONE: t('No outcome yet'),
  }[o];
}

export function settingLabel(s: FeedbackSetting): string {
  return {
    OUTPATIENT: t('Outpatient visit'),
    INPATIENT: t('Hospital stay'),
    EMERGENCY: t('Emergency department'),
    VIDEO: t('Video visit'),
  }[s];
}

export function feedbackItemLabel(i: FeedbackItem): string {
  return {
    waiting: t('Waiting time'),
    communication: t('How staff talked with you'),
    cleanliness: t('Cleanliness'),
    respect: t('Respect and dignity'),
    explanation: t('Explanation of care and treatment'),
  }[i];
}

/* ------------------------------------------------------------------------------- hooks -- */

const KEY = ['complaints'] as const;

export function useComplaintsMeta() {
  return useQuery({
    queryKey: [...KEY, 'meta'],
    queryFn: () => api<ComplaintsMeta>('/complaints/meta'),
  });
}

export function useComplaints(query: Record<string, string | number | undefined>) {
  return useQuery({
    queryKey: [...KEY, 'list', query],
    queryFn: () =>
      api<{ items: ComplaintSummary[]; page: number; totalPages: number; total: number }>(
        '/complaints',
        { query },
      ),
  });
}

export function useComplaint(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'detail', id],
    queryFn: () => api<ComplaintDetail>(`/complaints/${id}`),
    enabled: Boolean(id),
  });
}

export function useComplaintDashboard(months: number) {
  return useQuery({
    queryKey: [...KEY, 'dashboard', months],
    queryFn: () => api<ComplaintDashboard>('/complaints/dashboard', { query: { months } }),
  });
}

export function useFeedbackDashboard(months: number) {
  return useQuery({
    queryKey: [...KEY, 'feedback-dashboard', months],
    queryFn: () => api<FeedbackDashboard>('/complaints/feedback/dashboard', { query: { months } }),
  });
}

/** Complaint actions (staff and Ministry): POST /complaints/:id/<action>. */
export function useComplaintAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, body }: { action: string; body?: unknown }) =>
      api<ComplaintDetail>(`/complaints/${id}/${action}`, { method: 'POST', body: body ?? {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRecordComplaint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ComplaintDetail>('/complaints', { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/* ------------------------------------------------------------------------------ portal -- */

export function usePortalFacilities() {
  return useQuery({
    queryKey: [...KEY, 'portal', 'facilities'],
    queryFn: () =>
      api<{ items: { id: string; name: string; municipality: string | null; visited: boolean }[] }>(
        '/complaints/portal/facilities',
      ),
  });
}

export function useMyComplaints() {
  return useQuery({
    queryKey: [...KEY, 'portal', 'mine'],
    queryFn: () => api<{ items: PortalComplaint[] }>('/complaints/portal'),
  });
}

export function useSubmitComplaint() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{
        id: string;
        reference: string;
        acknowledgeDueAt: string;
        responseDueAt: string;
        hadRecentCare: boolean;
      }>('/complaints/portal', { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function usePortalComplaintAction(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action, body }: { action: 'escalate' | 'withdraw'; body?: unknown }) =>
      api<PortalComplaint>(`/complaints/portal/${id}/${action}`, {
        method: 'POST',
        body: body ?? {},
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRateableVisits() {
  return useQuery({
    queryKey: [...KEY, 'portal', 'rateable'],
    queryFn: () => api<{ items: RateableVisit[] }>('/complaints/feedback/eligible'),
  });
}

export function useSubmitFeedback() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ ok: true }>('/complaints/feedback', { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY, 'portal', 'rateable'] }),
  });
}
