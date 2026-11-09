import { Router } from 'express';
import { aliasedTable, and, asc, count, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { facilities, STAFF_ROLES, supportTickets, users } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { revokeAllSessions } from '../auth/auth.service.js';
import { requestPasswordReset } from '../auth/mfa.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import {
  accountView,
  directorsOf,
  itStaffOf,
  NEEDS_APPROVAL,
  newReference,
  OPEN_TICKET_STATUSES,
  resetSecondFactors,
  staffAccountOf,
  TICKET_KINDS,
  TICKET_STATUSES,
  type Ticket,
} from './support.service.js';

/** IT support: account and access requests of a facility's staff (no clinical access). */
export const supportRouter = Router();
supportRouter.use(authenticate);
supportRouter.use(requireRole(...STAFF_ROLES));

const IdParam = z.object({ id: z.string().uuid() });
const requester = aliasedTable(users, 'requester');
const subject = aliasedTable(users, 'subject');
const assignee = aliasedTable(users, 'assignee');
const approver = aliasedTable(users, 'approver');

/** Who sees which tickets: IT support and directors the facility's; others their own. */
function visibleTo(ctx: AuthContext) {
  if (ctx.role === 'IT_SUPPORT' || ctx.role === 'DIRECTOR') {
    return eq(supportTickets.facilityId, ctx.facilityId!);
  }
  return or(
    eq(supportTickets.requesterId, ctx.userId),
    eq(supportTickets.subjectUserId, ctx.userId),
  );
}

function facilityOf(ctx: AuthContext) {
  if (!ctx.facilityId) throw forbidden('IT support requests are handled by your facility');
  return ctx.facilityId;
}

const ticketColumns = {
  ticket: supportTickets,
  requesterName: requester.fullName,
  assigneeName: assignee.fullName,
  approverName: approver.fullName,
  subject: subject,
};

async function loadVisible(ctx: AuthContext, id: string) {
  const [row] = await db
    .select(ticketColumns)
    .from(supportTickets)
    .leftJoin(requester, eq(requester.id, supportTickets.requesterId))
    .leftJoin(assignee, eq(assignee.id, supportTickets.assignedToId))
    .leftJoin(approver, eq(approver.id, supportTickets.approvedById))
    .leftJoin(subject, eq(subject.id, supportTickets.subjectUserId))
    .where(and(eq(supportTickets.id, id), visibleTo(ctx)));
  if (!row) throw notFound('Request not found');
  return row;
}

type Row = Awaited<ReturnType<typeof loadVisible>>;

function present(ctx: AuthContext, r: Row) {
  const desk = ctx.role === 'IT_SUPPORT' || ctx.role === 'DIRECTOR';
  return {
    id: r.ticket.id,
    reference: r.ticket.reference,
    kind: r.ticket.kind,
    status: r.ticket.status,
    description: r.ticket.description,
    resolution: r.ticket.resolution,
    createdAt: r.ticket.createdAt,
    updatedAt: r.ticket.updatedAt,
    resolvedAt: r.ticket.resolvedAt,
    approvedAt: r.ticket.approvedAt,
    requesterName: r.requesterName,
    assigneeName: r.assigneeName,
    approverName: r.approverName,
    assignedToMe: r.ticket.assignedToId === ctx.userId,
    needsApproval: NEEDS_APPROVAL.includes(r.ticket.kind as (typeof NEEDS_APPROVAL)[number]),
    // The account in question: full account state for the desk, the name for everyone else.
    subject: r.subject
      ? desk
        ? accountView(r.subject)
        : { id: r.subject.id, fullName: r.subject.fullName, role: r.subject.role }
      : null,
  };
}

async function changed(
  ctx: AuthContext,
  req: Parameters<typeof requestMeta>[0],
  ticket: Ticket,
  change: string,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
) {
  await audit(
    {
      action: AuditAction.SUPPORT_TICKET_CHANGED,
      actor: ctx,
      resourceType: 'support_ticket',
      resourceId: ticket.id,
      meta: requestMeta(req),
      metadata: { change, kind: ticket.kind, reference: ticket.reference },
    },
    tx,
  );
}

/* --------------------------------------------------------------------------- list / read -- */

const ListQuery = PaginationSchema.extend({
  status: z.enum(['open', 'closed', 'approval', 'all']).default('open'),
  mine: z.coerce.boolean().optional(),
});

supportRouter.get('/tickets', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ListQuery, req.query);
  if ((ctx.role === 'IT_SUPPORT' || ctx.role === 'DIRECTOR') && !ctx.facilityId) throw forbidden();
  const statusFilter =
    q.status === 'open'
      ? inArray(supportTickets.status, OPEN_TICKET_STATUSES)
      : q.status === 'closed'
        ? inArray(supportTickets.status, ['RESOLVED', 'REJECTED'])
        : q.status === 'approval'
          ? eq(supportTickets.status, 'AWAITING_APPROVAL')
          : undefined;
  const where = and(
    visibleTo(ctx),
    statusFilter,
    q.mine ? eq(supportTickets.requesterId, ctx.userId) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    db
      .select(ticketColumns)
      .from(supportTickets)
      .leftJoin(requester, eq(requester.id, supportTickets.requesterId))
      .leftJoin(assignee, eq(assignee.id, supportTickets.assignedToId))
      .leftJoin(approver, eq(approver.id, supportTickets.approvedById))
      .leftJoin(subject, eq(subject.id, supportTickets.subjectUserId))
      .where(where)
      .orderBy(
        sql`CASE ${supportTickets.status} WHEN 'AWAITING_APPROVAL' THEN 0 WHEN 'OPEN' THEN 1 WHEN 'IN_PROGRESS' THEN 2 ELSE 3 END`,
        desc(supportTickets.createdAt),
      )
      .limit(toOffset(q).limit)
      .offset(toOffset(q).offset),
    db.select({ n: count() }).from(supportTickets).where(where),
  ]);
  res.json(
    paginated(
      rows.map((r) => present(ctx, r)),
      total?.n ?? 0,
      q,
    ),
  );
});

supportRouter.get('/tickets/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  res.json(present(ctx, await loadVisible(ctx, id)));
});

/** Colleagues a request can be about (names and roles only). */
supportRouter.get('/colleagues', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const rows = await db
    .select({ id: users.id, fullName: users.fullName, role: users.role })
    .from(users)
    .where(and(eq(users.facilityId, facilityId), inArray(users.role, [...STAFF_ROLES])))
    .orderBy(asc(users.fullName));
  res.json({ items: rows });
});

/** What the web app offers the caller. */
supportRouter.get('/me', async (req, res) => {
  const ctx = requireAuth(req);
  res.json({
    desk: ctx.role === 'IT_SUPPORT',
    approves: ctx.role === 'DIRECTOR',
    national: ctx.role === 'MINISTRY',
    canRequest: Boolean(ctx.facilityId),
  });
});

/* ------------------------------------------------------------------------------ create -- */

const CreateInput = z.object({
  kind: z.enum(TICKET_KINDS),
  description: z.string().trim().min(5).max(2000),
  /** The colleague the request is about (default: the requester). */
  subjectUserId: z.string().uuid().optional().nullable(),
});

supportRouter.post('/tickets', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const input = parse(CreateInput, req.body);
  const subjectId = input.subjectUserId ?? ctx.userId;
  if (!(await staffAccountOf(subjectId, facilityId))) {
    throw badRequest('The request can only be about staff of your facility');
  }
  const ticket = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(supportTickets)
      .values({
        reference: newReference(),
        facilityId,
        requesterId: ctx.userId,
        subjectUserId: subjectId,
        kind: input.kind,
        description: input.description,
      })
      .returning();
    await changed(ctx, req, row!, 'CREATED', tx);
    await notifyUsers(
      (await itStaffOf(facilityId, tx)).filter((id) => id !== ctx.userId),
      {
        type: 'support',
        title: 'New IT support request {reference}',
        vars: { reference: row!.reference },
        link: `/support?ticket=${row!.id}`,
      },
      tx,
    );
    return row!;
  });
  res.status(201).json(present(ctx, await loadVisible(ctx, ticket.id)));
});

/* ---------------------------------------------------------------------- desk actions -- */

/** Loads a ticket of the IT support user's facility that is still open. */
async function deskTicket(ctx: AuthContext, id: string) {
  if (ctx.role !== 'IT_SUPPORT') throw forbidden('Only IT support can do this');
  const row = await loadVisible(ctx, id);
  if (!OPEN_TICKET_STATUSES.includes(row.ticket.status as (typeof OPEN_TICKET_STATUSES)[number])) {
    throw conflict('This request is already closed');
  }
  return row;
}

async function notifyRequester(
  ticket: Ticket,
  title: string,
  tx: Parameters<typeof notifyUsers>[2],
) {
  await notifyUsers(
    [ticket.requesterId],
    {
      type: 'support',
      title,
      vars: { reference: ticket.reference },
      link: `/support?ticket=${ticket.id}`,
    },
    tx,
  );
}

supportRouter.post('/tickets/:id/assign', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const row = await deskTicket(ctx, id);
  await db.transaction(async (tx) => {
    const [t] = await tx
      .update(supportTickets)
      .set({
        assignedToId: ctx.userId,
        status: row.ticket.status === 'OPEN' ? 'IN_PROGRESS' : row.ticket.status,
      })
      .where(eq(supportTickets.id, id))
      .returning();
    await changed(ctx, req, t!, 'ASSIGNED', tx);
  });
  res.json(present(ctx, await loadVisible(ctx, id)));
});

/** Asks the facility's directors to approve an MFA reset or access change. */
supportRouter.post('/tickets/:id/request-approval', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const row = await deskTicket(ctx, id);
  if (!NEEDS_APPROVAL.includes(row.ticket.kind as (typeof NEEDS_APPROVAL)[number])) {
    throw badRequest('This kind of request does not need a director’s approval');
  }
  if (row.ticket.approvedAt) throw conflict('This request is already approved');
  await db.transaction(async (tx) => {
    const [t] = await tx
      .update(supportTickets)
      .set({ status: 'AWAITING_APPROVAL', assignedToId: row.ticket.assignedToId ?? ctx.userId })
      .where(eq(supportTickets.id, id))
      .returning();
    await changed(ctx, req, t!, 'APPROVAL_REQUESTED', tx);
    await notifyUsers(
      await directorsOf(t!.facilityId!, tx),
      {
        type: 'support',
        title: 'An IT support request needs your approval ({reference})',
        vars: { reference: t!.reference },
        link: `/support?ticket=${t!.id}`,
        important: true,
      },
      tx,
    );
  });
  res.json(present(ctx, await loadVisible(ctx, id)));
});

const DecisionInput = z.object({ note: z.string().trim().max(500).optional().nullable() });

/** The director approves (IT support may then act) or rejects (the request is closed). */
for (const decision of ['approve', 'reject-approval'] as const) {
  supportRouter.post(`/tickets/:id/${decision}`, async (req, res) => {
    const ctx = requireAuth(req);
    if (ctx.role !== 'DIRECTOR') throw forbidden('Only a director of the facility can decide');
    const { id } = parse(IdParam, req.params);
    const input = parse(DecisionInput, req.body ?? {});
    const row = await loadVisible(ctx, id);
    if (row.ticket.status !== 'AWAITING_APPROVAL')
      throw conflict('This request is not waiting for approval');
    // Four eyes: nobody approves a change to their own account.
    if (row.ticket.subjectUserId === ctx.userId) {
      throw forbidden('Another director must approve a change to your own account');
    }
    if (decision === 'reject-approval' && !input.note) throw badRequest('Give a reason');
    await db.transaction(async (tx) => {
      const [t] = await tx
        .update(supportTickets)
        .set(
          decision === 'approve'
            ? { status: 'IN_PROGRESS', approvedById: ctx.userId, approvedAt: new Date() }
            : {
                status: 'REJECTED',
                resolution: input.note!,
                resolvedAt: new Date(),
              },
        )
        .where(eq(supportTickets.id, id))
        .returning();
      await changed(ctx, req, t!, decision === 'approve' ? 'APPROVED' : 'APPROVAL_REJECTED', tx);
      if (decision === 'approve') {
        await notifyUsers(
          [t!.assignedToId],
          {
            type: 'support',
            title: 'IT support request {reference} was approved',
            vars: { reference: t!.reference },
            link: `/support?ticket=${t!.id}`,
          },
          tx,
        );
      } else {
        await notifyRequester(t!, 'Your IT support request {reference} was declined', tx);
      }
    });
    res.json(present(ctx, await loadVisible(ctx, id)));
  });
}

/** An account action by IT support on the ticket's account (audited on the account). */
async function accountAction(
  req: Parameters<typeof requestMeta>[0],
  action: 'UNLOCK' | 'PASSWORD_RESET_LINK' | 'MFA_RESET',
) {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const row = await deskTicket(ctx, id);
  if (!row.ticket.subjectUserId) throw badRequest('This request is not about an account');
  const account = await staffAccountOf(row.ticket.subjectUserId, ctx.facilityId!);
  if (!account) throw notFound('Account not found');
  if (account.role === 'MINISTRY') throw forbidden();
  if (account.id === ctx.userId) throw forbidden('Ask a colleague to act on your own account');
  if (action === 'MFA_RESET') {
    if (row.ticket.kind !== 'MFA_RESET') throw badRequest('Open a two-step sign-in reset request');
    if (!row.ticket.approvedAt) throw forbidden('A director must approve this first');
  }
  await db.transaction(async (tx) => {
    if (action === 'UNLOCK') {
      await tx
        .update(users)
        .set({ lockedUntil: null, failedLoginAttempts: 0 })
        .where(eq(users.id, account.id));
    } else if (action === 'MFA_RESET') {
      await resetSecondFactors(tx, account.id);
    }
    await audit(
      {
        action: AuditAction.SUPPORT_ACCOUNT_ACTION,
        actor: ctx,
        resourceType: 'user',
        resourceId: account.id,
        meta: requestMeta(req),
        metadata: {
          action,
          ticketId: row.ticket.id,
          reference: row.ticket.reference,
          approvedById: row.ticket.approvedById,
        },
      },
      tx,
    );
    await tx
      .update(supportTickets)
      .set({ assignedToId: row.ticket.assignedToId ?? ctx.userId, status: 'IN_PROGRESS' })
      .where(eq(supportTickets.id, row.ticket.id));
  });
  if (action === 'PASSWORD_RESET_LINK') {
    // The usual reset e-mail goes to the account's own address (IT support never sees the link).
    await requestPasswordReset(account.email, requestMeta(req));
  }
  if (action === 'MFA_RESET') await revokeAllSessions(account.id);
  return { ctx, id };
}

supportRouter.post('/tickets/:id/unlock', async (req, res) => {
  const { ctx, id } = await accountAction(req, 'UNLOCK');
  res.json(present(ctx, await loadVisible(ctx, id)));
});
supportRouter.post('/tickets/:id/password-reset', async (req, res) => {
  const { ctx, id } = await accountAction(req, 'PASSWORD_RESET_LINK');
  res.json(present(ctx, await loadVisible(ctx, id)));
});
supportRouter.post('/tickets/:id/mfa-reset', async (req, res) => {
  const { ctx, id } = await accountAction(req, 'MFA_RESET');
  res.json(present(ctx, await loadVisible(ctx, id)));
});

const CloseInput = z.object({ resolution: z.string().trim().min(3).max(2000) });

for (const outcome of ['resolve', 'reject'] as const) {
  supportRouter.post(`/tickets/:id/${outcome}`, async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const input = parse(CloseInput, req.body);
    const row = await deskTicket(ctx, id);
    if (outcome === 'resolve' && row.ticket.status === 'AWAITING_APPROVAL') {
      throw conflict('This request is waiting for a director’s approval');
    }
    await db.transaction(async (tx) => {
      const [t] = await tx
        .update(supportTickets)
        .set({
          status: outcome === 'resolve' ? 'RESOLVED' : 'REJECTED',
          resolution: input.resolution,
          resolvedAt: new Date(),
          assignedToId: row.ticket.assignedToId ?? ctx.userId,
        })
        .where(eq(supportTickets.id, id))
        .returning();
      await changed(ctx, req, t!, outcome === 'resolve' ? 'RESOLVED' : 'REJECTED', tx);
      await notifyRequester(
        t!,
        outcome === 'resolve'
          ? 'Your IT support request {reference} was resolved'
          : 'Your IT support request {reference} was closed without a change',
        tx,
      );
    });
    res.json(present(ctx, await loadVisible(ctx, id)));
  });
}

/* ------------------------------------------------------------------------ statistics -- */

/** Counts per facility for the Ministry (no content), or for the director's own facility. */
supportRouter.get('/stats', requireRole('MINISTRY', 'DIRECTOR', 'IT_SUPPORT'), async (req, res) => {
  const ctx = requireAuth(req);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const scope =
    ctx.role === 'MINISTRY' ? undefined : eq(supportTickets.facilityId, ctx.facilityId!);
  const rows = await db
    .select({
      facilityId: supportTickets.facilityId,
      facilityName: facilities.name,
      open: sql<number>`count(*) FILTER (WHERE ${supportTickets.status} IN ('OPEN', 'IN_PROGRESS'))::int`,
      awaitingApproval: sql<number>`count(*) FILTER (WHERE ${supportTickets.status} = 'AWAITING_APPROVAL')::int`,
      resolved30d: sql<number>`count(*) FILTER (WHERE ${supportTickets.status} = 'RESOLVED' AND ${supportTickets.resolvedAt} >= ${since})::int`,
      medianHours: sql<
        number | null
      >`percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ${supportTickets.resolvedAt} - ${supportTickets.createdAt}) / 3600) FILTER (WHERE ${supportTickets.resolvedAt} >= ${since})`,
    })
    .from(supportTickets)
    .innerJoin(facilities, eq(facilities.id, supportTickets.facilityId))
    .where(and(scope, isNotNull(supportTickets.facilityId)))
    .groupBy(supportTickets.facilityId, facilities.name)
    .orderBy(asc(facilities.name));
  const byKind = await db
    .select({ kind: supportTickets.kind, n: count() })
    .from(supportTickets)
    .where(and(scope, sql`${supportTickets.createdAt} >= ${since}`))
    .groupBy(supportTickets.kind);
  res.json({
    facilities: rows.map((r) => ({
      ...r,
      medianHours: r.medianHours === null ? null : Math.round(Number(r.medianHours) * 10) / 10,
    })),
    byKind: TICKET_KINDS.map((k) => ({ kind: k, count: byKind.find((b) => b.kind === k)?.n ?? 0 })),
    statuses: TICKET_STATUSES,
  });
});
