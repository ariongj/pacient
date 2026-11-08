import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/** API client and types for elective waiting lists. */

export type WaitingPriority = 'URGENT' | 'PRIORITY' | 'ROUTINE';
export type WaitingStatus = 'WAITING' | 'SCHEDULED' | 'SUSPENDED' | 'COMPLETED' | 'REMOVED';
export type WaitingKind = 'PROCEDURE' | 'OUTPATIENT';
export type RemovalReason =
  | 'TREATED_ELSEWHERE'
  | 'NO_LONGER_NEEDED'
  | 'PATIENT_DECLINED'
  | 'DECEASED'
  | 'DUPLICATE'
  | 'OTHER';

export interface WaitingEntry {
  id: string;
  patientId: string;
  patient?: { id: string; name: string; nationalId: string; dateOfBirth: string } | null;
  facilityId: string;
  facilityName?: string;
  specialty: string;
  kind: WaitingKind;
  procedureCode: string | null;
  procedureName: string;
  priority: WaitingPriority;
  /** Only for the treating care team (chart) and the doctor who added the entry. */
  clinicalReason?: string | null;
  referralId: string | null;
  addedById: string;
  addedByName?: string | null;
  addedAt: string;
  targetDate: string;
  status: WaitingStatus;
  scheduledFor: string | null;
  surgicalCaseId: string | null;
  appointmentId: string | null;
  suspendedDays: number;
  suspendedSince: string | null;
  removedReason: RemovalReason | null;
  completedAt: string | null;
  waitingDays: number;
  maxDays: number;
  breached: boolean;
  /** The scheduled date is later than the target date (maximum waiting time). */
  scheduledAfterTarget: boolean;
}

export interface WaitingEvent {
  id: string;
  event: string;
  details: Record<string, unknown> | null;
  reason: string | null;
  createdAt: string;
  actorName: string | null;
}

export interface WaitStats {
  count: number | null;
  medianDays: number | null;
  p90Days: number | null;
  breaches: number | null;
  suppressed: boolean;
}

export interface FacilityDashboard {
  totals: (WaitStats & { longestDays: number | null }) | null;
  bySpecialty: (WaitStats & {
    specialty: string;
    longestDays: number | null;
    urgent: number;
    scheduled: number;
    suspended: number;
  })[];
  longestWaits: WaitingEntry[];
  completedLast12Months: {
    count: number;
    medianDays: number | null;
    withinTargetPct: number | null;
  };
}

export interface NationalWaiting {
  smallCellThreshold: number;
  totals: WaitStats | null;
  bySpecialty: (WaitStats & { specialty: string })[];
  byFacility: (WaitStats & { facilityId: string; facilityName: string; specialty: string })[];
}

export interface PublicTimes {
  period: { from: string; to: string };
  smallCellThreshold: number;
  items: {
    facilityName: string;
    municipality: string | null;
    specialty: string;
    kind: WaitingKind;
    completed: number | null;
    medianDays: number | null;
    p90Days: number | null;
    suppressed: boolean;
  }[];
}

export interface MyWaitingEntry {
  id: string;
  facilityName: string;
  /** Null for guardians with appointments-only access (as are procedure, priority and reason). */
  specialty: string | null;
  kind: WaitingKind;
  procedureName: string | null;
  priority: WaitingPriority | null;
  status: WaitingStatus;
  addedAt: string;
  targetDate: string;
  scheduledFor: string | null;
  completedAt: string | null;
  removedReason: RemovalReason | null;
  waitingDays: number;
  maxDays: number;
  suspendedDays: number;
}

export interface WaitingReference {
  specialties: { code: string; label: string }[];
  priorities: { code: WaitingPriority; maxDays: number }[];
  removalReasons: { code: RemovalReason; clinical: boolean }[];
}

/* ------------------------------------------------------------------------------ labels -- */

/** Specialty labels come from the server in English and are translated here. */
export const SPECIALTY_LABELS: Record<string, string> = {
  CARDIOLOGY: 'Cardiology',
  DERMATOLOGY: 'Dermatology',
  ENDOCRINOLOGY: 'Endocrinology',
  ENT: 'Ear, nose and throat',
  GASTROENTEROLOGY: 'Gastroenterology',
  GENERAL_SURGERY: 'General surgery',
  GYNAECOLOGY: 'Gynaecology',
  NEUROLOGY: 'Neurology',
  NEUROSURGERY: 'Neurosurgery',
  OPHTHALMOLOGY: 'Ophthalmology',
  ORTHOPAEDICS: 'Orthopaedics',
  PAEDIATRIC_SURGERY: 'Paediatric surgery',
  PSYCHIATRY: 'Psychiatry',
  RHEUMATOLOGY: 'Rheumatology',
  UROLOGY: 'Urology',
  VASCULAR_SURGERY: 'Vascular surgery',
};
export const specialtyLabel = (code: string) => t(SPECIALTY_LABELS[code] ?? code);

export const priorityLabel = (p: WaitingPriority) =>
  ({ URGENT: t('Urgent'), PRIORITY: t('Priority|level'), ROUTINE: t('Routine') })[p];

export const priorityHint = (p: WaitingPriority, maxDays: number) =>
  t('{priority} – within {days} days', { priority: priorityLabel(p), days: maxDays });

export const waitingStatusLabel = (s: WaitingStatus) =>
  ({
    WAITING: t('Waiting'),
    SCHEDULED: t('Scheduled'),
    SUSPENDED: t('Postponed'),
    COMPLETED: t('Treated'),
    REMOVED: t('Removed from the list'),
  })[s];

export const kindLabel = (k: WaitingKind) =>
  k === 'PROCEDURE' ? t('Procedure or operation') : t('First specialist appointment');

export const removalLabel = (r: RemovalReason) =>
  ({
    TREATED_ELSEWHERE: t('Treated elsewhere'),
    NO_LONGER_NEEDED: t('No longer needed (clinical decision)'),
    PATIENT_DECLINED: t('Patient declined'),
    DECEASED: t('Patient died'),
    DUPLICATE: t('Duplicate entry'),
    OTHER: t('Other (clinical decision)'),
  })[r];

export const eventLabel = (e: string) =>
  ({
    ADDED: t('Added to the list'),
    SCHEDULED: t('Scheduled'),
    RESCHEDULED: t('Rescheduled'),
    UNSCHEDULED: t('Scheduled date cancelled'),
    SUSPENDED: t('Postponed at the patient’s request'),
    RESUMED: t('Resumed'),
    PRIORITY_CHANGED: t('Priority changed'),
    COMPLETED: t('Treated'),
    REMOVED: t('Removed from the list'),
    BREACH_WARNING: t('Approaching the maximum waiting time'),
  })[e] ?? e;

/* ------------------------------------------------------------------------------- hooks -- */

const KEY = ['waiting-lists'] as const;

export function useWaitingReference() {
  return useQuery({
    queryKey: [...KEY, 'reference'],
    queryFn: () => api<WaitingReference>('/waiting-lists/specialties'),
    staleTime: 60 * 60_000,
  });
}

export function useWaitingList(query: Record<string, string | number | undefined>) {
  return useQuery({
    queryKey: [...KEY, 'list', query],
    queryFn: () =>
      api<{ items: WaitingEntry[]; page: number; totalPages: number; total: number }>(
        '/waiting-lists',
        { query },
      ),
  });
}

export function useWaitingEntry(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'entry', id],
    queryFn: () => api<WaitingEntry & { events: WaitingEvent[] }>(`/waiting-lists/${id}`),
    enabled: Boolean(id),
  });
}

export function useWaitingDashboard(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'dashboard'],
    queryFn: () => api<FacilityDashboard>('/waiting-lists/dashboard'),
    enabled,
  });
}

export function useNationalWaiting(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'national'],
    queryFn: () => api<NationalWaiting>('/waiting-lists/national'),
    enabled,
  });
}

export function usePublicWaitingTimes(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'public'],
    queryFn: () => api<PublicTimes>('/waiting-lists/public/times'),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function usePatientWaiting(patientId: string) {
  return useQuery({
    queryKey: ['patient', patientId, 'waiting-lists'],
    queryFn: () =>
      api<{ items: WaitingEntry[] }>(`/waiting-lists/patients/${patientId}`).then((r) => r.items),
  });
}

/** The signed-in patient's entries (or the child's, when a guardian acts for them). */
export function useMyWaiting(patientId: string) {
  return useQuery({
    queryKey: [...KEY, 'mine', patientId],
    queryFn: () => api<{ items: MyWaitingEntry[] }>('/waiting-lists/mine').then((r) => r.items),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ['patient'] });
  };
}

export function useAddToWaitingList() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<WaitingEntry>('/waiting-lists', { method: 'POST', body }),
    onSuccess: done,
  });
}

export type WaitingAction =
  'schedule' | 'unschedule' | 'suspend' | 'resume' | 'priority' | 'complete' | 'remove';

export function useWaitingAction() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: WaitingAction;
      body?: Record<string, unknown>;
    }) => api<WaitingEntry>(`/waiting-lists/${id}/${action}`, { method: 'POST', body: body ?? {} }),
    onSuccess: done,
  });
}
