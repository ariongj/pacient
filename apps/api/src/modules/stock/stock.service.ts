import { and, asc, eq, gt, gte, inArray, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  medicationCatalog,
  notifications,
  stockBatches,
  stockMovements,
  stockSettings,
  users,
} from '../../db/schema.js';
import { conflict, HttpError, notFound } from '../../lib/errors.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/**
 * Pharmacy stock. Quantities are in dispensing units (tablets, vials, ml…). Batches hold the
 * current quantity; every change is also written to the append-only `stock_movements` ledger in
 * the same transaction, so the ledger always explains the current stock.
 */

/** Batches expiring within this many days are flagged "expiring". */
export const EXPIRING_DAYS = 90;
/** Pharmacists are alerted about batches expiring within this many days. */
export const EXPIRY_ALERT_DAYS = 30;

export type StockStatus = 'OK' | 'LOW' | 'OUT' | 'EXPIRING' | 'EXPIRED';

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

export const itemLabel = (i: { name: string; strength: string | null; form: string }) =>
  [i.name, i.strength, i.form].filter(Boolean).join(' ');

export interface LevelRow {
  itemId: string;
  name: string;
  atcCode: string | null;
  form: string;
  strength: string | null;
  unit: string;
  isEssential: boolean;
  onHand: number;
  expiredQuantity: number;
  expiringQuantity: number;
  reorderLevel: number;
  nextExpiry: string | null;
  status: StockStatus;
  flags: StockStatus[];
}

/** Status of one item: OUT and LOW win over expiry flags; flags lists everything that applies. */
export function statusOf(r: {
  onHand: number;
  reorderLevel: number;
  expiredQuantity: number;
  expiringQuantity: number;
}): { status: StockStatus; flags: StockStatus[] } {
  const flags: StockStatus[] = [];
  if (r.onHand <= 0) flags.push('OUT');
  else if (r.reorderLevel > 0 && r.onHand <= r.reorderLevel) flags.push('LOW');
  if (r.expiringQuantity > 0) flags.push('EXPIRING');
  if (r.expiredQuantity > 0) flags.push('EXPIRED');
  return { status: flags[0] ?? 'OK', flags };
}

/**
 * Stock levels at a facility. By default only items the facility stocks (has batches or a reorder
 * level for); `includeAll` adds every active catalogue item matching the search.
 */
export async function stockLevels(
  facilityId: string,
  opts: { q?: string; itemIds?: string[]; includeAll?: boolean; now?: Date } = {},
  executor: Executor = db,
): Promise<LevelRow[]> {
  const today = isoDay(opts.now ?? new Date());
  const expiringBy = isoDay(addDays(opts.now ?? new Date(), EXPIRING_DAYS));
  const q = opts.q?.trim();
  const result = await executor.execute<{
    item_id: string;
    name: string;
    atc_code: string | null;
    form: string;
    strength: string | null;
    unit: string;
    is_essential: boolean;
    on_hand: number;
    expired_quantity: number;
    expiring_quantity: number;
    reorder_level: number;
    next_expiry: string | null;
    stocked: boolean;
  }>(sql`
    SELECT c.id AS item_id, c.name, c.atc_code, c.form, c.strength, c.unit, c.is_essential,
      coalesce(sum(b.quantity) FILTER (WHERE b.expiry_date >= ${today}), 0)::int AS on_hand,
      coalesce(sum(b.quantity) FILTER (WHERE b.expiry_date < ${today}), 0)::int AS expired_quantity,
      coalesce(sum(b.quantity) FILTER (WHERE b.expiry_date >= ${today} AND b.expiry_date <= ${expiringBy}), 0)::int
        AS expiring_quantity,
      coalesce(max(s.reorder_level), 0)::int AS reorder_level,
      min(b.expiry_date) FILTER (WHERE b.expiry_date >= ${today} AND b.quantity > 0)::text AS next_expiry,
      (count(b.id) > 0 OR count(s.id) > 0) AS stocked
    FROM medication_catalog c
    LEFT JOIN stock_batches b ON b.item_id = c.id AND b.facility_id = ${facilityId}
    LEFT JOIN stock_settings s ON s.item_id = c.id AND s.facility_id = ${facilityId}
    WHERE c.is_active
      ${q ? sql`AND (c.name ILIKE ${`%${q}%`} OR c.atc_code ILIKE ${`${q}%`})` : sql``}
      ${opts.itemIds?.length ? sql`AND c.id IN ${sql.raw(`(${opts.itemIds.map((id) => `'${id.replace(/[^0-9a-f-]/gi, '')}'`).join(',')})`)}` : sql``}
    GROUP BY c.id
    ORDER BY c.name, c.strength`);
  return result.rows
    .filter((r) => opts.includeAll || opts.itemIds?.length || r.stocked)
    .map((r) => {
      const base = {
        itemId: r.item_id,
        name: r.name,
        atcCode: r.atc_code,
        form: r.form,
        strength: r.strength,
        unit: r.unit,
        isEssential: r.is_essential,
        onHand: Number(r.on_hand),
        expiredQuantity: Number(r.expired_quantity),
        expiringQuantity: Number(r.expiring_quantity),
        reorderLevel: Number(r.reorder_level),
        nextExpiry: r.next_expiry,
      };
      return { ...base, ...statusOf(base) };
    });
}

/** Batches of an item at a facility, first expiry first. */
export async function batchesFor(
  facilityId: string,
  itemId: string,
  executor: Executor = db,
  now = new Date(),
) {
  const today = isoDay(now);
  const rows = await executor
    .select({
      id: stockBatches.id,
      batchNumber: stockBatches.batchNumber,
      expiryDate: stockBatches.expiryDate,
      quantity: stockBatches.quantity,
      supplier: stockBatches.supplier,
      receivedAt: stockBatches.receivedAt,
    })
    .from(stockBatches)
    .where(and(eq(stockBatches.facilityId, facilityId), eq(stockBatches.itemId, itemId)))
    .orderBy(asc(stockBatches.expiryDate), asc(stockBatches.receivedAt));
  return rows.map((b) => ({ ...b, expired: b.expiryDate < today }));
}

/** First-expiry-first-out allocation of `units` over usable batches (pure; for suggestions). */
export function allocateFefo(
  batches: { id: string; quantity: number; expiryDate: string }[],
  units: number,
  today: string,
): { lines: { batchId: string; units: number }[]; shortBy: number } {
  const lines: { batchId: string; units: number }[] = [];
  let remaining = units;
  for (const b of [...batches]
    .filter((x) => x.expiryDate >= today && x.quantity > 0)
    .sort((a, c) => a.expiryDate.localeCompare(c.expiryDate))) {
    if (remaining <= 0) break;
    const take = Math.min(b.quantity, remaining);
    lines.push({ batchId: b.id, units: take });
    remaining -= take;
  }
  return { lines, shortBy: Math.max(0, remaining) };
}

/**
 * Takes stock out of batches inside the caller's transaction: locks the batches, refuses expired
 * or other-facility batches and insufficient quantities (409), and writes the ledger rows.
 * Without explicit lines the units are allocated first-expiry-first-out.
 */
export async function withdrawStock(
  tx: Executor,
  input: {
    facilityId: string;
    itemId: string;
    units: number;
    lines?: { batchId: string; units: number }[];
    type: 'DISPENSE' | 'TRANSFER_OUT';
    prescriptionId?: string | null;
    reason?: string | null;
    userId: string;
    now?: Date;
  },
) {
  const today = isoDay(input.now ?? new Date());
  const locked = await tx
    .select()
    .from(stockBatches)
    .where(
      and(eq(stockBatches.facilityId, input.facilityId), eq(stockBatches.itemId, input.itemId)),
    )
    .orderBy(asc(stockBatches.expiryDate))
    .for('update');
  let lines = input.lines;
  if (!lines?.length) {
    const alloc = allocateFefo(locked, input.units, today);
    if (alloc.shortBy > 0) {
      throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Not enough stock for this quantity', {
        shortBy: alloc.shortBy,
      });
    }
    lines = alloc.lines;
  }
  const total = lines.reduce((a, l) => a + l.units, 0);
  if (total !== input.units) throw conflict('The batch quantities do not add up to the quantity');
  const byId = new Map(locked.map((b) => [b.id, b]));
  for (const l of lines) {
    const b = byId.get(l.batchId);
    if (!b) throw notFound('Batch not found for this item at your facility');
    if (b.expiryDate < today) {
      throw new HttpError(409, 'BATCH_EXPIRED', 'An expired batch cannot be dispensed', {
        batchNumber: b.batchNumber,
      });
    }
    if (l.units <= 0) throw conflict('Each batch line needs a positive quantity');
    if (b.quantity < l.units) {
      throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Not enough stock in the chosen batch', {
        batchNumber: b.batchNumber,
        available: b.quantity,
        shortBy: l.units - b.quantity,
      });
    }
  }
  for (const l of lines) {
    await tx
      .update(stockBatches)
      .set({ quantity: sql`${stockBatches.quantity} - ${l.units}` })
      .where(eq(stockBatches.id, l.batchId));
    await tx.insert(stockMovements).values({
      facilityId: input.facilityId,
      itemId: input.itemId,
      batchId: l.batchId,
      type: input.type,
      quantity: -l.units,
      prescriptionId: input.prescriptionId ?? null,
      reason: input.reason ?? null,
      createdById: input.userId,
    });
  }
  return lines;
}

/** Start of the current day (server time) – alerts are sent at most once per day. */
const startOfDay = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

async function alreadyNotifiedToday(
  executor: Executor,
  facilityId: string,
  link: string,
  now: Date,
) {
  const [row] = await executor
    .select({ id: notifications.id })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(
      and(
        eq(users.facilityId, facilityId),
        eq(notifications.type, 'stock'),
        eq(notifications.link, link),
        gte(notifications.createdAt, startOfDay(now)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function facilityStaff(
  executor: Executor,
  facilityId: string,
  roles: ('PHARMACIST' | 'DIRECTOR')[],
) {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), inArray(users.role, roles), eq(users.isActive, true)),
    );
  return rows.map((r) => r.id);
}

/**
 * After stock changed: items at or below their reorder level alert the facility's pharmacists
 * (and its directors when an item ran out), at most once per item per day.
 */
export async function alertLowStock(
  executor: Executor,
  facilityId: string,
  itemIds: string[],
  now = new Date(),
) {
  if (!itemIds.length) return;
  const levels = await stockLevels(facilityId, { itemIds, now }, executor);
  for (const l of levels) {
    const out = l.onHand <= 0;
    const low = !out && l.reorderLevel > 0 && l.onHand <= l.reorderLevel;
    if (!out && !low) continue;
    const link = `/pharmacy/stock?item=${l.itemId}`;
    if (await alreadyNotifiedToday(executor, facilityId, link, now)) continue;
    const recipients = await facilityStaff(
      executor,
      facilityId,
      out ? ['PHARMACIST', 'DIRECTOR'] : ['PHARMACIST'],
    );
    await notifyUsers(
      recipients,
      {
        type: 'stock',
        title: out ? 'Out of stock: {item}' : 'Low stock: {item}',
        vars: { item: itemLabel(l) },
        important: out,
        link,
      },
      executor,
    );
  }
}

/**
 * Flags batches that still hold stock and expire within EXPIRY_ALERT_DAYS: the facility's
 * pharmacists get one notification per batch per day. Called when stock is viewed (no separate
 * worker is needed) and exported for tests. Returns the batches that were flagged.
 */
export async function checkExpiries(facilityId: string, now = new Date(), executor: Executor = db) {
  const today = isoDay(now);
  const by = isoDay(addDays(now, EXPIRY_ALERT_DAYS));
  const rows = await executor
    .select({
      id: stockBatches.id,
      batchNumber: stockBatches.batchNumber,
      expiryDate: stockBatches.expiryDate,
      name: medicationCatalog.name,
      strength: medicationCatalog.strength,
      form: medicationCatalog.form,
    })
    .from(stockBatches)
    .innerJoin(medicationCatalog, eq(medicationCatalog.id, stockBatches.itemId))
    .where(
      and(
        eq(stockBatches.facilityId, facilityId),
        gt(stockBatches.quantity, 0),
        gte(stockBatches.expiryDate, today),
        sql`${stockBatches.expiryDate} <= ${by}`,
      ),
    );
  const flagged: typeof rows = [];
  for (const b of rows) {
    const link = `/pharmacy/stock?batch=${b.id}`;
    if (await alreadyNotifiedToday(executor, facilityId, link, now)) continue;
    const recipients = await facilityStaff(executor, facilityId, ['PHARMACIST']);
    await notifyUsers(
      recipients,
      {
        type: 'stock',
        title: 'Batch {batch} of {item} expires on {date}',
        vars: { batch: b.batchNumber, item: itemLabel(b), date: b.expiryDate },
        link,
      },
      executor,
    );
    flagged.push(b);
  }
  return flagged;
}

/** The catalogue item a prescription's free-text medication most likely refers to. */
export async function catalogCandidates(medication: string, executor: Executor = db) {
  const words = medication
    .toLowerCase()
    .replace(/[^a-z0-9/ ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  const first = words[0];
  if (!first) return [];
  return executor
    .select({
      id: medicationCatalog.id,
      name: medicationCatalog.name,
      form: medicationCatalog.form,
      strength: medicationCatalog.strength,
      unit: medicationCatalog.unit,
      atcCode: medicationCatalog.atcCode,
    })
    .from(medicationCatalog)
    .where(
      and(
        eq(medicationCatalog.isActive, true),
        sql`${medicationCatalog.name} ILIKE ${`%${first}%`}`,
      ),
    )
    .orderBy(medicationCatalog.name, medicationCatalog.strength)
    .limit(10);
}

/** National availability of each (essential) item across facilities – no patient data. */
export async function nationalAvailability(opts: { essentialOnly?: boolean; now?: Date } = {}) {
  const today = isoDay(opts.now ?? new Date());
  const result = await db.execute<{
    item_id: string;
    name: string;
    strength: string | null;
    form: string;
    unit: string;
    atc_code: string | null;
    is_essential: boolean;
    facility_id: string;
    facility_name: string;
    on_hand: number;
    reorder_level: number;
    stocked: boolean;
  }>(sql`
    SELECT c.id AS item_id, c.name, c.strength, c.form, c.unit, c.atc_code, c.is_essential,
      f.id AS facility_id, f.name AS facility_name,
      coalesce((SELECT sum(b.quantity) FROM stock_batches b
                WHERE b.item_id = c.id AND b.facility_id = f.id AND b.expiry_date >= ${today}), 0)::int AS on_hand,
      coalesce((SELECT s.reorder_level FROM stock_settings s
                WHERE s.item_id = c.id AND s.facility_id = f.id), 0)::int AS reorder_level,
      (EXISTS (SELECT 1 FROM stock_batches b WHERE b.item_id = c.id AND b.facility_id = f.id)
        OR EXISTS (SELECT 1 FROM stock_settings s WHERE s.item_id = c.id AND s.facility_id = f.id)) AS stocked
    FROM medication_catalog c
    CROSS JOIN facilities f
    WHERE c.is_active ${opts.essentialOnly ? sql`AND c.is_essential` : sql``}
      AND EXISTS (SELECT 1 FROM stock_batches b WHERE b.facility_id = f.id)
    ORDER BY c.name, c.strength, f.name`);
  const items = new Map<
    string,
    {
      itemId: string;
      name: string;
      strength: string | null;
      form: string;
      unit: string;
      atcCode: string | null;
      isEssential: boolean;
      totalUnits: number;
      ok: number;
      low: number;
      out: number;
      outFacilities: string[];
      lowFacilities: string[];
    }
  >();
  for (const r of result.rows) {
    let it = items.get(r.item_id);
    if (!it) {
      it = {
        itemId: r.item_id,
        name: r.name,
        strength: r.strength,
        form: r.form,
        unit: r.unit,
        atcCode: r.atc_code,
        isEssential: r.is_essential,
        totalUnits: 0,
        ok: 0,
        low: 0,
        out: 0,
        outFacilities: [],
        lowFacilities: [],
      };
      items.set(r.item_id, it);
    }
    const onHand = Number(r.on_hand);
    it.totalUnits += onHand;
    // Only facilities that stock the item count; a facility that never carried it is not "out".
    if (!r.stocked) continue;
    if (onHand <= 0) {
      it.out++;
      it.outFacilities.push(r.facility_name);
    } else if (Number(r.reorder_level) > 0 && onHand <= Number(r.reorder_level)) {
      it.low++;
      it.lowFacilities.push(r.facility_name);
    } else it.ok++;
  }
  return [...items.values()];
}

/** Batches touched by a movement list – used to decide which items to re-check. */
export async function itemIdsForBatches(executor: Executor, batchIds: string[]) {
  if (!batchIds.length) return [];
  const rows = await executor
    .select({ itemId: stockBatches.itemId })
    .from(stockBatches)
    .where(inArray(stockBatches.id, batchIds));
  return [...new Set(rows.map((r) => r.itemId))];
}

export { stockSettings };
