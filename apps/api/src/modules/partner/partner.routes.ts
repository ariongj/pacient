import { Router, type Response } from 'express';
import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  births,
  facilities,
  partnerClients,
  PARTNER_SCOPES,
  patients,
  users,
} from '../../db/schema.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { hashToken } from '../../lib/tokens.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { viewFor } from '../clinical/clinical.service.js';
import { sharingWithdrawn } from '../consent/consent.service.js';
import {
  buildEverythingBundle,
  capabilityStatement,
  minimalPatient,
} from '../fhir/fhir.service.js';
import { confirmIdentity } from '../identity/identity.service.js';
import { nationalStats } from '../stats/stats.service.js';
import { billingPartnerRouter } from '../billing/partner.js';
import { surveillancePartnerRouter } from '../surveillance/partner.js';
import { openApiDocument } from '../../openapi/spec.js';
import {
  auditPartner,
  authenticatePartner,
  newPartnerKey,
  partnerLimiter,
  requirePurpose,
  requireScope,
} from './partner.auth.js';

/**
 * Partner API (/api/v1/partner). External systems never get database access: they call this API
 * with a scoped, revocable key; patient data is only released for a stated purpose of use, never
 * when the patient has withdrawn consent to sharing, and every call is audited and visible to the
 * patient in "who viewed my record".
 *
 *   /clients…            Ministry staff manage partner systems (user session)
 *   /openapi.json        public API description (no data)
 *   /fhir/…              fhir.patient.read
 *   /stats/national      stats.read
 *   /directory/…         directory.read
 *   /births…             births.notify (civil registry)
 */
export const partnerRouter = Router();

const FHIR_JSON = 'application/fhir+json; charset=utf-8';
const sendFhir = (res: Response, body: unknown, status = 200) =>
  res.status(status).type(FHIR_JSON).send(JSON.stringify(body));

partnerRouter.get('/openapi.json', (req, res) => {
  res.json(openApiDocument(`${req.protocol}://${req.get('host')}/api/v1`));
});

/* ------------------------------------------------------------------ management (Ministry) ------ */

const clients = Router();
clients.use(authenticate, requireRole('MINISTRY'));

const clientColumns = {
  id: partnerClients.id,
  name: partnerClients.name,
  organisation: partnerClients.organisation,
  scopes: partnerClients.scopes,
  apiKeyPrefix: partnerClients.apiKeyPrefix,
  isActive: partnerClients.isActive,
  allowedIps: partnerClients.allowedIps,
  createdAt: partnerClients.createdAt,
  lastSeenAt: partnerClients.lastSeenAt,
  revokedAt: partnerClients.revokedAt,
};

clients.get('/', async (_req, res) => {
  const rows = await db
    .select(clientColumns)
    .from(partnerClients)
    .orderBy(desc(partnerClients.isActive), desc(partnerClients.createdAt));
  res.json({ items: rows });
});

const ip = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F:.]{3,45}$/, 'Enter IP addresses such as 192.0.2.10');
const CreateClient = z.object({
  name: z.string().trim().min(3).max(120),
  organisation: z.string().trim().min(3).max(200),
  scopes: z.array(z.enum(PARTNER_SCOPES)).min(1).max(PARTNER_SCOPES.length),
  allowedIps: z.array(ip).max(20).optional(),
});

clients.post('/', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(CreateClient, req.body);
  const apiKey = newPartnerKey();
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(partnerClients)
      .values({
        name: input.name,
        organisation: input.organisation,
        scopes: [...new Set(input.scopes)],
        allowedIps: input.allowedIps?.length ? input.allowedIps : null,
        apiKeyHash: hashToken(apiKey),
        apiKeyPrefix: apiKey.slice(0, 10),
        createdById: ctx.userId,
      })
      .returning(clientColumns);
    await audit(
      {
        action: AuditAction.PARTNER_CLIENT_CREATED,
        actor: ctx,
        resourceType: 'partner_client',
        resourceId: created!.id,
        meta: requestMeta(req),
        metadata: { name: input.name, scopes: input.scopes },
      },
      tx,
    );
    return created!;
  });
  // The key is shown exactly once; only its hash is stored.
  res.status(201).json({ ...row, apiKey });
});

const IdParam = z.object({ id: z.string().uuid() });

clients.post('/:id/revoke', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const rows = await db
    .update(partnerClients)
    .set({ isActive: false, revokedAt: new Date() })
    .where(and(eq(partnerClients.id, id), isNull(partnerClients.revokedAt)))
    .returning({ id: partnerClients.id });
  if (!rows.length) {
    const [exists] = await db
      .select({ id: partnerClients.id })
      .from(partnerClients)
      .where(eq(partnerClients.id, id));
    if (!exists) throw notFound('Partner system not found');
  }
  await audit({
    action: AuditAction.PARTNER_CLIENT_REVOKED,
    actor: ctx,
    resourceType: 'partner_client',
    resourceId: id,
    meta: requestMeta(req),
  });
  res.status(204).end();
});

/** Calls per day and scope over the last 30 days, with refused calls counted separately. */
clients.get('/:id/usage', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const [client] = await db
    .select(clientColumns)
    .from(partnerClients)
    .where(eq(partnerClients.id, id));
  if (!client) throw notFound('Partner system not found');
  const result = await db.execute<{
    day: string;
    scope: string | null;
    outcome: string;
    calls: number;
  }>(sql`
    SELECT to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') AS day,
           metadata->>'scope' AS scope, outcome, count(*)::int AS calls
    FROM audit_logs
    WHERE action = ${AuditAction.PARTNER_API_ACCESS}
      AND metadata->>'clientId' = ${id}
      AND occurred_at > now() - interval '30 days'
    GROUP BY 1, 2, 3
    ORDER BY 1`);
  const rows = result.rows;
  const total = rows.reduce((a, r) => a + r.calls, 0);
  const denied = rows.filter((r) => r.outcome !== 'SUCCESS').reduce((a, r) => a + r.calls, 0);
  const patients = await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT patient_id)::int AS n FROM audit_logs
    WHERE action = ${AuditAction.PARTNER_API_ACCESS} AND metadata->>'clientId' = ${id}
      AND patient_id IS NOT NULL AND outcome = 'SUCCESS' AND occurred_at > now() - interval '30 days'`);
  res.json({
    client,
    total,
    denied,
    distinctPatients: patients.rows[0]?.n ?? 0,
    days: rows,
  });
});

partnerRouter.use('/clients', clients);

/* ------------------------------------------------------------------ partner API ------------------ */

const partnerApi = Router();
partnerApi.use(partnerLimiter, authenticatePartner);

partnerApi.get('/ping', (req, res) => {
  res.json({ ok: true, client: req.partner!.name, scopes: req.partner!.scopes });
});

/* FHIR (fhir.patient.read) */

partnerApi.get('/fhir/metadata', (_req, res) => {
  sendFhir(
    res,
    capabilityStatement(
      'Partner API key (Authorization: Bearer pk_…) with the fhir.patient.read scope. X-Purpose-Of-Use is required (TREATMENT, PAYMENT, PUBLIC_HEALTH); patients who withdrew consent to sharing are never returned; every call is audited.',
    ),
  );
});

const IdentifierQuery = z.object({ identifier: z.string().trim().min(3).max(120) });

partnerApi.get('/fhir/Patient', requireScope('fhir.patient.read'), async (req, res) => {
  const client = req.partner!;
  const { purpose, practitioner } = await requirePurpose(req, 'fhir.patient.read');
  const { identifier } = parse(IdentifierQuery, req.query);
  const value = identifier.includes('|') ? identifier.split('|').pop()!.trim() : identifier;
  const [found] = await db
    .select({ id: patients.id, mergedIntoId: patients.mergedIntoId })
    .from(patients)
    .where(eq(patients.nationalId, value));
  // A merged duplicate's number resolves to the surviving record.
  const patientId = found ? (found.mergedIntoId ?? found.id) : null;
  if (patientId && (await sharingWithdrawn(patientId))) {
    await auditPartner(req, client, {
      scope: 'fhir.patient.read',
      purpose,
      practitioner,
      patientId,
      outcome: 'DENIED',
      result: 'consent_withdrawn',
    });
    throw new HttpError(
      403,
      'CONSENT_WITHDRAWN',
      'The patient has withdrawn consent to sharing their record with other organisations',
    );
  }
  const entries = patientId ? [await minimalPatient(patientId)] : [];
  await auditPartner(req, client, {
    scope: 'fhir.patient.read',
    purpose,
    practitioner,
    patientId,
    result: patientId ? 'found' : 'not_found',
  });
  const base = `${req.protocol}://${req.get('host')}/api/v1/partner/fhir`;
  sendFhir(res, {
    resourceType: 'Bundle',
    type: 'searchset',
    timestamp: new Date().toISOString(),
    total: entries.length,
    entry: entries.map((resource) => ({
      fullUrl: `${base}/Patient/${String(resource.id)}`,
      resource,
      search: { mode: 'match' },
    })),
  });
});

const PatientParam = z.object({ id: z.string().uuid() });

partnerApi.get(
  '/fhir/Patient/:id/\\$everything',
  requireScope('fhir.patient.read'),
  async (req, res) => {
    const client = req.partner!;
    const { purpose, practitioner } = await requirePurpose(req, 'fhir.patient.read');
    const { id } = parse(PatientParam, req.params);
    const [patient] = await db
      .select({ id: patients.id, mergedIntoId: patients.mergedIntoId })
      .from(patients)
      .where(eq(patients.id, id));
    if (!patient) {
      await auditPartner(req, client, {
        scope: 'fhir.patient.read',
        purpose,
        practitioner,
        outcome: 'FAILURE',
        result: 'not_found',
      });
      throw notFound('Patient not found');
    }
    if (patient.mergedIntoId) {
      throw new HttpError(409, 'PATIENT_MERGED', 'This record was merged into another record', {
        mergedIntoId: patient.mergedIntoId,
      });
    }
    if (await sharingWithdrawn(id)) {
      await auditPartner(req, client, {
        scope: 'fhir.patient.read',
        purpose,
        practitioner,
        patientId: id,
        outcome: 'DENIED',
        result: 'consent_withdrawn',
      });
      throw new HttpError(
        403,
        'CONSENT_WITHDRAWN',
        'The patient has withdrawn consent to sharing their record with other organisations',
      );
    }
    const apiBase = `${req.protocol}://${req.get('host')}/api/v1`;
    // What the patient themself may see, minus anything confidential (guardian-level view).
    const bundle = await buildEverythingBundle(id, {
      view: viewFor('GUARDIAN'),
      purpose,
      apiBase,
      fhirBase: `${apiBase}/partner/fhir`,
      selfUrl: `${apiBase}/partner/fhir/Patient/${id}/$everything`,
    });
    await auditPartner(req, client, {
      scope: 'fhir.patient.read',
      purpose,
      practitioner,
      patientId: id,
      result: 'exported',
      extra: { resources: bundle.total },
    });
    sendFhir(res, bundle);
  },
);

/* Aggregate statistics (stats.read) */

partnerApi.get('/stats/national', requireScope('stats.read'), async (req, res) => {
  const stats = await nationalStats();
  await auditPartner(req, req.partner!, { scope: 'stats.read', result: 'ok' });
  res.json(stats);
});

/* Public directory (directory.read) – no staff contact details */

partnerApi.get('/directory/facilities', requireScope('directory.read'), async (req, res) => {
  const rows = await db
    .select({
      id: facilities.id,
      code: facilities.code,
      name: facilities.name,
      type: facilities.type,
      region: facilities.region,
      municipality: facilities.municipality,
      address: facilities.address,
      phone: facilities.phone,
    })
    .from(facilities)
    .where(eq(facilities.isActive, true))
    .orderBy(asc(facilities.name));
  await auditPartner(req, req.partner!, { scope: 'directory.read', result: 'ok' });
  res.json({ items: rows });
});

const PractitionerQuery = z.object({
  facility: z.string().trim().max(32).optional(),
  role: z.enum(['DOCTOR', 'NURSE', 'PHARMACIST']).optional(),
});

partnerApi.get('/directory/practitioners', requireScope('directory.read'), async (req, res) => {
  const q = parse(PractitionerQuery, req.query);
  const rows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      role: users.role,
      specialty: users.specialty,
      licenseNumber: users.licenseNumber,
      facilityCode: facilities.code,
      facilityName: facilities.name,
    })
    .from(users)
    .innerJoin(facilities, eq(facilities.id, users.facilityId))
    .where(
      and(
        eq(users.isActive, true),
        q.role ? eq(users.role, q.role) : inArray(users.role, ['DOCTOR', 'NURSE', 'PHARMACIST']),
        q.facility ? eq(facilities.code, q.facility) : undefined,
      ),
    )
    .orderBy(asc(facilities.name), asc(users.fullName))
    .limit(5000);
  await auditPartner(req, req.partner!, { scope: 'directory.read', result: 'ok' });
  res.json({ items: rows });
});

/* Civil registry (births.notify) */

const mothers = alias(patients, 'mothers');
const SinceQuery = z.object({ since: z.string().datetime({ offset: true }).optional() });

/** Births whose newborn still has a temporary identity – what the civil registry must register. */
partnerApi.get('/births', requireScope('births.notify'), async (req, res) => {
  const { since } = parse(SinceQuery, req.query);
  const from = since ? new Date(since) : new Date(Date.now() - 90 * 86_400_000);
  const rows = await db
    .select({
      birthId: births.id,
      bornAt: births.bornAt,
      birthOrder: births.birthOrder,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      newbornTemporaryId: patients.nationalId,
      newbornFirstName: patients.firstName,
      newbornLastName: patients.lastName,
      sex: patients.sex,
      motherNationalId: mothers.nationalId,
      motherFirstName: mothers.firstName,
      motherLastName: mothers.lastName,
    })
    .from(births)
    .innerJoin(patients, eq(patients.id, births.newbornPatientId))
    .innerJoin(facilities, eq(facilities.id, births.facilityId))
    .innerJoin(mothers, eq(mothers.id, births.motherPatientId))
    .where(
      and(
        eq(patients.temporaryIdentity, 'NEWBORN'),
        isNull(patients.mergedIntoId),
        gte(births.bornAt, from),
      ),
    )
    .orderBy(asc(births.bornAt))
    .limit(1000);
  await auditPartner(req, req.partner!, {
    scope: 'births.notify',
    result: 'ok',
    extra: { births: rows.length },
  });
  res.json({ items: rows });
});

const BirthParam = z.object({ birthId: z.string().uuid() });
const Registration = z.object({
  nationalId: z
    .string()
    .trim()
    .regex(/^[0-9]{10}$/, 'National ID must be exactly 10 digits'),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100).optional(),
});

/** The civil registry reports the national ID (and given name) issued for a newborn. */
partnerApi.post(
  '/births/:birthId/registration',
  requireScope('births.notify'),
  async (req, res) => {
    const client = req.partner!;
    const { birthId } = parse(BirthParam, req.params);
    const input = parse(Registration, req.body);
    const [row] = await db
      .select({ newborn: patients })
      .from(births)
      .innerJoin(patients, eq(patients.id, births.newbornPatientId))
      .where(eq(births.id, birthId));
    if (!row) {
      await auditPartner(req, client, {
        scope: 'births.notify',
        outcome: 'FAILURE',
        result: 'not_found',
      });
      throw notFound('Birth not found');
    }
    try {
      await confirmIdentity(
        {
          patientId: row.newborn.id,
          nationalId: input.nationalId,
          firstName: input.firstName,
          lastName: input.lastName ?? row.newborn.lastName,
          dateOfBirth: row.newborn.dateOfBirth,
          sex: row.newborn.sex,
        },
        { ctx: null, via: 'CIVIL_REGISTRY', meta: requestMeta(req), clientName: client.name },
      );
    } catch (err) {
      await auditPartner(req, client, {
        scope: 'births.notify',
        patientId: row.newborn.id,
        outcome: 'FAILURE',
        result: err instanceof HttpError ? err.code.toLowerCase() : 'error',
      });
      throw err;
    }
    await auditPartner(req, client, {
      scope: 'births.notify',
      patientId: row.newborn.id,
      result: 'registered',
    });
    res.json({ birthId, patientId: row.newborn.id, nationalId: input.nationalId });
  },
);

partnerApi.use('/claims', billingPartnerRouter);
partnerApi.use('/surveillance', surveillancePartnerRouter);

partnerRouter.use(partnerApi);
