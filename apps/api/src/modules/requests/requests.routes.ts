import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import { facilities, operatorRequestMessages, operatorRequests } from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import {
  adminLink,
  assertNoPatientData,
  BODY_MAX,
  facilitiesWithRequests,
  facilityLink,
  messagesOf,
  nextReference,
  notifyAdmins,
  REQUEST_CATEGORIES,
  REQUEST_STATUSES,
  requestCounts,
  requestsFrom,
  SUBJECT_MAX,
  type OperatorRequest,
  type RequestStatus,
} from './requests.service.js';

/**
 * Requests to the operator of the service (operator_requests and their messages): billing,
 * accounts, technical problems, data protection, security incidents. Never about a patient:
 * subjects and messages that contain a 10-digit number are refused. Round 2, builder G (owns the
 * whole modules/requests folder).
 *
 * `operatorRequestsRouter` is mounted on /operator-requests for the directors and IT support of a
 * facility (their own facility's requests only):
 *   GET /operator-requests, POST /operator-requests, GET /operator-requests/:id,
 *   POST /operator-requests/:id/messages
 *
 * `adminRequestsRouter` is mounted on /admin/requests (authenticated, ADMIN only): the inbox with
 * filters (status, category, facility) and counts, answers and status changes.
 *
 * Every change is audited in its transaction (operator_request.created, .message,
 * .status_changed), with ids, category, priority and statuses only – never the subject or text.
 */
export const operatorRequestsRouter = Router();
operatorRequestsRouter.use(authenticate, requireRole('DIRECTOR', 'IT_SUPPORT'));

export const adminRequestsRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const Category = z.enum(REQUEST_CATEGORIES);
const Status = z.enum(REQUEST_STATUSES);
const Subject = z.string().trim().min(3).max(SUBJECT_MAX);
const Body = z.string().trim().min(2).max(BODY_MAX);

type Audience = 'admin' | 'facility';

/** A request with its conversation, as the facility or the administrator sees it. */
async function requestDetail(id: string, audience: Audience, where?: SQL) {
  const [row] = await requestsFrom().where(and(eq(operatorRequests.id, id), where));
  if (!row) throw notFound('Request not found');
  return { ...row, messages: await messagesOf(id, audience) };
}

const STATUS_CHANGED_BY_MESSAGE = 'message';

/**
 * Moves a request to another status in the caller's transaction: resolved_at is set exactly while
 * it is resolved (a database check holds it to that). Audited; returns false when it was already
 * in that status.
 */
async function changeStatus(
  tx: Executor,
  request: OperatorRequest,
  to: RequestStatus,
  ctx: AuthContext,
  req: Request,
  cause?: string,
) {
  if (request.status === to) return false;
  const now = new Date();
  await tx
    .update(operatorRequests)
    .set({ status: to, resolvedAt: to === 'RESOLVED' ? now : null, updatedAt: now })
    .where(eq(operatorRequests.id, request.id));
  await audit(
    {
      action: AuditAction.OPERATOR_REQUEST_STATUS_CHANGED,
      actor: ctx,
      resourceType: 'operator_request',
      resourceId: request.id,
      meta: requestMeta(req),
      metadata: {
        reference: request.reference,
        from: request.status,
        to,
        ...(cause ? { cause } : {}),
      },
    },
    tx,
  );
  return true;
}

/** Adds a message to a request in the caller's transaction (audited, ids only). */
async function addMessage(
  tx: Executor,
  request: OperatorRequest,
  body: string,
  ctx: AuthContext,
  req: Request,
) {
  const [message] = await tx
    .insert(operatorRequestMessages)
    .values({ requestId: request.id, authorId: ctx.userId, body })
    .returning({ id: operatorRequestMessages.id });
  await audit(
    {
      action: AuditAction.OPERATOR_REQUEST_MESSAGE,
      actor: ctx,
      resourceType: 'operator_request',
      resourceId: request.id,
      meta: requestMeta(req),
      metadata: {
        reference: request.reference,
        messageId: message!.id,
        fromOperator: ctx.role === 'ADMIN',
      },
    },
    tx,
  );
  return message!.id;
}

async function lockRequest(tx: Executor, id: string, where?: SQL) {
  const [row] = await tx
    .select()
    .from(operatorRequests)
    .where(and(eq(operatorRequests.id, id), where))
    .for('update');
  if (!row) throw notFound('Request not found');
  return row;
}

/* ------------------------------------------------------------------ facilities --------------- */

function ownFacility(req: Request) {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  return { ctx, facilityId: ctx.facilityId };
}

const ListQuery = PaginationSchema.extend({ status: Status.optional() });

/** The facility's requests, unresolved first, the latest change first. */
operatorRequestsRouter.get('/', async (req, res) => {
  const { facilityId } = ownFacility(req);
  const q = parse(ListQuery, req.query);
  const where = and(
    eq(operatorRequests.facilityId, facilityId),
    q.status ? eq(operatorRequests.status, q.status) : undefined,
  );
  const { limit, offset } = toOffset(q);
  const items = await requestsFrom()
    .where(where)
    .orderBy(
      sql`${operatorRequests.status} = 'RESOLVED'`,
      desc(operatorRequests.updatedAt),
      desc(operatorRequests.id),
    )
    .limit(limit)
    .offset(offset);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(operatorRequests)
    .where(where);
  res.json(paginated(items, count?.n ?? 0, q));
});

const CreateInput = z.object({ category: Category, subject: Subject, body: Body });

/**
 * A new request with its first message. A security incident is of high priority and reaches every
 * administrator by e-mail at once; any other request is an important notification to them.
 */
operatorRequestsRouter.post('/', async (req, res) => {
  const { ctx, facilityId } = ownFacility(req);
  const input = parse(CreateInput, req.body);
  assertNoPatientData({ subject: input.subject, body: input.body });
  const incident = input.category === 'SECURITY_INCIDENT';
  const id = await db.transaction(async (tx) => {
    const reference = await nextReference(tx);
    const [row] = await tx
      .insert(operatorRequests)
      .values({
        reference,
        facilityId,
        requesterId: ctx.userId,
        category: input.category,
        subject: input.subject,
        priority: incident ? 'HIGH' : 'NORMAL',
      })
      .returning();
    const request = row!;
    await audit(
      {
        action: AuditAction.OPERATOR_REQUEST_CREATED,
        actor: ctx,
        resourceType: 'operator_request',
        resourceId: request.id,
        meta: requestMeta(req),
        metadata: {
          reference,
          category: request.category,
          priority: request.priority,
          facilityId,
        },
      },
      tx,
    );
    await addMessage(tx, request, input.body, ctx, req);
    const [facility] = await tx
      .select({ name: facilities.name })
      .from(facilities)
      .where(eq(facilities.id, facilityId));
    await notifyAdmins(
      tx,
      {
        title: incident
          ? 'Security incident reported by {facility} ({reference})'
          : 'New request {reference} from {facility}',
        vars: { reference, facility: facility?.name ?? '' },
        link: adminLink(request.id),
        important: true,
      },
      { emailEveryone: incident },
    );
    return request.id;
  });
  res.status(201).json(await requestDetail(id, 'facility'));
});

operatorRequestsRouter.get('/:id', async (req, res) => {
  const { facilityId } = ownFacility(req);
  const { id } = parse(IdParam, req.params);
  res.json(await requestDetail(id, 'facility', eq(operatorRequests.facilityId, facilityId)));
});

const MessageInput = z.object({ body: Body });

/**
 * The facility writes again. A request that was waiting for the facility, or resolved, is open
 * again: the operator has something to answer. The administrators are told (not important).
 */
operatorRequestsRouter.post('/:id/messages', async (req, res) => {
  const { ctx, facilityId } = ownFacility(req);
  const { id } = parse(IdParam, req.params);
  const { body } = parse(MessageInput, req.body);
  assertNoPatientData({ body });
  await db.transaction(async (tx) => {
    const request = await lockRequest(tx, id, eq(operatorRequests.facilityId, facilityId));
    await addMessage(tx, request, body, ctx, req);
    const reopened = await changeStatus(tx, request, 'OPEN', ctx, req, STATUS_CHANGED_BY_MESSAGE);
    if (!reopened) {
      await tx
        .update(operatorRequests)
        .set({ updatedAt: new Date() })
        .where(eq(operatorRequests.id, id));
    }
    const [facility] = await tx
      .select({ name: facilities.name })
      .from(facilities)
      .where(eq(facilities.id, facilityId));
    await notifyAdmins(tx, {
      title: 'New message on request {reference} from {facility}',
      vars: { reference: request.reference, facility: facility?.name ?? '' },
      link: adminLink(id),
    });
  });
  res
    .status(201)
    .json(await requestDetail(id, 'facility', eq(operatorRequests.facilityId, facilityId)));
});

/* ------------------------------------------------------------------ administrator ------------ */

const InboxQuery = PaginationSchema.extend({
  status: z.union([Status, z.literal('UNRESOLVED')]).optional(),
  category: Category.optional(),
  facilityId: z.string().uuid().optional(),
});

/**
 * Every facility's requests, unresolved and high priority first, with the counts per status over
 * all requests (the overview shows them) and the facilities that have asked something.
 */
adminRequestsRouter.get('/', async (req, res) => {
  const q = parse(InboxQuery, req.query);
  const where = and(
    q.status === 'UNRESOLVED'
      ? sql`${operatorRequests.status} <> 'RESOLVED'`
      : q.status
        ? eq(operatorRequests.status, q.status)
        : undefined,
    q.category ? eq(operatorRequests.category, q.category) : undefined,
    q.facilityId ? eq(operatorRequests.facilityId, q.facilityId) : undefined,
  );
  const { limit, offset } = toOffset(q);
  const items = await requestsFrom()
    .where(where)
    .orderBy(
      sql`${operatorRequests.status} = 'RESOLVED'`,
      sql`${operatorRequests.priority} = 'HIGH' DESC`,
      desc(operatorRequests.updatedAt),
      desc(operatorRequests.id),
    )
    .limit(limit)
    .offset(offset);
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(operatorRequests)
    .where(where);
  res.json({
    ...paginated(items, count?.n ?? 0, q),
    counts: await requestCounts(),
    facilities: await facilitiesWithRequests(),
  });
});

adminRequestsRouter.get('/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await requestDetail(id, 'admin'));
});

const AnswerInput = z.object({ body: Body, status: Status.optional() });

/**
 * The operator answers, and may set the status with it (typically "waiting for the facility" or
 * "resolved"). The first answer sets first_response_at. The requester is told (important, so it
 * reaches them by e-mail unless they turned e-mail off).
 */
adminRequestsRouter.post('/:id/messages', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(AnswerInput, req.body);
  assertNoPatientData({ body: input.body });
  await db.transaction(async (tx) => {
    const request = await lockRequest(tx, id);
    await addMessage(tx, request, input.body, ctx, req);
    const now = new Date();
    await tx
      .update(operatorRequests)
      .set({ firstResponseAt: request.firstResponseAt ?? now, updatedAt: now })
      .where(eq(operatorRequests.id, id));
    if (input.status) await changeStatus(tx, request, input.status, ctx, req);
    await notifyUsers(
      [request.requesterId],
      {
        type: 'operator_request',
        title: 'The operator answered your request {reference}',
        vars: { reference: request.reference },
        link: facilityLink(id),
        important: true,
      },
      tx,
    );
  });
  res.status(201).json(await requestDetail(id, 'admin'));
});

const StatusInput = z.object({ status: Status });

/** Changes the status without a message; the requester is told when it is resolved. */
adminRequestsRouter.post('/:id/status', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { status } = parse(StatusInput, req.body);
  await db.transaction(async (tx) => {
    const request = await lockRequest(tx, id);
    const changed = await changeStatus(tx, request, status, ctx, req);
    if (changed && status === 'RESOLVED') {
      await notifyUsers(
        [request.requesterId],
        {
          type: 'operator_request',
          title: 'Your request {reference} was resolved',
          vars: { reference: request.reference },
          link: facilityLink(id),
        },
        tx,
      );
    }
  });
  res.json(await requestDetail(id, 'admin'));
});
