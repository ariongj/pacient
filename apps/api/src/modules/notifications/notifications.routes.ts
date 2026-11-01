import { Router } from 'express';
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { notifications } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { parse, requireAuth } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';

const ListQuery = PaginationSchema.extend({ unreadOnly: z.enum(['true', 'false']).optional() });
const IdParam = z.object({ id: z.string().uuid() });

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ListQuery, req.query);
  const where = and(
    eq(notifications.userId, ctx.userId),
    q.unreadOnly === 'true' ? isNull(notifications.readAt) : undefined,
  );
  const [rows, [total], [unread]] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.createdAt))
      .limit(toOffset(q).limit)
      .offset(toOffset(q).offset),
    db.select({ total: count() }).from(notifications).where(where),
    db
      .select({ total: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, ctx.userId), isNull(notifications.readAt))),
  ]);
  res.json({ ...paginated(rows, total?.total ?? 0, q), unreadCount: unread?.total ?? 0 });
});

notificationsRouter.get('/unread-count', async (req, res) => {
  const ctx = requireAuth(req);
  const [row] = await db
    .select({ total: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, ctx.userId), isNull(notifications.readAt)));
  res.json({ unreadCount: row?.total ?? 0 });
});

notificationsRouter.post('/read-all', async (req, res) => {
  const ctx = requireAuth(req);
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, ctx.userId), isNull(notifications.readAt)));
  res.status(204).end();
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const rows = await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, ctx.userId)))
    .returning({ id: notifications.id });
  if (!rows.length) throw notFound('Notification not found');
  res.status(204).end();
});
