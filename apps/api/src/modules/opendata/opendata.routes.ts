import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { notFound } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import {
  DATASETS,
  type Built,
  type Cell,
  type Column,
  type Dataset,
  type Row,
} from './datasets.js';
import { label, type L, type Lang } from './labels.js';
import { THRESHOLD } from './suppression.js';

/**
 * Open data: public national statistics (no sign-in, no personal data, small counts suppressed).
 * Responses may be cached by browsers and proxies for an hour; each dataset is built at most
 * once every 10 minutes per API instance. Public reads are not audited (nothing personal is read
 * out), but they are rate limited per address.
 */
export const openDataRouter = Router();

export const LICENCE = {
  name: 'CC BY 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
  note: {
    en: 'Proposed licence, to be confirmed by the Ministry of Health. Please cite “Ministry of Health – Pacient”.',
    sq: 'Licencë e propozuar, që duhet ta konfirmojë Ministria e Shëndetësisë. Ju lutemi citoni “Ministria e Shëndetësisë – Pacient”.',
    sr: 'Predložena licenca, koju treba da potvrdi Ministarstvo zdravlja. Molimo navedite „Ministarstvo zdravlja – Pacient”.',
  } satisfies L,
};

const CACHE_TTL_MS = 10 * 60_000;
const BROWSER_MAX_AGE_S = 3600;

/* ------------------------------------------------------------------ rate limit ------------ */

let limitOverride: number | null = null;
/** Tests only: change the per-address limit (null restores the default). */
export function setOpenDataRateLimit(limit: number | null) {
  limitOverride = limit;
}

/** Strict: 300 requests per 10 minutes per address – plenty for people, a brake on scrapers. */
export const openDataLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: () => limitOverride ?? 300,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req: Request) => `opendata:${req.ip}`,
  handler: (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.status(429).json({
      error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later' },
    });
  },
});

/* ------------------------------------------------------------------ in-memory cache ------- */

interface Cached {
  generatedAt: string;
  built: Built;
}
const cache = new Map<string, { expires: number; value: Promise<Cached> }>();

/** Tests only: forget every cached dataset. */
export function clearOpenDataCache() {
  cache.clear();
}

function cached(dataset: Dataset): Promise<Cached> {
  const hit = cache.get(dataset.id);
  if (hit && hit.expires > Date.now()) return hit.value;
  const now = new Date();
  const value = dataset.build(now).then((built) => ({ generatedAt: now.toISOString(), built }));
  cache.set(dataset.id, { expires: Date.now() + CACHE_TTL_MS, value });
  // A failed build is not kept: the next request tries again.
  value.catch(() => cache.delete(dataset.id));
  return value;
}

/* ------------------------------------------------------------------ output ---------------- */

const LANGS = ['en', 'sq', 'sr'] as const;
const YES: L = { en: 'yes', sq: 'po', sr: 'da' };
const NO: L = { en: 'no', sq: 'jo', sr: 'ne' };
const SUPPRESSED_HEADER: L = { en: 'Suppressed', sq: 'E fshehur', sr: 'Skriveno' };

const isLabel = (v: Cell): v is L => typeof v === 'object' && v !== null;
const resolve = (v: Cell, lang: Lang) => (isLabel(v) ? label(v, lang, v.en) : v);

function describe(d: Dataset, lang: Lang) {
  return {
    id: d.id,
    title: label(d.title, lang, d.title.en),
    description: label(d.description, lang, d.description.en),
    methodology: label(d.methodology, lang, d.methodology.en),
    columns: d.columns.map((c: Column) => ({
      key: c.key,
      type: c.type,
      label: label(c.label, lang, c.label.en),
    })),
  };
}

function csvCell(v: string | number | boolean | null, lang: Lang): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return label(v ? YES : NO, lang, String(v));
  if (typeof v === 'number') return String(v);
  // Spreadsheet formula injection: text starting with these characters is prefixed.
  const text = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(d: Dataset, rows: Row[], lang: Lang): string {
  const header = [
    ...d.columns.map((c) => label(c.label, lang, c.label.en)),
    label(SUPPRESSED_HEADER, lang, 'Suppressed'),
  ];
  const lines = [header.map((h) => csvCell(h, lang)).join(',')];
  for (const row of rows) {
    const cells = d.columns.map((c) => csvCell(resolve(row[c.key] ?? null, lang), lang));
    cells.push(csvCell(row.suppressed, lang));
    lines.push(cells.join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

/** Public, cacheable; conditional requests get 304 when the body has not changed. */
function sendPublic(req: Request, res: Response, body: string, contentType: string) {
  const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
  res.set('Cache-Control', `public, max-age=${BROWSER_MAX_AGE_S}`);
  res.removeHeader('Pragma');
  res.set('ETag', etag);
  res.set('Vary', 'Origin');
  // Anyone may read open data, from any site; browsers on approved origins keep their cookies.
  const origin = req.headers.origin;
  if (!origin || !env.CORS_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', '*');
    res.removeHeader('Access-Control-Allow-Credentials');
  }
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  const match = req.headers['if-none-match'];
  if (match && match.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
    res.status(304).end();
    return;
  }
  res.type(contentType).send(body);
}

const langQuery = z.object({ lang: z.enum(LANGS).default('en') });

openDataRouter.use(openDataLimiter);

/** Index: what is published, in three languages, with the licence. */
openDataRouter.get('/', (req, res) => {
  const body = {
    title: {
      en: 'Open health data',
      sq: 'Të dhëna të hapura shëndetësore',
      sr: 'Otvoreni zdravstveni podaci',
    },
    licence: LICENCE,
    smallCellThreshold: THRESHOLD,
    languages: LANGS,
    formats: ['json', 'csv'],
    datasets: DATASETS.map((d) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      methodology: d.methodology,
      columns: d.columns,
      links: {
        json: `/api/v1/open-data/${d.id}`,
        csv: `/api/v1/open-data/${d.id}?format=csv`,
      },
    })),
  };
  sendPublic(req, res, JSON.stringify(body), 'application/json');
});

openDataRouter.get('/:dataset', async (req, res) => {
  const q = parse(langQuery.extend({ format: z.enum(['json', 'csv']).default('json') }), req.query);
  const dataset = DATASETS.find((d) => d.id === req.params.dataset);
  if (!dataset) throw notFound('No dataset with this name');
  const { generatedAt, built } = await cached(dataset);
  if (q.format === 'csv') {
    res.set(
      'Content-Disposition',
      `attachment; filename="${dataset.id}-${generatedAt.slice(0, 10)}-${q.lang}.csv"`,
    );
    sendPublic(req, res, toCsv(dataset, built.rows, q.lang), 'text/csv; charset=utf-8');
    return;
  }
  const body = {
    dataset: dataset.id,
    lang: q.lang,
    ...describe(dataset, q.lang),
    generatedAt,
    period: built.period,
    smallCellThreshold: THRESHOLD,
    licence: {
      name: LICENCE.name,
      url: LICENCE.url,
      note: label(LICENCE.note, q.lang, LICENCE.note.en),
    },
    rows: built.rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([k, v]) => [k, resolve(v, q.lang)])),
    ),
  };
  sendPublic(req, res, JSON.stringify(body), 'application/json');
});
