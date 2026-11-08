import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/**
 * Mental health safeguards: the legal steps of an involuntary admission and restrictive
 * interventions (restraint, seclusion, rapid tranquillisation). Time limits are illustrative until
 * confirmed by legal counsel and the Ministry.
 */
export const GROUNDS = ['DANGER_TO_SELF', 'DANGER_TO_OTHERS', 'SEVERE_SELF_NEGLECT'] as const;
export type Ground = (typeof GROUNDS)[number];

export const RESTRICTIVE_KINDS = [
  'PHYSICAL_RESTRAINT',
  'MECHANICAL_RESTRAINT',
  'SECLUSION',
  'RAPID_TRANQUILLISATION',
] as const;
export type RestrictiveKind = (typeof RESTRICTIVE_KINDS)[number];

export const END_REASONS = ['DISCHARGED', 'BECAME_VOLUNTARY', 'TRANSFERRED', 'OTHER'] as const;
export type EndReason = (typeof END_REASONS)[number];

export type LegalStep =
  | 'SECOND_OPINION'
  | 'RIGHTS_EXPLAINED'
  | 'REPRESENTATIVE_NOTIFIED'
  | 'COURT_NOTIFIED'
  | 'COURT_DECISION'
  | 'AUTHORISATION_REVIEW';
export type StepStatus = 'DONE' | 'PENDING' | 'DUE_SOON' | 'OVERDUE' | 'NOT_APPLICABLE';

export interface StepState {
  step: LegalStep;
  dueAt: string | null;
  doneAt: string | null;
  status: StepStatus;
}

export interface Involuntary {
  id: string;
  patientId: string;
  admissionId: string;
  status: 'ACTIVE' | 'ENDED' | 'RELEASED';
  grounds: Ground[];
  assessment: string;
  startedAt: string;
  decidedBy: string | null;
  decidedById: string;
  secondOpinion: { at: string; by: string | null; confirms: boolean | null } | null;
  court: {
    notifiedAt: string | null;
    reference: string | null;
    decisionAt: string | null;
    decision: 'CONFIRMED' | 'REJECTED' | null;
    authorisedUntil: string | null;
  };
  rightsExplainedAt: string | null;
  representative: { name: string | null; notifiedAt: string | null };
  endedAt: string | null;
  endReason: string | null;
  steps: StepState[];
  overdueSteps: LegalStep[];
}

export interface Observation {
  at: string;
  by: string | null;
  note: string | null;
  vitalsChecked: boolean;
  administrationId: string | null;
}

export interface Restrictive {
  id: string;
  patientId: string;
  admissionId: string | null;
  kind: RestrictiveKind;
  reason: string;
  startedAt: string;
  endedAt: string | null;
  orderedBy: string | null;
  observations: Observation[];
  injuries: string | null;
  debriefAt: string | null;
  debriefNote: string | null;
  durationMinutes: number | null;
  lastObservationAt: string | null;
  nextObservationDueAt: string | null;
  observationOverdue: boolean;
  debriefDueAt: string | null;
  debriefOverdue: boolean;
}

export interface BoardPatient {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  temporaryIdentity: string | null;
  unitName: string | null;
  bedLabel: string | null;
}

export interface MentalHealthBoard {
  involuntary: (Involuntary & { patient: BoardPatient | null })[];
  restrictive: (Restrictive & { patient: BoardPatient | null })[];
  counts: {
    involuntary: number;
    overdueLegalSteps: number;
    restrictiveActive: number;
    observationOverdue: number;
    debriefOverdue: number;
  };
  observationIntervalMinutes: number;
  debriefHours: number;
}

export interface RecentAdministration {
  id: string;
  medication: string;
  doseGiven: string | null;
  route: string;
  administeredAt: string;
}

export interface PatientMentalHealth {
  involuntary: Involuntary[];
  restrictive: Restrictive[];
  admission: {
    id: string;
    unitName: string;
    unitType: string;
    bedLabel: string | null;
    admittedAt: string;
  } | null;
  canStartInvoluntary: boolean;
  canStartRestrictive: boolean;
  /** Medicines given in the last 24 hours (rapid tranquillisation can refer to one). */
  recentAdministrations: RecentAdministration[];
  maxAuthorisationDays: number;
  observationIntervalMinutes: number;
}

export interface Oversight {
  involuntary: {
    id: string;
    patient: { firstName: string; lastName: string };
    unitName: string;
    startedAt: string;
    decidedBy: string | null;
    courtDecision: 'CONFIRMED' | 'REJECTED' | null;
    authorisedUntil: string | null;
    steps: StepState[];
    overdueSteps: LegalStep[];
  }[];
  overdueLegalSteps: number;
  restrictiveLast30Days: Record<RestrictiveKind, number>;
  restrictiveActive: number;
  debriefOverdue: number;
}

export interface MentalHealthStats {
  facilities: {
    facilityId: string;
    facilityName: string;
    involuntary: number | null;
    courtOnTimePct: number | null;
    restrictive: {
      restraint: number | null;
      seclusion: number | null;
      rapidTranquillisation: number | null;
      total: number | null;
    };
    per1000BedDays: {
      restraint: number | null;
      seclusion: number | null;
      rapidTranquillisation: number | null;
    };
    medianDurationMinutes: number | null;
  }[];
  months: { month: string; involuntary: number | null; restrictive: number | null }[];
  smallCellThreshold: number;
}

/* ------------------------------------------------------------------ queries --------------- */

export const useMentalHealthBoard = () =>
  useQuery({
    queryKey: ['mentalhealth', 'board'],
    queryFn: () => api<MentalHealthBoard>('/mental-health/board'),
    refetchInterval: 60_000,
  });

export const usePatientMentalHealth = (patientId: string) =>
  useQuery({
    queryKey: ['patient', patientId, 'mentalhealth'],
    queryFn: () => api<PatientMentalHealth>(`/mental-health/patients/${patientId}`),
    refetchInterval: 60_000,
    retry: false,
  });

export const useOversight = () =>
  useQuery({
    queryKey: ['mentalhealth', 'oversight'],
    queryFn: () => api<Oversight>('/mental-health/oversight'),
    refetchInterval: 5 * 60_000,
  });

export const useMentalHealthStats = () =>
  useQuery({
    queryKey: ['mentalhealth', 'stats'],
    queryFn: () => api<MentalHealthStats>('/mental-health/stats'),
  });

/* ------------------------------------------------------------------ mutations ------------- */

function useDone(patientId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['mentalhealth'] });
    void qc.invalidateQueries({ queryKey: ['patient', patientId, 'mentalhealth'] });
  };
}

export interface StartInvoluntaryInput {
  grounds: Ground[];
  assessment: string;
  startedAt?: string;
}

export function useStartInvoluntary(patientId: string) {
  const done = useDone(patientId);
  return useMutation({
    mutationFn: (body: StartInvoluntaryInput) =>
      api<Involuntary>(`/mental-health/patients/${patientId}/involuntary`, {
        method: 'POST',
        body,
      }),
    onSuccess: done,
  });
}

export type InvoluntaryAction =
  | { path: 'second-opinion'; body: { confirms: boolean; staysVoluntarily?: boolean; at?: string } }
  | { path: 'rights'; body: { at?: string } }
  | { path: 'representative'; body: { name: string; at?: string } }
  | { path: 'court-notification'; body: { reference: string; at?: string } }
  | {
      path: 'court-decision';
      body: { decision: 'CONFIRMED' | 'REJECTED'; authorisedUntil?: string; at?: string };
    }
  | { path: 'authorisation'; body: { authorisedUntil: string; reference?: string; at?: string } }
  | { path: 'end'; body: { reason: EndReason; note?: string; at?: string } };

export function useInvoluntaryAction(patientId: string) {
  const done = useDone(patientId);
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: InvoluntaryAction }) =>
      api<Involuntary>(`/mental-health/involuntary/${id}/${action.path}`, {
        method: 'POST',
        body: action.body,
      }),
    onSuccess: done,
  });
}

export interface StartRestrictiveInput {
  kind: RestrictiveKind;
  reason: string;
  startedAt?: string;
  medicationAdministrationId?: string;
}

export function useStartRestrictive(patientId: string) {
  const done = useDone(patientId);
  return useMutation({
    mutationFn: (body: StartRestrictiveInput) =>
      api<Restrictive>(`/mental-health/patients/${patientId}/restrictive`, {
        method: 'POST',
        body,
      }),
    onSuccess: done,
  });
}

export type RestrictiveAction =
  | { path: 'observations'; body: { note: string; vitalsChecked: boolean; at?: string } }
  | { path: 'end'; body: { injuries?: string | null; at?: string } }
  | { path: 'debrief'; body: { note: string; at?: string } };

export function useRestrictiveAction(patientId: string) {
  const done = useDone(patientId);
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: RestrictiveAction }) =>
      api<Restrictive>(`/mental-health/restrictive/${id}/${action.path}`, {
        method: 'POST',
        body: action.body,
      }),
    onSuccess: done,
  });
}

/* ------------------------------------------------------------------ labels ---------------- */

export function groundLabel(g: Ground): string {
  switch (g) {
    case 'DANGER_TO_SELF':
      return t('Serious risk to their own life or health');
    case 'DANGER_TO_OTHERS':
      return t('Serious risk to the life or health of others');
    case 'SEVERE_SELF_NEGLECT':
      return t('Unable to care for themselves, with serious harm likely');
  }
}

export function kindLabel(k: RestrictiveKind): string {
  switch (k) {
    case 'PHYSICAL_RESTRAINT':
      return t('Physical restraint');
    case 'MECHANICAL_RESTRAINT':
      return t('Mechanical restraint');
    case 'SECLUSION':
      return t('Seclusion');
    case 'RAPID_TRANQUILLISATION':
      return t('Rapid tranquillisation');
  }
}

export function stepLabel(s: LegalStep): string {
  switch (s) {
    case 'SECOND_OPINION':
      return t('Independent second examination');
    case 'RIGHTS_EXPLAINED':
      return t('Rights explained to the patient');
    case 'REPRESENTATIVE_NOTIFIED':
      return t('Representative or family informed');
    case 'COURT_NOTIFIED':
      return t('Court notified');
    case 'COURT_DECISION':
      return t('Court decision');
    case 'AUTHORISATION_REVIEW':
      return t('Review before the authorisation ends');
  }
}

export function stepStatusLabel(s: StepStatus): string {
  switch (s) {
    case 'DONE':
      return t('Done');
    case 'PENDING':
      return t('Pending');
    case 'DUE_SOON':
      return t('Due soon');
    case 'OVERDUE':
      return t('Overdue');
    case 'NOT_APPLICABLE':
      return t('Not applicable');
  }
}

export const stepTone = (s: StepStatus) =>
  s === 'OVERDUE'
    ? ('danger' as const)
    : s === 'DUE_SOON'
      ? ('warning' as const)
      : s === 'DONE'
        ? ('success' as const)
        : ('neutral' as const);

export function endReasonLabel(r: string | null): string {
  if (!r) return '—';
  const [code, ...rest] = r.split(': ');
  const note = rest.join(': ');
  const label = (() => {
    switch (code) {
      case 'DISCHARGED':
        return t('Discharged');
      case 'BECAME_VOLUNTARY':
        return t('Stays as a voluntary patient');
      case 'TRANSFERRED':
        return t('Transferred');
      case 'NOT_CONFIRMED':
        return t('Not confirmed by the second examination');
      case 'COURT_REJECTED':
        return t('Not authorised by the court');
      case 'OTHER':
        return t('Other reason');
      default:
        return code ?? '';
    }
  })();
  return note ? `${label}: ${note}` : label;
}

export function involuntaryStatusLabel(s: Involuntary['status']): string {
  switch (s) {
    case 'ACTIVE':
      return t('In force');
    case 'ENDED':
      return t('Ended');
    case 'RELEASED':
      return t('Released');
  }
}
