import { Router } from 'express';
import { and, count, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { complaints, facilities, feedbackResponses, patients, users } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  COMPLAINT_CATEGORIES,
  COMPLAINT_CHANNELS,
  COMPLAINT_STATUSES,
  FEEDBACK_ITEMS,
  FEEDBACK_SETTINGS,
  RESPONSE_OUTCOMES,
} from './complaints.constants.js';
import {
  careFacilities,
  complainantIds,
  complaintCounts,
  complaintTimeliness,
  deadlinesFor,
  dedupeKeyFor,
  directorIds,
  feedbackComments,
  feedbackGroups,
  hadRecentCare,
  ministryIds,
  monthOf,
  nextComplaintReference,
  rateableVisits,
  suppressed,
  timingOf,
} from './complaints.service.js';

/**
 * Patient complaints and experience feedback.
 *
 * Complaints are handled by the facility's director and the staff member they assign, with
 * deadlines for acknowledgement (5 working days) and a written response (30 days); the
 * complainant may escalate to the Ministry within 30 days of the response. Complaint content is
 * visible to the complainant, the facility's director and assignee, and – once escalated – the
 * Ministry. Reading a complaint is not access to the clinical record (it is audited as
 * `complaint`, never in the patient's access log), and complaints are never shown in the chart.
 *
 * Feedback is anonymous: the stored response has no patient, user, visit or exact time (month
 * only), its audit entry has no actor, IP address or patient, and results are shown only for
 * groups of at least the small-cell threshold.
 */
export const complaintsRouter = Router();
complaintsRouter.use(authenticate);

const IdParam = z.object({ id: z.string().uuid() });
const STAFF_ROLES = ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'DIRECTOR'] as const;
const staffRoles: readonly string[] = STAFF_ROLES;
const Months = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) });
const sinceDate = (months: number, now = new Date()) => {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months + 1, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

type ComplaintRow = typeof complaints.$inferSelect;

async function loadComplaint(id: string) {
  const [row] = await db.select().from(complaints).where(eq(complaints.id, id));
  if (!row) throw notFound('Complaint not found');
  return row;
}

/** The patient a portal request is about (own record, or a child with full guardian access). */
function portalPatient(ctx: AuthContext): string {
  if (ctx.role !== 'PATIENT' || !ctx.patientId) throw forbidden();
  if (ctx.proxy && ctx.proxy.scope !== 'FULL') {
    throw forbidden('Complaints for this person need full guardian access');
  }
  return ctx.patientId;
}

type Access = 'director' | 'assignee' | 'ministry' | null;

/** Who may work on a complaint; anyone else gets "not found" (existence is not revealed). */
function accessTo(ctx: AuthContext, c: ComplaintRow): Access {
  if (ctx.role === 'DIRECTOR' && ctx.facilityId === c.facilityId) return 'director';
  if (
    staffRoles.includes(ctx.role) &&
    c.assignedToId === ctx.userId &&
    ctx.facilityId === c.facilityId
  ) {
    return 'assignee';
  }
  if (ctx.role === 'MINISTRY' && c.escalatedAt) return 'ministry';
  return null;
}

function requireAccess(ctx: AuthContext, c: ComplaintRow, allowed: Access[]) {
  const access = accessTo(ctx, c);
  if (!access) throw notFound('Complaint not found');
  if (!allowed.includes(access)) throw forbidden();
  return access;
}

async function auditComplaint(
  req: Parameters<typeof requestMeta>[0],
  ctx: AuthContext,
  c: Pick<ComplaintRow, 'id' | 'reference'>,
  action: (typeof AuditAction)['COMPLAINT_SUBMITTED' | 'COMPLAINT_UPDATED'],
  metadata: Record<string, unknown> = {},
  executor: Parameters<typeof audit>[1] = db,
) {
  await audit(
    {
      action,
      actor: ctx,
      resourceType: 'complaint',
      resourceId: c.id,
      meta: requestMeta(req),
      metadata: { reference: c.reference, ...metadata },
    },
    executor,
  );
}

/** Staff view of a complaint (names for contact; never clinical content). */
async function staffView(c: ComplaintRow, access: Access) {
  const [facility] = await db
    .select({ name: facilities.name })
    .from(facilities)
    .where(eq(facilities.id, c.facilityId));
  const [patient] = c.patientId
    ? await db
        .select({
          firstName: patients.firstName,
          lastName: patients.lastName,
          nationalId: patients.nationalId,
          phone: patients.phone,
        })
        .from(patients)
        .where(eq(patients.id, c.patientId))
    : [];
  const ids = [c.assignedToId, c.respondedById, c.submittedByUserId].filter((x): x is string =>
    Boolean(x),
  );
  const names = ids.length
    ? await db
        .select({ id: users.id, fullName: users.fullName })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  const nameOf = (id: string | null) =>
    id ? (names.find((n) => n.id === id)?.fullName ?? null) : null;
  const recentCare = c.patientId
    ? await hadRecentCare(c.patientId, c.facilityId, c.createdAt)
    : false;
  return {
    id: c.id,
    reference: c.reference,
    facilityId: c.facilityId,
    facilityName: facility?.name ?? null,
    patientId: access === 'ministry' ? null : c.patientId,
    // The Ministry decides on the facility's handling; it does not need contact details.
    patientName:
      access === 'ministry' || !patient ? null : `${patient.firstName} ${patient.lastName}`,
    patientNationalId: access === 'ministry' ? null : (patient?.nationalId ?? null),
    patientPhone: access === 'ministry' ? null : (patient?.phone ?? null),
    submittedBy: c.submittedByUserId ? nameOf(c.submittedByUserId) : null,
    channel: c.channel,
    category: c.category,
    description: c.description,
    desiredOutcome: c.desiredOutcome,
    status: c.status,
    assignedToId: c.assignedToId,
    assignedTo: nameOf(c.assignedToId),
    createdAt: c.createdAt,
    acknowledgedAt: c.acknowledgedAt,
    acknowledgeDueAt: c.acknowledgeDueAt,
    responseDueAt: c.responseDueAt,
    response: c.response,
    respondedAt: c.respondedAt,
    respondedBy: nameOf(c.respondedById),
    outcome: c.outcome,
    escalatedAt: c.escalatedAt,
    escalationReason: c.escalationReason,
    ministryDecision: c.ministryDecision,
    closedAt: c.closedAt,
    hadRecentCare: recentCare,
    ...timingOf(c),
  };
}

/** What the complainant sees: their complaint, the response and the Ministry decision. */
function portalView(c: ComplaintRow & { facilityName: string }) {
  const t = timingOf(c);
  return {
    id: c.id,
    reference: c.reference,
    facilityId: c.facilityId,
    facilityName: c.facilityName,
    channel: c.channel,
    category: c.category,
    description: c.description,
    desiredOutcome: c.desiredOutcome,
    status: c.status,
    createdAt: c.createdAt,
    acknowledgedAt: c.acknowledgedAt,
    responseDueAt: c.responseDueAt,
    response: c.response,
    respondedAt: c.respondedAt,
    outcome: c.outcome,
    escalatedAt: c.escalatedAt,
    escalationReason: c.escalationReason,
    ministryDecision: c.ministryDecision,
    closedAt: c.closedAt,
    canEscalate: t.canEscalate,
    escalateUntil: t.escalateUntil,
    canWithdraw: t.canWithdraw,
  };
}

const portalLink = (id: string) => `/portal/complaints?complaint=${id}`;
const staffLink = (id: string) => `/complaints?complaint=${id}`;

/* ------------------------------------------------------------------------------- reference -- */

complaintsRouter.get('/meta', async (req, res) => {
  const ctx = requireAuth(req);
  let staff: { id: string; fullName: string; role: string }[] = [];
  if (ctx.role === 'DIRECTOR' && ctx.facilityId) {
    staff = await db
      .select({ id: users.id, fullName: users.fullName, role: users.role })
      .from(users)
      .where(
        and(
          eq(users.facilityId, ctx.facilityId),
          eq(users.isActive, true),
          inArray(users.role, [...STAFF_ROLES]),
        ),
      )
      .orderBy(users.fullName);
  }
  res.json({
    categories: COMPLAINT_CATEGORIES,
    channels: COMPLAINT_CHANNELS,
    statuses: COMPLAINT_STATUSES,
    outcomes: RESPONSE_OUTCOMES,
    feedbackItems: FEEDBACK_ITEMS,
    feedbackSettings: FEEDBACK_SETTINGS,
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    staff,
    canRecord: (ctx.role === 'RECEPTION' || ctx.role === 'DIRECTOR') && Boolean(ctx.facilityId),
    canManage: ctx.role === 'DIRECTOR' && Boolean(ctx.facilityId),
    isMinistry: ctx.role === 'MINISTRY',
  });
});

/* ---------------------------------------------------------------------------------- portal -- */

complaintsRouter.get('/portal/facilities', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const patientId = portalPatient(ctx);
  const visited = await careFacilities(patientId);
  const rows = await db
    .select({ id: facilities.id, name: facilities.name, municipality: facilities.municipality })
    .from(facilities)
    .where(eq(facilities.isActive, true))
    .orderBy(facilities.name);
  res.json({ items: rows.map((f) => ({ ...f, visited: visited.has(f.id) })) });
});

const PortalComplaintInput = z.object({
  facilityId: z.string().uuid(),
  category: z.enum(COMPLAINT_CATEGORIES),
  description: z.string().trim().min(20).max(5000),
  desiredOutcome: z.string().trim().max(2000).optional().nullable(),
});

complaintsRouter.post('/portal', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const patientId = portalPatient(ctx);
  const input = parse(PortalComplaintInput, req.body);
  const [facility] = await db
    .select({ id: facilities.id, isActive: facilities.isActive })
    .from(facilities)
    .where(eq(facilities.id, input.facilityId));
  if (!facility?.isActive) throw badRequest('Unknown facility');
  const recentCare = await hadRecentCare(patientId, facility.id);
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    const reference = await nextComplaintReference(tx, now);
    const [created] = await tx
      .insert(complaints)
      .values({
        reference,
        facilityId: facility.id,
        patientId,
        submittedByUserId: ctx.userId,
        channel: 'PORTAL',
        category: input.category,
        description: input.description,
        desiredOutcome: input.desiredOutcome || null,
        ...deadlinesFor(now),
        createdAt: now,
      })
      .returning();
    await auditComplaint(
      req,
      ctx,
      created!,
      AuditAction.COMPLAINT_SUBMITTED,
      {
        channel: 'PORTAL',
        hadRecentCare: recentCare,
      },
      tx,
    );
    await notifyUsers(
      await directorIds(facility.id, tx),
      {
        type: 'complaint.new',
        title: 'New complaint {reference}',
        vars: { reference },
        link: staffLink(created!.id),
      },
      tx,
    );
    return created!;
  });
  res.status(201).json({
    id: row.id,
    reference: row.reference,
    acknowledgeDueAt: row.acknowledgeDueAt,
    responseDueAt: row.responseDueAt,
    hadRecentCare: recentCare,
  });
});

complaintsRouter.get('/portal', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const patientId = portalPatient(ctx);
  const rows = await db
    .select({ c: complaints, facilityName: facilities.name })
    .from(complaints)
    .innerJoin(facilities, eq(facilities.id, complaints.facilityId))
    .where(eq(complaints.patientId, patientId))
    .orderBy(desc(complaints.createdAt));
  res.json({ items: rows.map((r) => portalView({ ...r.c, facilityName: r.facilityName })) });
});

async function portalComplaint(ctx: AuthContext, id: string) {
  const patientId = portalPatient(ctx);
  const [row] = await db
    .select({ c: complaints, facilityName: facilities.name })
    .from(complaints)
    .innerJoin(facilities, eq(facilities.id, complaints.facilityId))
    .where(and(eq(complaints.id, id), eq(complaints.patientId, patientId)));
  if (!row) throw notFound('Complaint not found');
  return { ...row.c, facilityName: row.facilityName };
}

complaintsRouter.get('/portal/:id', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  res.json(portalView(await portalComplaint(ctx, id)));
});

const ReasonInput = z.object({ reason: z.string().trim().min(10).max(2000) });

complaintsRouter.post('/portal/:id/escalate', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(ReasonInput, req.body);
  const c = await portalComplaint(ctx, id);
  if (!timingOf(c).canEscalate) {
    throw conflict(
      'This complaint can be escalated to the Ministry only within 30 days of the facility’s response',
    );
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({ status: 'ESCALATED', escalatedAt: now, escalationReason: reason })
      .where(eq(complaints.id, id));
    await auditComplaint(req, ctx, c, AuditAction.COMPLAINT_UPDATED, { status: 'ESCALATED' }, tx);
    await notifyUsers(
      [...(await ministryIds(tx)), ...(await directorIds(c.facilityId, tx))],
      {
        type: 'complaint.escalated',
        title: 'Complaint {reference} escalated to the Ministry',
        vars: { reference: c.reference },
        link: staffLink(id),
        important: true,
      },
      tx,
    );
  });
  res.json(portalView(await portalComplaint(ctx, id)));
});

complaintsRouter.post('/portal/:id/withdraw', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const c = await portalComplaint(ctx, id);
  if (!timingOf(c).canWithdraw) throw conflict('This complaint can no longer be withdrawn');
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({ status: 'CLOSED', outcome: 'WITHDRAWN', closedAt: now })
      .where(eq(complaints.id, id));
    await auditComplaint(
      req,
      ctx,
      c,
      AuditAction.COMPLAINT_UPDATED,
      { status: 'CLOSED', outcome: 'WITHDRAWN' },
      tx,
    );
    const handlers = c.assignedToId ? [c.assignedToId] : await directorIds(c.facilityId, tx);
    await notifyUsers(
      handlers,
      {
        type: 'complaint.withdrawn',
        title: 'Complaint {reference} was withdrawn',
        vars: { reference: c.reference },
        link: staffLink(id),
      },
      tx,
    );
  });
  res.json(portalView(await portalComplaint(ctx, id)));
});

/* -------------------------------------------------------------------------------- feedback -- */

complaintsRouter.get('/feedback/eligible', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.patientId) throw forbidden();
  const visits = await rateableVisits(ctx.patientId, {
    appointmentsOnly: ctx.proxy?.scope === 'APPOINTMENTS',
  });
  res.json({
    items: visits.map((v) => ({
      setting: v.setting,
      visitId: v.visitId,
      facilityName: v.facilityName,
      unitName: v.unitName,
      endedAt: v.endedAt,
    })),
  });
});

const Score = z.number().int().min(1).max(5);
const FeedbackInput = z.object({
  setting: z.enum(FEEDBACK_SETTINGS),
  visitId: z.string().uuid(),
  overall: Score,
  scores: z
    .object(Object.fromEntries(FEEDBACK_ITEMS.map((i) => [i, Score.optional()])))
    .strict()
    .optional(),
  wouldRecommend: z.boolean().optional().nullable(),
  comment: z.string().trim().max(1000).optional().nullable(),
});

complaintsRouter.post('/feedback', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.patientId) throw forbidden();
  const input = parse(FeedbackInput, req.body);
  const visits = await rateableVisits(ctx.patientId, {
    appointmentsOnly: ctx.proxy?.scope === 'APPOINTMENTS',
  });
  const visit = visits.find((v) => v.setting === input.setting && v.visitId === input.visitId);
  if (!visit) {
    throw conflict('This visit cannot be rated (already rated, too long ago, or not yours)');
  }
  const scores = Object.fromEntries(
    Object.entries(input.scores ?? {}).filter(([, v]) => v !== undefined),
  ) as Record<string, number>;
  const month = monthOf(visit.endedAt);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(feedbackResponses).values({
        facilityId: visit.facilityId,
        unitId: visit.setting === 'INPATIENT' ? visit.unitId : null,
        setting: visit.setting,
        dedupeKey: dedupeKeyFor(visit.setting, visit.visitId),
        overall: input.overall,
        scores: Object.keys(scores).length ? scores : null,
        wouldRecommend: input.wouldRecommend ?? null,
        comment: input.comment || null,
        month,
        // Only the month is kept, so the time of submission cannot be matched to a visit.
        createdAt: new Date(`${month}T00:00:00Z`),
      });
      // No actor, patient, IP address, user agent or response id: the entry only shows that a
      // rating was given for the facility.
      await audit(
        {
          action: AuditAction.FEEDBACK_SUBMITTED,
          resourceType: 'feedback',
          metadata: { facilityId: visit.facilityId, setting: visit.setting },
        },
        tx,
      );
    });
  } catch (err) {
    if (
      (err as { cause?: { code?: string }; code?: string }).cause?.code === '23505' ||
      (err as { code?: string }).code === '23505'
    ) {
      throw conflict('This visit has already been rated');
    }
    throw err;
  }
  res.status(201).json({ ok: true });
});

const FeedbackScope = Months.extend({ facilityId: z.string().uuid().optional() });

complaintsRouter.get(
  '/feedback/dashboard',
  requireRole('DIRECTOR', 'MINISTRY'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const q = parse(FeedbackScope, req.query);
    const facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId! : q.facilityId;
    const since = monthOf(sinceDate(q.months));
    const [all] = await feedbackGroups('all', { facilityId, since });
    const byMonth = await feedbackGroups('month', { facilityId, since });
    const bySetting = await feedbackGroups('setting', { facilityId, since });
    const byUnit = facilityId ? await feedbackGroups('unit', { facilityId, since }) : [];
    const byFacility =
      ctx.role === 'MINISTRY' && !facilityId ? await feedbackGroups('facility', { since }) : [];
    const comments = ctx.role === 'DIRECTOR' ? await feedbackComments(ctx.facilityId!, since) : [];
    res.json({
      months: q.months,
      smallCellThreshold: SMALL_CELL_THRESHOLD,
      overall: all ?? null,
      byMonth,
      bySetting,
      byUnit,
      byFacility,
      comments,
    });
  },
);

/* ---------------------------------------------------------------------------------- staff -- */

const StaffComplaintInput = z.object({
  patientNationalId: z.string().trim().min(5).max(20),
  channel: z.enum(['IN_PERSON', 'PHONE', 'LETTER']),
  category: z.enum(COMPLAINT_CATEGORIES),
  description: z.string().trim().min(20).max(5000),
  desiredOutcome: z.string().trim().max(2000).optional().nullable(),
  receivedAt: z.coerce.date().optional(),
});

complaintsRouter.post('/', requireRole('RECEPTION', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const input = parse(StaffComplaintInput, req.body);
  const now = new Date();
  const receivedAt = input.receivedAt ?? now;
  if (receivedAt.getTime() > now.getTime() + 60_000)
    throw badRequest('The date received cannot be in the future');
  if (receivedAt.getTime() < now.getTime() - 30 * 86_400_000) {
    throw badRequest('Record a complaint within 30 days of receiving it');
  }
  const [p] = await db
    .select({
      id: patients.id,
      mergedIntoId: patients.mergedIntoId,
      primaryFacilityId: patients.primaryFacilityId,
    })
    .from(patients)
    .where(eq(patients.nationalId, input.patientNationalId));
  const facilityId = ctx.facilityId;
  // Only people registered or recently cared for here; the same answer for unknown and
  // inaccessible numbers, so the form cannot be used to look people up nationally.
  const reachable =
    p &&
    (p.primaryFacilityId === facilityId ||
      (await hadRecentCare(p.mergedIntoId ?? p.id, facilityId, now)));
  if (!p || !reachable) {
    throw badRequest('No person with this national ID number is registered or treated here');
  }
  const patientId = p.mergedIntoId ?? p.id;
  const row = await db.transaction(async (tx) => {
    const reference = await nextComplaintReference(tx, now);
    const [created] = await tx
      .insert(complaints)
      .values({
        reference,
        facilityId,
        patientId,
        channel: input.channel,
        category: input.category,
        description: input.description,
        desiredOutcome: input.desiredOutcome || null,
        ...deadlinesFor(receivedAt),
        createdAt: receivedAt,
      })
      .returning();
    await auditComplaint(
      req,
      ctx,
      created!,
      AuditAction.COMPLAINT_SUBMITTED,
      { channel: input.channel },
      tx,
    );
    await notifyUsers(
      (await directorIds(facilityId, tx)).filter((id) => id !== ctx.userId),
      {
        type: 'complaint.new',
        title: 'New complaint {reference}',
        vars: { reference },
        link: staffLink(created!.id),
      },
      tx,
    );
    return created!;
  });
  // Contact details are not echoed back; the complaint is opened from the list.
  res.status(201).json({ id: row.id, reference: row.reference, status: row.status });
});

const ListQuery = PaginationSchema.extend({
  status: z.enum(COMPLAINT_STATUSES).optional(),
  category: z.enum(COMPLAINT_CATEGORIES).optional(),
  overdue: z.enum(['true', 'false']).optional(),
  view: z.enum(['all', 'assigned', 'escalated']).optional(),
});

complaintsRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ListQuery, req.query);
  const where: SQL[] = [];
  if (ctx.role === 'MINISTRY') {
    where.push(isNotNull(complaints.escalatedAt));
  } else if (ctx.role === 'DIRECTOR' && ctx.facilityId && q.view !== 'assigned') {
    where.push(eq(complaints.facilityId, ctx.facilityId));
  } else if (staffRoles.includes(ctx.role) && ctx.facilityId) {
    where.push(eq(complaints.facilityId, ctx.facilityId), eq(complaints.assignedToId, ctx.userId));
  } else {
    throw forbidden();
  }
  if (q.status) where.push(eq(complaints.status, q.status));
  if (q.category) where.push(eq(complaints.category, q.category));
  if (q.overdue === 'true') {
    where.push(
      or(
        sql`${complaints.acknowledgedAt} IS NULL AND ${complaints.acknowledgeDueAt} < now() AND ${complaints.status} NOT IN ('CLOSED', 'ESCALATED')`,
        sql`${complaints.respondedAt} IS NULL AND ${complaints.responseDueAt} < now() AND ${complaints.status} NOT IN ('CLOSED', 'ESCALATED')`,
      )!,
    );
  }
  const filter = and(...where);
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(complaints)
    .where(filter);
  const rows = await db
    .select({ c: complaints, facilityName: facilities.name, assignedTo: users.fullName })
    .from(complaints)
    .innerJoin(facilities, eq(facilities.id, complaints.facilityId))
    .leftJoin(users, eq(users.id, complaints.assignedToId))
    .where(filter)
    .orderBy(
      ctx.role === 'MINISTRY'
        ? sql`(${complaints.ministryDecision} IS NULL) DESC, ${complaints.escalatedAt} DESC`
        : sql`(${complaints.status} IN ('CLOSED', 'ESCALATED')) ASC, ${complaints.responseDueAt} ASC`,
    )
    .limit(toOffset(q).limit)
    .offset(toOffset(q).offset);
  res.json(
    paginated(
      rows.map((r) => ({
        id: r.c.id,
        reference: r.c.reference,
        facilityName: r.facilityName,
        channel: r.c.channel,
        category: r.c.category,
        status: r.c.status,
        createdAt: r.c.createdAt,
        acknowledgeDueAt: r.c.acknowledgeDueAt,
        responseDueAt: r.c.responseDueAt,
        acknowledgedAt: r.c.acknowledgedAt,
        respondedAt: r.c.respondedAt,
        outcome: r.c.outcome,
        escalatedAt: r.c.escalatedAt,
        ministryDecided: Boolean(r.c.ministryDecision),
        assignedTo: r.assignedTo,
        ...timingOf(r.c),
      })),
      Number(total),
      q,
    ),
  );
});

complaintsRouter.get('/dashboard', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(Months, req.query);
  const facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId! : undefined;
  const since = sinceDate(q.months);
  const national = ctx.role === 'MINISTRY';
  // Nationally, small counts per facility and category are suppressed.
  const cells = (rows: { key: string; label: string | null; count: number }[]) =>
    national
      ? rows.map((r) =>
          suppressed(r.count)
            ? { ...r, count: null, suppressed: true }
            : { ...r, suppressed: false },
        )
      : rows.map((r) => ({ ...r, suppressed: false }));
  const overdue = facilityId
    ? await db
        .select()
        .from(complaints)
        .where(
          and(
            eq(complaints.facilityId, facilityId),
            inArray(complaints.status, ['RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING']),
            or(
              and(isNull(complaints.acknowledgedAt), sql`${complaints.acknowledgeDueAt} < now()`),
              and(isNull(complaints.respondedAt), sql`${complaints.responseDueAt} < now()`),
            ),
          ),
        )
        .orderBy(complaints.responseDueAt)
    : [];
  const [{ open } = { open: 0 }] = await db
    .select({ open: count() })
    .from(complaints)
    .where(
      and(
        inArray(complaints.status, ['RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESPONDED']),
        facilityId ? eq(complaints.facilityId, facilityId) : undefined,
      ),
    );
  const [{ escalatedPending } = { escalatedPending: 0 }] = await db
    .select({ escalatedPending: count() })
    .from(complaints)
    .where(
      and(
        eq(complaints.status, 'ESCALATED'),
        isNull(complaints.ministryDecision),
        facilityId ? eq(complaints.facilityId, facilityId) : undefined,
      ),
    );
  const byMonth = await complaintCounts('month', { facilityId, since });
  res.json({
    months: q.months,
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    open: Number(open),
    escalatedPending: Number(escalatedPending),
    timeliness: await complaintTimeliness({ facilityId, since }),
    byCategory: cells(await complaintCounts('category', { facilityId, since })),
    byStatus: cells(await complaintCounts('status', { facilityId, since })),
    byOutcome: cells(await complaintCounts('outcome', { facilityId, since })),
    byMonth: cells(byMonth),
    byFacility: national ? cells(await complaintCounts('facility', { since })) : [],
    overdue: overdue.map((c) => ({
      id: c.id,
      reference: c.reference,
      category: c.category,
      status: c.status,
      acknowledgeDueAt: c.acknowledgeDueAt,
      responseDueAt: c.responseDueAt,
      acknowledgedAt: c.acknowledgedAt,
      respondedAt: c.respondedAt,
      ...timingOf(c),
    })),
  });
});

complaintsRouter.get('/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const c = await loadComplaint(id);
  const access = requireAccess(ctx, c, ['director', 'assignee', 'ministry']);
  res.json({ ...(await staffView(c, access)), access });
});

const AssignInput = z.object({ userId: z.string().uuid().nullable() });

complaintsRouter.post('/:id/assign', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { userId } = parse(AssignInput, req.body);
  const c = await loadComplaint(id);
  requireAccess(ctx, c, ['director']);
  if (c.status === 'CLOSED' || c.status === 'ESCALATED') throw conflict('This complaint is closed');
  if (userId) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          eq(users.facilityId, c.facilityId),
          eq(users.isActive, true),
          inArray(users.role, [...STAFF_ROLES]),
        ),
      );
    if (!u) throw badRequest('Choose a member of staff of this facility');
  }
  await db.transaction(async (tx) => {
    await tx.update(complaints).set({ assignedToId: userId }).where(eq(complaints.id, id));
    await auditComplaint(req, ctx, c, AuditAction.COMPLAINT_UPDATED, { assignedToId: userId }, tx);
    if (userId && userId !== ctx.userId) {
      await notifyUsers(
        [userId],
        {
          type: 'complaint.assigned',
          title: 'Complaint {reference} assigned to you',
          vars: { reference: c.reference },
          link: staffLink(id),
        },
        tx,
      );
    }
  });
  res.json(await staffView(await loadComplaint(id), 'director'));
});

complaintsRouter.post('/:id/acknowledge', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const c = await loadComplaint(id);
  const access = requireAccess(ctx, c, ['director', 'assignee']);
  if (c.status !== 'RECEIVED') throw conflict('This complaint has already been acknowledged');
  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({ status: 'ACKNOWLEDGED', acknowledgedAt: new Date() })
      .where(eq(complaints.id, id));
    await auditComplaint(
      req,
      ctx,
      c,
      AuditAction.COMPLAINT_UPDATED,
      { status: 'ACKNOWLEDGED' },
      tx,
    );
    await notifyUsers(
      await complainantIds(c, tx),
      {
        type: 'complaint.acknowledged',
        title: 'Your complaint {reference} has been received and is being looked into',
        vars: { reference: c.reference },
        link: portalLink(id),
      },
      tx,
    );
  });
  res.json(await staffView(await loadComplaint(id), access));
});

complaintsRouter.post('/:id/investigate', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const c = await loadComplaint(id);
  const access = requireAccess(ctx, c, ['director', 'assignee']);
  if (c.status !== 'RECEIVED' && c.status !== 'ACKNOWLEDGED') {
    throw conflict('Only a new or acknowledged complaint can be put under investigation');
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({ status: 'INVESTIGATING', acknowledgedAt: c.acknowledgedAt ?? now })
      .where(eq(complaints.id, id));
    await auditComplaint(
      req,
      ctx,
      c,
      AuditAction.COMPLAINT_UPDATED,
      { status: 'INVESTIGATING' },
      tx,
    );
    if (!c.acknowledgedAt) {
      await notifyUsers(
        await complainantIds(c, tx),
        {
          type: 'complaint.acknowledged',
          title: 'Your complaint {reference} has been received and is being looked into',
          vars: { reference: c.reference },
          link: portalLink(id),
        },
        tx,
      );
    }
  });
  res.json(await staffView(await loadComplaint(id), access));
});

const RespondInput = z.object({
  response: z.string().trim().min(30).max(10_000),
  outcome: z.enum(RESPONSE_OUTCOMES),
});

complaintsRouter.post('/:id/respond', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(RespondInput, req.body);
  const c = await loadComplaint(id);
  const access = requireAccess(ctx, c, ['director', 'assignee']);
  if (!['RECEIVED', 'ACKNOWLEDGED', 'INVESTIGATING'].includes(c.status)) {
    throw conflict('This complaint has already been answered');
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({
        status: 'RESPONDED',
        response: input.response,
        outcome: input.outcome,
        respondedAt: now,
        respondedById: ctx.userId,
        acknowledgedAt: c.acknowledgedAt ?? now,
      })
      .where(eq(complaints.id, id));
    await auditComplaint(
      req,
      ctx,
      c,
      AuditAction.COMPLAINT_UPDATED,
      {
        status: 'RESPONDED',
        outcome: input.outcome,
      },
      tx,
    );
    await notifyUsers(
      await complainantIds(c, tx),
      {
        type: 'complaint.responded',
        title: 'A response to your complaint {reference} is ready',
        vars: { reference: c.reference },
        link: portalLink(id),
        important: true,
      },
      tx,
    );
  });
  res.json(await staffView(await loadComplaint(id), access));
});

complaintsRouter.post('/:id/close', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const c = await loadComplaint(id);
  requireAccess(ctx, c, ['director']);
  if (c.status !== 'RESPONDED') throw conflict('Only an answered complaint can be closed');
  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({ status: 'CLOSED', closedAt: new Date() })
      .where(eq(complaints.id, id));
    await auditComplaint(req, ctx, c, AuditAction.COMPLAINT_UPDATED, { status: 'CLOSED' }, tx);
  });
  res.json(await staffView(await loadComplaint(id), 'director'));
});

const DecisionInput = z.object({ decision: z.string().trim().min(30).max(10_000) });

complaintsRouter.post('/:id/decision', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { decision } = parse(DecisionInput, req.body);
  const c = await loadComplaint(id);
  requireAccess(ctx, c, ['ministry']);
  if (c.status !== 'ESCALATED' || c.ministryDecision) {
    throw conflict('The Ministry has already decided on this complaint');
  }
  await db.transaction(async (tx) => {
    await tx
      .update(complaints)
      .set({ status: 'CLOSED', ministryDecision: decision, closedAt: new Date() })
      .where(eq(complaints.id, id));
    await auditComplaint(
      req,
      ctx,
      c,
      AuditAction.COMPLAINT_UPDATED,
      { status: 'CLOSED', ministryDecision: true },
      tx,
    );
    await notifyUsers(
      await complainantIds(c, tx),
      {
        type: 'complaint.decided',
        title: 'The Ministry has decided on your complaint {reference}',
        vars: { reference: c.reference },
        link: portalLink(id),
        important: true,
      },
      tx,
    );
    await notifyUsers(
      await directorIds(c.facilityId, tx),
      {
        type: 'complaint.decided',
        title: 'The Ministry has decided on complaint {reference}',
        vars: { reference: c.reference },
        link: staffLink(id),
      },
      tx,
    );
  });
  res.json(await staffView(await loadComplaint(id), 'ministry'));
});
