#!/usr/bin/env node
/**
 * Load test of the main read paths (sign-in, worklists, boards, chart summary, notifications,
 * patient search, portal) with a realistic mix of roles. Development/staging only: it signs in
 * with the demo accounts from `npm run db:seed`.
 *
 *   node scripts/load-test.mjs [--base http://localhost:4000] [--duration 60] [--concurrency 40]
 *        [--ramp 10] [--json]
 *
 * Start the API with a raised per-user limit first, e.g. RATE_LIMIT_PER_MINUTE=100000, or the
 * limiter (600 requests per user per minute) is what you measure. Reports throughput, latency
 * percentiles and errors per scenario; exits with 1 when the error rate is above 1% or the p95 of
 * any scenario is above --p95 milliseconds (default 500).
 */
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://localhost:4000').replace(/\/$/, '');
const DURATION = Number(arg('duration', '60')) * 1000;
const CONCURRENCY = Number(arg('concurrency', '40'));
const RAMP = Number(arg('ramp', '10')) * 1000;
const P95_LIMIT = Number(arg('p95', '500'));
const JSON_OUT = process.argv.includes('--json');
const PASSWORD = 'Pacient-Demo-2026';
const API = `${BASE}/api/v1`;

async function call(path, token, init = {}) {
  const started = performance.now();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const body = await res.arrayBuffer();
  return { status: res.status, ms: performance.now() - started, body };
}

async function signIn(email) {
  const res = await call('/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`Sign-in failed for ${email}: ${res.status}`);
  const json = JSON.parse(Buffer.from(res.body).toString('utf8'));
  if (!json.accessToken) throw new Error(`${email} needs two-step sign-in; use a dev database`);
  return json.accessToken;
}

const tokens = {
  doctor: await signIn('doctor@pacient.local'),
  nurse: await signIn('nurse@pacient.local'),
  reception: await signIn('reception@pacient.local'),
  director: await signIn('director@pacient.local'),
  patient: await signIn('patient@pacient.local'),
};

const me = JSON.parse(Buffer.from((await call('/auth/me', tokens.patient)).body).toString('utf8'));
const ownRecord = me.patientId;

// Patients whose chart the demo doctor may open (care team).
const list = await call('/patients?pageSize=100', tokens.doctor);
const candidates = JSON.parse(Buffer.from(list.body).toString('utf8')).items.map((p) => p.id);
const charts = [];
for (const id of candidates) {
  if ((await call(`/patients/${id}/summary`, tokens.doctor)).status === 200) charts.push(id);
  if (charts.length >= 30) break;
}
if (!charts.length) throw new Error('The demo doctor has no patients – seed the database first');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const SEARCHES = ['Ga', 'Kr', 'Ber', 'Hox', '11000'];

/** Weighted scenarios: roughly what a working hospital day looks like. */
const SCENARIOS = [
  { name: 'doctor worklist', weight: 8, run: () => call('/worklist', tokens.doctor) },
  {
    name: 'chart summary',
    weight: 14,
    run: () => call(`/patients/${pick(charts)}/summary`, tokens.doctor),
  },
  {
    name: 'chart vitals',
    weight: 6,
    run: () => call(`/patients/${pick(charts)}/vitals`, tokens.doctor),
  },
  {
    name: 'chart prescriptions',
    weight: 6,
    run: () => call(`/patients/${pick(charts)}/prescriptions`, tokens.doctor),
  },
  {
    name: 'patient search',
    weight: 8,
    run: () => call(`/patients?q=${pick(SEARCHES)}&pageSize=20`, tokens.reception),
  },
  {
    name: 'notifications count',
    weight: 16,
    run: () =>
      call('/notifications/unread-count', pick([tokens.doctor, tokens.nurse, tokens.patient])),
  },
  { name: 'bed board', weight: 6, run: () => call('/hospital/board', tokens.nurse) },
  { name: 'early warning board', weight: 6, run: () => call('/early-warning/board', tokens.nurse) },
  { name: 'emergency board', weight: 6, run: () => call('/ed/board', tokens.nurse) },
  { name: 'director dashboard', weight: 3, run: () => call('/stats/facility', tokens.director) },
  {
    name: 'portal own record',
    weight: 6,
    run: () => call(`/patients/${ownRecord}/summary`, tokens.patient),
  },
  {
    name: 'sign-in',
    weight: 1,
    run: () =>
      call('/auth/login', null, {
        method: 'POST',
        body: JSON.stringify({ email: 'nurse@pacient.local', password: PASSWORD }),
      }),
  },
];
const totalWeight = SCENARIOS.reduce((a, s) => a + s.weight, 0);
const choose = () => {
  let r = Math.random() * totalWeight;
  for (const s of SCENARIOS) if ((r -= s.weight) < 0) return s;
  return SCENARIOS[0];
};

const stats = new Map(SCENARIOS.map((s) => [s.name, { ms: [], errors: 0, statuses: {} }]));
const started = Date.now();
const deadline = started + DURATION;
async function worker(index) {
  // Ramp up: workers start spread over the ramp period.
  await new Promise((r) => setTimeout(r, (RAMP * index) / CONCURRENCY));
  while (Date.now() < deadline) {
    const s = choose();
    const st = stats.get(s.name);
    try {
      const r = await s.run();
      st.ms.push(r.ms);
      st.statuses[r.status] = (st.statuses[r.status] ?? 0) + 1;
      if (r.status >= 400) st.errors++;
    } catch {
      st.errors++;
      st.statuses.network = (st.statuses.network ?? 0) + 1;
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
const elapsed = (Date.now() - started) / 1000;

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0;
const rows = [...stats].map(([name, st]) => {
  const sorted = [...st.ms].sort((a, b) => a - b);
  const n = st.ms.length + (st.statuses.network ?? 0);
  return {
    name,
    requests: n,
    rps: +(n / elapsed).toFixed(1),
    p50: +pct(sorted, 50).toFixed(0),
    p95: +pct(sorted, 95).toFixed(0),
    p99: +pct(sorted, 99).toFixed(0),
    errors: st.errors,
    statuses: st.statuses,
  };
});
const all = rows.reduce((a, r) => a + r.requests, 0);
const errors = rows.reduce((a, r) => a + r.errors, 0);
const summary = {
  base: BASE,
  concurrency: CONCURRENCY,
  seconds: +elapsed.toFixed(1),
  requests: all,
  rps: +(all / elapsed).toFixed(1),
  errorRate: all ? +(errors / all).toFixed(4) : 0,
};
const failing = rows.filter((r) => r.p95 > P95_LIMIT).map((r) => r.name);

if (JSON_OUT) console.log(JSON.stringify({ summary, scenarios: rows }, null, 2));
else {
  console.log(
    `\n${summary.requests} requests in ${summary.seconds}s – ${summary.rps} req/s, ${CONCURRENCY} concurrent, error rate ${(summary.errorRate * 100).toFixed(2)}%\n`,
  );
  console.log(
    'scenario'.padEnd(22),
    'req'.padStart(7),
    'req/s'.padStart(7),
    'p50'.padStart(6),
    'p95'.padStart(6),
    'p99'.padStart(6),
    'errors'.padStart(7),
    ' statuses',
  );
  for (const r of rows) {
    console.log(
      r.name.padEnd(22),
      String(r.requests).padStart(7),
      String(r.rps).padStart(7),
      `${r.p50}`.padStart(6),
      `${r.p95}`.padStart(6),
      `${r.p99}`.padStart(6),
      String(r.errors).padStart(7),
      ' ' + JSON.stringify(r.statuses),
    );
  }
  if (failing.length) console.log(`\np95 above ${P95_LIMIT} ms: ${failing.join(', ')}`);
}
process.exit(summary.errorRate > 0.01 || failing.length ? 1 : 0);
