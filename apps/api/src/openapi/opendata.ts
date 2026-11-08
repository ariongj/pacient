import { op, q, enumOf, type ModuleOperation } from './modules.js';

/** OpenAPI entries for open data (/open-data). */
export const OPENDATA_TAGS = [
  { name: 'Open data', description: 'Public national statistics without personal data.' },
];

const T = 'Open data';

/** Published dataset ids (kept equal to the module's list by test/opendata.test.ts). */
export const OPENDATA_DATASET_IDS = [
  'facilities',
  'waiting-times',
  'vaccination-coverage',
  'notifiable-diseases',
  'notifiable-diseases-municipality',
  'mortality',
  'bed-occupancy',
  'emergency-waiting',
  'screening-coverage',
];

const PUBLIC =
  'No sign-in. Aggregate figures only; counts from 1 to 4 are suppressed (null, row flagged `suppressed`), ' +
  'with secondary suppression where a hidden count could be worked out from a total. ' +
  '`Cache-Control: public, max-age=3600` and a strong ETag (send If-None-Match for 304). ' +
  'Built at most once every 10 minutes. Strict per-address rate limit. Licence: CC BY 4.0 (to be confirmed by the Ministry of Health).';

const dataset = op('get', '/open-data/{dataset}', T, 'One dataset as JSON or CSV', {
  auth: 'none',
  description:
    PUBLIC +
    ' JSON: title, description, methodology and column labels in the chosen language, generatedAt, period, rows. ' +
    'CSV: UTF-8 with BOM, CRLF line endings, headers in the chosen language, empty cells where suppressed, plus a Suppressed column; sent as an attachment.',
  params: [
    q('format', enumOf('json', 'csv'), 'Default json'),
    q('lang', enumOf('en', 'sq', 'sr'), 'Language of labels and CSV headers (default en)'),
  ],
  responses: {
    '200': 'Dataset (application/json or text/csv)',
    '304': 'Not modified (ETag matched)',
    '404': 'Unknown dataset',
    '429': 'Too many requests',
  },
});
dataset.params = dataset.params?.map((p) =>
  p.name === 'dataset'
    ? { ...p, schema: enumOf(...OPENDATA_DATASET_IDS), description: 'Dataset id from the index' }
    : p,
);

export const OPENDATA_OPERATIONS: ModuleOperation[] = [
  op('get', '/open-data', T, 'Index of published datasets', {
    auth: 'none',
    description:
      PUBLIC +
      ' Lists every dataset with its title, description, methodology and columns in English, Albanian and Serbian, and links to JSON and CSV.',
    responses: {
      '200': 'Dataset index with licence',
      '304': 'Not modified',
      '429': 'Too many requests',
    },
  }),
  dataset,
];
