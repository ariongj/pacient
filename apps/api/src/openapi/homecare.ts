import {
  arr,
  bool,
  date,
  dateTime,
  enumOf,
  int,
  num,
  obj,
  op,
  q,
  str,
  uuid,
  type ModuleOperation,
} from './modules.js';
import { FREQUENCIES, MAX_SCHEDULE_WEEKS, TASKS } from '../modules/homecare/homecare.service.js';

/** OpenAPI entries for home care (/home-care). */
export const HOMECARE_TAGS = [
  {
    name: 'Home care',
    description: 'Community nursing: home care episodes, visits and care plans.',
  },
];

const H = 'Home care';
const reason = obj({ reason: str({ minLength: 3, maxLength: 300 }) }, ['reason']);
const tasks = arr(enumOf(...TASKS));
const TEAM = 'NURSE, DOCTOR of the community nursing team';

export const HOMECARE_OPERATIONS: ModuleOperation[] = [
  op('get', '/home-care/teams', H, 'Community nursing teams', {
    description:
      'With a patient: the teams of the caller’s facility and of the patient’s registered facility (for referral). Always returns the teams the caller belongs to.',
    params: [q('patientId', uuid)],
  }),
  op('get', '/home-care/teams/{id}/members', H, 'Nurses and doctors of a team', {
    access: 'team members, DIRECTOR of the facility',
  }),
  op('get', '/home-care/patients/{patientId}', H, 'The patient’s home care episodes and visits', {
    access: 'DOCTOR, NURSE (care team or the patient’s community nursing team)',
  }),
  op('post', '/home-care/patients/{patientId}/episodes', H, 'Refer a patient to home care', {
    access: 'DOCTOR with write access',
    description:
      'One open episode per patient and team. The team must belong to the caller’s facility or the patient’s registered facility. `admissionId` marks a referral at a hospital discharge.',
    body: obj(
      {
        teamUnitId: uuid,
        reason: str({ minLength: 5, maxLength: 300 }),
        tasks,
        goals: str({ maxLength: 4000 }),
        visitAddress: str({ maxLength: 300 }),
        accessNotes: str({ maxLength: 300 }),
        admissionId: uuid,
      },
      ['teamUnitId', 'reason', 'tasks'],
    ),
  }),
  op('get', '/home-care/episodes/{id}', H, 'A home care episode with all its visits', {
    access: 'DOCTOR, NURSE (care team or the community nursing team)',
  }),
  op('post', '/home-care/episodes/{id}/accept', H, 'Accept a referral', { access: TEAM }),
  op(
    'patch',
    '/home-care/episodes/{id}/care-plan',
    H,
    'Change the care plan, address or access notes',
    {
      access: `${TEAM}, or the patient’s DOCTOR`,
      body: obj({
        goals: str({ maxLength: 4000 }),
        tasks,
        visitAddress: str({ minLength: 3, maxLength: 300 }),
        accessNotes: str({ maxLength: 300 }),
      }),
    },
  ),
  op('post', '/home-care/episodes/{id}/hold', H, 'Put an episode on hold', {
    access: TEAM,
    description: 'Planned visits that have not started are cancelled.',
    body: reason,
  }),
  op('post', '/home-care/episodes/{id}/resume', H, 'Resume an episode on hold', { access: TEAM }),
  op('post', '/home-care/episodes/{id}/discharge', H, 'Discharge from home care', {
    access: `${TEAM}, or the patient’s DOCTOR`,
    body: reason,
  }),
  op('post', '/home-care/episodes/{id}/visits', H, 'Plan home visits (single or recurring)', {
    access: TEAM,
    description: `TWICE_WEEKLY visits on the start day and three days later each week; at most ${MAX_SCHEDULE_WEEKS} weeks.`,
    body: obj(
      {
        startAt: dateTime,
        frequency: enumOf(...FREQUENCIES),
        weeks: int({ minimum: 1, maximum: MAX_SCHEDULE_WEEKS }),
        assignedToId: uuid,
        tasks,
      },
      ['startAt', 'frequency'],
    ),
  }),
  op('patch', '/home-care/visits/{id}', H, 'Reschedule or reassign a planned visit', {
    access: TEAM,
    body: obj({ scheduledFor: dateTime, assignedToId: uuid, tasks }),
  }),
  op('post', '/home-care/visits/{id}/check-in', H, 'Start a visit (check-in at the home)', {
    access: TEAM,
  }),
  op('post', '/home-care/visits/{id}/complete', H, 'Record a visit as done (check-out)', {
    access: TEAM,
    description:
      'Observations are stored as vital signs of the patient and scored with NEWS2 (or PEWS for children).',
    body: obj(
      {
        notes: str({ minLength: 3, maxLength: 4000 }),
        tasksDone: tasks,
        observations: obj({
          systolic: int(),
          diastolic: int(),
          heartRate: int(),
          respiratoryRate: int(),
          oxygenSaturation: int(),
          temperatureC: num,
          consciousness: enumOf('A', 'C', 'V', 'P', 'U'),
          onSupplementalOxygen: bool,
          painScore: int({ minimum: 0, maximum: 10 }),
          weightKg: num,
        }),
      },
      ['notes'],
    ),
  }),
  op('post', '/home-care/visits/{id}/missed', H, 'Record a missed visit', {
    access: TEAM,
    description:
      'For visits with medication, injections or palliative care the referring doctor and the team are notified once.',
    body: reason,
  }),
  op('post', '/home-care/visits/{id}/cancel', H, 'Cancel a planned visit', {
    access: TEAM,
    body: reason,
  }),
  op('get', '/home-care/board', H, 'The team’s day list', {
    access: TEAM,
    description:
      'Visits per nurse ordered by time with address and access notes; referrals and episodes; visits needing attention (checked in more than 2 hours ago without check-out, or not started 2 hours after their time).',
    params: [q('teamId', uuid), q('date', date)],
  }),
  op('get', '/home-care/stats', H, 'Team activity (no names)', {
    access: 'DIRECTOR (own facility)',
  }),
  op('get', '/home-care/mine', H, 'My home care (portal)', {
    access: 'PATIENT (own record or guardian; appointments-only guardians see visit times only)',
  }),
];
