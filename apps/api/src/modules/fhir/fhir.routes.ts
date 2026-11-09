import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { forbidden, HttpError, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import {
  assertDemographicsAccess,
  resolveAndAuditRead,
  resolveClinicalReadAccess,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import * as clinical from '../clinical/clinical.service.js';
import * as fhir from './fhir.mapper.js';
import { buildEverythingBundle, capabilityStatement } from './fhir.service.js';
import {
  HISTORY_TYPES,
  historyBundle,
  locate,
  resourceAt,
  type HistoryType,
} from '../history/fhir-history.js';
import { currentPatientOf, NOT_FOR_PATIENTS, versionsOf } from '../history/history.service.js';

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
      { history: true },
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

/* ------------------------------------------------------------------ history --------------- */

const HistoryParams = z.object({
  type: z.enum(HISTORY_TYPES),
  id: z.string().min(36).max(60),
});
const VersionParams = HistoryParams.extend({ vid: z.coerce.number().int().min(1) });

/**
 * Versions of one resource. Same access as the chart's record history: treating staff only,
 * audited as a record view of the patient the resource belongs to now.
 */
async function historyOf(req: Request, type: HistoryType, id: string) {
  const ctx = requireAuth(req);
  if (ctx.role === 'PATIENT') throw forbidden(NOT_FOR_PATIENTS);
  const where = locate(type, id);
  if (!where) throw notFound(`${type}/${id} not found`);
  const patientId = await currentPatientOf(where.table, where.rowId);
  if (!patientId) throw notFound(`${type}/${id} not found`);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'history');
  return { ...where, rows: await versionsOf(where.table, where.rowId) };
}

fhirRouter.get('/:type/:id/_history', authenticate, async (req, res) => {
  const { type, id } = parse(HistoryParams, req.params);
  const { table, rows } = await historyOf(req, type, id);
  const bundle = historyBundle(
    type,
    id,
    table,
    rows,
    `${req.protocol}://${req.get('host')}/api/v1/fhir`,
  );
  if (!bundle.total) throw notFound(`${type}/${id} not found`);
  send(res, bundle);
});

fhirRouter.get('/:type/:id/_history/:vid', authenticate, async (req, res) => {
  const { type, id, vid } = parse(VersionParams, req.params);
  const { table, rows } = await historyOf(req, type, id);
  const row = rows.find((r) => r.version === vid);
  if (!row) throw notFound(`${type}/${id} has no version ${vid}`);
  const resource = resourceAt(table, id, row);
  if (!resource) throw new HttpError(410, 'GONE', `${type}/${id} did not exist in version ${vid}`);
  send(res, resource);
});
