import { date, enumOf, int, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';

/** OpenAPI entries for professional licences (/licences). */
export const LICENCES_TAGS = [
  {
    name: 'Professional licences',
    description: 'Licensing of health professionals and licence checks.',
  },
];

const L = 'Professional licences';
const PROFESSIONS = ['PHYSICIAN', 'DENTIST', 'NURSE', 'MIDWIFE', 'PHARMACIST'];
const STATES = ['VALID', 'EXPIRING', 'EXPIRED', 'SUSPENDED', 'REVOKED'];
const reasonBody = obj({ reason: str({ minLength: 5, maxLength: 500 }) }, ['reason']);
const licenceFields = {
  holderName: str({ minLength: 3, maxLength: 200 }),
  profession: enumOf(...PROFESSIONS),
  specialty: str({ maxLength: 120 }),
  issuedBy: str({ minLength: 3, maxLength: 200 }),
  issuedOn: date,
  validUntil: date,
  cpdCredits: int({ minimum: 0, maximum: 9999 }),
};

export const LICENCES_OPERATIONS: ModuleOperation[] = [
  {
    ...op('get', '/licences/public/{number}', L, 'Check a professional licence (public)', {
      auth: 'none',
      description:
        'No sign-in. Returns holder name, profession, specialty, status (VALID, EXPIRED, SUSPENDED, REVOKED) and valid-until date only. Rate limited per address.',
      responses: { '200': 'Licence status', '404': 'Unknown number', '429': 'Too many checks' },
    }),
    params: [{ name: 'number', in: 'path', required: true, schema: str({ maxLength: 40 }) }],
  },
  op('get', '/licences/me', L, 'My professional licence', { access: 'staff' }),
  op('get', '/licences/facility', L, 'Clinical staff of a facility with their licence state', {
    access: 'DIRECTOR (own facility), MINISTRY',
    params: [q('facilityId', uuid, 'Ministry only')],
  }),
  op('post', '/licences/{id}/link', L, 'Link a licence to a staff account', {
    access: 'MINISTRY; DIRECTOR (own staff, same number and name)',
    description:
      'The profession must fit the role: doctor ↔ physician or dentist, nurse ↔ nurse or midwife, pharmacist ↔ pharmacist.',
    body: obj({ userId: uuid }, ['userId']),
  }),
  op('post', '/licences/{id}/unlink', L, 'Unlink a licence from its account', {
    access: 'MINISTRY',
    body: reasonBody,
  }),
  op('get', '/licences', L, 'National licence register', {
    access: 'MINISTRY',
    params: [
      q('q', str({ maxLength: 100 }), 'Name, number or specialty'),
      q('profession', enumOf(...PROFESSIONS)),
      q('state', enumOf(...STATES)),
      q('linked', enumOf('yes', 'no')),
      q('page', int({ minimum: 1 })),
      q('pageSize', int({ minimum: 1, maximum: 100 })),
    ],
  }),
  op('get', '/licences/stats', L, 'Licence statistics by profession and state', {
    access: 'MINISTRY',
  }),
  op('get', '/licences/accounts', L, 'Find clinical staff accounts to link', {
    access: 'MINISTRY',
    params: [q('q', str({ minLength: 2, maxLength: 100 }))],
  }),
  op('post', '/licences', L, 'Register a licence', {
    access: 'MINISTRY',
    body: obj({ licenceNumber: str({ maxLength: 40 }), ...licenceFields }, [
      'licenceNumber',
      'holderName',
      'profession',
      'issuedBy',
      'issuedOn',
      'validUntil',
    ]),
  }),
  op('post', '/licences/import', L, 'Import licences from CSV', {
    access: 'MINISTRY',
    description:
      'Columns: licenceNumber, holderName, profession, specialty, issuedBy, issuedOn, validUntil, cpdCredits. Existing numbers are updated (status is never changed by an import). dryRun (default true) only validates.',
    body: obj({ csv: str({ maxLength: 190000 }), dryRun: { type: 'boolean' } }, ['csv']),
  }),
  op('get', '/licences/{id}', L, 'A licence with its linked account', { access: 'MINISTRY' }),
  op('patch', '/licences/{id}', L, 'Update a licence (renewal, specialty, CPD)', {
    access: 'MINISTRY',
    body: obj(licenceFields),
  }),
  op('post', '/licences/{id}/status', L, 'Suspend, revoke or reinstate a licence', {
    access: 'MINISTRY',
    description: 'A revoked licence cannot be reinstated; a new licence is registered instead.',
    body: obj(
      {
        status: enumOf('ACTIVE', 'SUSPENDED', 'REVOKED'),
        reason: str({ minLength: 5, maxLength: 500 }),
      },
      ['status', 'reason'],
    ),
  }),
  op('get', '/licences/{id}/history', L, 'Changes to a licence', { access: 'MINISTRY' }),
];
