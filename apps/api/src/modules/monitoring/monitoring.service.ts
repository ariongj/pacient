import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db, pool } from '../../db/client.js';

/**
 * Operational and clinical-safety indicators for monitoring. Counts only – never patient data.
 * Computed with cheap COUNT queries and cached for 15 seconds per scope.
 */
export interface Indicators {
  scope: 'national' | 'facility';
  emailPending: number;
  emailFailed: number;
  emailOldestPendingSeconds: number;
  smsPending: number;
  smsFailed: number;
  smsOldestPendingSeconds: number;
  criticalResultsUnacknowledged: number;
  criticalResultsUnacknowledgedOver30m: number;
  escalatedResultsPending: number;
  news2HighUnacknowledged: number;
  edWaitingBeyondTarget: number;
  transfusionRequestsOpen: number;
  integrationMessagesNeedingReview: number;
  labOrdersWaiting: number;
  caseReportDraftsOver24h: number;
  facilitiesInDowntime: number;
}

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; value: Indicators }>();

const n = (v: unknown) => Number(v ?? 0) || 0;

export async function indicators(facilityId: string | null = null): Promise<Indicators> {
  const key = facilityId ?? 'national';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const f = facilityId;
  const result = await db.execute<Record<string, unknown>>(sql`
    SELECT
      (SELECT count(*) FROM email_outbox WHERE ${f}::uuid IS NULL AND status IN ('PENDING', 'SENDING')) AS email_pending,
      (SELECT count(*) FROM email_outbox WHERE ${f}::uuid IS NULL AND status = 'FAILED'
         AND created_at > now() - interval '7 days') AS email_failed,
      (SELECT coalesce(extract(epoch FROM now() - min(created_at)), 0) FROM email_outbox
         WHERE ${f}::uuid IS NULL AND status IN ('PENDING', 'SENDING')) AS email_oldest,
      (SELECT count(*) FROM sms_outbox WHERE ${f}::uuid IS NULL AND status IN ('PENDING', 'SENDING')) AS sms_pending,
      (SELECT count(*) FROM sms_outbox WHERE ${f}::uuid IS NULL AND status = 'FAILED'
         AND created_at > now() - interval '7 days') AS sms_failed,
      (SELECT coalesce(extract(epoch FROM now() - min(created_at)), 0) FROM sms_outbox
         WHERE ${f}::uuid IS NULL AND status IN ('PENDING', 'SENDING')) AS sms_oldest,
      (SELECT count(*) FROM lab_results r JOIN users u ON u.id = r.ordered_by_id
         WHERE r.flag = 'CRITICAL' AND r.acknowledged_at IS NULL AND r.superseded_by_id IS NULL
           AND (${f}::uuid IS NULL OR u.facility_id = ${f})) AS critical,
      (SELECT count(*) FROM lab_results r JOIN users u ON u.id = r.ordered_by_id
         WHERE r.flag = 'CRITICAL' AND r.acknowledged_at IS NULL AND r.superseded_by_id IS NULL
           AND r.created_at < now() - interval '30 minutes'
           AND (${f}::uuid IS NULL OR u.facility_id = ${f})) AS critical_30,
      (SELECT count(DISTINCT e.lab_result_id) FROM result_escalations e
         JOIN lab_results r ON r.id = e.lab_result_id JOIN users u ON u.id = r.ordered_by_id
         WHERE r.acknowledged_at IS NULL AND r.superseded_by_id IS NULL
           AND (${f}::uuid IS NULL OR u.facility_id = ${f})) AS escalated,
      (SELECT count(*) FROM early_warning_scores s LEFT JOIN admissions a ON a.id = s.admission_id
         WHERE s.risk = 'HIGH' AND s.acknowledged_at IS NULL AND s.computed_at > now() - interval '24 hours'
           AND (${f}::uuid IS NULL OR a.facility_id = ${f})) AS news_high,
      (SELECT count(*) FROM ed_visits v
         WHERE v.status = 'WAITING' AND (${f}::uuid IS NULL OR v.facility_id = ${f})
           AND now() - v.arrived_at > CASE v.triage_level
             WHEN 1 THEN interval '0 minutes' WHEN 2 THEN interval '10 minutes'
             WHEN 3 THEN interval '60 minutes' WHEN 4 THEN interval '120 minutes'
             WHEN 5 THEN interval '240 minutes' ELSE interval '15 minutes' END) AS ed_breaches,
      (SELECT count(*) FROM transfusion_requests t
         WHERE t.status IN ('REQUESTED', 'SAMPLE_RECEIVED', 'CROSSMATCHED')
           AND (${f}::uuid IS NULL OR t.facility_id = ${f})) AS transfusions,
      (SELECT count(*) FROM integration_messages m JOIN integration_clients c ON c.id = m.client_id
         WHERE m.status = 'NEEDS_REVIEW' AND (${f}::uuid IS NULL OR c.facility_id = ${f})) AS review,
      (SELECT count(*) FROM lab_orders o
         WHERE o.status IN ('ORDERED', 'RECEIVED', 'IN_PROGRESS')
           AND (${f}::uuid IS NULL OR o.facility_id = ${f})) AS lab_waiting,
      (SELECT count(*) FROM case_reports c
         WHERE c.status = 'DRAFT' AND c.created_at < now() - interval '24 hours'
           AND (${f}::uuid IS NULL OR c.facility_id = ${f})) AS case_drafts,
      (SELECT count(*) FROM facilities WHERE downtime_since IS NOT NULL
         AND (${f}::uuid IS NULL OR id = ${f})) AS downtime
  `);
  const r = result.rows[0] ?? {};
  const value: Indicators = {
    scope: facilityId ? 'facility' : 'national',
    emailPending: n(r.email_pending),
    emailFailed: n(r.email_failed),
    emailOldestPendingSeconds: Math.round(n(r.email_oldest)),
    smsPending: n(r.sms_pending),
    smsFailed: n(r.sms_failed),
    smsOldestPendingSeconds: Math.round(n(r.sms_oldest)),
    criticalResultsUnacknowledged: n(r.critical),
    criticalResultsUnacknowledgedOver30m: n(r.critical_30),
    escalatedResultsPending: n(r.escalated),
    news2HighUnacknowledged: n(r.news_high),
    edWaitingBeyondTarget: n(r.ed_breaches),
    transfusionRequestsOpen: n(r.transfusions),
    integrationMessagesNeedingReview: n(r.review),
    labOrdersWaiting: n(r.lab_waiting),
    caseReportDraftsOver24h: n(r.case_drafts),
    facilitiesInDowntime: n(r.downtime),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Clears the indicator cache (tests). */
export function clearIndicatorCache() {
  cache.clear();
}

export async function dbLatencyMs(): Promise<number | null> {
  const start = process.hrtime.bigint();
  try {
    await pool.query('SELECT 1');
    return Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
  } catch {
    return null;
  }
}

export function poolStats() {
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

let packageVersion = '0.0.0';
try {
  packageVersion = (
    JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      version: string;
    }
  ).version;
} catch {
  /* running from an unusual layout */
}

export const versionInfo = () => ({
  version: packageVersion,
  release: env.APP_VERSION ?? null,
  node: process.version,
});
