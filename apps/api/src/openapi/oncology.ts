import { arr, bool, date, dateTime, enumOf, int, obj, op, q, str, uuid } from './modules.js';
import type { ModuleOperation } from './modules.js';

/** OpenAPI entries for cancer registry (/oncology). */
export const ONCOLOGY_TAGS = [
  {
    name: 'Cancer registry',
    description: 'Cancer registration, tumour board (MDT) meetings and national incidence.',
  },
];

const C = 'Cancer registry';

const LATERALITY = enumOf('LEFT', 'RIGHT', 'BILATERAL', 'NOT_APPLICABLE', 'UNKNOWN');
const BASIS = enumOf(
  'HISTOLOGY',
  'CYTOLOGY',
  'CLINICAL_INVESTIGATION',
  'CLINICAL_ONLY',
  'DEATH_CERTIFICATE_ONLY',
);
const STAGE = enumOf('0', 'I', 'II', 'III', 'IV', 'UNKNOWN');
const TUMOUR_GROUP = enumOf(
  'BREAST',
  'LUNG',
  'COLORECTAL',
  'UROLOGY',
  'GYNAECOLOGY',
  'HAEMATOLOGY',
  'HEAD_NECK',
  'SKIN',
  'UPPER_GI',
  'OTHER',
);
const RECOMMENDATION = enumOf(
  'SURGERY',
  'CHEMOTHERAPY',
  'RADIOTHERAPY',
  'COMBINED',
  'SURVEILLANCE',
  'PALLIATIVE',
  'MORE_TESTS',
  'OTHER',
);
const TOPOGRAPHY = str({ pattern: '^C[0-9]{2}\\.[0-9]$', description: 'ICD-O-3 site, e.g. C50.4' });
const MORPHOLOGY = str({
  pattern: '^[0-9]{4}/[0-3]$',
  description: 'ICD-O-3 histology/behaviour, e.g. 8500/3',
});
const reason = str({ minLength: 10, maxLength: 500 });

const caseFields = {
  diagnosedOn: date,
  icd10: str({
    pattern: '^(C[0-8][0-9]|C9[0-7]|D0[0-9])(\\.[0-9A-Z]{1,2})?$',
    description: 'C00–C97 or D00–D09',
  }),
  topography: TOPOGRAPHY,
  morphology: MORPHOLOGY,
  laterality: LATERALITY,
  basisOfDiagnosis: BASIS,
  tnmT: str({ description: 'e.g. cT2, pT1c, Tis' }),
  tnmN: str({ description: 'e.g. N0, pN1a' }),
  tnmM: str({ description: 'M0, M1, M1b' }),
  stage: STAGE,
  tnmEdition: str({ maxLength: 10 }),
};

export const ONCOLOGY_OPERATIONS: ModuleOperation[] = [
  op('get', '/oncology/definitions', C, 'Site, morphology and code lists for the registry', {
    access: 'DOCTOR, NURSE, DIRECTOR, MINISTRY',
  }),
  op('get', '/oncology/patients/{patientId}', C, 'The patient’s cancers and tumour board history', {
    access: 'DOCTOR, NURSE (care team)',
    description: 'Audited as a view of the patient record.',
  }),
  op('post', '/oncology/patients/{patientId}/cases', C, 'Register a primary cancer', {
    access: 'DOCTOR (care team)',
    description:
      'Laterality is required for paired organs. Coding inconsistencies are returned as warnings. A cancer of the same site group registered within three months returns 409 POSSIBLE_DUPLICATE unless confirmNotDuplicate is set.',
    body: obj({ ...caseFields, confirmNotDuplicate: bool }, [
      'diagnosedOn',
      'icd10',
      'topography',
      'morphology',
      'basisOfDiagnosis',
    ]),
  }),
  op('patch', '/oncology/cases/{id}', C, 'Correct or complete the coding of a registration', {
    access: 'DOCTOR (care team)',
    body: obj(caseFields),
  }),
  op('post', '/oncology/cases/{id}/withdraw', C, 'Withdraw a registration made in error', {
    access: 'DOCTOR (care team)',
    body: obj({ reason }, ['reason']),
  }),
  op('post', '/oncology/cases/{id}/mark-duplicate', C, 'Mark a registration as a duplicate', {
    access: 'DOCTOR (care team)',
    body: obj({ duplicateOfId: uuid, reason }, ['duplicateOfId', 'reason']),
  }),
  op('get', '/oncology/dco-candidates', C, 'Cancer deaths without a registration', {
    access: 'DOCTOR (certifying doctor or care team)',
    description:
      'Signed death certificates with an underlying cause C00–C97 and no registered cancer.',
  }),
  op(
    'post',
    '/oncology/dco-candidates/{id}/register',
    C,
    'Register a death-certificate-only case',
    {
      access: 'DOCTOR (certifying doctor or care team)',
      description:
        'The path id is the death certificate. Basis of diagnosis DEATH_CERTIFICATE_ONLY.',
      body: obj({ topography: TOPOGRAPHY, morphology: MORPHOLOGY, laterality: LATERALITY }),
    },
  ),
  op('get', '/oncology/stats', C, 'Cancer incidence statistics (small cells suppressed)', {
    access: 'DIRECTOR (own facility), MINISTRY (national, with crude rates)',
    description:
      'Counts of 1–4 are not shown. Crude rates per 100 000 use the registered population of each municipality, not the census population.',
    params: [
      q('fromYear', int({ minimum: 1990, maximum: 2100 })),
      q('toYear', int({ minimum: 1990, maximum: 2100 })),
    ],
  }),
  op('get', '/oncology/mdt/meetings', C, 'Tumour board meetings of my facility', {
    access: 'DOCTOR, NURSE',
    params: [q('when', enumOf('upcoming', 'past'))],
  }),
  op('post', '/oncology/mdt/meetings', C, 'Schedule a tumour board meeting', {
    access: 'DOCTOR',
    body: obj({ tumourGroup: TUMOUR_GROUP, scheduledFor: dateTime, chairId: uuid }, [
      'tumourGroup',
      'scheduledFor',
    ]),
  }),
  op('get', '/oncology/mdt/meetings/{id}', C, 'Tumour board agenda', {
    access: 'DOCTOR, NURSE (facility)',
    description:
      'Patients and referring doctors for everyone of the facility; question, summary and recommendation only for the chair, the referring doctor and the care team. Audited for each patient.',
  }),
  op('patch', '/oncology/mdt/meetings/{id}', C, 'Reschedule a meeting or hand over the chair', {
    access: 'DOCTOR (chair)',
    body: obj({ scheduledFor: dateTime, chairId: uuid }),
  }),
  op('post', '/oncology/mdt/meetings/{id}/cancel', C, 'Cancel a tumour board meeting', {
    access: 'DOCTOR (chair)',
    description: 'Refused while patients are still on the agenda.',
    body: obj({ reason }, ['reason']),
  }),
  op('post', '/oncology/mdt/meetings/{id}/hold', C, 'Record that the meeting took place', {
    access: 'DOCTOR (chair)',
    body: obj({ attendees: arr(str({ minLength: 2, maxLength: 200 }), { minItems: 2 }) }, [
      'attendees',
    ]),
  }),
  op('post', '/oncology/mdt/meetings/{id}/cases', C, 'Add a patient to the agenda', {
    access: 'DOCTOR (care team)',
    body: obj(
      {
        patientId: uuid,
        cancerCaseId: uuid,
        question: str({ minLength: 5, maxLength: 500 }),
        summary: str({ maxLength: 5000 }),
      },
      ['patientId', 'question'],
    ),
  }),
  op('post', '/oncology/mdt/cases/{id}/decision', C, 'Record the recommendation or defer', {
    access: 'DOCTOR (chair)',
    description:
      'DISCUSSED needs recommendation and recommendationText and notifies the referring doctor. DEFERRED moves the patient to another planned meeting.',
    body: obj(
      {
        status: enumOf('DISCUSSED', 'DEFERRED'),
        recommendation: RECOMMENDATION,
        recommendationText: str({ minLength: 10, maxLength: 5000 }),
        deferToMeetingId: uuid,
        note: str({ maxLength: 500 }),
      },
      ['status'],
    ),
  }),
  op('post', '/oncology/mdt/cases/{id}/informed', C, 'Record that the patient was told', {
    access: 'DOCTOR (care team)',
  }),
];
