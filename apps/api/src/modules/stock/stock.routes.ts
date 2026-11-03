import { Router } from 'express';
import { and, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  medicationCatalog,
  STAFF_ROLES,
  stockBatches,
  stockMovements,
  stockSettings,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { toCsv } from '../reports/reports.routes.js';
import {
  alertLowStock,
  batchesFor,
  checkExpiries,
  isoDay,
  nationalAvailability,
  stockLevels,
  type StockStatus,
} from './stock.service.js';

/**
 * Pharmacy stock: the national medication catalogue (Ministry), stock levels, deliveries,
 * adjustments and the movement ledger of a facility (its pharmacists; directors read only), and
 * national medicine availability (Ministry, no patient data).
 */
export const stockRouter = Router();
stockRouter.use(authenticate);

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });
const ItemParam = z.object({ itemId: Uuid });

const CatalogInput = z.object({
  name: z.string().trim().min(2).max(200),
  atcCode: z
    .string()
    .trim()
    .regex(/^[A-Z]\d{2}[A-Z]{0,2}\d{0,2}$/, 'ATC codes look like N02BE01')
    .optional()
    .nullable(),
  form: z.string().trim().min(2).max(60),
  strength: z.string().trim().max(60).optional().nullable(),
  unit: z.string().trim().min(1).max(30),
  isEssential: z.boolean().default(false),
});
const CatalogPatch = CatalogInput.partial().extend({ isActive: z.boolean().optional() });

const ReceiptInput = z.object({
  supplier: z.string().trim().max(200).optional().nullable(),
  items: z
    .array(
      z.object({
        itemId: Uuid,
        batchNumber: z.string().trim().min(1).max(60),
        expiryDate: z.string().date(),
        quantity: z.number().int().positive().max(1_000_000),
        supplier: z.string().trim().max(200).optional().nullable(),
      }),
    )
    .min(1)
    .max(100),
});

const AdjustmentInput = z.object({
  batchId: Uuid,
  quantity: z
    .number()
    .int()
    .refine((n) => n !== 0, 'Enter a quantity other than zero'),
  type: z.enum(['ADJUSTMENT', 'EXPIRED', 'DAMAGED', 'RETURN']),
  reason: z.string().trim().min(5).max(500),
});

const LevelsQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['ALL', 'LOW', 'OUT', 'EXPIRING', 'EXPIRED', 'ATTENTION']).default('ALL'),
  all: z.enum(['true', 'false']).default('false'),
});

const MovementsQuery = PaginationSchema.extend({
  itemId: Uuid.optional(),
  type: z
    .enum([
      'RECEIPT',
      'DISPENSE',
      'ADJUSTMENT',
      'EXPIRED',
      'DAMAGED',
      'TRANSFER_OUT',
      'TRANSFER_IN',
      'RETURN',
    ])
    .optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

/** Pharmacists manage their facility's stock; directors may look. */
function facilityOf(ctx: AuthContext, write: boolean) {
  const allowed = write ? ['PHARMACIST'] : ['PHARMACIST', 'DIRECTOR'];
  if (!allowed.includes(ctx.role) || !ctx.facilityId) {
    throw forbidden(
      write
        ? 'Only the facility’s pharmacists can change stock'
        : 'Only pharmacy staff and the facility director can see stock',
    );
  }
  return ctx.facilityId;
}

/* ---------------------------------------------------------------------------------- catalogue */

stockRouter.get('/catalog', requireRole(...STAFF_ROLES), async (req, res) => {
  const { q, essential, includeInactive } = parse(
    z.object({
      q: z.string().trim().max(100).optional(),
      essential: z.enum(['true', 'false']).optional(),
      includeInactive: z.enum(['true', 'false']).optional(),
    }),
    req.query,
  );
  const ctx = requireAuth(req);
  const filters: SQL[] = [];
  if (!(includeInactive === 'true' && ctx.role === 'MINISTRY'))
    filters.push(eq(medicationCatalog.isActive, true));
  if (essential === 'true') filters.push(eq(medicationCatalog.isEssential, true));
  if (q) {
    filters.push(
      sql`(${medicationCatalog.name} ILIKE ${`%${q}%`} OR ${medicationCatalog.atcCode} ILIKE ${`${q}%`})`,
    );
  }
  const rows = await db
    .select()
    .from(medicationCatalog)
    .where(and(...filters))
    .orderBy(medicationCatalog.name, medicationCatalog.strength)
    .limit(q ? 30 : 500);
  res.json({ items: rows });
});

stockRouter.post('/catalog', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(CatalogInput, req.body);
  const [dup] = await db
    .select({ id: medicationCatalog.id })
    .from(medicationCatalog)
    .where(
      and(
        sql`lower(${medicationCatalog.name}) = lower(${input.name})`,
        sql`lower(${medicationCatalog.form}) = lower(${input.form})`,
        input.strength
          ? sql`lower(${medicationCatalog.strength}) = lower(${input.strength})`
          : sql`${medicationCatalog.strength} IS NULL`,
      ),
    );
  if (dup) throw conflict('This medicine is already in the catalogue');
  const row = await db.transaction(async (tx) => {
    const [created] = await tx.insert(medicationCatalog).values(input).returning();
    await audit(
      {
        action: AuditAction.STOCK_SETTINGS_CHANGED,
        actor: ctx,
        resourceType: 'medication_catalog',
        resourceId: created!.id,
        meta: requestMeta(req),
        metadata: { change: 'catalog.created', name: input.name },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

stockRouter.patch('/catalog/:id', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(CatalogPatch, req.body);
  if (!Object.keys(input).length) throw badRequest('Nothing to change');
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(medicationCatalog)
      .set(input)
      .where(eq(medicationCatalog.id, id))
      .returning();
    if (!updated) throw notFound('Catalogue item not found');
    await audit(
      {
        action: AuditAction.STOCK_SETTINGS_CHANGED,
        actor: ctx,
        resourceType: 'medication_catalog',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { change: 'catalog.updated', fields: Object.keys(input) },
      },
      tx,
    );
    return updated;
  });
  res.json(row);
});

/* ------------------------------------------------------------------------- facility stock */

const matchesStatus = (flags: StockStatus[], status: z.infer<typeof LevelsQuery>['status']) =>
  status === 'ALL' ||
  (status === 'ATTENTION' ? flags.length > 0 : flags.includes(status as StockStatus));

stockRouter.get('/levels', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx, false);
  const q = parse(LevelsQuery, req.query);
  // Viewing stock doubles as the daily expiry check (one alert per batch per day).
  if (ctx.role === 'PHARMACIST') await checkExpiries(facilityId);
  const rows = await stockLevels(facilityId, { q: q.q, includeAll: q.all === 'true' });
  const items = rows.filter((r) => matchesStatus(r.flags, q.status));
  const counts = { LOW: 0, OUT: 0, EXPIRING: 0, EXPIRED: 0 } as Record<string, number>;
  for (const r of rows) for (const f of r.flags) counts[f] = (counts[f] ?? 0) + 1;
  res.json({ items, counts, total: rows.length, canEdit: ctx.role === 'PHARMACIST' });
});

stockRouter.get('/items/:itemId/batches', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx, false);
  const { itemId } = parse(ItemParam, req.params);
  const [item] = await db.select().from(medicationCatalog).where(eq(medicationCatalog.id, itemId));
  if (!item) throw notFound('Catalogue item not found');
  const [level] = await stockLevels(facilityId, { itemIds: [itemId] });
  res.json({ item, level: level ?? null, batches: await batchesFor(facilityId, itemId) });
});

stockRouter.post('/receipts', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx, true);
  const input = parse(ReceiptInput, req.body);
  const today = isoDay(new Date());
  for (const l of input.items) {
    if (l.expiryDate <= today)
      throw badRequest('Expiry dates of received stock must be in the future');
  }
  const itemIds = [...new Set(input.items.map((l) => l.itemId))];
  const known = await db
    .select({ id: medicationCatalog.id })
    .from(medicationCatalog)
    .where(and(inArray(medicationCatalog.id, itemIds), eq(medicationCatalog.isActive, true)));
  if (known.length !== itemIds.length) throw badRequest('Unknown or inactive catalogue item');

  const result = await db.transaction(async (tx) => {
    const lines: { batchId: string; itemId: string; quantity: number }[] = [];
    for (const l of input.items) {
      const supplier = l.supplier ?? input.supplier ?? null;
      const [existing] = await tx
        .select()
        .from(stockBatches)
        .where(
          and(
            eq(stockBatches.facilityId, facilityId),
            eq(stockBatches.itemId, l.itemId),
            eq(stockBatches.batchNumber, l.batchNumber),
          ),
        )
        .for('update');
      let batchId: string;
      if (existing) {
        if (existing.expiryDate !== l.expiryDate) {
          throw conflict(
            `Batch ${l.batchNumber} is already in stock with a different expiry date (${existing.expiryDate})`,
          );
        }
        await tx
          .update(stockBatches)
          .set({ quantity: sql`${stockBatches.quantity} + ${l.quantity}` })
          .where(eq(stockBatches.id, existing.id));
        batchId = existing.id;
      } else {
        const [created] = await tx
          .insert(stockBatches)
          .values({
            facilityId,
            itemId: l.itemId,
            batchNumber: l.batchNumber,
            expiryDate: l.expiryDate,
            quantity: l.quantity,
            supplier,
            createdById: ctx.userId,
          })
          .returning({ id: stockBatches.id });
        batchId = created!.id;
      }
      await tx.insert(stockMovements).values({
        facilityId,
        itemId: l.itemId,
        batchId,
        type: 'RECEIPT',
        quantity: l.quantity,
        reason: supplier ? `Delivery from ${supplier}` : null,
        createdById: ctx.userId,
      });
      lines.push({ batchId, itemId: l.itemId, quantity: l.quantity });
    }
    await audit(
      {
        action: AuditAction.STOCK_RECEIVED,
        actor: ctx,
        resourceType: 'stock_receipt',
        meta: requestMeta(req),
        metadata: { lines: lines.length, units: lines.reduce((a, l) => a + l.quantity, 0) },
      },
      tx,
    );
    return lines;
  });
  res.status(201).json({ lines: result });
});

stockRouter.post('/adjustments', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx, true);
  const input = parse(AdjustmentInput, req.body);
  if (['EXPIRED', 'DAMAGED'].includes(input.type) && input.quantity > 0) {
    throw badRequest('Expired or damaged stock can only be removed (negative quantity)');
  }
  const result = await db.transaction(async (tx) => {
    const [batch] = await tx
      .select()
      .from(stockBatches)
      .where(and(eq(stockBatches.id, input.batchId), eq(stockBatches.facilityId, facilityId)))
      .for('update');
    if (!batch) throw notFound('Batch not found at your facility');
    if (batch.quantity + input.quantity < 0) {
      throw conflict(`Only ${batch.quantity} unit(s) are left in batch ${batch.batchNumber}`);
    }
    await tx
      .update(stockBatches)
      .set({ quantity: batch.quantity + input.quantity })
      .where(eq(stockBatches.id, batch.id));
    const [movement] = await tx
      .insert(stockMovements)
      .values({
        facilityId,
        itemId: batch.itemId,
        batchId: batch.id,
        type: input.type,
        quantity: input.quantity,
        reason: input.reason,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.STOCK_ADJUSTED,
        actor: ctx,
        resourceType: 'stock_batch',
        resourceId: batch.id,
        meta: requestMeta(req),
        metadata: { type: input.type, quantity: input.quantity },
      },
      tx,
    );
    await alertLowStock(tx, facilityId, [batch.itemId]);
    return { movement, quantity: batch.quantity + input.quantity };
  });
  res.status(201).json(result);
});

stockRouter.put('/settings/:itemId', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx, true);
  const { itemId } = parse(ItemParam, req.params);
  const { reorderLevel } = parse(
    z.object({ reorderLevel: z.number().int().min(0).max(1_000_000) }),
    req.body,
  );
  const [item] = await db
    .select({ id: medicationCatalog.id })
    .from(medicationCatalog)
    .where(eq(medicationCatalog.id, itemId));
  if (!item) throw notFound('Catalogue item not found');
  await db.transaction(async (tx) => {
    await tx
      .insert(stockSettings)
      .values({ facilityId, itemId, reorderLevel })
      .onConflictDoUpdate({
        target: [stockSettings.facilityId, stockSettings.itemId],
        set: { reorderLevel, updatedAt: new Date() },
      });
    await audit(
      {
        action: AuditAction.STOCK_SETTINGS_CHANGED,
        actor: ctx,
        resourceType: 'stock_settings',
        resourceId: itemId,
        meta: requestMeta(req),
        metadata: { reorderLevel },
      },
      tx,
    );
    await alertLowStock(tx, facilityId, [itemId]);
  });
  res.json({ itemId, reorderLevel });
});

stockRouter.get('/movements', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx, false);
  const q = parse(MovementsQuery, req.query);
  const filters: SQL[] = [eq(stockMovements.facilityId, facilityId)];
  if (q.itemId) filters.push(eq(stockMovements.itemId, q.itemId));
  if (q.type) filters.push(eq(stockMovements.type, q.type));
  if (q.from) filters.push(gte(stockMovements.createdAt, new Date(`${q.from}T00:00:00`)));
  if (q.to) filters.push(lte(stockMovements.createdAt, new Date(`${q.to}T23:59:59.999`)));
  const where = and(...filters);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: stockMovements.id,
        type: stockMovements.type,
        quantity: stockMovements.quantity,
        reason: stockMovements.reason,
        prescriptionId: stockMovements.prescriptionId,
        createdAt: stockMovements.createdAt,
        itemId: stockMovements.itemId,
        itemName: medicationCatalog.name,
        itemStrength: medicationCatalog.strength,
        itemForm: medicationCatalog.form,
        unit: medicationCatalog.unit,
        batchNumber: stockBatches.batchNumber,
        byName: users.fullName,
      })
      .from(stockMovements)
      .innerJoin(medicationCatalog, eq(medicationCatalog.id, stockMovements.itemId))
      .leftJoin(stockBatches, eq(stockBatches.id, stockMovements.batchId))
      .innerJoin(users, eq(users.id, stockMovements.createdById))
      .where(where)
      .orderBy(desc(stockMovements.createdAt))
      .limit(toOffset(q).limit)
      .offset(toOffset(q).offset),
    db.select({ total: count() }).from(stockMovements).where(where),
  ]);
  res.json(paginated(rows, total?.total ?? 0, q));
});

/* ------------------------------------------------------------------------------ national */

stockRouter.get('/national', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(
    z.object({
      essential: z.enum(['true', 'false']).default('true'),
      format: z.enum(['json', 'csv']).default('json'),
    }),
    req.query,
  );
  const items = await nationalAvailability({ essentialOnly: q.essential === 'true' });
  if (q.format === 'csv') {
    await audit({
      action: AuditAction.REPORT_EXPORTED,
      actor: ctx,
      resourceType: 'report',
      meta: requestMeta(req),
      metadata: { report: 'medicine-availability', essentialOnly: q.essential === 'true' },
    });
    const csv = toCsv(
      [
        'medicine',
        'atcCode',
        'unit',
        'totalUnits',
        'facilitiesOk',
        'facilitiesLow',
        'facilitiesOut',
        'outAt',
        'lowAt',
      ],
      items.map((i) => ({
        medicine: [i.name, i.strength, i.form].filter(Boolean).join(' '),
        atcCode: i.atcCode,
        unit: i.unit,
        totalUnits: i.totalUnits,
        facilitiesOk: i.ok,
        facilitiesLow: i.low,
        facilitiesOut: i.out,
        outAt: i.outFacilities.join('; '),
        lowAt: i.lowFacilities.join('; '),
      })),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="medicine-availability.csv"');
    res.send(csv);
    return;
  }
  const summary = {
    items: items.length,
    withShortage: items.filter((i) => i.out > 0).length,
    withLowStock: items.filter((i) => i.low > 0).length,
  };
  res.json({ items, summary });
});
