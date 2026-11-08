import { arr, enumOf, num, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';
import { ON_CALL_SPECIALTIES, SHIFT_KINDS } from '../modules/rosters/rosters.service.js';

/** OpenAPI entries for rosters and on-call (/rosters). */
export const ROSTERS_TAGS = [
  {
    name: 'Rosters and on-call',
    description: 'Staff shifts, on-call rota and who is on call now.',
  },
];

const R = 'Rosters and on-call';
const date = str({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
const time = str({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' });
const override = {
  acknowledgedWarnings: arr(enumOf('REST_PERIOD', 'WEEKLY_HOURS')),
  overrideReason: str({ minLength: 10, maxLength: 300 }),
};
const warnings = {
  '409': 'Overlap with another shift, or working-time warnings to confirm (WORKING_TIME_WARNINGS)',
};

export const ROSTERS_OPERATIONS: ModuleOperation[] = [
  op('get', '/rosters/meta', R, 'Shift kinds, default times, on-call specialties and rules', {
    access: 'facility staff',
  }),
  op('get', '/rosters/staff', R, 'Staff and units that can be rostered', {
    access: 'DIRECTOR',
  }),
  op('get', '/rosters/week', R, 'The roster for one week', {
    access: 'facility staff',
    params: [q('start', date, 'Any day of the week (local); default this week'), q('unitId', uuid)],
  }),
  op('get', '/rosters/mine', R, 'My shifts', {
    access: 'facility staff',
    params: [q('from', date), q('to', date)],
  }),
  op('get', '/rosters/mine.ics', R, 'My shifts as an iCalendar file', {
    access: 'facility staff',
    description: 'Authenticated download (text/calendar); there is no public feed URL.',
  }),
  op('get', '/rosters/on-call', R, 'Who is on call now and next', {
    access: 'facility staff',
  }),
  op('get', '/rosters/staffing', R, 'Nurse staffing per ward and gaps in the next 7 days', {
    access: 'DIRECTOR',
    params: [
      q('date', date),
      q('ratioGeneral', num, 'Patients per nurse on general wards (default 8)'),
      q('ratioIntensive', num, 'Patients per nurse in intensive care and neonatology (default 2)'),
    ],
  }),
  op('post', '/rosters/shifts', R, 'Plan a shift', {
    access: 'DIRECTOR',
    body: obj(
      {
        userId: uuid,
        unitId: uuid,
        kind: enumOf(...SHIFT_KINDS),
        specialty: enumOf(...ON_CALL_SPECIALTIES),
        date,
        startTime: time,
        endTime: time,
        note: str({ maxLength: 300 }),
        ...override,
      },
      ['userId', 'kind', 'date'],
    ),
    responses: { '201': 'Planned', ...warnings },
  }),
  op('patch', '/rosters/shifts/{id}', R, 'Change a shift', {
    access: 'DIRECTOR',
    body: obj({
      unitId: uuid,
      kind: enumOf(...SHIFT_KINDS),
      specialty: enumOf(...ON_CALL_SPECIALTIES),
      date,
      startTime: time,
      endTime: time,
      note: str({ maxLength: 300 }),
      ...override,
    }),
    responses: warnings,
  }),
  op('post', '/rosters/shifts/{id}/cancel', R, 'Cancel a shift', {
    access: 'DIRECTOR',
    body: obj({ reason: str({ minLength: 3, maxLength: 300 }) }, ['reason']),
  }),
  op('post', '/rosters/bulk', R, 'Create a week from a pattern or a copy', {
    access: 'DIRECTOR',
    description:
      'mode PATTERN: one person, seven entries Monday–Sunday (a shift kind or null). mode COPY: the planned shifts of another week (whole facility or one unit). All or nothing.',
    body: obj(
      {
        mode: enumOf('PATTERN', 'COPY'),
        weekStart: date,
        fromWeekStart: date,
        userId: uuid,
        unitId: uuid,
        pattern: arr(enumOf(...SHIFT_KINDS)),
        specialty: enumOf(...ON_CALL_SPECIALTIES),
        ...override,
      },
      ['mode', 'weekStart'],
    ),
    responses: { '201': 'Created', ...warnings },
  }),
  op('post', '/rosters/publish', R, 'Publish a week (one summary notification per person)', {
    access: 'DIRECTOR',
    body: obj({ weekStart: date, unitId: uuid }, ['weekStart']),
  }),
];
