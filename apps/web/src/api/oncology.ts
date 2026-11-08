import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/** API client and types for the cancer registry and tumour boards (/oncology). */

export const LATERALITIES = ['LEFT', 'RIGHT', 'BILATERAL', 'NOT_APPLICABLE', 'UNKNOWN'] as const;
export const BASES_OF_DIAGNOSIS = [
  'HISTOLOGY',
  'CYTOLOGY',
  'CLINICAL_INVESTIGATION',
  'CLINICAL_ONLY',
  'DEATH_CERTIFICATE_ONLY',
] as const;
export const STAGES = ['0', 'I', 'II', 'III', 'IV', 'UNKNOWN'] as const;
export const TUMOUR_GROUPS = [
  'BREAST',
  'LUNG',
  'COLORECTAL',
  'UROLOGY',
  'GYNAECOLOGY',
  'HAEMATOLOGY',
  'HEAD_NECK',
  'SKIN',
  'UPPER_GI',
  'OTHER',
] as const;
export const RECOMMENDATIONS = [
  'SURGERY',
  'CHEMOTHERAPY',
  'RADIOTHERAPY',
  'COMBINED',
  'SURVEILLANCE',
  'PALLIATIVE',
  'MORE_TESTS',
  'OTHER',
] as const;

export type Laterality = (typeof LATERALITIES)[number];
export type BasisOfDiagnosis = (typeof BASES_OF_DIAGNOSIS)[number];
export type Stage = (typeof STAGES)[number];
export type TumourGroup = (typeof TUMOUR_GROUPS)[number];
export type Recommendation = (typeof RECOMMENDATIONS)[number];

/** English labels (translated with t()). */
export const LATERALITY_LABEL: Record<Laterality, string> = {
  LEFT: 'Left|side',
  RIGHT: 'Right|side',
  BILATERAL: 'Both sides|laterality',
  NOT_APPLICABLE: 'Not a paired organ',
  UNKNOWN: 'Side unknown',
};
export const BASIS_LABEL: Record<BasisOfDiagnosis, string> = {
  HISTOLOGY: 'Histology of the primary tumour',
  CYTOLOGY: 'Cytology',
  CLINICAL_INVESTIGATION: 'Clinical investigation (imaging, endoscopy)',
  CLINICAL_ONLY: 'Clinical only',
  DEATH_CERTIFICATE_ONLY: 'Death certificate only',
};
export const STAGE_LABEL: Record<Stage, string> = {
  '0': 'Stage 0 (in situ)',
  I: 'Stage I',
  II: 'Stage II',
  III: 'Stage III',
  IV: 'Stage IV',
  UNKNOWN: 'Stage unknown',
};
export const TUMOUR_GROUP_LABEL: Record<TumourGroup, string> = {
  BREAST: 'Breast',
  LUNG: 'Lung and thorax',
  COLORECTAL: 'Colorectal',
  UROLOGY: 'Urological',
  GYNAECOLOGY: 'Gynaecological',
  HAEMATOLOGY: 'Haematological',
  HEAD_NECK: 'Head and neck',
  SKIN: 'Skin and melanoma',
  UPPER_GI: 'Upper gastrointestinal',
  OTHER: 'General (all sites)',
};
export const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  SURGERY: 'Surgery',
  CHEMOTHERAPY: 'Systemic therapy (chemotherapy)',
  RADIOTHERAPY: 'Radiotherapy',
  COMBINED: 'Combined treatment',
  SURVEILLANCE: 'Surveillance|treatment',
  PALLIATIVE: 'Best supportive / palliative care',
  MORE_TESTS: 'Further investigations',
  OTHER: 'Other',
};
export const REVIEW_STATUS_LABEL = {
  PENDING: 'On the agenda',
  DISCUSSED: 'Discussed',
  DEFERRED: 'Deferred',
} as const;
export const REVIEW_TONE = { PENDING: 'info', DISCUSSED: 'success', DEFERRED: 'neutral' } as const;
export const MEETING_STATUS_LABEL = {
  PLANNED: 'Planned|meeting',
  HELD: 'Held',
  CANCELLED: 'Cancelled',
} as const;
/** Coding warnings returned by the API, by code. */
export const WARNING_LABEL: Record<string, string> = {
  LATERALITY_NOT_PAIRED: 'A side was given for a site that is not a paired organ',
  TOPOGRAPHY_MISMATCH: 'The site code does not match the ICD-10 code',
  BEHAVIOUR_MISMATCH:
    'The behaviour code (/2 in situ, /3 malignant) does not match the ICD-10 code',
  BEHAVIOUR_NOT_MALIGNANT: 'Benign or uncertain behaviour is not normally registered',
  STAGE_MISMATCH: 'The stage does not match the TNM categories or the behaviour',
};

export const ICD10_CANCER = /^(C[0-8][0-9]|C9[0-7]|D0[0-9])(\.[0-9A-Z]{1,2})?$/;
export const TOPOGRAPHY = /^C[0-9]{2}\.[0-9]$/;
export const MORPHOLOGY = /^[0-9]{4}\/[0-3]$/;

export interface CodeLabel {
  code: string;
  label: string;
}

export interface Definitions {
  siteGroups: CodeLabel[];
  pairedSiteGroups: string[];
  morphologies: CodeLabel[];
}

export interface CaseWarning {
  code: string;
  message: string;
}

export interface CaseFields {
  diagnosedOn: string;
  icd10: string;
  topography: string;
  morphology: string;
  laterality: Laterality;
  basisOfDiagnosis: BasisOfDiagnosis;
  tnmT?: string | null;
  tnmN?: string | null;
  tnmM?: string | null;
  stage?: Stage | null;
  tnmEdition?: string | null;
}

export interface CancerCase extends CaseFields {
  id: string;
  patientId: string;
  facilityId: string;
  status: 'ACTIVE' | 'DUPLICATE' | 'WITHDRAWN';
  registeredById: string;
  createdAt: string;
  updatedAt: string;
  siteGroup: string;
  warnings: CaseWarning[];
}

export type ReviewStatus = 'PENDING' | 'DISCUSSED' | 'DEFERRED';

export interface ChartReview {
  id: string;
  meetingId: string;
  cancerCaseId: string | null;
  question: string;
  summary: string | null;
  recommendation: Recommendation | null;
  recommendationText: string | null;
  status: ReviewStatus;
  decidedAt: string | null;
  patientInformedAt: string | null;
  referredBy: string;
  meeting: {
    id: string;
    tumourGroup: TumourGroup;
    scheduledFor: string;
    status: MeetingStatus;
  };
}

export interface PatientOncology {
  cases: CancerCase[];
  reviews: ChartReview[];
}

export interface DcoCandidate {
  deathRecordId: string;
  patientId: string;
  certificateNumber: string | null;
  diedAt: string;
  underlyingCauseIcd10: string;
  facilityName: string | null;
  patient: {
    firstName: string;
    lastName: string;
    nationalId: string;
    dateOfBirth: string;
    sex: string;
  };
}

export type MeetingStatus = 'PLANNED' | 'HELD' | 'CANCELLED';

export interface Meeting {
  id: string;
  facilityId: string;
  tumourGroup: TumourGroup;
  scheduledFor: string;
  chairId: string;
  status: MeetingStatus;
  attendees: string[];
  chair: string | null;
  caseCount?: number;
  pendingCount?: number;
  isChair: boolean;
}

export interface AgendaCase {
  id: string;
  patientId: string;
  patient: {
    firstName: string;
    lastName: string;
    nationalId: string;
    dateOfBirth: string;
    sex: string;
  };
  referredBy: string;
  referredById: string;
  status: ReviewStatus;
  decidedAt: string | null;
  patientInformedAt: string | null;
  /** Only for the chair, the referring doctor and the patient's care team. */
  details: {
    question: string;
    summary: string | null;
    recommendation: Recommendation | null;
    recommendationText: string | null;
    cancerCase: {
      icd10: string;
      topography: string;
      morphology: string;
      stage: Stage | null;
    } | null;
  } | null;
}

export interface MeetingDetail extends Meeting {
  cases: AgendaCase[];
}

export interface RegistryStats {
  fromYear: number;
  toYear: number;
  scope: 'NATIONAL' | 'FACILITY';
  smallCellThreshold: number;
  total: number | null;
  bySite: {
    code: string;
    label: string | null;
    total: number | null;
    male: number | null;
    female: number | null;
  }[];
  byAgeBand: { band: string; male: number | null; female: number | null }[];
  byYear: { year: number; count: number | null }[];
  byStage: { stage: Stage; count: number | null }[];
  byMunicipality: {
    municipality: string;
    count: number | null;
    population: number | null;
    ratePer100k: number | null;
  }[];
  quality: {
    histologicallyVerifiedPct: number | null;
    microscopicallyVerifiedPct: number | null;
    deathCertificateOnlyPct: number | null;
  };
  deathCertificateOnlyCandidates: number | null;
}

const patientKey = (patientId: string) => ['patient', patientId, 'oncology'];

export const useOncologyDefinitions = () =>
  useQuery({
    queryKey: ['oncology', 'definitions'],
    queryFn: () => api<Definitions>('/oncology/definitions'),
    staleTime: Infinity,
  });

export const usePatientOncology = (patientId: string) =>
  useQuery({
    queryKey: patientKey(patientId),
    queryFn: () => api<PatientOncology>(`/oncology/patients/${patientId}`),
  });

function useInvalidate(patientId?: string) {
  const qc = useQueryClient();
  return () => {
    if (patientId) void qc.invalidateQueries({ queryKey: patientKey(patientId) });
    void qc.invalidateQueries({ queryKey: ['oncology'] });
  };
}

export function useRegisterCancer(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: (body: CaseFields & { confirmNotDuplicate?: boolean }) =>
      api<CancerCase>(`/oncology/patients/${patientId}/cases`, { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useUpdateCancer(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<CaseFields> & { id: string }) =>
      api<CancerCase>(`/oncology/cases/${id}`, { method: 'PATCH', body }),
    onSuccess: done,
  });
}

export function useWithdrawCancer(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<CancerCase>(`/oncology/cases/${id}/withdraw`, { method: 'POST', body: { reason } }),
    onSuccess: done,
  });
}

export function useMarkDuplicate(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; duplicateOfId: string; reason: string }) =>
      api<CancerCase>(`/oncology/cases/${id}/mark-duplicate`, { method: 'POST', body }),
    onSuccess: done,
  });
}

export const useDcoCandidates = (enabled = true) =>
  useQuery({
    queryKey: ['oncology', 'dco'],
    queryFn: () => api<{ items: DcoCandidate[] }>('/oncology/dco-candidates'),
    enabled,
  });

export function useRegisterDco() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({
      deathRecordId,
      ...body
    }: {
      deathRecordId: string;
      topography?: string;
      morphology?: string;
      laterality?: Laterality;
    }) =>
      api<CancerCase>(`/oncology/dco-candidates/${deathRecordId}/register`, {
        method: 'POST',
        body,
      }),
    onSuccess: done,
  });
}

export const useRegistryStats = (fromYear?: number, toYear?: number) =>
  useQuery({
    queryKey: ['oncology', 'stats', fromYear ?? '', toYear ?? ''],
    queryFn: () => api<RegistryStats>('/oncology/stats', { query: { fromYear, toYear } }),
  });

export const useMeetings = (when: 'upcoming' | 'past') =>
  useQuery({
    queryKey: ['oncology', 'meetings', when],
    queryFn: () => api<{ items: Meeting[] }>('/oncology/mdt/meetings', { query: { when } }),
  });

export const useMeeting = (id: string | null) =>
  useQuery({
    queryKey: ['oncology', 'meeting', id],
    queryFn: () => api<MeetingDetail>(`/oncology/mdt/meetings/${id}`),
    enabled: Boolean(id),
  });

export function useScheduleMeeting() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (body: { tumourGroup: TumourGroup; scheduledFor: string; chairId?: string }) =>
      api<Meeting>('/oncology/mdt/meetings', { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useUpdateMeeting() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; scheduledFor?: string; chairId?: string }) =>
      api<Meeting>(`/oncology/mdt/meetings/${id}`, { method: 'PATCH', body }),
    onSuccess: done,
  });
}

export function useCancelMeeting() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<Meeting>(`/oncology/mdt/meetings/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: done,
  });
}

export function useHoldMeeting() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, attendees }: { id: string; attendees: string[] }) =>
      api<Meeting>(`/oncology/mdt/meetings/${id}/hold`, { method: 'POST', body: { attendees } }),
    onSuccess: done,
  });
}

export function useAddToMeeting(patientId: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: ({
      meetingId,
      ...body
    }: {
      meetingId: string;
      cancerCaseId?: string;
      question: string;
      summary?: string;
    }) =>
      api(`/oncology/mdt/meetings/${meetingId}/cases`, {
        method: 'POST',
        body: { ...body, patientId },
      }),
    onSuccess: done,
  });
}

export type Decision =
  | { status: 'DISCUSSED'; recommendation: Recommendation; recommendationText: string }
  | { status: 'DEFERRED'; deferToMeetingId: string; note?: string };

export function useRecordDecision() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ reviewId, ...body }: Decision & { reviewId: string }) =>
      api(`/oncology/mdt/cases/${reviewId}/decision`, { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useMarkInformed(patientId?: string) {
  const done = useInvalidate(patientId);
  return useMutation({
    mutationFn: (reviewId: string) =>
      api(`/oncology/mdt/cases/${reviewId}/informed`, { method: 'POST' }),
    onSuccess: done,
  });
}
