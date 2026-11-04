import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * Minimal Prometheus metrics (text exposition format 0.0.4) without a client library.
 * Labels are always bounded: HTTP routes are normalised so ids never become label values.
 */
type Labels = Record<string, string>;

const labelKey = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(labels[k]!)}"`)
    .join(',');
const escapeLabel = (v: string) =>
  v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

class Counter {
  private values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(labels: Labels = {}, by = 1) {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  get(labels: Labels = {}) {
    return this.values.get(labelKey(labels)) ?? 0;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return lines.join('\n');
  }
}

class Histogram {
  private series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: number[],
  ) {}
  observe(labels: Labels, value: number) {
    const k = labelKey(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.buckets.forEach((b, i) => {
      if (value <= b) s.counts[i]!++;
    });
    s.sum += value;
    s.count++;
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? ',' : '';
      this.buckets.forEach((b, i) =>
        lines.push(`${this.name}_bucket{${k}${sep}le="${b}"} ${s.counts[i]}`),
      );
      lines.push(`${this.name}_bucket{${k}${sep}le="+Inf"} ${s.count}`);
      lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return lines.join('\n');
  }
}

/** A gauge rendered from values provided at scrape time. */
export function renderGauge(
  name: string,
  help: string,
  samples: { labels?: Labels; value: number }[],
): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const s of samples) {
    const k = s.labels ? labelKey(s.labels) : '';
    lines.push(`${name}${k ? `{${k}}` : ''} ${Number.isFinite(s.value) ? s.value : 0}`);
  }
  return lines.join('\n');
}

export const httpRequests = new Counter(
  'pacient_http_requests_total',
  'HTTP requests by method, route pattern and status code.',
);
export const httpDuration = new Histogram(
  'pacient_http_request_duration_seconds',
  'HTTP request duration in seconds by method and route pattern.',
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
);

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();
export function eventLoopDelaySeconds() {
  const out = {
    mean: loop.mean / 1e9,
    p99: loop.percentile(99) / 1e9,
    max: loop.max / 1e9,
  };
  loop.reset();
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The route label: the Express route pattern when known, otherwise the path with identifiers
 * (uuids, numbers, accession/order/temporary codes, long tokens) replaced by placeholders.
 */
export function routeLabel(req: Request, status: number): string {
  if (status === 404 && !req.route) return 'unmatched';
  const path = (req.originalUrl || req.url).split('?')[0]!;
  return (
    path
      .split('/')
      .map((seg) => {
        if (!seg) return seg;
        if (UUID.test(seg)) return ':id';
        if (/^\d+$/.test(seg)) return ':n';
        if (/^(TMP|IMG|PAC)[0-9A-F]{6,}$/i.test(seg)) return ':code';
        if (seg.length > 24 || (/\d/.test(seg) && /[a-z]/i.test(seg) && seg.length > 10))
          return ':token';
        return seg;
      })
      .join('/') || '/'
  );
}

/** Express middleware: counts requests and records their duration. */
export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = routeLabel(req, res.statusCode);
    // Long-lived event streams would distort latency figures.
    if (route.endsWith('/events')) return;
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    httpDuration.observe({ method: req.method, route }, seconds);
  });
  next();
}

export function renderHttpMetrics(): string {
  return [httpRequests.render(), httpDuration.render()].join('\n');
}

/** Recent server errors (5xx) for the System health page. */
export function serverErrorCount(): number {
  let n = 0;
  for (const line of httpRequests.render().split('\n')) {
    const m = /status="5\d\d"\}\s+(\d+)/.exec(line);
    if (m) n += Number(m[1]);
  }
  return n;
}
