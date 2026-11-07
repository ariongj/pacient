import { arr, bool, date, enumOf, obj, op, str, uuid, type ModuleOperation } from './modules.js';

/** OpenAPI entries for organ donation and advance directives (/directives). */
export const DIRECTIVES_TAGS = [
  {
    name: 'Organ donation and directives',
    description: 'Organ donation registry, advance directives and resuscitation decisions.',
  },
];

const D = 'Organ donation and directives';
const DECISIONS = ['DONOR', 'DONOR_SOME', 'NOT_DONOR'];
const ORGANS = ['KIDNEYS', 'LIVER', 'HEART', 'LUNGS', 'PANCREAS', 'CORNEAS', 'TISSUE'];
const KINDS = ['DNACPR', 'TREATMENT_ESCALATION', 'ADVANCE_REFUSAL', 'HEALTHCARE_PROXY'];

const donation = (extra: Record<string, Record<string, unknown>> = {}) =>
  obj(
    {
      decision: enumOf(...DECISIONS),
      organs: arr(enumOf(...ORGANS), { description: 'Required for DONOR_SOME' }),
      familyInformed: bool,
      faithOrBeliefNote: str({ maxLength: 300 }),
      ...extra,
    },
    ['decision', ...Object.keys(extra)],
  );
const reason = obj({ reason: str({ minLength: 5, maxLength: 500 }) }, ['reason']);

export const DIRECTIVES_OPERATIONS: ModuleOperation[] = [
  op('get', '/directives/mine', D, 'My organ donation decision and advance directives', {
    access: 'PATIENT (own record; a guardian sees a child’s directives only)',
  }),
  op('post', '/directives/mine/organ-donation', D, 'Register my organ donation decision', {
    access: 'PATIENT (adults, own record)',
    description: 'Each change is a new entry; the latest one is the current decision.',
    body: donation(),
    responses: { '201': 'Recorded', '409': 'Under 18, or deceased' },
  }),
  op('post', '/directives/mine/healthcare-proxy', D, 'Name my healthcare proxy', {
    access: 'PATIENT (adults, own record)',
    body: obj(
      {
        proxyName: str({ minLength: 2, maxLength: 200 }),
        proxyPhone: str({ maxLength: 40 }),
        relationship: str({ maxLength: 100 }),
        note: str({ maxLength: 1000 }),
      },
      ['proxyName'],
    ),
  }),
  op(
    'post',
    '/directives/mine/directives/{id}/revoke',
    D,
    'Withdraw my healthcare proxy or refusal',
    {
      access: 'PATIENT (own healthcare proxy and advance refusals)',
      body: reason,
    },
  ),
  op('get', '/directives/patients/{patientId}', D, 'Advance directives of a patient', {
    access: 'care team',
    description: 'Active and revoked directives. The organ donation decision is not included.',
  }),
  op(
    'get',
    '/directives/patients/{patientId}/flags',
    D,
    'Active DNACPR and ceiling-of-care flags',
    {
      access: 'care team',
    },
  ),
  op('post', '/directives/patients/{patientId}', D, 'Record an advance directive', {
    access: 'DOCTOR (all kinds), NURSE (healthcare proxy)',
    description:
      'DNACPR and treatment escalation need who the decision was discussed with. Directives are never edited: revoke and record a new one.',
    body: obj(
      {
        kind: enumOf(...KINDS),
        summary: str({ minLength: 5, maxLength: 2000 }),
        discussedWith: str({ maxLength: 300 }),
        proxyName: str({ maxLength: 200 }),
        proxyPhone: str({ maxLength: 40 }),
        documentId: uuid,
        reviewDate: date,
      },
      ['kind', 'summary'],
    ),
    responses: { '201': 'Recorded', '409': 'An active decision of this kind exists' },
  }),
  op('post', '/directives/{id}/revoke', D, 'Revoke an advance directive', {
    access: 'DOCTOR with write access (NURSE: healthcare proxy)',
    body: reason,
  }),
  op(
    'post',
    '/directives/patients/{patientId}/organ-donation/check',
    D,
    'Check the organ donation register for a patient',
    {
      access: 'DOCTOR (care team)',
      description:
        'For end-of-life care or transplant coordination only. Every check is audited and shown in the patient’s access log.',
      body: obj(
        {
          purpose: enumOf('END_OF_LIFE_CARE', 'TRANSPLANT_COORDINATION'),
          note: str({ maxLength: 300 }),
        },
        ['purpose'],
      ),
    },
  ),
  op(
    'post',
    '/directives/patients/{patientId}/organ-donation',
    D,
    'Record an organ donation decision in person',
    {
      access: 'DOCTOR, NURSE, RECEPTION (with the person present)',
      body: donation({ personPresent: bool }),
    },
  ),
  op(
    'get',
    '/directives/ed-flags',
    D,
    'DNACPR and ceiling-of-care flags in the emergency department',
    {
      access: 'emergency department doctors and nurses',
    },
  ),
  op('get', '/directives/registry/stats', D, 'Organ donation registry statistics', {
    access: 'MINISTRY (aggregate, small cells suppressed)',
  }),
];
