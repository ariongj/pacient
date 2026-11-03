import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  admissions,
  beds,
  births,
  careUnits,
  edVisits,
  facilities,
  imagingOrders,
  patients,
  users,
} from '../../db/schema.js';
import * as clinical from '../clinical/clinical.service.js';
import type { ViewOptions } from '../clinical/clinical.service.js';
import { listDocuments } from '../documents/documents.service.js';
import * as fhir from './fhir.mapper.js';

type R = Record<string, unknown>;

/**
 * Why a Patient/$everything bundle is built. FULL is the staff/patient export (governed by the
 * caller's own access); the others are partner purposes of use, each with the minimum content:
 *  - TREATMENT – the patient-view record (released results, signed notes, never confidential
 *    visits), like the patient themselves would see it;
 *  - PAYMENT – patient identification, encounters/stays with dates and diagnosis codes, no notes;
 *  - PUBLIC_HEALTH – identification, diagnoses, vaccinations and released laboratory results.
 */
export type BundlePurpose = 'FULL' | 'TREATMENT' | 'PAYMENT' | 'PUBLIC_HEALTH';

export interface BundleOptions {
  view: ViewOptions;
  purpose: BundlePurpose;
  /** e.g. https://host/api/v1 – used for document content links. */
  apiBase: string;
  /** e.g. https://host/api/v1/fhir – fullUrl prefix of the entries. */
  fhirBase: string;
  selfUrl: string;
}

const TEMPORARY_ID_SYSTEM = 'urn:pacient:temporary-id';

/** Patient resource with temporary identities and multiple births represented. */
function patientWithIdentity(
  p: typeof patients.$inferSelect,
  minimal: boolean,
  multipleBirth: number | boolean | undefined,
): R {
  const base = fhir.patientResource(p);
  if (p.temporaryIdentity) {
    base.identifier = [{ use: 'temp', system: TEMPORARY_ID_SYSTEM, value: p.nationalId }];
    base.extension = [
      { url: 'urn:pacient:temporary-identity', valueCode: p.temporaryIdentity.toLowerCase() },
    ];
  }
  if (typeof multipleBirth === 'number') base.multipleBirthInteger = multipleBirth;
  else if (multipleBirth === false) base.multipleBirthBoolean = false;
  if (minimal) {
    delete base.telecom;
    delete base.address;
    delete base.contact;
  }
  return base;
}

/** Minimal Patient for identifier searches (no contact details). */
export async function minimalPatient(patientId: string): Promise<R> {
  const [p] = await db.select().from(patients).where(eq(patients.id, patientId));
  return patientWithIdentity(p!, true, undefined);
}

async function hospitalData(patientId: string, view: ViewOptions) {
  const [stays, edAttendances, imaging, birth] = await Promise.all([
    db
      .select({
        id: admissions.id,
        status: admissions.status,
        admittedAt: admissions.admittedAt,
        dischargedAt: admissions.dischargedAt,
        reason: admissions.reason,
        disposition: admissions.disposition,
        attendingDoctorId: admissions.attendingDoctorId,
        facilityId: admissions.facilityId,
        source: admissions.source,
        unitName: careUnits.name,
        bedLabel: beds.label,
      })
      .from(admissions)
      .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
      .leftJoin(beds, eq(beds.id, admissions.bedId))
      .where(
        and(
          eq(admissions.patientId, patientId),
          view.patientView ? ne(admissions.status, 'CANCELLED') : undefined,
        ),
      )
      .orderBy(asc(admissions.admittedAt)),
    db
      .select({
        id: edVisits.id,
        status: edVisits.status,
        arrivedAt: edVisits.arrivedAt,
        departedAt: edVisits.departedAt,
        chiefComplaint: edVisits.chiefComplaint,
        triageLevel: edVisits.triageLevel,
        assignedDoctorId: edVisits.assignedDoctorId,
        facilityId: edVisits.facilityId,
      })
      .from(edVisits)
      .where(eq(edVisits.patientId, patientId))
      .orderBy(asc(edVisits.arrivedAt)),
    db
      .select()
      .from(imagingOrders)
      .where(eq(imagingOrders.patientId, patientId))
      .orderBy(asc(imagingOrders.createdAt)),
    db
      .select({ birth: births, mother: patients })
      .from(births)
      .innerJoin(patients, eq(patients.id, births.motherPatientId))
      .where(eq(births.newbornPatientId, patientId))
      .limit(1),
  ]);
  // Siblings born of the same mother within a day → multiple birth.
  let multipleBirth: number | boolean | undefined;
  const b = birth[0]?.birth;
  if (b) {
    const siblings = await db
      .select({ id: births.id, bornAt: births.bornAt })
      .from(births)
      .where(eq(births.motherPatientId, b.motherPatientId));
    const twins = siblings.filter(
      (s) => Math.abs(new Date(s.bornAt).getTime() - new Date(b.bornAt).getTime()) < 86_400_000,
    );
    multipleBirth = twins.length > 1 ? b.birthOrder : false;
  }
  const reportVisible = (o: typeof imagingOrders.$inferSelect) =>
    o.status === 'REPORTED' && (!view.patientView || Boolean(o.releasedAt));
  return { stays, edAttendances, imaging, birth: birth[0], multipleBirth, reportVisible };
}

/** Builds a FHIR searchset Bundle for Patient/$everything according to purpose and view. */
export async function buildEverythingBundle(patientId: string, opts: BundleOptions) {
  const { view, purpose } = opts;
  const full = purpose === 'FULL' || purpose === 'TREATMENT';
  const withReasons = full;
  const payment = purpose === 'PAYMENT';
  const publicHealth = purpose === 'PUBLIC_HEALTH';

  const [
    [patient],
    encounters,
    diagnoses,
    prescriptions,
    administrations,
    allergies,
    vitals,
    labs,
    vaccines,
    documents,
    hospital,
  ] = await Promise.all([
    db.select().from(patients).where(eq(patients.id, patientId)),
    clinical.listEncounters(patientId, { page: 1, pageSize: 10_000 }, view),
    clinical.listDiagnoses(patientId, view),
    full ? clinical.listPrescriptions(patientId, view) : Promise.resolve([]),
    full ? clinical.listAdministrations(patientId, view) : Promise.resolve([]),
    full ? clinical.listAllergies(patientId) : Promise.resolve([]),
    full ? clinical.listVitals(patientId, 10_000, view) : Promise.resolve([]),
    full || publicHealth ? clinical.listLabResults(patientId, view) : Promise.resolve([]),
    full || publicHealth ? clinical.listImmunizations(patientId, view) : Promise.resolve([]),
    full ? listDocuments(patientId, view) : Promise.resolve([]),
    hospitalData(patientId, view),
  ]);

  const imaging = full ? hospital.imaging : [];
  const facilityIds = new Set<string>([
    patient!.primaryFacilityId,
    ...encounters.items.map((e) => e.facilityId),
    ...hospital.stays.map((s) => s.facilityId),
    ...hospital.edAttendances.map((e) => e.facilityId),
  ]);
  const practitionerIds = new Set<string>([
    ...encounters.items.map((e) => e.doctorId),
    ...diagnoses.map((d) => d.doctorId),
    ...prescriptions.map((p) => p.doctorId),
    ...labs.map((l) => l.orderedById),
    ...documents.filter((d) => d.uploadedByRole !== 'PATIENT').map((d) => d.uploadedById),
    ...hospital.stays.map((s) => s.attendingDoctorId),
    ...hospital.edAttendances.flatMap((e) => (e.assignedDoctorId ? [e.assignedDoctorId] : [])),
    ...imaging.flatMap((o) => [
      o.orderedById,
      ...(o.reportedById && hospital.reportVisible(o) ? [o.reportedById] : []),
    ]),
  ]);
  const [orgs, practitioners] = await Promise.all([
    db
      .select()
      .from(facilities)
      .where(inArray(facilities.id, [...facilityIds])),
    practitionerIds.size
      ? db
          .select({
            id: users.id,
            fullName: users.fullName,
            licenseNumber: users.licenseNumber,
            role: users.role,
          })
          .from(users)
          .where(inArray(users.id, [...practitionerIds]))
      : Promise.resolve([]),
  ]);

  const encounterOut = (e: (typeof encounters.items)[number]) => {
    const r = fhir.encounterResource(e, patientId);
    if (!withReasons) delete r.reasonCode;
    return r;
  };
  const conditionOut = (d: (typeof diagnoses)[number]) => {
    const r = fhir.conditionResource(d, patientId);
    if (payment) delete r.note;
    return r;
  };

  const resources: R[] = [
    patientWithIdentity(patient!, !full, hospital.multipleBirth),
    ...orgs.map(fhir.organizationResource),
    ...practitioners.map(fhir.practitionerResource),
    ...encounters.items.map(encounterOut),
    ...hospital.stays.map((s) =>
      fhir.admissionEncounter(s, patientId, { includeReason: withReasons }),
    ),
    ...hospital.edAttendances.map((e) =>
      fhir.edEncounter(e, patientId, { includeReason: withReasons }),
    ),
    ...diagnoses.map(conditionOut),
    ...prescriptions.map((p) => fhir.medicationRequestResource(p, patientId)),
    ...administrations.map((a) => fhir.medicationAdministrationResource(a, patientId)),
    ...allergies.map((a) => fhir.allergyResource(a, patientId)),
    ...vitals.flatMap((v) => fhir.vitalObservations(v, patientId)),
    ...labs.map((l) => fhir.labObservation(l, patientId)),
    ...vaccines.map((v) => fhir.immunizationResource(v, patientId)),
    ...imaging.map((o) => fhir.imagingServiceRequest(o, patientId)),
    ...imaging
      .filter(hospital.reportVisible)
      .map((o) => fhir.imagingDiagnosticReport(o, patientId)),
    ...documents.map((d) =>
      fhir.documentReferenceResource(
        d,
        patientId,
        `${opts.apiBase}/patients/${patientId}/documents/${d.id}/content`,
      ),
    ),
  ];
  if (hospital.birth && full) {
    resources.push(
      fhir.motherRelatedPerson(hospital.birth.mother, patientId),
      ...fhir.birthObservations(hospital.birth.birth, patientId),
    );
  }

  return {
    resourceType: 'Bundle',
    type: 'searchset',
    timestamp: new Date().toISOString(),
    total: resources.length,
    link: [{ relation: 'self', url: opts.selfUrl }],
    entry: resources.map((resource) => ({
      fullUrl: `${opts.fhirBase}/${String(resource.resourceType)}/${String(resource.id)}`,
      resource,
      search: { mode: resource.resourceType === 'Patient' ? 'match' : 'include' },
    })),
  };
}

/** CapabilityStatement shared by the staff and partner FHIR endpoints. */
export function capabilityStatement(security: string) {
  return {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: '2026-11-03',
    kind: 'instance',
    software: { name: 'Pacient', version: '0.3.0' },
    fhirVersion: '4.0.1',
    format: ['application/fhir+json'],
    rest: [
      {
        mode: 'server',
        security: { description: security },
        resource: [
          {
            type: 'Patient',
            interaction: [{ code: 'read' }, { code: 'search-type' }],
            searchParam: [
              {
                name: 'identifier',
                type: 'token',
                documentation:
                  'National ID (urn:pacient:national-id) or temporary ID (urn:pacient:temporary-id); partner API only',
              },
            ],
            operation: [
              {
                name: 'everything',
                definition: 'http://hl7.org/fhir/OperationDefinition/Patient-everything',
              },
            ],
          },
          ...[
            'Encounter',
            'Condition',
            'MedicationRequest',
            'MedicationAdministration',
            'AllergyIntolerance',
            'Observation',
            'Immunization',
            'ServiceRequest',
            'DiagnosticReport',
            'DocumentReference',
            'RelatedPerson',
            'Organization',
            'Practitioner',
          ].map((type) => ({
            type,
            interaction: [] as unknown[],
            documentation: 'Available within Patient/$everything',
          })),
        ],
      },
    ],
  };
}
