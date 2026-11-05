import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { incidentReviewers, users } from '../../db/schema.js';
import type { AuthContext } from '../../lib/http.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';

/** Calendar year in Kosovo (references restart every year). */
export function kosovoYear(d: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade', year: 'numeric' }).format(d),
  );
}

/**
 * Next reference "INC-<year>-<5 digits>". Callers run inside a transaction: the advisory lock
 * serialises concurrent reports (the unique index is the backstop).
 */
export async function nextIncidentReference(tx: Executor, now = new Date()): Promise<string> {
  const year = kosovoYear(now);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('safety_incidents.reference'))`);
  const result = await tx.execute<{ max: string | null }>(sql`
    SELECT max(reference) AS max FROM safety_incidents WHERE reference LIKE ${`INC-${year}-%`}`);
  const last = result.rows[0]?.max;
  const n = last ? Number(last.slice(-5)) + 1 : 1;
  return `INC-${year}-${String(n).padStart(5, '0')}`;
}

/** Active reviewers of a facility: its directors and the named safety leads. */
export async function reviewerIdsFor(facilityId: string, executor: Executor = db) {
  const directors = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR'), eq(users.isActive, true)),
    );
  const leads = await executor
    .select({ id: users.id })
    .from(incidentReviewers)
    .innerJoin(users, eq(users.id, incidentReviewers.userId))
    .where(
      and(
        eq(incidentReviewers.facilityId, facilityId),
        eq(users.facilityId, facilityId),
        eq(users.isActive, true),
      ),
    );
  return [...new Set([...directors, ...leads].map((r) => r.id))];
}

/** Reviewers see and work on their own facility's incidents only. */
export async function isReviewer(ctx: AuthContext, facilityId: string, executor: Executor = db) {
  if (!ctx.facilityId || ctx.facilityId !== facilityId) return false;
  if (ctx.role === 'DIRECTOR') return true;
  if (ctx.role === 'PATIENT' || ctx.role === 'MINISTRY') return false;
  const [row] = await executor
    .select({ userId: incidentReviewers.userId })
    .from(incidentReviewers)
    .where(
      and(eq(incidentReviewers.facilityId, facilityId), eq(incidentReviewers.userId, ctx.userId)),
    );
  return Boolean(row);
}

/** Staff of a facility who may own an action or be named a reviewer. */
export async function facilityStaff(facilityId: string, ids: string[], executor: Executor = db) {
  if (!ids.length) return [];
  return executor
    .select({ id: users.id, fullName: users.fullName, role: users.role })
    .from(users)
    .where(
      and(
        inArray(users.id, ids),
        eq(users.facilityId, facilityId),
        eq(users.isActive, true),
        inArray(users.role, ['DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION', 'DIRECTOR']),
      ),
    );
}

/* ------------------------------------------------------------------------------ aggregates -- */

export interface Cell {
  key: string;
  count: number | null;
  suppressed: boolean;
}

/** Counts below the threshold are hidden (null) so rare events cannot identify anyone. */
export function suppressCells(rows: { key: string; count: number }[]): Cell[] {
  return rows.map((r) =>
    r.count < SMALL_CELL_THRESHOLD
      ? { key: r.key, count: null, suppressed: true }
      : { key: r.key, count: r.count, suppressed: false },
  );
}

/** "YYYY-MM" for the last `months` months (oldest first), in Kosovo time. */
export function monthKeys(months: number, now = new Date()): string[] {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
  });
  const [y, m] = fmt.format(now).split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export function monthSeries(rows: { key: string; count: number }[], months: number, now?: Date) {
  const map = new Map(rows.map((r) => [r.key, r.count]));
  return monthKeys(months, now).map((key) => ({ key, count: map.get(key) ?? 0 }));
}

/** Start of the reporting window (first day of the oldest month, Kosovo time ≈ UTC midnight). */
export function windowStart(months: number, now = new Date()): Date {
  const first = monthKeys(months, now)[0]!;
  return new Date(`${first}-01T00:00:00Z`);
}
