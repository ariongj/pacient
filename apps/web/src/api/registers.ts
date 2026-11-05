import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatNumber } from '../format';
import { t } from '../i18n';
import type { Tone } from '../components/ui';
import { api } from './client';

/** API client and types for chronic disease registers. */

export type RegisterCode =
  'DIABETES' | 'HYPERTENSION' | 'ASTHMA' | 'COPD' | 'CKD' | 'HEART_FAILURE';
export const REGISTER_CODES: RegisterCode[] = [
  'DIABETES',
  'HYPERTENSION',
  'ASTHMA',
  'COPD',
  'CKD',
  'HEART_FAILURE',
];
export type ProcessState = 'UP_TO_DATE' | 'DUE_SOON' | 'DUE' | 'OVERDUE';
export type TargetCode = 'HBA1C' | 'BP' | 'CHOLESTEROL';

export interface ProcessStatus {
  code: string;
  label: string;
  intervalDays: number;
  recordable: boolean;
  results: string[] | null;
  last: { at: string; display: string; detail: string | null } | null;
  dueDate: string;
  state: ProcessState;
  target: { code: TargetCode; description: string; met: boolean | null } | null;
  trend: { at: string; value: number }[];
}

export interface Enrolment {
  id: string;
  register: RegisterCode;
  status: 'ACTIVE' | 'LEFT';
  source: 'DIAGNOSIS' | 'MANUAL';
  enrolledAt: string;
  leftAt: string | null;
  leftReason: string | null;
  facilityName: string;
  enrolledBy: string | null;
}

export interface PatientRegisters {
  registers: (Enrolment & { label: string; processes: ProcessStatus[] })[];
  history: Enrolment[];
  suggested: { register: RegisterCode; label: string; diagnosis: string }[];
  records: {
    id: string;
    register: RegisterCode;
    process: string;
    result: string;
    notes: string | null;
    performedAt: string;
    recordedBy: string | null;
  }[];
  canEnrol: boolean;
  canRecord: boolean;
}

export interface RecallItem {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    nationalId: string;
    dateOfBirth: string;
    sex: string;
    phone: string | null;
  };
  registers: {
    register: RegisterCode;
    label: string;
    items: { code: string; label: string; state: ProcessState; dueDate: string }[];
    targetsNotMet: TargetCode[];
  }[];
}
export interface RecallList {
  items: RecallItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: { patients: number; overdueItems: number; inCare: number };
}

export interface IndicatorCell {
  count: number | null;
  percent: number | null;
  suppressed: boolean;
}
export interface RegisterIndicators {
  register: RegisterCode;
  label: string;
  enrolled: number | null;
  suppressed: boolean;
  prevalencePer1000: number | null;
  processes: ({ code: string; label: string } & IndicatorCell)[];
  targets: ({ code: TargetCode; label: string; description: string } & IndicatorCell)[];
}
export interface Indicators {
  scope: 'FACILITY' | 'NATIONAL';
  groupBy: 'NONE' | 'FACILITY' | 'MUNICIPALITY';
  asOf: string;
  threshold: number;
  total: RegisterIndicators[];
  rows: { key: string; name: string; registers: RegisterIndicators[] }[];
  disclaimer: string;
}

/* ----------------------------------------------------------------------------- labels -- */

export function registerLabel(code: string): string {
  const labels: Record<RegisterCode, string> = {
    DIABETES: t('Diabetes'),
    HYPERTENSION: t('Hypertension'),
    ASTHMA: t('Asthma'),
    COPD: t('COPD'),
    CKD: t('Chronic kidney disease'),
    HEART_FAILURE: t('Heart failure'),
  };
  return labels[code as RegisterCode] ?? code;
}

export function processLabel(code: string): string {
  const labels: Record<string, string> = {
    HBA1C: t('HbA1c'),
    BLOOD_PRESSURE: t('Blood pressure'),
    CREATININE: t('Kidney function (creatinine / eGFR)'),
    URINE_ACR: t('Urine albumin–creatinine ratio'),
    CHOLESTEROL: t('Cholesterol'),
    WEIGHT: t('Weight / BMI'),
    FOOT_EXAM: t('Foot examination'),
    RETINAL_SCREENING: t('Eye (retinal) screening'),
    SMOKING_STATUS: t('Smoking status'),
    INFLUENZA_VACCINATION: t('Influenza vaccination'),
    INHALER_TECHNIQUE: t('Inhaler technique checked'),
    ACTION_PLAN: t('Written asthma action plan'),
    SPIROMETRY: t('Spirometry'),
    POTASSIUM: t('Potassium'),
  };
  return labels[code] ?? code;
}

export function resultLabel(code: string): string {
  const labels: Record<string, string> = {
    NORMAL: t('Normal'),
    ABNORMAL: t('Abnormal'),
    DECLINED: t('Declined by the patient'),
    DONE: t('Done'),
    NON_SMOKER: t('Never smoked'),
    EX_SMOKER: t('Ex-smoker'),
    SMOKER: t('Smoker'),
    OBSTRUCTION: t('Obstruction'),
  };
  return labels[code] ?? code;
}

export function stateLabel(s: ProcessState): string {
  return {
    UP_TO_DATE: t('Up to date|review'),
    DUE_SOON: t('Due soon'),
    DUE: t('Due|review'),
    OVERDUE: t('Overdue'),
  }[s];
}
export const STATE_TONE: Record<ProcessState, Tone> = {
  UP_TO_DATE: 'success',
  DUE_SOON: 'info',
  DUE: 'warning',
  OVERDUE: 'danger',
};

export function targetLabel(code: TargetCode): string {
  return {
    HBA1C: t('HbA1c at target'),
    BP: t('Blood pressure at target'),
    CHOLESTEROL: t('Cholesterol at target'),
  }[code];
}
export function targetDescription(code: TargetCode): string {
  return {
    HBA1C: t('HbA1c ≤ 7.5 % (58 mmol/mol)'),
    BP: t('Below 140/90 mmHg (below 150/90 mmHg from age 80)'),
    CHOLESTEROL: t('Total cholesterol < 5.0 mmol/L'),
  }[code];
}

/** The eGFR and BMI details the server adds ("eGFR ≈ 62 mL/min/1.73 m²", "BMI 27.4"). */
export function detailLabel(detail: string | null): string | null {
  if (!detail) return null;
  const egfr = /^eGFR ≈ (\d+)/.exec(detail);
  if (egfr) return t('eGFR ≈ {value} mL/min/1.73 m²', { value: egfr[1]! });
  const bmi = /^BMI ([\d.]+)$/.exec(detail);
  if (bmi) return t('BMI {value}', { value: formatNumber(Number(bmi[1])) });
  return detail;
}

/* ------------------------------------------------------------------------------ hooks -- */

const KEY = ['registers'] as const;

export const usePatientRegisters = (patientId: string) =>
  useQuery({
    queryKey: ['patient', patientId, 'registers'],
    queryFn: () => api<PatientRegisters>(`/registers/patients/${patientId}`),
  });

export const useRecalls = (query: {
  register?: string;
  state: 'OVERDUE' | 'DUE' | 'ALL';
  q?: string;
  page: number;
}) =>
  useQuery({
    queryKey: [...KEY, 'recalls', query],
    queryFn: () =>
      api<RecallList>('/registers/recalls', {
        query: { ...query, pageSize: 25 },
      }),
  });

export const useIndicators = (query: {
  register?: string;
  groupBy?: string;
  facilityId?: string;
}) =>
  useQuery({
    queryKey: [...KEY, 'indicators', query],
    queryFn: () => api<Indicators>('/registers/indicators', { query }),
  });

function useRegisterMutation<V>(
  patientId: string,
  request: (v: V) => { path: string; body: unknown },
  onDone?: () => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) => {
      const { path, body } = request(v);
      return api(path, { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId, 'registers'] });
      void qc.invalidateQueries({ queryKey: KEY });
      onDone?.();
    },
  });
}

export const useEnrol = (patientId: string, onDone?: () => void) =>
  useRegisterMutation(
    patientId,
    (v: { register: RegisterCode; reason?: string }) => ({
      path: `/registers/patients/${patientId}/enrolments`,
      body: v,
    }),
    onDone,
  );

export const useLeave = (patientId: string, onDone?: () => void) =>
  useRegisterMutation(
    patientId,
    (v: { enrolmentId: string; reason: string }) => ({
      path: `/registers/enrolments/${v.enrolmentId}/leave`,
      body: { reason: v.reason },
    }),
    onDone,
  );

export const useRecordProcess = (patientId: string, onDone?: () => void) =>
  useRegisterMutation(
    patientId,
    (v: {
      register: RegisterCode;
      process: string;
      result: string;
      notes?: string;
      performedAt?: string;
    }) => ({ path: `/registers/patients/${patientId}/care-processes`, body: v }),
    onDone,
  );
