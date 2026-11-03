import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/* Emergency department: types and hooks for the board, triage and the chart tab. */

export type TriageLevel = 1 | 2 | 3 | 4 | 5;
export type EdStatus =
  | 'WAITING'
  | 'IN_TREATMENT'
  | 'ADMITTED'
  | 'DISCHARGED'
  | 'TRANSFERRED'
  | 'LEFT_WITHOUT_BEING_SEEN';
export type ArrivalMode = 'WALK_IN' | 'AMBULANCE' | 'REFERRAL' | 'POLICE' | 'OTHER';

export interface EdPatient {
  id: string;
  firstName: string;
  lastName: string;
  nationalId: string;
  dateOfBirth: string;
  sex: string;
  temporaryIdentity: 'NEWBORN' | 'UNIDENTIFIED' | null;
}

export interface EdVitals {
  recordedAt: string;
  systolic: number | null;
  diastolic: number | null;
  heartRate: number | null;
  respiratoryRate: number | null;
  temperature: string | null;
  spo2: number | null;
}

export interface EdBoardItem {
  id: string;
  patient: EdPatient;
  arrivedAt: string;
  arrivalMode: ArrivalMode;
  chiefComplaint: string;
  status: 'WAITING' | 'IN_TREATMENT';
  triageLevel: TriageLevel | null;
  triagedAt: string | null;
  triageNote: string | null;
  assignedDoctor: { id: string; fullName: string | null } | null;
  seenAt: string | null;
  minutesWaiting: number;
  minutesInDepartment: number;
  targetMinutes: number;
  breached: boolean;
  vitals: EdVitals | null;
}

export interface EdDeparted {
  id: string;
  status: EdStatus;
  triageLevel: TriageLevel | null;
  arrivedAt: string;
  departedAt: string;
  admissionId: string | null;
  patient: EdPatient;
}

export interface EdBoard {
  unit: { id: string; name: string; code: string };
  canTreat: boolean;
  targets: Record<'triage' | TriageLevel, number>;
  counts: Record<'awaitingTriage' | 'waiting' | 'inTreatment' | TriageLevel, number>;
  items: EdBoardItem[];
  departed: EdDeparted[];
  doctors: { id: string; fullName: string }[];
  generatedAt: string;
}

export interface EdHistoryItem {
  id: string;
  arrivedAt: string;
  arrivalMode: ArrivalMode;
  chiefComplaint: string;
  triageLevel: TriageLevel | null;
  triageNote: string | null;
  triagedAt: string | null;
  triagedBy: string | null;
  seenAt: string | null;
  assignedDoctor: string | null;
  status: EdStatus;
  departedAt: string | null;
  dispositionNote: string | null;
  admissionId: string | null;
  facilityName: string;
}

/** Five-level triage scale. Colour is never the only signal: the number and name are shown too. */
export const TRIAGE = {
  1: { colour: 'red', name: () => t('Immediate') },
  2: { colour: 'orange', name: () => t('Very urgent') },
  3: { colour: 'yellow', name: () => t('Urgent') },
  4: { colour: 'green', name: () => t('Standard') },
  5: { colour: 'blue', name: () => t('Non-urgent') },
} as const satisfies Record<TriageLevel, { colour: string; name: () => string }>;

export const TRIAGE_GUIDANCE: Record<TriageLevel, () => string> = {
  1: () => t('Life-threatening: airway, breathing or circulation compromised. Resuscitation now.'),
  2: () =>
    t('Very urgent: severe pain, chest pain, reduced consciousness or very abnormal vital signs.'),
  3: () =>
    t('Urgent: moderate pain or stable illness that needs several investigations or treatments.'),
  4: () => t('Standard: minor injury or illness, stable; one simple investigation or treatment.'),
  5: () => t('Non-urgent: could be seen by the family doctor; no investigations needed.'),
};

export const TRIAGE_LEVELS: TriageLevel[] = [1, 2, 3, 4, 5];

export const ARRIVAL_MODES: ArrivalMode[] = ['WALK_IN', 'AMBULANCE', 'REFERRAL', 'POLICE', 'OTHER'];

export const arrivalModeLabel = (m: ArrivalMode) =>
  ({
    WALK_IN: t('Walked in'),
    AMBULANCE: t('Ambulance'),
    REFERRAL: t('Referred'),
    POLICE: t('Police'),
    OTHER: t('Other'),
  })[m];

export const edStatusLabel = (s: EdStatus) =>
  ({
    WAITING: t('Waiting'),
    IN_TREATMENT: t('In treatment'),
    ADMITTED: t('Admitted'),
    DISCHARGED: t('Discharged'),
    TRANSFERRED: t('Transferred'),
    LEFT_WITHOUT_BEING_SEEN: t('Left without being seen'),
  })[s];

/** Display name; unidentified patients are shown with their temporary number. */
export function edPatientName(
  p: Pick<EdPatient, 'firstName' | 'lastName' | 'nationalId' | 'temporaryIdentity'>,
) {
  if (p.temporaryIdentity === 'UNIDENTIFIED') return `${t('Unknown patient')} ${p.nationalId}`;
  return `${p.firstName} ${p.lastName}`;
}

/** Initials only – for screens others can see (big-screen mode). */
export function edPatientInitials(p: EdPatient) {
  if (p.temporaryIdentity === 'UNIDENTIFIED') return `? · ${p.nationalId.slice(-4)}`;
  return `${p.firstName.charAt(0)}. ${p.lastName.charAt(0)}. · ${p.nationalId.slice(-3)}`;
}

/** "1 h 05 min" style durations. */
export function formatMinutes(total: number) {
  if (total < 60) return t('{n} min', { n: total });
  const h = Math.floor(total / 60);
  const m = total % 60;
  return t('{h} h {m} min', { h, m: String(m).padStart(2, '0') });
}

export const ED_KEY = ['ed'] as const;

export function useEdBoard(enabled = true) {
  return useQuery({
    queryKey: [...ED_KEY, 'board'],
    queryFn: () => api<EdBoard>('/ed/board'),
    // Refreshed every 15 s; waiting times also tick locally in between.
    refetchInterval: 15_000,
    enabled,
  });
}

export function useEdHistory(patientId: string) {
  return useQuery({
    queryKey: ['patient', patientId, 'ed-visits'],
    queryFn: () =>
      api<{ items: EdHistoryItem[] }>(`/ed/patients/${patientId}/visits`).then((r) => r.items),
  });
}

/** A mutation that refreshes the board (and the patient's chart) afterwards. */
export function useEdMutation<TVars>(
  request: (vars: TVars) => { path: string; method?: 'POST' | 'PATCH'; body?: unknown },
  onDone?: () => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => {
      const { path, ...opts } = request(vars);
      return api<unknown>(path, { method: 'POST', ...opts });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ED_KEY });
      void qc.invalidateQueries({ queryKey: ['patient'] });
      void qc.invalidateQueries({ queryKey: ['hospital'] });
      onDone?.();
    },
  });
}
