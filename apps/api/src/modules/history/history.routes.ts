import { Router, type Request } from 'express';
import { z } from 'zod';
import { forbidden } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { PaginationSchema } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { resolveAndAuditRead } from '../access/policy.js';
import { VERSIONED_TABLES, VERSIONED_TABLE_NAMES } from './definitions.js';
import {
  NOT_FOR_PATIENTS,
  recentChanges,
  recordHistory,
  versionsForPatient,
} from './history.service.js';

/**
 * Record history: who changed what in a patient's chart and when.
 *
 * Staff with read access only (care team, cover, unit staff, emergency access) – every read is
 * audited as a record view. Patients and guardians are refused: the history holds drafts,
 * entries made in error and values that were corrected or not yet released, which the portal
 * deliberately does not show. Patients see who opened their record in the access log and ask
 * for corrections through correction requests.
 */
export const historyRouter = Router();
historyRouter.use(authenticate);

const Table = z.enum(VERSIONED_TABLE_NAMES as [string, ...string[]]);
const PatientParam = z.object({ patientId: z.string().uuid() });
const RecordParams = PatientParam.extend({ table: Table, resourceId: z.string().uuid() });
const ChangesQuery = PaginationSchema.extend({ table: Table.optional() });

async function historyAccess(req: Request, patientId: string) {
  const ctx = requireAuth(req);
  if (ctx.role === 'PATIENT') throw forbidden(NOT_FOR_PATIENTS);
  return resolveAndAuditRead(ctx, patientId, requestMeta(req), 'history');
}

/** The versioned record types (labels in English; the web app translates them). */
historyRouter.get('/tables', (_req, res) => {
  res.json({
    items: VERSIONED_TABLE_NAMES.map((name) => ({
      name,
      label: VERSIONED_TABLES[name].label,
      fhirType: VERSIONED_TABLES[name].fhirType,
      fields: Object.entries(VERSIONED_TABLES[name].fields).map(([field, f]) => ({
        field,
        label: f.label,
        kind: f.kind,
      })),
    })),
  });
});

/** All versions of one record, newest first, with who changed what. */
historyRouter.get('/patients/:patientId/records/:table/:resourceId', async (req, res) => {
  const { patientId, table, resourceId } = parse(RecordParams, req.params);
  await historyAccess(req, patientId);
  const t = table as (typeof VERSIONED_TABLE_NAMES)[number];
  const rows = await versionsForPatient(t, resourceId, patientId);
  res.json(await recordHistory(t, rows));
});

/** Recent changes in the patient's chart, newest first. */
historyRouter.get('/patients/:patientId/changes', async (req, res) => {
  const { patientId } = parse(PatientParam, req.params);
  const q = parse(ChangesQuery, req.query);
  await historyAccess(req, patientId);
  res.json(
    await recentChanges(patientId, {
      page: q.page,
      pageSize: q.pageSize,
      table: q.table as (typeof VERSIONED_TABLE_NAMES)[number] | undefined,
    }),
  );
});
