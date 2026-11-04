/**
 * When is the next dose due? Uses the structured frequency code when present, otherwise the
 * free-text frequency (English, Albanian, Serbian).
 */
const CODE_HOURS: Record<string, number | 'ONCE' | 'PRN'> = {
  QD: 24,
  OD: 24,
  BID: 12,
  TID: 8,
  QID: 6,
  Q4H: 4,
  Q6H: 6,
  Q8H: 8,
  Q12H: 12,
  QHS: 24,
  WEEKLY: 168,
  STAT: 'ONCE',
  ONCE: 'ONCE',
  PRN: 'PRN',
};

const word = (alternatives: string) =>
  new RegExp(`(?<![\\p{L}\\d])(?:${alternatives})(?![\\p{L}\\d])`, 'iu');
const TEXT_PER_DAY: [RegExp, number][] = [
  [word('four times|4 ?x|katër herë|četiri puta|qid|qds'), 4],
  [word('three times|3 ?x|tri herë|tre herë|tri puta|tid|tds'), 3],
  [word('twice|2 ?x|dy herë|dva puta|bid|bd'), 2],
  [word('once|1 ?x|një herë|jednom|qd|od|daily|në ditë|dnevno'), 1],
];
/** "3 times a day", "3 herë në ditë", "3 puta dnevno". */
const NUMERIC_PER_DAY = /(?<!\d)([1-6])\s*(?:x|times|herë|here|puta)(?![\p{L}\d])/iu;

export interface DoseInterval {
  /** Hours between doses, or null when it cannot be derived. */
  hours: number | null;
  once: boolean;
  asNeeded: boolean;
}

export function doseInterval(rx: {
  frequency: string;
  frequencyCode?: string | null;
  asNeeded?: boolean | null;
}): DoseInterval {
  const asNeeded =
    Boolean(rx.asNeeded) || /\bprn\b|sipas nevojës|po potrebi|as needed/i.test(rx.frequency);
  const code = rx.frequencyCode ? CODE_HOURS[rx.frequencyCode.toUpperCase()] : undefined;
  if (code === 'ONCE') return { hours: null, once: true, asNeeded };
  if (code === 'PRN') return { hours: null, once: false, asNeeded: true };
  if (typeof code === 'number') return { hours: code, once: false, asNeeded };
  if (/\bstat\b|single dose|vetëm një herë|jednokratno/i.test(rx.frequency)) {
    return { hours: null, once: true, asNeeded };
  }
  const every = /every\s+(\d{1,3})\s*h|çdo\s+(\d{1,3})\s*or|svakih\s+(\d{1,3})\s*(?:h|sat)/i.exec(
    rx.frequency,
  );
  if (every) return { hours: Number(every[1] ?? every[2] ?? every[3]), once: false, asNeeded };
  const numeric = NUMERIC_PER_DAY.exec(rx.frequency);
  const perDay = numeric
    ? Number(numeric[1])
    : TEXT_PER_DAY.find(([re]) => re.test(rx.frequency))?.[1];
  return { hours: perDay ? 24 / perDay : null, once: false, asNeeded };
}

/** Tolerance around the due time (minutes). */
export const DUE_WINDOW_MINUTES = 60;

export type TimingProblem = 'NOT_DUE' | 'ALREADY_GIVEN' | null;

export interface TimingResult {
  problem: TimingProblem;
  lastGivenAt: Date | null;
  nextDueAt: Date | null;
}

export function timingCheck(
  interval: DoseInterval,
  lastGivenAt: Date | null,
  now = new Date(),
): TimingResult {
  if (!lastGivenAt) return { problem: null, lastGivenAt: null, nextDueAt: null };
  if (interval.once) return { problem: 'ALREADY_GIVEN', lastGivenAt, nextDueAt: null };
  const sinceMin = (now.getTime() - lastGivenAt.getTime()) / 60_000;
  if (
    sinceMin < DUE_WINDOW_MINUTES &&
    (interval.hours === null || interval.hours * 60 > DUE_WINDOW_MINUTES * 2)
  ) {
    return {
      problem: 'ALREADY_GIVEN',
      lastGivenAt,
      nextDueAt: interval.hours
        ? new Date(lastGivenAt.getTime() + interval.hours * 3_600_000)
        : null,
    };
  }
  if (interval.hours === null) return { problem: null, lastGivenAt, nextDueAt: null };
  const nextDueAt = new Date(lastGivenAt.getTime() + interval.hours * 3_600_000);
  if (now.getTime() < nextDueAt.getTime() - DUE_WINDOW_MINUTES * 60_000) {
    return { problem: 'NOT_DUE', lastGivenAt, nextDueAt };
  }
  return { problem: null, lastGivenAt, nextDueAt };
}
