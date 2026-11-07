/** Fixed lists for patient complaints and experience feedback (checked by database constraints). */

export const COMPLAINT_CHANNELS = ['PORTAL', 'IN_PERSON', 'PHONE', 'LETTER'] as const;
export type ComplaintChannel = (typeof COMPLAINT_CHANNELS)[number];

export const COMPLAINT_CATEGORIES = [
  'CARE_QUALITY',
  'COMMUNICATION',
  'WAITING_TIME',
  'STAFF_ATTITUDE',
  'BILLING',
  'PRIVACY',
  'FACILITIES',
  'OTHER',
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export const COMPLAINT_STATUSES = [
  'RECEIVED',
  'ACKNOWLEDGED',
  'INVESTIGATING',
  'RESPONDED',
  'CLOSED',
  'ESCALATED',
] as const;
export type ComplaintStatus = (typeof COMPLAINT_STATUSES)[number];

/** Outcomes the facility can give; WITHDRAWN is set only when the complainant withdraws. */
export const RESPONSE_OUTCOMES = ['UPHELD', 'PARTLY_UPHELD', 'NOT_UPHELD'] as const;
export const COMPLAINT_OUTCOMES = [...RESPONSE_OUTCOMES, 'WITHDRAWN'] as const;
export type ComplaintOutcome = (typeof COMPLAINT_OUTCOMES)[number];

/**
 * Deadlines. Acknowledgement within 5 working days (Monday–Friday; public holidays are not taken
 * into account), a written response within 30 calendar days, and escalation to the Ministry within
 * 30 days of the response.
 */
export const ACKNOWLEDGE_WORKING_DAYS = 5;
export const RESPONSE_DAYS = 30;
export const ESCALATION_DAYS = 30;
/** Reminders to the handler: this many days before a deadline, and on the deadline. */
export const REMINDER_DAYS_BEFORE = 3;
/** A complaint is "about care received" when the patient had a visit there in this many years. */
export const RECENT_CARE_YEARS = 2;

export const FEEDBACK_SETTINGS = ['OUTPATIENT', 'INPATIENT', 'EMERGENCY', 'VIDEO'] as const;
export type FeedbackSetting = (typeof FEEDBACK_SETTINGS)[number];

/** Optional item scores (1–5) besides the overall rating. */
export const FEEDBACK_ITEMS = [
  'waiting',
  'communication',
  'cleanliness',
  'respect',
  'explanation',
] as const;
export type FeedbackItem = (typeof FEEDBACK_ITEMS)[number];

/** Visits can be rated for this many days after they ended. */
export const FEEDBACK_WINDOW_DAYS = 30;
