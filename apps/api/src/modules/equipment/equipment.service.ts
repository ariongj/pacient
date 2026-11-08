import { and, eq, like, lt, ne, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  careUnits,
  equipmentEvents,
  equipmentItems,
  notifications,
  users,
} from '../../db/schema.js';
import { isTest } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { parseCsv } from '../licences/licences.service.js';

/**
 * Medical equipment register: items per facility (and ward), an append-only history of services,
 * faults, repairs and status changes, and the maintenance schedule (next service = last service +
 * interval). Equipment is not personal data: nothing here refers to a patient.
 *
 * Managing the register (adding items, recording services and repairs) is the facility director's
 * job; any doctor, nurse or pharmacist of the facility can report a fault from the ward.
 */

export const CATEGORIES = [
  'VENTILATOR',
  'MONITOR',
  'DEFIBRILLATOR',
  'INFUSION_PUMP',
  'IMAGING',
  'LAB_ANALYSER',
  'DIALYSIS',
  'OTHER',
] as const;
export type Category = (typeof CATEGORIES)[number];
export const CRITICALITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export const STATUSES = ['IN_SERVICE', 'OUT_OF_SERVICE', 'IN_MAINTENANCE', 'RETIRED'] as const;
export type EquipmentStatus = (typeof STATUSES)[number];
export const EVENT_KINDS = ['SERVICE', 'FAULT', 'REPAIR', 'STATUS'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Equipment shown in the ward availability panel (life support and monitoring). */
export const CRITICAL_CATEGORIES: Category[] = [
  'VENTILATOR',
  'DEFIBRILLATOR',
  'MONITOR',
  'INFUSION_PUMP',
];
/** Equipment counted in the Ministry's national view. */
export const NATIONAL_CATEGORIES: Category[] = ['VENTILATOR', 'DEFIBRILLATOR', 'DIALYSIS'];

/** Items due for service within this many days are listed as "due soon". */
export const DUE_SOON_DAYS = 30;
/** High-criticality items out of service longer than this are escalated to the director. */
export const OUT_OF_SERVICE_ALERT_HOURS = 24;

export const todayIso = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

/** Next service date from the last service (or the commissioning date) and the interval. */
export function nextDueFrom(
  base: string | null | undefined,
  intervalDays: number | null | undefined,
): string | null {
  if (!base || !intervalDays) return null;
  return addDays(base, intervalDays);
}

export type MaintenanceState = 'OVERDUE' | 'DUE_SOON' | 'OK' | 'NONE';

export function maintenanceState(
  item: { nextServiceDue: string | null; status: string },
  today = todayIso(),
): MaintenanceState {
  if (item.status === 'RETIRED' || !item.nextServiceDue) return 'NONE';
  if (item.nextServiceDue < today) return 'OVERDUE';
  if (daysBetween(today, item.nextServiceDue) <= DUE_SOON_DAYS) return 'DUE_SOON';
  return 'OK';
}

/** The status an item has after an event (null: unchanged). */
export function statusAfterEvent(
  kind: EventKind,
  item: { criticality: string; status: string },
  requested: EquipmentStatus | null | undefined,
): EquipmentStatus | null {
  switch (kind) {
    case 'SERVICE':
      return 'IN_SERVICE';
    case 'REPAIR':
      return requested ?? 'IN_SERVICE';
    case 'FAULT':
      // A fault in life-support equipment always takes it out of service until it is repaired.
      if (item.criticality === 'HIGH') return 'OUT_OF_SERVICE';
      return requested ?? null;
    case 'STATUS':
      return requested ?? null;
  }
}

/* ------------------------------------------------------------------------------ CSV import -- */

export const CSV_COLUMNS = [
  'assetTag',
  'category',
  'name',
  'manufacturer',
  'model',
  'serialNumber',
  'unitCode',
  'criticality',
  'serviceIntervalDays',
  'commissionedOn',
  'lastServiceAt',
] as const;

export interface CsvRow {
  line: number;
  assetTag: string;
  category: Category;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  unitCode: string | null;
  criticality: (typeof CRITICALITIES)[number];
  serviceIntervalDays: number | null;
  commissionedOn: string | null;
  lastServiceAt: string | null;
}

export interface CsvError {
  line: number;
  message: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => ISO_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Validates a CSV file (header row with the column names, any order). */
export function validateCsv(text: string): { rows: CsvRow[]; errors: CsvError[] } {
  const table = parseCsv(text.replace(/^\uFEFF/, '')).filter((r) => r.some((c) => c.trim()));
  const errors: CsvError[] = [];
  const rows: CsvRow[] = [];
  if (!table.length) return { rows, errors: [{ line: 1, message: 'The file is empty' }] };
  const header = table[0]!.map((h) => h.trim());
  const missing = ['assetTag', 'category', 'name', 'criticality'].filter(
    (c) => !header.includes(c),
  );
  if (missing.length) {
    return {
      rows,
      errors: [{ line: 1, message: `Missing columns: ${missing.join(', ')}` }],
    };
  }
  const col = (r: string[], name: string) => {
    const i = header.indexOf(name);
    return i >= 0 ? (r[i] ?? '').trim() : '';
  };
  const seen = new Set<string>();
  table.slice(1).forEach((r, idx) => {
    const line = idx + 2;
    const problems: string[] = [];
    const assetTag = col(r, 'assetTag').toUpperCase();
    const category = col(r, 'category').toUpperCase();
    const criticality = col(r, 'criticality').toUpperCase();
    const name = col(r, 'name');
    const interval = col(r, 'serviceIntervalDays');
    const commissionedOn = col(r, 'commissionedOn');
    const lastServiceAt = col(r, 'lastServiceAt');
    if (!/^[A-Z0-9][A-Z0-9-]{1,39}$/.test(assetTag)) problems.push('invalid asset tag');
    else if (seen.has(assetTag)) problems.push('asset tag repeated in the file');
    if (!(CATEGORIES as readonly string[]).includes(category)) problems.push('unknown category');
    if (!(CRITICALITIES as readonly string[]).includes(criticality))
      problems.push('unknown criticality');
    if (name.length < 2 || name.length > 200) problems.push('name must be 2–200 characters');
    if (interval && !/^\d{1,4}$/.test(interval)) problems.push('invalid service interval');
    if (interval && Number(interval) === 0) problems.push('invalid service interval');
    if (commissionedOn && !validDate(commissionedOn)) problems.push('invalid commissioning date');
    if (lastServiceAt && !validDate(lastServiceAt)) problems.push('invalid last service date');
    if (problems.length) {
      errors.push({ line, message: problems.join('; ') });
      return;
    }
    seen.add(assetTag);
    rows.push({
      line,
      assetTag,
      category: category as Category,
      name,
      manufacturer: col(r, 'manufacturer') || null,
      model: col(r, 'model') || null,
      serialNumber: col(r, 'serialNumber') || null,
      unitCode: col(r, 'unitCode') || null,
      criticality: criticality as CsvRow['criticality'],
      serviceIntervalDays: interval ? Number(interval) : null,
      commissionedOn: commissionedOn || null,
      lastServiceAt: lastServiceAt || null,
    });
  });
  return { rows, errors };
}

/* -------------------------------------------------------------------------- recipients ----- */

export async function directorsOf(facilityId: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR'), eq(users.isActive, true)),
    );
  return rows.map((r) => r.id);
}

/* ------------------------------------------------------------------------------ worker ---- */

const WORKER_TYPE = 'equipment';

/** Sends a notification once: the dedupe key travels in the notification link. */
async function notifyOnce(
  key: string,
  facilityId: string,
  n: { title: string; vars: Record<string, string | number | Date>; itemId: string },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    const [already] = await tx
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.type, WORKER_TYPE), like(notifications.link, `%${key}%`)))
      .limit(1);
    if (already) return false;
    const recipients = await directorsOf(facilityId, tx);
    if (!recipients.length) return false;
    await notifyUsers(
      recipients,
      {
        type: WORKER_TYPE,
        title: n.title,
        vars: n.vars,
        link: `/equipment?item=${n.itemId}&${key}`,
      },
      tx,
    );
    return true;
  });
}

/**
 * Daily: tells the facility's directors (once per item and due date) when equipment becomes due
 * for service, and (once per outage) when life-support equipment has been out of service for more
 * than 24 hours.
 */
export async function runEquipmentWorkerOnce(now = new Date()): Promise<number> {
  const today = todayIso(now);
  let sent = 0;
  const overdue = await db
    .select({
      id: equipmentItems.id,
      facilityId: equipmentItems.facilityId,
      assetTag: equipmentItems.assetTag,
      name: equipmentItems.name,
      nextServiceDue: equipmentItems.nextServiceDue,
    })
    .from(equipmentItems)
    .where(and(ne(equipmentItems.status, 'RETIRED'), lt(equipmentItems.nextServiceDue, today)));
  for (const item of overdue) {
    const key = `eqo=${item.id}:${item.nextServiceDue}`;
    if (
      await notifyOnce(key, item.facilityId, {
        title: 'Equipment overdue for service: {tag} {name}',
        vars: { tag: item.assetTag, name: item.name },
        itemId: item.id,
      })
    ) {
      sent++;
    }
  }

  // Life-support equipment out of service: the outage starts at the last event that set the status.
  const cutoff = new Date(now.getTime() - OUT_OF_SERVICE_ALERT_HOURS * 3_600_000);
  const down = await db
    .select({
      id: equipmentItems.id,
      facilityId: equipmentItems.facilityId,
      assetTag: equipmentItems.assetTag,
      name: equipmentItems.name,
      eventId: sql<string | null>`(
        SELECT e.id FROM ${equipmentEvents} e
        WHERE e.item_id = equipment_items.id AND e.status = 'OUT_OF_SERVICE'
        ORDER BY e.occurred_at DESC LIMIT 1)`,
      since: sql<string | null>`(
        SELECT max(e.occurred_at) FROM ${equipmentEvents} e
        WHERE e.item_id = equipment_items.id AND e.status = 'OUT_OF_SERVICE')`,
    })
    .from(equipmentItems)
    .where(
      and(eq(equipmentItems.criticality, 'HIGH'), eq(equipmentItems.status, 'OUT_OF_SERVICE')),
    );
  for (const item of down) {
    if (!item.since || new Date(item.since) > cutoff) continue;
    const key = `eqd=${item.id}:${item.eventId ?? 'none'}`;
    if (
      await notifyOnce(key, item.facilityId, {
        title: 'Life-support equipment out of service for more than 24 hours: {tag} {name}',
        vars: { tag: item.assetTag, name: item.name },
        itemId: item.id,
      })
    ) {
      sent++;
    }
  }
  return sent;
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

function runSafely() {
  runEquipmentWorkerOnce().then(
    (n) => n && logger.info({ notifications: n }, 'Equipment maintenance notifications sent'),
    (err: unknown) => logger.error({ err }, 'Equipment worker failed'),
  );
}

/** Daily (first run 15 minutes after start). Not started in tests. */
export function startEquipmentWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 15 * 60_000);
  first.unref();
  timer = setInterval(runSafely, 24 * 60 * 60_000);
  timer.unref();
}

export function stopEquipmentWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}

/* ----------------------------------------------------------------------------- helpers ---- */

/** Active units of a facility (for selects and the availability panel). */
export async function unitsOf(facilityId: string, executor: Executor = db) {
  return executor
    .select({ id: careUnits.id, name: careUnits.name, code: careUnits.code, type: careUnits.type })
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.isActive, true)))
    .orderBy(careUnits.name);
}

export async function unitOfFacility(
  facilityId: string,
  unitId: string | null | undefined,
  executor: Executor = db,
) {
  if (!unitId) return null;
  const [u] = await executor
    .select({ id: careUnits.id })
    .from(careUnits)
    .where(and(eq(careUnits.id, unitId), eq(careUnits.facilityId, facilityId)));
  return u ?? undefined;
}
