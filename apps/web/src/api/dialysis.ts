import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/** API client and types for dialysis. */

export const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Day = (typeof DAYS)[number];
export const SHIFTS = ['MORNING', 'AFTERNOON', 'EVENING'] as const;
export type Shift = (typeof SHIFTS)[number];
export const VASCULAR_ACCESS = [
  'FISTULA',
  'GRAFT',
  'TUNNELLED_CATHETER',
  'TEMPORARY_CATHETER',
] as const;
export type VascularAccess = (typeof VASCULAR_ACCESS)[number];
export const COMPLICATIONS = [
  'HYPOTENSION',
  'CRAMPS',
  'ACCESS_PROBLEM',
  'CLOTTING',
  'FEVER',
  'CHEST_PAIN',
  'OTHER',
] as const;
export type Complication = (typeof COMPLICATIONS)[number];
export const END_REASONS = [
  'TRANSPLANT',
  'TRANSFERRED',
  'RECOVERED',
  'PERITONEAL_DIALYSIS',
  'CONSERVATIVE_CARE',
  'DECEASED',
  'OTHER',
] as const;
export type EndReason = (typeof END_REASONS)[number];
export type SessionStatus = 'PLANNED' | 'IN_PROGRESS' | 'COMPLETED' | 'MISSED' | 'CANCELLED';

export const dayLabel = (d: string) =>
  ({
    MON: t('Mon'),
    TUE: t('Tue'),
    WED: t('Wed'),
    THU: t('Thu'),
    FRI: t('Fri'),
    SAT: t('Sat'),
    SUN: t('Sun'),
  })[d] ?? d;

export const shiftLabel = (s: string) =>
  ({
    MORNING: t('Morning|shift'),
    AFTERNOON: t('Afternoon|shift'),
    EVENING: t('Evening|shift'),
  })[s] ?? s;

export const accessLabel = (a: string) =>
  ({
    FISTULA: t('Arteriovenous fistula'),
    GRAFT: t('Arteriovenous graft'),
    TUNNELLED_CATHETER: t('Tunnelled catheter'),
    TEMPORARY_CATHETER: t('Temporary catheter'),
  })[a] ?? a;

export const complicationLabel = (c: string) =>
  ({
    HYPOTENSION: t('Hypotension'),
    CRAMPS: t('Cramps'),
    ACCESS_PROBLEM: t('Access problem'),
    CLOTTING: t('Clotting of the circuit'),
    FEVER: t('Fever or chills'),
    CHEST_PAIN: t('Chest pain'),
    OTHER: t('Other|complication'),
  })[c] ?? c;

export const endReasonLabel = (r: string) => {
  const [code, ...rest] = r.split(': ');
  const label =
    {
      TRANSPLANT: t('Kidney transplant'),
      TRANSFERRED: t('Transferred to another unit'),
      RECOVERED: t('Kidney function recovered'),
      PERITONEAL_DIALYSIS: t('Changed to peritoneal dialysis'),
      CONSERVATIVE_CARE: t('Conservative care'),
      DECEASED: t('Died'),
      OTHER: t('Other reason'),
    }[code!] ?? code!;
  return rest.length ? `${label}: ${rest.join(': ')}` : label;
};

export const sessionStatusLabel = (s: string) =>
  ({
    PLANNED: t('Planned|dialysis'),
    IN_PROGRESS: t('On dialysis'),
    COMPLETED: t('Completed|dialysis'),
    MISSED: t('Missed|dialysis'),
    CANCELLED: t('Cancelled|dialysis'),
  })[s] ?? s;

export interface Adequacy {
  urr: number | null;
  ktv: number | null;
  meetsTarget: boolean | null;
}

export type Warning =
  | { code: 'IDWG_HIGH'; gainKg: number; percent: number }
  | { code: 'PRE_BP_HIGH'; systolic: number | null; diastolic: number | null }
  | { code: 'PRE_BP_LOW'; systolic: number }
  | { code: 'POST_BP_LOW'; systolic: number }
  | { code: 'BELOW_TARGET_WEIGHT'; kg: number }
  | { code: 'ADEQUACY_BELOW_TARGET' };

export function warningText(w: Warning): string {
  switch (w.code) {
    case 'IDWG_HIGH':
      return t('Weight gain {kg} kg ({percent}% of the target weight)', {
        kg: w.gainKg,
        percent: w.percent,
      });
    case 'PRE_BP_HIGH':
      return t('High blood pressure before dialysis ({bp})', {
        bp: `${w.systolic ?? '—'}/${w.diastolic ?? '—'}`,
      });
    case 'PRE_BP_LOW':
      return t('Low blood pressure before dialysis ({bp})', { bp: w.systolic });
    case 'POST_BP_LOW':
      return t('Low blood pressure after dialysis ({bp})', { bp: w.systolic });
    case 'BELOW_TARGET_WEIGHT':
      return t('{kg} kg below the target weight', { kg: w.kg });
    case 'ADEQUACY_BELOW_TARGET':
      return t('Dialysis dose below target');
  }
}

export interface Schedule {
  id: string;
  patientId: string;
  unitId: string;
  unitName: string | null;
  days: Day[];
  shift: Shift;
  durationMinutes: number;
  targetWeightKg: number | null;
  vascularAccess: VascularAccess;
  status: 'ACTIVE' | 'ENDED';
  startedOn: string;
  endedOn: string | null;
  endReason: string | null;
}

export interface Session {
  id: string;
  patientId: string;
  unitId: string;
  scheduleId: string | null;
  sessionDate: string;
  shift: Shift | null;
  status: SessionStatus;
  machine: string | null;
  startedAt: string | null;
  endedAt: string | null;
  preWeightKg: number | null;
  postWeightKg: number | null;
  preSystolic: number | null;
  preDiastolic: number | null;
  postSystolic: number | null;
  postDiastolic: number | null;
  ultrafiltrationMl: number | null;
  bloodFlowMlMin: number | null;
  preUrea: number | null;
  postUrea: number | null;
  complications: Complication[];
  notes: string | null;
  missedReason: string | null;
  targetWeightKg: number | null;
  interdialyticGainKg: number | null;
  interdialyticGainPercent: number | null;
  adequacy: Adequacy;
  warnings: Warning[];
}

export interface PatientRef {
  id: string;
  firstName: string;
  lastName: string;
  nationalId: string;
  dateOfBirth?: string;
}

export interface BoardSession extends Session {
  patient: PatientRef;
  vascularAccess: VascularAccess | null;
}

export interface DialysisUnit {
  id: string;
  name: string;
  code: string;
  stations: number;
  activePatients: number;
  isStaff: boolean;
  load: Record<Shift, Record<Day, number>>;
}

export interface Board {
  unit: { id: string; name: string };
  date: string;
  shifts: { shift: Shift; stations: number; items: BoardSession[] }[];
}

export interface UnitPatient {
  patient: PatientRef;
  schedule: Schedule;
  lastSessionDate: string | null;
  completed30: number;
  missed30: number;
  lastAdequacy: (Adequacy & { sessionDate: string }) | null;
}

export interface Targets {
  ktv: number;
  urr: number;
}

export interface PatientDialysis {
  schedules: Schedule[];
  sessions: Session[];
  monthlyAdequacy: (Adequacy & { month: string; sessionDate: string })[];
  targets: Targets;
  canSchedule: boolean;
  units: { id: string; name: string }[];
}

export interface DialysisStats {
  scope: 'FACILITY' | 'NATIONAL';
  items: {
    facilityId: string;
    facilityName: string;
    patientsOnDialysis: number | null;
    sessionsByMonth: { month: string; completed: number | null; missed: number | null }[];
    completed90: number | null;
    measuredPercent: number | null;
    meetingTargetPercent: number | null;
    missedPercent: number | null;
  }[];
  targets: Targets;
  smallCellThreshold: number | null;
}

const KEY = ['dialysis'] as const;

export const useDialysisUnits = (enabled = true) =>
  useQuery({
    queryKey: [...KEY, 'units'],
    queryFn: () => api<{ items: DialysisUnit[]; shifts: Shift[]; days: Day[] }>('/dialysis/units'),
    enabled,
  });

export const useDialysisBoard = (unitId: string | undefined, date: string) =>
  useQuery({
    queryKey: [...KEY, 'board', unitId ?? '', date],
    queryFn: () => api<Board>(`/dialysis/units/${unitId}/board`, { query: { date } }),
    enabled: Boolean(unitId),
    refetchInterval: 60_000,
  });

export const useDialysisPatients = (unitId: string | undefined) =>
  useQuery({
    queryKey: [...KEY, 'patients', unitId ?? ''],
    queryFn: () =>
      api<{ items: UnitPatient[]; targets: Targets }>(`/dialysis/units/${unitId}/patients`),
    enabled: Boolean(unitId),
  });

export const usePatientDialysis = (patientId: string) =>
  useQuery({
    queryKey: ['patient', patientId, 'dialysis'],
    queryFn: () => api<PatientDialysis>(`/dialysis/patients/${patientId}`),
  });

export const useDialysisStats = (enabled = true) =>
  useQuery({
    queryKey: [...KEY, 'stats'],
    queryFn: () => api<DialysisStats>('/dialysis/stats'),
    enabled,
  });

/** POST/PATCH helper for every dialysis action; refreshes the board, lists and the chart. */
export function useDialysisAction<TBody = Record<string, unknown>>(
  build: (body: TBody) => { path: string; method?: 'POST' | 'PATCH'; body?: unknown },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => {
      const r = build(body);
      return api<Record<string, unknown>>(r.path, { method: r.method ?? 'POST', body: r.body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ['patient'] });
    },
  });
}
