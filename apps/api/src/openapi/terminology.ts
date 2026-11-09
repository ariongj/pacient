import { bool, enumOf, int, obj, op, q, str, uuid, type ModuleOperation } from './modules.js';

/** OpenAPI entries for terminology (/terminology). */
export const TERMINOLOGY_TAGS = [
  { name: 'Terminology', description: 'Code systems, versions, concepts and versioned mappings.' },
];

const T = 'Terminology';
const READ = 'Any staff member (patients are refused)';
const MANAGE_SYSTEM =
  'MINISTRY for national (EXTERNAL) systems; DIRECTOR for LOCAL systems of their facility';
const MANAGE_MAP =
  'MINISTRY for national mappings; DIRECTOR when the mapping uses a LOCAL system of their facility';
const page = [q('page', int({ minimum: 1 })), q('pageSize', int({ minimum: 1, maximum: 200 }))];
const csv = {
  type: 'string',
  description: 'CSV file as the request body (Content-Type: text/csv, at most 5 MB)',
};
const importParams = [
  q('version', str({ maxLength: 40 }), 'Version label, e.g. 2019-KS-2 (required)'),
  q('notes', str({ maxLength: 2000 })),
  q('dryRun', bool, 'Validate and compare only; nothing is saved'),
];
const equivalence = enumOf('EQUIVALENT', 'WIDER', 'NARROWER', 'RELATEDTO', 'UNMATCHED');

export const TERMINOLOGY_OPERATIONS: ModuleOperation[] = [
  op('get', '/terminology/systems', T, 'Code systems with their active version', { access: READ }),
  op('post', '/terminology/systems', T, 'Create a code system', {
    access: MANAGE_SYSTEM,
    body: obj(
      {
        code: str({ pattern: '^[A-Z0-9][A-Z0-9-]{1,39}$' }),
        name: str({ minLength: 3, maxLength: 200 }),
        url: str({ format: 'uri', maxLength: 300 }),
        publisher: str({ maxLength: 200 }),
        kind: enumOf('EXTERNAL', 'LOCAL'),
        description: str({ maxLength: 4000 }),
      },
      ['code', 'name', 'url', 'kind'],
    ),
    responses: { '201': 'Created', '409': 'Code or URL already used' },
  }),
  op('get', '/terminology/systems/{id}', T, 'A code system and all its versions', { access: READ }),
  op('patch', '/terminology/systems/{id}', T, 'Change the name, publisher or description', {
    access: MANAGE_SYSTEM,
    body: obj({
      name: str({ minLength: 3, maxLength: 200 }),
      publisher: str({ maxLength: 200 }),
      description: str({ maxLength: 4000 }),
    }),
  }),
  op('get', '/terminology/systems/{id}/concepts', T, 'Search concepts', {
    access: READ,
    description:
      'Code prefix or words of the display in English, Albanian or Serbian. Active version unless versionId is given.',
    params: [q('q', str({ maxLength: 100 })), q('versionId', uuid), q('activeOnly', bool), ...page],
  }),
  op(
    'get',
    '/terminology/systems/{id}/concept',
    T,
    'A concept with parent, children and mappings',
    {
      access: READ,
      params: [q('code', str({ maxLength: 40 }), 'The code (required)'), q('versionId', uuid)],
    },
  ),
  op(
    'post',
    '/terminology/systems/{id}/versions',
    T,
    'Import a new version from CSV (as a draft)',
    {
      access: MANAGE_SYSTEM,
      description:
        'Columns: code,display,display_sq,display_sr,parent,active. Every error is reported by line and nothing is saved while there are errors. The response compares the draft with the active version.',
      params: importParams,
      body: csv,
      responses: { '201': 'Draft created', '400': 'Errors by line', '409': 'Version exists' },
    },
  ),
  op('get', '/terminology/versions/{id}/diff', T, 'Compare a version with the active one', {
    access: READ,
    description: 'Added, removed, display changes, inactivated, reactivated and moved codes.',
  }),
  op('get', '/terminology/versions/{id}/export', T, 'Download a version as CSV', {
    access: READ,
    description: 'Cells that a spreadsheet would run as a formula start with an apostrophe.',
    responses: { '200': 'text/csv' },
  }),
  op('post', '/terminology/versions/{id}/activate', T, 'Activate a draft version', {
    access: MANAGE_SYSTEM,
    description: 'The previous active version is retired in the same transaction.',
    responses: { '200': 'Activated', '409': 'Not a draft' },
  }),
  op('delete', '/terminology/versions/{id}', T, 'Discard a draft version', {
    access: MANAGE_SYSTEM,
    responses: { '204': 'Discarded', '409': 'Not a draft' },
  }),
  op('get', '/terminology/maps', T, 'Mappings between code systems', { access: READ }),
  op('post', '/terminology/maps', T, 'Create a mapping', {
    access: MANAGE_MAP,
    body: obj(
      {
        code: str({ pattern: '^[A-Z0-9][A-Z0-9-]{1,59}$' }),
        name: str({ minLength: 3, maxLength: 200 }),
        url: str({ format: 'uri', maxLength: 300 }),
        sourceSystemId: uuid,
        targetSystemId: uuid,
      },
      ['code', 'name', 'url', 'sourceSystemId', 'targetSystemId'],
    ),
  }),
  op('get', '/terminology/maps/{id}', T, 'A mapping and its versions', { access: READ }),
  op('get', '/terminology/maps/{id}/entries', T, 'Entries of a mapping version', {
    access: READ,
    params: [
      q('q', str({ maxLength: 100 })),
      q('versionId', uuid),
      q('equivalence', equivalence),
      ...page,
    ],
  }),
  op(
    'post',
    '/terminology/maps/{id}/versions',
    T,
    'Import a mapping version from CSV (as a draft)',
    {
      access: MANAGE_MAP,
      description:
        'Columns: source_code,target_code,equivalence,comment (and optionally source_display). Source and target codes are checked against the active versions; active source codes without an entry are reported.',
      params: importParams,
      body: csv,
      responses: { '201': 'Draft created', '400': 'Errors by line', '409': 'No active version' },
    },
  ),
  op('get', '/terminology/map-versions/{id}/export', T, 'Download a mapping version as CSV', {
    access: READ,
    responses: { '200': 'text/csv' },
  }),
  op('post', '/terminology/map-versions/{id}/activate', T, 'Activate a draft mapping version', {
    access: MANAGE_MAP,
  }),
  op('delete', '/terminology/map-versions/{id}', T, 'Discard a draft mapping version', {
    access: MANAGE_MAP,
    responses: { '204': 'Discarded' },
  }),
  op('get', '/terminology/translate', T, 'Translate a code with a mapping', {
    access: READ,
    params: [
      q('map', str({ maxLength: 300 }), 'Mapping code or URL'),
      q('code', str({ maxLength: 40 })),
    ],
  }),
  op('get', '/terminology/fhir/CodeSystem', T, 'FHIR CodeSystem search (summary)', {
    access: READ,
    params: [q('url', str()), q('name', str())],
    responses: { '200': 'FHIR Bundle (application/fhir+json)' },
  }),
  op('get', '/terminology/fhir/CodeSystem/$lookup', T, 'FHIR CodeSystem $lookup', {
    access: READ,
    params: [q('system', str(), 'Canonical URL or code'), q('code', str())],
    responses: { '200': 'FHIR Parameters', '404': 'OperationOutcome' },
  }),
  op('get', '/terminology/fhir/CodeSystem/$validate-code', T, 'FHIR CodeSystem $validate-code', {
    access: READ,
    params: [q('url', str()), q('system', str()), q('code', str()), q('display', str())],
    responses: { '200': 'FHIR Parameters (result, message, display)' },
  }),
  op('get', '/terminology/fhir/CodeSystem/{id}', T, 'FHIR CodeSystem with concepts', {
    access: READ,
    description: 'Concepts of the active version (content "complete" up to 5000 concepts).',
  }),
  op('get', '/terminology/fhir/ConceptMap', T, 'FHIR ConceptMap search (summary)', {
    access: READ,
    params: [q('url', str()), q('name', str())],
  }),
  op('get', '/terminology/fhir/ConceptMap/$translate', T, 'FHIR ConceptMap $translate', {
    access: READ,
    params: [q('url', str(), 'ConceptMap URL or code'), q('code', str()), q('system', str())],
    responses: { '200': 'FHIR Parameters', '404': 'OperationOutcome' },
  }),
  op('get', '/terminology/fhir/ConceptMap/{id}', T, 'FHIR ConceptMap with its active entries', {
    access: READ,
  }),
];
