import { timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { db } from '../../db/client.js';
import { badRequest, forbidden, unauthorized } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import {
  eventLoopDelaySeconds,
  renderGauge,
  renderHttpMetrics,
  serverErrorCount,
} from '../../lib/metrics.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { dbLatencyMs, indicators, poolStats, versionInfo } from './monitoring.service.js';

/* ------------------------------------------------------------------ /metrics (Prometheus) */

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7).trim() : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * GET /metrics at the app root. With METRICS_TOKEN a bearer token is required; without it,
 * production answers only connections from the same host (the proxy address is never trusted
 * for this – the socket address is used).
 */
export async function metricsHandler(req: Request, res: Response) {
  if (env.METRICS_TOKEN) {
    if (!tokenMatches(req.get('authorization'), env.METRICS_TOKEN)) throw unauthorized();
  } else if (isProd && !LOOPBACK.has(req.socket.remoteAddress ?? '')) {
    throw forbidden('Metrics are only available from this host or with METRICS_TOKEN');
  }
  const [ind, latency] = await Promise.all([indicators(), dbLatencyMs()]);
  const mem = process.memoryUsage();
  const loop = eventLoopDelaySeconds();
  const pool = poolStats();
  const g = (name: string, help: string, value: number) =>
    renderGauge(`pacient_${name}`, help, [{ value }]);
  const body = [
    renderHttpMetrics(),
    g('process_uptime_seconds', 'Process uptime in seconds.', Math.round(process.uptime())),
    renderGauge('pacient_process_memory_bytes', 'Process memory by type.', [
      { labels: { type: 'rss' }, value: mem.rss },
      { labels: { type: 'heap_used' }, value: mem.heapUsed },
      { labels: { type: 'heap_total' }, value: mem.heapTotal },
      { labels: { type: 'external' }, value: mem.external },
    ]),
    renderGauge('pacient_event_loop_delay_seconds', 'Event loop delay since the last scrape.', [
      { labels: { stat: 'mean' }, value: loop.mean },
      { labels: { stat: 'p99' }, value: loop.p99 },
      { labels: { stat: 'max' }, value: loop.max },
    ]),
    renderGauge('pacient_db_pool_connections', 'Database pool connections by state.', [
      { labels: { state: 'total' }, value: pool.total },
      { labels: { state: 'idle' }, value: pool.idle },
      { labels: { state: 'waiting' }, value: pool.waiting },
    ]),
    g('db_up', 'Whether the database answered a ping (1/0).', latency === null ? 0 : 1),
    g('db_latency_seconds', 'Database ping latency in seconds.', (latency ?? 0) / 1000),
    renderGauge('pacient_outbox_messages', 'Email/SMS outbox messages by channel and state.', [
      { labels: { channel: 'email', state: 'pending' }, value: ind.emailPending },
      { labels: { channel: 'email', state: 'failed_7d' }, value: ind.emailFailed },
      { labels: { channel: 'sms', state: 'pending' }, value: ind.smsPending },
      { labels: { channel: 'sms', state: 'failed_7d' }, value: ind.smsFailed },
    ]),
    renderGauge('pacient_outbox_oldest_pending_seconds', 'Age of the oldest pending message.', [
      { labels: { channel: 'email' }, value: ind.emailOldestPendingSeconds },
      { labels: { channel: 'sms' }, value: ind.smsOldestPendingSeconds },
    ]),
    g(
      'critical_results_unacknowledged',
      'Critical laboratory results not yet acknowledged.',
      ind.criticalResultsUnacknowledged,
    ),
    g(
      'critical_results_unacknowledged_over_30m',
      'Critical laboratory results unacknowledged for more than 30 minutes.',
      ind.criticalResultsUnacknowledgedOver30m,
    ),
    g(
      'escalated_results_pending',
      'Escalated critical results still unacknowledged.',
      ind.escalatedResultsPending,
    ),
    g(
      'news2_high_unacknowledged',
      'High NEWS2 scores (last 24 h) not acknowledged.',
      ind.news2HighUnacknowledged,
    ),
    g(
      'ed_waiting_beyond_target',
      'Emergency department patients waiting beyond their triage target.',
      ind.edWaitingBeyondTarget,
    ),
    g('transfusion_requests_open', 'Open transfusion requests.', ind.transfusionRequestsOpen),
    g(
      'integration_messages_needing_review',
      'Laboratory messages held for manual review.',
      ind.integrationMessagesNeedingReview,
    ),
    g('lab_orders_waiting', 'Laboratory orders not yet resulted.', ind.labOrdersWaiting),
    g(
      'case_report_drafts_over_24h',
      'Notifiable disease case reports in draft for more than 24 hours.',
      ind.caseReportDraftsOver24h,
    ),
    g('facilities_in_downtime', 'Facilities currently in downtime mode.', ind.facilitiesInDowntime),
  ].join('\n');
  res.type('text/plain; version=0.0.4; charset=utf-8').set('Cache-Control', 'no-store');
  res.send(`${body}\n`);
}

/* ------------------------------------------------------------------ /api/v1/monitoring */

export const monitoringRouter = Router();
monitoringRouter.use(authenticate);

/** Health summary for the System health page (Ministry: national, director: own facility). */
monitoringRouter.get('/health', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId : null;
  if (ctx.role === 'DIRECTOR' && !facilityId) throw forbidden();
  const [ind, latency] = await Promise.all([indicators(facilityId), dbLatencyMs()]);
  const mem = process.memoryUsage();
  res.json({
    generatedAt: new Date().toISOString(),
    scope: ind.scope,
    api: {
      ...versionInfo(),
      uptimeSeconds: Math.round(process.uptime()),
      memoryRssBytes: mem.rss,
      serverErrorsSinceStart: serverErrorCount(),
    },
    database: { up: latency !== null, latencyMs: latency, pool: poolStats() },
    indicators: ind,
  });
});

/* ------------------------------------------------------------------ audit export (SIEM) */

const ExportQuery = z
  .object({
    from: z.string().datetime({ offset: true }).or(z.string().date()),
    to: z.string().datetime({ offset: true }).or(z.string().date()),
    format: z.enum(['jsonl', 'cef']).default('jsonl'),
  })
  .transform((q) => ({ ...q, fromDate: new Date(q.from), toDate: new Date(q.to) }));

type AuditRow = {
  id: string;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_role: string | null;
  actor_facility_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  patient_id: string | null;
  outcome: string;
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
  metadata: Record<string, unknown> | null;
  /** Full-precision (microsecond) timestamp for the keyset cursor; JS Dates keep only ms. */
  cursor_at?: string;
};

const cefHeader = (v: string) => v.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
const cefExt = (v: string) => v.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\r?\n/g, ' ');

/** One audit entry as an ArcSight Common Event Format line. */
export function toCef(r: AuditRow, version: string): string {
  const severity = r.outcome === 'SUCCESS' ? (r.action.includes('emergency') ? 6 : 3) : 7;
  const ext: [string, string | null][] = [
    ['rt', String(new Date(r.occurred_at).getTime())],
    ['suid', r.actor_user_id],
    ['suser', r.actor_role],
    ['cs1Label', 'facilityId'],
    ['cs1', r.actor_facility_id],
    ['cs2Label', 'resourceType'],
    ['cs2', r.resource_type],
    ['cs3Label', 'resourceId'],
    ['cs3', r.resource_id],
    ['duid', r.patient_id],
    ['outcome', r.outcome],
    ['src', r.ip_address],
    ['requestClientApplication', r.user_agent],
    ['externalId', r.id],
    ['cs4Label', 'requestId'],
    ['cs4', r.request_id],
  ];
  const extension = ext
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${cefExt(String(v))}`)
    .join(' ');
  return `CEF:0|Pacient|Pacient EHR|${cefHeader(version)}|${cefHeader(r.action)}|${cefHeader(r.action)}|${severity}|${extension}`;
}

monitoringRouter.get('/audit-export', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ExportQuery, req.query);
  if (Number.isNaN(q.fromDate.getTime()) || Number.isNaN(q.toDate.getTime())) {
    throw badRequest('Invalid date range');
  }
  if (q.toDate <= q.fromDate) throw badRequest('"to" must be after "from"');
  if (q.toDate.getTime() - q.fromDate.getTime() > 31 * 86_400_000) {
    throw badRequest('Export at most 31 days at a time');
  }
  // Audit the export itself before streaming (the exported range is recorded).
  await audit({
    action: AuditAction.AUDIT_EXPORTED,
    actor: ctx,
    resourceType: 'audit_log',
    meta: requestMeta(req),
    metadata: { from: q.fromDate.toISOString(), to: q.toDate.toISOString(), format: q.format },
  });
  const version = versionInfo().release ?? versionInfo().version;
  const stamp = q.fromDate.toISOString().slice(0, 10);
  res
    .status(200)
    .type(q.format === 'jsonl' ? 'application/x-ndjson' : 'text/plain')
    .set(
      'Content-Disposition',
      `attachment; filename="pacient-audit-${stamp}.${q.format === 'jsonl' ? 'jsonl' : 'cef'}"`,
    )
    .set('Cache-Control', 'no-store');

  // Keyset pagination keeps memory flat for large ranges.
  let after: { at: string; id: string } | null = null;
  for (;;) {
    const cursor: { at: string; id: string } | null = after;
    const page: { rows: AuditRow[] } = await db.execute<AuditRow>(sql`
      SELECT id, occurred_at, actor_user_id, actor_role, actor_facility_id, action, resource_type,
             resource_id, patient_id, outcome, host(ip_address) AS ip_address, user_agent,
             request_id, metadata, occurred_at::text AS cursor_at
      FROM audit_logs
      WHERE occurred_at >= ${q.fromDate.toISOString()} AND occurred_at < ${q.toDate.toISOString()}
        ${cursor ? sql`AND (occurred_at, id) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : sql``}
      ORDER BY occurred_at, id
      LIMIT 1000`);
    if (!page.rows.length) break;
    const lines = page.rows.map((r) =>
      q.format === 'jsonl'
        ? JSON.stringify({
            id: r.id,
            occurredAt: new Date(r.occurred_at).toISOString(),
            actorUserId: r.actor_user_id,
            actorRole: r.actor_role,
            actorFacilityId: r.actor_facility_id,
            action: r.action,
            resourceType: r.resource_type,
            resourceId: r.resource_id,
            patientId: r.patient_id,
            outcome: r.outcome,
            ipAddress: r.ip_address,
            userAgent: r.user_agent,
            requestId: r.request_id,
            metadata: r.metadata,
          })
        : toCef(r, version),
    );
    if (!res.write(`${lines.join('\n')}\n`)) await new Promise((r) => res.once('drain', r));
    const last: AuditRow = page.rows[page.rows.length - 1]!;
    after = { at: last.cursor_at!, id: last.id };
    if (page.rows.length < 1000) break;
  }
  res.end();
});
