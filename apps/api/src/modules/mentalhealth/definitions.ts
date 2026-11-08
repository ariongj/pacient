/**
 * Mental health safeguards: legal steps of an involuntary admission and the rules for restrictive
 * interventions.
 *
 * ILLUSTRATIVE – the time limits follow the structure of the Kosovo Law on Mental Health
 * (independent second examination, notification of the competent court, court decision, periodic
 * review of the authorisation) but the exact hours and days must be confirmed by legal counsel and
 * the Ministry before use with real patients. They are kept here, in one place, so they can be
 * changed without touching the workflow.
 */

export const GROUNDS = ['DANGER_TO_SELF', 'DANGER_TO_OTHERS', 'SEVERE_SELF_NEGLECT'] as const;
export type Ground = (typeof GROUNDS)[number];

/** Hours after the start of the involuntary admission. */
export const SECOND_OPINION_HOURS = 24;
export const RIGHTS_EXPLAINED_HOURS = 24;
export const REPRESENTATIVE_NOTIFIED_HOURS = 24;
export const COURT_NOTIFICATION_HOURS = 48;
/** Hours after the court was notified. */
export const COURT_DECISION_HOURS = 72;
/** Longest authorisation a single court decision may give (days). */
export const MAX_AUTHORISATION_DAYS = 90;
/** Remind this many days before the authorisation ends. */
export const AUTHORISATION_WARNING_DAYS = 7;

export const LEGAL_STEPS = [
  'SECOND_OPINION',
  'RIGHTS_EXPLAINED',
  'REPRESENTATIVE_NOTIFIED',
  'COURT_NOTIFIED',
  'COURT_DECISION',
  'AUTHORISATION_REVIEW',
] as const;
export type LegalStep = (typeof LEGAL_STEPS)[number];

export const END_REASONS = ['DISCHARGED', 'BECAME_VOLUNTARY', 'TRANSFERRED', 'OTHER'] as const;

export const RESTRICTIVE_KINDS = [
  'PHYSICAL_RESTRAINT',
  'MECHANICAL_RESTRAINT',
  'SECLUSION',
  'RAPID_TRANQUILLISATION',
] as const;
export type RestrictiveKind = (typeof RESTRICTIVE_KINDS)[number];

/** Observation at least every 15 minutes while restraint or seclusion continues. */
export const OBSERVATION_INTERVAL_MINUTES = 15;
/** A debrief with the patient (and staff) within 72 hours after it ends. */
export const DEBRIEF_HOURS = 72;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type StepStatus = 'DONE' | 'PENDING' | 'DUE_SOON' | 'OVERDUE' | 'NOT_APPLICABLE';

export interface InvoluntaryTimes {
  status: string;
  startedAt: Date;
  secondOpinionAt: Date | null;
  rightsExplainedAt: Date | null;
  representativeNotifiedAt: Date | null;
  courtNotifiedAt: Date | null;
  courtDecisionAt: Date | null;
  courtDecision: string | null;
  authorisedUntil: Date | null;
}

export interface LegalStepState {
  step: LegalStep;
  dueAt: Date | null;
  doneAt: Date | null;
  status: StepStatus;
}

/** Due within the next six hours (or, for the authorisation, within the warning period). */
const SOON_MS = 6 * HOUR;

function state(
  step: LegalStep,
  dueAt: Date | null,
  doneAt: Date | null,
  active: boolean,
  now: Date,
  soonMs = SOON_MS,
): LegalStepState {
  if (doneAt) return { step, dueAt, doneAt, status: 'DONE' };
  if (!active || !dueAt) return { step, dueAt, doneAt: null, status: 'NOT_APPLICABLE' };
  const left = dueAt.getTime() - now.getTime();
  return {
    step,
    dueAt,
    doneAt: null,
    status: left < 0 ? 'OVERDUE' : left <= soonMs ? 'DUE_SOON' : 'PENDING',
  };
}

/**
 * The legal steps of an involuntary admission with their due times and state. Once the admission
 * has ended (or was released), steps not done are no longer applicable.
 */
export function legalSteps(ia: InvoluntaryTimes, now = new Date()): LegalStepState[] {
  const active = ia.status === 'ACTIVE';
  const start = ia.startedAt.getTime();
  const at = (ms: number) => new Date(start + ms);
  const courtDecisionDue = ia.courtNotifiedAt
    ? new Date(ia.courtNotifiedAt.getTime() + COURT_DECISION_HOURS * HOUR)
    : at((COURT_NOTIFICATION_HOURS + COURT_DECISION_HOURS) * HOUR);
  const steps: LegalStepState[] = [
    state('SECOND_OPINION', at(SECOND_OPINION_HOURS * HOUR), ia.secondOpinionAt, active, now),
    state('RIGHTS_EXPLAINED', at(RIGHTS_EXPLAINED_HOURS * HOUR), ia.rightsExplainedAt, active, now),
    state(
      'REPRESENTATIVE_NOTIFIED',
      at(REPRESENTATIVE_NOTIFIED_HOURS * HOUR),
      ia.representativeNotifiedAt,
      active,
      now,
    ),
    state('COURT_NOTIFIED', at(COURT_NOTIFICATION_HOURS * HOUR), ia.courtNotifiedAt, active, now),
    state('COURT_DECISION', courtDecisionDue, ia.courtDecisionAt, active, now),
  ];
  // The authorisation given by the court must be reviewed (renewed or ended) before it runs out.
  if (ia.courtDecision === 'CONFIRMED' && ia.authorisedUntil) {
    steps.push(
      state(
        'AUTHORISATION_REVIEW',
        ia.authorisedUntil,
        null,
        active,
        now,
        AUTHORISATION_WARNING_DAYS * DAY,
      ),
    );
  }
  return steps;
}

export interface RestrictiveTimes {
  kind: string;
  startedAt: Date;
  endedAt: Date | null;
  debriefAt: Date | null;
  observations: { at?: unknown }[];
}

/** Last observation (or the start), when the next is due and whether it is overdue. */
export function observationState(r: RestrictiveTimes, now = new Date()) {
  const times = r.observations
    .map((o) => (typeof o.at === 'string' ? new Date(o.at).getTime() : NaN))
    .filter((t) => Number.isFinite(t));
  const last = times.length ? Math.max(...times) : r.startedAt.getTime();
  // Rapid tranquillisation is an event: monitoring is recorded but not on a 15-minute clock.
  const continuous = r.kind !== 'RAPID_TRANQUILLISATION';
  const nextDueAt =
    !r.endedAt && continuous ? new Date(last + OBSERVATION_INTERVAL_MINUTES * 60_000) : null;
  return {
    lastObservationAt: times.length ? new Date(last) : null,
    nextObservationDueAt: nextDueAt,
    observationOverdue: Boolean(nextDueAt && nextDueAt.getTime() < now.getTime()),
  };
}

/** Debrief due 72 hours after the end; overdue when not recorded by then. */
export function debriefState(r: RestrictiveTimes, now = new Date()) {
  if (!r.endedAt) return { debriefDueAt: null, debriefOverdue: false };
  const due = new Date(r.endedAt.getTime() + DEBRIEF_HOURS * HOUR);
  return { debriefDueAt: due, debriefOverdue: !r.debriefAt && due.getTime() < now.getTime() };
}
