import { Router } from 'express';
import { and, eq, exists, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { careAssignments, careTasks, patients, taskStatusEnum, users } from '../../db/schema.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/**
 * Care tasks across the clinician's patients. A task is visible to the person it is assigned to,
 * or – when assigned to a role – to care-team members with that role. Completion is explicit and
 * attributed; tasks are never closed implicitly.
 */
const ListQuery = z.object({
  scope: z.enum(['mine', 'team']).default('mine'),
  status: z.enum(taskStatusEnum.enumValues).default('OPEN'),
});
const IdParam = z.object({ id: z.string().uuid() });
const CompleteSchema = z.object({ note: z.string().trim().max(2000).optional().nullable() });
const CancelSchema = z.object({ note: z.string().trim().min(3).max(2000) });

const inMyCareTeam = (ctx: AuthContext) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(careAssignments)
      .where(
        and(
          eq(careAssignments.patientId, careTasks.patientId),
          eq(careAssignments.doctorId, ctx.userId),
          isNull(careAssignments.endedAt),
        ),
      ),
  );

function mine(ctx: AuthContext): SQL {
  return or(
    eq(careTasks.assignedToId, ctx.userId),
    and(isNull(careTasks.assignedToId), eq(careTasks.assignedRole, ctx.role), inMyCareTeam(ctx)),
  )!;
}

async function loadTask(ctx: AuthContext, id: string) {
  const [task] = await db
    .select()
    .from(careTasks)
    .where(and(eq(careTasks.id, id), eq(careTasks.facilityId, ctx.facilityId!), inMyCareTeam(ctx)));
  if (!task) throw notFound('Task not found');
  return task;
}

export const careTasksRouter = Router();
careTasksRouter.use(authenticate, requireRole('DOCTOR', 'NURSE'));

careTasksRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ListQuery, req.query);
  const rows = await db
    .select({
      id: careTasks.id,
      patientId: careTasks.patientId,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      title: careTasks.title,
      details: careTasks.details,
      priority: careTasks.priority,
      status: careTasks.status,
      dueAt: careTasks.dueAt,
      assignedRole: careTasks.assignedRole,
      assignedToId: careTasks.assignedToId,
      assignedToName: sql<
        string | null
      >`(SELECT u.full_name FROM users u WHERE u.id = ${careTasks.assignedToId})`,
      createdById: careTasks.createdById,
      createdByName: users.fullName,
      createdAt: careTasks.createdAt,
      completedAt: careTasks.completedAt,
      overdue: sql<boolean>`${careTasks.status} = 'OPEN' AND ${careTasks.dueAt} < now()`,
    })
    .from(careTasks)
    .innerJoin(patients, eq(patients.id, careTasks.patientId))
    .innerJoin(users, eq(users.id, careTasks.createdById))
    .where(
      and(
        eq(careTasks.facilityId, ctx.facilityId!),
        eq(careTasks.status, q.status),
        q.scope === 'mine' ? mine(ctx) : inMyCareTeam(ctx),
      ),
    )
    .orderBy(
      sql`CASE ${careTasks.priority} WHEN 'URGENT' THEN 0 ELSE 1 END`,
      sql`${careTasks.dueAt} ASC NULLS LAST`,
    )
    .limit(300);
  res.json({ items: rows });
});

careTasksRouter.post('/:id/complete', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { note } = parse(CompleteSchema, req.body ?? {});
  const task = await loadTask(ctx, id);
  if (task.status !== 'OPEN') throw conflict('Task is not open');
  const canComplete =
    task.assignedToId === ctx.userId ||
    (!task.assignedToId && task.assignedRole === ctx.role) ||
    ctx.role === 'DOCTOR';
  if (!canComplete) throw forbidden('This task is assigned to someone else');
  await db.transaction(async (tx) => {
    await tx
      .update(careTasks)
      .set({
        status: 'DONE',
        completedById: ctx.userId,
        completedAt: new Date(),
        completionNote: note ?? null,
      })
      .where(and(eq(careTasks.id, id), eq(careTasks.status, 'OPEN')));
    await audit(
      {
        action: AuditAction.CARE_TASK_UPDATED,
        actor: ctx,
        resourceType: 'care_task',
        resourceId: id,
        patientId: task.patientId,
        meta: requestMeta(req),
        metadata: { status: 'DONE' },
      },
      tx,
    );
    if (task.createdById !== ctx.userId) {
      await notifyUsers(
        [task.createdById],
        { type: 'task', title: 'A care task you created was completed', link: '/tasks' },
        tx,
      );
    }
  });
  res.status(204).end();
});

careTasksRouter.post('/:id/cancel', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { note } = parse(CancelSchema, req.body);
  const task = await loadTask(ctx, id);
  if (task.status !== 'OPEN') throw conflict('Task is not open');
  if (task.createdById !== ctx.userId && ctx.role !== 'DOCTOR') {
    throw forbidden('Only the creator or a doctor can cancel a task');
  }
  await db.transaction(async (tx) => {
    await tx
      .update(careTasks)
      .set({
        status: 'CANCELLED',
        completedById: ctx.userId,
        completedAt: new Date(),
        completionNote: note,
      })
      .where(eq(careTasks.id, id));
    await audit(
      {
        action: AuditAction.CARE_TASK_UPDATED,
        actor: ctx,
        resourceType: 'care_task',
        resourceId: id,
        patientId: task.patientId,
        meta: requestMeta(req),
        metadata: { status: 'CANCELLED' },
      },
      tx,
    );
  });
  res.status(204).end();
});
