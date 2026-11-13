import {
  bool,
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
import { OUTCOMES, PRIORITIES } from '../modules/ems/ems.service.js';

/** OpenAPI entries for ambulance service (/ems). */
export const EMS_TAGS = [
  {
    name: 'Ambulance service',
    description:
      'Emergency calls, dispatch, pre-hospital care and handover to the emergency department.',
  },
];

const E = 'Ambulance service';
const CREW = 'DOCTOR, NURSE (staff of the ambulance service)';

const answers = obj(
  {
    conscious: bool,
    breathingNormally: bool,
    chestPain: bool,
    majorBleeding: bool,
    strokeSigns: bool,
    seriousInjury: bool,
    severePain: bool,
  },
  ['conscious', 'breathingNormally'],
);

export const EMS_OPERATIONS: ModuleOperation[] = [
  op('get', '/ems/services', E, 'My ambulance services and what I can do', {
    access: 'staff, DIRECTOR, MINISTRY',
  }),
  op('get', '/ems/destinations', E, 'Hospitals with an emergency department', { access: CREW }),
  op('post', '/ems/vehicles', E, 'Add a vehicle to an ambulance service', {
    access: 'DIRECTOR (own facility)',
    body: obj(
      {
        serviceId: uuid,
        callSign: str({ minLength: 2, maxLength: 20 }),
        level: enumOf('BLS', 'ALS'),
      },
      ['serviceId', 'callSign', 'level'],
    ),
  }),
  op('patch', '/ems/vehicles/{id}', E, 'Take an idle vehicle out of service or back', {
    access: `${CREW}, DIRECTOR`,
    body: obj({ status: enumOf('AVAILABLE', 'OUT_OF_SERVICE') }, ['status']),
  }),
  op('get', '/ems/board', E, 'Dispatch board: open calls and vehicles', {
    access: CREW,
    params: [q('serviceId', uuid)],
  }),
  op('post', '/ems/incidents', E, 'Record an emergency call', {
    access: CREW,
    description:
      'The category (P1 immediately life-threatening, P2 urgent, P3 non-urgent – illustrative until the national protocol is adopted) is computed from the answers; changing it needs a reason.',
    body: obj(
      {
        serviceId: uuid,
        receivedAt: dateTime,
        callerName: str({ maxLength: 200 }),
        callerPhone: str({ maxLength: 40 }),
        address: str({ minLength: 3, maxLength: 300 }),
        municipality: str({ maxLength: 100 }),
        latitude: num,
        longitude: num,
        complaint: str({ minLength: 3, maxLength: 300 }),
        answers,
        priority: enumOf(...PRIORITIES),
        priorityReason: str({ minLength: 5, maxLength: 300 }),
        patientDescription: str({ maxLength: 300 }),
      },
      ['address', 'complaint', 'answers'],
    ),
  }),
  op('get', '/ems/incidents/{id}', E, 'A call with its pre-hospital care record', {
    access: `${CREW}; DOCTOR, NURSE of the destination emergency department; after the handover, whoever may read the patient’s record`,
    description:
      'Everyone but the crew gets the record without the caller’s name and phone or the exact address of the scene.',
  }),
  op('post', '/ems/incidents/{id}/patient', E, 'Link the patient to the call', {
    access: CREW,
    description:
      'By national ID and date of birth together (both must match), or as an unidentified patient with a temporary number.',
    body: obj({
      nationalId: str({ pattern: '^\\d{10}$' }),
      dateOfBirth: str({ format: 'date' }),
      unidentified: obj(
        {
          sex: enumOf('MALE', 'FEMALE', 'OTHER', 'UNKNOWN'),
          estimatedAge: int({ minimum: 0, maximum: 120 }),
          note: str({ minLength: 3, maxLength: 300 }),
        },
        ['sex', 'estimatedAge', 'note'],
      ),
    }),
  }),
  op('post', '/ems/incidents/{id}/dispatch', E, 'Dispatch an available vehicle', {
    access: CREW,
    body: obj({ ambulanceUnitId: uuid }, ['ambulanceUnitId']),
    responses: { '409': 'Already dispatched, or the vehicle is not available' },
  }),
  op(
    'post',
    '/ems/incidents/{id}/status',
    E,
    'Crew progress: on scene, transporting, at hospital',
    {
      access: CREW,
      description:
        'Leaving for hospital needs the destination and the expected arrival time; the destination emergency department is pre-alerted.',
      body: obj(
        {
          status: enumOf('ON_SCENE', 'TRANSPORTING', 'AT_HOSPITAL'),
          destinationFacilityId: uuid,
          etaMinutes: int({ minimum: 1, maximum: 240 }),
        },
        ['status'],
      ),
    },
  ),
  op('post', '/ems/incidents/{id}/destination', E, 'Change the destination hospital', {
    access: CREW,
    body: obj({ destinationFacilityId: uuid, etaMinutes: int({ minimum: 1, maximum: 240 }) }, [
      'destinationFacilityId',
      'etaMinutes',
    ]),
  }),
  op('post', '/ems/incidents/{id}/close', E, 'Close a call (on scene, or after the handover)', {
    access: CREW,
    body: obj({ outcome: enumOf(...OUTCOMES.filter((o) => o !== 'CANCELLED')) }, ['outcome']),
  }),
  op('post', '/ems/incidents/{id}/cancel', E, 'Cancel a call before the crew is on scene', {
    access: CREW,
    body: obj({ reason: str({ minLength: 3, maxLength: 300 }) }, ['reason']),
  }),
  op('post', '/ems/incidents/{id}/care', E, 'Record pre-hospital care (append-only)', {
    access: CREW,
    description:
      'OBSERVATION (BP, heart rate, respiratory rate, SpO₂, GCS, glucose, temperature, oxygen), INTERVENTION, MEDICATION or NOTE. Returns the NEWS2 (PEWS for children) from the latest observations.',
    body: obj(
      {
        kind: enumOf('OBSERVATION', 'INTERVENTION', 'MEDICATION', 'NOTE'),
        recordedAt: dateTime,
        data: obj({}),
        text: str({ maxLength: 500 }),
        medication: str({ maxLength: 200 }),
        dose: str({ maxLength: 100 }),
        route: str({ maxLength: 50 }),
      },
      ['kind'],
    ),
  }),
  op('get', '/ems/incoming', E, 'Ambulances on their way to my emergency department', {
    access: 'DOCTOR, NURSE of the emergency department, RECEPTION',
    description:
      'No names before the handover: priority, complaint, sex, age band, early warning, and when the crew expects to arrive (expectedAt).',
  }),
  op('post', '/ems/incidents/{id}/handover', E, 'Take the handover and open the attendance', {
    access: 'DOCTOR, NURSE of the destination emergency department',
    body: obj({
      unitId: uuid,
      sex: enumOf('MALE', 'FEMALE', 'OTHER', 'UNKNOWN'),
      estimatedAge: int({ minimum: 0, maximum: 120 }),
    }),
  }),
  op('get', '/ems/patients/{patientId}', E, 'A patient’s ambulance calls', {
    access: 'care team',
    description: 'For the chart: without the caller’s details or the exact address of the scene.',
  }),
  op('get', '/ems/stats', E, 'Ambulance statistics (small cells suppressed)', {
    access: 'DIRECTOR (own facility), MINISTRY',
    params: [q('from', dateTime), q('to', dateTime)],
  }),
];
