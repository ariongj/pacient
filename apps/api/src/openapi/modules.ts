/**
 * OpenAPI registry entries for the hospital and public-health modules (theatre, stock, images,
 * scheduling, vaccination, account security, medication safety, blood bank, nutrition, billing,
 * early warning, surveillance, video visits). Imported by spec.ts. A test compares the whole registry
 * with the routes the Express routers actually register, so a new endpoint cannot be forgotten.
 */
type Schema = Record<string, unknown>;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Auth = 'user' | 'partner' | 'lab' | 'none';

export interface ModuleOperation {
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  auth: Auth;
  access?: string;
  params?: {
    name: string;
    in: 'path' | 'query' | 'header';
    required?: boolean;
    description?: string;
    schema?: Schema;
  }[];
  body?: Schema;
  responses?: Record<string, string>;
}

export const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra });
export const int = (extra: Schema = {}): Schema => ({ type: 'integer', ...extra });
export const num: Schema = { type: 'number' };
export const bool: Schema = { type: 'boolean' };
export const uuid: Schema = { type: 'string', format: 'uuid' };
export const date: Schema = { type: 'string', format: 'date' };
export const dateTime: Schema = { type: 'string', format: 'date-time' };
export const arr = (items: Schema, extra: Schema = {}): Schema => ({
  type: 'array',
  items,
  ...extra,
});
export const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: 'object',
  properties,
  required,
});
export const enumOf = (...values: string[]): Schema => ({ type: 'string', enum: values });
export const reason = obj({ reason: str({ minLength: 3, maxLength: 500 }) }, ['reason']);

/** Path parameters are derived from {name} segments; only query/header params are listed. */
export function op(
  method: Method,
  path: string,
  tag: string,
  summary: string,
  extra: Partial<Omit<ModuleOperation, 'method' | 'path' | 'tag' | 'summary'>> = {},
): ModuleOperation {
  const pathParams = [...path.matchAll(/\{(\w+)\}/g)].map((m) => ({
    name: m[1]!,
    in: 'path' as const,
    required: true,
    schema: /Uid$/.test(m[1]!) ? str() : uuid,
  }));
  return {
    method,
    path,
    tag,
    summary,
    auth: 'user',
    ...extra,
    params: [...pathParams, ...(extra.params ?? [])],
  };
}
export const q = (name: string, schema: Schema, description?: string) => ({
  name,
  in: 'query' as const,
  schema,
  description,
});

export const MODULE_TAGS: { name: string; description: string }[] = [
  {
    name: 'Operating theatres',
    description: 'Surgical requests, theatre schedule, WHO checklist.',
  },
  { name: 'Pharmacy stock', description: 'Medication catalogue, batches, receipts, availability.' },
  { name: 'Scheduling', description: 'Consulting hours, free slots and online booking.' },
  { name: 'Vaccination', description: 'National immunization calendar, due doses, coverage.' },
  { name: 'Account security', description: 'Passkeys, signed-in devices, sign-in history.' },
  {
    name: 'Medication safety',
    description: 'Interaction, allergy, kidney, age and pregnancy checks.',
  },
  { name: 'Blood bank', description: 'Blood groups, stock, crossmatch, transfusions, reactions.' },
  { name: 'Nutrition', description: 'Diet orders, malnutrition screening, kitchen lists.' },
  { name: 'Billing', description: 'Insurance, tariff, charges, co-payments, claims.' },
  { name: 'Early warning', description: 'NEWS2 scores, escalation and the ward board.' },
  { name: 'Surveillance', description: 'Notifiable disease case reports and dashboards.' },
  { name: 'Video visits', description: 'Telemedicine rooms and WebRTC signalling.' },
];

const T = 'Operating theatres';
const S = 'Pharmacy stock';
const SCH = 'Scheduling';
const V = 'Vaccination';
const SEC = 'Account security';
const SAF = 'Medication safety';
const BB = 'Blood bank';
const N = 'Nutrition';
const B = 'Billing';
const EW = 'Early warning';
const SV = 'Surveillance';
const VV = 'Video visits';
const IMG = 'Imaging';
const P = 'Partner API';

const checklist = obj({ confirmations: obj({}), note: str({ maxLength: 1000 }) });

export const MODULE_OPERATIONS: ModuleOperation[] = [
  // Operating theatres
  op('get', '/theatre/theatres', T, 'Operating theatres of my facility'),
  op('get', '/theatre/doctors', T, 'Surgeons and anaesthetists for the team selects'),
  op('get', '/theatre/schedule', T, 'Theatre day list', {
    params: [q('date', date), q('theatreUnitId', uuid)],
  }),
  op('get', '/theatre/requests', T, 'Operations waiting for a theatre'),
  op('post', '/theatre/cases', T, 'Request an operation', {
    access: 'DOCTOR with write access',
    body: obj(
      {
        patientId: uuid,
        procedure: str({ minLength: 3, maxLength: 300 }),
        procedureCode: str({ maxLength: 20 }),
        laterality: enumOf('LEFT', 'RIGHT', 'BILATERAL', 'NOT_APPLICABLE'),
        priority: enumOf('ELECTIVE', 'URGENT', 'EMERGENCY'),
        indication: str({ minLength: 5, maxLength: 1000 }),
        primarySurgeonId: uuid,
        assistantId: uuid,
        anaesthetistId: uuid,
        anaesthesiaType: enumOf(
          'GENERAL',
          'SPINAL',
          'EPIDURAL',
          'REGIONAL_BLOCK',
          'LOCAL',
          'SEDATION',
        ),
        estimatedMinutes: int({ minimum: 5, maximum: 1440 }),
        admissionId: uuid,
        consentRecordId: uuid,
      },
      ['patientId', 'procedure', 'laterality', 'indication', 'primarySurgeonId'],
    ),
  }),
  op('get', '/theatre/cases/{id}', T, 'Surgical case'),
  op('post', '/theatre/cases/{id}/schedule', T, 'Schedule in a theatre', {
    body: obj(
      {
        theatreUnitId: uuid,
        scheduledStart: dateTime,
        estimatedMinutes: int(),
        consentWaiverReason: str({ minLength: 10 }),
        force: bool,
        forceReason: str({ minLength: 5 }),
      },
      ['theatreUnitId', 'scheduledStart'],
    ),
    responses: { '409': 'THEATRE_BOOKED, SURGEON_DOUBLE_BOOKED or CONSENT_REQUIRED' },
  }),
  op('post', '/theatre/cases/{id}/postpone', T, 'Postpone an operation', { body: reason }),
  op('post', '/theatre/cases/{id}/cancel', T, 'Cancel an operation', { body: reason }),
  op('post', '/theatre/cases/{id}/sign-in', T, 'WHO checklist – sign in (before anaesthesia)', {
    body: checklist,
  }),
  op('post', '/theatre/cases/{id}/time-out', T, 'WHO checklist – time out (before incision)', {
    body: checklist,
  }),
  op('post', '/theatre/cases/{id}/sign-out', T, 'WHO checklist – sign out (before leaving)', {
    body: checklist,
  }),
  op('post', '/theatre/cases/{id}/complete', T, 'Sign the operation note and complete', {
    access: 'Primary or assistant surgeon',
    body: obj(
      {
        operationNote: str({ minLength: 20, maxLength: 20000 }),
        complications: str({ maxLength: 2000 }),
        estimatedBloodLossMl: int({ minimum: 0 }),
      },
      ['operationNote'],
    ),
  }),
  op('get', '/theatre/patients/{patientId}/cases', T, "A patient's operations", {
    params: [q('status', str())],
  }),

  // Pharmacy stock
  op('get', '/stock/catalog', S, 'National medication catalogue', {
    params: [q('q', str()), q('essential', enumOf('true', 'false'))],
  }),
  op('post', '/stock/catalog', S, 'Add a catalogue item', {
    access: 'MINISTRY',
    body: obj(
      {
        name: str(),
        atcCode: str(),
        form: str(),
        strength: str(),
        unit: str(),
        isEssential: bool,
        barcode: str({
          description:
            'Pack barcode (GTIN/EAN with check digit) for barcode-checked administration; unique',
        }),
        ingredients: arr(str(), { description: 'Active ingredients (INN)' }),
      },
      ['name', 'form', 'unit'],
    ),
    responses: { '409': 'Already in the catalogue, or the barcode belongs to another item' },
  }),
  op('patch', '/stock/catalog/{id}', S, 'Change a catalogue item', {
    access: 'MINISTRY',
    description:
      'Any field of the item (name, ATC code, form, strength, unit, essential, barcode, ' +
      'ingredients) or isActive.',
  }),
  op('get', '/stock/levels', S, 'Stock levels of my facility', {
    access: 'PHARMACIST, DIRECTOR (read-only)',
    params: [
      q('q', str()),
      q('status', enumOf('ALL', 'LOW', 'OUT', 'EXPIRING', 'EXPIRED', 'ATTENTION')),
    ],
  }),
  op('get', '/stock/items/{itemId}/batches', S, 'Batches of an item (earliest expiry first)'),
  op('post', '/stock/receipts', S, 'Receive a delivery', {
    access: 'PHARMACIST',
    body: obj(
      {
        supplier: str(),
        items: arr(
          obj(
            { itemId: uuid, batchNumber: str(), expiryDate: date, quantity: int({ minimum: 1 }) },
            ['itemId', 'batchNumber', 'expiryDate', 'quantity'],
          ),
        ),
      },
      ['items'],
    ),
  }),
  op('post', '/stock/adjustments', S, 'Adjust a batch (never below zero)', {
    access: 'PHARMACIST',
    body: obj(
      {
        batchId: uuid,
        quantity: int(),
        type: enumOf('ADJUSTMENT', 'EXPIRED', 'DAMAGED', 'RETURN'),
        reason: str({ minLength: 5 }),
      },
      ['batchId', 'quantity', 'type', 'reason'],
    ),
  }),
  op('put', '/stock/settings/{itemId}', S, 'Set the reorder level', {
    body: obj({ reorderLevel: int({ minimum: 0 }) }, ['reorderLevel']),
  }),
  op('get', '/stock/movements', S, 'Stock ledger (append-only)', {
    params: [q('itemId', uuid), q('from', date), q('to', date)],
  }),
  op('get', '/stock/national', S, 'National medicine availability', {
    access: 'MINISTRY',
    params: [q('essential', enumOf('true', 'false')), q('format', enumOf('json', 'csv'))],
  }),

  // Images (PACS)
  op('post', '/imaging/orders/{id}/study', IMG, 'Link a PACS study to an order', {
    access: 'Radiology unit staff',
    body: obj({ studyInstanceUid: str() }, ['studyInstanceUid']),
  }),
  op('post', '/imaging/orders/{id}/study/lookup', IMG, 'Find the study by accession number'),
  op('get', '/imaging/orders/{id}/images', IMG, 'Series and images of the linked study'),
  op(
    'get',
    '/imaging/orders/{id}/images/{seriesUid}/{instanceUid}/rendered',
    IMG,
    'Rendered image (PNG/JPEG) through the authorised proxy',
    { params: [q('window', num), q('level', num)] },
  ),

  // Scheduling
  op('get', '/scheduling/doctors', SCH, 'Doctors offering appointments', {
    params: [q('specialty', str()), q('facilityId', uuid)],
  }),
  op('get', '/scheduling/doctors/{doctorId}/availability', SCH, 'Consulting hours'),
  op('put', '/scheduling/doctors/{doctorId}/availability', SCH, 'Replace weekly consulting hours', {
    body: obj(
      {
        blocks: arr(
          obj(
            {
              weekday: int({ minimum: 0, maximum: 6 }),
              startTime: str({ pattern: '^\\d{2}:\\d{2}$' }),
              endTime: str({ pattern: '^\\d{2}:\\d{2}$' }),
              slotMinutes: int({ minimum: 5, maximum: 240 }),
              portalBookable: bool,
              validFrom: date,
              validUntil: date,
            },
            ['weekday', 'startTime', 'endTime', 'slotMinutes'],
          ),
        ),
      },
      ['blocks'],
    ),
  }),
  op('post', '/scheduling/doctors/{doctorId}/exceptions', SCH, 'Add an absence', {
    body: obj({ startsAt: dateTime, endsAt: dateTime, reason: str() }, ['startsAt', 'endsAt']),
  }),
  op('delete', '/scheduling/doctors/{doctorId}/exceptions/{id}', SCH, 'Remove an absence'),
  op('get', '/scheduling/slots', SCH, 'Free slots (max 31 days)', {
    params: [q('doctorId', uuid), q('from', date), q('to', date)],
  }),
  op('post', '/scheduling/book', SCH, 'Book a slot online', {
    access: 'PATIENT (or guardian)',
    body: obj(
      {
        doctorId: uuid,
        start: dateTime,
        reason: str({ minLength: 2, maxLength: 500 }),
        mode: enumOf('IN_PERSON', 'VIDEO'),
      },
      ['doctorId', 'start', 'reason'],
    ),
    responses: { '201': 'Confirmed appointment', '409': 'The slot was just taken' },
  }),

  // Vaccination
  op('get', '/vaccination/schedule', V, 'National immunization calendar'),
  op('post', '/vaccination/schedule', V, 'Add a calendar dose', { access: 'MINISTRY' }),
  op('patch', '/vaccination/schedule/{id}', V, 'Change a calendar dose', { access: 'MINISTRY' }),
  op('get', '/vaccination/patients/{patientId}/status', V, 'Given, due and overdue doses'),
  op('post', '/vaccination/patients/{patientId}/doses', V, 'Record a calendar dose', {
    access: 'NURSE, DOCTOR (care team)',
    body: obj(
      {
        scheduleItemId: uuid,
        administeredAt: dateTime,
        lotNumber: str(),
        site: str(),
        notes: str(),
      },
      ['scheduleItemId'],
    ),
  }),
  op('post', '/vaccination/patients/{patientId}/link', V, 'Count a vaccination for a dose', {
    body: obj({ immunizationId: uuid, scheduleItemId: uuid }, ['immunizationId', 'scheduleItemId']),
  }),
  op('get', '/vaccination/due', V, 'Children with due or overdue doses at my facility', {
    params: [q('status', enumOf('DUE', 'OVERDUE')), q('withinDays', int()), q('q', str())],
  }),
  op('get', '/vaccination/coverage', V, 'Coverage by birth cohort (small cells suppressed)', {
    access: 'MINISTRY, DIRECTOR',
    params: [q('cohort', enumOf('12-23m', '24-35m', '6-7y')), q('facilityId', uuid)],
  }),
  op('get', '/vaccination/coverage/facilities', V, 'Facilities for the coverage filter', {
    access: 'MINISTRY',
  }),

  // Account security
  op('get', '/auth/security/passkeys', SEC, 'My passkeys'),
  op('post', '/auth/security/passkeys/options', SEC, 'Start passkey registration'),
  op('post', '/auth/security/passkeys', SEC, 'Finish passkey registration', {
    body: obj({ response: obj({}), deviceName: str({ maxLength: 100 }) }, ['response']),
    responses: { '403': 'REAUTH_REQUIRED – sign in again or send the password' },
  }),
  op('patch', '/auth/security/passkeys/{id}', SEC, 'Rename a passkey'),
  op('delete', '/auth/security/passkeys/{id}', SEC, 'Remove a passkey'),
  op('post', '/auth/security/passkeys/login/options', SEC, 'Passkey sign-in options', {
    auth: 'none',
  }),
  op('post', '/auth/security/passkeys/login', SEC, 'Sign in with a passkey', {
    auth: 'none',
    body: obj({ response: obj({}) }, ['response']),
    responses: { '200': 'Access token; refresh cookie set' },
  }),
  op('post', '/auth/security/passkeys/mfa/options', SEC, 'Passkey as second step – options', {
    auth: 'none',
    body: obj({ mfaToken: str() }, ['mfaToken']),
  }),
  op('post', '/auth/security/passkeys/mfa', SEC, 'Passkey as second step', {
    auth: 'none',
    body: obj({ mfaToken: str(), response: obj({}) }, ['mfaToken', 'response']),
  }),
  op('get', '/auth/security/sessions', SEC, 'Signed-in devices'),
  op('post', '/auth/security/sessions/{id}/revoke', SEC, 'Sign out a device'),
  op('post', '/auth/security/sessions/revoke-others', SEC, 'Sign out all other devices'),
  op('get', '/auth/security/history', SEC, 'My sign-in and security events (90 days)', {
    params: [q('page', int({ minimum: 1 }))],
  }),

  // Medication safety
  op('post', '/safety/check', SAF, 'Check a medicine for a patient', {
    body: obj(
      {
        patientId: uuid,
        medication: str({ minLength: 2, maxLength: 200 }),
        catalogItemId: uuid,
        excludePrescriptionId: uuid,
      },
      ['patientId', 'medication'],
    ),
  }),
  op('post', '/safety/check-list', SAF, 'Pairwise check of a list of medicines', {
    body: obj(
      {
        medications: arr(obj({ medication: str(), catalogItemId: uuid }, ['medication'])),
        patientId: uuid,
      },
      ['medications'],
    ),
  }),
  op('get', '/safety/patients/{patientId}/alerts', SAF, 'Stored alerts per prescription'),
  op('get', '/safety/ingredients', SAF, 'Ingredient names (autocomplete)', {
    params: [q('q', str())],
  }),
  op('get', '/safety/interactions', SAF, 'Interaction database', { params: [q('q', str())] }),
  op('post', '/safety/interactions', SAF, 'Add an interaction', { access: 'MINISTRY' }),
  op('patch', '/safety/interactions/{id}', SAF, 'Change an interaction', { access: 'MINISTRY' }),

  // Blood bank
  op('get', '/blood-bank/me', BB, 'Whether I am blood bank staff'),
  op('get', '/blood-bank/colleagues', BB, 'Doctors and nurses (second checker)'),
  op('post', '/blood-bank/patients/{id}/blood-group', BB, 'Record a blood group result', {
    access: 'Blood bank staff',
    body: obj(
      {
        abo: enumOf('O', 'A', 'B', 'AB'),
        rhD: enumOf('POS', 'NEG'),
        antibodyScreen: enumOf('NEGATIVE', 'POSITIVE'),
        antibodies: str(),
      },
      ['abo', 'rhD'],
    ),
  }),
  op('get', '/blood-bank/patients/{id}', BB, 'Blood group, requests and transfusions'),
  op('post', '/blood-bank/units', BB, 'Receive a blood unit', { access: 'Blood bank staff' }),
  op('get', '/blood-bank/stock', BB, 'Stock by product and group'),
  op('post', '/blood-bank/units/{id}/discard', BB, 'Discard a unit', { body: reason }),
  op('post', '/blood-bank/requests', BB, 'Request blood products', {
    access: 'DOCTOR (care team)',
    body: obj(
      {
        patientId: uuid,
        product: enumOf('RED_CELLS', 'PLASMA', 'PLATELETS', 'CRYOPRECIPITATE', 'WHOLE_BLOOD'),
        units: int({ minimum: 1, maximum: 20 }),
        urgency: enumOf('ROUTINE', 'URGENT', 'EMERGENCY'),
        indication: str({ minLength: 5 }),
        haemoglobinGl: int(),
        exceptionReason: str(),
        admissionId: uuid,
        surgicalCaseId: uuid,
      },
      ['patientId', 'product', 'units', 'urgency', 'indication'],
    ),
  }),
  op('get', '/blood-bank/requests', BB, 'Request queue', { params: [q('status', str())] }),
  op('post', '/blood-bank/requests/{id}/sample', BB, 'Sample received'),
  op('get', '/blood-bank/requests/{id}/compatible-units', BB, 'Compatible units for a request'),
  op('post', '/blood-bank/requests/{id}/crossmatch', BB, 'Crossmatch and reserve units', {
    body: obj({ unitIds: arr(uuid), emergencyReason: str() }, ['unitIds']),
  }),
  op('post', '/blood-bank/requests/{id}/issue', BB, 'Issue a crossmatched unit', {
    body: obj({ unitId: uuid }, ['unitId']),
  }),
  op('post', '/blood-bank/requests/{id}/emergency-issue', BB, 'Emergency O RhD- issue', {
    body: obj({ unitId: uuid, reason: str({ minLength: 10 }) }, ['unitId', 'reason']),
  }),
  op('post', '/blood-bank/requests/{id}/cancel', BB, 'Cancel a request', { body: reason }),
  op('post', '/blood-bank/transfusions/{id}/start', BB, 'Bedside identity and unit check', {
    body: obj(
      {
        nationalId: str(),
        dateOfBirth: date,
        unitNumber: str(),
        secondCheckerId: uuid,
        vitals: obj({}),
      },
      ['nationalId', 'dateOfBirth', 'unitNumber', 'secondCheckerId'],
    ),
    responses: { '409': 'IDENTITY_MISMATCH, UNIT_MISMATCH or expired unit' },
  }),
  op('post', '/blood-bank/transfusions/{id}/confirm-check', BB, 'Second checker confirms', {
    responses: { '409': 'CHECK_EXPIRED' },
  }),
  op('post', '/blood-bank/transfusions/{id}/observation', BB, 'Record observations'),
  op('post', '/blood-bank/transfusions/{id}/complete', BB, 'Complete a transfusion'),
  op('post', '/blood-bank/transfusions/{id}/reaction', BB, 'Report a transfusion reaction', {
    body: obj(
      {
        type: enumOf('FEBRILE', 'ALLERGIC', 'HAEMOLYTIC', 'TACO', 'TRALI', 'ANAPHYLAXIS', 'OTHER'),
        severity: str(),
        details: str(),
        actionsTaken: str(),
      },
      ['type', 'severity'],
    ),
  }),
  op('get', '/blood-bank/reactions', BB, 'Haemovigilance (directors: suppressed counts)'),

  // Nutrition
  op('post', '/nutrition/admissions/{admissionId}/diet', N, 'Order a diet', {
    access: 'DOCTOR, NURSE (care team)',
    body: obj(
      {
        dietType: str(),
        restrictions: arr(str()),
        fluidLimitMl: int(),
        notes: str(),
        reason: str(),
        surgicalCaseId: uuid,
        startsAt: dateTime,
        endsAt: dateTime,
      },
      ['dietType'],
    ),
  }),
  op('get', '/nutrition/patients/{patientId}', N, 'Diet, fasting and screenings'),
  op('post', '/nutrition/patients/{patientId}/screenings', N, 'Record a nutrition screening', {
    body: obj({ tool: enumOf('NRS2002', 'MUST', 'STRONGKIDS'), answers: obj({}) }, [
      'tool',
      'answers',
    ]),
  }),
  op('get', '/nutrition/kitchen', N, 'Kitchen meal list', {
    params: [q('meal', enumOf('BREAKFAST', 'LUNCH', 'DINNER')), q('date', date), q('unitId', uuid)],
  }),
  op('get', '/nutrition/wards/{unitId}', N, 'Ward nutrition overview'),
  op('get', '/nutrition/screening-due', N, 'Admissions without a screening', {
    params: [q('unitId', uuid)],
  }),

  // Billing
  op('get', '/billing/patients', B, 'Find a patient for billing', { params: [q('q', str())] }),
  op('get', '/billing/patients/{patientId}/insurance', B, 'Insurance coverage'),
  op('post', '/billing/patients/{patientId}/insurance', B, 'Add coverage', {
    access: 'RECEPTION, DIRECTOR',
    body: obj(
      {
        insurer: enumOf('FSSH', 'PRIVATE', 'NONE'),
        policyNumber: str(),
        status: enumOf('ACTIVE', 'SUSPENDED', 'ENDED'),
        exemption: str(),
        validFrom: date,
        validUntil: date,
      },
      ['insurer', 'validFrom'],
    ),
  }),
  op('patch', '/billing/patients/{patientId}/insurance/{id}', B, 'Change coverage'),
  op(
    'post',
    '/billing/patients/{patientId}/insurance/verify',
    B,
    'Check eligibility with the Fund',
  ),
  op('get', '/billing/services', B, 'National tariff'),
  op('post', '/billing/services', B, 'Add a tariff item', { access: 'MINISTRY' }),
  op('patch', '/billing/services/{id}', B, 'Change a tariff item', { access: 'MINISTRY' }),
  op('get', '/billing/patients/{patientId}/charges', B, "A patient's charges and receipts"),
  op('get', '/billing/charges', B, 'Charges of my facility', { params: [q('status', str())] }),
  op('post', '/billing/charges', B, 'Add a manual charge'),
  op('post', '/billing/charges/{id}/void', B, 'Void a charge', { body: reason }),
  op('post', '/billing/capture', B, 'Capture charges from care now (idempotent)'),
  op('post', '/billing/payments', B, 'Take a co-payment (receipt)', {
    body: obj(
      { patientId: uuid, chargeIds: arr(uuid), method: enumOf('CASH', 'CARD', 'TRANSFER') },
      ['patientId', 'chargeIds', 'method'],
    ),
  }),
  op('get', '/billing/payments/{id}', B, 'Receipt'),
  op('get', '/billing/claims', B, 'Claims to the Health Insurance Fund'),
  op('post', '/billing/claims', B, 'Prepare a claim for a period', {
    body: obj({ periodFrom: date, periodTo: date }, ['periodFrom', 'periodTo']),
  }),
  op('get', '/billing/claims/{id}', B, 'Claim with lines', {
    params: [q('format', enumOf('json', 'csv'))],
  }),
  op('post', '/billing/claims/{id}/submit', B, 'Submit a claim'),
  op('post', '/billing/claims/{id}/discard', B, 'Discard a draft claim'),
  op('get', '/billing/summary', B, 'Billing summary of my facility'),
  op('get', '/partner/claims', P, 'Submitted claims', {
    auth: 'partner',
    access: 'claims.read',
    params: [q('status', str())],
  }),
  op('get', '/partner/claims/{id}', P, 'Claim lines (audited per patient)', {
    auth: 'partner',
    access: 'claims.read',
  }),
  op('post', '/partner/claims/{id}/decision', P, 'Record the Fund decision', {
    auth: 'partner',
    access: 'claims.read',
    body: obj(
      {
        status: enumOf('ACCEPTED', 'PARTIALLY_PAID', 'PAID', 'REJECTED'),
        paidCents: int({ minimum: 0 }),
        note: str({ maxLength: 1000 }),
        rejectedLineIds: arr(uuid),
      },
      ['status'],
    ),
  }),

  // Early warning
  op('get', '/early-warning/board', EW, 'Ward early-warning board', {
    params: [q('unitId', uuid)],
  }),
  op('get', '/early-warning/patients/{patientId}', EW, 'NEWS2 history'),
  op('post', '/early-warning/scores/{id}/acknowledge', EW, 'Acknowledge an alert', {
    body: obj({ note: str({ maxLength: 500 }) }),
  }),
  op('put', '/early-warning/patients/{patientId}/spo2-scale', EW, 'Set SpO2 scale 1 or 2', {
    access: 'DOCTOR',
    body: obj({ scale: int({ enum: [1, 2] }), reason: str() }, ['scale', 'reason']),
  }),

  // Surveillance
  op('get', '/surveillance/diseases', SV, 'Notifiable diseases'),
  op('post', '/surveillance/diseases', SV, 'Add a notifiable disease', { access: 'MINISTRY' }),
  op('patch', '/surveillance/diseases/{id}', SV, 'Change a notifiable disease', {
    access: 'MINISTRY',
  }),
  op('get', '/surveillance/my-cases', SV, 'My case reports', { access: 'DOCTOR' }),
  op('get', '/surveillance/patients/{patientId}/cases', SV, "A patient's case reports"),
  op('get', '/surveillance/cases', SV, 'Case reports', {
    access: 'MINISTRY (identifiable), DIRECTOR (own facility, no names)',
    params: [
      q('disease', str()),
      q('status', str()),
      q('from', date),
      q('to', date),
      q('facilityId', uuid),
    ],
  }),
  op('get', '/surveillance/cases/{id}', SV, 'Case report'),
  op('patch', '/surveillance/cases/{id}', SV, 'Complete a draft case report', {
    body: obj({
      onsetDate: date,
      classification: enumOf('SUSPECTED', 'PROBABLE', 'CONFIRMED'),
      details: obj({}),
    }),
  }),
  op('post', '/surveillance/cases/{id}/submit', SV, 'Submit to public health'),
  op('post', '/surveillance/cases/{id}/discard', SV, 'Not a case', { body: reason }),
  op('post', '/surveillance/cases/{id}/review', SV, 'Public health review', {
    access: 'MINISTRY',
    body: obj(
      {
        classification: enumOf('SUSPECTED', 'PROBABLE', 'CONFIRMED', 'DISCARDED'),
        note: str(),
      },
      ['classification'],
    ),
  }),
  op('get', '/surveillance/dashboard', SV, 'Weekly counts, municipalities and alerts', {
    params: [q('weeks', int({ minimum: 4, maximum: 52 }))],
  }),
  op('get', '/partner/surveillance/cases', P, 'Submitted case reports (audited per patient)', {
    auth: 'partner',
    access: 'surveillance.read',
    params: [q('since', dateTime)],
  }),
  op('get', '/partner/surveillance/summary', P, 'Weekly aggregates (suppressed)', {
    auth: 'partner',
    access: 'surveillance.read',
    params: [q('weeks', int())],
  }),

  // Video visits
  op('get', '/video/appointments/{id}', VV, 'Video appointment and room state'),
  op('post', '/video/appointments/{id}/join', VV, 'Join the room (ICE servers returned)', {
    access: "The appointment's doctor, patient or guardian",
    responses: { '409': 'TOO_EARLY or TOO_LATE' },
  }),
  op('post', '/video/sessions/{id}/signal', VV, 'Send a WebRTC signal', {
    body: obj({ kind: enumOf('ready', 'offer', 'answer', 'candidate', 'bye'), payload: {} }, [
      'kind',
    ]),
  }),
  op('get', '/video/sessions/{id}/signals', VV, 'Pending signals for me', {
    params: [q('after', int({ minimum: 0 }))],
  }),
  op('post', '/video/sessions/{id}/end', VV, 'End the visit'),
  op('get', '/video/waiting', VV, 'My patients in the waiting room', { access: 'DOCTOR' }),
];
