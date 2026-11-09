import { Router } from 'express';
import { and, arrayContains, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  channelMessages,
  channelReads,
  channels,
  facilities,
  STAFF_ROLES,
  users,
  type Role,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { publish } from '../../lib/events.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/**
 * Team channels: facility channels for each team (all staff, clinical, pharmacy, front desk) and
 * national channels connecting the Ministry with facility leadership. Channels coordinate work;
 * clinical documentation belongs in the patient record, and patient identifiers should not be
 * posted (patients are discussed through the record, tasks and referrals, where access is enforced).
 */
const FACILITY_DEFAULTS: { name: string; description: string; roles: Role[] }[] = [
  {
    name: 'all-staff',
    description: 'Everyone working at this facility',
    roles: [
      'DIRECTOR',
      'DOCTOR',
      'NURSE',
      'PHARMACIST',
      'RECEPTION',
      'LAB_TECHNICIAN',
      'IT_SUPPORT',
    ],
  },
  {
    name: 'clinical',
    description: 'Doctors, nurses and pharmacists – clinical coordination',
    roles: ['DIRECTOR', 'DOCTOR', 'NURSE', 'PHARMACIST', 'LAB_TECHNICIAN'],
  },
  {
    name: 'pharmacy',
    description: 'Medication supply, shortages and pharmacy questions',
    roles: ['DOCTOR', 'NURSE', 'PHARMACIST', 'DIRECTOR'],
  },
  {
    name: 'front-desk',
    description: 'Reception, scheduling and patient flow',
    roles: ['RECEPTION', 'NURSE', 'DOCTOR', 'DIRECTOR'],
  },
];
const NATIONAL_DEFAULTS: { name: string; description: string; roles: Role[] }[] = [
  {
    name: 'ministry-directors',
    description: 'Ministry of Health and facility directors',
    roles: ['MINISTRY', 'DIRECTOR'],
  },
];
const STAFF = [...STAFF_ROLES] as Role[];

const CreateSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'Use lowercase letters, digits and dashes'),
  description: z.string().trim().max(300).optional().nullable(),
  allowedRoles: z.array(z.enum(STAFF_ROLES)).min(1),
});
const PostSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  isUrgent: z.boolean().default(false),
});
const IdParam = z.object({ id: z.string().uuid() });
const HistoryQuery = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Creates the default channels the first time they are needed (idempotent). */
export async function ensureDefaultChannels(facilityId: string | null, executor: Executor = db) {
  const scope: 'FACILITY' | 'NATIONAL' = facilityId ? 'FACILITY' : 'NATIONAL';
  const defaults = facilityId ? FACILITY_DEFAULTS : NATIONAL_DEFAULTS;
  const existing = await executor
    .select({ name: channels.name })
    .from(channels)
    .where(facilityId ? eq(channels.facilityId, facilityId) : eq(channels.scope, 'NATIONAL'));
  const missing = defaults.filter((d) => !existing.some((e) => e.name === d.name));
  if (missing.length) {
    await executor
      .insert(channels)
      .values(
        missing.map((d) => ({
          scope,
          facilityId,
          name: d.name,
          description: d.description,
          allowedRoles: d.roles,
        })),
      )
      .onConflictDoNothing();
  }
}

function visibleTo(ctx: AuthContext): SQL {
  const roleAllowed = arrayContains(channels.allowedRoles, [ctx.role]);
  const facilityChannel = ctx.facilityId
    ? and(eq(channels.scope, 'FACILITY'), eq(channels.facilityId, ctx.facilityId))
    : undefined;
  return and(
    roleAllowed,
    facilityChannel
      ? or(facilityChannel, eq(channels.scope, 'NATIONAL'))
      : eq(channels.scope, 'NATIONAL'),
  )!;
}

async function loadChannel(ctx: AuthContext, id: string) {
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, id), visibleTo(ctx)));
  if (!channel) throw notFound('Channel not found');
  return channel;
}

/** Active users who can see the channel (for live delivery and urgent notifications). */
async function members(channel: typeof channels.$inferSelect): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.isActive, true),
        inArray(users.role, channel.allowedRoles),
        channel.scope === 'FACILITY' ? eq(users.facilityId, channel.facilityId!) : undefined,
      ),
    );
  return rows.map((r) => r.id);
}

export const channelsRouter = Router();
channelsRouter.use(authenticate, requireRole(...STAFF));

channelsRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  if (ctx.facilityId) await ensureDefaultChannels(ctx.facilityId);
  await ensureDefaultChannels(null);
  const rows = await db
    .select({
      id: channels.id,
      scope: channels.scope,
      name: channels.name,
      description: channels.description,
      allowedRoles: channels.allowedRoles,
      facilityName: facilities.name,
      lastMessageAt: channels.lastMessageAt,
      isArchived: channels.isArchived,
      unreadCount: sql<number>`(SELECT count(*)::int FROM channel_messages m
        WHERE m.channel_id = ${channels.id} AND m.author_id <> ${ctx.userId}
          AND m.created_at > coalesce((SELECT r.last_read_at FROM channel_reads r
            WHERE r.channel_id = ${channels.id} AND r.user_id = ${ctx.userId}), 'epoch'))`,
    })
    .from(channels)
    .leftJoin(facilities, eq(facilities.id, channels.facilityId))
    .where(and(visibleTo(ctx), eq(channels.isArchived, false)))
    .orderBy(channels.scope, channels.name);
  res.json({ items: rows });
});

channelsRouter.post('/', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(CreateSchema, req.body);
  const facilityRoles: Role[] = [
    'DIRECTOR',
    'DOCTOR',
    'NURSE',
    'PHARMACIST',
    'RECEPTION',
    'LAB_TECHNICIAN',
    'IT_SUPPORT',
  ];
  if (ctx.role === 'DIRECTOR' && input.allowedRoles.some((r) => !facilityRoles.includes(r))) {
    throw badRequest('Facility channels can only include facility staff roles');
  }
  // Creators can always see what they create.
  const allowedRoles = [...new Set<Role>([...input.allowedRoles, ctx.role])];
  const scope: 'FACILITY' | 'NATIONAL' = ctx.role === 'MINISTRY' ? 'NATIONAL' : 'FACILITY';
  const facilityId = ctx.role === 'MINISTRY' ? null : ctx.facilityId;
  const [dup] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.name, input.name),
        facilityId ? eq(channels.facilityId, facilityId) : eq(channels.scope, 'NATIONAL'),
      ),
    );
  if (dup) throw conflict('A channel with this name already exists');
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(channels)
      .values({
        scope,
        facilityId,
        name: input.name,
        description: input.description ?? null,
        allowedRoles,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.CHANNEL_CREATED,
        actor: ctx,
        resourceType: 'channel',
        resourceId: created!.id,
        meta: requestMeta(req),
        metadata: { name: input.name, allowedRoles },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

channelsRouter.get('/:id/messages', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const q = parse(HistoryQuery, req.query);
  const channel = await loadChannel(ctx, id);
  const rows = await db
    .select({
      id: channelMessages.id,
      body: channelMessages.body,
      isUrgent: channelMessages.isUrgent,
      createdAt: channelMessages.createdAt,
      authorId: channelMessages.authorId,
      authorName: users.fullName,
      authorRole: users.role,
      authorFacility: facilities.name,
    })
    .from(channelMessages)
    .innerJoin(users, eq(users.id, channelMessages.authorId))
    .leftJoin(facilities, eq(facilities.id, users.facilityId))
    .where(
      and(
        eq(channelMessages.channelId, id),
        q.before ? lt(channelMessages.createdAt, new Date(q.before)) : undefined,
      ),
    )
    .orderBy(desc(channelMessages.createdAt))
    .limit(q.limit);
  res.json({ channel, items: rows.reverse(), hasMore: rows.length === q.limit });
});

channelsRouter.post('/:id/read', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  await loadChannel(ctx, id);
  await db
    .insert(channelReads)
    .values({ channelId: id, userId: ctx.userId, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [channelReads.channelId, channelReads.userId],
      set: { lastReadAt: new Date() },
    });
  res.status(204).end();
});

channelsRouter.post('/:id/messages', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(PostSchema, req.body);
  const channel = await loadChannel(ctx, id);
  if (channel.isArchived) throw conflict('This channel is archived');
  const recipients = await members(channel);
  const row = await db.transaction(async (tx) => {
    const now = new Date();
    const [created] = await tx
      .insert(channelMessages)
      .values({ channelId: id, authorId: ctx.userId, body: input.body, isUrgent: input.isUrgent })
      .returning();
    await tx.update(channels).set({ lastMessageAt: now }).where(eq(channels.id, id));
    await tx
      .insert(channelReads)
      .values({ channelId: id, userId: ctx.userId, lastReadAt: now })
      .onConflictDoUpdate({
        target: [channelReads.channelId, channelReads.userId],
        set: { lastReadAt: now },
      });
    await audit(
      {
        action: AuditAction.CHANNEL_MESSAGE_POSTED,
        actor: ctx,
        resourceType: 'channel',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { urgent: input.isUrgent },
      },
      tx,
    );
    await publish(recipients, { type: 'channel.message', ref: id }, tx);
    if (input.isUrgent) {
      await notifyUsers(
        recipients.filter((u) => u !== ctx.userId),
        {
          type: 'channel',
          title: 'Urgent message in #{channel}',
          vars: { channel: channel.name },
          important: true,
          link: `/channels?c=${id}`,
        },
        tx,
      );
    }
    return created!;
  });
  res.status(201).json(row);
});

channelsRouter.post('/:id/archive', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const channel = await loadChannel(ctx, id);
  const owns =
    (ctx.role === 'MINISTRY' && channel.scope === 'NATIONAL') ||
    (ctx.role === 'DIRECTOR' && channel.facilityId === ctx.facilityId);
  if (!owns) throw forbidden('You can only archive channels you manage');
  await db.update(channels).set({ isArchived: true }).where(eq(channels.id, id));
  res.status(204).end();
});
