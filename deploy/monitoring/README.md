# Monitoring and observability

Everything an operations team needs to watch Pacient in production: Prometheus metrics, alert
rules, a Grafana dashboard, log shipping and an audit export for the SIEM. The Ministry also gets
a built-in **System health** page (`/ministry/system`) that works without any of this.

| File                     | Purpose                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `prometheus.yml`         | Scrape configuration (bearer token, 15 s interval)          |
| `alerts.yml`             | Alert rules: availability, latency, queues, clinical safety |
| `grafana-dashboard.json` | Import into Grafana (Dashboards → New → Import)             |

## 1. Metrics endpoint

The API serves Prometheus text format (0.0.4) at `GET /metrics` on its own port (4000).

- **Production**: set `METRICS_TOKEN` (at least 16 characters, e.g. `openssl rand -hex 32`) and
  scrape with `Authorization: Bearer <token>`. Without a token the endpoint only answers requests
  whose socket comes from the loopback interface (forwarded headers are ignored), so a public
  proxy can never expose it.
- **Development/test**: open without a token.
- The public nginx (`apps/web/nginx.conf`) returns 404 for `/metrics` and only proxies `/api/`.
  Scrape the `api` container over the internal network instead.
- Set `APP_VERSION` (for example the git SHA or release tag) so dashboards and the System health
  page show which build is running.

```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://api:4000/metrics | head
```

Store the token for Prometheus in `/etc/prometheus/secrets/pacient-metrics-token` (mode 0400).

### Metrics

HTTP (labels use the **route pattern**, e.g. `/api/v1/patients/:id/summary`, never ids, so
cardinality stays bounded and no identifiers reach the metrics store; unknown paths are `unmatched`,
SSE streams are excluded):

| Metric                                  | Type      | Labels                      |
| --------------------------------------- | --------- | --------------------------- |
| `pacient_http_requests_total`           | counter   | `method`, `route`, `status` |
| `pacient_http_request_duration_seconds` | histogram | `method`, `route`           |

Runtime and database:

| Metric                             | Labels                                              |
| ---------------------------------- | --------------------------------------------------- |
| `pacient_process_uptime_seconds`   |                                                     |
| `pacient_process_memory_bytes`     | `type` = rss, heap_used, heap_total, external       |
| `pacient_event_loop_delay_seconds` | `stat` = mean, p99, max (since the previous scrape) |
| `pacient_db_pool_connections`      | `state` = total, idle, waiting                      |
| `pacient_db_up`                    |                                                     |
| `pacient_db_latency_seconds`       |                                                     |

Queues and clinical safety (cheap `COUNT` queries, cached for 15 s so frequent scrapes do not load
the database; all aggregate, no patient data):

| Metric                                             | Meaning                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| `pacient_outbox_messages{channel,state}`           | Email/SMS outbox: `pending`, `failed_7d`       |
| `pacient_outbox_oldest_pending_seconds{channel}`   | Age of the oldest undelivered message          |
| `pacient_critical_results_unacknowledged`          | Critical lab results without acknowledgement   |
| `pacient_critical_results_unacknowledged_over_30m` | … older than 30 minutes                        |
| `pacient_escalated_results_pending`                | Escalated critical results still open          |
| `pacient_news2_high_unacknowledged`                | High NEWS2 scores (24 h) not acknowledged      |
| `pacient_ed_waiting_beyond_target`                 | ED patients waiting beyond their triage target |
| `pacient_transfusion_requests_open`                | Transfusion requests not yet issued            |
| `pacient_integration_messages_needing_review`      | Inbound lab messages held for manual matching  |
| `pacient_lab_orders_waiting`                       | Lab orders without a final result              |
| `pacient_case_report_drafts_over_24h`              | Notifiable-disease reports still in draft      |
| `pacient_facilities_in_downtime`                   | Facilities working on paper                    |

Not yet exported (planned): number of open SSE connections and last-run timestamps of the
background workers (outbox sender, escalation sweep, reminders). Those modules do not expose the
values yet; once they do, add `pacient_sse_connections` and
`pacient_worker_last_run_timestamp_seconds{worker}` plus a "worker stalled" alert.

## 2. Prometheus, Alertmanager and Grafana

```yaml
# docker compose excerpt, on the same network as the api service
prometheus:
  image: prom/prometheus:v2.53.0
  volumes:
    - ./deploy/monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    - ./deploy/monitoring/alerts.yml:/etc/prometheus/alerts.yml:ro
    - ./secrets/pacient-metrics-token:/etc/prometheus/secrets/pacient-metrics-token:ro
```

Check the files before deploying:

```bash
promtool check config deploy/monitoring/prometheus.yml
```

```bash
promtool check rules deploy/monitoring/alerts.yml
```

Alerts carry `severity: page` (outage or patient-safety risk: wake someone) or
`severity: ticket` (next working hours). Route them in Alertmanager accordingly. The clinical
alerts complement, not replace, the in-app escalation: they tell the operations centre that the
in-app chain is not being answered.

Import `grafana-dashboard.json` and pick the Prometheus data source. To link it from the Ministry
System health page, build the web app with `VITE_GRAFANA_URL=https://grafana.example/d/pacient-system-health`.

### Disk space and backup age (placeholders)

`PacientDiskSpaceLow` needs [node_exporter](https://github.com/prometheus/node_exporter) on the
database host. `PacientBackupTooOld` expects the backup job to write a textfile metric after each
successful run, for example at the end of `deploy/backup.sh`:

```bash
echo "pacient_backup_last_success_timestamp_seconds $(date +%s)" > /var/lib/node_exporter/textfile/pacient_backup.prom
```

## 3. Log shipping

In production the API logs one JSON object per line to stdout (pino). Credentials, cookies and
tokens are redacted; clinical data is never logged, only identifiers and the request id
(`X-Request-Id`, also stored on every audit entry, so a log line can be joined to the audit
trail). Ship stdout with any collector:

**Vector** (to Loki):

```toml
[sources.pacient]
type = "docker_logs"
include_containers = ["pacient-api"]

[transforms.parse]
type = "remap"
inputs = ["pacient"]
source = '. = merge(., parse_json!(.message))'

[sinks.loki]
type = "loki"
inputs = ["parse"]
endpoint = "http://loki:3100"
labels = { app = "pacient", level = "{{ level }}" }
encoding.codec = "json"
```

**Fluent Bit**:

```ini
[INPUT]
    Name   tail
    Path   /var/lib/docker/containers/*/*.log
    Parser docker
    Tag    pacient.*

[FILTER]
    Name   parser
    Match  pacient.*
    Key_Name log
    Parser json

[OUTPUT]
    Name   loki
    Match  pacient.*
    Host   loki
    Labels app=pacient
```

Keep high-cardinality fields (request id, user id) out of Loki labels; query them as JSON fields.
Retain application logs for at most 90 days; the audit log in the database is the legal record.

## 4. Audit export for the SIEM

`GET /api/v1/monitoring/audit-export?from=&to=&format=jsonl|cef` (Ministry only, also on the
System health page):

- `from`/`to`: ISO date (`2026-11-01`) or date-time with offset; `to` is exclusive; at most
  31 days per request.
- `jsonl`: one JSON object per audit entry (`id`, `occurredAt`, `actorUserId`, `actorRole`,
  `actorFacilityId`, `action`, `resourceType`, `resourceId`, `patientId`, `outcome`,
  `ipAddress`, `userAgent`, `requestId`, `metadata`). Suits Loki, Elastic and Splunk.
- `cef`: ArcSight Common Event Format, `CEF:0|Pacient|Pacient EHR|<version>|<action>|<action>|<severity>|…`
  with `rt` (epoch ms), `suid`, `suser` (role), `duid` (patient id), `src`, `outcome`,
  `externalId` (audit id) and custom strings for facility, resource and request id. Severity 3
  for normal access, 6 for emergency (break-glass) access, 7 for failures and denials.
- The response is streamed in pages of 1,000 rows (keyset on timestamp and id), so a month of
  activity does not load into memory.
- Every export is itself audited (`audit.exported`, with the range and format).

The export contains patient identifiers (pseudonymous UUIDs, no names). Treat the SIEM as a
system holding personal health data: restrict access, encrypt at rest and apply the same retention
as the audit log.

A nightly pull for a SIEM collector, using a Ministry service account's access token:

```bash
curl -sf -H "Authorization: Bearer $TOKEN" "https://pacient.example/api/v1/monitoring/audit-export?from=$(date -u -d yesterday +%F)&to=$(date -u +%F)&format=cef" -o "pacient-audit-$(date -u -d yesterday +%F).cef"
```

## 5. Health endpoints

| Endpoint                        | Who                                | Use                                            |
| ------------------------------- | ---------------------------------- | ---------------------------------------------- |
| `GET /health/live`              | anyone                             | Liveness probe (process up)                    |
| `GET /health/ready`             | anyone                             | Readiness probe (database reachable)           |
| `GET /api/v1/monitoring/health` | Ministry; directors (own facility) | Versions, uptime, DB latency, pool, indicators |
| `GET /metrics`                  | Prometheus (token)                 | Everything above as time series                |
