import { and, asc, count, desc, eq, inArray, ne, notLike, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { auditLogs, clinicalResourceVersions, facilities, users } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { paginated, toOffset, type Pagination } from '../../lib/pagination.js';
import {
  VERSIONED_TABLES,
  type FieldKind,
  type TableDef,
  type VersionedTable,
} from './definitions.js';

/**
 * Version history of clinical records. The database trigger `clinical_version_capture()` copies
 * every insert, update and delete of the versioned tables into clinical_resource_versions; this
 * service reads it back, attributes each version to a person through the audit entry written in
 * the same transaction (audit_logs.tx_id) and turns consecutive versions into field changes.
 */

/** Refusal for patients and guardians (see history.routes.ts for why). */
export const NOT_FOR_PATIENTS =
  'The change history of a record is available to the treating care team. Your access log shows who opened your record.';

export type VersionRow = typeof clinicalResourceVersions.$inferSelect;
type Data = Record<string, unknown>;
type Value = string | number | boolean | null;

export interface Actor {
  userId: string | null;
  name: string | null;
  role: string | null;
  action: string;
  at: string;
}

export interface FieldValue {
  field: string;
  label: string;
  kind: FieldKind;
  value: Value;
}

export interface FieldChange {
  field: string;
  label: string;
  kind: FieldKind;
  before: Value;
  after: Value;
}

const tableDef = (table: string): TableDef => VERSIONED_TABLES[table as VersionedTable];

/** All versions of one record, oldest first. */
export async function versionsOf(table: VersionedTable, resourceId: string) {
  return db
    .select()
    .from(clinicalResourceVersions)
    .where(
      and(
        eq(clinicalResourceVersions.tableName, table),
        eq(clinicalResourceVersions.resourceId, resourceId),
      ),
    )
    .orderBy(asc(clinicalResourceVersions.version));
}

/**
 * Versions of a record that belongs to the patient now (its latest version names the patient).
 * Earlier versions may name a duplicate record that was merged into this one.
 */
export async function versionsForPatient(
  table: VersionedTable,
  resourceId: string,
  patientId: string,
) {
  const rows = await versionsOf(table, resourceId);
  if (!rows.length || rows.at(-1)!.patientId !== patientId) {
    throw notFound('No such record in this patient’s chart');
  }
  return rows;
}

/** The patient a record belongs to now, from its latest version (null when unknown). */
export async function currentPatientOf(table: VersionedTable, resourceId: string) {
  const [row] = await db
    .select({ patientId: clinicalResourceVersions.patientId })
    .from(clinicalResourceVersions)
    .where(
      and(
        eq(clinicalResourceVersions.tableName, table),
        eq(clinicalResourceVersions.resourceId, resourceId),
      ),
    )
    .orderBy(desc(clinicalResourceVersions.version))
    .limit(1);
  return row?.patientId ?? null;
}

/**
 * Who made each version: the audit entry of the same transaction about the same record, or else
 * about the same patient. Reads (views, exports) never count. Versions written without an audit
 * entry in their transaction (laboratory interface, data loads) have no actor.
 */
export async function attribute(rows: VersionRow[]): Promise<Map<string, Actor | null>> {
  const out = new Map<string, Actor | null>();
  const txIds = [...new Set(rows.filter((r) => r.operation !== 'BASELINE').map((r) => r.txId))];
  const entries = txIds.length
    ? await db
        .select({
          txId: auditLogs.txId,
          resourceId: auditLogs.resourceId,
          patientId: auditLogs.patientId,
          action: auditLogs.action,
          occurredAt: auditLogs.occurredAt,
          userId: auditLogs.actorUserId,
          role: auditLogs.actorRole,
          name: users.fullName,
        })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.actorUserId))
        .where(
          and(
            inArray(auditLogs.txId, txIds),
            eq(auditLogs.outcome, 'SUCCESS'),
            notLike(auditLogs.action, '%.viewed'),
            notLike(auditLogs.action, '%exported'),
          ),
        )
        .orderBy(asc(auditLogs.occurredAt))
    : [];
  for (const r of rows) {
    if (r.operation === 'BASELINE') {
      out.set(r.id, null);
      continue;
    }
    const sameTx = entries.filter((e) => e.txId === r.txId);
    const hit =
      sameTx.find((e) => e.resourceId === r.resourceId) ??
      sameTx.find((e) => r.patientId !== null && e.patientId === r.patientId);
    out.set(
      r.id,
      hit
        ? {
            userId: hit.userId,
            name: hit.name,
            role: hit.role,
            action: hit.action,
            at: hit.occurredAt.toISOString(),
          }
        : null,
    );
  }
  return out;
}

/** Names for the user and facility ids that appear in the shown columns of the versions. */
async function lookups(table: VersionedTable, rows: VersionRow[]) {
  const def = tableDef(table);
  const userIds = new Set<string>();
  const facilityIds = new Set<string>();
  for (const r of rows) {
    for (const [col, fd] of Object.entries(def.fields)) {
      const v = r.data[col];
      if (typeof v !== 'string') continue;
      if (fd.kind === 'user') userIds.add(v);
      if (fd.kind === 'facility') facilityIds.add(v);
    }
  }
  const [u, f] = await Promise.all([
    userIds.size
      ? db
          .select({ id: users.id, name: users.fullName })
          .from(users)
          .where(inArray(users.id, [...userIds]))
      : Promise.resolve([]),
    facilityIds.size
      ? db
          .select({ id: facilities.id, name: facilities.name })
          .from(facilities)
          .where(inArray(facilities.id, [...facilityIds]))
      : Promise.resolve([]),
  ]);
  return {
    users: new Map(u.map((x) => [x.id, x.name])),
    facilities: new Map(f.map((x) => [x.id, x.name])),
  };
}

type Lookups = Awaited<ReturnType<typeof lookups>>;

function display(kind: FieldKind, raw: unknown, names: Lookups): Value {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (kind) {
    case 'user':
      return names.users.get(String(raw)) ?? null;
    case 'facility':
      return names.facilities.get(String(raw)) ?? null;
    case 'masked':
      return true;
    case 'bool':
      return Boolean(raw);
    case 'number':
      return Number(raw);
    default:
      return String(raw);
  }
}

/** The shown columns of one version, without empty ones. */
export function stateOf(table: VersionedTable, data: Data, names: Lookups): FieldValue[] {
  return Object.entries(tableDef(table).fields).flatMap(([field, fd]) => {
    const value = display(fd.kind, data[field], names);
    return value === null ? [] : [{ field, label: fd.label, kind: fd.kind, value }];
  });
}

/** Shown columns that differ between two versions (all non-empty ones for the first version). */
export function diffOf(
  table: VersionedTable,
  before: Data | null,
  after: Data,
  names: Lookups,
): FieldChange[] {
  return Object.entries(tableDef(table).fields).flatMap(([field, fd]) => {
    const a = before ? display(fd.kind, before[field], names) : null;
    const b = display(fd.kind, after[field], names);
    if (before && JSON.stringify(before[field] ?? null) === JSON.stringify(after[field] ?? null)) {
      return [];
    }
    // The first version lists what was filled in; unticked boxes are not news.
    if (!before && (b === null || b === false)) return [];
    // A masked value that changed shows as a change even though both sides read "set".
    if (a === b && fd.kind !== 'masked') return [];
    return [{ field, label: fd.label, kind: fd.kind, before: a, after: b }];
  });
}

/** Only the patient changed: the record was moved here from a merged duplicate (or back). */
export const isMergeMove = (r: VersionRow) =>
  r.operation === 'UPDATE' && r.changedFields?.length === 1 && r.changedFields[0] === 'patient_id';

/** The full history of one record for the chart, newest first. */
export async function recordHistory(table: VersionedTable, rows: VersionRow[]) {
  const [actors, names] = await Promise.all([attribute(rows), lookups(table, rows)]);
  const def = tableDef(table);
  const versions = rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1]!.data : null;
    const deleted = r.operation === 'DELETE';
    return {
      version: r.version,
      operation: r.operation,
      recordedAt: r.recordedAt.toISOString(),
      by: actors.get(r.id) ?? null,
      mergedMove: isMergeMove(r),
      title: def.title(r.data),
      changes: deleted ? [] : diffOf(table, prev, r.data, names),
      state: stateOf(table, r.data, names),
    };
  });
  const last = rows.at(-1)!;
  return {
    table,
    tableLabel: def.label,
    resourceId: last.resourceId,
    title: def.title(last.data),
    deleted: last.operation === 'DELETE',
    versions: versions.reverse(),
  };
}

/** Recent changes in a patient's chart (no baseline rows), newest first. */
export async function recentChanges(
  patientId: string,
  opts: Pagination & { table?: VersionedTable },
) {
  const where = and(
    eq(clinicalResourceVersions.patientId, patientId),
    ne(clinicalResourceVersions.operation, 'BASELINE'),
    opts.table ? eq(clinicalResourceVersions.tableName, opts.table) : undefined,
  );
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select()
      .from(clinicalResourceVersions)
      .where(where)
      .orderBy(desc(clinicalResourceVersions.recordedAt), desc(clinicalResourceVersions.version))
      .limit(toOffset(opts).limit)
      .offset(toOffset(opts).offset),
    db.select({ total: count() }).from(clinicalResourceVersions).where(where),
  ]);
  const actors = await attribute(rows);
  // Previous versions, so updates can name the fields that really changed on screen.
  const prevKeys = rows
    .filter((r) => r.version > 1)
    .map((r) => [r.tableName, r.resourceId, r.version - 1] as const);
  const previous = prevKeys.length
    ? await db
        .select()
        .from(clinicalResourceVersions)
        .where(
          sql`(${clinicalResourceVersions.tableName}, ${clinicalResourceVersions.resourceId}, ${clinicalResourceVersions.version}) IN (${sql.join(
            prevKeys.map(([t, id, v]) => sql`(${t}, ${id}::uuid, ${v})`),
            sql`, `,
          )})`,
        )
    : [];
  const prevOf = new Map(previous.map((p) => [`${p.tableName}:${p.resourceId}:${p.version}`, p]));
  const items = rows.map((r) => {
    const table = r.tableName as VersionedTable;
    const def = tableDef(table);
    const prev = prevOf.get(`${r.tableName}:${r.resourceId}:${r.version - 1}`);
    const fields =
      r.operation === 'UPDATE'
        ? Object.entries(def.fields)
            .filter(
              ([col]) =>
                JSON.stringify(prev?.data[col] ?? null) !== JSON.stringify(r.data[col] ?? null),
            )
            .map(([field, fd]) => ({ field, label: fd.label }))
        : [];
    return {
      id: r.id,
      table,
      tableLabel: def.label,
      resourceId: r.resourceId,
      title: def.title(r.data),
      version: r.version,
      operation: r.operation,
      recordedAt: r.recordedAt.toISOString(),
      by: actors.get(r.id) ?? null,
      mergedMove: isMergeMove(r),
      changedFields: fields,
    };
  });
  return paginated(items, Number(total), opts);
}

/** snake_case row data → the camelCase shape the FHIR mappers take. */
export function camel(data: Data): Data {
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
      v,
    ]),
  );
}
