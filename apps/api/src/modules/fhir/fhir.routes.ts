import { Router, type Response } from 'express';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { facilities, patients, users } from '../../db/schema.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import { assertDemographicsAccess, resolveClinicalReadAccess } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import * as clinical from '../clinical/clinical.service.js';
import { listDocuments } from '../documents/documents.service.js';
import * as fhir from './fhir.mapper.js';

/**
 * HL7 FHIR R4 interface (JSON). Same authorization as the rest of the API: the caller must be
 * allowed to read the record (care team, emergency access or the patient themself), and the
 * patient-facing view only contains released results and signed notes. Every export is audited.
 */
const FHIR_JSON = 'application/fhir+json; charset=utf-8';
const PatientParam = z.object({ id: z.string().uuid() });

function send(res: Response, body: unknown, status = 200) {
  res.status(status).type(FHIR_JSON).send(JSON.stringify(body));
}

export const fhirRouter = Router();

/** CapabilityStatement – public, describes what this server supports. */
fhirRouter.get('/metadata', (_req, res) => {
  send(res, {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: '2026-11-02',
    kind: 'instance',
    software: { name: 'Pacient', version: '0.2.0' },
    fhirVersion: '4.0.1',
    format: ['application/fhir+json'],
    rest: [
      {
        mode: 'server',
        security: {
          description:
            'OAuth-style bearer access tokens issued by Pacient. Access is limited to the patient themself and their care team; every read is audited.',
        },
        resource: [
          {
            type: 'Patient',
            interaction: [{ code: 'read' }],
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
            'DocumentReference',
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
  });
});

fhirRouter.get('/Patient/:id', authenticate, async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(PatientParam, req.params);
  const p = await assertDemographicsAccess(ctx, id);
  send(res, fhir.patientResource(p));
});

fhirRouter.get('/Patient/:id/\\$everything', authenticate, async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(PatientParam, req.params);
  const basis = await resolveClinicalReadAccess(ctx, id, requestMeta(req));
  const view = clinical.viewFor(basis);

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
  ] = await Promise.all([
    db.select().from(patients).where(eq(patients.id, id)),
    clinical.listEncounters(id, { page: 1, pageSize: 10_000 }, view),
    clinical.listDiagnoses(id, view),
    clinical.listPrescriptions(id, view),
    clinical.listAdministrations(id, view),
    clinical.listAllergies(id),
    clinical.listVitals(id, 10_000, view),
    clinical.listLabResults(id, view),
    clinical.listImmunizations(id, view),
    listDocuments(id, view),
  ]);

  const facilityIds = new Set<string>([
    patient!.primaryFacilityId,
    ...encounters.items.map((e) => e.facilityId),
  ]);
  const practitionerIds = new Set<string>([
    ...encounters.items.map((e) => e.doctorId),
    ...diagnoses.map((d) => d.doctorId),
    ...prescriptions.map((p) => p.doctorId),
    ...labs.map((l) => l.orderedById),
    ...documents.filter((d) => d.uploadedByRole !== 'PATIENT').map((d) => d.uploadedById),
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

  const apiBase = `${req.protocol}://${req.get('host')}/api/v1`;
  const resources = [
    fhir.patientResource(patient!),
    ...orgs.map(fhir.organizationResource),
    ...practitioners.map(fhir.practitionerResource),
    ...encounters.items.map((e) => fhir.encounterResource(e, id)),
    ...diagnoses.map((d) => fhir.conditionResource(d, id)),
    ...prescriptions.map((p) => fhir.medicationRequestResource(p, id)),
    ...administrations.map((a) => fhir.medicationAdministrationResource(a, id)),
    ...allergies.map((a) => fhir.allergyResource(a, id)),
    ...vitals.flatMap((v) => fhir.vitalObservations(v, id)),
    ...labs.map((l) => fhir.labObservation(l, id)),
    ...vaccines.map((v) => fhir.immunizationResource(v, id)),
    ...documents.map((d) =>
      fhir.documentReferenceResource(d, id, `${apiBase}/patients/${id}/documents/${d.id}/content`),
    ),
  ];

  await audit({
    action: AuditAction.FHIR_EXPORTED,
    actor: ctx,
    resourceType: 'patient',
    resourceId: id,
    patientId: id,
    meta: requestMeta(req),
    metadata: { basis, resources: resources.length },
  });

  const base = `${req.protocol}://${req.get('host')}/api/v1/fhir`;
  send(res, {
    resourceType: 'Bundle',
    type: 'searchset',
    timestamp: new Date().toISOString(),
    total: resources.length,
    link: [{ relation: 'self', url: `${base}/Patient/${id}/$everything` }],
    entry: resources.map((resource) => ({
      fullUrl: `${base}/${resource.resourceType}/${resource.id}`,
      resource,
      search: { mode: resource.resourceType === 'Patient' ? 'match' : 'include' },
    })),
  });
});
