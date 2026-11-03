import { useQuery } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';
import type { Appointment } from './types';

/** Consulting hours are local to Kosovo; slots are shown in that time zone. */
export const SCHEDULING_TZ = 'Europe/Belgrade';

export interface AvailabilityBlock {
  id?: string;
  weekday: number;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  portalBookable: boolean;
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface AvailabilityException {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

export interface Availability {
  doctor: { id: string; fullName: string; specialty: string | null; facilityId: string };
  blocks: AvailabilityBlock[];
  exceptions: AvailabilityException[];
  canEdit: boolean;
}

export interface Slot {
  start: string;
  end: string;
  minutes: number;
  portalBookable: boolean;
}

export interface BookableDoctor {
  id: string;
  fullName: string;
  specialty: string | null;
  facilityId: string;
  facilityName: string | null;
  hasConsultingHours: boolean;
  portalBookable: boolean;
  inCareTeam: boolean;
}

/** Appointment as returned by the API, including how it was booked. */
export type AppointmentWithChannel = Appointment & { bookedVia?: 'STAFF' | 'PORTAL' };

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHEDULING_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: SCHEDULING_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "YYYY-MM-DD" of an instant in Kosovo time. */
export const localDateOf = (d: Date | string) => dateFmt.format(new Date(d));
/** "HH:MM" of an instant in Kosovo time. */
export const slotTime = (d: Date | string) => timeFmt.format(new Date(d));
export const todayLocal = () => localDateOf(new Date());
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** A Date at noon UTC of a calendar date – safe for weekday/day-name formatting anywhere in Europe. */
export const noonOf = (date: string) => new Date(`${date}T12:00:00Z`);

export const weekdayName = (n: number) =>
  [
    t('Sunday'),
    t('Monday'),
    t('Tuesday'),
    t('Wednesday'),
    t('Thursday'),
    t('Friday'),
    t('Saturday'),
  ][n] ?? '';

export const weekdayShort = (n: number) =>
  [t('Sun'), t('Mon'), t('Tue'), t('Wed'), t('Thu'), t('Fri'), t('Sat')][n] ?? '';

export function useBookableDoctors() {
  return useQuery({
    queryKey: ['scheduling', 'doctors'],
    queryFn: () => api<{ items: BookableDoctor[] }>('/scheduling/doctors').then((r) => r.items),
  });
}

export function useSlots(doctorId: string | null | undefined, from: string, to: string) {
  return useQuery({
    queryKey: ['scheduling', 'slots', doctorId, from, to],
    queryFn: () =>
      api<{ from: string; to: string; items: Slot[] }>('/scheduling/slots', {
        query: { doctorId: doctorId!, from, to },
      }),
    enabled: Boolean(doctorId),
  });
}

export function useAvailability(doctorId: string | null | undefined) {
  return useQuery({
    queryKey: ['scheduling', 'availability', doctorId],
    queryFn: () => api<Availability>(`/scheduling/doctors/${doctorId}/availability`),
    enabled: Boolean(doctorId),
  });
}
