/** Fixed lists for patient safety incident reporting (mirrored by CHECK constraints in 0018). */
export const INCIDENT_CATEGORIES = [
  'MEDICATION',
  'FALL',
  'PRESSURE_INJURY',
  'IDENTIFICATION',
  'TRANSFUSION',
  'DIAGNOSTIC',
  'SURGICAL',
  'INFECTION',
  'EQUIPMENT',
  'IT_SYSTEM',
  'COMMUNICATION',
  'VIOLENCE',
  'OTHER',
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

/** Harm levels, least to most severe. */
export const HARM_LEVELS = ['NEAR_MISS', 'NO_HARM', 'LOW', 'MODERATE', 'SEVERE', 'DEATH'] as const;
export type HarmLevel = (typeof HARM_LEVELS)[number];

/** Harm at which the patient (or family) must be told before the review can be closed. */
export const DISCLOSURE_HARM: ReadonlySet<HarmLevel> = new Set(['MODERATE', 'SEVERE', 'DEATH']);
/** Harm at which reviewers are alerted as a serious incident. */
export const SERIOUS_HARM: ReadonlySet<HarmLevel> = new Set(['SEVERE', 'DEATH']);

export const INCIDENT_STATUSES = ['NEW', 'UNDER_REVIEW', 'ACTION_PLANNED', 'CLOSED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const CONTRIBUTING_FACTORS = [
  'PATIENT',
  'TASK',
  'INDIVIDUAL',
  'TEAM',
  'ENVIRONMENT',
  'ORGANISATIONAL',
  'EQUIPMENT',
  'IT_SYSTEM',
  'COMMUNICATION',
  'TRAINING',
] as const;

/** Staff roles that report incidents (the Ministry has no facility). */
export const REPORTER_ROLES = ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'DIRECTOR'] as const;

/** Allowed status changes (reopening a closed review is a director decision with a reason). */
export const TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  NEW: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['ACTION_PLANNED', 'CLOSED'],
  ACTION_PLANNED: ['UNDER_REVIEW', 'CLOSED'],
  CLOSED: ['UNDER_REVIEW'],
};

/** Clinical safety case hazard identifiers, e.g. H17. */
export const HAZARD_REF = /^H\d{2}$/;
