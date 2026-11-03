import { Router, type Response } from 'express';
import { z } from 'zod';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import { assertDemographicsAccess, resolveClinicalReadAccess } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import * as clinical from '../clinical/clinical.service.js';
import * as fhir from './fhir.mapper.js';
import { buildEverythingBundle, capabilityStatement } from './fhir.service.js';

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
  send(
    res,
    capabilityStatement(
      'OAuth-style bearer access tokens issued by Pacient. Access is limited to the patient themself and their care team; every read is audited. Partner systems use /api/v1/partner/fhir with an API key.',
    ),
  );
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
  const apiBase = `${req.protocol}://${req.get('host')}/api/v1`;
  const bundle = await buildEverythingBundle(id, {
    view,
    purpose: 'FULL',
    apiBase,
    fhirBase: `${apiBase}/fhir`,
    selfUrl: `${apiBase}/fhir/Patient/${id}/$everything`,
  });

  await audit({
    action: AuditAction.FHIR_EXPORTED,
    actor: ctx,
    resourceType: 'patient',
    resourceId: id,
    patientId: id,
    meta: requestMeta(req),
    metadata: { basis, resources: bundle.total },
  });

  send(res, bundle);
});
