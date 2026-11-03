import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { appointments, availabilityExceptions, doctorAvailability } from '../../db/schema.js';
import {
  addDays,
  daysBetween,
  fromMinutes,
  localTime,
  toMinutes,
  weekdayOf,
  zonedToUtc,
} from './time.js';

export interface Slot {
  start: string;
  end: string;
  minutes: number;
  portalBookable: boolean;
}

/** Appointment states that occupy a doctor's time. */
export const BUSY_STATUSES = ['REQUESTED', 'CONFIRMED', 'CHECKED_IN'] as const;

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  aStart < bEnd && bStart < aEnd;

/**
 * Free slots of a doctor between two local dates (inclusive): the weekly consulting hours, minus
 * exceptions (leave, training), minus appointments that occupy the time, minus anything that
 * starts before `notBefore`. `portalOnly` keeps only blocks patients may book themselves.
 */
export async function freeSlots(
  doctorId: string,
  fromDate: string,
  toDate: string,
  opts: { portalOnly?: boolean; notBefore?: Date } = {},
  executor: Executor = db,
): Promise<Slot[]> {
  const days = daysBetween(fromDate, toDate);
  if (days < 0) return [];
  const blocks = await executor
    .select()
    .from(doctorAvailability)
    .where(and(eq(doctorAvailability.doctorId, doctorId), eq(doctorAvailability.isActive, true)));
  if (!blocks.length) return [];

  // Generous UTC window around the local dates for the busy-time queries.
  const windowStart = new Date(`${fromDate}T00:00:00Z`).getTime() - 86_400_000;
  const windowEnd = new Date(`${toDate}T00:00:00Z`).getTime() + 2 * 86_400_000;
  const [exceptions, booked] = await Promise.all([
    executor
      .select({ startsAt: availabilityExceptions.startsAt, endsAt: availabilityExceptions.endsAt })
      .from(availabilityExceptions)
      .where(
        and(
          eq(availabilityExceptions.doctorId, doctorId),
          lt(availabilityExceptions.startsAt, new Date(windowEnd)),
          gt(availabilityExceptions.endsAt, new Date(windowStart)),
        ),
      ),
    executor
      .select({
        scheduledAt: appointments.scheduledAt,
        durationMinutes: appointments.durationMinutes,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.doctorId, doctorId),
          inArray(appointments.status, [...BUSY_STATUSES]),
          lt(appointments.scheduledAt, new Date(windowEnd)),
          gt(appointments.scheduledAt, new Date(windowStart - 86_400_000)),
        ),
      ),
  ]);
  const busy = [
    ...exceptions.map((e) => [e.startsAt.getTime(), e.endsAt.getTime()] as const),
    ...booked.map(
      (b) =>
        [b.scheduledAt.getTime(), b.scheduledAt.getTime() + b.durationMinutes * 60_000] as const,
    ),
  ];
  const notBefore = opts.notBefore?.getTime() ?? Date.now();

  const byStart = new Map<number, Slot>();
  for (let i = 0; i <= days; i++) {
    const date = addDays(fromDate, i);
    const weekday = weekdayOf(date);
    for (const b of blocks) {
      if (b.weekday !== weekday) continue;
      if (b.validFrom && date < b.validFrom) continue;
      if (b.validUntil && date > b.validUntil) continue;
      if (opts.portalOnly && !b.portalBookable) continue;
      const end = toMinutes(b.endTime);
      for (let m = toMinutes(b.startTime); m + b.slotMinutes <= end; m += b.slotMinutes) {
        const time = fromMinutes(m);
        const start = zonedToUtc(date, time);
        // Skip local times that do not exist (clocks going forward).
        if (!start || localTime(start) !== time) continue;
        const s = start.getTime();
        const e = s + b.slotMinutes * 60_000;
        if (s < notBefore) continue;
        if (busy.some(([bs, be]) => overlaps(s, e, bs, be))) continue;
        const existing = byStart.get(s);
        if (existing) {
          existing.portalBookable ||= b.portalBookable;
          continue;
        }
        byStart.set(s, {
          start: new Date(s).toISOString(),
          end: new Date(e).toISOString(),
          minutes: b.slotMinutes,
          portalBookable: b.portalBookable,
        });
      }
    }
  }
  return [...byStart.values()].sort((a, b) => a.start.localeCompare(b.start));
}
