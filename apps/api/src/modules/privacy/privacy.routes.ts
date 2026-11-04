import { Router } from 'express';
import { and, asc, count, desc, eq, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  dataSubjectRequests,
  facilities,
  legalHolds,
  patients,
  retentionPolicies,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { assertFullProxyScope, getPatientOrThrow } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyFacilityRole, notifyPatient } from '../notifications/notifications.service.js';
import { categoryByName, ensureRetentionPolicies, runRetentionOnce } from './retention.js';

/**
 * Data protection (Law No. 06/L-082 on Protection of Personal Data): retention of operational
 * data, the register of data-subject requests (30-day legal deadline) and legal holds.
 * Who: the Ministry nationally (it edits retention and runs the job); facility directors for
 * patients registered at their facility; patients and guardians for their own requests.
 */
export const privacyRouter = Router();
privacyRouter.use(authenticate);

const DEADLINE_DAYS = 30;
const KINDS = [
  'ACCESS',
  'RECTIFICATION',
  'RESTRICTION',
  'ERASURE',
  'OBJECTION',
  'PORTABILITY',
] as const;
const STATUSES = ['RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'REJECTED'] as const;

const isAdmin = (ctx: AuthContext) => ctx.role === 'MINISTRY' || ctx.role === 'DIRECTOR';
function assertAdmin(ctx: AuthContext) {
  if (!isAdmin(ctx))
    throw forbidden('Only the Ministry and facility directors handle data protection');
}
function assertMinistry(ctx: AuthContext) {
  if (ctx.role !== 'MINISTRY') throw forbidden('Only the Ministry may change retention policies');
}

/** Directors may act for patients registered at their facility; the Ministry for everyone. */
async function assertPatientInScope(ctx: AuthContext, patientId: string) {
  const patient = await getPatientOrThrow(patientId);
  if (ctx.role === 'MINISTRY') return patient;
  if (ctx.role === 'DIRECTOR' && patient.primaryFacilityId === ctx.facilityId) return patient;
  throw forbidden();
}

const scopeFilter = (ctx: AuthContext): SQL | undefined =>
  ctx.role === 'DIRECTOR' ? eq(patients.primaryFacilityId, ctx.facilityId!) : undefined;

/* ------------------------------------------------------------------ retention */

privacyRouter.get('/retention', async (req, res) => {
  const ctx = requireAuth(req);
  assertAdmin(ctx);
  await ensureRetentionPolicies();
  const rows = await db.select().from(retentionPolicies).orderBy(asc(retentionPolicies.category));
  res.json({
    items: rows.map((r) => ({
      ...r,
      description: categoryByName(r.category)?.description ?? r.category,
      defaultDays: categoryByName(r.category)?.defaultDays ?? null,
    })),
    canEdit: ctx.role === 'MINISTRY',
  });
});

privacyRouter.patch('/retention/:category', async (req, res) => {
  const ctx = requireAuth(req);
  assertMinistry(ctx);
  const { category } = parse(z.object({ category: z.string().max(40) }), req.params);
  if (!categoryByName(category)) throw notFound('Unknown retention category');
  const input = parse(
    z
      .object({
        retainDays: z.number().int().min(1).max(36500).optional(),
        legalBasis: z.string().trim().min(10).max(300).optional(),
        isActive: z.boolean().optional(),
      })
      .refine((v) => Object.keys(v).length > 0, 'Nothing to change'),
    req.body,
  );
  await ensureRetentionPolicies();
  const [row] = await db
    .update(retentionPolicies)
    .set({ ...input, updatedById: ctx.userId, updatedAt: new Date() })
    .where(eq(retentionPolicies.category, category))
    .returning();
  await audit({
    action: AuditAction.RETENTION_POLICY_CHANGED,
    actor: ctx,
    resourceType: 'retention_policy',
    resourceId: row!.id,
    meta: requestMeta(req),
    metadata: { category, ...input },
  });
  res.json(row);
});

/** What the next run would remove (counts only). */
privacyRouter.post('/retention/preview', async (req, res) => {
  const ctx = requireAuth(req);
  assertAdmin(ctx);
  res.json(await runRetentionOnce(new Date(), { dryRun: true }));
});

privacyRouter.post('/retention/run', async (req, res) => {
  const ctx = requireAuth(req);
  assertMinistry(ctx);
  res.json(await runRetentionOnce(new Date(), { actor: ctx }));
});

/* ------------------------------------------------------------------ data-subject requests */

const requestColumns = {
  id: dataSubjectRequests.id,
  patientId: dataSubjectRequests.patientId,
  kind: dataSubjectRequests.kind,
  status: dataSubjectRequests.status,
  details: dataSubjectRequests.details,
  receivedVia: dataSubjectRequests.receivedVia,
  receivedAt: dataSubjectRequests.receivedAt,
  dueAt: dataSubjectRequests.dueAt,
  completedAt: dataSubjectRequests.completedAt,
  outcome: dataSubjectRequests.outcome,
};

function withOverdue<T extends { status: string; dueAt: Date }>(r: T, now = new Date()) {
  return {
    ...r,
    overdue: (r.status === 'RECEIVED' || r.status === 'IN_PROGRESS') && r.dueAt < now,
  };
}

async function createRequest(
  ctx: AuthContext,
  input: { patientId: string; kind: (typeof KINDS)[number]; details?: string; receivedVia: string },
  meta: ReturnType<typeof requestMeta>,
) {
  const patient = await getPatientOrThrow(input.patientId);
  const receivedAt = new Date();
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(dataSubjectRequests)
      .values({
        patientId: patient.id,
        facilityId: patient.primaryFacilityId,
        kind: input.kind,
        details: input.details ?? null,
        receivedVia: input.receivedVia,
        receivedAt,
        dueAt: new Date(receivedAt.getTime() + DEADLINE_DAYS * 86_400_000),
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.DATA_SUBJECT_REQUEST,
        actor: ctx,
        resourceType: 'data_subject_request',
        resourceId: created!.id,
        patientId: patient.id,
        meta,
        metadata: { kind: input.kind, event: 'received', via: input.receivedVia },
      },
      tx,
    );
    return created!;
  });
  // The facility's directors handle requests; no request detail in the notification.
  await notifyFacilityRole(patient.primaryFacilityId, ['DIRECTOR'], {
    type: 'privacy',
    title: 'A new data protection request was received',
    link: '/privacy',
  });
  return row;
}

const PortalRequestSchema = z.object({
  kind: z.enum(KINDS),
  details: z.string().trim().max(2000).optional(),
});

/** Patients (and full-scope guardians) list and create their own requests. */
privacyRouter.get('/my-requests', async (req, res) => {
  const ctx = requireAuth(req);
  if (ctx.role !== 'PATIENT' || !ctx.patientId) throw forbidden();
  assertFullProxyScope(ctx);
  const rows = await db
    .select(requestColumns)
    .from(dataSubjectRequests)
    .where(eq(dataSubjectRequests.patientId, ctx.patientId))
    .orderBy(desc(dataSubjectRequests.receivedAt));
  res.json({ items: rows.map((r) => withOverdue(r)) });
});

privacyRouter.post('/my-requests', async (req, res) => {
  const ctx = requireAuth(req);
  if (ctx.role !== 'PATIENT' || !ctx.patientId) throw forbidden();
  assertFullProxyScope(ctx);
  const input = parse(PortalRequestSchema, req.body);
  if (input.kind !== 'ACCESS' && input.kind !== 'PORTABILITY' && !input.details) {
    throw badRequest('Please describe your request');
  }
  const open = await db
    .select({ n: count() })
    .from(dataSubjectRequests)
    .where(
      and(
        eq(dataSubjectRequests.patientId, ctx.patientId),
        sql`${dataSubjectRequests.status} IN ('RECEIVED', 'IN_PROGRESS')`,
      ),
    );
  if ((open[0]?.n ?? 0) >= 5) throw conflict('You already have five open requests');
  const row = await createRequest(
    ctx,
    { patientId: ctx.patientId, kind: input.kind, details: input.details, receivedVia: 'PORTAL' },
    requestMeta(req),
  );
  res.status(201).json(withOverdue(row));
});

const ListQuery = PaginationSchema.extend({
  status: z.enum(STATUSES).optional(),
  kind: z.enum(KINDS).optional(),
  overdue: z.enum(['true', 'false']).optional(),
});

privacyRouter.get('/requests', async (req, res) => {
  const ctx = requireAuth(req);
  assertAdmin(ctx);
  const q = parse(ListQuery, req.query);
  const now = new Date();
  const filters: (SQL | undefined)[] = [scopeFilter(ctx)];
  if (q.status) filters.push(eq(dataSubjectRequests.status, q.status));
  if (q.kind) filters.push(eq(dataSubjectRequests.kind, q.kind));
  if (q.overdue === 'true') {
    filters.push(lt(dataSubjectRequests.dueAt, now));
    filters.push(sql`${dataSubjectRequests.status} IN ('RECEIVED', 'IN_PROGRESS')`);
  }
  const where = and(...filters);
  const [rows, [total], [overdue]] = await Promise.all([
    db
      .select({
        ...requestColumns,
        patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
        nationalId: patients.nationalId,
        facilityName: facilities.name,
        handledBy: users.fullName,
      })
      .from(dataSubjectRequests)
      .innerJoin(patients, eq(patients.id, dataSubjectRequests.patientId))
      .leftJoin(facilities, eq(facilities.id, dataSubjectRequests.facilityId))
      .leftJoin(users, eq(users.id, dataSubjectRequests.handledById))
      .where(where)
      .orderBy(asc(dataSubjectRequests.dueAt))
      .limit(toOffset(q).limit)
      .offset(toOffset(q).offset),
    db
      .select({ n: count() })
      .from(dataSubjectRequests)
      .innerJoin(patients, eq(patients.id, dataSubjectRequests.patientId))
      .where(where),
    db
      .select({ n: count() })
      .from(dataSubjectRequests)
      .innerJoin(patients, eq(patients.id, dataSubjectRequests.patientId))
      .where(
        and(
          scopeFilter(ctx),
          lt(dataSubjectRequests.dueAt, now),
          sql`${dataSubjectRequests.status} IN ('RECEIVED', 'IN_PROGRESS')`,
        ),
      ),
  ]);
  res.json({
    ...paginated(
      rows.map((r) => withOverdue(r, now)),
      total?.n ?? 0,
      q,
    ),
    overdueCount: overdue?.n ?? 0,
  });
});

privacyRouter.post('/requests', async (req, res) => {
  const ctx = requireAuth(req);
  assertAdmin(ctx);
  const input = parse(
    z.object({
      patientId: z.string().uuid().optional(),
      nationalId: z.string().trim().min(5).max(20).optional(),
      kind: z.enum(KINDS),
      details: z.string().trim().max(2000).optional(),
      receivedVia: z.enum(['IN_PERSON', 'POST', 'EMAIL']),
    }),
    req.body,
  );
  let patientId = input.patientId;
  if (!patientId && input.nationalId) {
    const [p] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.nationalId, input.nationalId), isNull(patients.mergedIntoId)));
    patientId = p?.id;
  }
  if (!patientId) throw notFound('Patient not found');
  await assertPatientInScope(ctx, patientId);
  const row = await createRequest(
    ctx,
    { patientId, kind: input.kind, details: input.details, receivedVia: input.receivedVia },
    requestMeta(req),
  );
  res.status(201).json(withOverdue(row));
});

privacyRouter.patch('/requests/:id', async (req, res) => {
  const ctx = requireAuth(req);
  assertAdmin(ctx);
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const input = parse(
    z.object({
      status: z.enum(['IN_PROGRESS', 'COMPLETED', 'REJECTED']),
      outcome: z.string().trim().max(2000).optional(),
    }),
    req.body,
  );
  if ((input.status === 'COMPLETED' || input.status === 'REJECTED') && !input.outcome) {
    throw badRequest('Record the outcome before closing the request');
  }
  const [existing] = await db
    .select()
    .from(dataSubjectRequests)
    .where(eq(dataSubjectRequests.id, id));
  if (!existing) throw notFound('Request not found');
  await assertPatientInScope(ctx, existing.patientId);
  if (existing.status === 'COMPLETED' || existing.status === 'REJECTED') {
    throw conflict('This request is already closed');
  }
  const closing = input.status !== 'IN_PROGRESS';
  const [row] = await db
    .update(dataSubjectRequests)
    .set({
      status: input.status,
      outcome: input.outcome ?? existing.outcome,
      handledById: ctx.userId,
      completedAt: closing ? new Date() : null,
    })
    .where(eq(dataSubjectRequests.id, id))
    .returning();
  await audit({
    action: AuditAction.DATA_SUBJECT_REQUEST,
    actor: ctx,
    resourceType: 'data_subject_request',
    resourceId: id,
    patientId: existing.patientId,
    meta: requestMeta(req),
    metadata: { kind: existing.kind, event: input.status },
  });
  if (closing) {
    await notifyPatient(existing.patientId, {
      type: 'privacy',
      title: 'Your data protection request has been answered',
      link: '/portal/consents',
      important: true,
    });
  }
  res.json(withOverdue(row!));
});

/* ------------------------------------------------------------------ legal holds */

privacyRouter.get('/holds', async (req, res) => {
  const ctx = requireAuth(req);
  assertAdmin(ctx);
  const q = parse(z.object({ active: z.enum(['true', 'false']).default('true') }), req.query);
  const rows = await db
    .select({
      id: legalHolds.id,
      patientId: legalHolds.patientId,
      reason: legalHolds.reason,
      createdAt: legalHolds.createdAt,
      releasedAt: legalHolds.releasedAt,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      nationalId: patients.nationalId,
      createdBy: users.fullName,
    })
    .from(legalHolds)
    .innerJoin(patients, eq(patients.id, legalHolds.patientId))
    .leftJoin(users, eq(users.id, legalHolds.createdById))
    .where(and(scopeFilter(ctx), q.active === 'true' ? isNull(legalHolds.releasedAt) : undefined))
    .orderBy(desc(legalHolds.createdAt))
    .limit(200);
  res.json({ items: rows });
});

/** Active holds of one patient (shown on merge and retention views). */
privacyRouter.get('/patients/:patientId/holds', async (req, res) => {
  const ctx = requireAuth(req);
  assertAdmin(ctx);
  const { patientId } = parse(z.object({ patientId: z.string().uuid() }), req.params);
  await assertPatientInScope(ctx, patientId);
  const rows = await db
    .select()
    .from(legalHolds)
    .where(and(eq(legalHolds.patientId, patientId), isNull(legalHolds.releasedAt)));
  res.json({ items: rows, onHold: rows.length > 0 });
});

privacyRouter.post('/holds', async (req, res) => {
  const ctx = requireAuth(req);
  assertAdmin(ctx);
  const input = parse(
    z.object({
      patientId: z.string().uuid().optional(),
      nationalId: z.string().trim().min(5).max(20).optional(),
      reason: z.string().trim().min(10).max(500),
    }),
    req.body,
  );
  let patientId = input.patientId;
  if (!patientId && input.nationalId) {
    const [p] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.nationalId, input.nationalId), isNull(patients.mergedIntoId)));
    patientId = p?.id;
  }
  if (!patientId) throw notFound('Patient not found');
  await assertPatientInScope(ctx, patientId);
  const [existing] = await db
    .select({ id: legalHolds.id })
    .from(legalHolds)
    .where(and(eq(legalHolds.patientId, patientId), isNull(legalHolds.releasedAt)));
  if (existing) throw conflict('This patient is already under a legal hold');
  const [row] = await db
    .insert(legalHolds)
    .values({ patientId, reason: input.reason, createdById: ctx.userId })
    .returning();
  await audit({
    action: AuditAction.LEGAL_HOLD_CHANGED,
    actor: ctx,
    resourceType: 'legal_hold',
    resourceId: row!.id,
    patientId,
    meta: requestMeta(req),
    metadata: { event: 'placed' },
  });
  res.status(201).json(row);
});

privacyRouter.post('/holds/:id/release', async (req, res) => {
  const ctx = requireAuth(req);
  assertAdmin(ctx);
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
  const [hold] = await db.select().from(legalHolds).where(eq(legalHolds.id, id));
  if (!hold) throw notFound('Legal hold not found');
  await assertPatientInScope(ctx, hold.patientId);
  if (hold.releasedAt) throw conflict('This legal hold was already released');
  const [row] = await db
    .update(legalHolds)
    .set({ releasedAt: new Date(), releasedById: ctx.userId })
    .where(eq(legalHolds.id, id))
    .returning();
  await audit({
    action: AuditAction.LEGAL_HOLD_CHANGED,
    actor: ctx,
    resourceType: 'legal_hold',
    resourceId: id,
    patientId: hold.patientId,
    meta: requestMeta(req),
    metadata: { event: 'released', reason },
  });
  res.json(row);
});
