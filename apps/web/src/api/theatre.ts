import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

export type SurgeryStatus =
  'REQUESTED' | 'SCHEDULED' | 'IN_THEATRE' | 'COMPLETED' | 'POSTPONED' | 'CANCELLED';
export type SurgeryPriority = 'ELECTIVE' | 'URGENT' | 'EMERGENCY';
export type Laterality = 'LEFT' | 'RIGHT' | 'BILATERAL' | 'NOT_APPLICABLE';
export type AnaesthesiaType =
  'GENERAL' | 'SPINAL' | 'EPIDURAL' | 'REGIONAL_BLOCK' | 'LOCAL' | 'SEDATION';
export type ChecklistStep = 'signIn' | 'timeOut' | 'signOut';

export interface ChecklistEntry {
  answers: Record<string, unknown>;
  by: { id: string; name: string };
  at: string;
}
export type Checklist = Partial<Record<ChecklistStep, ChecklistEntry>> & {
  consentWaiver?: { reason: string; by: { id: string; name: string }; at: string };
  postponements?: { reason: string; by: { id: string; name: string }; at: string }[];
};

export interface SurgicalCase {
  id: string;
  patientId: string;
  theatreUnitId: string | null;
  procedure: string;
  procedureCode: string | null;
  laterality: Laterality;
  priority: SurgeryPriority;
  indication?: string;
  primarySurgeonId: string;
  assistantId: string | null;
  anaesthetistId: string | null;
  anaesthesiaType: AnaesthesiaType | null;
  scheduledStart: string | null;
  estimatedMinutes: number;
  status: SurgeryStatus;
  consentRecordId: string | null;
  checklist?: Checklist;
  progress: Record<ChecklistStep, boolean>;
  inTheatreAt: string | null;
  incisionAt: string | null;
  closureAt: string | null;
  outOfTheatreAt: string | null;
  operationNote?: string | null;
  complications?: string | null;
  estimatedBloodLossMl?: number | null;
  noteSignedAt: string | null;
  noteSignedBy: string | null;
  cancelReason: string | null;
  createdAt: string;
  surgeon: string;
  assistant: string | null;
  anaesthetist: string | null;
  patientFirstName: string;
  patientLastName: string;
  patientNationalId: string;
  patientDateOfBirth: string;
  patientSex: string;
  patientTemporaryIdentity: 'NEWBORN' | 'UNIDENTIFIED' | null;
}

/** What a patient sees of their operations. */
export interface PatientSurgery {
  id: string;
  procedure: string;
  laterality: Laterality;
  status: SurgeryStatus;
  scheduledStart: string | null;
  outOfTheatreAt: string | null;
  surgeon: string;
}

export interface Theatre {
  id: string;
  name: string;
  code: string;
}

export interface TheatreSchedule {
  date: string;
  theatres: Theatre[];
  items: SurgicalCase[];
  isTheatreStaff: boolean;
}

export const STATUS_LABELS: Record<SurgeryStatus, () => string> = {
  REQUESTED: () => t('Requested'),
  SCHEDULED: () => t('Scheduled'),
  IN_THEATRE: () => t('In theatre'),
  COMPLETED: () => t('Completed'),
  POSTPONED: () => t('Postponed'),
  CANCELLED: () => t('Cancelled'),
};
export const STATUS_TONES: Record<
  SurgeryStatus,
  'info' | 'warning' | 'success' | 'neutral' | 'danger'
> = {
  REQUESTED: 'warning',
  SCHEDULED: 'info',
  IN_THEATRE: 'danger',
  COMPLETED: 'success',
  POSTPONED: 'warning',
  CANCELLED: 'neutral',
};
export const PRIORITY_LABELS: Record<SurgeryPriority, () => string> = {
  ELECTIVE: () => t('Elective'),
  URGENT: () => t('Urgent'),
  EMERGENCY: () => t('Emergency'),
};
export const LATERALITY_LABELS: Record<Laterality, () => string> = {
  LEFT: () => t('Left'),
  RIGHT: () => t('Right'),
  BILATERAL: () => t('Both sides'),
  NOT_APPLICABLE: () => t('Side not applicable'),
};
export const ANAESTHESIA_LABELS: Record<AnaesthesiaType, () => string> = {
  GENERAL: () => t('General anaesthesia'),
  SPINAL: () => t('Spinal anaesthesia'),
  EPIDURAL: () => t('Epidural anaesthesia'),
  REGIONAL_BLOCK: () => t('Regional block'),
  LOCAL: () => t('Local anaesthesia'),
  SEDATION: () => t('Sedation'),
};

/** Procedure with the side, e.g. "Inguinal hernia repair – right". */
export function procedureLabel(c: { procedure: string; laterality: Laterality }) {
  return c.laterality === 'NOT_APPLICABLE'
    ? c.procedure
    : t('{procedure} – {side}', {
        procedure: c.procedure,
        side: LATERALITY_LABELS[c.laterality](),
      });
}

export const patientLabel = (c: SurgicalCase) =>
  c.patientTemporaryIdentity === 'UNIDENTIFIED'
    ? t('Unknown patient {code}', { code: c.patientLastName })
    : `${c.patientFirstName} ${c.patientLastName}`;

/** Query keys live under ['hospital'] so `hospital.board` live events refresh them. */
const KEY = ['hospital', 'theatre'] as const;

export function useTheatres() {
  return useQuery({
    queryKey: [...KEY, 'theatres'],
    queryFn: () => api<{ items: Theatre[]; isTheatreStaff: boolean }>('/theatre/theatres'),
  });
}

export function useTheatreSchedule(date: string) {
  return useQuery({
    queryKey: [...KEY, 'schedule', date],
    queryFn: () => api<TheatreSchedule>('/theatre/schedule', { query: { date } }),
    refetchInterval: 60_000,
  });
}

export function useTheatreRequests(enabled = true) {
  return useQuery({
    queryKey: [...KEY, 'requests'],
    queryFn: () => api<{ items: SurgicalCase[] }>('/theatre/requests').then((r) => r.items),
    enabled,
  });
}

export function useSurgicalCase(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'case', id],
    queryFn: () => api<SurgicalCase>(`/theatre/cases/${id}`),
    enabled: Boolean(id),
  });
}

export function usePatientSurgeries(patientId: string) {
  return useQuery({
    queryKey: ['patient', patientId, 'surgery'],
    queryFn: () =>
      api<{ items: (SurgicalCase | PatientSurgery)[] }>(
        `/theatre/patients/${patientId}/cases`,
      ).then((r) => r.items),
  });
}

export function useFacilityDoctors() {
  return useQuery({
    queryKey: [...KEY, 'doctors'],
    queryFn: () =>
      api<{ items: { id: string; fullName: string; specialty: string | null }[] }>(
        '/theatre/doctors',
      ).then((r) => r.items),
    staleTime: 5 * 60_000,
  });
}

/** POST to a theatre endpoint and refresh every theatre view and the patient's chart. */
export function useTheatreAction<TVars>(
  request: (vars: TVars) => { path: string; body?: unknown },
  onDone?: () => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => {
      const { path, body } = request(vars);
      return api<SurgicalCase>(`/theatre${path}`, { method: 'POST', body: body ?? {} });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['hospital'] });
      void qc.invalidateQueries({ queryKey: ['patient'] });
      onDone?.();
    },
  });
}

/* WHO Surgical Safety Checklist questions, per step. */
export type ChecklistItem =
  | { key: string; kind: 'confirm'; label: () => string }
  | {
      key: string;
      kind: 'choice';
      label: () => string;
      options: { value: string; label: () => string }[];
    }
  | { key: string; kind: 'text'; label: () => string; optional?: boolean };

const yesNo = [
  { value: 'NO', label: () => t('No') },
  { value: 'YES', label: () => t('Yes') },
];

export const CHECKLIST: Record<
  ChecklistStep,
  { title: () => string; hint: () => string; items: ChecklistItem[] }
> = {
  signIn: {
    title: () => t('WHO sign in'),
    hint: () => t('Before induction of anaesthesia'),
    items: [
      {
        key: 'identityConfirmed',
        kind: 'confirm',
        label: () => t('Patient has confirmed identity, site, procedure and consent'),
      },
      {
        key: 'siteMarked',
        kind: 'choice',
        label: () => t('Site marked'),
        options: [
          { value: 'YES', label: () => t('Yes') },
          { value: 'NOT_APPLICABLE', label: () => t('Not applicable') },
        ],
      },
      { key: 'consentConfirmed', kind: 'confirm', label: () => t('Consent confirmed') },
      {
        key: 'anaesthesiaCheckComplete',
        kind: 'confirm',
        label: () => t('Anaesthesia machine and medication check complete'),
      },
      {
        key: 'pulseOximeterFunctioning',
        kind: 'confirm',
        label: () => t('Pulse oximeter on the patient and functioning'),
      },
      { key: 'knownAllergy', kind: 'choice', label: () => t('Known allergy?'), options: yesNo },
      {
        key: 'difficultAirwayRisk',
        kind: 'choice',
        label: () => t('Difficult airway or aspiration risk?'),
        options: yesNo,
      },
      {
        key: 'bloodLossRisk',
        kind: 'choice',
        label: () => t('Risk of more than 500 ml blood loss (7 ml/kg in children)?'),
        options: yesNo,
      },
    ],
  },
  timeOut: {
    title: () => t('WHO time out'),
    hint: () => t('Before skin incision'),
    items: [
      {
        key: 'teamIntroduced',
        kind: 'confirm',
        label: () => t('All team members introduced by name and role'),
      },
      {
        key: 'patientSiteProcedureConfirmed',
        kind: 'confirm',
        label: () => t('Patient, site and procedure confirmed'),
      },
      {
        key: 'antibioticProphylaxis',
        kind: 'choice',
        label: () => t('Antibiotic prophylaxis given within the last 60 minutes'),
        options: [
          { value: 'GIVEN', label: () => t('Given') },
          { value: 'NOT_APPLICABLE', label: () => t('Not applicable') },
        ],
      },
      {
        key: 'criticalEventsReviewed',
        kind: 'confirm',
        label: () => t('Anticipated critical events reviewed (surgeon, anaesthesia, nursing)'),
      },
      {
        key: 'imagingDisplayed',
        kind: 'choice',
        label: () => t('Essential imaging displayed'),
        options: [
          { value: 'YES', label: () => t('Yes') },
          { value: 'NOT_APPLICABLE', label: () => t('Not applicable') },
        ],
      },
    ],
  },
  signOut: {
    title: () => t('WHO sign out'),
    hint: () => t('Before the patient leaves the operating room'),
    items: [
      {
        key: 'procedureRecorded',
        kind: 'confirm',
        label: () => t('Name of the procedure recorded'),
      },
      {
        key: 'countsCorrect',
        kind: 'choice',
        label: () => t('Instrument, sponge and needle counts correct'),
        options: [
          { value: 'true', label: () => t('Correct') },
          { value: 'false', label: () => t('Not correct') },
        ],
      },
      {
        key: 'countsNote',
        kind: 'text',
        label: () => t('If not correct: what was done'),
        optional: true,
      },
      {
        key: 'specimenLabelled',
        kind: 'choice',
        label: () => t('Specimen labelled (including patient name)'),
        options: [
          { value: 'YES', label: () => t('Yes') },
          { value: 'NOT_APPLICABLE', label: () => t('No specimen') },
        ],
      },
      {
        key: 'equipmentProblems',
        kind: 'text',
        label: () => t('Equipment problems to be addressed'),
        optional: true,
      },
      {
        key: 'recoveryConcerns',
        kind: 'text',
        label: () => t('Key concerns for recovery and management'),
        optional: true,
      },
    ],
  },
};
