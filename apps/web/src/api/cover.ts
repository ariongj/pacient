import type { Worklist } from './types';
import { t } from '../i18n';

/** A period in which a colleague covers an absent doctor's results. */
export interface CoverArrangement {
  id: string;
  doctorId: string;
  doctorName: string;
  coverDoctorId: string;
  coverDoctorName: string;
  startsAt: string;
  endsAt: string;
  note: string | null;
  cancelledAt: string | null;
  createdById: string;
  createdAt: string;
}

export interface Colleague {
  id: string;
  fullName: string;
  specialty: string | null;
}

/** A critical result waiting for review, as directors see it: no patient identity, no values. */
export interface EscalatedResult {
  id: string;
  orderingDoctor: string;
  minutesWaiting: number;
  level: number;
  coveredBy: string[];
}

type WorklistResult = Worklist['unacknowledgedResults'][number] & { escalationLevel?: number };

export type CoverWorklist = Omit<Worklist, 'unacknowledgedResults'> & {
  unacknowledgedResults: WorklistResult[];
  coveredResults?: (WorklistResult & { orderedById: string; orderedBy: string })[];
};

export type CoverState = 'CURRENT' | 'UPCOMING' | 'ENDED' | 'CANCELLED';

export function coverState(a: CoverArrangement, now = Date.now()): CoverState {
  if (a.cancelledAt) return 'CANCELLED';
  if (new Date(a.endsAt).getTime() <= now) return 'ENDED';
  if (new Date(a.startsAt).getTime() > now) return 'UPCOMING';
  return 'CURRENT';
}

export function waited(minutes: number): string {
  if (minutes < 60) return t('{m} min', { m: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? t('{h} h {m} min', { h, m }) : t('{h} h', { h });
}
