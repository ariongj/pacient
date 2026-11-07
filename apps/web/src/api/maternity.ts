import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Tone } from '../components/ui';
import { t } from '../i18n';
import { api } from './client';

/** API client and types for antenatal care. */

export const RISK_FACTORS = [
  'AGE_UNDER_18',
  'AGE_OVER_40',
  'PREVIOUS_CAESAREAN',
  'PREVIOUS_PRE_ECLAMPSIA',
  'PREVIOUS_STILLBIRTH',
  'PREVIOUS_PRETERM',
  'MULTIPLE_PREGNANCY',
  'DIABETES',
  'GESTATIONAL_DIABETES',
  'HYPERTENSION',
  'BMI_OVER_35',
  'RH_NEGATIVE',
  'SMOKING',
  'ANAEMIA',
  'HIV',
  'HEPATITIS_B',
  'OTHER',
] as const;
export type RiskFactor = (typeof RISK_FACTORS)[number];
/** Added from the date of birth by the server. */
export const AGE_FACTORS: RiskFactor[] = ['AGE_UNDER_18', 'AGE_OVER_40'];
export const LOW_RISK_FACTORS: RiskFactor[] = ['RH_NEGATIVE', 'SMOKING', 'ANAEMIA', 'OTHER'];

export const OUTCOMES = [
  'DELIVERED',
  'MISCARRIAGE',
  'TERMINATION',
  'ECTOPIC',
  'TRANSFERRED_OUT',
] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type PregnancyStatus = 'ONGOING' | Outcome;
export const PRESENTATIONS = ['CEPHALIC', 'BREECH', 'TRANSVERSE', 'UNKNOWN'] as const;
export const URINE_PROTEIN = ['NEGATIVE', 'TRACE', '1+', '2+', '3+'] as const;

export type AlertCode =
  | 'SEVERE_HYPERTENSION'
  | 'PRE_ECLAMPSIA_RISK'
  | 'HYPERTENSION'
  | 'FETAL_HEART_RATE'
  | 'REDUCED_FETAL_MOVEMENTS'
  | 'FUNDAL_HEIGHT'
  | 'MALPRESENTATION'
  | 'PRESENTATION_NOT_RECORDED';
export interface VisitAlert {
  code: AlertCode;
  severity: 'SEVERE' | 'WARNING' | 'INFO';
}

export interface AntenatalVisit {
  id: string;
  visitAt: string;
  gestationDays: number;
  gestation: string;
  systolic: number | null;
  diastolic: number | null;
  weightKg: string | null;
  fundalHeightCm: string | null;
  fetalHeartRate: number | null;
  presentation: string | null;
  urineProtein: string | null;
  oedema: boolean | null;
  fetalMovements: boolean | null;
  nextVisitDate: string | null;
  notes: string | null;
  recordedBy: string | null;
  alerts: VisitAlert[];
}

export type ContactState = 'DONE' | 'DUE' | 'OVERDUE' | 'UPCOMING' | 'NOT_APPLICABLE';
export type KeyTestState = 'DONE' | 'DUE' | 'OVERDUE' | 'NOT_YET' | 'NOT_APPLICABLE';

export interface Pregnancy {
  id: string;
  status: PregnancyStatus;
  facilityName: string;
  bookedBy?: string | null;
  bookedAt: string;
  lmpDate: string | null;
  eddDate: string;
  eddMethod: 'LMP' | 'ULTRASOUND';
  gravida: number;
  para: number;
  riskLevel: 'LOW' | 'HIGH';
  riskFactors?: RiskFactor[];
  otherRiskNote?: string | null;
  endedAt: string | null;
  outcomeNote: string | null;
  bookingGestation: string;
  gestationDays: number;
  gestation: string;
  postTerm: boolean;
  nearEdd: boolean;
  nextVisitDate: string | null;
  visits: AntenatalVisit[];
  schedule: {
    week: number;
    targetDate: string;
    state: ContactState;
    visitAt: string | null;
  }[];
  keyTests: {
    code: string;
    label: string;
    fromWeek: number;
    dueByWeek: number;
    state: KeyTestState;
    doneAtGestation: string | null;
  }[];
}

export interface PatientPregnancies {
  items: Pregnancy[];
  canBook: boolean;
  canEdit: boolean;
}

export type WorklistFilter =
  'ALL' | 'HIGH_RISK' | 'OVERDUE_CONTACT' | 'NEAR_EDD' | 'POST_TERM' | 'ALERTS';
export const WORKLIST_FILTERS: WorklistFilter[] = [
  'ALL',
  'HIGH_RISK',
  'ALERTS',
  'OVERDUE_CONTACT',
  'NEAR_EDD',
  'POST_TERM',
];

export interface WorklistItem {
  id: string;
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    nationalId: string;
    dateOfBirth: string;
    phone: string | null;
  };
  eddDate: string;
  gestation: string;
  riskLevel: 'LOW' | 'HIGH';
  riskFactors: RiskFactor[];
  postTerm: boolean;
  nearEdd: boolean;
  overdueContact: boolean;
  visitCount: number;
  lastVisitAt: string | null;
  nextVisitDate: string | null;
  alerts: VisitAlert[];
}
export interface Worklist {
  items: WorklistItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: Record<WorklistFilter, number>;
}

export interface IndicatorRow {
  municipality: string | null;
  booked: number | null;
  firstTrimesterPct: number | null;
  highRiskPct: number | null;
  delivered: number | null;
  anc4Pct: number | null;
  anc8Pct: number | null;
}
export interface MaternityDashboard {
  scope: 'FACILITY' | 'NATIONAL';
  threshold: number;
  ongoing: Record<
    'total' | 'highRisk' | 'overdueContact' | 'nearEdd' | 'postTerm' | 'alerts',
    number | null
  >;
  indicators: IndicatorRow | null;
  byMunicipality: IndicatorRow[];
  disclaimer: string;
}

/* ------------------------------------------------------------------------------ labels -- */

export function riskFactorLabel(code: string): string {
  const labels: Record<RiskFactor, string> = {
    AGE_UNDER_18: t('Mother under 18'),
    AGE_OVER_40: t('Mother 40 or older'),
    PREVIOUS_CAESAREAN: t('Previous caesarean section'),
    PREVIOUS_PRE_ECLAMPSIA: t('Previous pre-eclampsia'),
    PREVIOUS_STILLBIRTH: t('Previous stillbirth'),
    PREVIOUS_PRETERM: t('Previous preterm birth'),
    MULTIPLE_PREGNANCY: t('Multiple pregnancy (twins or more)'),
    DIABETES: t('Diabetes before pregnancy'),
    GESTATIONAL_DIABETES: t('Gestational diabetes'),
    HYPERTENSION: t('Chronic hypertension'),
    BMI_OVER_35: t('BMI over 35'),
    RH_NEGATIVE: t('Rh negative'),
    SMOKING: t('Smoking'),
    ANAEMIA: t('Anaemia'),
    HIV: t('HIV infection'),
    HEPATITIS_B: t('Hepatitis B'),
    OTHER: t('Other risk factor'),
  };
  return labels[code as RiskFactor] ?? code;
}

export function outcomeLabel(s: PregnancyStatus): string {
  return {
    ONGOING: t('Ongoing|pregnancy'),
    DELIVERED: t('Delivered'),
    MISCARRIAGE: t('Miscarriage'),
    TERMINATION: t('Termination of pregnancy'),
    ECTOPIC: t('Ectopic pregnancy'),
    TRANSFERRED_OUT: t('Care transferred to another facility'),
  }[s];
}

export function alertLabel(code: AlertCode): string {
  return {
    SEVERE_HYPERTENSION: t('Severe hypertension (≥ 160/110)'),
    PRE_ECLAMPSIA_RISK: t('Possible pre-eclampsia – raised blood pressure or protein in urine'),
    HYPERTENSION: t('Raised blood pressure (≥ 140/90)'),
    FETAL_HEART_RATE: t('Fetal heart rate outside 110–160'),
    REDUCED_FETAL_MOVEMENTS: t('Reduced fetal movements'),
    FUNDAL_HEIGHT: t('Fundal height differs from gestation by more than 3 cm'),
    MALPRESENTATION: t('Breech or transverse presentation'),
    PRESENTATION_NOT_RECORDED: t('Record the presentation from 36 weeks'),
  }[code];
}
export const ALERT_TONE: Record<VisitAlert['severity'], Tone> = {
  SEVERE: 'danger',
  WARNING: 'warning',
  INFO: 'info',
};

export function presentationLabel(p: string): string {
  return (
    {
      CEPHALIC: t('Cephalic'),
      BREECH: t('Breech'),
      TRANSVERSE: t('Transverse'),
      UNKNOWN: t('Not determined'),
    }[p] ?? p
  );
}

export function contactStateLabel(s: ContactState): string {
  return {
    DONE: t('Done'),
    DUE: t('Due|contact'),
    OVERDUE: t('Overdue'),
    UPCOMING: t('Upcoming|contact'),
    NOT_APPLICABLE: t('Not applicable'),
  }[s];
}
export const CONTACT_TONE: Record<ContactState, Tone> = {
  DONE: 'success',
  DUE: 'warning',
  OVERDUE: 'danger',
  UPCOMING: 'neutral',
  NOT_APPLICABLE: 'neutral',
};

export function keyTestLabel(code: string): string {
  return (
    {
      BLOOD_GROUP: t('Blood group and antibody screen'),
      HAEMOGLOBIN: t('Haemoglobin'),
      HIV: t('HIV test'),
      SYPHILIS: t('Syphilis test'),
      HEPATITIS_B: t('Hepatitis B (HBsAg)'),
      ANOMALY_SCAN: t('Anomaly scan (18–22 weeks)'),
      GLUCOSE_TOLERANCE: t('Glucose tolerance test (24–28 weeks)'),
    }[code] ?? code
  );
}
export function keyTestStateLabel(s: KeyTestState): string {
  return {
    DONE: t('Done'),
    DUE: t('Due|contact'),
    OVERDUE: t('Overdue'),
    NOT_YET: t('Later in pregnancy'),
    NOT_APPLICABLE: t('Not applicable'),
  }[s];
}
export const KEY_TEST_TONE: Record<KeyTestState, Tone> = {
  DONE: 'success',
  DUE: 'warning',
  OVERDUE: 'danger',
  NOT_YET: 'neutral',
  NOT_APPLICABLE: 'neutral',
};

export function filterLabel(f: WorklistFilter): string {
  return {
    ALL: t('All ongoing'),
    HIGH_RISK: t('High risk'),
    ALERTS: t('Alerts at the last visit'),
    OVERDUE_CONTACT: t('Overdue check-up'),
    NEAR_EDD: t('Due within 14 days'),
    POST_TERM: t('Past 42 weeks'),
  }[f];
}

/** "24+3 weeks". */
export const gestationLabel = (ga: string) => t('{ga} weeks', { ga });

/* ------------------------------------------------------------------------------- hooks -- */

const KEY = ['maternity'] as const;

export const usePatientPregnancies = (patientId: string) =>
  useQuery({
    queryKey: ['patient', patientId, 'pregnancy'],
    queryFn: () => api<PatientPregnancies>(`/maternity/patients/${patientId}`),
  });

export const useMyPregnancy = () =>
  useQuery({
    queryKey: [...KEY, 'mine'],
    queryFn: () =>
      api<{ items: Pregnancy[]; confidentialFromGuardians?: boolean }>('/maternity/mine'),
  });

export const useMaternityWorklist = (query: { filter: WorklistFilter; q?: string; page: number }) =>
  useQuery({
    queryKey: [...KEY, 'worklist', query],
    queryFn: () => api<Worklist>('/maternity/worklist', { query: { ...query, pageSize: 25 } }),
  });

export const useMaternityDashboard = (enabled = true) =>
  useQuery({
    queryKey: [...KEY, 'dashboard'],
    queryFn: () => api<MaternityDashboard>('/maternity/dashboard'),
    enabled,
  });

export interface DatingWarning {
  code: 'EDD_DISCREPANCY';
  days: number;
}

function useMaternityMutation<V, R = unknown>(
  patientId: string,
  request: (v: V) => { path: string; method: 'POST' | 'PATCH'; body: unknown },
  onDone?: (r: R) => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) => {
      const { path, method, body } = request(v);
      return api<R>(path, { method, body });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['patient', patientId, 'pregnancy'] });
      void qc.invalidateQueries({ queryKey: KEY });
      onDone?.(r);
    },
  });
}

export interface BookInput {
  lmpDate?: string;
  scanEdd?: string;
  gravida: number;
  para: number;
  riskFactors: RiskFactor[];
  otherRiskNote?: string;
}

export const useBookPregnancy = (
  patientId: string,
  onDone?: (r: { warnings: DatingWarning[] }) => void,
) =>
  useMaternityMutation<BookInput, { warnings: DatingWarning[] }>(
    patientId,
    (v) => ({ path: `/maternity/patients/${patientId}/pregnancies`, method: 'POST', body: v }),
    onDone,
  );

export const useUpdatePregnancy = (
  patientId: string,
  onDone?: (r: { warnings: DatingWarning[] }) => void,
) =>
  useMaternityMutation<
    { id: string; body: Record<string, unknown> },
    { warnings: DatingWarning[] }
  >(
    patientId,
    (v) => ({ path: `/maternity/pregnancies/${v.id}`, method: 'PATCH', body: v.body }),
    onDone,
  );

export const useRecordVisit = (patientId: string, onDone?: (r: { alerts: VisitAlert[] }) => void) =>
  useMaternityMutation<{ id: string; body: Record<string, unknown> }, { alerts: VisitAlert[] }>(
    patientId,
    (v) => ({ path: `/maternity/pregnancies/${v.id}/visits`, method: 'POST', body: v.body }),
    onDone,
  );

export const useClosePregnancy = (patientId: string, onDone?: () => void) =>
  useMaternityMutation<{ id: string; outcome: Outcome; endedAt?: string; note?: string }>(
    patientId,
    (v) => ({
      path: `/maternity/pregnancies/${v.id}/close`,
      method: 'POST',
      body: { outcome: v.outcome, endedAt: v.endedAt, note: v.note },
    }),
    () => onDone?.(),
  );
