import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api, ApiError, downloadFile } from './client';

/** API client and types for staff rosters and on-call. */

export type ShiftKind = 'DAY' | 'LATE' | 'NIGHT' | 'ON_CALL';
export type WarningCode = 'REST_PERIOD' | 'WEEKLY_HOURS';

export interface Shift {
  id: string;
  userId: string;
  userName: string;
  userRole: string;
  unitId: string | null;
  unitName: string | null;
  kind: ShiftKind;
  specialty: string | null;
  startsAt: string;
  endsAt: string;
  status: 'PLANNED' | 'CANCELLED';
  note: string | null;
  /** Local (Europe/Belgrade) date and times. */
  date: string;
  startTime: string;
  endTime: string;
  hours: number;
}

export interface Unit {
  id: string;
  name: string;
  type: string;
}

export interface RosterMeta {
  kinds: ShiftKind[];
  defaultTimes: Record<ShiftKind, { start: string; end: string }>;
  specialties: string[];
  rules: { minRestHours: number; maxWeekHours: number };
  defaultRatio: { general: number; intensive: number };
  today: string;
  canManage: boolean;
}

export interface Week {
  start: string;
  days: string[];
  units: Unit[];
  shifts: Shift[];
  publications: { at: string; unitId: string | null }[];
}

export interface OnCallPerson {
  shiftId: string;
  userId: string;
  name: string;
  role: string;
  startsAt: string;
  endsAt: string;
}

export interface OnCallItem {
  specialty: string;
  current: OnCallPerson[];
  next: OnCallPerson | null;
}

type ShiftCounts = { nurses: number; ratio: number | null; over: boolean };
export interface StaffingWard {
  unitId: string;
  unitName: string;
  unitType: string;
  beds: number;
  occupied: number;
  threshold: number;
  shifts: Record<'DAY' | 'LATE' | 'NIGHT', ShiftCounts>;
}

export type Gap =
  | { type: 'NO_NIGHT_NURSE'; date: string; unitId: string; unitName: string }
  | { type: 'NO_ON_CALL'; date: string; specialty: string }
  | { type: 'WARD_NOT_ROSTERED'; unitId: string; unitName: string };

export interface Staffing {
  date: string;
  ratio: { general: number; intensive: number };
  wards: StaffingWard[];
  gaps: Gap[];
}

export interface StaffMember {
  id: string;
  fullName: string;
  role: string;
  specialty: string | null;
  unitIds: string[];
}

export interface ShiftInput {
  userId: string;
  unitId?: string | null;
  kind: ShiftKind;
  specialty?: string | null;
  date: string;
  startTime?: string;
  endTime?: string;
  note?: string | null;
  acknowledgedWarnings?: WarningCode[];
  overrideReason?: string;
}

export type BulkInput =
  | {
      mode: 'PATTERN';
      userId: string;
      unitId?: string | null;
      weekStart: string;
      pattern: (ShiftKind | null)[];
      specialty?: string | null;
      acknowledgedWarnings?: WarningCode[];
      overrideReason?: string;
    }
  | {
      mode: 'COPY';
      fromWeekStart: string;
      weekStart: string;
      unitId?: string | null;
      acknowledgedWarnings?: WarningCode[];
      overrideReason?: string;
    };

export interface WorkingTimeWarning {
  code: WarningCode;
  hours: number;
  limit: number;
  userId?: string;
  date?: string;
}

/** Working-time warnings the director can confirm with a reason (409 WORKING_TIME_WARNINGS). */
export function warningsOf(error: unknown): WorkingTimeWarning[] | null {
  if (error instanceof ApiError && error.code === 'WORKING_TIME_WARNINGS') {
    return (error.details as WorkingTimeWarning[]) ?? [];
  }
  return null;
}

export function warningText(w: WorkingTimeWarning): string {
  return w.code === 'REST_PERIOD'
    ? t('Less than {limit} hours of rest between shifts ({hours} h)', {
        limit: w.limit,
        hours: w.hours,
      })
    : t('More than {limit} working hours in the week ({hours} h)', {
        limit: w.limit,
        hours: w.hours,
      });
}

export const KIND_LABEL: Record<ShiftKind, string> = {
  DAY: 'Day shift',
  LATE: 'Late shift',
  NIGHT: 'Night shift',
  ON_CALL: 'On call',
};
/** One-letter codes used in the week grid (translated). */
export const KIND_SHORT: Record<ShiftKind, string> = {
  DAY: 'D|shift',
  LATE: 'L|shift',
  NIGHT: 'N|shift',
  ON_CALL: 'OC|shift',
};
export const kindLabel = (k: ShiftKind) => t(KIND_LABEL[k]);

export const SPECIALTY_LABEL: Record<string, string> = {
  INTERNAL_MEDICINE: 'Internal medicine',
  GENERAL_SURGERY: 'General surgery',
  ANAESTHESIA: 'Anaesthesia',
  CARDIOLOGY: 'Cardiology',
  NEUROLOGY: 'Neurology',
  OBSTETRICS: 'Obstetrics',
  PAEDIATRICS: 'Paediatrics',
  ORTHOPAEDICS: 'Orthopaedics',
  NEUROSURGERY: 'Neurosurgery',
  UROLOGY: 'Urology',
  PSYCHIATRY: 'Psychiatry',
  RADIOLOGY: 'Radiology',
};
export const specialtyLabel = (s: string | null) => (s ? t(SPECIALTY_LABEL[s] ?? s) : '');

/* ------------------------------------------------------------------ dates (local) -------- */

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export function mondayOf(date: string): string {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}
/** A calendar date as a Date at local noon (safe for display in any time zone). */
export const noon = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
};

/* ------------------------------------------------------------------ queries -------------- */

export const useRosterMeta = () =>
  useQuery({ queryKey: ['rosters', 'meta'], queryFn: () => api<RosterMeta>('/rosters/meta') });

export const useWeek = (start: string, unitId: string) =>
  useQuery({
    queryKey: ['rosters', 'week', start, unitId],
    queryFn: () => api<Week>('/rosters/week', { query: { start, unitId: unitId || undefined } }),
  });

export const useMyShifts = () =>
  useQuery({
    queryKey: ['rosters', 'mine'],
    queryFn: () => api<{ from: string; to: string; items: Shift[] }>('/rosters/mine'),
  });

export const useOnCall = () =>
  useQuery({
    queryKey: ['rosters', 'on-call'],
    queryFn: () => api<{ at: string; items: OnCallItem[] }>('/rosters/on-call'),
    refetchInterval: 5 * 60_000,
  });

export const useStaffing = (
  date: string,
  ratioGeneral: number,
  ratioIntensive: number,
  enabled: boolean,
) =>
  useQuery({
    queryKey: ['rosters', 'staffing', date, ratioGeneral, ratioIntensive],
    queryFn: () =>
      api<Staffing>('/rosters/staffing', { query: { date, ratioGeneral, ratioIntensive } }),
    enabled,
  });

export const useRosterStaff = (enabled: boolean) =>
  useQuery({
    queryKey: ['rosters', 'staff'],
    queryFn: () => api<{ staff: StaffMember[]; units: Unit[] }>('/rosters/staff'),
    enabled,
  });

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['rosters'] });
}

export function useSaveShift() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Partial<ShiftInput> }) =>
      id
        ? api<Shift>(`/rosters/shifts/${id}`, { method: 'PATCH', body })
        : api<Shift>('/rosters/shifts', { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useCancelShift() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<Shift>(`/rosters/shifts/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: done,
  });
}

export function useBulk() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (body: BulkInput) =>
      api<{ created: number }>('/rosters/bulk', { method: 'POST', body }),
    onSuccess: done,
  });
}

export function usePublish() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (body: { weekStart: string; unitId?: string | null }) =>
      api<{ notified: number; shifts: number }>('/rosters/publish', { method: 'POST', body }),
    onSuccess: done,
  });
}

export const downloadMyCalendar = () => downloadFile('/rosters/mine.ics', 'pacient-shifts.ics');
