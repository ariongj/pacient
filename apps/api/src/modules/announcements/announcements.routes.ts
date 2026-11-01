import { Router } from 'express';
import { and, desc, eq, gt, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  announcementAudienceEnum,
  announcements,
  facilities,
  patients,
  users,
} from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';

/**
 * Announcements: the Ministry publishes nationally, directors publish to their facility. Readers
 * see what applies to their audience (staff or patients) and their facility.
 */
const CreateSchema = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(3).max(5000),
  audience: z.enum(announcementAudienceEnum.enumValues).default('EVERYONE'),
  expiresAt: z
    .string()
    .datetime({ offset: true })
    .refine((d) => new Date(d) > new Date(), 'Expiry must be in the future')
    .optional()
    .nullable(),
});
const IdParam = z.object({ id: z.string().uuid() });

const columns = {
  id: announcements.id,
  scope: announcements.scope,
  audience: announcements.audience,
  title: announcements.title,
  body: announcements.body,
  publishedAt: announcements.publishedAt,
  expiresAt: announcements.expiresAt,
  facilityId: announcements.facilityId,
  facilityName: facilities.name,
  authorName: users.fullName,
};

const active = () => or(isNull(announcements.expiresAt), gt(announcements.expiresAt, new Date()))!;

async function readerFacility(ctx: AuthContext): Promise<string | null> {
  if (ctx.role !== 'PATIENT') return ctx.facilityId;
  if (!ctx.patientId) return null;
  const [p] = await db
    .select({ f: patients.primaryFacilityId })
    .from(patients)
    .where(eq(patients.id, ctx.patientId));
  return p?.f ?? null;
}

export const announcementsRouter = Router();
announcementsRouter.use(authenticate);

announcementsRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const audiences = ctx.role === 'PATIENT' ? ['EVERYONE', 'PATIENTS'] : ['EVERYONE', 'STAFF'];
  const facilityId = await readerFacility(ctx);
  const scope: SQL = facilityId
    ? or(eq(announcements.scope, 'NATIONAL'), eq(announcements.facilityId, facilityId))!
    : eq(announcements.scope, 'NATIONAL');
  const rows = await db
    .select(columns)
    .from(announcements)
    .innerJoin(users, eq(users.id, announcements.authorId))
    .leftJoin(facilities, eq(facilities.id, announcements.facilityId))
    .where(
      and(
        scope,
        active(),
        inArray(announcements.audience, audiences as ('EVERYONE' | 'STAFF' | 'PATIENTS')[]),
      ),
    )
    .orderBy(desc(announcements.publishedAt))
    .limit(50);
  res.json({ items: rows });
});

/** Everything the caller's office has published, including expired items. */
announcementsRouter.get('/manage', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const where =
    ctx.role === 'MINISTRY'
      ? eq(announcements.scope, 'NATIONAL')
      : eq(announcements.facilityId, ctx.facilityId!);
  const rows = await db
    .select(columns)
    .from(announcements)
    .innerJoin(users, eq(users.id, announcements.authorId))
    .leftJoin(facilities, eq(facilities.id, announcements.facilityId))
    .where(where)
    .orderBy(desc(announcements.publishedAt))
    .limit(200);
  res.json({ items: rows });
});

announcementsRouter.post('/', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(CreateSchema, req.body);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(announcements)
      .values({
        ...input,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        authorId: ctx.userId,
        scope: ctx.role === 'MINISTRY' ? 'NATIONAL' : 'FACILITY',
        facilityId: ctx.role === 'MINISTRY' ? null : ctx.facilityId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.ANNOUNCEMENT_PUBLISHED,
        actor: ctx,
        resourceType: 'announcement',
        resourceId: created!.id,
        meta: requestMeta(req),
        metadata: { audience: input.audience },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

/** Withdraw (expire now). Announcements are kept for the record rather than deleted. */
announcementsRouter.post('/:id/withdraw', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const owned =
    ctx.role === 'MINISTRY'
      ? eq(announcements.scope, 'NATIONAL')
      : eq(announcements.facilityId, ctx.facilityId!);
  const rows = await db
    .update(announcements)
    .set({ expiresAt: new Date() })
    .where(and(eq(announcements.id, id), owned))
    .returning({ id: announcements.id });
  if (!rows.length) throw notFound('Announcement not found');
  res.status(204).end();
});
