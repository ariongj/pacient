import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';
import type { Role } from './types';

/** API client and types for patient safety incident reporting. */

export type IncidentCategory =
  | 'MEDICATION'
  | 'FALL'
  | 'PRESSURE_INJURY'
  | 'IDENTIFICATION'
  | 'TRANSFUSION'
  | 'DIAGNOSTIC'
  | 'SURGICAL'
  | 'INFECTION'
  | 'EQUIPMENT'
  | 'IT_SYSTEM'
  | 'COMMUNICATION'
  | 'VIOLENCE'
  | 'OTHER';
export type HarmLevel = 'NEAR_MISS' | 'NO_HARM' | 'LOW' | 'MODERATE' | 'SEVERE' | 'DEATH';
export type IncidentStatus = 'NEW' | 'UNDER_REVIEW' | 'ACTION_PLANNED' | 'CLOSED';
export type ContributingFactor =
  | 'PATIENT'
  | 'TASK'
  | 'INDIVIDUAL'
  | 'TEAM'
  | 'ENVIRONMENT'
  | 'ORGANISATIONAL'
  | 'EQUIPMENT'
  | 'IT_SYSTEM'
  | 'COMMUNICATION'
  | 'TRAINING';

export interface IncidentMeta {
  categories: IncidentCategory[];
  harmLevels: HarmLevel[];
  statuses: IncidentStatus[];
  contributingFactors: ContributingFactor[];
  disclosureHarm: HarmLevel[];
  units: { id: string; name: string; type: string }[];
  canReport: boolean;
  canAttachPatient: boolean;
  canReview: boolean;
  canManageReviewers: boolean;
  isMinistry: boolean;
  smallCellThreshold: number;
}

export interface MyReport {
  id: string;
  reference: string;
  category: IncidentCategory;
  harm: HarmLevel;
  status: IncidentStatus;
  occurredAt: string;
  reportedAt: string;
  closedAt: string | null;
  description: string;
  lessons: string | null;
  unitName: string | null;
}

export interface QueueItem {
  id: string;
  reference: string;
  category: IncidentCategory;
  harm: HarmLevel;
  reviewedHarm: HarmLevel | null;
  status: IncidentStatus;
  occurredAt: string;
  reportedAt: string;
  anonymous: boolean;
  reporterRole: Role;
  unitName: string | null;
  reviewerName: string | null;
  hasPatient: boolean;
  openActions: number;
}

export interface IncidentAction {
  id: string;
  description: string;
  ownerId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
}

/** Full incident (reviewers). */
export interface IncidentDetail extends Omit<QueueItem, 'hasPatient' | 'openActions'> {
  viewerIsReviewer: true;
  facilityId: string;
  location: string | null;
  description: string;
  immediateAction: string | null;
  reviewerId: string | null;
  reporterName: string | null;
  contributingFactors: ContributingFactor[] | null;
  findings: string | null;
  lessons: string | null;
  hazardRef: string | null;
  patientInformedAt: string | null;
  closedAt: string | null;
  patient: { id: string; firstName: string; lastName: string; nationalId: string } | null;
  actions: IncidentAction[];
}

/** The reporter's own view of their report. */
export interface OwnReport {
  viewerIsReviewer: false;
  id: string;
  reference: string;
  category: IncidentCategory;
  harm: HarmLevel;
  status: IncidentStatus;
  occurredAt: string;
  reportedAt: string;
  closedAt: string | null;
  description: string;
  immediateAction: string | null;
  lessons: string | null;
}

export interface MyAction {
  id: string;
  description: string;
  dueDate: string | null;
  completedAt: string | null;
  incidentId: string;
  reference: string;
  category: IncidentCategory;
}

export interface Bucket {
  key: string;
  count: number;
}
export interface Cell {
  key: string;
  count: number | null;
  suppressed: boolean;
}

export interface FacilityDashboard {
  months: number;
  total: number;
  open: number;
  byCategory: Bucket[];
  byHarm: Bucket[];
  byStatus: Bucket[];
  byUnit: Bucket[];
  byMonth: Bucket[];
  timeToClose: { closed: number; medianDays: number | null; meanDays: number | null };
  overdueActions: {
    id: string;
    description: string;
    dueDate: string;
    ownerName: string | null;
    incidentId: string;
    reference: string;
  }[];
}

export interface NationalDashboard {
  months: number;
  total: number | null;
  byCategory: Cell[];
  byHarm: Cell[];
  byMonth: Cell[];
  byFacility: Cell[];
  smallCellThreshold: number;
}

export interface SystemIncident {
  id: string;
  reference: string;
  facilityName: string;
  occurredMonth: string;
  harm: HarmLevel;
  reviewedHarm: HarmLevel | null;
  status: IncidentStatus;
  hazardRef: string | null;
  contributingFactors: ContributingFactor[] | null;
  description: string | null;
  findings: string | null;
  lessons: string | null;
  closedAt: string | null;
  textWithheld?: boolean;
}

interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/* ------------------------------------------------------------------------------ labels -- */

export const categoryLabel = (c: string) =>
  t(
    {
      MEDICATION: 'Medication|incident category',
      FALL: 'Fall',
      PRESSURE_INJURY: 'Pressure injury',
      IDENTIFICATION: 'Patient identification',
      TRANSFUSION: 'Blood transfusion',
      DIAGNOSTIC: 'Diagnosis or test results',
      SURGICAL: 'Surgery or procedure',
      INFECTION: 'Infection',
      EQUIPMENT: 'Medical equipment',
      IT_SYSTEM: 'Computer system (Pacient)',
      COMMUNICATION: 'Communication or handover',
      VIOLENCE: 'Violence or aggression',
      OTHER: 'Other',
    }[c] ?? c,
  );

export const harmLabel = (h: string) =>
  t(
    {
      NEAR_MISS: 'Near miss (did not reach the patient)',
      NO_HARM: 'Reached the patient, no harm',
      LOW: 'Low harm',
      MODERATE: 'Moderate harm',
      SEVERE: 'Severe harm',
      DEATH: 'Death',
    }[h] ?? h,
  );

export const harmShort = (h: string) =>
  t(
    {
      NEAR_MISS: 'Near miss',
      NO_HARM: 'No harm',
      LOW: 'Low harm',
      MODERATE: 'Moderate harm',
      SEVERE: 'Severe harm',
      DEATH: 'Death',
    }[h] ?? h,
  );

export const harmTone = (h: string): 'neutral' | 'info' | 'warning' | 'danger' =>
  h === 'SEVERE' || h === 'DEATH'
    ? 'danger'
    : h === 'MODERATE'
      ? 'warning'
      : h === 'NEAR_MISS'
        ? 'info'
        : 'neutral';

export const statusLabel = (s: string) =>
  t(
    {
      NEW: 'New',
      UNDER_REVIEW: 'Under review',
      ACTION_PLANNED: 'Action plan agreed',
      CLOSED: 'Closed',
    }[s] ?? s,
  );

export const statusTone = (s: string): 'neutral' | 'info' | 'warning' | 'success' =>
  s === 'NEW' ? 'warning' : s === 'CLOSED' ? 'success' : 'info';

export const factorLabel = (f: string) =>
  t(
    {
      PATIENT: 'Patient factors',
      TASK: 'Task or procedure',
      INDIVIDUAL: 'Individual (staff) factors',
      TEAM: 'Team working',
      ENVIRONMENT: 'Work environment',
      ORGANISATIONAL: 'Organisation and management',
      EQUIPMENT: 'Equipment',
      IT_SYSTEM: 'Computer system',
      COMMUNICATION: 'Communication',
      TRAINING: 'Education and training',
    }[f] ?? f,
  );

/* ------------------------------------------------------------------------------ queries -- */

const KEY = ['incidents'] as const;

export function useIncidentMeta() {
  return useQuery({
    queryKey: [...KEY, 'meta'],
    queryFn: () => api<IncidentMeta>('/incidents/meta'),
    staleTime: 5 * 60_000,
  });
}

export function useMyReports(page: number, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'mine', page],
    queryFn: () => api<Page<MyReport>>('/incidents/mine', { query: { page } }),
    enabled,
  });
}

export function useMyActions(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'actions', 'mine'],
    queryFn: () => api<{ items: MyAction[] }>('/incidents/actions/mine').then((r) => r.items),
    enabled,
  });
}

export function useQueue(query: Record<string, string | number | undefined>, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'queue', query],
    queryFn: () => api<Page<QueueItem>>('/incidents', { query }),
    enabled,
  });
}

export function useIncident(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'detail', id],
    queryFn: () => api<IncidentDetail | OwnReport>(`/incidents/${id}`),
    enabled: Boolean(id),
  });
}

export function useIncidentStaff(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, 'staff'],
    queryFn: () =>
      api<{ staff: { id: string; fullName: string; role: Role }[]; reviewerIds: string[] }>(
        '/incidents/staff',
      ),
    enabled,
    staleTime: 60_000,
  });
}

export function useReviewers(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, 'reviewers'],
    queryFn: () =>
      api<{
        reviewers: { userId: string; fullName: string; role: Role }[];
        candidates: { userId: string; fullName: string; role: Role }[];
      }>('/incidents/reviewers'),
    enabled,
  });
}

export function useFacilityDashboard(months: number, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'dashboard', months],
    queryFn: () => api<FacilityDashboard>('/incidents/dashboard', { query: { months } }),
    enabled,
  });
}

export function useNationalDashboard(months: number, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'national', months],
    queryFn: () => api<NationalDashboard>('/incidents/national', { query: { months } }),
    enabled,
  });
}

export function useSystemIncidents(page: number, enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'it-system', page],
    queryFn: () => api<Page<SystemIncident>>('/incidents/national/it-system', { query: { page } }),
    enabled,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: KEY });
}

export function useReportIncident() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ id: string; reference: string; anonymous: boolean }>('/incidents', {
        method: 'POST',
        body,
      }),
    onSuccess: done,
  });
}

export function useUpdateIncident() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<unknown>(`/incidents/${id}`, { method: 'PATCH', body }),
    onSuccess: done,
  });
}

export function useAddAction() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<IncidentAction>(`/incidents/${id}/actions`, { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useUpdateAction() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<unknown>(`/incidents/actions/${id}`, { method: 'PATCH', body }),
    onSuccess: done,
  });
}

export function useSaveReviewers() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (userIds: string[]) =>
      api<unknown>('/incidents/reviewers', { method: 'PUT', body: { userIds } }),
    onSuccess: done,
  });
}
