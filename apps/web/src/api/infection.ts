import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import type { Tone } from '../components/ui';
import { api } from './client';

/** API client and types for infection prevention and antimicrobial stewardship. */

export type Precaution = 'CONTACT' | 'DROPLET' | 'AIRBORNE' | 'PROTECTIVE';
export const PRECAUTIONS: Precaution[] = ['CONTACT', 'DROPLET', 'AIRBORNE', 'PROTECTIVE'];
export type HaiType = 'CLABSI' | 'CAUTI' | 'VAP' | 'SSI' | 'CDI' | 'MRSA_BACTERAEMIA' | 'OTHER';
export const HAI_TYPES: HaiType[] = [
  'CLABSI',
  'CAUTI',
  'VAP',
  'SSI',
  'CDI',
  'MRSA_BACTERAEMIA',
  'OTHER',
];
export type HaiStatus = 'SUSPECTED' | 'CONFIRMED' | 'RULED_OUT';
export type ReviewOutcome = 'CONTINUE' | 'NARROW' | 'SWITCH_ORAL' | 'STOP';
export const REVIEW_OUTCOMES: ReviewOutcome[] = ['CONTINUE', 'NARROW', 'SWITCH_ORAL', 'STOP'];

/** Isolation shown on the bed board (the reason only for the treating team). */
export interface BoardIsolation {
  precaution: Precaution;
  reason: string | null;
}

export interface Definitions {
  precautions: { code: Precaution; guidance: string }[];
  haiTypes: { code: HaiType; label: string; criteria: string; device: string | null }[];
  restrictedAgents: { code: string; name: string; atc: string[]; intravenousOnly: boolean }[];
  reviewAfterHours: number;
  me: { infectionControl: boolean; stewardship: boolean };
  disclaimer: string;
}

export interface IsolationOrder {
  id: string;
  precaution: Precaution;
  reason: string;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  orderedBy: string;
}

export interface HaiEvent {
  id: string;
  type: HaiType;
  organism: string | null;
  onsetAt: string;
  deviceRelated: boolean;
  status: HaiStatus;
  notes: string | null;
  unitName: string | null;
  reviewedAt: string | null;
}

export interface Approval {
  id: string;
  prescriptionId: string;
  patientId: string;
  firstName: string;
  lastName: string;
  medication: string;
  dosage: string;
  frequency: string;
  route: string;
  prescriptionStatus: string;
  indication: string;
  justification: string;
  status: 'REQUESTED' | 'APPROVED' | 'DECLINED';
  requestedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  reviewDueAt: string | null;
  reviewedAt: string | null;
  reviewOutcome: ReviewOutcome | null;
  createdAt: string;
  reviewOverdue: boolean;
  reviewNeeded: boolean;
  mine: boolean;
}

export interface PatientInfection {
  activeIsolations: (IsolationOrder & { guidance: string })[];
  isolationHistory: IsolationOrder[];
  hai: HaiEvent[];
  antimicrobials: Approval[];
  infectionControl: boolean;
}

export interface IsolationListItem {
  id: string;
  patientId: string;
  firstName: string;
  lastName: string;
  temporaryIdentity: string | null;
  precaution: Precaution;
  reason: string;
  startedAt: string;
  unitName: string | null;
  bed: string | null;
  guidance: string;
}
export type IsolationList =
  | { scope: 'patients'; items: IsolationListItem[] }
  | {
      scope: 'counts';
      units: { unit: string; byPrecaution: Partial<Record<Precaution, number>> }[];
    };

export interface HaiListItem {
  id: string;
  patientId: string;
  firstName: string;
  lastName: string;
  type: HaiType;
  organism: string | null;
  onsetAt: string;
  deviceRelated: boolean;
  status: HaiStatus;
  unitName: string | null;
  reportedBy: string;
}

export interface Suggestion {
  labResultId: string;
  patientId: string;
  firstName: string;
  lastName: string;
  testName: string;
  value: string;
  collectedAt: string;
  unitName: string;
  hoursAfterAdmission: number;
}

export interface FacilitySurveillance {
  scope: 'facility';
  months: number;
  trend: {
    month: string;
    patientDays: number;
    confirmed: number;
    suspected: number;
    rate: number | null;
  }[];
  units: {
    unit: string;
    patientDays: number;
    confirmed: number;
    deviceRelated: number;
    rate: number | null;
  }[];
  byType: { type: HaiType; confirmed: number; suspected: number; ruledOut: number }[];
}
export interface NationalSurveillance {
  scope: 'national';
  months: number;
  threshold: number;
  facilities: {
    facility: string;
    patientDays: number;
    confirmed: number | null;
    deviceRelated: number | null;
    rate: number | null;
    suppressed: boolean;
  }[];
  trend: { month: string; patientDays: number; confirmed: number | null; rate: number | null }[];
}

export interface StewardshipQueue {
  scope: 'team' | 'mine';
  awaitingDecision: Approval[];
  reviewsOverdue: Approval[];
  recent: Approval[];
}

export interface StewardshipStats {
  scope: 'facility' | 'national';
  months: number;
  threshold: number;
  facilities: {
    facility: string;
    starts: number | null;
    patientDays: number;
    startsPer1000: number | null;
    approvalRate: number | null;
    reviewCompliance: number | null;
    suppressed: boolean;
  }[];
}

/* ------------------------------------------------------------------------------ labels -- */

export function precautionLabel(p: Precaution): string {
  switch (p) {
    case 'CONTACT':
      return t('Contact precautions');
    case 'DROPLET':
      return t('Droplet precautions');
    case 'AIRBORNE':
      return t('Airborne precautions');
    case 'PROTECTIVE':
      return t('Protective isolation');
  }
}

/** Short guidance per precaution (shown with the badge). */
export function precautionGuidance(p: Precaution): string {
  switch (p) {
    case 'CONTACT':
      return t(
        'Gloves and apron or gown for contact with the patient or surroundings; dedicated equipment.',
      );
    case 'DROPLET':
      return t('Surgical mask within 1–2 metres; single room or cohort with the same organism.');
    case 'AIRBORNE':
      return t(
        'FFP2/FFP3 respirator; single room with the door closed (negative pressure if available).',
      );
    case 'PROTECTIVE':
      return t(
        'Protects a vulnerable patient (e.g. neutropenia): hand hygiene, mask if unwell, no plants or fresh flowers.',
      );
  }
}

export function haiTypeLabel(type: HaiType): string {
  switch (type) {
    case 'CLABSI':
      return t('Central line-associated bloodstream infection');
    case 'CAUTI':
      return t('Catheter-associated urinary tract infection');
    case 'VAP':
      return t('Ventilator-associated pneumonia');
    case 'SSI':
      return t('Surgical site infection');
    case 'CDI':
      return t('Clostridioides difficile infection');
    case 'MRSA_BACTERAEMIA':
      return t('MRSA bloodstream infection');
    case 'OTHER':
      return t('Other healthcare-associated infection');
  }
}

export function haiCriteria(type: HaiType): string {
  switch (type) {
    case 'CLABSI':
      return t(
        'Positive blood culture with a recognised pathogen (or two cultures with a common commensal and symptoms), central line in place for more than 2 days, no other source.',
      );
    case 'CAUTI':
      return t(
        'Fever or urinary symptoms with a urine culture of ≥ 10⁵ CFU/ml, urinary catheter in place for more than 2 days.',
      );
    case 'VAP':
      return t(
        'New and persistent infiltrate on imaging with fever or leucocytosis and purulent secretions, mechanical ventilation for more than 2 days.',
      );
    case 'SSI':
      return t(
        'Infection of the incision or organ/space within 30 days of the operation (90 days with an implant): pus, positive culture or a diagnosis by the surgeon.',
      );
    case 'CDI':
      return t(
        'Diarrhoea (≥ 3 unformed stools in 24 h) with a positive toxin test, onset more than 3 days after admission.',
      );
    case 'MRSA_BACTERAEMIA':
      return t(
        'Blood culture positive for meticillin-resistant Staphylococcus aureus, taken more than 48 h after admission.',
      );
    case 'OTHER':
      return t(
        'Infection not present or incubating on admission, with onset 48 h or more after admission.',
      );
  }
}

export const HAI_STATUS: Record<HaiStatus, { label: string; tone: Tone }> = {
  SUSPECTED: { label: 'Suspected|infection', tone: 'warning' },
  CONFIRMED: { label: 'Confirmed|infection', tone: 'danger' },
  RULED_OUT: { label: 'Ruled out', tone: 'neutral' },
};

export const APPROVAL_STATUS: Record<Approval['status'], { label: string; tone: Tone }> = {
  REQUESTED: { label: 'Awaiting approval', tone: 'warning' },
  APPROVED: { label: 'Approved|antibiotic', tone: 'success' },
  DECLINED: { label: 'Declined|antibiotic', tone: 'danger' },
};

export function reviewOutcomeLabel(o: ReviewOutcome): string {
  switch (o) {
    case 'CONTINUE':
      return t('Continue');
    case 'NARROW':
      return t('Narrow the spectrum');
    case 'SWITCH_ORAL':
      return t('Switch to oral');
    case 'STOP':
      return t('Stop the antibiotic');
  }
}

/* ------------------------------------------------------------------------------- hooks -- */

export const useInfectionDefinitions = () =>
  useQuery({
    queryKey: ['infection', 'definitions'],
    queryFn: () => api<Definitions>('/infection/definitions'),
    staleTime: 5 * 60_000,
  });

export const usePatientInfection = (patientId: string) =>
  useQuery({
    queryKey: ['patient', patientId, 'infection'],
    queryFn: () => api<PatientInfection>(`/infection/patients/${patientId}`),
  });

export const useIsolations = (enabled = true) =>
  useQuery({
    queryKey: ['infection', 'isolations'],
    queryFn: () => api<IsolationList>('/infection/isolations'),
    enabled,
  });

export const useHaiList = (enabled: boolean) =>
  useQuery({
    queryKey: ['infection', 'hai'],
    queryFn: () => api<{ items: HaiListItem[] }>('/infection/hai'),
    enabled,
  });

export const useSuggestions = (enabled: boolean) =>
  useQuery({
    queryKey: ['infection', 'suggestions'],
    queryFn: () => api<{ items: Suggestion[] }>('/infection/suggestions'),
    enabled,
  });

export const useSurveillance = (months: number, enabled = true) =>
  useQuery({
    queryKey: ['infection', 'surveillance', months],
    queryFn: () =>
      api<FacilitySurveillance | NationalSurveillance>('/infection/surveillance', {
        query: { months },
      }),
    enabled,
  });

export const useStewardship = (enabled: boolean) =>
  useQuery({
    queryKey: ['infection', 'stewardship'],
    queryFn: () => api<StewardshipQueue>('/infection/stewardship'),
    enabled,
  });

export const useStewardshipStats = (months: number, enabled: boolean) =>
  useQuery({
    queryKey: ['infection', 'stewardship-stats', months],
    queryFn: () => api<StewardshipStats>('/infection/stewardship/stats', { query: { months } }),
    enabled,
  });

function useInvalidate(patientId?: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['infection'] });
    void qc.invalidateQueries({ queryKey: ['hospital'] });
    if (patientId) void qc.invalidateQueries({ queryKey: ['patient', patientId] });
  };
}

export function useStartIsolation(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: (body: { precaution: Precaution; reason: string }) =>
      api<IsolationOrder>(`/infection/patients/${patientId}/isolations`, { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useEndIsolation(patientId?: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<IsolationOrder>(`/infection/isolations/${id}/end`, { method: 'POST', body: { reason } }),
    onSuccess: done,
  });
}

export function useReportHai(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: (body: {
      type: HaiType;
      organism?: string;
      onsetAt: string;
      deviceRelated: boolean;
      notes?: string;
    }) => api<HaiEvent>(`/infection/patients/${patientId}/hai`, { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useReviewHai(patientId?: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({
      id,
      status,
      notes,
    }: {
      id: string;
      status: 'CONFIRMED' | 'RULED_OUT';
      notes?: string;
    }) => api<HaiEvent>(`/infection/hai/${id}/review`, { method: 'POST', body: { status, notes } }),
    onSuccess: done,
  });
}

export function useDecideApproval(patientId?: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({
      id,
      decision,
      note,
    }: {
      id: string;
      decision: 'APPROVED' | 'DECLINED';
      note?: string;
    }) =>
      api<Approval>(`/infection/antimicrobials/${id}/decision`, {
        method: 'POST',
        body: { decision, note },
      }),
    onSuccess: done,
  });
}

export function useReviewAntimicrobial(patientId?: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({ id, outcome, note }: { id: string; outcome: ReviewOutcome; note?: string }) =>
      api<Approval>(`/infection/antimicrobials/${id}/review`, {
        method: 'POST',
        body: { outcome, note },
      }),
    onSuccess: done,
  });
}
