import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  integrationClients,
  integrationMessages,
  integrationMessageStatusEnum,
  patients,
} from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { Hl7Error } from '../../lib/hl7.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { open } from '../../lib/secret-box.js';
import { hashToken } from '../../lib/tokens.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { fileReviewedMessage, ReviewNeeded } from '../lab/ingest.js';

/**
 * Facility directors manage their laboratory connections: register a system (the API key is shown
 * once), revoke it, watch the message log, and resolve messages held for review.
 */
export const integrationsAdminRouter = Router();
integrationsAdminRouter.use(authenticate, requireRole('DIRECTOR'));

integrationsAdminRouter.get('/clients', async (req, res) => {
  const ctx = requireAuth(req);
  const rows = await db
    .select({
      id: integrationClients.id,
      name: integrationClients.name,
      kind: integrationClients.kind,
      apiKeyPrefix: integrationClients.apiKeyPrefix,
      isActive: integrationClients.isActive,
      lastSeenAt: integrationClients.lastSeenAt,
      createdAt: integrationClients.createdAt,
    })
    .from(integrationClients)
    .where(eq(integrationClients.facilityId, ctx.facilityId!))
    .orderBy(desc(integrationClients.createdAt));
  res.json({ items: rows });
});

integrationsAdminRouter.post('/clients', async (req, res) => {
  const ctx = requireAuth(req);
  const { name } = parse(z.object({ name: z.string().trim().min(3).max(120) }), req.body);
  const apiKey = `pk_${randomBytes(32).toString('base64url')}`;
  const [row] = await db
    .insert(integrationClients)
    .values({
      name,
      facilityId: ctx.facilityId!,
      apiKeyHash: hashToken(apiKey),
      apiKeyPrefix: apiKey.slice(0, 10),
      createdById: ctx.userId,
    })
    .returning({
      id: integrationClients.id,
      name: integrationClients.name,
      apiKeyPrefix: integrationClients.apiKeyPrefix,
    });
  await audit({
    action: AuditAction.INTEGRATION_CLIENT_CREATED,
    actor: ctx,
    resourceType: 'integration_client',
    resourceId: row!.id,
    meta: requestMeta(req),
    metadata: { name },
  });
  // The key is shown exactly once; only its hash is stored.
  res.status(201).json({ ...row, apiKey });
});

integrationsAdminRouter.post('/clients/:id/revoke', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const rows = await db
    .update(integrationClients)
    .set({ isActive: false })
    .where(and(eq(integrationClients.id, id), eq(integrationClients.facilityId, ctx.facilityId!)))
    .returning({ id: integrationClients.id });
  if (!rows.length) throw notFound('Connection not found');
  await audit({
    action: AuditAction.INTEGRATION_CLIENT_REVOKED,
    actor: ctx,
    resourceType: 'integration_client',
    resourceId: id,
    meta: requestMeta(req),
  });
  res.status(204).end();
});

const MessagesQuery = PaginationSchema.extend({
  status: z.enum(integrationMessageStatusEnum.enumValues).optional(),
  clientId: z.string().uuid().optional(),
});

integrationsAdminRouter.get('/messages', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(MessagesQuery, req.query);
  const filters: SQL[] = [eq(integrationClients.facilityId, ctx.facilityId!)];
  if (q.status) filters.push(eq(integrationMessages.status, q.status));
  if (q.clientId) filters.push(eq(integrationMessages.clientId, q.clientId));
  const where = and(...filters);
  const [rows, [total], counts] = await Promise.all([
    db
      .select({
        id: integrationMessages.id,
        direction: integrationMessages.direction,
        messageType: integrationMessages.messageType,
        controlId: integrationMessages.controlId,
        status: integrationMessages.status,
        error: integrationMessages.error,
        resultCount: integrationMessages.resultCount,
        patientId: integrationMessages.patientId,
        orderId: integrationMessages.orderId,
        receivedAt: integrationMessages.receivedAt,
        reviewedAt: integrationMessages.reviewedAt,
        reviewNote: integrationMessages.reviewNote,
        clientName: integrationClients.name,
      })
      .from(integrationMessages)
      .innerJoin(integrationClients, eq(integrationClients.id, integrationMessages.clientId))
      .where(where)
      .orderBy(desc(integrationMessages.receivedAt))
      .limit(toOffset(q).limit)
      .offset(toOffset(q).offset),
    db
      .select({ total: count() })
      .from(integrationMessages)
      .innerJoin(integrationClients, eq(integrationClients.id, integrationMessages.clientId))
      .where(where),
    db
      .select({ status: integrationMessages.status, n: count() })
      .from(integrationMessages)
      .innerJoin(integrationClients, eq(integrationClients.id, integrationMessages.clientId))
      .where(eq(integrationClients.facilityId, ctx.facilityId!))
      .groupBy(integrationMessages.status),
  ]);
  res.json({
    ...paginated(rows, total?.total ?? 0, q),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
  });
});

/**
 * A message held for review. Shows the identifiers needed to decide (not the whole message): the
 * patient identifiers it carries and the order number, plus candidate patients at this facility.
 */
integrationsAdminRouter.get('/messages/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const [row] = await db
    .select({ message: integrationMessages, facilityId: integrationClients.facilityId })
    .from(integrationMessages)
    .innerJoin(integrationClients, eq(integrationClients.id, integrationMessages.clientId))
    .where(and(eq(integrationMessages.id, id), eq(integrationClients.facilityId, ctx.facilityId!)));
  if (!row) throw notFound('Message not found');
  const raw = row.message.rawSealed ? open(row.message.rawSealed) : '';
  const pid =
    raw
      .split(/\r\n|\r|\n/)
      .find((l) => l.startsWith('PID|'))
      ?.split('|') ?? [];
  const obr =
    raw
      .split(/\r\n|\r|\n/)
      .find((l) => l.startsWith('OBR|'))
      ?.split('|') ?? [];
  const nationalId = (pid[3] ?? '').split('~')[0]?.split('^')[0] ?? '';
  const candidates = nationalId
    ? await db
        .select({
          id: patients.id,
          firstName: patients.firstName,
          lastName: patients.lastName,
          dateOfBirth: patients.dateOfBirth,
          nationalId: patients.nationalId,
        })
        .from(patients)
        .where(
          and(eq(patients.nationalId, nationalId), eq(patients.primaryFacilityId, ctx.facilityId!)),
        )
    : [];
  const { rawSealed: _r, ...message } = row.message;
  res.json({
    ...message,
    identifiers: {
      nationalId,
      name: (pid[5] ?? '').replace('^', ', '),
      dateOfBirth: pid[7] ?? '',
      placerOrderNumber: (obr[2] ?? '').split('^')[0],
    },
    candidates,
  });
});

const ReviewSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('FILE'),
    patientId: z.string().uuid(),
    note: z.string().trim().min(5).max(500),
  }),
  z.object({ action: z.literal('IGNORE'), note: z.string().trim().min(5).max(500) }),
]);

integrationsAdminRouter.post('/messages/:id/review', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const input = parse(ReviewSchema, req.body);
  const [row] = await db
    .select({ message: integrationMessages, client: integrationClients })
    .from(integrationMessages)
    .innerJoin(integrationClients, eq(integrationClients.id, integrationMessages.clientId))
    .where(and(eq(integrationMessages.id, id), eq(integrationClients.facilityId, ctx.facilityId!)));
  if (!row) throw notFound('Message not found');
  if (row.message.status !== 'NEEDS_REVIEW')
    throw conflict('This message is not waiting for review');

  let patientId: string | null = null;
  if (input.action === 'FILE') {
    try {
      const filed = await fileReviewedMessage(
        { id: row.client.id, name: row.client.name, facilityId: row.client.facilityId },
        open(row.message.rawSealed!),
        id,
        input.patientId,
      );
      patientId = filed.order.patientId;
    } catch (err) {
      if (err instanceof Hl7Error || err instanceof ReviewNeeded)
        throw badRequest((err as Error).message);
      throw err;
    }
  }
  await db
    .update(integrationMessages)
    .set({
      status: input.action === 'FILE' ? 'RESOLVED' : 'IGNORED',
      reviewedById: ctx.userId,
      reviewedAt: new Date(),
      reviewNote: input.note,
    })
    .where(eq(integrationMessages.id, id));
  await audit({
    action: AuditAction.LAB_MESSAGE_REVIEWED,
    actor: ctx,
    resourceType: 'integration_message',
    resourceId: id,
    patientId,
    meta: requestMeta(req),
    metadata: { action: input.action },
  });
  res.status(204).end();
});
