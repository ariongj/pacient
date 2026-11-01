import { Router, type Request } from 'express';
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { badRequest } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';

/**
 * Purpose-specific aggregate reports (blueprint §7). Directors are restricted to their own
 * facility; the Ministry may filter by region or facility. All counts below the small-cell
 * threshold are suppressed, in the API response and in exports alike, and every export is audited.
 */
const Query = z
  .object({
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    region: z.string().trim().max(100).optional(),
    facilityId: z.string().uuid().optional(),
  })
  .transform((q) => {
    const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : new Date();
    const from = q.from
      ? new Date(`${q.from}T00:00:00Z`)
      : new Date(to.getTime() - 90 * 86_400_000);
    return { ...q, from, to };
  })
  .refine((q) => q.from <= q.to, 'from must be before to')
  .refine(
    (q) => q.to.getTime() - q.from.getTime() <= 2 * 366 * 86_400_000,
    'Period may not exceed two years',
  );

type ReportQuery = z.infer<typeof Query>;
const ReportName = z.object({ report: z.enum(['diagnoses', 'activity']) });

function scopeFor(ctx: AuthContext, q: ReportQuery) {
  if (ctx.role === 'DIRECTOR') return { facilityId: ctx.facilityId!, region: undefined };
  return { facilityId: q.facilityId, region: q.region };
}

function facilityFilter(alias: string, scope: { facilityId?: string; region?: string }): SQL {
  const parts: SQL[] = [sql`TRUE`];
  if (scope.facilityId) parts.push(sql`${sql.raw(alias)}.id = ${scope.facilityId}`);
  if (scope.region) parts.push(sql`${sql.raw(alias)}.region = ${scope.region}`);
  return sql.join(parts, sql` AND `);
}

const suppress = (n: number) => (n < SMALL_CELL_THRESHOLD ? null : n);

async function diagnosesReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const result = await db.execute<{
    region: string;
    icd10Code: string;
    description: string;
    patients: number;
  }>(sql`
    SELECT f.region, d.icd10_code AS "icd10Code", min(d.description) AS description,
      count(DISTINCT d.patient_id)::int AS patients
    FROM diagnoses d
    JOIN users u ON u.id = d.doctor_id
    JOIN facilities f ON f.id = u.facility_id
    WHERE d.diagnosed_at BETWEEN ${q.from.toISOString()} AND ${q.to.toISOString()}
      AND ${facilityFilter('f', scope)}
    GROUP BY f.region, d.icd10_code
    ORDER BY patients DESC, f.region, d.icd10_code
    LIMIT 500`);
  const rows = result.rows.map((r) => ({
    region: r.region,
    icd10Code: r.icd10Code,
    description: r.description,
    patients: suppress(r.patients),
    suppressed: r.patients < SMALL_CELL_THRESHOLD,
  }));
  return {
    columns: ['region', 'icd10Code', 'description', 'patients'],
    rows,
  };
}

async function activityReport(ctx: AuthContext, q: ReportQuery) {
  const scope = scopeFor(ctx, q);
  const from = q.from.toISOString();
  const to = q.to.toISOString();
  const result = await db.execute<Record<string, string | number>>(sql`
    SELECT f.code, f.name, f.region,
      (SELECT count(*)::int FROM encounters e WHERE e.facility_id = f.id AND e.started_at BETWEEN ${from} AND ${to}) AS encounters,
      (SELECT count(DISTINCT e.patient_id)::int FROM encounters e WHERE e.facility_id = f.id AND e.started_at BETWEEN ${from} AND ${to}) AS "uniquePatients",
      (SELECT count(*)::int FROM appointments a WHERE a.facility_id = f.id AND a.status = 'COMPLETED' AND a.scheduled_at BETWEEN ${from} AND ${to}) AS "appointmentsCompleted",
      (SELECT count(*)::int FROM appointments a WHERE a.facility_id = f.id AND a.status = 'NO_SHOW' AND a.scheduled_at BETWEEN ${from} AND ${to}) AS "noShows",
      (SELECT count(*)::int FROM referrals r WHERE r.from_facility_id = f.id AND r.created_at BETWEEN ${from} AND ${to}) AS "referralsSent",
      (SELECT count(*)::int FROM referrals r WHERE r.to_facility_id = f.id AND r.created_at BETWEEN ${from} AND ${to}) AS "referralsReceived",
      (SELECT count(*)::int FROM immunizations i WHERE i.facility_id = f.id AND i.administered_at BETWEEN ${from} AND ${to}) AS vaccinations,
      (SELECT count(*)::int FROM emergency_access_grants g JOIN users u ON u.id = g.doctor_id
         WHERE u.facility_id = f.id AND g.created_at BETWEEN ${from} AND ${to}) AS "emergencyAccess"
    FROM facilities f
    WHERE ${facilityFilter('f', scope)}
    ORDER BY f.region, f.name`);
  return {
    columns: [
      'code',
      'name',
      'region',
      'encounters',
      'uniquePatients',
      'appointmentsCompleted',
      'noShows',
      'referralsSent',
      'referralsReceived',
      'vaccinations',
      'emergencyAccess',
    ],
    // Operational counts per facility are not about individuals, but patient counts still follow
    // the suppression rule.
    rows: result.rows.map((r) => ({ ...r, uniquePatients: suppress(Number(r.uniquePatients)) })),
  };
}

const REPORTS = { diagnoses: diagnosesReport, activity: activityReport };

/** CSV with protection against spreadsheet formula injection. */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return (
    [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') +
    '\r\n'
  );
}

async function run(req: Request) {
  const ctx = requireAuth(req);
  const { report } = parse(ReportName, req.params);
  const q = parse(Query, req.query);
  if (ctx.role === 'DIRECTOR' && (q.region || (q.facilityId && q.facilityId !== ctx.facilityId))) {
    throw badRequest('Directors can only report on their own facility');
  }
  const data = await REPORTS[report](ctx, q);
  return { ctx, report, q, data };
}

export const reportsRouter = Router();
reportsRouter.use(authenticate, requireRole('MINISTRY', 'DIRECTOR'));

reportsRouter.get('/:report', async (req, res) => {
  const { q, data } = await run(req);
  res.json({ from: q.from, to: q.to, smallCellThreshold: SMALL_CELL_THRESHOLD, ...data });
});

reportsRouter.get('/:report/export', async (req, res) => {
  const { ctx, report, q, data } = await run(req);
  await audit({
    action: AuditAction.REPORT_EXPORTED,
    actor: ctx,
    resourceType: 'report',
    meta: requestMeta(req),
    metadata: {
      report,
      from: q.from.toISOString(),
      to: q.to.toISOString(),
      region: q.region ?? null,
      facilityId: ctx.role === 'DIRECTOR' ? ctx.facilityId : (q.facilityId ?? null),
      rows: data.rows.length,
    },
  });
  const name = `pacient-${report}-${q.from.toISOString().slice(0, 10)}-to-${q.to.toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(toCsv(data.columns, data.rows as Record<string, unknown>[]));
});
