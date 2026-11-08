import {
  arr,
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
import {
  COMPLICATIONS,
  DAYS,
  END_REASONS,
  SHIFTS,
  VASCULAR_ACCESS,
} from '../modules/dialysis/dialysis.service.js';

/** OpenAPI entries for dialysis (/dialysis). */
export const DIALYSIS_TAGS = [
  { name: 'Dialysis', description: 'Haemodialysis schedules, sessions and adequacy.' },
];

const D = 'Dialysis';
const STAFF = 'DOCTOR, NURSE of the dialysis unit';
const RECORD = 'NURSE, DOCTOR with access (staff of the patient’s dialysis unit)';
const SCHEDULER = 'DOCTOR of the dialysis unit, or DOCTOR with write access';
const weight = num;
const urea = { type: 'number', minimum: 0.5, maximum: 80, description: 'mmol/l' };

const schedule = obj(
  {
    days: arr(enumOf(...DAYS), { minItems: 1, maxItems: 7 }),
    shift: enumOf(...SHIFTS),
    durationMinutes: int({ minimum: 60, maximum: 600 }),
    targetWeightKg: weight,
    vascularAccess: enumOf(...VASCULAR_ACCESS),
  },
  [],
);

export const DIALYSIS_OPERATIONS: ModuleOperation[] = [
  op('get', '/dialysis/units', D, 'Dialysis units of my facility', {
    access: 'DOCTOR, NURSE, DIRECTOR',
    description:
      'Stations (beds of the unit), active patients and how many patients are scheduled per shift and weekday.',
  }),
  op('get', '/dialysis/units/{unitId}/board', D, 'Sessions of a unit on one day, by shift', {
    access: STAFF,
    description:
      'Planned, running and finished sessions with warnings (weight gain above 4% of the target weight, blood pressure, adequacy below target). Defaults to today (Kosovo time).',
    params: [q('date', date)],
  }),
  op('get', '/dialysis/units/{unitId}/patients', D, 'Patients of a dialysis unit', {
    access: STAFF,
    description: 'Active schedules with attendance in the last 30 days and the last adequacy.',
  }),
  op('get', '/dialysis/patients/{patientId}', D, 'The patient’s dialysis schedules and sessions', {
    access: 'DOCTOR, NURSE with access to the patient',
    description: 'The last 90 sessions, monthly adequacy (URR, Kt/V) and the targets. Audited.',
  }),
  op('post', '/dialysis/patients/{patientId}/schedules', D, 'Start a dialysis schedule', {
    access: SCHEDULER,
    description:
      'One active schedule per patient. Refused with 409 SHIFT_FULL when a chosen day of the shift has no free station. Sessions are planned 14 days ahead.',
    body: obj(
      {
        unitId: uuid,
        days: arr(enumOf(...DAYS), { minItems: 1, maxItems: 7 }),
        shift: enumOf(...SHIFTS),
        durationMinutes: int({ minimum: 60, maximum: 600 }),
        targetWeightKg: weight,
        vascularAccess: enumOf(...VASCULAR_ACCESS),
        startedOn: date,
      },
      ['unitId', 'days', 'shift', 'vascularAccess'],
    ),
  }),
  op('patch', '/dialysis/schedules/{id}', D, 'Change a dialysis schedule', {
    access: SCHEDULER,
    description:
      'New days or shift are checked against the stations; planned sessions from tomorrow follow the new days.',
    body: schedule,
  }),
  op('post', '/dialysis/schedules/{id}/end', D, 'End a dialysis schedule', {
    access: SCHEDULER,
    description: 'Cancels the planned sessions from today.',
    body: obj({ reason: enumOf(...END_REASONS), note: str({ maxLength: 250 }) }, ['reason']),
  }),
  op('post', '/dialysis/sessions/{id}/start', D, 'Start a session', {
    access: RECORD,
    body: obj(
      {
        machine: str({ minLength: 1, maxLength: 40 }),
        preWeightKg: weight,
        preSystolic: int(),
        preDiastolic: int(),
        startedAt: dateTime,
      },
      ['machine', 'preWeightKg', 'preSystolic', 'preDiastolic'],
    ),
  }),
  op('post', '/dialysis/sessions/{id}/end', D, 'End a session', {
    access: RECORD,
    description:
      'Post weight and blood pressure, ultrafiltration, complications and (optionally) the urea before and after for URR and Kt/V (Daugirdas).',
    body: obj(
      {
        postWeightKg: weight,
        postSystolic: int(),
        postDiastolic: int(),
        ultrafiltrationMl: int({ minimum: 0, maximum: 8000 }),
        bloodFlowMlMin: int({ minimum: 100, maximum: 600 }),
        preUrea: urea,
        postUrea: urea,
        complications: arr(enumOf(...COMPLICATIONS)),
        notes: str({ maxLength: 2000 }),
        endedAt: dateTime,
      },
      ['postWeightKg', 'postSystolic', 'postDiastolic', 'ultrafiltrationMl'],
    ),
  }),
  op('patch', '/dialysis/sessions/{id}/urea', D, 'Add the urea results to a session', {
    access: RECORD,
    body: obj({ preUrea: urea, postUrea: urea }, ['preUrea', 'postUrea']),
  }),
  op('post', '/dialysis/sessions/{id}/missed', D, 'Record a missed session', {
    access: RECORD,
    body: obj({ reason: str({ minLength: 3, maxLength: 300 }) }, ['reason']),
  }),
  op('get', '/dialysis/stats', D, 'Dialysis statistics', {
    access: 'DIRECTOR (own facility), MINISTRY (national)',
    description:
      'Patients on dialysis, sessions per month, share of measured sessions meeting the adequacy target and missed sessions. For the Ministry counts of 1–4 are hidden. Aggregates only.',
  }),
];
