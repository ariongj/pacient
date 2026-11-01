import { Router } from 'express';
import { and, asc, eq, ilike, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { facilities, facilityTypeEnum } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';

const FacilityInput = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,32}$/, 'Code may contain letters, digits and dashes'),
  name: z.string().trim().min(2).max(200),
  type: z.enum(facilityTypeEnum.enumValues),
  region: z.string().trim().min(2).max(100),
  municipality: z.string().trim().min(2).max(100),
  address: z.string().trim().max(300).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
});

const FacilityPatch = FacilityInput.partial().extend({ isActive: z.boolean().optional() });

const ListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  region: z.string().trim().max(100).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

const IdParam = z.object({ id: z.string().uuid() });

export const facilitiesRouter = Router();
facilitiesRouter.use(authenticate);

/** Facility directory – public information, available to every authenticated user. */
facilitiesRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [];
  if (q.search) {
    filters.push(
      or(ilike(facilities.name, `%${q.search}%`), ilike(facilities.code, `%${q.search}%`))!,
    );
  }
  if (q.region) filters.push(eq(facilities.region, q.region));
  if (!(ctx.role === 'MINISTRY' && q.includeInactive === 'true')) {
    filters.push(eq(facilities.isActive, true));
  }
  const rows = await db
    .select()
    .from(facilities)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(facilities.region), asc(facilities.name));
  res.json({ items: rows });
});

facilitiesRouter.get('/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const [row] = await db.select().from(facilities).where(eq(facilities.id, id));
  if (!row) throw notFound('Facility not found');
  res.json(row);
});

facilitiesRouter.post('/', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(FacilityInput, req.body);
  const created = await db.transaction(async (tx) => {
    const [row] = await tx.insert(facilities).values(input).returning();
    await audit(
      {
        action: AuditAction.FACILITY_CREATED,
        actor: ctx,
        resourceType: 'facility',
        resourceId: row!.id,
        meta: requestMeta(req),
        metadata: { code: row!.code },
      },
      tx,
    );
    return row!;
  });
  res.status(201).json(created);
});

facilitiesRouter.patch('/:id', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const patch = parse(FacilityPatch, req.body);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(facilities).set(patch).where(eq(facilities.id, id)).returning();
    if (!row) throw notFound('Facility not found');
    await audit(
      {
        action: AuditAction.FACILITY_UPDATED,
        actor: ctx,
        resourceType: 'facility',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { fields: Object.keys(patch) },
      },
      tx,
    );
    return row;
  });
  res.json(updated);
});
