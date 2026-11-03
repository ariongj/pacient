import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

export type UnitType =
  | 'GENERAL_WARD'
  | 'SURGICAL_WARD'
  | 'ICU'
  | 'MATERNITY'
  | 'PAEDIATRIC'
  | 'NEONATAL'
  | 'EMERGENCY'
  | 'RADIOLOGY'
  | 'OPERATING_THEATRE';
export const WARD_TYPES: UnitType[] = [
  'GENERAL_WARD',
  'SURGICAL_WARD',
  'ICU',
  'MATERNITY',
  'PAEDIATRIC',
  'NEONATAL',
];
export type BedStatus = 'AVAILABLE' | 'OCCUPIED' | 'CLEANING' | 'OUT_OF_SERVICE';
export type AdmissionSource = 'EMERGENCY' | 'ELECTIVE' | 'TRANSFER' | 'BIRTH';
export type Disposition = 'HOME' | 'TRANSFER' | 'AGAINST_ADVICE' | 'DECEASED' | 'OTHER';

/** Labels evaluated at render time so they follow the current language. */
export const unitTypeLabel = (type: UnitType) =>
  ({
    GENERAL_WARD: t('General ward'),
    SURGICAL_WARD: t('Surgical ward'),
    ICU: t('Intensive care'),
    MATERNITY: t('Maternity'),
    PAEDIATRIC: t('Paediatrics'),
    NEONATAL: t('Neonatal care'),
    EMERGENCY: t('Emergency department'),
    RADIOLOGY: t('Radiology'),
    OPERATING_THEATRE: t('Operating theatre'),
  })[type];
export const bedStatusLabel = (s: BedStatus) =>
  ({
    AVAILABLE: t('Available'),
    OCCUPIED: t('Occupied'),
    CLEANING: t('Being cleaned'),
    OUT_OF_SERVICE: t('Out of service'),
  })[s];
export const sourceLabel = (s: AdmissionSource) =>
  ({
    EMERGENCY: t('From emergency'),
    ELECTIVE: t('Planned'),
    TRANSFER: t('Transfer from another facility'),
    BIRTH: t('Birth'),
  })[s];
export const dispositionLabel = (d: Disposition) =>
  ({
    HOME: t('Home'),
    TRANSFER: t('Transferred to another facility'),
    AGAINST_ADVICE: t('Left against medical advice'),
    DECEASED: t('Deceased'),
    OTHER: t('Other'),
  })[d];

export interface UnitBed {
  id: string;
  label: string;
  status: BedStatus;
}
export interface Unit {
  id: string;
  name: string;
  code: string;
  type: UnitType;
  isActive: boolean;
  beds: UnitBed[];
  total: number;
  occupied: number;
  available: number;
  staff: number;
}

export interface BoardStay {
  admissionId: string;
  patientId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: string;
  temporaryIdentity: string | null;
  attendingDoctorId: string;
  attendingDoctorName: string;
  source: AdmissionSource;
  admittedAt: string;
  daysInHospital: number;
  expectedDischargeAt: string | null;
  /** Only for the attending doctor, unit staff and the care team. */
  reason: string | null;
  mine: boolean;
}
export interface BoardBed {
  id: string;
  label: string;
  status: BedStatus;
  note: string | null;
  stay: BoardStay | null;
}
export interface BoardUnit {
  id: string;
  name: string;
  code: string;
  type: UnitType;
  total: number;
  occupied: number;
  available: number;
  beds: BoardBed[];
  withoutBed: BoardStay[];
}
export interface Board {
  units: BoardUnit[];
  myUnitIds: string[];
}

export interface Movement {
  id: string;
  movedAt: string;
  reason: string | null;
  fromUnitName: string | null;
  fromBedLabel: string | null;
  toUnitName: string | null;
  toBedLabel: string | null;
}
export interface Stay {
  id: string;
  patientId: string;
  status: 'ADMITTED' | 'DISCHARGED' | 'CANCELLED';
  source: AdmissionSource;
  reason: string;
  unitId: string;
  unitName: string | null;
  bedId: string | null;
  bedLabel: string | null;
  attendingDoctorId: string;
  attendingDoctorName: string | null;
  admittingDoctorName: string | null;
  admittedAt: string;
  expectedDischargeAt: string | null;
  dischargedAt: string | null;
  dischargedByName: string | null;
  disposition: Disposition | null;
  dischargeSummary: string | null;
  summarySigned: boolean;
  dischargeSignedAt: string | null;
  releasedToPatientAt: string | null;
  edVisitId: string | null;
  movements: Movement[];
}

export interface StaffMember {
  userId: string;
  fullName: string;
  role: 'DOCTOR' | 'NURSE' | 'RECEPTION';
  specialty: string | null;
  assignedAt: string;
}
export interface Person {
  id: string;
  fullName: string;
  role?: string;
  specialty: string | null;
}
export interface Today {
  admissions: number;
  discharges: number;
  inpatients: number;
  beds: number;
  available: number;
  expectedToday: number;
}

export const boardKey = ['hospital', 'board'] as const;

export function useBoard(mine: boolean) {
  return useQuery({
    queryKey: [...boardKey, mine],
    queryFn: () => api<Board>('/hospital/board', { query: { mine: mine ? 'true' : undefined } }),
    // Beds change all the time: keep the board fresh without a reload.
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
}

export function useUnits(types?: UnitType[], includeInactive = false) {
  return useQuery({
    queryKey: ['hospital', 'units', types?.join(','), includeInactive],
    queryFn: () =>
      api<{ items: Unit[] }>('/hospital/units', {
        query: {
          type: types?.join(','),
          includeInactive: includeInactive ? 'true' : undefined,
        },
      }).then((r) => r.items),
  });
}

export function useHospitalDoctors() {
  return useQuery({
    queryKey: ['hospital', 'doctors'],
    queryFn: () => api<{ items: Person[] }>('/hospital/doctors').then((r) => r.items),
    staleTime: 5 * 60_000,
  });
}

export function usePatientStays(patientId: string) {
  return useQuery({
    queryKey: ['patient', patientId, 'admissions'],
    queryFn: () =>
      api<{ items: Stay[] }>(`/hospital/patients/${patientId}/admissions`).then((r) => r.items),
  });
}

export function useToday(enabled = true) {
  return useQuery({
    queryKey: ['hospital', 'today'],
    queryFn: () => api<Today>('/hospital/today'),
    enabled,
    refetchInterval: 60_000,
  });
}

/** A mutation that refreshes the board, units and the patient's chart afterwards. */
export function useHospitalMutation<V, R = unknown>(
  fn: (vars: V) => Promise<R>,
  opts: { patientId?: string; onDone?: (r: R) => void } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['hospital'] });
      if (opts.patientId) void qc.invalidateQueries({ queryKey: ['patient', opts.patientId] });
      void qc.invalidateQueries({ queryKey: ['patient'] });
      opts.onDone?.(r);
    },
  });
}

/** Age in whole years (or months/days for babies), for bed cards. */
export function shortAge(dateOfBirth: string): string {
  const dob = new Date(dateOfBirth);
  const now = new Date();
  const days = Math.floor((now.getTime() - dob.getTime()) / 86_400_000);
  if (days < 31) return t('{count} d', { count: Math.max(0, days) });
  const months = (now.getFullYear() - dob.getFullYear()) * 12 + now.getMonth() - dob.getMonth();
  if (months < 24) return t('{count} mo', { count: months });
  let years = now.getFullYear() - dob.getFullYear();
  if (
    now.getMonth() < dob.getMonth() ||
    (now.getMonth() === dob.getMonth() && now.getDate() < dob.getDate())
  ) {
    years--;
  }
  return t('{age} y', { age: years });
}

export const sexShort = (sex: string) =>
  sex === 'FEMALE' ? t('F') : sex === 'MALE' ? t('M') : '—';
