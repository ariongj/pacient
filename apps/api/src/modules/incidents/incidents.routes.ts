import { Router } from 'express';
import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  auditLogs,
  careAssignments,
  careUnits,
  facilities,
  incidentActions,
  incidentReviewers,
  patients,
  safetyIncidents,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { unitAccessVia } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  CONTRIBUTING_FACTORS,
  DISCLOSURE_HARM,
  HARM_LEVELS,
  HAZARD_REF,
  INCIDENT_CATEGORIES,
  INCIDENT_STATUSES,
  REPORTER_ROLES,
  SERIOUS_HARM,
  TRANSITIONS,
  type HarmLevel,
  type IncidentStatus,
} from './incidents.constants.js';
import {
  facilityStaff,
  isReviewer,
  monthSeries,
  nextIncidentReference,
  reviewerIdsFor,
  suppressCells,
  windowStart,
} from './incidents.service.js';

/**
 * Patient safety incident and near-miss reporting – a learning system, not a disciplinary one.
 *
 * - Any staff member reports at their facility, optionally anonymously: the reporter is then not
 *   stored anywhere (not in the row, not in the audit trail, no IP address or user agent).
 * - Reports are read only by the facility's reviewers (its directors and named safety leads).
 *   Reporters see their own named reports and the outcome; action owners see their actions.
 * - The patient involved does not see the report, and reviewers reading it is not a record access
 *   (no clinical record is opened), so it is audited as `safety_incident`, never against the
 *   patient's access log.
 * - The Ministry sees national counts with small-cell suppression and, for the clinical safety
 *   officer, incidents involving the system (IT_SYSTEM) – their text only once the facility has
 *   closed its review.
 */
export const incidentsRouter = Router();
incidentsRouter.use(authenticate);

const IdParam = z.object({ id: z.string().uuid() });
const ActionIdParam = z.object({ actionId: z.string().uuid() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const Months = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) });
const reporterRoles: readonly string[] = REPORTER_ROLES;

function reporterFacility(ctx: AuthContext): string {
  if (!reporterRoles.includes(ctx.role) || !ctx.facilityId) {
    throw forbidden('Incidents are reported by staff of a facility');
  }
  return ctx.facilityId;
}

async function loadIncident(id: string) {
  const [row] = await db.select().from(safetyIncidents).where(eq(safetyIncidents.id, id));
  if (!row) throw notFound('Incident not found');
  return row;
}

async function assertReviewer(ctx: AuthContext, facilityId: string) {
  if (!(await isReviewer(ctx, facilityId))) {
    throw forbidden('Only the facility’s incident reviewers can see this');
  }
}

/**
 * The reporter may attach the patient involved only if they are caring for them (care team or
 * the ward they work on). Unknown national IDs and patients they cannot see get the same answer,
 * so the form cannot be used to find out whether someone is registered; nothing is written to the
 * patient's access log for the lookup.
 */
async function attachablePatient(ctx: AuthContext, nationalId: string): Promise<string> {
  const refuse = () =>
    badRequest(
      'You can attach only a patient in your care. Describe the patient without identifiers instead – the reviewers can add them.',
    );
  if (ctx.role !== 'DOCTOR' && ctx.role !== 'NURSE') throw refuse();
  const [p] = await db
    .select({ id: patients.id, mergedIntoId: patients.mergedIntoId })
    .from(patients)
    .where(eq(patients.nationalId, nationalId));
  if (!p) throw refuse();
  const patientId = p.mergedIntoId ?? p.id;
  const [care] = await db
    .select({ id: careAssignments.id })
    .from(careAssignments)
    .where(
      and(
        eq(careAssignments.doctorId, ctx.userId),
        eq(careAssignments.patientId, patientId),
        isNull(careAssignments.endedAt),
      ),
    );
  if (care) return patientId;
  if (await unitAccessVia(ctx.userId, ctx.facilityId, patientId)) return patientId;
  throw refuse();
}

/* ------------------------------------------------------------------------------------ meta -- */

incidentsRouter.get('/meta', async (req, res) => {
  const ctx = requireAuth(req);
  const canReport = reporterRoles.includes(ctx.role) && Boolean(ctx.facilityId);
  const units = ctx.facilityId
    ? await db
        .select({ id: careUnits.id, name: careUnits.name, type: careUnits.type })
        .from(careUnits)
        .where(and(eq(careUnits.facilityId, ctx.facilityId), eq(careUnits.isActive, true)))
        .orderBy(careUnits.name)
    : [];
  res.json({
    categories: INCIDENT_CATEGORIES,
    harmLevels: HARM_LEVELS,
    statuses: INCIDENT_STATUSES,
    contributingFactors: CONTRIBUTING_FACTORS,
    disclosureHarm: [...DISCLOSURE_HARM],
    units,
    canReport,
    canAttachPatient: ctx.role === 'DOCTOR' || ctx.role === 'NURSE',
    canReview: ctx.facilityId ? await isReviewer(ctx, ctx.facilityId) : false,
    canManageReviewers: ctx.role === 'DIRECTOR',
    isMinistry: ctx.role === 'MINISTRY',
    smallCellThreshold: SMALL_CELL_THRESHOLD,
  });
});

/* -------------------------------------------------------------------------------- reporting -- */

const ReportInput = z.object({
  occurredAt: z.coerce
    .date()
    .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'The time cannot be in the future')
    .refine(
      (d) => d.getTime() >= Date.now() - 2 * 365 * 86_400_000,
      'Report incidents from the last two years',
    ),
  unitId: z.string().uuid().nullish(),
  location: z.string().trim().max(200).nullish(),
  category: z.enum(INCIDENT_CATEGORIES),
  harm: z.enum(HARM_LEVELS),
  description: z
    .string()
    .trim()
    .min(20, 'Describe what happened in at least 20 characters')
    .max(5000),
  immediateAction: z.string().trim().max(2000).nullish(),
  patientNationalId: z
    .string()
    .trim()
    .regex(/^[A-Z0-9]{5,20}$/i, 'Enter the national ID number')
    .nullish(),
  anonymous: z.boolean().default(false),
});

incidentsRouter.post('/', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = reporterFacility(ctx);
  const input = parse(ReportInput, req.body);
  if (input.unitId) {
    const [unit] = await db
      .select({ id: careUnits.id })
      .from(careUnits)
      .where(and(eq(careUnits.id, input.unitId), eq(careUnits.facilityId, facilityId)));
    if (!unit) throw badRequest('Choose a unit of your facility');
  }
  const patientId = input.patientNationalId
    ? await attachablePatient(ctx, input.patientNationalId)
    : null;

  const incident = await db.transaction(async (tx) => {
    const reference = await nextIncidentReference(tx);
    const [row] = await tx
      .insert(safetyIncidents)
      .values({
        reference,
        facilityId,
        reportedById: input.anonymous ? null : ctx.userId,
        reporterRole: ctx.role,
        anonymous: input.anonymous,
        occurredAt: input.occurredAt,
        unitId: input.unitId ?? null,
        location: input.location ?? null,
        category: input.category,
        harm: input.harm,
        description: input.description,
        immediateAction: input.immediateAction ?? null,
        patientId,
      })
      .returning();
    const metadata = {
      reference,
      category: input.category,
      harm: input.harm,
      anonymous: input.anonymous,
      patientAttached: Boolean(patientId),
    };
    if (input.anonymous) {
      // No actor, IP address, user agent or request id: the report cannot be traced back. The
      // facility is kept so the director's audit review still shows that a report was made.
      await tx.insert(auditLogs).values({
        action: AuditAction.INCIDENT_REPORTED,
        actorFacilityId: facilityId,
        resourceType: 'safety_incident',
        resourceId: row!.id,
        metadata,
      });
    } else {
      await audit(
        {
          action: AuditAction.INCIDENT_REPORTED,
          actor: ctx,
          resourceType: 'safety_incident',
          resourceId: row!.id,
          meta: requestMeta(req),
          metadata,
        },
        tx,
      );
    }
    const serious = SERIOUS_HARM.has(input.harm);
    await notifyUsers(
      await reviewerIdsFor(facilityId, tx),
      {
        type: 'incident',
        title: serious
          ? 'Serious safety incident reported: {reference} – review now'
          : 'New safety incident reported: {reference}',
        vars: { reference },
        link: `/incidents?id=${row!.id}`,
        important: serious,
      },
      tx,
    );
    return row!;
  });
  res.status(201).json({
    id: incident.id,
    reference: incident.reference,
    anonymous: incident.anonymous,
    status: incident.status,
  });
});

/** The reporter's own named reports with their status and, once closed, what was learned. */
incidentsRouter.get('/mine', async (req, res) => {
  const ctx = requireAuth(req);
  const p = parse(PaginationSchema, req.query);
  const where = eq(safetyIncidents.reportedById, ctx.userId);
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({
        id: safetyIncidents.id,
        reference: safetyIncidents.reference,
        category: safetyIncidents.category,
        harm: safetyIncidents.harm,
        status: safetyIncidents.status,
        occurredAt: safetyIncidents.occurredAt,
        reportedAt: safetyIncidents.reportedAt,
        closedAt: safetyIncidents.closedAt,
        description: safetyIncidents.description,
        lessons: safetyIncidents.lessons,
        unitName: careUnits.name,
      })
      .from(safetyIncidents)
      .leftJoin(careUnits, eq(careUnits.id, safetyIncidents.unitId))
      .where(where)
      .orderBy(desc(safetyIncidents.reportedAt))
      .limit(toOffset(p).limit)
      .offset(toOffset(p).offset),
    db.select({ total: count() }).from(safetyIncidents).where(where),
  ]);
  res.json(
    paginated(
      rows.map((r) => ({ ...r, lessons: r.status === 'CLOSED' ? r.lessons : null })),
      total,
      p,
    ),
  );
});

/* ------------------------------------------------------------------------------ action owners -- */

const ownerUser = aliasedTable(users, 'owner_user');

incidentsRouter.get('/actions/mine', async (req, res) => {
  const ctx = requireAuth(req);
  const rows = await db
    .select({
      id: incidentActions.id,
      description: incidentActions.description,
      dueDate: incidentActions.dueDate,
      completedAt: incidentActions.completedAt,
      incidentId: incidentActions.incidentId,
      reference: safetyIncidents.reference,
      category: safetyIncidents.category,
    })
    .from(incidentActions)
    .innerJoin(safetyIncidents, eq(safetyIncidents.id, incidentActions.incidentId))
    .where(
      and(
        eq(incidentActions.ownerId, ctx.userId),
        sql`(${incidentActions.completedAt} IS NULL OR ${incidentActions.completedAt} > now() - interval '30 days')`,
      ),
    )
    .orderBy(sql`${incidentActions.completedAt} IS NOT NULL`, asc(incidentActions.dueDate));
  res.json({ items: rows });
});

const ActionUpdate = z
  .object({
    completed: z.boolean().optional(),
    description: z.string().trim().min(3).max(500).optional(),
    ownerId: z.string().uuid().nullish(),
    dueDate: isoDate.nullish(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

incidentsRouter.patch('/actions/:actionId', async (req, res) => {
  const ctx = requireAuth(req);
  const { actionId } = parse(ActionIdParam, req.params);
  const input = parse(ActionUpdate, req.body);
  const [action] = await db.select().from(incidentActions).where(eq(incidentActions.id, actionId));
  if (!action) throw notFound('Action not found');
  const incident = await loadIncident(action.incidentId);
  const reviewer = await isReviewer(ctx, incident.facilityId);
  const owner = action.ownerId === ctx.userId;
  if (!reviewer && !owner) throw notFound('Action not found');
  const editsDetails =
    input.description !== undefined || input.ownerId !== undefined || input.dueDate !== undefined;
  if (editsDetails && !reviewer) throw forbidden('Only reviewers can change an action');
  if (editsDetails && incident.status === 'CLOSED') {
    throw conflict('The review is closed – reopen it to change its actions');
  }
  if (input.ownerId) {
    const [staff] = await facilityStaff(incident.facilityId, [input.ownerId]);
    if (!staff) throw badRequest('The owner must be a member of staff at this facility');
  }
  const [updated] = await db.transaction(async (tx) => {
    const result = await tx
      .update(incidentActions)
      .set({
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
        ...(input.completed !== undefined
          ? { completedAt: input.completed ? (action.completedAt ?? new Date()) : null }
          : {}),
      })
      .where(eq(incidentActions.id, actionId))
      .returning();
    await audit(
      {
        action: AuditAction.INCIDENT_UPDATED,
        actor: ctx,
        resourceType: 'safety_incident',
        resourceId: incident.id,
        meta: requestMeta(req),
        metadata: { reference: incident.reference, actionId, changes: Object.keys(input) },
      },
      tx,
    );
    if (input.ownerId && input.ownerId !== action.ownerId && input.ownerId !== ctx.userId) {
      await notifyUsers(
        [input.ownerId],
        {
          type: 'incident',
          title: 'An action from incident {reference} was assigned to you',
          vars: { reference: incident.reference },
          link: '/incidents?tab=actions',
        },
        tx,
      );
    }
    return result;
  });
  res.json(updated);
});

/* -------------------------------------------------------------------------------- reviewers -- */

incidentsRouter.get('/reviewers', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = ctx.facilityId!;
  const reviewers = await db
    .select({ userId: users.id, fullName: users.fullName, role: users.role })
    .from(incidentReviewers)
    .innerJoin(users, eq(users.id, incidentReviewers.userId))
    .where(eq(incidentReviewers.facilityId, facilityId))
    .orderBy(users.fullName);
  const candidates = await db
    .select({ userId: users.id, fullName: users.fullName, role: users.role })
    .from(users)
    .where(
      and(
        eq(users.facilityId, facilityId),
        eq(users.isActive, true),
        inArray(users.role, ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION']),
      ),
    )
    .orderBy(users.fullName);
  res.json({ reviewers, candidates });
});

incidentsRouter.put('/reviewers', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = ctx.facilityId!;
  const { userIds } = parse(z.object({ userIds: z.array(z.string().uuid()).max(50) }), req.body);
  const unique = [...new Set(userIds)];
  const staff = (await facilityStaff(facilityId, unique)).filter((s) => s.role !== 'DIRECTOR');
  if (staff.length !== unique.length) {
    throw badRequest('Reviewers must be clinical or administrative staff of your facility');
  }
  await db.transaction(async (tx) => {
    await tx.delete(incidentReviewers).where(eq(incidentReviewers.facilityId, facilityId));
    if (unique.length) {
      await tx.insert(incidentReviewers).values(unique.map((userId) => ({ facilityId, userId })));
    }
    await audit(
      {
        action: AuditAction.INCIDENT_REVIEWERS_CHANGED,
        actor: ctx,
        resourceType: 'facility',
        resourceId: facilityId,
        meta: requestMeta(req),
        metadata: { reviewerIds: unique },
      },
      tx,
    );
  });
  res.json({ userIds: unique });
});

/** Staff of the reviewer's facility (action owners) and who can review (reviewer assignment). */
incidentsRouter.get('/staff', async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden('Only the facility’s incident reviewers can see this');
  await assertReviewer(ctx, ctx.facilityId);
  const staff = await db
    .select({ id: users.id, fullName: users.fullName, role: users.role })
    .from(users)
    .where(
      and(
        eq(users.facilityId, ctx.facilityId),
        eq(users.isActive, true),
        inArray(users.role, ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'DIRECTOR']),
      ),
    )
    .orderBy(users.fullName);
  res.json({ staff, reviewerIds: await reviewerIdsFor(ctx.facilityId) });
});

/* -------------------------------------------------------------------------------- dashboards -- */

async function grouped(where: SQL, key: SQL) {
  const rows = await db
    .select({ key: sql<string>`${key}`, count: count() })
    .from(safetyIncidents)
    .leftJoin(careUnits, eq(careUnits.id, safetyIncidents.unitId))
    .leftJoin(facilities, eq(facilities.id, safetyIncidents.facilityId))
    .where(where)
    .groupBy(sql`1`)
    .orderBy(desc(count()));
  return rows.map((r) => ({ key: r.key ?? '', count: Number(r.count) }));
}

const monthKey = sql`to_char(${safetyIncidents.reportedAt} AT TIME ZONE 'Europe/Belgrade', 'YYYY-MM')`;
const effectiveHarm = sql`coalesce(${safetyIncidents.reviewedHarm}, ${safetyIncidents.harm})`;

/** Facility dashboard for reviewers: everything counted, nothing suppressed (own facility). */
incidentsRouter.get('/dashboard', async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  await assertReviewer(ctx, ctx.facilityId);
  const { months } = parse(Months, req.query);
  const since = windowStart(months);
  const where = and(
    eq(safetyIncidents.facilityId, ctx.facilityId),
    sql`${safetyIncidents.reportedAt} >= ${since}`,
  )!;
  const [byCategory, byHarm, byStatus, byUnit, byMonth] = await Promise.all([
    grouped(where, sql`${safetyIncidents.category}`),
    grouped(where, effectiveHarm),
    grouped(where, sql`${safetyIncidents.status}`),
    grouped(where, sql`coalesce(${careUnits.name}, '')`),
    grouped(where, monthKey),
  ]);
  const closeStats = await db.execute<{
    median: string | null;
    mean: string | null;
    n: number;
  }>(sql`
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM closed_at - reported_at) / 86400) AS median,
           avg(extract(epoch FROM closed_at - reported_at) / 86400) AS mean,
           count(*)::int AS n
    FROM safety_incidents
    WHERE facility_id = ${ctx.facilityId} AND closed_at IS NOT NULL AND reported_at >= ${since}`);
  const overdue = await db
    .select({
      id: incidentActions.id,
      description: incidentActions.description,
      dueDate: incidentActions.dueDate,
      ownerName: ownerUser.fullName,
      incidentId: safetyIncidents.id,
      reference: safetyIncidents.reference,
    })
    .from(incidentActions)
    .innerJoin(safetyIncidents, eq(safetyIncidents.id, incidentActions.incidentId))
    .leftJoin(ownerUser, eq(ownerUser.id, incidentActions.ownerId))
    .where(
      and(
        eq(safetyIncidents.facilityId, ctx.facilityId),
        isNull(incidentActions.completedAt),
        sql`${incidentActions.dueDate} < (now() AT TIME ZONE 'Europe/Belgrade')::date`,
      ),
    )
    .orderBy(asc(incidentActions.dueDate))
    .limit(50);
  const stats = closeStats.rows[0];
  const total = byStatus.reduce((s, r) => s + r.count, 0);
  res.json({
    months,
    total,
    open: byStatus.filter((r) => r.key !== 'CLOSED').reduce((s, r) => s + r.count, 0),
    byCategory,
    byHarm,
    byStatus,
    byUnit,
    byMonth: monthSeries(byMonth, months),
    timeToClose: {
      closed: stats?.n ?? 0,
      medianDays: stats?.median == null ? null : Math.round(Number(stats.median) * 10) / 10,
      meanDays: stats?.mean == null ? null : Math.round(Number(stats.mean) * 10) / 10,
    },
    overdueActions: overdue,
  });
});

/** National counts for the Ministry: no descriptions, no patients, small cells suppressed. */
incidentsRouter.get('/national', requireRole('MINISTRY'), async (req, res) => {
  const { months } = parse(Months, req.query);
  const since = windowStart(months);
  const where = sql`${safetyIncidents.reportedAt} >= ${since}`;
  const [byCategory, byHarm, byMonth, byFacility] = await Promise.all([
    grouped(where, sql`${safetyIncidents.category}`),
    grouped(where, effectiveHarm),
    grouped(where, monthKey),
    grouped(where, sql`${facilities.name}`),
  ]);
  const total = byCategory.reduce((s, r) => s + r.count, 0);
  res.json({
    months,
    total: total < SMALL_CELL_THRESHOLD ? null : total,
    byCategory: suppressCells(byCategory),
    byHarm: suppressCells(byHarm),
    byMonth: suppressCells(monthSeries(byMonth, months)),
    byFacility: suppressCells(byFacility),
    smallCellThreshold: SMALL_CELL_THRESHOLD,
  });
});

/**
 * Incidents involving the system itself, for the clinical safety officer's hazard log. Text
 * (description, findings, lessons) is released only after the facility closed its review, which
 * is when reviewers have removed anything identifying; patients and reporters are never included.
 */
incidentsRouter.get('/national/it-system', requireRole('MINISTRY'), async (req, res) => {
  const p = parse(PaginationSchema, req.query);
  const where = eq(safetyIncidents.category, 'IT_SYSTEM');
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({
        id: safetyIncidents.id,
        reference: safetyIncidents.reference,
        facilityName: facilities.name,
        occurredMonth: sql<string>`to_char(${safetyIncidents.occurredAt} AT TIME ZONE 'Europe/Belgrade', 'YYYY-MM')`,
        harm: safetyIncidents.harm,
        reviewedHarm: safetyIncidents.reviewedHarm,
        status: safetyIncidents.status,
        hazardRef: safetyIncidents.hazardRef,
        contributingFactors: safetyIncidents.contributingFactors,
        description: safetyIncidents.description,
        findings: safetyIncidents.findings,
        lessons: safetyIncidents.lessons,
        closedAt: safetyIncidents.closedAt,
      })
      .from(safetyIncidents)
      .innerJoin(facilities, eq(facilities.id, safetyIncidents.facilityId))
      .where(where)
      .orderBy(desc(safetyIncidents.reportedAt))
      .limit(toOffset(p).limit)
      .offset(toOffset(p).offset),
    db.select({ total: count() }).from(safetyIncidents).where(where),
  ]);
  res.json(
    paginated(
      rows.map((r) =>
        r.status === 'CLOSED'
          ? r
          : { ...r, description: null, findings: null, lessons: null, textWithheld: true },
      ),
      total,
      p,
    ),
  );
});

/* ------------------------------------------------------------------------------ review queue -- */

const pageOf = (q: { page: number; pageSize: number }) => ({ page: q.page, pageSize: q.pageSize });
const reviewerUser = aliasedTable(users, 'reviewer_user');
const reporterUser = aliasedTable(users, 'reporter_user');

const ListQuery = PaginationSchema.extend({
  status: z.enum([...INCIDENT_STATUSES, 'OPEN']).optional(),
  category: z.enum(INCIDENT_CATEGORIES).optional(),
  harm: z.enum(HARM_LEVELS).optional(),
  unitId: z.string().uuid().optional(),
  q: z.string().trim().max(30).optional(),
});

incidentsRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden('Only the facility’s incident reviewers can see this');
  await assertReviewer(ctx, ctx.facilityId);
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [eq(safetyIncidents.facilityId, ctx.facilityId)];
  if (q.status === 'OPEN') filters.push(sql`${safetyIncidents.status} <> 'CLOSED'`);
  else if (q.status) filters.push(eq(safetyIncidents.status, q.status));
  if (q.category) filters.push(eq(safetyIncidents.category, q.category));
  if (q.harm) filters.push(sql`${effectiveHarm} = ${q.harm}`);
  if (q.unitId) filters.push(eq(safetyIncidents.unitId, q.unitId));
  if (q.q) filters.push(sql`${safetyIncidents.reference} ILIKE ${`%${q.q}%`}`);
  const where = and(...filters)!;
  const openActions = sql<number>`(SELECT count(*)::int FROM incident_actions a WHERE a.incident_id = ${safetyIncidents.id} AND a.completed_at IS NULL)`;
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({
        id: safetyIncidents.id,
        reference: safetyIncidents.reference,
        category: safetyIncidents.category,
        harm: safetyIncidents.harm,
        reviewedHarm: safetyIncidents.reviewedHarm,
        status: safetyIncidents.status,
        occurredAt: safetyIncidents.occurredAt,
        reportedAt: safetyIncidents.reportedAt,
        anonymous: safetyIncidents.anonymous,
        reporterRole: safetyIncidents.reporterRole,
        unitName: careUnits.name,
        reviewerName: reviewerUser.fullName,
        hasPatient: sql<boolean>`${safetyIncidents.patientId} IS NOT NULL`,
        openActions,
      })
      .from(safetyIncidents)
      .leftJoin(careUnits, eq(careUnits.id, safetyIncidents.unitId))
      .leftJoin(reviewerUser, eq(reviewerUser.id, safetyIncidents.reviewerId))
      .where(where)
      .orderBy(
        sql`${safetyIncidents.status} = 'CLOSED'`,
        sql`${safetyIncidents.harm} IN ('SEVERE', 'DEATH') DESC`,
        desc(safetyIncidents.reportedAt),
      )
      .limit(toOffset(pageOf(q)).limit)
      .offset(toOffset(pageOf(q)).offset),
    db.select({ total: count() }).from(safetyIncidents).where(where),
  ]);
  res.json(paginated(rows, total, pageOf(q)));
});

async function incidentDetail(id: string) {
  const [row] = await db
    .select({
      incident: safetyIncidents,
      unitName: careUnits.name,
      reviewerName: reviewerUser.fullName,
      reporterName: reporterUser.fullName,
      patient: {
        id: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
        nationalId: patients.nationalId,
      },
    })
    .from(safetyIncidents)
    .leftJoin(careUnits, eq(careUnits.id, safetyIncidents.unitId))
    .leftJoin(reviewerUser, eq(reviewerUser.id, safetyIncidents.reviewerId))
    .leftJoin(reporterUser, eq(reporterUser.id, safetyIncidents.reportedById))
    .leftJoin(patients, eq(patients.id, safetyIncidents.patientId))
    .where(eq(safetyIncidents.id, id));
  if (!row) throw notFound('Incident not found');
  const actions = await db
    .select({
      id: incidentActions.id,
      description: incidentActions.description,
      ownerId: incidentActions.ownerId,
      ownerName: ownerUser.fullName,
      dueDate: incidentActions.dueDate,
      completedAt: incidentActions.completedAt,
      createdAt: incidentActions.createdAt,
    })
    .from(incidentActions)
    .leftJoin(ownerUser, eq(ownerUser.id, incidentActions.ownerId))
    .where(eq(incidentActions.incidentId, id))
    .orderBy(asc(incidentActions.createdAt));
  const { incident } = row;
  return {
    ...incident,
    unitName: row.unitName,
    reviewerName: row.reviewerName,
    reporterName: incident.anonymous ? null : row.reporterName,
    patient: row.patient?.id ? row.patient : null,
    actions,
  };
}

incidentsRouter.get('/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const incident = await loadIncident(id);
  if (await isReviewer(ctx, incident.facilityId)) {
    await audit({
      action: AuditAction.INCIDENT_UPDATED,
      actor: ctx,
      resourceType: 'safety_incident',
      resourceId: id,
      meta: requestMeta(req),
      metadata: { reference: incident.reference, viewed: true },
    });
    res.json({ ...(await incidentDetail(id)), viewerIsReviewer: true });
    return;
  }
  // The reporter sees their own report and its outcome – never the review notes or the patient.
  if (incident.reportedById && incident.reportedById === ctx.userId) {
    res.json({
      id: incident.id,
      reference: incident.reference,
      category: incident.category,
      harm: incident.harm,
      status: incident.status,
      occurredAt: incident.occurredAt,
      reportedAt: incident.reportedAt,
      closedAt: incident.closedAt,
      description: incident.description,
      immediateAction: incident.immediateAction,
      lessons: incident.status === 'CLOSED' ? incident.lessons : null,
      viewerIsReviewer: false,
    });
    return;
  }
  throw notFound('Incident not found');
});

/* ------------------------------------------------------------------------------------ review -- */

const ReviewInput = z
  .object({
    status: z.enum(INCIDENT_STATUSES).optional(),
    reviewerId: z.string().uuid().optional(),
    category: z.enum(INCIDENT_CATEGORIES).optional(),
    reviewedHarm: z.enum(HARM_LEVELS).nullish(),
    contributingFactors: z.array(z.enum(CONTRIBUTING_FACTORS)).max(10).optional(),
    findings: z.string().trim().max(10_000).nullish(),
    lessons: z.string().trim().max(5000).nullish(),
    hazardRef: z
      .string()
      .trim()
      .toUpperCase()
      .regex(HAZARD_REF, 'Use a hazard number from the clinical safety case, e.g. H17')
      .nullish(),
    patientInformedAt: z.coerce
      .date()
      .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'The time cannot be in the future')
      .nullish(),
    /** Open actions deliberately carried over when closing (they stay on the owners' lists). */
    carryOverActionIds: z.array(z.string().uuid()).max(50).optional(),
    reopenReason: z.string().trim().min(10).max(500).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

incidentsRouter.patch('/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(ReviewInput, req.body);
  const existing = await loadIncident(id);
  if (!(await isReviewer(ctx, existing.facilityId))) throw notFound('Incident not found');

  const result = await db.transaction(async (tx) => {
    const [incident] = await tx
      .select()
      .from(safetyIncidents)
      .where(eq(safetyIncidents.id, id))
      .for('update');
    if (!incident) throw notFound('Incident not found');
    const from = incident.status as IncidentStatus;
    const to = input.status ?? from;
    const reopening = from === 'CLOSED' && to === 'UNDER_REVIEW';
    if (from === 'CLOSED' && !reopening) {
      throw conflict('This review is closed. Reopen it (director) to make changes.');
    }
    if (to !== from && !TRANSITIONS[from].includes(to)) {
      throw conflict('This status change is not allowed');
    }
    if (reopening) {
      if (ctx.role !== 'DIRECTOR') throw forbidden('Only the director can reopen a closed review');
      if (!input.reopenReason) throw badRequest('Give a reason for reopening the review');
    }

    let reviewerId = input.reviewerId ?? incident.reviewerId;
    if (from === 'NEW' && to === 'UNDER_REVIEW' && !reviewerId) reviewerId = ctx.userId;
    if (input.reviewerId && input.reviewerId !== incident.reviewerId) {
      if (!(await reviewerIdsFor(incident.facilityId, tx)).includes(input.reviewerId)) {
        throw badRequest('Choose one of the facility’s incident reviewers');
      }
    }

    const next = {
      category: input.category ?? incident.category,
      reviewedHarm: input.reviewedHarm !== undefined ? input.reviewedHarm : incident.reviewedHarm,
      contributingFactors: input.contributingFactors ?? incident.contributingFactors,
      findings: input.findings !== undefined ? input.findings || null : incident.findings,
      lessons: input.lessons !== undefined ? input.lessons || null : incident.lessons,
      hazardRef: input.hazardRef !== undefined ? input.hazardRef || null : incident.hazardRef,
      patientInformedAt:
        input.patientInformedAt !== undefined
          ? input.patientInformedAt
          : incident.patientInformedAt,
    };
    if (next.patientInformedAt && next.patientInformedAt < incident.occurredAt) {
      throw badRequest('The patient cannot have been told before the incident happened');
    }

    const actions = await tx
      .select({ id: incidentActions.id, completedAt: incidentActions.completedAt })
      .from(incidentActions)
      .where(eq(incidentActions.incidentId, id));
    if (to === 'ACTION_PLANNED' && from !== 'ACTION_PLANNED' && !actions.length) {
      throw badRequest('Add at least one action before marking the action plan as agreed');
    }
    let carriedOver: string[] = [];
    if (to === 'CLOSED' && from !== 'CLOSED') {
      if (!next.findings) throw badRequest('Record the review findings before closing');
      if (!next.reviewedHarm) throw badRequest('Confirm the level of harm before closing');
      if (DISCLOSURE_HARM.has(next.reviewedHarm as HarmLevel) && !next.patientInformedAt) {
        throw badRequest(
          'Moderate or greater harm: record when the patient or family was told (open disclosure) before closing',
        );
      }
      const open = actions.filter((a) => !a.completedAt).map((a) => a.id);
      const carry = new Set(input.carryOverActionIds ?? []);
      const notCarried = open.filter((a) => !carry.has(a));
      if (notCarried.length) {
        throw badRequest(
          'Complete every action, or carry the open ones over explicitly, before closing',
        );
      }
      carriedOver = open;
    }

    const [updated] = await tx
      .update(safetyIncidents)
      .set({
        ...next,
        status: to,
        reviewerId,
        closedAt: to === 'CLOSED' ? new Date() : reopening ? null : incident.closedAt,
      })
      .where(eq(safetyIncidents.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.INCIDENT_UPDATED,
        actor: ctx,
        resourceType: 'safety_incident',
        resourceId: id,
        meta: requestMeta(req),
        metadata: {
          reference: incident.reference,
          from,
          to,
          changes: Object.keys(input).filter((k) => k !== 'reopenReason'),
          ...(carriedOver.length ? { carriedOverActionIds: carriedOver } : {}),
          ...(reopening ? { reopenReason: input.reopenReason } : {}),
        },
      },
      tx,
    );

    if (reviewerId && reviewerId !== incident.reviewerId && reviewerId !== ctx.userId) {
      await notifyUsers(
        [reviewerId],
        {
          type: 'incident',
          title: 'You were asked to review incident {reference}',
          vars: { reference: incident.reference },
          link: `/incidents?id=${id}`,
        },
        tx,
      );
    }
    if (to !== from && incident.reportedById && incident.reportedById !== ctx.userId) {
      const title = {
        NEW: null,
        UNDER_REVIEW: 'Your incident report {reference} is being reviewed',
        ACTION_PLANNED: 'Actions were agreed for your incident report {reference}',
        CLOSED: 'Your incident report {reference} was closed – see what was learned',
      }[to];
      if (title) {
        await notifyUsers(
          [incident.reportedById],
          {
            type: 'incident',
            title,
            vars: { reference: incident.reference },
            link: `/incidents?tab=mine&id=${id}`,
          },
          tx,
        );
      }
    }
    return updated!;
  });
  res.json(result);
});

const ActionInput = z.object({
  description: z.string().trim().min(3).max(500),
  ownerId: z.string().uuid().nullish(),
  dueDate: isoDate.nullish(),
});

incidentsRouter.post('/:id/actions', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(ActionInput, req.body);
  const incident = await loadIncident(id);
  if (!(await isReviewer(ctx, incident.facilityId))) throw notFound('Incident not found');
  if (incident.status === 'CLOSED') {
    throw conflict('The review is closed – reopen it to add actions');
  }
  if (input.ownerId) {
    const [staff] = await facilityStaff(incident.facilityId, [input.ownerId]);
    if (!staff) throw badRequest('The owner must be a member of staff at this facility');
  }
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(incidentActions)
      .values({
        incidentId: id,
        description: input.description,
        ownerId: input.ownerId ?? null,
        dueDate: input.dueDate ?? null,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.INCIDENT_UPDATED,
        actor: ctx,
        resourceType: 'safety_incident',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { reference: incident.reference, actionAdded: created!.id },
      },
      tx,
    );
    if (input.ownerId && input.ownerId !== ctx.userId) {
      await notifyUsers(
        [input.ownerId],
        {
          type: 'incident',
          title: 'An action from incident {reference} was assigned to you',
          vars: { reference: incident.reference },
          link: '/incidents?tab=actions',
        },
        tx,
      );
    }
    return created!;
  });
  res.status(201).json(row);
});
