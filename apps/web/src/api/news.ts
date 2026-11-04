import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';
import type { Vitals } from './types';

/** NEWS2 early warning (Royal College of Physicians, 2017). */
export type NewsRisk = 'LOW' | 'LOW_MEDIUM' | 'MEDIUM' | 'HIGH';
export type NewsParameter =
  'respiration' | 'spo2' | 'air' | 'systolic' | 'pulse' | 'consciousness' | 'temperature';
export const NEWS_PARAMETERS: NewsParameter[] = [
  'respiration',
  'spo2',
  'air',
  'systolic',
  'pulse',
  'consciousness',
  'temperature',
];

export type NewsComponents = Partial<Record<NewsParameter, number | null>> & {
  singleThree?: boolean;
  missing?: NewsParameter[];
  spo2Scale?: 1 | 2;
};

export interface NewsScore {
  id: string;
  vitalSignId: string;
  admissionId: string | null;
  score: number;
  risk: NewsRisk;
  complete: boolean;
  components: NewsComponents;
  computedAt: string;
  escalatedAt: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export interface NewsBoardItem {
  admissionId: string;
  patientId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: string;
  temporaryIdentity: string | null;
  unitId: string;
  unitName: string;
  bedLabel: string | null;
  attendingDoctorName: string;
  admittedAt: string;
  latest: Omit<NewsScore, 'vitalSignId' | 'admissionId' | 'acknowledgedBy'> | null;
  trend: { score: number; risk: NewsRisk; computedAt: string }[];
  lastObservationAt: string | null;
  observationIntervalMinutes: number;
  minutesSinceObservation: number;
  overdue: boolean;
}

export interface NewsBoard {
  items: NewsBoardItem[];
  counts: { HIGH: number; MEDIUM: number; LOW_MEDIUM: number; overdue: number; total: number };
}

/** Vital signs with the NEWS2 parameters added in the early-warning module. */
export type VitalsWithNews = Vitals & {
  consciousness: 'A' | 'C' | 'V' | 'P' | 'U' | null;
  onSupplementalOxygen: boolean | null;
  painScore: number | null;
};

export const NEWS_KEY = ['news'] as const;

export function useNewsBoard(unitId?: string, enabled = true) {
  return useQuery({
    queryKey: [...NEWS_KEY, 'board', unitId ?? 'all'],
    queryFn: () => api<NewsBoard>('/early-warning/board', { query: unitId ? { unitId } : {} }),
    enabled,
    refetchInterval: 60_000,
  });
}

export function usePatientNews(patientId: string) {
  return useQuery({
    queryKey: [...NEWS_KEY, 'patient', patientId],
    queryFn: () =>
      api<{ items: NewsScore[]; spo2Scale: 1 | 2 }>(`/early-warning/patients/${patientId}`),
  });
}

function useInvalidateNews(patientId?: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: NEWS_KEY });
    void qc.invalidateQueries({ queryKey: ['hospital'] });
    if (patientId) void qc.invalidateQueries({ queryKey: ['patient', patientId] });
  };
}

export function useAcknowledgeScore(patientId?: string) {
  const done = useInvalidateNews(patientId);
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) =>
      api<{ acknowledged: number }>(`/early-warning/scores/${id}/acknowledge`, {
        method: 'POST',
        body: note ? { note } : {},
      }),
    onSuccess: done,
  });
}

export function useSetSpo2Scale(patientId: string) {
  const done = useInvalidateNews(patientId);
  return useMutation({
    mutationFn: (input: { scale: 1 | 2; reason: string }) =>
      api(`/early-warning/patients/${patientId}/spo2-scale`, { method: 'PUT', body: input }),
    onSuccess: done,
  });
}

export function riskLabel(risk: NewsRisk): string {
  switch (risk) {
    case 'HIGH':
      return t('High risk – emergency response');
    case 'MEDIUM':
      return t('Medium risk – urgent response');
    case 'LOW_MEDIUM':
      return t('Single parameter 3 – urgent ward review');
    default:
      return t('Low risk');
  }
}

export function riskShort(risk: NewsRisk): string {
  switch (risk) {
    case 'HIGH':
      return t('High');
    case 'MEDIUM':
      return t('Medium');
    case 'LOW_MEDIUM':
      return t('Low–medium');
    default:
      return t('Low');
  }
}

export function parameterLabel(p: NewsParameter): string {
  switch (p) {
    case 'respiration':
      return t('Respiration rate');
    case 'spo2':
      return t('Oxygen saturation');
    case 'air':
      return t('Air or oxygen');
    case 'systolic':
      return t('Systolic blood pressure');
    case 'pulse':
      return t('Pulse');
    case 'consciousness':
      return t('Consciousness');
    case 'temperature':
      return t('Temperature');
  }
}

export function consciousnessLabel(level: string): string {
  switch (level) {
    case 'A':
      return t('Alert');
    case 'C':
      return t('New confusion');
    case 'V':
      return t('Responds to voice');
    case 'P':
      return t('Responds to pain');
    case 'U':
      return t('Unresponsive');
    default:
      return level;
  }
}

/** "every 15 min" / "hourly" / "every 4 h" / "every 12 h". */
export function intervalLabel(minutes: number): string {
  if (minutes < 60) return t('every {count} min', { count: minutes });
  if (minutes === 60) return t('hourly');
  return t('every {count} h', { count: Math.round(minutes / 60) });
}
