import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { env } from '../src/config/env.js';
import { db } from '../src/db/client.js';
import { auditLogs, labResults } from '../src/db/schema.js';
import { clearIndicatorCache } from '../src/modules/monitoring/monitoring.service.js';
import { toCef } from '../src/modules/monitoring/monitoring.routes.js';
import { api, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});

describe('/metrics', () => {
  it('exposes Prometheus text with HELP/TYPE lines and route patterns, not ids', async () => {
    await api()
      .get(`/api/v1/patients/${w.patient.id}/summary`)
      .set(bearer(w.tokens.doctor))
      .expect(200);
    const res = await api().get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('# HELP pacient_http_requests_total');
    expect(res.text).toContain('# TYPE pacient_http_request_duration_seconds histogram');
    expect(res.text).toContain('route="/api/v1/patients/:id/summary"');
    expect(res.text).not.toContain(w.patient.id);
    expect(res.text).toMatch(/pacient_db_up 1/);
    expect(res.text).toContain('pacient_critical_results_unacknowledged');
  });

  it('counts requests', async () => {
    const count = (text: string) => {
      const m =
        /pacient_http_requests_total\{method="GET",route="\/health\/live",status="200"\} (\d+)/.exec(
          text,
        );
      return m ? Number(m[1]) : 0;
    };
    const before = count((await api().get('/metrics')).text);
    await api().get('/health/live');
    await api().get('/health/live');
    const after = count((await api().get('/metrics')).text);
    expect(after - before).toBe(2);
  });

  it('requires the bearer token when METRICS_TOKEN is set', async () => {
    const saved = env.METRICS_TOKEN;
    env.METRICS_TOKEN = 'test-metrics-token-0123456789';
    try {
      expect((await api().get('/metrics')).status).toBe(401);
      expect((await api().get('/metrics').set(bearer('wrong-token'))).status).toBe(401);
      expect(
        (await api().get('/metrics').set(bearer('test-metrics-token-0123456789'))).status,
      ).toBe(200);
    } finally {
      env.METRICS_TOKEN = saved;
    }
  });
});

describe('/api/v1/monitoring/health', () => {
  it('gives the Ministry national indicators and directors their facility only', async () => {
    // A critical result for the world facility's doctor.
    await db.insert(labResults).values({
      patientId: w.patient.id,
      orderedById: w.users.doctor.id,
      testName: 'Kalium',
      value: '7.1',
      unit: 'mmol/L',
      flag: 'CRITICAL',
      status: 'FINAL',
      collectedAt: new Date(Date.now() - 3_600_000),
      createdAt: new Date(Date.now() - 3_600_000),
    });
    clearIndicatorCache();
    const nat = await api().get('/api/v1/monitoring/health').set(bearer(w.tokens.ministry));
    expect(nat.status).toBe(200);
    expect(nat.body.scope).toBe('national');
    expect(nat.body.database.up).toBe(true);
    expect(nat.body.indicators.criticalResultsUnacknowledgedOver30m).toBeGreaterThanOrEqual(1);

    const own = await api().get('/api/v1/monitoring/health').set(bearer(w.tokens.director));
    expect(own.body.scope).toBe('facility');
    expect(own.body.indicators.criticalResultsUnacknowledged).toBeGreaterThanOrEqual(1);
    const other = await api().get('/api/v1/monitoring/health').set(bearer(w.tokens.otherDirector));
    expect(other.body.indicators.criticalResultsUnacknowledged).toBe(0);
    expect(JSON.stringify(nat.body)).not.toContain(w.patient.id);

    for (const token of [w.tokens.doctor, w.tokens.nurse, w.tokens.patient]) {
      expect((await api().get('/api/v1/monitoring/health').set(bearer(token))).status).toBe(403);
    }
  });
});

describe('audit export', () => {
  const range = () => {
    const to = new Date(Date.now() + 60_000).toISOString();
    const from = new Date(Date.now() - 86_400_000).toISOString();
    return { from, to };
  };

  it('streams JSON lines with all audit fields and audits the export', async () => {
    const { from, to } = range();
    const res = await api()
      .get('/api/v1/monitoring/audit-export')
      .query({ from, to, format: 'jsonl' })
      .set(bearer(w.tokens.ministry))
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.on('data', (c: Buffer) => (data += c.toString()));
        r.on('end', () => cb(null, data));
      });
    expect(res.status).toBe(200);
    const lines = (res.body as string)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(0);
    expect(Object.keys(lines[0])).toEqual(
      expect.arrayContaining(['occurredAt', 'actorUserId', 'action', 'patientId', 'ipAddress']),
    );
    const [row] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'audit.exported'), eq(auditLogs.actorUserId, w.users.ministry.id)),
      );
    expect(row).toBeTruthy();
  });

  it('formats CEF and escapes separators', async () => {
    const { from, to } = range();
    const res = await api()
      .get('/api/v1/monitoring/audit-export')
      .query({ from, to, format: 'cef' })
      .set(bearer(w.tokens.ministry))
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.on('data', (c: Buffer) => (data += c.toString()));
        r.on('end', () => cb(null, data));
      });
    expect(res.status).toBe(200);
    const first = (res.body as string).split('\n')[0]!;
    expect(first).toMatch(/^CEF:0\|Pacient\|Pacient EHR\|[^|]+\|[^|]+\|[^|]+\|\d+\|rt=\d+/);
  });

  it('limits the range to 31 days and the role to the Ministry', async () => {
    const from = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const to = new Date().toISOString();
    expect(
      (
        await api()
          .get('/api/v1/monitoring/audit-export')
          .query({ from, to })
          .set(bearer(w.tokens.ministry))
      ).status,
    ).toBe(400);
    const { from: f, to: t } = range();
    expect(
      (
        await api()
          .get('/api/v1/monitoring/audit-export')
          .query({ from: f, to: t })
          .set(bearer(w.tokens.director))
      ).status,
    ).toBe(403);
  });

  it('rejects an inverted range', async () => {
    const now = Date.now();
    const res = await api()
      .get('/api/v1/monitoring/audit-export')
      .query({ from: new Date(now).toISOString(), to: new Date(now - 60_000).toISOString() })
      .set(bearer(w.tokens.ministry));
    expect(res.status).toBe(400);
  });

  it('pages through more than one batch without duplicates or gaps (microsecond timestamps)', async () => {
    const run = randomUUID();
    // 1,500 rows inside one millisecond: a millisecond cursor would repeat or skip rows.
    await db.execute(sql`
      INSERT INTO audit_logs (occurred_at, action, outcome, metadata)
      SELECT timestamptz '2001-02-03 04:05:06.000000+00' + (g * interval '0.5 microsecond'),
             'test.pagination', 'SUCCESS', jsonb_build_object('run', ${run}::text)
      FROM generate_series(1, 1500) g`);
    const res = await api()
      .get('/api/v1/monitoring/audit-export')
      .query({ from: '2001-02-03', to: '2001-02-04', format: 'jsonl' })
      .set(bearer(w.tokens.ministry))
      .buffer(true)
      .parse((r, cb) => {
        let data = '';
        r.on('data', (c: Buffer) => (data += c.toString()));
        r.on('end', () => cb(null, data));
      });
    expect(res.status).toBe(200);
    const ours = (res.body as string)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { id: string; metadata: { run?: string } | null })
      .filter((l) => l.metadata?.run === run);
    expect(ours).toHaveLength(1500);
    expect(new Set(ours.map((l) => l.id)).size).toBe(1500);
  });
});

describe('toCef', () => {
  it('escapes header pipes and extension equals signs, backslashes and newlines', () => {
    const line = toCef(
      {
        id: '00000000-0000-0000-0000-000000000001',
        occurred_at: new Date('2026-01-02T03:04:05.000Z'),
        actor_user_id: null,
        actor_role: 'DOCTOR',
        actor_facility_id: null,
        action: 'record|viewed',
        resource_type: 'patient',
        resource_id: null,
        patient_id: null,
        outcome: 'SUCCESS',
        ip_address: '10.0.0.1',
        user_agent: 'agent=x\\y\nnext',
        request_id: null,
        metadata: null,
      },
      '1.2.3',
    );
    expect(line.startsWith('CEF:0|Pacient|Pacient EHR|1.2.3|record\\|viewed|')).toBe(true);
    expect(line).toContain('rt=1767323045000');
    expect(line).toContain('requestClientApplication=agent\\=x\\\\y next');
    expect(line).not.toContain('\n');
    expect(line).not.toContain('suid=');
  });
});
