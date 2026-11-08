import { HAI_TYPES, PRECAUTIONS, REVIEW_OUTCOMES } from '../modules/infection/definitions.js';
import { bool, dateTime, enumOf, int, obj, op, q, str, type ModuleOperation } from './modules.js';

/** OpenAPI entries for infection prevention (/infection). */
export const INFECTION_TAGS = [
  {
    name: 'Infection prevention',
    description: 'Isolation precautions, healthcare-associated infections, restricted antibiotics.',
  },
];

const T = 'Infection prevention';
const months = q('months', int({ minimum: 1, maximum: 36 }), 'Default 12');
const IC = 'infection control staff (DOCTOR, NURSE of an INFECTION_CONTROL unit)';

export const INFECTION_OPERATIONS: ModuleOperation[] = [
  op('get', '/infection/definitions', T, 'Precautions, HAI criteria, restricted antibiotics'),
  op(
    'get',
    '/infection/patients/{patientId}',
    T,
    'A patient’s isolation, infections and restricted antibiotics',
    {
      access: 'DOCTOR, NURSE (care team or infection control)',
    },
  ),
  op('post', '/infection/patients/{patientId}/isolations', T, 'Start isolation precautions', {
    access: 'DOCTOR, NURSE (care team or infection control)',
    body: obj(
      { precaution: enumOf(...PRECAUTIONS), reason: str({ minLength: 2, maxLength: 200 }) },
      ['precaution', 'reason'],
    ),
    responses: { '201': 'Started', '409': 'These precautions are already in place' },
  }),
  op('post', '/infection/isolations/{id}/end', T, 'End isolation precautions', {
    access: 'DOCTOR, NURSE (care team or infection control)',
    body: obj({ reason: str({ minLength: 3, maxLength: 300 }) }, ['reason']),
  }),
  op('get', '/infection/isolations', T, 'Isolated patients at my facility by ward', {
    access:
      'DOCTOR, NURSE (own wards and patients; everything for infection control), DIRECTOR (counts)',
  }),
  op(
    'post',
    '/infection/patients/{patientId}/hai',
    T,
    'Report a possible healthcare-associated infection',
    {
      access: 'DOCTOR, NURSE (care team or infection control)',
      body: obj(
        {
          type: enumOf(...HAI_TYPES),
          organism: str({ maxLength: 120 }),
          onsetAt: dateTime,
          deviceRelated: bool,
          notes: str({ maxLength: 2000 }),
        },
        ['type', 'onsetAt'],
      ),
    },
  ),
  op('post', '/infection/hai/{id}/review', T, 'Confirm or rule out an infection', {
    access: IC,
    body: obj({ status: enumOf('CONFIRMED', 'RULED_OUT'), notes: str({ maxLength: 2000 }) }, [
      'status',
    ]),
  }),
  op('get', '/infection/hai', T, 'Reported infections at my facility', {
    access: IC,
    params: [q('status', enumOf('SUSPECTED', 'CONFIRMED', 'RULED_OUT'))],
  }),
  op(
    'get',
    '/infection/suggestions',
    T,
    'Positive cultures after 48 hours without a recorded infection',
    {
      access: IC,
    },
  ),
  op('get', '/infection/surveillance', T, 'Infection rates per 1,000 patient-days', {
    access:
      'DIRECTOR and infection control (facility, by ward), MINISTRY (by facility, small counts hidden)',
    params: [months],
  }),
  op('get', '/infection/stewardship', T, 'Restricted antibiotic requests and overdue reviews', {
    access: 'PHARMACIST and infection control (facility queue), DOCTOR (own requests)',
  }),
  op(
    'post',
    '/infection/antimicrobials/{id}/decision',
    T,
    'Approve or decline a restricted antibiotic',
    {
      access: 'PHARMACIST and infection control (not their own requests)',
      body: obj({ decision: enumOf('APPROVED', 'DECLINED'), note: str({ maxLength: 500 }) }, [
        'decision',
      ]),
    },
  ),
  op('post', '/infection/antimicrobials/{id}/review', T, 'Record the 72-hour antibiotic review', {
    access: 'DOCTOR with write access, PHARMACIST and infection control',
    body: obj({ outcome: enumOf(...REVIEW_OUTCOMES), note: str({ maxLength: 500 }) }, ['outcome']),
  }),
  op('get', '/infection/stewardship/stats', T, 'Restricted antibiotic indicators', {
    access: 'DIRECTOR, stewardship team (facility), MINISTRY (by facility, small counts hidden)',
    params: [months],
  }),
];
