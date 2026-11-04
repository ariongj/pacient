import { and, asc, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  appointments,
  bloodGroupTests,
  dietOrders,
  earlyWarningScores,
  immunizations,
  insuranceCoverages,
  medicationCatalog,
  prescriptions,
  stockBatches,
  stockMovements,
  surgicalCases,
  transfusionRequests,
  transfusions,
  bloodUnits,
  vaccineSchedule,
  videoSessions,
} from '../../db/schema.js';
import type { ViewOptions } from '../clinical/clinical.service.js';

/**
 * FHIR R4 resources for the hospital modules added after the first FHIR export: operations,
 * dispensing from stock, diets, NEWS2, blood group and transfusions, insurance coverage,
 * vaccination series and video visits. Content limits per purpose are applied by the caller
 * (fhir.service.ts); mappers take explicit flags for what clinical detail to include.
 */
type R = Record<string, unknown>;

const SYSTEMS = {
  loinc: 'http://loinc.org',
  snomed: 'http://snomed.info/sct',
  ucum: 'http://unitsofmeasure.org',
  atc: 'http://www.whocc.no/atc',
  actCode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  obsCategory: 'http://terminology.hl7.org/CodeSystem/observation-category',
  /** Pacient's own code systems, for concepts without a universal code here. */
  local: 'urn:pacient:codes',
} as const;

const ref = (type: string, id: string | null | undefined) =>
  id ? { reference: `${type}/${id}` } : undefined;
const clean = <T extends R>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : undefined);

/* ---------------------------------------------------------------- vital-sign extensions ----- */

/** Extra Observations for the NEWS2 inputs added to vital signs (ACVPU, oxygen, pain). */
export function extraVitalObservations(
  v: {
    id: string;
    encounterId?: string | null;
    recordedAt: string | Date;
    consciousness?: string | null;
    onSupplementalOxygen?: boolean | null;
    painScore?: number | null;
  },
  patientId: string,
): R[] {
  const base = {
    resourceType: 'Observation',
    status: 'final',
    category: [
      { coding: [{ system: SYSTEMS.obsCategory, code: 'vital-signs', display: 'Vital Signs' }] },
    ],
    subject: ref('Patient', patientId),
    encounter: ref('Encounter', v.encounterId ?? null),
    effectiveDateTime: iso(v.recordedAt),
  };
  const out: R[] = [];
  if (v.consciousness) {
    out.push(
      clean({
        ...base,
        id: `${v.id}-acvpu`,
        code: {
          coding: [
            { system: SYSTEMS.loinc, code: '80288-4', display: 'Level of consciousness' },
            { system: SYSTEMS.local, code: 'acvpu', display: 'ACVPU' },
          ],
        },
        valueCodeableConcept: {
          coding: [{ system: `${SYSTEMS.local}/acvpu`, code: v.consciousness }],
          text: ACVPU[v.consciousness] ?? v.consciousness,
        },
      }),
    );
  }
  if (v.onSupplementalOxygen !== null && v.onSupplementalOxygen !== undefined) {
    out.push(
      clean({
        ...base,
        id: `${v.id}-o2`,
        code: {
          coding: [
            {
              system: SYSTEMS.local,
              code: 'supplemental-oxygen',
              display: 'On supplemental oxygen',
            },
          ],
          text: 'Air or oxygen',
        },
        valueBoolean: v.onSupplementalOxygen,
      }),
    );
  }
  if (v.painScore !== null && v.painScore !== undefined) {
    out.push(
      clean({
        ...base,
        id: `${v.id}-pain`,
        code: {
          coding: [
            {
              system: SYSTEMS.loinc,
              code: '72514-3',
              display: 'Pain severity - 0-10 verbal numeric rating [Score] - Reported',
            },
          ],
        },
        valueInteger: v.painScore,
      }),
    );
  }
  return out;
}

const ACVPU: Record<string, string> = {
  A: 'Alert',
  C: 'New confusion',
  V: 'Responds to voice',
  P: 'Responds to pain',
  U: 'Unresponsive',
};

/** NEWS2 aggregate score (RCP 2017). SNOMED CT (UK) concept plus a local code. */
export function news2Observation(
  s: { id: string; score: number; risk: string; computedAt: string | Date; complete: boolean },
  patientId: string,
): R {
  return clean({
    resourceType: 'Observation',
    id: `news2-${s.id}`,
    status: s.complete ? 'final' : 'preliminary',
    category: [{ coding: [{ system: SYSTEMS.obsCategory, code: 'survey', display: 'Survey' }] }],
    code: {
      coding: [
        {
          system: SYSTEMS.snomed,
          code: '1104051000000101',
          display: 'Royal College of Physicians National Early Warning Score 2 total score',
        },
        { system: SYSTEMS.local, code: 'news2', display: 'NEWS2 total score' },
      ],
      text: 'NEWS2',
    },
    subject: ref('Patient', patientId),
    effectiveDateTime: iso(s.computedAt),
    valueInteger: s.score,
    interpretation: [
      {
        coding: [{ system: `${SYSTEMS.local}/news2-risk`, code: s.risk }],
        text: s.risk.toLowerCase().replace('_', '-'),
      },
    ],
  });
}

/* -------------------------------------------------------------------------- operations ----- */

const SURGERY_STATUS: Record<string, string> = {
  REQUESTED: 'preparation',
  SCHEDULED: 'preparation',
  IN_THEATRE: 'in-progress',
  COMPLETED: 'completed',
  POSTPONED: 'on-hold',
  CANCELLED: 'not-done',
};
const LATERALITY: Record<string, { code: string; display: string }> = {
  LEFT: { code: '7771000', display: 'Left' },
  RIGHT: { code: '24028007', display: 'Right' },
  BILATERAL: { code: '51440002', display: 'Right and left' },
};

export function surgeryProcedure(
  c: typeof surgicalCases.$inferSelect,
  patientId: string,
  opts: { includeNote: boolean; includeIndication: boolean },
): R {
  const side = LATERALITY[c.laterality];
  return clean({
    resourceType: 'Procedure',
    id: c.id,
    status: SURGERY_STATUS[c.status] ?? 'unknown',
    category: {
      coding: [{ system: SYSTEMS.snomed, code: '387713003', display: 'Surgical procedure' }],
    },
    code: clean({
      coding: c.procedureCode
        ? [{ system: `${SYSTEMS.local}/procedure`, code: c.procedureCode }]
        : undefined,
      text: c.procedure,
    }),
    subject: ref('Patient', patientId),
    encounter: ref('Encounter', c.admissionId),
    performedPeriod:
      c.inTheatreAt || c.incisionAt
        ? clean({
            start: iso(c.incisionAt ?? c.inTheatreAt),
            end: iso(c.closureAt ?? c.outOfTheatreAt),
          })
        : undefined,
    performer: [
      {
        function: { coding: [{ system: SYSTEMS.snomed, code: '304292004', display: 'Surgeon' }] },
        actor: ref('Practitioner', c.primarySurgeonId),
      },
      ...(c.anaesthetistId
        ? [
            {
              function: {
                coding: [{ system: SYSTEMS.snomed, code: '88189002', display: 'Anesthesiologist' }],
              },
              actor: ref('Practitioner', c.anaesthetistId),
            },
          ]
        : []),
    ],
    location: ref('Location', c.theatreUnitId),
    reasonCode: opts.includeIndication ? [{ text: c.indication }] : undefined,
    bodySite: side
      ? [{ coding: [{ system: SYSTEMS.snomed, ...side }], text: `Laterality: ${side.display}` }]
      : undefined,
    complication: opts.includeNote && c.complications ? [{ text: c.complications }] : undefined,
    note:
      opts.includeNote && c.operationNote && c.noteSignedAt
        ? [{ text: c.operationNote, time: iso(c.noteSignedAt) }]
        : undefined,
  });
}

/* ------------------------------------------------------------------------- dispensing ----- */

export function medicationDispense(
  d: {
    id: string;
    prescriptionId: string;
    medication: string;
    atcCode: string | null;
    units: number | null;
    unit: string | null;
    batchNumber: string | null;
    expiryDate: string | null;
    dispensedAt: string | Date | null;
    dispensedById: string | null;
  },
  patientId: string,
): R {
  const contained = clean({
    resourceType: 'Medication',
    id: 'med',
    code: clean({
      coding: d.atcCode ? [{ system: SYSTEMS.atc, code: d.atcCode }] : undefined,
      text: d.medication,
    }),
    batch:
      d.batchNumber || d.expiryDate
        ? clean({
            lotNumber: d.batchNumber ?? undefined,
            expirationDate: d.expiryDate ?? undefined,
          })
        : undefined,
  });
  return clean({
    resourceType: 'MedicationDispense',
    id: d.id,
    contained: [contained],
    status: 'completed',
    medicationReference: { reference: '#med', display: d.medication },
    subject: ref('Patient', patientId),
    performer: d.dispensedById ? [{ actor: ref('Practitioner', d.dispensedById) }] : undefined,
    authorizingPrescription: [ref('MedicationRequest', d.prescriptionId)],
    quantity:
      d.units !== null && d.units !== undefined
        ? clean({ value: d.units, unit: d.unit ?? undefined })
        : undefined,
    whenHandedOver: iso(d.dispensedAt),
  });
}

/* --------------------------------------------------------------------------- nutrition ----- */

export function nutritionOrder(
  o: typeof dietOrders.$inferSelect,
  patientId: string,
  opts: { includeNotes: boolean },
): R {
  const ended = o.endsAt && new Date(o.endsAt).getTime() <= Date.now();
  return clean({
    resourceType: 'NutritionOrder',
    id: o.id,
    status: ended ? 'completed' : 'active',
    intent: 'order',
    patient: ref('Patient', patientId),
    encounter: ref('Encounter', o.admissionId),
    dateTime: iso(o.startsAt),
    orderer: ref('Practitioner', o.orderedById),
    excludeFoodModifier: o.restrictions?.length
      ? o.restrictions.map((text) => ({ text }))
      : undefined,
    oralDiet: clean({
      type: [
        {
          coding: [{ system: `${SYSTEMS.local}/diet-type`, code: o.dietType }],
          text: o.dietType.toLowerCase().replaceAll('_', ' '),
        },
      ],
      fluidConsistencyType: undefined,
      instruction: o.fluidLimitMl ? `Fluid limit ${o.fluidLimitMl} ml per 24 h` : undefined,
    }),
    note: opts.includeNotes && o.notes ? [{ text: o.notes }] : undefined,
  });
}

/* ------------------------------------------------------------------ blood and transfusion ----- */

export function bloodGroupObservation(
  t: typeof bloodGroupTests.$inferSelect,
  patientId: string,
): R {
  const rh = t.rhD === 'POS' ? 'RhD positive' : 'RhD negative';
  return clean({
    resourceType: 'Observation',
    id: `blood-group-${t.id}`,
    status: 'final',
    category: [
      { coding: [{ system: SYSTEMS.obsCategory, code: 'laboratory', display: 'Laboratory' }] },
    ],
    code: {
      coding: [
        { system: SYSTEMS.loinc, code: '882-1', display: 'ABO and Rh group [Type] in Blood' },
      ],
    },
    subject: ref('Patient', patientId),
    effectiveDateTime: iso(t.testedAt),
    valueCodeableConcept: {
      coding: [
        { system: `${SYSTEMS.local}/abo-rh`, code: `${t.abo}${t.rhD === 'POS' ? '+' : '-'}` },
      ],
      text: `${t.abo} ${rh}`,
    },
    component: [
      {
        code: {
          coding: [
            {
              system: SYSTEMS.loinc,
              code: '890-4',
              display: 'Blood group antibody screen [Presence] in Serum or Plasma',
            },
          ],
        },
        valueString: t.antibodyScreen + (t.antibodies ? ` (${t.antibodies})` : ''),
      },
    ],
  });
}

const TRANSFUSION_STATUS: Record<string, string> = {
  ISSUED: 'preparation',
  AWAITING_CHECK: 'preparation',
  IN_PROGRESS: 'in-progress',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
  RETURNED: 'not-done',
};

export function transfusionProcedure(
  t: {
    id: string;
    status: string;
    startedAt: Date | string | null;
    endedAt: Date | string | null;
    product: string;
    unitNumber: string;
    reaction: boolean;
    reactionType: string | null;
    reactionDetails: string | null;
    checkedById: string | null;
    admissionId: string | null;
  },
  patientId: string,
  opts: { includeDetails: boolean },
): R {
  return clean({
    resourceType: 'Procedure',
    id: `transfusion-${t.id}`,
    status: TRANSFUSION_STATUS[t.status] ?? 'unknown',
    code: {
      coding: [
        { system: SYSTEMS.snomed, code: '116859006', display: 'Transfusion of blood product' },
        { system: SYSTEMS.local, code: 'transfusion', display: 'Transfusion' },
      ],
    },
    subject: ref('Patient', patientId),
    encounter: ref('Encounter', t.admissionId),
    performedPeriod: t.startedAt
      ? clean({ start: iso(t.startedAt), end: iso(t.endedAt) })
      : undefined,
    performer: t.checkedById ? [{ actor: ref('Practitioner', t.checkedById) }] : undefined,
    usedCode: [
      {
        coding: [{ system: `${SYSTEMS.local}/blood-product`, code: t.product }],
        text: opts.includeDetails ? `${t.product} unit ${t.unitNumber}` : t.product,
      },
    ],
    complication:
      opts.includeDetails && t.reaction
        ? [
            {
              text:
                [t.reactionType, t.reactionDetails].filter(Boolean).join(': ') ||
                'Transfusion reaction',
            },
          ]
        : undefined,
  });
}

/* ---------------------------------------------------------------------------- coverage ----- */

const INSURER_NAME: Record<string, string> = {
  FSSH: 'Fondi i Sigurimit Shëndetësor (Health Insurance Fund)',
  PRIVATE: 'Private insurer',
};

export function coverageResource(
  c: typeof insuranceCoverages.$inferSelect,
  patientId: string,
): R | null {
  if (c.insurer === 'NONE') return null;
  return clean({
    resourceType: 'Coverage',
    id: c.id,
    status: c.status === 'ACTIVE' ? 'active' : 'cancelled',
    type:
      c.insurer === 'FSSH'
        ? { coding: [{ system: SYSTEMS.actCode, code: 'PUBLICPOL', display: 'public healthcare' }] }
        : { text: 'Private health insurance' },
    subscriberId: c.policyNumber ?? undefined,
    beneficiary: ref('Patient', patientId),
    period: clean({ start: c.validFrom, end: c.validUntil ?? undefined }),
    payor: [{ display: INSURER_NAME[c.insurer] ?? c.insurer }],
    costToBeneficiary: c.exemption
      ? [
          {
            type: { text: 'Co-payment' },
            valueMoney: { value: 0, currency: 'EUR' },
            exception: [
              {
                type: {
                  coding: [{ system: `${SYSTEMS.local}/copay-exemption`, code: c.exemption }],
                },
              },
            ],
          },
        ]
      : undefined,
  });
}

/* ------------------------------------------------------------------------- video visits ----- */

export function videoEncounter(
  v: {
    id: string;
    scheduledAt: Date | string;
    durationMinutes: number;
    reason: string;
    doctorId: string;
    facilityId: string;
    sessionStatus: string | null;
    startedAt: Date | string | null;
    endedAt: Date | string | null;
  },
  patientId: string,
  opts: { includeReason: boolean },
): R {
  const status =
    v.sessionStatus === 'ENDED'
      ? 'finished'
      : v.sessionStatus === 'ACTIVE'
        ? 'in-progress'
        : 'planned';
  const start = v.startedAt ?? v.scheduledAt;
  return clean({
    resourceType: 'Encounter',
    id: `video-${v.id}`,
    status,
    class: { system: SYSTEMS.actCode, code: 'VR', display: 'virtual' },
    subject: ref('Patient', patientId),
    participant: [{ individual: ref('Practitioner', v.doctorId) }],
    appointment: [ref('Appointment', v.id)],
    period: clean({
      start: iso(start),
      end: iso(
        v.endedAt ??
          (status === 'planned'
            ? new Date(new Date(v.scheduledAt).getTime() + v.durationMinutes * 60_000)
            : null),
      ),
    }),
    reasonCode: opts.includeReason ? [{ text: v.reason }] : undefined,
    serviceProvider: ref('Organization', v.facilityId),
  });
}

/* ------------------------------------------------------------------------------ loading ----- */

/** Loads the data behind the resources above for one patient. */
export async function loadExtra(patientId: string, view: ViewOptions) {
  const [surgery, dispenses, diets, scores, groups, transfused, coverages, series, video] =
    await Promise.all([
      db
        .select()
        .from(surgicalCases)
        .where(
          and(
            eq(surgicalCases.patientId, patientId),
            view.patientView ? eq(surgicalCases.status, 'COMPLETED') : undefined,
          ),
        )
        .orderBy(asc(surgicalCases.createdAt)),
      db
        .select({
          prescriptionId: prescriptions.id,
          prescriptionMedication: prescriptions.medication,
          dispensedAt: prescriptions.dispensedAt,
          dispensedById: prescriptions.dispensedById,
          movementId: stockMovements.id,
          movementQuantity: stockMovements.quantity,
          catalogName: medicationCatalog.name,
          atcCode: medicationCatalog.atcCode,
          unit: medicationCatalog.unit,
          batchNumber: stockBatches.batchNumber,
          expiryDate: stockBatches.expiryDate,
        })
        .from(prescriptions)
        .leftJoin(
          stockMovements,
          and(
            eq(stockMovements.prescriptionId, prescriptions.id),
            eq(stockMovements.type, 'DISPENSE'),
          ),
        )
        .leftJoin(medicationCatalog, eq(medicationCatalog.id, stockMovements.itemId))
        .leftJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
        .where(and(eq(prescriptions.patientId, patientId), isNotNull(prescriptions.dispensedAt)))
        .orderBy(asc(prescriptions.dispensedAt)),
      db
        .select()
        .from(dietOrders)
        .where(eq(dietOrders.patientId, patientId))
        .orderBy(asc(dietOrders.startsAt)),
      db
        .select()
        .from(earlyWarningScores)
        .where(eq(earlyWarningScores.patientId, patientId))
        .orderBy(desc(earlyWarningScores.computedAt))
        .limit(200),
      db
        .select()
        .from(bloodGroupTests)
        .where(eq(bloodGroupTests.patientId, patientId))
        .orderBy(asc(bloodGroupTests.testedAt)),
      db
        .select({
          id: transfusions.id,
          status: transfusions.status,
          startedAt: transfusions.startedAt,
          endedAt: transfusions.endedAt,
          reaction: transfusions.reaction,
          reactionType: transfusions.reactionType,
          reactionDetails: transfusions.reactionDetails,
          checkedById: transfusions.checkedById,
          product: bloodUnits.product,
          unitNumber: bloodUnits.unitNumber,
          admissionId: transfusionRequests.admissionId,
        })
        .from(transfusions)
        .innerJoin(bloodUnits, eq(bloodUnits.id, transfusions.unitId))
        .innerJoin(transfusionRequests, eq(transfusionRequests.id, transfusions.requestId))
        .where(
          and(
            eq(transfusions.patientId, patientId),
            view.patientView ? inArray(transfusions.status, ['COMPLETED', 'STOPPED']) : undefined,
          ),
        )
        .orderBy(asc(transfusions.issuedAt)),
      db
        .select()
        .from(insuranceCoverages)
        .where(eq(insuranceCoverages.patientId, patientId))
        .orderBy(asc(insuranceCoverages.validFrom)),
      db
        .select({
          immunizationId: immunizations.id,
          code: vaccineSchedule.code,
          vaccine: vaccineSchedule.vaccine,
          doseNumber: vaccineSchedule.doseNumber,
        })
        .from(immunizations)
        .innerJoin(vaccineSchedule, eq(vaccineSchedule.id, immunizations.scheduleItemId))
        .where(eq(immunizations.patientId, patientId)),
      db
        .select({
          id: appointments.id,
          scheduledAt: appointments.scheduledAt,
          durationMinutes: appointments.durationMinutes,
          reason: appointments.reason,
          doctorId: appointments.doctorId,
          facilityId: appointments.facilityId,
          status: appointments.status,
          sessionStatus: videoSessions.status,
          startedAt: videoSessions.startedAt,
          endedAt: videoSessions.endedAt,
        })
        .from(appointments)
        .leftJoin(videoSessions, eq(videoSessions.appointmentId, appointments.id))
        .where(
          and(
            eq(appointments.patientId, patientId),
            eq(appointments.mode, 'VIDEO'),
            ne(appointments.status, 'CANCELLED'),
          ),
        )
        .orderBy(asc(appointments.scheduledAt)),
    ]);

  const dispenseRows = dispenses.map((d) => ({
    id: d.movementId ?? `rx-${d.prescriptionId}`,
    prescriptionId: d.prescriptionId,
    medication: d.catalogName ?? d.prescriptionMedication,
    atcCode: d.atcCode,
    units: d.movementQuantity !== null ? Math.abs(d.movementQuantity) : null,
    unit: d.unit,
    batchNumber: d.batchNumber,
    expiryDate: d.expiryDate,
    dispensedAt: d.dispensedAt,
    dispensedById: d.dispensedById,
  }));

  return {
    surgery,
    dispenses: dispenseRows,
    diets,
    scores,
    groups,
    transfused,
    coverages,
    seriesByImmunization: new Map(series.map((s) => [s.immunizationId, s])),
    video,
  };
}
