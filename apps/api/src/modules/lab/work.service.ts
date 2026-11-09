import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { auditLogs, labOrders, labResults, labSpecimenEvents, users } from '../../db/schema.js';
import { forbidden } from '../../lib/errors.js';
import type { AuthContext } from '../../lib/http.js';
import { AuditAction } from '../audit/audit.service.js';

/**
 * Laboratory work inside a facility (blueprint §4 diagnostics): specimen tracking, manual result
 * entry where no laboratory system (LIS) is connected, and validation by a second person.
 *
 * Who works the laboratory worklist:
 *  - LAB_TECHNICIAN staff of the facility;
 *  - doctors of the facility whose specialty is a laboratory one (laboratory medicine, clinical
 *    biochemistry, microbiology, pathology, haematology) – they may also validate.
 * Directors see turnaround statistics only. Nobody gets chart access through the worklist: it
 * shows what the laboratory needs to identify the specimen and do the test.
 */

export const LAB_SPECIALTY = /laborat|biochem|microbiolog|patholog|haematolog|hematolog/i;

export const REJECTION_REASONS = [
  'HAEMOLYSED',
  'CLOTTED',
  'MISLABELLED',
  'INSUFFICIENT',
  'WRONG_CONTAINER',
  'DELAYED_TRANSPORT',
  'OTHER',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** Is this user laboratory staff of their facility (technician, or a laboratory doctor)? */
export async function isLabStaff(ctx: AuthContext, executor: Executor = db): Promise<boolean> {
  if (!ctx.facilityId) return false;
  if (ctx.role === 'LAB_TECHNICIAN') return true;
  if (ctx.role !== 'DOCTOR') return false;
  const [u] = await executor
    .select({ specialty: users.specialty })
    .from(users)
    .where(eq(users.id, ctx.userId));
  return Boolean(u?.specialty && LAB_SPECIALTY.test(u.specialty));
}

export async function assertLabStaff(ctx: AuthContext, executor: Executor = db) {
  if (!(await isLabStaff(ctx, executor))) {
    throw forbidden('Only laboratory staff of this facility can do this');
  }
  return ctx.facilityId!;
}

export async function recordSpecimenEvent(
  tx: Executor,
  orderId: string,
  actorId: string,
  event: (typeof labSpecimenEvents.$inferInsert)['event'],
  extra: { reason?: string | null; specimenBarcode?: string | null } = {},
) {
  await tx.insert(labSpecimenEvents).values({
    orderId,
    actorId,
    event,
    reason: extra.reason ?? null,
    specimenBarcode: extra.specimenBarcode ?? null,
  });
}

/** The current (not superseded) result of an order, if any. */
export async function currentResult(tx: Executor, orderId: string) {
  const [row] = await tx
    .select()
    .from(labResults)
    .where(and(eq(labResults.orderId, orderId), isNull(labResults.supersededById)))
    .orderBy(desc(labResults.createdAt))
    .limit(1);
  return row ?? null;
}

/** Who entered a manual result (from the audit entry written in the same transaction). */
export async function enteredBy(tx: Executor, resultIds: string[]) {
  if (!resultIds.length) return new Map<string, string>();
  const rows = await tx
    .select({ resultId: auditLogs.resourceId, userId: auditLogs.actorUserId })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, AuditAction.LAB_RESULT_ENTERED),
        eq(auditLogs.resourceType, 'lab_result'),
        inArray(auditLogs.resourceId, resultIds),
      ),
    );
  return new Map(rows.filter((r) => r.resultId && r.userId).map((r) => [r.resultId!, r.userId!]));
}

/** Latest specimen events per order. */
export async function latestEvents(tx: Executor, orderIds: string[]) {
  if (!orderIds.length) return new Map<string, typeof labSpecimenEvents.$inferSelect>();
  const rows = await tx
    .select()
    .from(labSpecimenEvents)
    .where(inArray(labSpecimenEvents.orderId, orderIds))
    .orderBy(desc(labSpecimenEvents.occurredAt));
  const out = new Map<string, typeof labSpecimenEvents.$inferSelect>();
  for (const r of rows) if (!out.has(r.orderId)) out.set(r.orderId, r);
  return out;
}

/** The barcode last recorded for each order (collection or receipt). */
export async function barcodes(tx: Executor, orderIds: string[]) {
  if (!orderIds.length) return new Map<string, string>();
  const rows = await tx
    .select({ orderId: labSpecimenEvents.orderId, barcode: labSpecimenEvents.specimenBarcode })
    .from(labSpecimenEvents)
    .where(inArray(labSpecimenEvents.orderId, orderIds))
    .orderBy(desc(labSpecimenEvents.occurredAt));
  const out = new Map<string, string>();
  for (const r of rows) if (r.barcode && !out.has(r.orderId)) out.set(r.orderId, r.barcode);
  return out;
}

export const OPEN_STATUSES = ['ORDERED', 'RECEIVED', 'IN_PROGRESS'] as const;

/** Lab orders of a facility in the given statuses (newest priority first). */
export function facilityOrders(
  facilityId: string,
  statuses: (typeof labOrders.$inferSelect)['status'][],
) {
  return and(eq(labOrders.facilityId, facilityId), inArray(labOrders.status, statuses));
}

/** Median and 90th percentile of a list of minutes (null when empty). */
export function percentiles(values: number[]) {
  if (!values.length) return { median: null, p90: null };
  const s = [...values].sort((a, b) => a - b);
  const at = (q: number) => {
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return Math.round(s[lo]! + (s[hi]! - s[lo]!) * (pos - lo));
  };
  return { median: at(0.5), p90: at(0.9) };
}
