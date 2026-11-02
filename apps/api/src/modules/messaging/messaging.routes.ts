import { Router } from 'express';
import { aliasedTable, and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { messages, messageThreads, patients, users } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { hasActiveCareAssignment } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient, notifyUsers } from '../notifications/notifications.service.js';

/**
 * Non-urgent secure messaging between a patient and a doctor in their care team. Both sides must
 * still have an active care relationship to send. Messages are part of the communication record
 * and cannot be edited or deleted.
 */
const Body = z.string().trim().min(1).max(5000);
const CreateThread = z.object({
  doctorId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  subject: z.string().trim().min(2).max(200),
  body: Body,
});
const IdParam = z.object({ id: z.string().uuid() });

const doctor = aliasedTable(users, 'doctor');

async function loadThread(ctx: AuthContext, id: string) {
  const [thread] = await db.select().from(messageThreads).where(eq(messageThreads.id, id));
  if (!thread) throw notFound('Conversation not found');
  const isParticipant =
    (ctx.role === 'PATIENT' && thread.patientId === ctx.patientId) ||
    ((ctx.role === 'DOCTOR' || ctx.role === 'NURSE') && thread.doctorId === ctx.userId);
  if (!isParticipant) throw notFound('Conversation not found');
  return thread;
}

async function assertCanMessage(doctorId: string, patientId: string) {
  if (!(await hasActiveCareAssignment(doctorId, patientId))) {
    throw forbidden('Messages can only be exchanged within an active care relationship');
  }
}

async function notifyRecipient(
  ctx: AuthContext,
  thread: { id: string; patientId: string; doctorId: string },
) {
  if (ctx.role === 'PATIENT') {
    await notifyUsers([thread.doctorId], {
      type: 'message',
      title: 'New message from a patient',
      link: `/messages?thread=${thread.id}`,
    });
  } else {
    await notifyPatient(thread.patientId, {
      type: 'message',
      title: 'New message from your care team',
      link: `/portal/messages?thread=${thread.id}`,
    });
  }
}

export const messagingRouter = Router();
// Patients message the clinicians of their care team (doctors or nurses).
messagingRouter.use(authenticate, requireRole('PATIENT', 'DOCTOR', 'NURSE'));

messagingRouter.get('/threads', async (req, res) => {
  const ctx = requireAuth(req);
  const where =
    ctx.role === 'PATIENT'
      ? eq(messageThreads.patientId, ctx.patientId ?? '00000000-0000-0000-0000-000000000000')
      : eq(messageThreads.doctorId, ctx.userId);
  const rows = await db
    .select({
      id: messageThreads.id,
      subject: messageThreads.subject,
      status: messageThreads.status,
      lastMessageAt: messageThreads.lastMessageAt,
      createdAt: messageThreads.createdAt,
      patientId: messageThreads.patientId,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      doctorId: messageThreads.doctorId,
      doctorName: doctor.fullName,
      doctorSpecialty: doctor.specialty,
      unreadCount: sql<number>`(SELECT count(*)::int FROM ${messages} m
        WHERE m.thread_id = ${messageThreads.id} AND m.read_at IS NULL AND m.sender_id <> ${ctx.userId})`,
    })
    .from(messageThreads)
    .innerJoin(patients, eq(patients.id, messageThreads.patientId))
    .innerJoin(doctor, eq(doctor.id, messageThreads.doctorId))
    .where(where)
    .orderBy(desc(messageThreads.lastMessageAt))
    .limit(200);
  res.json({ items: rows });
});

messagingRouter.post('/threads', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(CreateThread, req.body);
  let patientId: string;
  let doctorId: string;
  if (ctx.role === 'PATIENT') {
    if (!ctx.patientId) throw forbidden('No patient record is linked to this account');
    if (!input.doctorId) throw badRequest('doctorId is required');
    patientId = ctx.patientId;
    doctorId = input.doctorId;
  } else {
    if (!input.patientId) throw badRequest('patientId is required');
    patientId = input.patientId;
    doctorId = ctx.userId;
  }
  await assertCanMessage(doctorId, patientId);

  const thread = await db.transaction(async (tx) => {
    const [t] = await tx
      .insert(messageThreads)
      .values({ patientId, doctorId, subject: input.subject })
      .returning();
    await tx.insert(messages).values({ threadId: t!.id, senderId: ctx.userId, body: input.body });
    await audit(
      {
        action: AuditAction.MESSAGE_SENT,
        actor: ctx,
        resourceType: 'message_thread',
        resourceId: t!.id,
        patientId,
        meta: requestMeta(req),
      },
      tx,
    );
    return t!;
  });
  await notifyRecipient(ctx, thread);
  res.status(201).json(thread);
});

messagingRouter.get('/threads/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const thread = await loadThread(ctx, id);
  // Opening a conversation marks the other side's messages as read.
  await db
    .update(messages)
    .set({ readAt: new Date() })
    .where(
      and(eq(messages.threadId, id), isNull(messages.readAt), ne(messages.senderId, ctx.userId)),
    );
  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      createdAt: messages.createdAt,
      readAt: messages.readAt,
      senderId: messages.senderId,
      senderName: users.fullName,
      senderRole: users.role,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.senderId))
    .where(eq(messages.threadId, id))
    .orderBy(messages.createdAt);
  const [names] = await db
    .select({
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      doctorName: doctor.fullName,
    })
    .from(patients)
    .innerJoin(doctor, eq(doctor.id, thread.doctorId))
    .where(eq(patients.id, thread.patientId));
  const canReply =
    thread.status === 'OPEN' && (await hasActiveCareAssignment(thread.doctorId, thread.patientId));
  res.json({ ...thread, ...names, canReply, messages: rows });
});

messagingRouter.post('/threads/:id/messages', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const body = parse(z.object({ body: Body }), req.body).body;
  const thread = await loadThread(ctx, id);
  if (thread.status !== 'OPEN') throw conflict('This conversation is closed');
  await assertCanMessage(thread.doctorId, thread.patientId);
  const message = await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(messages)
      .values({ threadId: id, senderId: ctx.userId, body })
      .returning();
    await tx
      .update(messageThreads)
      .set({ lastMessageAt: new Date() })
      .where(eq(messageThreads.id, id));
    await audit(
      {
        action: AuditAction.MESSAGE_SENT,
        actor: ctx,
        resourceType: 'message_thread',
        resourceId: id,
        patientId: thread.patientId,
        meta: requestMeta(req),
      },
      tx,
    );
    return m!;
  });
  await notifyRecipient(ctx, thread);
  res.status(201).json(message);
});

messagingRouter.post('/threads/:id/close', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  await loadThread(ctx, id);
  await db.update(messageThreads).set({ status: 'CLOSED' }).where(eq(messageThreads.id, id));
  res.status(204).end();
});
