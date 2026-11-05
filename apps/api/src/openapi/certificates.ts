import { bool, date, enumOf, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';

/** OpenAPI entries for medical certificates (/certificates and the public /verify/certificates). */
export const CERTIFICATES_TAGS = [
  {
    name: 'Medical certificates',
    description: 'Sick leave and fitness certificates with public verification.',
  },
];

const C = 'Medical certificates';

/** Path parameters that are not UUIDs (certificate number, verification code). */
const textPath = (operation: ModuleOperation, name: string, maxLength: number) => ({
  ...operation,
  params: operation.params?.map((p) =>
    p.in === 'path' && p.name === name ? { ...p, schema: str({ maxLength }) } : p,
  ),
});
const KINDS = [
  'SICK_LEAVE',
  'FITNESS_FOR_WORK',
  'SCHOOL_ABSENCE',
  'SPORTS_FITNESS',
  'DRIVING_FITNESS',
  'GENERAL',
];

export const CERTIFICATES_OPERATIONS: ModuleOperation[] = [
  op('get', '/certificates/stats', C, 'Certificate statistics (counts by month and kind)', {
    access: 'DIRECTOR (own facility), MINISTRY (national)',
    params: [
      q('from', date),
      q('to', date),
      q('facilityId', uuid, 'Ministry only: limit to one facility'),
    ],
  }),
  op('get', '/certificates/mine', C, 'Certificates I issued recently', { access: 'DOCTOR' }),
  textPath(
    op('get', '/certificates/by-serial/{serial}', C, 'Find a certificate by its number', {
      access: 'DIRECTOR (own facility)',
    }),
    'serial',
    30,
  ),
  op('get', '/certificates/patients/{patientId}', C, 'Certificates of a patient', {
    access: 'care team, patient, guardian',
  }),
  op('post', '/certificates/patients/{patientId}', C, 'Issue a medical certificate', {
    access: 'DOCTOR with write access',
    description:
      'Sick leave and school absence cover at most 30 days; longer absences are extensions that start the day after the previous certificate ends. Issued certificates are immutable.',
    body: obj(
      {
        kind: enumOf(...KINDS),
        startDate: date,
        endDate: date,
        icd10Code: str({ maxLength: 10 }),
        diagnosisOnCertificate: bool,
        outcome: enumOf('FIT', 'FIT_WITH_RESTRICTIONS', 'UNFIT'),
        restrictions: str({ maxLength: 500 }),
        purpose: str({ maxLength: 200 }),
        remarks: str({ maxLength: 2000 }),
        encounterId: uuid,
        extendsCertificateId: uuid,
      },
      ['kind', 'startDate'],
    ),
    responses: { '201': 'Issued (with warnings, e.g. medical commission after 90 days)' },
  }),
  op('get', '/certificates/{id}', C, 'Certificate for printing, with its verification link', {
    access: 'care team, patient, guardian',
  }),
  op('post', '/certificates/{id}/revoke', C, 'Revoke a certificate', {
    access: 'the issuing DOCTOR, DIRECTOR (own facility)',
    body: obj({ reason: str({ minLength: 5, maxLength: 300 }) }, ['reason']),
  }),
  textPath(
    op('get', '/verify/certificates/{code}', C, 'Verify a certificate by its QR code', {
      auth: 'none',
      description:
        'Public. Returns whether the certificate is genuine and valid, expired or revoked, its kind, dates and issuer, and the patient initials and birth year – never the diagnosis. Rate limited per address.',
      responses: { '200': 'Certificate found', '404': 'No certificate matches this code' },
    }),
    'code',
    40,
  ),
];
