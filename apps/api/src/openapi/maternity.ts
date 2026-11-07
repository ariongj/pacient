import {
  arr,
  bool,
  date,
  dateTime,
  enumOf,
  int,
  num,
  obj,
  op,
  q,
  str,
  type ModuleOperation,
} from './modules.js';
import {
  OUTCOMES,
  PRESENTATIONS,
  RISK_FACTORS,
  URINE_PROTEIN,
} from '../modules/maternity/definitions.js';

/** OpenAPI entries for antenatal care (/maternity). */
export const MATERNITY_TAGS = [
  {
    name: 'Antenatal care',
    description: 'Pregnancy records, antenatal visits and risk assessment.',
  },
];

const T = 'Antenatal care';
const riskFactors = arr(enumOf(...RISK_FACTORS));

export const MATERNITY_OPERATIONS: ModuleOperation[] = [
  op('get', '/maternity/definitions', T, 'Risk factors, outcomes, contact schedule and key tests'),
  op(
    'get',
    '/maternity/patients/{patientId}',
    T,
    'A patient’s pregnancies with visits and schedule',
    {
      access: 'DOCTOR, NURSE (care team)',
    },
  ),
  op('post', '/maternity/patients/{patientId}/pregnancies', T, 'Book a pregnancy', {
    access: 'DOCTOR, NURSE (care team)',
    description:
      'EDD from the last menstrual period (LMP + 280 days) or a dating scan; when both are given the scan is used and a difference of more than 7 days is returned as a warning. Age risk factors are added automatically.',
    body: obj(
      {
        lmpDate: date,
        scanEdd: date,
        gravida: int({ minimum: 1, maximum: 30 }),
        para: int({ minimum: 0, maximum: 29 }),
        riskFactors,
        otherRiskNote: str({ maxLength: 200 }),
      },
      ['gravida', 'para'],
    ),
    responses: { '201': 'The booked pregnancy and dating warnings', '409': 'Already ongoing' },
  }),
  op('patch', '/maternity/pregnancies/{id}', T, 'Change the dating, gravida/para or risk factors', {
    access: 'DOCTOR, NURSE (care team)',
    body: obj({
      dating: obj({ lmpDate: date, scanEdd: date }),
      gravida: int({ minimum: 1, maximum: 30 }),
      para: int({ minimum: 0, maximum: 29 }),
      riskFactors,
      otherRiskNote: str({ maxLength: 200 }),
      reason: str({ maxLength: 300 }),
    }),
  }),
  op('post', '/maternity/pregnancies/{id}/visits', T, 'Record an antenatal visit', {
    access: 'DOCTOR, NURSE (care team)',
    description:
      'Gestational age is computed from the EDD. The response lists alerts (pre-eclampsia, fetal heart rate, fetal movements, fundal height, presentation); they never block recording.',
    body: obj({
      visitAt: dateTime,
      systolic: int({ minimum: 50, maximum: 260 }),
      diastolic: int({ minimum: 30, maximum: 160 }),
      weightKg: { ...num, minimum: 25, maximum: 250 },
      fundalHeightCm: { ...num, minimum: 5, maximum: 60 },
      fetalHeartRate: int({ minimum: 50, maximum: 240 }),
      presentation: enumOf(...PRESENTATIONS),
      urineProtein: enumOf(...URINE_PROTEIN),
      oedema: bool,
      fetalMovements: bool,
      notes: str({ maxLength: 2000 }),
      nextVisitDate: date,
    }),
  }),
  op('post', '/maternity/pregnancies/{id}/close', T, 'Record the outcome of a pregnancy', {
    access: 'DOCTOR, NURSE (care team)',
    description:
      'Deliveries are normally closed by registering the birth from the mother’s record.',
    body: obj({ outcome: enumOf(...OUTCOMES), endedAt: dateTime, note: str({ maxLength: 500 }) }, [
      'outcome',
    ]),
  }),
  op('get', '/maternity/worklist', T, 'Ongoing pregnancies of patients in my care', {
    access: 'DOCTOR, NURSE (care team)',
    params: [
      q('filter', enumOf('ALL', 'HIGH_RISK', 'OVERDUE_CONTACT', 'NEAR_EDD', 'POST_TERM', 'ALERTS')),
      q('q', str()),
      q('page', int({ minimum: 1 })),
      q('pageSize', int({ minimum: 1, maximum: 100 })),
    ],
  }),
  op('get', '/maternity/dashboard', T, 'Maternity dashboard (small cells suppressed)', {
    access: 'MINISTRY (national), DIRECTOR (own facility)',
  }),
  op('get', '/maternity/mine', T, 'My pregnancy (portal)', {
    access: 'PATIENT (own record, or guardian with full access)',
  }),
];
