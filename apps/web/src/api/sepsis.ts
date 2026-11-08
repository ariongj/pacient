import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/**
 * Sepsis screening and the Sepsis Six bundle (UK Sepsis Trust / NICE NG51 approach, illustrative
 * until the local sepsis protocol is adopted).
 */
export type SepsisStatus = 'PENDING' | 'NOT_SEPSIS' | 'SEPSIS_SUSPECTED' | 'RED_FLAG';

export const SEPSIS_STEPS = [
  'oxygen',
  'cultures',
  'antibiotics',
  'fluids',
  'lactate',
  'urineOutput',
] as const;
export type SepsisStep = (typeof SEPSIS_STEPS)[number];

export const RED_FLAGS = [
  'SYSTOLIC_LE_90',
  'HR_GE_130',
  'RR_GE_25',
  'NEEDS_OXYGEN',
  'NEW_CONFUSION',
  'NON_BLANCHING_RASH',
  'NO_URINE_18H',
  'LACTATE_GE_2',
  'RECENT_CHEMOTHERAPY',
] as const;
export const AMBER_FLAGS = [
  'SYSTOLIC_91_100',
  'HR_91_130',
  'RR_21_24',
  'TEMPERATURE_LT_36',
  'NO_URINE_12_18H',
  'ALTERED_BEHAVIOUR',
  'IMMUNOSUPPRESSED',
  'RECENT_SURGERY_OR_TRAUMA',
  'WOUND_INFECTION_SIGNS',
  'RIGORS',
] as const;
export type SepsisFlag = (typeof RED_FLAGS)[number] | (typeof AMBER_FLAGS)[number];

export const SUSPECTED_SOURCES = [
  'RESPIRATORY',
  'URINARY',
  'ABDOMINAL',
  'SKIN_SOFT_TISSUE',
  'LINE_OR_DEVICE',
  'SURGICAL_SITE',
  'CENTRAL_NERVOUS_SYSTEM',
  'UNKNOWN',
] as const;
export type SuspectedSource = (typeof SUSPECTED_SOURCES)[number];

export interface SepsisScreen {
  id: string;
  patientId: string;
  admissionId: string | null;
  edVisitId: string | null;
  trigger: 'PROMPTED' | 'MANUAL';
  status: SepsisStatus;
  suspectedSource: SuspectedSource | null;
  flags: SepsisFlag[];
  screenedAt: string | null;
  screenedBy: string | null;
  steps: { step: SepsisStep; at: string | null; by: string | null }[];
  stepsDone: number;
  antibioticPrescriptionId: string | null;
  bundleStartedAt: string | null;
  bundleCompletedAt: string | null;
  minutesSinceStart: number | null;
  overdue: boolean;
  escalatedAt: string | null;
  seniorReviewAt: string | null;
  notes: string | null;
  createdAt: string;
  open: boolean;
}

export interface SepsisBoardItem extends SepsisScreen {
  patient: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    sex: string;
    temporaryIdentity: string | null;
  };
  unitId: string | null;
  unitName: string | null;
  bedLabel: string | null;
}

export interface SepsisBoard {
  items: SepsisBoardItem[];
  counts: { PENDING: number; RED_FLAG: number; SEPSIS_SUSPECTED: number; overdue: number };
  targetMinutes: number;
}

export interface PatientSepsis {
  items: SepsisScreen[];
  latestVitals: {
    recordedAt: string;
    systolic: number | null;
    heartRate: number | null;
    respiratoryRate: number | null;
    oxygenSaturation: number | null;
    onSupplementalOxygen: boolean | null;
    consciousness: string | null;
    temperatureC: string | null;
  } | null;
  suggestedFlags: SepsisFlag[];
  location: {
    unitName: string;
    bedLabel: string | null;
    setting: 'INPATIENT' | 'EMERGENCY';
  } | null;
  targetMinutes: number;
}

export interface SepsisDashboardRow {
  screens: number;
  prompted: number;
  redFlags: number;
  suspected: number;
  withinTargetPct: number | null;
  medianMinutesToAntibiotics: number | null;
}

export interface SepsisDashboard {
  months: (SepsisDashboardRow & { month: string })[];
  total: SepsisDashboardRow;
  targetMinutes: number;
  smallCellThreshold: number;
}

export interface ScreenInput {
  suspectedInfection: boolean;
  suspectedSource?: SuspectedSource | null;
  flags: SepsisFlag[];
  notes?: string | null;
}

export type BoardFilter = 'OPEN' | 'PENDING' | 'RED_FLAG' | 'SEPSIS_SUSPECTED';

export const useSepsisBoard = (status: BoardFilter) =>
  useQuery({
    queryKey: ['sepsis', 'board', status],
    queryFn: () => api<SepsisBoard>('/sepsis/board', { query: { status } }),
    refetchInterval: 30_000,
  });

export const usePatientSepsis = (patientId: string) =>
  useQuery({
    queryKey: ['patient', patientId, 'sepsis'],
    queryFn: () => api<PatientSepsis>(`/sepsis/patients/${patientId}`),
    refetchInterval: 60_000,
  });

export const useSepsisDashboard = () =>
  useQuery({
    queryKey: ['sepsis', 'dashboard'],
    queryFn: () => api<SepsisDashboard>('/sepsis/dashboard'),
  });

function useInvalidate(patientId?: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['sepsis'] });
    if (patientId) void qc.invalidateQueries({ queryKey: ['patient', patientId, 'sepsis'] });
  };
}

/** Answer a prompt (screenId) or screen without a prompt (patientId only). */
export function useRecordScreen(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({ screenId, input }: { screenId?: string; input: ScreenInput }) =>
      screenId
        ? api<SepsisScreen>(`/sepsis/screens/${screenId}/screen`, { method: 'POST', body: input })
        : api<SepsisScreen>(`/sepsis/patients/${patientId}/screens`, {
            method: 'POST',
            body: input,
          }),
    onSuccess: done,
  });
}

export function useRecordStep(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({ screenId, step }: { screenId: string; step: SepsisStep }) =>
      api<SepsisScreen>(`/sepsis/screens/${screenId}/bundle`, { method: 'POST', body: { step } }),
    onSuccess: done,
  });
}

export function useSeniorReview(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: (screenId: string) =>
      api<SepsisScreen>(`/sepsis/screens/${screenId}/senior-review`, { method: 'POST', body: {} }),
    onSuccess: done,
  });
}

/* ------------------------------------------------------------------ labels ---------------- */

export const isRedFlag = (f: string) => (RED_FLAGS as readonly string[]).includes(f);

export function statusLabel(s: SepsisStatus): string {
  switch (s) {
    case 'PENDING':
      return t('Screen needed');
    case 'NOT_SEPSIS':
      return t('Sepsis not suspected');
    case 'SEPSIS_SUSPECTED':
      return t('Sepsis suspected');
    case 'RED_FLAG':
      return t('Red flag sepsis');
  }
}

export function statusTone(s: SepsisStatus): 'danger' | 'warning' | 'info' | 'success' {
  return s === 'RED_FLAG'
    ? 'danger'
    : s === 'SEPSIS_SUSPECTED'
      ? 'warning'
      : s === 'PENDING'
        ? 'info'
        : 'success';
}

export function stepLabel(s: SepsisStep): string {
  switch (s) {
    case 'oxygen':
      return t('Oxygen (target SpO₂ 94–98%)');
    case 'cultures':
      return t('Blood cultures');
    case 'antibiotics':
      return t('IV antibiotics');
    case 'fluids':
      return t('IV fluids');
    case 'lactate':
      return t('Lactate and full blood count');
    case 'urineOutput':
      return t('Urine output monitoring');
  }
}

export function flagLabel(f: SepsisFlag): string {
  switch (f) {
    case 'SYSTOLIC_LE_90':
      return t('Systolic blood pressure 90 or lower');
    case 'HR_GE_130':
      return t('Heart rate 130 or higher');
    case 'RR_GE_25':
      return t('Respiratory rate 25 or higher');
    case 'NEEDS_OXYGEN':
      return t('Needs oxygen to keep SpO₂ at 92% or more');
    case 'NEW_CONFUSION':
      return t('New confusion; responds only to voice or pain, or unresponsive');
    case 'NON_BLANCHING_RASH':
      return t('Non-blanching rash, mottled or ashen skin');
    case 'NO_URINE_18H':
      return t('No urine passed in 18 hours');
    case 'LACTATE_GE_2':
      return t('Lactate 2 mmol/L or higher');
    case 'RECENT_CHEMOTHERAPY':
      return t('Chemotherapy in the last 6 weeks');
    case 'SYSTOLIC_91_100':
      return t('Systolic blood pressure 91–100');
    case 'HR_91_130':
      return t('Heart rate 91–130');
    case 'RR_21_24':
      return t('Respiratory rate 21–24');
    case 'TEMPERATURE_LT_36':
      return t('Temperature below 36 °C');
    case 'NO_URINE_12_18H':
      return t('No urine passed in 12–18 hours');
    case 'ALTERED_BEHAVIOUR':
      return t('Relatives worried about changed behaviour or mental state');
    case 'IMMUNOSUPPRESSED':
      return t('Weakened immune system');
    case 'RECENT_SURGERY_OR_TRAUMA':
      return t('Surgery or trauma in the last 6 weeks');
    case 'WOUND_INFECTION_SIGNS':
      return t('Signs of wound, device or skin infection');
    case 'RIGORS':
      return t('Rigors (shaking chills)');
  }
}

export function sourceLabel(s: SuspectedSource): string {
  switch (s) {
    case 'RESPIRATORY':
      return t('Chest (respiratory)');
    case 'URINARY':
      return t('Urine (urinary tract)');
    case 'ABDOMINAL':
      return t('Abdomen');
    case 'SKIN_SOFT_TISSUE':
      return t('Skin or soft tissue');
    case 'LINE_OR_DEVICE':
      return t('Line or device');
    case 'SURGICAL_SITE':
      return t('Surgical wound');
    case 'CENTRAL_NERVOUS_SYSTEM':
      return t('Brain or meninges');
    case 'UNKNOWN':
      return t('Source not known');
  }
}

/** "35 min" since the bundle started (live). */
export function minutesSince(iso: string, now = Date.now()): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
}
