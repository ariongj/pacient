# Performance and capacity

`npm run load-test` (`scripts/load-test.mjs`) signs in with the demo accounts and replays a
weighted mix of the busiest read paths: doctor worklist, chart summary, vitals and prescriptions,
patient search, notification counts, the bed, early warning and emergency boards, the director
dashboard, the patient's own record and sign-in. It reports requests per second, p50/p95/p99
latency and errors per scenario, and exits with 1 when the error rate is above 1% or a p95 is above
`--p95` milliseconds (default 500).

```bash
RATE_LIMIT_PER_MINUTE=100000 npm run dev -w apps/api   # in one terminal: lift the per-user limit
npm run load-test -- --duration 60 --concurrency 40      # in another
```

Run it against a development or staging database loaded with `npm run db:seed` – never against
production (it uses the demo accounts).

## Baseline (development container, 4 vCPU, one API process, PostgreSQL 16 on the same host)

Measured while other test databases were running on the same machine, so these are conservative.

| Scenario            | 1 user p50 (ms) | 40 users p50 / p95 (ms) | Share of requests |
| ------------------- | --------------: | ----------------------: | ----------------: |
| Doctor worklist     |               7 |               130 / 163 |               10% |
| Chart summary       |               7 |               133 / 168 |               16% |
| Chart vitals        |               4 |               107 / 135 |                7% |
| Patient search      |               3 |                 47 / 62 |                9% |
| Notification count  |               2 |                 46 / 62 |               18% |
| Bed board           |               4 |                 68 / 89 |                7% |
| Early warning board |               5 |                88 / 112 |                7% |
| Emergency board     |               6 |               149 / 182 |                7% |
| Patient own record  |               6 |               110 / 140 |                7% |
| Sign-in (argon2id)  |              34 |               186 / 219 |                1% |

Overall: **about 390 requests per second with 40 concurrent users and no errors**. Single requests
take 2–9 ms (sign-in ~35 ms, by design: password hashing is deliberately slow), so the latency at
40 users is queueing in one Node.js process, which is CPU-bound – not slow queries.

## What this means for a national deployment

A busy clinician generates roughly one request every 5–10 seconds (page loads, polling of
notification counts and boards; live updates arrive over server-sent events, not polling). One API
process therefore serves about 2,000–4,000 concurrently active users at these latencies. Kosovo has
in the order of 15,000–20,000 health workers, of whom only a fraction are active at the same time,
plus patients using the portal.

Recommended starting point: **3–4 API processes** (or containers) behind the reverse proxy, each
with `DB_POOL_MAX=10–20`, one PostgreSQL primary with a streaming replica (see
[deploy/README.md](../deploy/README.md) for PITR), and PgBouncer when the number of processes grows.
Re-run the load test after major changes and before go-live with production-sized data.

## Things that are per process today

- **Rate limiting** keeps its counters in memory: with N processes the effective per-user limit is
  N × `RATE_LIMIT_PER_MINUTE`. Use a shared store (e.g. Redis) or sticky sessions if exact limits
  matter.
- **Video visit signalling** is kept in memory: route `/api/v1/video` with sticky sessions (see
  [ARCHITECTURE.md](ARCHITECTURE.md)).
- **Background workers** run in every process; they use database locks (`FOR UPDATE SKIP LOCKED`,
  advisory locks, conditional `UPDATE … RETURNING` claims or idempotent inserts) so several processes do not do the same work twice. When
  adding a worker, keep that property and test it.
- **Live updates** use PostgreSQL `LISTEN/NOTIFY`, so they reach users on every process.

## Settings

| Variable                | Default | Meaning                                                     |
| ----------------------- | ------: | ----------------------------------------------------------- |
| `RATE_LIMIT_PER_MINUTE` |     600 | API requests per user (or per IP when anonymous) per minute |
| `DB_POOL_MAX`           |      10 | Database connections per API process                        |
