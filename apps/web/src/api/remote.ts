import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatNumber } from '../format';
import { t } from '../i18n';
import type { Tone } from '../components/ui';
import { api } from './client';

/** API client and types for remote monitoring (home readings). */

export type ReadingKind =
  'BLOOD_PRESSURE' | 'GLUCOSE' | 'WEIGHT' | 'SPO2' | 'HEART_RATE' | 'TEMPERATURE' | 'PEAK_FLOW';
export const READING_KINDS: ReadingKind[] = [
  'BLOOD_PRESSURE',
  'GLUCOSE',
  'WEIGHT',
  'SPO2',
  'HEART_RATE',
  'TEMPERATURE',
  'PEAK_FLOW',
];
export type Flag = 'NORMAL' | 'OUT_OF_RANGE' | 'URGENT';
export type Limits = Partial<Record<string, number>>;
export type Advice = 'URGENT' | 'URGENT_LOW_GLUCOSE' | 'OUT_OF_RANGE' | null;

export interface Reading {
  id: string;
  kind: ReadingKind;
  values: Record<string, number | string>;
  reasons: string[];
  measuredAt: string;
  source: string;
  note: string | null;
  flag: Flag;
  reviewedAt: string | null;
  reviewNote?: string | null;
  reviewedBy: string | null;
  createdAt: string;
}

export interface Plan {
  id: string;
  kinds: ReadingKind[];
  thresholds: Limits;
  limits: Limits;
  frequency: string | null;
  instructions: string | null;
  status: 'ACTIVE' | 'ENDED';
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
  updatedAt: string;
  enrolledBy: string;
}

export interface PatientMonitoring {
  plan: Plan | null;
  history: Omit<Plan, 'limits'>[];
  readings: Reading[];
  suggestion: { registers: string[]; kinds: ReadingKind[] } | null;
  canEnrol: boolean;
  canReview: boolean;
}

export interface Definitions {
  kinds: {
    kind: ReadingKind;
    unit: string;
    thresholds: { key: string; default: number | null }[];
  }[];
  glucoseContexts: string[];
  defaults: Limits;
  registerSuggestions: Record<string, ReadingKind[]>;
  maxBackdateDays: number;
  disclaimer: string;
}

export interface PatientRef {
  id: string;
  firstName: string;
  lastName: string;
  nationalId: string;
  dateOfBirth: string;
  phone?: string | null;
}

export interface ReviewItem {
  id: string;
  kind: ReadingKind;
  values: Record<string, number | string>;
  reasons: string[];
  measuredAt: string;
  note: string | null;
  flag: Flag;
  planned: boolean;
  createdAt: string;
  patient: PatientRef;
}
export interface ReviewList {
  items: ReviewItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: { urgent: number; outOfRange: number };
}
export interface SilentItem {
  planId: string;
  kinds: ReadingKind[];
  frequency: string | null;
  planStartedAt: string;
  lastReadingAt: string | null;
  silentAfterDays: number;
  daysSilent: number;
  patient: PatientRef;
}
export interface SuggestionItem {
  patient: PatientRef;
  registers: string[];
  kinds: ReadingKind[];
}
export interface MyMonitoring {
  plan: {
    id: string;
    kinds: ReadingKind[];
    limits: Limits;
    frequency: string | null;
    instructions: string | null;
    createdAt: string;
    enrolledBy: string | null;
  } | null;
  readings: Reading[];
}
export interface SubmitResult {
  reading: Reading;
  flag: Flag;
  reasons: string[];
  planned: boolean;
  advice: Advice;
}
export interface RemoteStats {
  enrolledPatients: number;
  byKind: { kind: ReadingKind; n: number }[];
  weekly: { week: string; readings: number; flagged: number }[];
  review: {
    flagged: number;
    reviewedWithin24h: number;
    pct: number | null;
    stillPending: number;
    urgent: number;
  };
  generatedAt: string;
}

/* ------------------------------------------------------------------------------ hooks -- */

const KEY = ['remote-monitoring'];

export const useRemoteDefinitions = () =>
  useQuery({
    queryKey: [...KEY, 'definitions'],
    queryFn: () => api<Definitions>('/remote-monitoring/definitions'),
    staleTime: Infinity,
  });

export const usePatientMonitoring = (patientId: string) =>
  useQuery({
    queryKey: [...KEY, 'patient', patientId],
    queryFn: () => api<PatientMonitoring>(`/remote-monitoring/patients/${patientId}`),
  });

export const useReviewList = (params: { flag?: string; kind?: string; page: number }) =>
  useQuery({
    queryKey: [...KEY, 'review', params],
    queryFn: () => api<ReviewList>('/remote-monitoring/review', { query: params }),
  });

export const useSilentPatients = () =>
  useQuery({
    queryKey: [...KEY, 'silent'],
    queryFn: () => api<{ items: SilentItem[]; total: number }>('/remote-monitoring/silent'),
  });

export const useSuggestions = () =>
  useQuery({
    queryKey: [...KEY, 'suggestions'],
    queryFn: () =>
      api<{ items: SuggestionItem[]; total: number }>('/remote-monitoring/suggestions'),
  });

export const useMyMonitoring = () =>
  useQuery({
    queryKey: [...KEY, 'mine'],
    queryFn: () => api<MyMonitoring>('/remote-monitoring/mine'),
  });

export const useRemoteStats = (enabled = true) =>
  useQuery({
    queryKey: [...KEY, 'stats'],
    queryFn: () => api<RemoteStats>('/remote-monitoring/stats'),
    enabled,
  });

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

export interface PlanInput {
  kinds: ReadingKind[];
  thresholds?: Limits;
  frequency?: string | null;
  instructions?: string | null;
}

export function useEnrolPlan(patientId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: PlanInput) =>
      api<Plan>(`/remote-monitoring/patients/${patientId}/plans`, { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

export function useUpdatePlan() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<PlanInput> & { id: string }) =>
      api<Plan>(`/remote-monitoring/plans/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
}

export function useEndPlan() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<Plan>(`/remote-monitoring/plans/${id}/end`, { method: 'POST', body: { reason } }),
    onSuccess: invalidate,
  });
}

export function useReviewReading() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      api<Reading>(`/remote-monitoring/readings/${id}/review`, {
        method: 'POST',
        body: { note: note || null },
      }),
    onSuccess: invalidate,
  });
}

export function useSubmitReading() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: {
      kind: ReadingKind;
      values: Record<string, number | string>;
      measuredAt?: string;
      note?: string;
    }) => api<SubmitResult>('/remote-monitoring/mine/readings', { method: 'POST', body }),
    onSuccess: invalidate,
  });
}

/* ----------------------------------------------------------------------------- labels -- */

export function kindLabel(kind: string): string {
  const labels: Record<ReadingKind, string> = {
    BLOOD_PRESSURE: t('Blood pressure'),
    GLUCOSE: t('Blood glucose'),
    WEIGHT: t('Weight'),
    SPO2: t('Oxygen saturation'),
    HEART_RATE: t('Pulse|heart rate'),
    TEMPERATURE: t('Temperature'),
    PEAK_FLOW: t('Peak flow'),
  };
  return labels[kind as ReadingKind] ?? kind;
}

export const UNITS: Record<ReadingKind, string> = {
  BLOOD_PRESSURE: 'mmHg',
  GLUCOSE: 'mmol/L',
  WEIGHT: 'kg',
  SPO2: '%',
  HEART_RATE: '/min',
  TEMPERATURE: '°C',
  PEAK_FLOW: 'L/min',
};

export function glucoseContextLabel(c: string): string {
  return (
    {
      FASTING: t('Fasting'),
      BEFORE_MEAL: t('Before a meal'),
      AFTER_MEAL: t('After a meal'),
      BEDTIME: t('At bedtime'),
      RANDOM: t('Other time'),
    }[c] ?? c
  );
}

/** "152/94 mmHg", "7,2 mmol/L (fasting)", "SpO₂ 93 % · pulse 88/min". */
export function readingValue(kind: string, values: Record<string, number | string>): string {
  const n = (k: string) =>
    typeof values[k] === 'number' ? formatNumber(values[k] as number) : '?';
  const pulse =
    typeof values.pulse === 'number' ? ` · ${t('pulse {value}/min', { value: n('pulse') })}` : '';
  switch (kind) {
    case 'BLOOD_PRESSURE':
      return `${n('systolic')}/${n('diastolic')} mmHg${pulse}`;
    case 'GLUCOSE':
      return `${n('value')} mmol/L${
        typeof values.context === 'string'
          ? ` (${glucoseContextLabel(values.context).toLowerCase()})`
          : ''
      }`;
    case 'SPO2':
      return `${n('value')} %${pulse}`;
    default:
      return `${n('value')} ${UNITS[kind as ReadingKind] ?? ''}`.trim();
  }
}

export function flagLabel(flag: Flag): string {
  return {
    NORMAL: t('Within limits'),
    OUT_OF_RANGE: t('Outside the limits'),
    URGENT: t('Urgent|reading'),
  }[flag];
}
export const FLAG_TONE: Record<Flag, Tone> = {
  NORMAL: 'success',
  OUT_OF_RANGE: 'warning',
  URGENT: 'danger',
};

export function reasonLabel(code: string): string {
  const labels: Record<string, string> = {
    BP_HIGH: t('Blood pressure above the limit'),
    BP_LOW: t('Blood pressure below the limit'),
    BP_URGENT_HIGH: t('Very high blood pressure'),
    BP_URGENT_LOW: t('Very low blood pressure'),
    GLUCOSE_LOW: t('Low blood sugar'),
    GLUCOSE_URGENT_LOW: t('Very low blood sugar'),
    GLUCOSE_HIGH: t('High blood sugar'),
    GLUCOSE_URGENT_HIGH: t('Very high blood sugar'),
    WEIGHT_GAIN: t('Weight gain within three days'),
    SPO2_LOW: t('Low oxygen saturation'),
    SPO2_URGENT_LOW: t('Very low oxygen saturation'),
    HEART_RATE_LOW: t('Slow pulse'),
    HEART_RATE_HIGH: t('Fast pulse'),
    HEART_RATE_URGENT: t('Pulse far outside the limits'),
    TEMPERATURE_HIGH: t('Fever'),
    TEMPERATURE_URGENT_HIGH: t('Very high fever'),
    TEMPERATURE_LOW: t('Low body temperature'),
    PEAK_FLOW_LOW: t('Peak flow below the limit'),
    PEAK_FLOW_URGENT_LOW: t('Peak flow far below the limit'),
  };
  return labels[code] ?? code;
}

/** Names of the alert limits shown in the plan form. */
export function limitLabel(key: string): string {
  const labels: Record<string, string> = {
    systolicHigh: t('Systolic: review from'),
    diastolicHigh: t('Diastolic: review from'),
    systolicLow: t('Systolic: review at or below'),
    systolicUrgentHigh: t('Systolic: urgent from'),
    diastolicUrgentHigh: t('Diastolic: urgent from'),
    systolicUrgentLow: t('Systolic: urgent below'),
    glucoseLow: t('Glucose: review below'),
    glucoseUrgentLow: t('Glucose: urgent below'),
    glucoseHigh: t('Glucose: review above'),
    glucoseUrgentHigh: t('Glucose: urgent above'),
    weightGainKg3Days: t('Weight gain in 3 days: review from (kg)'),
    spo2Low: t('SpO₂: review below'),
    spo2UrgentLow: t('SpO₂: urgent below'),
    heartRateLow: t('Pulse: review below'),
    heartRateHigh: t('Pulse: review above'),
    heartRateUrgentLow: t('Pulse: urgent below'),
    heartRateUrgentHigh: t('Pulse: urgent above'),
    temperatureHigh: t('Temperature: review from'),
    temperatureUrgentHigh: t('Temperature: urgent from'),
    temperatureLow: t('Temperature: review below'),
    peakFlowLow: t('Peak flow: review below'),
    peakFlowUrgentLow: t('Peak flow: urgent below'),
    silentAfterDays: t('Days without readings before follow-up'),
  };
  return labels[key] ?? key;
}

/** Values plotted for each kind (blood pressure has two lines). */
export function seriesOf(kind: ReadingKind): { key: string; label: string }[] {
  if (kind === 'BLOOD_PRESSURE') {
    return [
      { key: 'systolic', label: t('Systolic') },
      { key: 'diastolic', label: t('Diastolic') },
    ];
  }
  return [{ key: 'value', label: kindLabel(kind) }];
}

/** Limit lines drawn on the trend chart of each kind. */
export function limitLinesOf(kind: ReadingKind, limits: Limits) {
  const pick = (keys: string[], tone: 'warning' | 'danger') =>
    keys
      .filter((k) => typeof limits[k] === 'number')
      .map((k) => ({ value: limits[k]!, label: limitLabel(k), tone }));
  switch (kind) {
    case 'BLOOD_PRESSURE':
      return [
        ...pick(['systolicHigh', 'diastolicHigh'], 'warning'),
        ...pick(['systolicUrgentHigh'], 'danger'),
      ];
    case 'GLUCOSE':
      return [
        ...pick(['glucoseLow', 'glucoseHigh'], 'warning'),
        ...pick(['glucoseUrgentLow'], 'danger'),
      ];
    case 'SPO2':
      return [...pick(['spo2Low'], 'warning'), ...pick(['spo2UrgentLow'], 'danger')];
    case 'HEART_RATE':
      return pick(['heartRateLow', 'heartRateHigh'], 'warning');
    case 'TEMPERATURE':
      return [
        ...pick(['temperatureHigh'], 'warning'),
        ...pick(['temperatureUrgentHigh'], 'danger'),
      ];
    case 'PEAK_FLOW':
      return [...pick(['peakFlowLow'], 'warning'), ...pick(['peakFlowUrgentLow'], 'danger')];
    default:
      return [];
  }
}
