import { enumOf, obj, op, q, str, type ModuleOperation } from './modules.js';

/**
 * OpenAPI entries: the service agreement and the data processing agreement accepted per facility (/subscription, /admin).
 * Round 2, builder G: add an entry here for every route added (test/fhir-coverage.test.ts
 * checks both ways).
 */
export const AGREEMENTS_TAGS = [
  {
    name: 'Agreements',
    description:
      'The service agreement and the data processing agreement, accepted once per facility by a director. A missing acceptance never blocks anything.',
  },
];

const T = 'Agreements';
const ADMIN = 'ADMIN (platform administrator)';
const DIRECTOR = 'DIRECTOR (own facility)';
const kindEnum = enumOf('SERVICE_AGREEMENT', 'DPA');
const localeEnum = enumOf('sq', 'sr', 'en');

export const AGREEMENTS_OPERATIONS: ModuleOperation[] = [
  op('get', '/subscription/agreements', T, 'The agreements of my facility', {
    access: DIRECTOR,
    description:
      'For each agreement: the current published text in the requested language (else the director’s), whether the facility still has to accept it (it accepted neither the latest version that asked for acceptance nor a later one), and the facility’s acceptances with signer name and title. `asked` says whether the facility is a customer (an active facility whose subscription is TRIAL, ACTIVE, PAST_DUE or SUSPENDED, as in /admin/agreements/missing): only then are its directors shown a notice, and only then does `pending` count the agreements still to accept (0 otherwise). Any facility may accept. Nothing is blocked while one is pending.',
    params: [q('locale', localeEnum)],
  }),
  op(
    'post',
    '/subscription/agreements/{documentId}/accept',
    T,
    'Accept an agreement for my facility',
    {
      access: DIRECTOR,
      description:
        'Only the current version can be accepted; a version the facility already accepted (in any language) is not recorded again. Stored with the signer’s name and title as typed, the director’s account, time, IP address and browser, and audited in the same transaction.',
      params: [q('locale', localeEnum)],
      body: obj(
        {
          signerName: str({ minLength: 2, maxLength: 200 }),
          signerTitle: str({ minLength: 2, maxLength: 200 }),
        },
        ['signerName', 'signerTitle'],
      ),
      responses: {
        '201': 'Accepted; the agreements of the facility',
        '200': 'Already accepted; nothing changed',
        '404': 'Not a published agreement',
        '409': 'Not the current version',
      },
    },
  ),
  op('get', '/admin/organizations/{facilityId}/agreements', T, 'A facility’s agreements', {
    access: ADMIN,
    description:
      'Per agreement: the current version, whether the facility still has to accept it, and its acceptances (version, language, signer name and title, the director’s account, time). `asked` and `pending` as for the director: a facility that is not a customer is not asked.',
  }),
  op('get', '/admin/agreements/missing', T, 'Customers without the current agreements', {
    access: ADMIN,
    description:
      'Customers are active facilities whose subscription has not ended. Per agreement: the current version, whether it asks for acceptance, and how many customers are up to date or pending; and the customers with the agreements they still have to accept.',
  }),
  op('get', '/admin/agreements/acceptances', T, 'Which facilities accepted a version', {
    access: ADMIN,
    description: 'The number of facilities that accepted it and the latest 50 acceptances.',
    params: [
      q('kind', kindEnum),
      q('version', str({ minLength: 1, maxLength: 20 }), 'Trimmed; an unknown version gives 0'),
    ],
  }),
];
