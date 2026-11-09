import { VERSIONED_TABLE_NAMES } from '../modules/history/definitions.js';
import { HISTORY_TYPES } from '../modules/history/fhir-history.js';
import { enumOf, int, op, q, str, type ModuleOperation } from './modules.js';

/** OpenAPI entries for record history (/history) and FHIR _history. */
export const HISTORY_TAGS = [
  {
    name: 'Record history',
    description: 'Version history of clinical records: who changed what and when.',
  },
];

const T = 'Record history';
const table = enumOf(...VERSIONED_TABLE_NAMES);
const STAFF =
  'DOCTOR, NURSE with read access to the patient (care team, cover, unit, emergency access); audited as a record view. Patients and guardians are refused.';

/** Replace the default (uuid) schema of non-id path parameters. */
function withPathSchemas(o: ModuleOperation, schemas: Record<string, ReturnType<typeof str>>) {
  return {
    ...o,
    params: o.params?.map((p) =>
      p.in === 'path' && schemas[p.name] ? { ...p, schema: schemas[p.name] } : p,
    ),
  };
}

export const HISTORY_OPERATIONS: ModuleOperation[] = [
  op('get', '/history/tables', T, 'Versioned record types and the fields shown in their history', {
    access: 'Any signed-in user (no patient data)',
  }),
  withPathSchemas(
    op(
      'get',
      '/history/patients/{patientId}/records/{table}/{resourceId}',
      T,
      'All versions of one record, newest first, with who changed which fields',
      {
        access: STAFF,
        description:
          'Each version names the person whose audit entry was written in the same transaction (null when none, e.g. laboratory interface or data load). A version that only moved the record from a merged duplicate has mergedMove = true. E-prescription codes are never shown.',
        responses: { '404': 'No such record in this patient’s chart' },
      },
    ),
    { table },
  ),
  op('get', '/history/patients/{patientId}/changes', T, 'Recent changes in a patient’s chart', {
    access: STAFF,
    params: [
      q('table', table),
      q('page', int({ minimum: 1 })),
      q('pageSize', int({ minimum: 1, maximum: 100 })),
    ],
  }),
  withPathSchemas(
    op(
      'get',
      '/fhir/{type}/{id}/_history',
      'FHIR',
      'Version history of a resource (Bundle type history)',
      {
        access: STAFF,
        description:
          'For AllergyIntolerance, Condition, MedicationRequest, Observation (laboratory results and vital signs), Immunization and Encounter.',
      },
    ),
    { type: enumOf(...HISTORY_TYPES), id: str({ description: 'Resource id' }) },
  ),
  withPathSchemas(
    op('get', '/fhir/{type}/{id}/_history/{vid}', 'FHIR', 'One version of a resource (vread)', {
      access: STAFF,
      responses: { '410': 'The resource did not exist in that version (deleted)' },
    }),
    {
      type: enumOf(...HISTORY_TYPES),
      id: str({ description: 'Resource id' }),
      vid: int({ minimum: 1 }),
    },
  ),
];
