import {
  bool,
  date,
  dateTime,
  enumOf,
  int,
  obj,
  op,
  q,
  str,
  uuid,
  type ModuleOperation,
} from './modules.js';

/** OpenAPI entries for medical equipment (/equipment). */
export const EQUIPMENT_TAGS = [
  {
    name: 'Medical equipment',
    description: 'Equipment register, maintenance schedule and faults.',
  },
];

const E = 'Medical equipment';
const CATEGORIES = [
  'VENTILATOR',
  'MONITOR',
  'DEFIBRILLATOR',
  'INFUSION_PUMP',
  'IMAGING',
  'LAB_ANALYSER',
  'DIALYSIS',
  'OTHER',
];
const STATUSES = ['IN_SERVICE', 'OUT_OF_SERVICE', 'IN_MAINTENANCE', 'RETIRED'];
const STAFF = 'DOCTOR, NURSE, PHARMACIST, DIRECTOR (own facility)';

const itemFields = {
  assetTag: str({ pattern: '^[A-Z0-9][A-Z0-9-]{1,39}$' }),
  category: enumOf(...CATEGORIES),
  name: str({ minLength: 2, maxLength: 200 }),
  manufacturer: str({ maxLength: 120 }),
  model: str({ maxLength: 120 }),
  serialNumber: str({ maxLength: 120 }),
  unitId: uuid,
  criticality: enumOf('HIGH', 'MEDIUM', 'LOW'),
  serviceIntervalDays: int({ minimum: 1, maximum: 3650 }),
  commissionedOn: date,
  lastServiceAt: date,
};

export const EQUIPMENT_OPERATIONS: ModuleOperation[] = [
  op('get', '/equipment/meta', E, 'Categories, statuses, units and what I may do', {
    access: `${STAFF}, MINISTRY`,
  }),
  op('get', '/equipment/items', E, 'Equipment of my facility', {
    access: STAFF,
    params: [
      q('unitId', uuid),
      q('category', enumOf(...CATEGORIES)),
      q('status', enumOf(...STATUSES)),
      q('maintenance', enumOf('OVERDUE', 'DUE_SOON')),
      q('q', str({ maxLength: 100 }), 'Asset tag, name, model or serial number'),
      q('tag', str({ maxLength: 40 }), 'Exact asset tag (scanned label)'),
      q('includeRetired', bool),
      q('page', int({ minimum: 1 })),
      q('pageSize', int({ minimum: 1, maximum: 100 })),
    ],
  }),
  op('post', '/equipment/items', E, 'Add equipment to the register', {
    access: 'DIRECTOR (own facility)',
    body: obj(itemFields, ['assetTag', 'category', 'name', 'criticality']),
    responses: { '201': 'Created', '409': 'Asset tag already used at the facility' },
  }),
  op('get', '/equipment/items/{id}', E, 'Equipment with its service and fault history', {
    access: STAFF,
  }),
  op('patch', '/equipment/items/{id}', E, 'Edit equipment details', {
    access: 'DIRECTOR (own facility)',
    description: 'Changing the service interval or last service date recomputes the next due date.',
    body: obj(itemFields),
  }),
  op('post', '/equipment/items/{id}/retire', E, 'Retire equipment', {
    access: 'DIRECTOR (own facility)',
    body: obj({ reason: str({ minLength: 5, maxLength: 500 }) }, ['reason']),
  }),
  op(
    'post',
    '/equipment/items/{id}/events',
    E,
    'Record a service, fault, repair or status change',
    {
      access: 'DOCTOR, NURSE, PHARMACIST (faults); DIRECTOR (all kinds)',
      description:
        'Append-only history. A service sets the next due date; a fault takes high-criticality equipment out of service automatically; a fault can be linked to a safety incident of the facility by its reference.',
      body: obj(
        {
          kind: enumOf('SERVICE', 'FAULT', 'REPAIR', 'STATUS'),
          description: str({ minLength: 5, maxLength: 500 }),
          occurredAt: dateTime,
          status: enumOf('IN_SERVICE', 'OUT_OF_SERVICE', 'IN_MAINTENANCE'),
          incidentReference: str({ maxLength: 30 }),
        },
        ['kind', 'description'],
      ),
      responses: { '201': 'Recorded' },
    },
  ),
  op('post', '/equipment/import', E, 'Import equipment from CSV', {
    access: 'DIRECTOR (own facility)',
    description:
      'Columns: assetTag, category, name, manufacturer, model, serialNumber, unitCode, criticality, serviceIntervalDays, commissionedOn, lastServiceAt. Existing asset tags are updated (the status never changes). dryRun (default true) only validates; nothing is applied while any row has an error.',
    body: obj({ csv: str({ maxLength: 190000 }), dryRun: bool }, ['csv']),
  }),
  op('get', '/equipment/maintenance', E, 'Overdue, due-soon and out-of-service equipment', {
    access: STAFF,
    params: [q('unitId', uuid)],
  }),
  op('get', '/equipment/availability', E, 'Critical equipment in service per ward', {
    access: STAFF,
  }),
  op('get', '/equipment/national', E, 'National equipment availability and maintenance', {
    access: 'MINISTRY',
    description:
      'Ventilators, defibrillators and dialysis machines in service by facility and municipality, overdue maintenance and faults per month. Aggregates only.',
  }),
];
