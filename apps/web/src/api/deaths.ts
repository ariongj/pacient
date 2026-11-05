import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** API client and types for death registration (WHO medical certificate of cause of death). */

export const PLACES_OF_DEATH = [
  'HOSPITAL',
  'EMERGENCY_DEPARTMENT',
  'HOME',
  'NURSING_HOME',
  'EN_ROUTE',
  'OTHER',
] as const;
export const MANNERS_OF_DEATH = [
  'NATURAL',
  'ACCIDENT',
  'INTENTIONAL_SELF_HARM',
  'ASSAULT',
  'PENDING_INVESTIGATION',
  'UNDETERMINED',
] as const;
export const AUTOPSY_STATUSES = ['NONE', 'REQUESTED', 'PENDING', 'PERFORMED'] as const;
export const PREGNANCY_STATUSES = [
  'NOT_PREGNANT',
  'PREGNANT',
  'WITHIN_42_DAYS',
  'DAYS_43_TO_1_YEAR',
  'UNKNOWN',
] as const;
export const FORENSIC_MANNERS = new Set([
  'ACCIDENT',
  'INTENTIONAL_SELF_HARM',
  'ASSAULT',
  'PENDING_INVESTIGATION',
]);

export type PlaceOfDeath = (typeof PLACES_OF_DEATH)[number];
export type MannerOfDeath = (typeof MANNERS_OF_DEATH)[number];
export type CauseLine = 'a' | 'b' | 'c' | 'd' | 'II';

/** English labels (translated with t()). */
export const PLACE_LABEL: Record<PlaceOfDeath, string> = {
  HOSPITAL: 'Hospital ward',
  EMERGENCY_DEPARTMENT: 'Emergency department',
  HOME: 'Home',
  NURSING_HOME: 'Nursing home',
  EN_ROUTE: 'On the way to hospital',
  OTHER: 'Other place',
};
export const MANNER_LABEL: Record<MannerOfDeath, string> = {
  NATURAL: 'Disease (natural)',
  ACCIDENT: 'Accident',
  INTENTIONAL_SELF_HARM: 'Intentional self-harm',
  ASSAULT: 'Assault',
  PENDING_INVESTIGATION: 'Pending investigation',
  UNDETERMINED: 'Could not be determined',
};
export const AUTOPSY_LABEL: Record<(typeof AUTOPSY_STATUSES)[number], string> = {
  NONE: 'No autopsy',
  REQUESTED: 'Autopsy requested',
  PENDING: 'Autopsy done, findings pending',
  PERFORMED: 'Autopsy findings used',
};
export const PREGNANCY_LABEL: Record<(typeof PREGNANCY_STATUSES)[number], string> = {
  NOT_PREGNANT: 'Not pregnant in the past year',
  PREGNANT: 'Pregnant at the time of death',
  WITHIN_42_DAYS: 'Pregnant within 42 days before death',
  DAYS_43_TO_1_YEAR: 'Pregnant 43 days to 1 year before death',
  UNKNOWN: 'Unknown',
};
export const LINE_LABEL: Record<CauseLine, string> = {
  a: '(a) Immediate cause – disease or condition directly leading to death',
  b: '(b) Due to (or as a consequence of)',
  c: '(c) Due to (or as a consequence of)',
  d: '(d) Underlying condition that started the sequence',
  II: 'Part II – other significant conditions contributing to death',
};

export interface DeathCause {
  line: CauseLine;
  text: string;
  icd10: string | null;
  interval: string | null;
}

export interface Perinatal {
  birthWeightGrams?: number | null;
  gestationWeeks?: number | null;
  multiplePregnancy?: boolean | null;
  stillbirth?: boolean | null;
  hoursSurvived?: number | null;
  maternalConditions?: string | null;
}

export interface DeathFields {
  diedAt: string;
  placeOfDeath: PlaceOfDeath;
  placeDetail?: string | null;
  admissionId?: string | null;
  causes: DeathCause[];
  underlyingCauseIcd10: string;
  mannerOfDeath: MannerOfDeath;
  autopsy: (typeof AUTOPSY_STATUSES)[number];
  pregnancyStatus?: (typeof PREGNANCY_STATUSES)[number] | null;
  perinatal?: Perinatal | null;
  reportedToForensics: boolean;
}

export interface DeathCheck {
  code: string;
  message: string;
  field?: string;
}

export interface DeathRecord extends DeathFields {
  id: string;
  patientId: string;
  status: 'DRAFT' | 'SIGNED';
  certificateNumber: string | null;
  signedAt: string | null;
  certifiedBy: { id: string; name: string | null };
  facility: { id: string; name: string | null; code: string | null };
  original: Partial<DeathFields> | null;
  amendments: {
    id: string;
    changes: Record<string, [unknown, unknown]>;
    reason: string;
    amendedBy: string | null;
    createdAt: string;
  }[];
  civilRegistryAcknowledgedAt: string | null;
  civilRegistryReference: string | null;
  createdAt: string;
  updatedAt: string;
  checks: { problems: DeathCheck[]; warnings: DeathCheck[] };
  canEdit: boolean;
  canAmend: boolean;
  effects?: {
    appointmentsCancelled: number;
    waitingListRemoved: number;
    registersLeft: number;
    portalDisabled: boolean;
  };
}

export interface PatientDeath {
  deceasedAt: string | null;
  openAdmission: boolean;
  canCertify: boolean;
  record: DeathRecord | null;
}

export interface DeathListItem {
  id: string;
  status: 'DRAFT' | 'SIGNED';
  certificateNumber: string | null;
  diedAt: string;
  placeOfDeath: PlaceOfDeath;
  signedAt: string | null;
  createdAt: string;
  civilRegistryAcknowledgedAt: string | null;
  certifiedBy: string | null;
  amendments: number;
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    nationalId: string;
    temporaryIdentity: string | null;
    dateOfBirth: string;
    sex: string;
  };
}

export interface MortalityStats {
  scope: 'FACILITY' | 'NATIONAL';
  from: string;
  to: string;
  suppressionThreshold: number;
  total: number | null;
  byMonth: { month: string; count: number | null }[];
  byChapter: { chapter: string; range: string; label: string; count: number | null }[];
  byAgeBand: { band: string; male: number | null; female: number | null; total: number | null }[];
  byManner: { manner: MannerOfDeath; count: number | null }[];
  inHospital: { deaths: number | null; discharges: number; ratePer100: number | null };
}

const key = (patientId: string) => ['patient', patientId, 'death'] as const;

export const usePatientDeath = (patientId: string, enabled = true) =>
  useQuery({
    queryKey: key(patientId),
    queryFn: () => api<PatientDeath>(`/deaths/patients/${patientId}`),
    enabled,
  });

export const useDeathList = (status: 'DRAFT' | 'SIGNED' | undefined, page: number) =>
  useQuery({
    queryKey: ['deaths', 'list', status ?? 'all', page],
    queryFn: () =>
      api<{ items: DeathListItem[]; page: number; totalPages: number; total: number }>('/deaths', {
        query: { status, page, pageSize: 20 },
      }),
  });

export const useMortalityStats = (from?: string, to?: string) =>
  useQuery({
    queryKey: ['deaths', 'stats', from ?? '', to ?? ''],
    queryFn: () => api<MortalityStats>('/deaths/stats', { query: { from, to } }),
  });

function useInvalidate(patientId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: key(patientId) });
    void qc.invalidateQueries({ queryKey: ['patient', patientId, 'demographics'] });
    void qc.invalidateQueries({ queryKey: ['deaths'] });
  };
}

export function useSaveDeath(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({ id, fields }: { id?: string; fields: DeathFields }) =>
      id
        ? api<DeathRecord>(`/deaths/${id}`, { method: 'PATCH', body: fields })
        : api<DeathRecord>(`/deaths/patients/${patientId}`, { method: 'POST', body: fields }),
    onSuccess: done,
  });
}

export function useDiscardDeath(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: (id: string) => api<void>(`/deaths/${id}`, { method: 'DELETE' }),
    onSuccess: done,
  });
}

export function useSignDeath(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({ id, acknowledgedWarnings }: { id: string; acknowledgedWarnings: string[] }) =>
      api<DeathRecord>(`/deaths/${id}/sign`, { method: 'POST', body: { acknowledgedWarnings } }),
    onSuccess: done,
  });
}

export function useAmendDeath(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({
      id,
      changes,
      reason,
    }: {
      id: string;
      changes: Partial<DeathFields>;
      reason: string;
    }) =>
      api<DeathRecord>(`/deaths/${id}/amendments`, {
        method: 'POST',
        body: { changes, reason },
      }),
    onSuccess: done,
  });
}

/** Lowest completed Part I line – normally the underlying cause. */
export function lowestPartOneCode(causes: DeathCause[]): string | null {
  const partOne = causes.filter((c) => c.line !== 'II' && c.text.trim());
  const order = ['a', 'b', 'c', 'd'];
  const lowest = [...partOne].sort((x, y) => order.indexOf(y.line) - order.indexOf(x.line))[0];
  return lowest?.icd10?.trim().toUpperCase() || null;
}
