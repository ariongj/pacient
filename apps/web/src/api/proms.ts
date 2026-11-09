import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getLocale, t } from '../i18n';
import type { Tone } from '../components/ui';
import { api } from './client';

/** API client and types for patient-reported outcomes (questionnaires). */

export type InstrumentCode = 'PHQ9' | 'GAD7' | 'WHO5' | 'AUDITC';
export type Frequency = 'ONCE' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY';
export const FREQUENCIES: Frequency[] = ['ONCE', 'WEEKLY', 'MONTHLY', 'QUARTERLY'];
export type DueState = 'UPCOMING' | 'DUE' | 'OVERDUE' | 'NONE';
export type Advice = 'CRISIS' | 'HIGH' | null;

/** Text in English, Albanian and Serbian (the sq/sr wording is a working translation). */
export type Text = { en: string; sq: string; sr: string };

export interface Instrument {
  code: InstrumentCode;
  name: string;
  measures: string;
  stem: Text;
  items: { code: string; text: Text; options: { value: number; text: Text }[] }[];
  minScore: number;
  maxScore: number;
  direction: 'HIGHER_WORSE' | 'HIGHER_BETTER';
  bands: { code: string; min: number; max: number }[];
  mcid: number | null;
  sensitive: boolean;
  terms: string;
  source: string;
  translationStatus: 'WORKING';
}

export interface Change {
  previous: number;
  difference: number;
  meaningful: boolean;
  direction: 'BETTER' | 'WORSE' | 'SAME';
}

export interface Assignment {
  id: string;
  instrument: InstrumentCode;
  frequency: Frequency;
  nextDueAt: string | null;
  status: 'ACTIVE' | 'ENDED';
  endedAt?: string | null;
  endReason?: string | null;
  createdAt: string;
  assignedBy: string;
  due: DueState;
}

export interface Response {
  id: string;
  assignmentId?: string | null;
  instrument: InstrumentCode;
  answers: Record<string, number>;
  score: number | null;
  severity: string | null;
  safetyFlag?: boolean;
  submittedAt: string;
  reviewedAt: string | null;
  reviewNote?: string | null;
  reviewedBy?: string | null;
  change: Change | null;
}

export interface PatientProms {
  assignments: Assignment[];
  responses: Response[];
  canAssign: boolean;
  canReview: boolean;
}

export interface MyProms {
  acting: boolean;
  assignments: Omit<Assignment, 'status'>[];
  responses: Response[];
}

export interface SubmitResult {
  response: {
    id: string;
    instrument: InstrumentCode;
    score: number;
    severity: string;
    submittedAt: string;
  };
  change: Change | null;
  advice: Advice;
  careTeamNotified: boolean;
}

export interface PatientRef {
  id: string;
  firstName: string;
  lastName: string;
  nationalId: string;
  dateOfBirth: string;
  phone: string | null;
}

export interface ReviewItem {
  id: string;
  instrument: InstrumentCode;
  score: number | null;
  severity: string | null;
  safetyFlag: boolean;
  submittedAt: string;
  reviewedAt: string | null;
  previousScore: number | null;
  difference: number | null;
  meaningful: boolean;
  patient: PatientRef;
}

export interface PromStats {
  period: { from: string; to: string };
  smallCellThreshold: number;
  items: {
    instrument: InstrumentCode;
    asked: number | null;
    answered: number | null;
    completionPct: number | null;
    responses: number | null;
    safetyFlags: number | null;
    flagsReviewedWithin24hPct: number | null;
  }[];
}

/* ------------------------------------------------------------------------------ hooks -- */

const KEY = ['proms'] as const;

export function useInstruments() {
  return useQuery({
    queryKey: [...KEY, 'instruments'],
    queryFn: () =>
      api<{ instruments: Instrument[]; frequencies: Frequency[] }>('/proms/instruments'),
    staleTime: 60 * 60_000,
  });
}

export function usePatientProms(patientId: string) {
  return useQuery({
    queryKey: [...KEY, 'patient', patientId],
    queryFn: () => api<PatientProms>(`/proms/patients/${patientId}`),
  });
}

export function useMyProms(actingFor?: string | null) {
  return useQuery({
    queryKey: [...KEY, 'mine', actingFor ?? 'self'],
    queryFn: () => api<MyProms>('/proms/mine'),
  });
}

export function useReviewList(query: { show: string; instrument?: string; page: number }) {
  return useQuery({
    queryKey: [...KEY, 'review', query],
    queryFn: () =>
      api<{
        items: ReviewItem[];
        page: number;
        totalPages: number;
        total: number;
        counts: { flagged: number };
      }>('/proms/review', { query: { ...query, pageSize: 25 } }),
  });
}

export function usePromStats(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'stats'],
    queryFn: () => api<PromStats>('/proms/stats'),
    enabled,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

export function useAssign(patientId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { instrument: InstrumentCode; frequency: Frequency; firstDueAt?: string }) =>
      api<Assignment>(`/proms/patients/${patientId}/assignments`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useChangeFrequency() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, frequency }: { id: string; frequency: Frequency }) =>
      api<Assignment>(`/proms/assignments/${id}`, { method: 'PATCH', body: { frequency } }),
    onSuccess: invalidate,
  });
}

export function useEndAssignment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<Assignment>(`/proms/assignments/${id}/end`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
}

export function useSubmitResponse() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: {
      instrument: InstrumentCode;
      assignmentId?: string;
      answers: Record<string, number>;
    }) => api<SubmitResult>('/proms/mine/responses', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useReviewResponse() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      api<Response>(`/proms/responses/${id}/review`, {
        method: 'POST',
        body: { note: note || null },
      }),
    onSuccess: invalidate,
  });
}

/* ----------------------------------------------------------------------------- labels -- */

/** The questionnaire text in the current language (sq/sr: working translations). */
export function localText(text: Text): string {
  const l = getLocale();
  return (l === 'sq' || l === 'sr' ? text[l] : text.en) || text.en;
}

export function instrumentName(code: string): string {
  const names: Record<InstrumentCode, string> = {
    PHQ9: t('PHQ-9 (depression)'),
    GAD7: t('GAD-7 (anxiety)'),
    WHO5: t('WHO-5 (well-being)'),
    AUDITC: t('AUDIT-C (alcohol)'),
  };
  return names[code as InstrumentCode] ?? code;
}

export function frequencyLabel(f: string): string {
  return (
    {
      ONCE: t('Once'),
      WEEKLY: t('Every week'),
      MONTHLY: t('Every month'),
      QUARTERLY: t('Every three months'),
    }[f] ?? f
  );
}

export function severityLabel(code: string | null): string {
  if (!code) return '—';
  const labels: Record<string, string> = {
    MINIMAL: t('Minimal'),
    MILD: t('Mild'),
    MODERATE: t('Moderate'),
    MODERATELY_SEVERE: t('Moderately severe'),
    SEVERE: t('Severe'),
    GOOD: t('Good well-being'),
    LOW: t('Low well-being'),
    VERY_LOW: t('Very low well-being'),
    LOWER_RISK: t('Lower risk'),
    INCREASED_RISK: t('Increased risk'),
    HIGH_RISK: t('High risk'),
  };
  return labels[code] ?? code;
}

export const SEVERITY_TONE: Record<string, Tone> = {
  MINIMAL: 'success',
  MILD: 'neutral',
  MODERATE: 'warning',
  MODERATELY_SEVERE: 'danger',
  SEVERE: 'danger',
  GOOD: 'success',
  LOW: 'warning',
  VERY_LOW: 'danger',
  LOWER_RISK: 'success',
  INCREASED_RISK: 'warning',
  HIGH_RISK: 'danger',
};

export function dueLabel(d: DueState): string {
  return {
    UPCOMING: t('Not due yet'),
    DUE: t('Due now'),
    OVERDUE: t('Overdue'),
    NONE: '—',
  }[d];
}
export const DUE_TONE: Record<DueState, Tone> = {
  UPCOMING: 'neutral',
  DUE: 'info',
  OVERDUE: 'warning',
  NONE: 'neutral',
};
