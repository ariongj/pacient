/**
 * Mapping from Pacient's model to HL7 FHIR R4 resources. The output is a pragmatic subset aimed at
 * patient-record exchange (Patient, Organization, Practitioner, Encounter, Condition,
 * MedicationRequest, MedicationAdministration, AllergyIntolerance, Observation, Immunization,
 * DocumentReference).
 * Before production exchange, validate against the profiles agreed with partners (e.g. IPS).
 */
type R = Record<string, unknown>;

export const SYSTEMS = {
  nationalId: 'urn:pacient:national-id',
  facilityCode: 'urn:pacient:facility-code',
  license: 'urn:pacient:professional-licence',
  icd10: 'http://hl7.org/fhir/sid/icd-10',
  loinc: 'http://loinc.org',
  ucum: 'http://unitsofmeasure.org',
  actCode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  obsCategory: 'http://terminology.hl7.org/CodeSystem/observation-category',
  interpretation: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
  conditionClinical: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
  allergyClinical: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
  allergyVerification: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification',
};

const ref = (type: string, id: string | null | undefined) =>
  id ? { reference: `${type}/${id}` } : undefined;
const clean = <T extends R>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : undefined);

export function patientResource(p: {
  id: string;
  nationalId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  municipality: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  primaryFacilityId: string;
}): R {
  const gender =
    { FEMALE: 'female', MALE: 'male', OTHER: 'other', UNKNOWN: 'unknown' }[p.sex] ?? 'unknown';
  return clean({
    resourceType: 'Patient',
    id: p.id,
    identifier: [{ system: SYSTEMS.nationalId, value: p.nationalId }],
    name: [{ use: 'official', family: p.lastName, given: [p.firstName] }],
    gender,
    birthDate: p.dateOfBirth,
    telecom: [
      p.phone ? { system: 'phone', value: p.phone } : null,
      p.email ? { system: 'email', value: p.email } : null,
    ].filter(Boolean),
    address:
      p.address || p.municipality
        ? [clean({ text: p.address ?? undefined, city: p.municipality ?? undefined })]
        : undefined,
    contact: p.emergencyContactName
      ? [
          clean({
            relationship: [{ text: 'Emergency contact' }],
            name: { text: p.emergencyContactName },
            telecom: p.emergencyContactPhone
              ? [{ system: 'phone', value: p.emergencyContactPhone }]
              : undefined,
          }),
        ]
      : undefined,
    managingOrganization: ref('Organization', p.primaryFacilityId),
  });
}

export function organizationResource(f: {
  id: string;
  code: string;
  name: string;
  municipality: string;
  phone: string | null;
}): R {
  return clean({
    resourceType: 'Organization',
    id: f.id,
    identifier: [{ system: SYSTEMS.facilityCode, value: f.code }],
    name: f.name,
    address: [{ city: f.municipality }],
    telecom: f.phone ? [{ system: 'phone', value: f.phone }] : undefined,
  });
}

export function practitionerResource(u: {
  id: string;
  fullName: string;
  licenseNumber: string | null;
  role: string;
}): R {
  return clean({
    resourceType: 'Practitioner',
    id: u.id,
    identifier: u.licenseNumber ? [{ system: SYSTEMS.license, value: u.licenseNumber }] : undefined,
    name: [{ text: u.fullName }],
    qualification: [{ code: { text: u.role.charAt(0) + u.role.slice(1).toLowerCase() } }],
  });
}

const ENCOUNTER_CLASS: Record<string, [string, string]> = {
  OUTPATIENT: ['AMB', 'ambulatory'],
  INPATIENT: ['IMP', 'inpatient encounter'],
  EMERGENCY: ['EMER', 'emergency'],
  TELEHEALTH: ['VR', 'virtual'],
  HOME_VISIT: ['HH', 'home health'],
};

export function encounterResource(
  e: {
    id: string;
    type: string;
    reason: string;
    startedAt: string | Date;
    endedAt: string | Date | null;
    doctorId: string;
    facilityId: string;
  },
  patientId: string,
): R {
  const [code, display] = ENCOUNTER_CLASS[e.type] ?? ['AMB', 'ambulatory'];
  return clean({
    resourceType: 'Encounter',
    id: e.id,
    status: e.endedAt ? 'finished' : 'in-progress',
    class: { system: SYSTEMS.actCode, code, display },
    subject: ref('Patient', patientId),
    participant: [{ individual: ref('Practitioner', e.doctorId) }],
    period: clean({ start: iso(e.startedAt), end: iso(e.endedAt) }),
    reasonCode: [{ text: e.reason }],
    serviceProvider: ref('Organization', e.facilityId),
  });
}

export function conditionResource(
  d: {
    id: string;
    encounterId: string | null;
    icd10Code: string;
    description: string;
    status: string;
    diagnosedAt: string | Date;
    resolvedAt: string | Date | null;
    doctorId: string;
  },
  patientId: string,
): R {
  const clinical = d.status === 'RESOLVED' ? 'resolved' : 'active';
  return clean({
    resourceType: 'Condition',
    id: d.id,
    clinicalStatus: { coding: [{ system: SYSTEMS.conditionClinical, code: clinical }] },
    code: {
      coding: [{ system: SYSTEMS.icd10, code: d.icd10Code, display: d.description }],
      text: d.description,
    },
    subject: ref('Patient', patientId),
    encounter: ref('Encounter', d.encounterId),
    onsetDateTime: iso(d.diagnosedAt),
    abatementDateTime: iso(d.resolvedAt),
    recorder: ref('Practitioner', d.doctorId),
    note: d.status === 'CHRONIC' ? [{ text: 'Chronic condition' }] : undefined,
  });
}

export function medicationRequestResource(
  m: {
    id: string;
    encounterId: string | null;
    medication: string;
    dosage: string;
    frequency: string;
    route: string;
    instructions: string | null;
    startDate: string;
    endDate: string | null;
    status: string;
    doctorId: string;
    createdAt: string | Date;
  },
  patientId: string,
): R {
  const status =
    { ACTIVE: 'active', COMPLETED: 'completed', CANCELLED: 'cancelled' }[m.status] ?? 'unknown';
  return clean({
    resourceType: 'MedicationRequest',
    id: m.id,
    status,
    intent: 'order',
    medicationCodeableConcept: { text: m.medication },
    subject: ref('Patient', patientId),
    encounter: ref('Encounter', m.encounterId),
    authoredOn: iso(m.createdAt),
    requester: ref('Practitioner', m.doctorId),
    dosageInstruction: [
      clean({
        text: `${m.dosage}, ${m.frequency}${m.instructions ? ` – ${m.instructions}` : ''}`,
        route: { text: m.route },
      }),
    ],
    dispenseRequest: { validityPeriod: clean({ start: m.startDate, end: m.endDate ?? undefined }) },
  });
}

export function medicationAdministrationResource(
  a: {
    id: string;
    prescriptionId: string;
    medication: string;
    status: string;
    doseGiven: string | null;
    reason: string | null;
    administeredAt: string | Date;
  },
  patientId: string,
): R {
  // FHIR status: GIVEN → completed, REFUSED/WITHHELD/OMITTED → not-done with a reason.
  const notDone = a.status !== 'GIVEN';
  return clean({
    resourceType: 'MedicationAdministration',
    id: a.id,
    status: notDone ? 'not-done' : 'completed',
    statusReason: notDone
      ? [{ text: `${a.status.toLowerCase()}${a.reason ? `: ${a.reason}` : ''}` }]
      : undefined,
    medicationCodeableConcept: { text: a.medication },
    subject: ref('Patient', patientId),
    effectiveDateTime: iso(a.administeredAt),
    request: ref('MedicationRequest', a.prescriptionId),
    dosage: a.doseGiven ? { text: a.doseGiven } : undefined,
  });
}

export function allergyResource(
  a: {
    id: string;
    substance: string;
    reaction: string | null;
    severity: string;
    verificationStatus: string;
    source: string;
    recordedAt: string | Date;
  },
  patientId: string,
): R {
  const verification =
    {
      UNCONFIRMED: 'unconfirmed',
      CONFIRMED: 'confirmed',
      REFUTED: 'refuted',
      ENTERED_IN_ERROR: 'entered-in-error',
    }[a.verificationStatus] ?? 'unconfirmed';
  const inactive =
    a.verificationStatus === 'REFUTED' || a.verificationStatus === 'ENTERED_IN_ERROR';
  return clean({
    resourceType: 'AllergyIntolerance',
    id: a.id,
    clinicalStatus: inactive
      ? undefined
      : { coding: [{ system: SYSTEMS.allergyClinical, code: 'active' }] },
    verificationStatus: { coding: [{ system: SYSTEMS.allergyVerification, code: verification }] },
    criticality: a.severity === 'SEVERE' || a.severity === 'LIFE_THREATENING' ? 'high' : 'low',
    code: { text: a.substance },
    patient: ref('Patient', patientId),
    recordedDate: iso(a.recordedAt),
    asserter: a.source === 'PATIENT_REPORTED' ? ref('Patient', patientId) : undefined,
    reaction: a.reaction
      ? [
          {
            manifestation: [{ text: a.reaction }],
            severity:
              a.severity === 'MILD' ? 'mild' : a.severity === 'MODERATE' ? 'moderate' : 'severe',
          },
        ]
      : undefined,
  });
}

const VITALS: { key: string; code: string; display: string; unit: string; ucum: string }[] = [
  { key: 'heartRate', code: '8867-4', display: 'Heart rate', unit: 'beats/minute', ucum: '/min' },
  { key: 'temperatureC', code: '8310-5', display: 'Body temperature', unit: 'C', ucum: 'Cel' },
  {
    key: 'respiratoryRate',
    code: '9279-1',
    display: 'Respiratory rate',
    unit: 'breaths/minute',
    ucum: '/min',
  },
  { key: 'oxygenSaturation', code: '59408-5', display: 'Oxygen saturation', unit: '%', ucum: '%' },
  { key: 'weightKg', code: '29463-7', display: 'Body weight', unit: 'kg', ucum: 'kg' },
  { key: 'heightCm', code: '8302-2', display: 'Body height', unit: 'cm', ucum: 'cm' },
];

const vitalCategory = [
  { coding: [{ system: SYSTEMS.obsCategory, code: 'vital-signs', display: 'Vital Signs' }] },
];

export function vitalObservations(
  v: R & { id: string; recordedAt: string | Date; encounterId?: string | null },
  patientId: string,
): R[] {
  const out: R[] = [];
  const base = {
    resourceType: 'Observation',
    status: 'final',
    category: vitalCategory,
    subject: ref('Patient', patientId),
    encounter: ref('Encounter', v.encounterId ?? null),
    effectiveDateTime: iso(v.recordedAt),
  };
  if (v.systolic != null && v.diastolic != null) {
    out.push(
      clean({
        ...base,
        id: `${v.id}-bp`,
        code: {
          coding: [{ system: SYSTEMS.loinc, code: '85354-9', display: 'Blood pressure panel' }],
        },
        component: [
          {
            code: {
              coding: [
                { system: SYSTEMS.loinc, code: '8480-6', display: 'Systolic blood pressure' },
              ],
            },
            valueQuantity: {
              value: Number(v.systolic),
              unit: 'mmHg',
              system: SYSTEMS.ucum,
              code: 'mm[Hg]',
            },
          },
          {
            code: {
              coding: [
                { system: SYSTEMS.loinc, code: '8462-4', display: 'Diastolic blood pressure' },
              ],
            },
            valueQuantity: {
              value: Number(v.diastolic),
              unit: 'mmHg',
              system: SYSTEMS.ucum,
              code: 'mm[Hg]',
            },
          },
        ],
      }),
    );
  }
  for (const m of VITALS) {
    const value = v[m.key];
    if (value === null || value === undefined) continue;
    out.push(
      clean({
        ...base,
        id: `${v.id}-${m.code}`,
        code: { coding: [{ system: SYSTEMS.loinc, code: m.code, display: m.display }] },
        valueQuantity: { value: Number(value), unit: m.unit, system: SYSTEMS.ucum, code: m.ucum },
      }),
    );
  }
  return out;
}

const INTERPRETATION: Record<string, string> = { NORMAL: 'N', LOW: 'L', HIGH: 'H', CRITICAL: 'AA' };

export function labObservation(
  l: {
    id: string;
    encounterId: string | null;
    testName: string;
    value: string;
    unit: string | null;
    referenceRange: string | null;
    flag: string;
    status: string;
    collectedAt: string | Date;
    orderedById?: string;
  },
  patientId: string,
): R {
  const numeric = /^-?\d+(\.\d+)?$/.test(l.value.trim());
  return clean({
    resourceType: 'Observation',
    id: l.id,
    status:
      { PRELIMINARY: 'preliminary', FINAL: 'final', CORRECTED: 'corrected' }[l.status] ?? 'final',
    category: [
      { coding: [{ system: SYSTEMS.obsCategory, code: 'laboratory', display: 'Laboratory' }] },
    ],
    code: { text: l.testName },
    subject: ref('Patient', patientId),
    encounter: ref('Encounter', l.encounterId),
    effectiveDateTime: iso(l.collectedAt),
    performer: l.orderedById ? [ref('Practitioner', l.orderedById)] : undefined,
    valueQuantity: numeric
      ? clean({ value: Number(l.value), unit: l.unit ?? undefined })
      : undefined,
    valueString: numeric ? undefined : l.value,
    interpretation: [
      { coding: [{ system: SYSTEMS.interpretation, code: INTERPRETATION[l.flag] ?? 'N' }] },
    ],
    referenceRange: l.referenceRange ? [{ text: l.referenceRange }] : undefined,
  });
}

export function immunizationResource(
  i: {
    id: string;
    encounterId: string | null;
    vaccine: string;
    doseNumber: number | null;
    lotNumber: string | null;
    site: string | null;
    administeredAt: string | Date;
  },
  patientId: string,
): R {
  return clean({
    resourceType: 'Immunization',
    id: i.id,
    status: 'completed',
    vaccineCode: { text: i.vaccine },
    patient: ref('Patient', patientId),
    encounter: ref('Encounter', i.encounterId),
    occurrenceDateTime: iso(i.administeredAt),
    lotNumber: i.lotNumber ?? undefined,
    site: i.site ? { text: i.site } : undefined,
    protocolApplied: i.doseNumber ? [{ doseNumberPositiveInt: i.doseNumber }] : undefined,
  });
}

const DOCUMENT_TYPES: Record<string, { code: string; display: string }> = {
  REFERRAL_LETTER: { code: '57133-1', display: 'Referral note' },
  DISCHARGE_SUMMARY: { code: '18842-5', display: 'Discharge summary' },
  IMAGING_REPORT: { code: '18748-4', display: 'Diagnostic imaging study' },
  LAB_REPORT: { code: '11502-2', display: 'Laboratory report' },
  CONSENT_FORM: { code: '59284-0', display: 'Consent document' },
  CLINICAL_PHOTO: { code: '72170-4', display: 'Photographic image' },
  PATIENT_PROVIDED: { code: '51855-5', display: 'Patient note' },
  OTHER: { code: '34133-9', display: 'Summary of episode note' },
};

/** Document metadata with a link to the authenticated content endpoint (content is not inlined). */
export function documentReferenceResource(
  d: {
    id: string;
    encounterId: string | null;
    category: string;
    title: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    status: string;
    createdAt: string | Date;
    uploadedById: string;
    uploadedByRole: string;
  },
  patientId: string,
  contentUrl: string,
): R {
  const type = DOCUMENT_TYPES[d.category] ?? DOCUMENT_TYPES.OTHER!;
  return clean({
    resourceType: 'DocumentReference',
    id: d.id,
    status: d.status === 'ENTERED_IN_ERROR' ? 'entered-in-error' : 'current',
    type: { coding: [{ system: SYSTEMS.loinc, ...type }], text: d.category },
    subject: ref('Patient', patientId),
    date: iso(d.createdAt),
    author: [
      ref(
        d.uploadedByRole === 'PATIENT' ? 'Patient' : 'Practitioner',
        d.uploadedByRole === 'PATIENT' ? patientId : d.uploadedById,
      ),
    ],
    description: d.title,
    context: d.encounterId ? { encounter: [ref('Encounter', d.encounterId)] } : undefined,
    content: [
      {
        attachment: {
          contentType: d.mimeType,
          size: d.sizeBytes,
          title: d.title,
          url: contentUrl,
          extension: [{ url: 'urn:pacient:sha256', valueString: d.sha256 }],
        },
      },
    ],
  });
}
