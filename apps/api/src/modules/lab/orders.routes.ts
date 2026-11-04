import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { labOrders, labPriorityEnum, labResults, users } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import { assertClinicalWriteAccess, WRITERS, resolveAndAuditRead } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { assertEncounterBelongsToPatient } from '../clinical/clinical.service.js';
import { catalogByCode, LAB_CATALOG } from './catalog.js';

/** Unique, human-typable order number echoed back by the laboratory (OBR-2). */
export function newPlacerOrderNumber(now = new Date()): string {
  const date = now.toISOString().slice(2, 10).replace(/-/g, '');
  return `PAC${date}${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
}

const OrderInput = z.object({
  testCode: z.string().trim().min(1).max(40),
  priority: z.enum(labPriorityEnum.enumValues).default('ROUTINE'),
  clinicalNotes: z.string().trim().max(1000).optional().nullable(),
  encounterId: z.string().uuid().optional().nullable(),
});
const PatientParam = z.object({ patientId: z.string().uuid() });
const OrderParams = PatientParam.extend({ orderId: z.string().uuid() });

export const labCatalogRouter = Router();
labCatalogRouter.get('/', authenticate, (_req, res) => {
  res.json({ items: LAB_CATALOG.map(({ normal: _n, decimals: _d, ...t }) => t) });
});

export const labOrdersRouter = Router({ mergeParams: true });
labOrdersRouter.use(authenticate);

labOrdersRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'lab-orders');
  const rows = await db
    .select({
      id: labOrders.id,
      placerOrderNumber: labOrders.placerOrderNumber,
      testCode: labOrders.testCode,
      testName: labOrders.testName,
      specimen: labOrders.specimen,
      priority: labOrders.priority,
      clinicalNotes: labOrders.clinicalNotes,
      status: labOrders.status,
      fillerOrderNumber: labOrders.fillerOrderNumber,
      createdAt: labOrders.createdAt,
      receivedAt: labOrders.receivedAt,
      resultedAt: labOrders.resultedAt,
      cancelledAt: labOrders.cancelledAt,
      orderedBy: users.fullName,
    })
    .from(labOrders)
    .innerJoin(users, eq(users.id, labOrders.orderedById))
    .where(eq(labOrders.patientId, patientId))
    .orderBy(desc(labOrders.createdAt))
    .limit(200);
  res.json({ items: rows });
});

labOrdersRouter.post('/', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(OrderInput, req.body);
  await assertClinicalWriteAccess(ctx, patientId, requestMeta(req), WRITERS.doctorOnly);
  const test = catalogByCode(input.testCode);
  if (!test) throw badRequest('Unknown test code');
  if (input.encounterId) await assertEncounterBelongsToPatient(input.encounterId, patientId);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(labOrders)
      .values({
        placerOrderNumber: newPlacerOrderNumber(),
        patientId,
        encounterId: input.encounterId ?? null,
        orderedById: ctx.userId,
        facilityId: ctx.facilityId!,
        testCode: test.code,
        testName: test.name,
        specimen: test.specimen,
        priority: input.priority,
        clinicalNotes: input.clinicalNotes ?? null,
      })
      .returning();
    await audit(
      {
        action: AuditAction.LAB_ORDER_CREATED,
        actor: ctx,
        resourceType: 'lab_order',
        resourceId: created!.id,
        patientId,
        meta: requestMeta(req),
        metadata: { testCode: test.code, priority: input.priority },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

labOrdersRouter.post('/:orderId/cancel', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId, orderId } = parse(OrderParams, req.params);
  await assertClinicalWriteAccess(ctx, patientId, requestMeta(req), WRITERS.doctorOnly);
  const [order] = await db
    .update(labOrders)
    .set({ status: 'CANCELLED', cancelledAt: new Date() })
    .where(
      and(
        eq(labOrders.id, orderId),
        eq(labOrders.patientId, patientId),
        inArray(labOrders.status, ['ORDERED', 'RECEIVED']),
      ),
    )
    .returning();
  if (!order) {
    const [exists] = await db
      .select({ id: labOrders.id })
      .from(labOrders)
      .where(eq(labOrders.id, orderId));
    if (!exists) throw notFound('Order not found');
    throw conflict('The laboratory is already processing this order');
  }
  await audit({
    action: AuditAction.LAB_ORDER_CANCELLED,
    actor: ctx,
    resourceType: 'lab_order',
    resourceId: orderId,
    patientId,
    meta: requestMeta(req),
  });
  res.json(order);
});

/** Results that came back for this order (current versions). */
export async function resultsForOrder(orderId: string) {
  return db.select().from(labResults).where(eq(labResults.orderId, orderId));
}
