/**
 * Local-time helpers for consulting hours. Hours are entered as local "HH:MM" in Kosovo
 * (Europe/Belgrade, CET/CEST); slots are stored and compared as UTC instants.
 */
export const SCHEDULING_TZ = 'Europe/Belgrade';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHEDULING_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function parts(d: Date) {
  const p = Object.fromEntries(partsFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour),
    mi: Number(p.minute),
    s: Number(p.second),
  };
}

/** Offset of local time from UTC at instant `d`, in milliseconds (CET +1 h, CEST +2 h). */
export function tzOffsetMs(d: Date): number {
  const p = parts(d);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of a local date and time. Returns null for local times that do not exist
 * (the hour skipped when clocks go forward); for repeated times (clocks go back) the first one.
 */
export function zonedToUtc(date: string, time: string): Date | null {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const candidates = [guess - tzOffsetMs(new Date(guess - 3 * 3_600_000)), guess - tzOffsetMs(new Date(guess))];
  for (const utc of candidates.sort((a, b) => a - b)) {
    const back = new Date(utc);
    if (localDate(back) === date && localTime(back) === time) return back;
  }
  return null;
}

/** "YYYY-MM-DD" of the instant in local time. */
export function localDate(d: Date): string {
  const p = parts(d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** "HH:MM" of the instant in local time. */
export function localTime(d: Date): string {
  const p = parts(d);
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday, for a local calendar date. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return h * 60 + m;
};
export const fromMinutes = (n: number) =>
  `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
