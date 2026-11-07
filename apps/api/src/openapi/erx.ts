import { date, int, obj, op, q, str, type ModuleOperation } from './modules.js';

/** OpenAPI entries for national e-prescriptions (/e-prescriptions and the pharmacy API). */
export const ERX_TAGS = [
  {
    name: 'E-prescriptions',
    description: 'National e-prescriptions dispensed by community pharmacies.',
  },
];

const E = 'E-prescriptions';
const P = 'Partner API';
const CODE_PATTERN = '^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$';

const erxRequest = obj({
  repeats: int({ minimum: 0, maximum: 12, description: 'Repeat supplies after the first' }),
  validDays: int({
    minimum: 1,
    maximum: 365,
    description:
      'Days the e-prescription can be dispensed (default 30 per supply; one supply at most 90; controlled medicines 7)',
  }),
});

const identity = [
  q('nationalId', str({ minLength: 5, maxLength: 20 }), "The patient's national ID"),
  q('dateOfBirth', date, 'Instead of the national ID'),
];

function withCodeParam(o: ModuleOperation): ModuleOperation {
  o.params = o.params?.map((p) =>
    p.name === 'code'
      ? {
          ...p,
          schema: str({ pattern: CODE_PATTERN }),
          description: 'The code the patient shows, e.g. ABCD-EFGH-JKLM',
        }
      : p,
  );
  return o;
}

export const ERX_OPERATIONS: ModuleOperation[] = [
  op('get', '/e-prescriptions/patients/{patientId}', E, 'A patient’s e-prescriptions', {
    access: 'care team, the patient, guardian',
    description:
      'With the code, supplies dispensed and remaining, validity and dispensing history.',
  }),
  op(
    'post',
    '/e-prescriptions/prescriptions/{prescriptionId}/issue',
    E,
    'Send an active prescription as an e-prescription',
    { access: 'DOCTOR with write access', body: erxRequest },
  ),
  op(
    'post',
    '/e-prescriptions/prescriptions/{prescriptionId}/cancel',
    E,
    'Cancel an e-prescription (no pharmacy can dispense it any more)',
    {
      access: 'DOCTOR with write access',
      body: obj({ reason: str({ minLength: 5, maxLength: 500 }) }, ['reason']),
    },
  ),
  op('get', '/e-prescriptions/mine', E, 'My recently issued e-prescriptions', {
    access: 'DOCTOR',
  }),
  op('get', '/e-prescriptions/stats', E, 'E-prescription statistics (small cells suppressed)', {
    access: 'DIRECTOR (own facility), MINISTRY (national)',
    params: [q('months', int({ minimum: 1, maximum: 24 }))],
  }),
  withCodeParam(
    op('get', '/partner/e-prescriptions/{code}', P, 'Look up an e-prescription to dispense', {
      auth: 'partner',
      access: 'prescriptions.dispense',
      params: identity,
      description:
        'Both the code and the national ID (or date of birth) are required; a wrong pair gets the same 404 as an unknown code, and failed look-ups are rate limited. Returns what to dispense, supplies remaining, validity, allergy substances and the dispensing history – never diagnoses.',
      responses: {
        '200': 'The e-prescription',
        '404': 'No match',
        '429': 'Too many failed look-ups',
      },
    }),
  ),
  withCodeParam(
    op('post', '/partner/e-prescriptions/{code}/dispense', P, 'Record a dispensed supply', {
      auth: 'partner',
      access: 'prescriptions.dispense',
      body: obj(
        {
          nationalId: str({ minLength: 5, maxLength: 20 }),
          dateOfBirth: date,
          pharmacyName: str({ minLength: 2, maxLength: 200 }),
          pharmacistName: str({ minLength: 3, maxLength: 200 }),
          pharmacistLicence: str({ maxLength: 60 }),
          productName: str({
            minLength: 2,
            maxLength: 200,
            description: 'Generic substitution allowed',
          }),
          quantity: str({ minLength: 1, maxLength: 100 }),
        },
        ['pharmacyName', 'pharmacistName', 'productName', 'quantity'],
      ),
      responses: {
        '201': 'The dispensing, with supplies remaining',
        '404': 'No match',
        '409': 'Cancelled, stopped, expired or fully dispensed',
      },
    }),
  ),
  op(
    'post',
    '/partner/e-prescriptions/dispensings/{id}/reverse',
    P,
    'Reverse a dispensing recorded in error (within 24 hours)',
    {
      auth: 'partner',
      access: 'prescriptions.dispense',
      description:
        'Only the system that recorded the dispensing; the supply becomes available again.',
      body: obj({ reason: str({ minLength: 5, maxLength: 300 }) }, ['reason']),
      responses: { '201': 'The reversal', '409': 'Already reversed or older than 24 hours' },
    },
  ),
];
