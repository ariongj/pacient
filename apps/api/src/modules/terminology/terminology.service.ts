import { and, asc, count, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  codeSystems,
  codeSystemVersions,
  conceptMapEntries,
  conceptMaps,
  conceptMapVersions,
  terminologyConcepts,
} from '../../db/schema.js';
import type { AuthContext } from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';

/**
 * Terminology service: code systems with versions, concepts in Albanian and Serbian, and
 * versioned mappings between systems. Imports arrive as CSV and become a DRAFT version, which is
 * compared with the active version and then activated (the previous active version is retired in
 * the same transaction). Other modules call lookupConcept / validateCode / translateCode.
 */

export const EQUIVALENCES = ['EQUIVALENT', 'WIDER', 'NARROWER', 'RELATEDTO', 'UNMATCHED'] as const;
export type Equivalence = (typeof EQUIVALENCES)[number];

/** Upload limits: CSV body size and rows per import. */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 100_000;
/** At most this many errors are returned for one import (the rest are counted). */
const MAX_ERRORS = 200;
/** Diff and report lists are capped; counts are always complete. */
const MAX_LIST = 500;

export type CodeSystem = typeof codeSystems.$inferSelect;
export type ConceptMap = typeof conceptMaps.$inferSelect;

/* ---------------------------------------------------------------------------- CSV ---------- */

/** RFC 4180 parser (comma only, quoted fields, doubled quotes, CRLF), with the line of each row. */
export function parseCsv(text: string): { line: number; cells: string[] }[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: { line: number; cells: string[] }[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((f) => f.trim() !== '')) rows.push({ line: rowLine, cells: row });
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
      line++;
      rowLine = line;
    } else field += ch;
  }
  endRow();
  return rows;
}

/**
 * Spreadsheet-safe CSV cell: quoted when needed, and text that a spreadsheet would run as a
 * formula (= + - @, tab, carriage return) gets a leading apostrophe.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: (string | number | boolean | null | undefined)[]) =>
  cells.map(csvCell).join(',');

/** Undo the formula protection of our own export, so an exported file can be imported again. */
const unprotect = (s: string) => (/^'[=+\-@]/.test(s) ? s.slice(1) : s);

export interface LineError {
  path: string;
  message: string;
}

function headerIndex(
  header: string[],
  required: string[],
  optional: string[],
  headerMessage: string,
): { idx: Record<string, number>; error?: undefined } | { idx?: undefined; error: LineError } {
  const names = header.map((h) => h.trim().toLowerCase());
  const idx: Record<string, number> = {};
  for (const col of [...required, ...optional]) {
    const i = names.indexOf(col);
    if (i >= 0) idx[col] = i;
  }
  const missing = required.filter((c) => idx[c] === undefined);
  if (missing.length) {
    return {
      error: {
        path: 'line 1',
        message: headerMessage,
      },
    };
  }
  return { idx };
}

const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/;
const TRUE = new Set(['', 'true', '1', 'yes', 'y', 'po', 'da']);
const FALSE = new Set(['false', '0', 'no', 'n', 'jo', 'ne']);

export interface ConceptRow {
  code: string;
  display: string;
  displaySq: string | null;
  displaySr: string | null;
  parentCode: string | null;
  active: boolean;
  /** Extra attributes (not imported from CSV; set by seeds and future importers). */
  properties?: Record<string, unknown> | null;
}

/** Validates a code system CSV: code,display,display_sq,display_sr,parent,active. */
export function validateConceptCsv(text: string): {
  rows: ConceptRow[];
  errors: LineError[];
  errorCount: number;
} {
  const parsed = parseCsv(text);
  const errors: LineError[] = [];
  let errorCount = 0;
  const fail = (line: number, message: string) => {
    errorCount++;
    if (errors.length < MAX_ERRORS) errors.push({ path: `line ${line}`, message });
  };
  if (!parsed.length)
    return { rows: [], errors: [{ path: 'line 1', message: 'The file is empty' }], errorCount: 1 };
  const header = headerIndex(
    parsed[0]!.cells,
    ['code', 'display'],
    ['display_sq', 'display_sr', 'parent', 'active'],
    'The first line must name the columns code, display, display_sq, display_sr, parent, active',
  );
  if (header.error) return { rows: [], errors: [header.error], errorCount: 1 };
  const idx = header.idx;
  if (parsed.length - 1 > MAX_ROWS) {
    return {
      rows: [],
      errors: [
        { path: 'line 1', message: 'Too many rows: at most 100 000 can be imported at once' },
      ],
      errorCount: 1,
    };
  }
  const cell = (cells: string[], col: string) =>
    idx[col] === undefined ? '' : unprotect((cells[idx[col]!] ?? '').trim());
  const rows: ConceptRow[] = [];
  const lineOf = new Map<string, number>();
  for (const { line, cells } of parsed.slice(1)) {
    const code = cell(cells, 'code');
    const display = cell(cells, 'display');
    const active = cell(cells, 'active').toLowerCase();
    let ok = true;
    if (!code) {
      fail(line, 'The code is missing');
      ok = false;
    } else if (code.length > 40 || !CODE_RE.test(code)) {
      fail(line, 'The code may have at most 40 letters, digits and . _ - / : (no spaces)');
      ok = false;
    } else if (lineOf.has(code)) {
      fail(line, 'This code appears twice in the file');
      ok = false;
    }
    if (!display) {
      fail(line, 'The display text is missing');
      ok = false;
    } else if (display.length > 400) {
      fail(line, 'The display text may have at most 400 characters');
      ok = false;
    }
    for (const col of ['display_sq', 'display_sr']) {
      if (cell(cells, col).length > 400) {
        fail(line, 'The display text may have at most 400 characters');
        ok = false;
      }
    }
    if (!TRUE.has(active) && !FALSE.has(active)) {
      fail(line, 'The active column must be true or false');
      ok = false;
    }
    if (!ok) continue;
    lineOf.set(code, line);
    rows.push({
      code,
      display,
      displaySq: cell(cells, 'display_sq') || null,
      displaySr: cell(cells, 'display_sr') || null,
      parentCode: cell(cells, 'parent') || null,
      active: !FALSE.has(active),
    });
  }
  // Parents must be in the same file, and the hierarchy must not loop.
  const parentOf = new Map(rows.map((r) => [r.code, r.parentCode]));
  for (const r of rows) {
    if (!r.parentCode) continue;
    if (!parentOf.has(r.parentCode)) {
      fail(lineOf.get(r.code)!, 'The parent code is not in the file');
      continue;
    }
    let p: string | null | undefined = r.parentCode;
    for (let depth = 0; p; depth++) {
      if (p === r.code || depth > 50) {
        fail(lineOf.get(r.code)!, 'The parent codes form a loop');
        break;
      }
      p = parentOf.get(p);
    }
  }
  return { rows, errors, errorCount };
}

export interface MapRow {
  sourceCode: string;
  sourceDisplay: string | null;
  targetCode: string | null;
  equivalence: Equivalence;
  comment: string | null;
}

/**
 * Validates a mapping CSV (source_code,target_code,equivalence,comment[,source_display]) against
 * the active versions of the source and target systems.
 */
export function validateMapCsv(
  text: string,
  sourceCodes: Set<string>,
  targetCodes: Map<string, { active: boolean }>,
): { rows: MapRow[]; errors: LineError[]; errorCount: number; warnings: LineError[] } {
  const parsed = parseCsv(text);
  const errors: LineError[] = [];
  const warnings: LineError[] = [];
  let errorCount = 0;
  const fail = (line: number, message: string) => {
    errorCount++;
    if (errors.length < MAX_ERRORS) errors.push({ path: `line ${line}`, message });
  };
  if (!parsed.length)
    return {
      rows: [],
      errors: [{ path: 'line 1', message: 'The file is empty' }],
      errorCount: 1,
      warnings,
    };
  const header = headerIndex(
    parsed[0]!.cells,
    ['source_code', 'target_code', 'equivalence'],
    ['comment', 'source_display'],
    'The first line must name the columns source_code, target_code, equivalence, comment',
  );
  if (header.error) return { rows: [], errors: [header.error], errorCount: 1, warnings };
  const idx = header.idx;
  if (parsed.length - 1 > MAX_ROWS) {
    return {
      rows: [],
      errors: [
        { path: 'line 1', message: 'Too many rows: at most 100 000 can be imported at once' },
      ],
      errorCount: 1,
      warnings,
    };
  }
  const cell = (cells: string[], col: string) =>
    idx[col] === undefined ? '' : unprotect((cells[idx[col]!] ?? '').trim());
  const rows: MapRow[] = [];
  const seen = new Set<string>();
  for (const { line, cells } of parsed.slice(1)) {
    const sourceCode = cell(cells, 'source_code');
    const targetCode = cell(cells, 'target_code') || null;
    const equivalence = cell(cells, 'equivalence').toUpperCase() as Equivalence;
    const comment = cell(cells, 'comment') || null;
    let ok = true;
    if (!sourceCode) {
      fail(line, 'The source code is missing');
      ok = false;
    } else if (!sourceCodes.has(sourceCode)) {
      fail(line, 'The source code is not in the active version of the source system');
      ok = false;
    }
    if (!(EQUIVALENCES as readonly string[]).includes(equivalence)) {
      fail(line, 'The equivalence must be EQUIVALENT, WIDER, NARROWER, RELATEDTO or UNMATCHED');
      ok = false;
    } else if (equivalence === 'UNMATCHED' && targetCode) {
      fail(line, 'An UNMATCHED row must not have a target code');
      ok = false;
    } else if (equivalence !== 'UNMATCHED' && !targetCode) {
      fail(line, 'The target code is missing');
      ok = false;
    }
    if (targetCode) {
      const target = targetCodes.get(targetCode);
      if (!target) {
        fail(line, 'The target code is not in the active version of the target system');
        ok = false;
      } else if (!target.active && warnings.length < MAX_ERRORS) {
        warnings.push({ path: `line ${line}`, message: 'The target code is inactive' });
      }
    }
    if (comment && comment.length > 500) {
      fail(line, 'The comment may have at most 500 characters');
      ok = false;
    }
    const key = `${sourceCode}\u0000${targetCode ?? ''}`;
    if (ok && seen.has(key)) {
      fail(line, 'This mapping appears twice in the file');
      ok = false;
    }
    if (!ok) continue;
    seen.add(key);
    rows.push({
      sourceCode,
      sourceDisplay: cell(cells, 'source_display').slice(0, 400) || null,
      targetCode,
      equivalence,
      comment,
    });
  }
  return { rows, errors, errorCount, warnings };
}

/* --------------------------------------------------------------------- permissions --------- */

/**
 * The Ministry manages national (EXTERNAL) code systems; a director manages the LOCAL code systems
 * of their own facility. Everyone else reads.
 */
export function canManageSystem(ctx: AuthContext, system: Pick<CodeSystem, 'kind' | 'facilityId'>) {
  if (ctx.role === 'MINISTRY') return system.kind === 'EXTERNAL';
  if (ctx.role === 'DIRECTOR') {
    return system.kind === 'LOCAL' && !!ctx.facilityId && system.facilityId === ctx.facilityId;
  }
  return false;
}

/** The facility that owns a map: the one owning its local system, null for national maps. */
export function mapOwner(source: CodeSystem, target: CodeSystem): string | null | 'INVALID' {
  const local = [source, target].filter((s) => s.kind === 'LOCAL');
  if (!local.length) return null;
  const facilities = new Set(local.map((s) => s.facilityId));
  return facilities.size === 1 ? (local[0]!.facilityId ?? 'INVALID') : 'INVALID';
}

export function canManageMap(ctx: AuthContext, source: CodeSystem, target: CodeSystem) {
  const owner = mapOwner(source, target);
  if (owner === 'INVALID') return false;
  if (owner === null) return ctx.role === 'MINISTRY';
  return ctx.role === 'DIRECTOR' && ctx.facilityId === owner;
}

export function assertCanManageSystem(ctx: AuthContext, system: CodeSystem) {
  if (!canManageSystem(ctx, system)) {
    throw forbidden(
      system.kind === 'LOCAL'
        ? 'Only the director of the owning facility can change a local code system'
        : 'Only the Ministry can change a national code system',
    );
  }
}

/* -------------------------------------------------------------------------- reads ---------- */

export async function getSystem(id: string, executor: Executor = db) {
  const [s] = await executor.select().from(codeSystems).where(eq(codeSystems.id, id));
  if (!s) throw notFound('Code system not found');
  return s;
}

export async function systemByCodeOrUrl(codeOrUrl: string) {
  const [s] = await db
    .select()
    .from(codeSystems)
    .where(or(eq(codeSystems.code, codeOrUrl), eq(codeSystems.url, codeOrUrl)));
  return s ?? null;
}

export async function activeVersionOf(systemId: string, executor: Executor = db) {
  const [v] = await executor
    .select()
    .from(codeSystemVersions)
    .where(
      and(eq(codeSystemVersions.codeSystemId, systemId), eq(codeSystemVersions.status, 'ACTIVE')),
    );
  return v ?? null;
}

export async function getSystemVersion(id: string) {
  const [v] = await db.select().from(codeSystemVersions).where(eq(codeSystemVersions.id, id));
  if (!v) throw notFound('Version not found');
  return v;
}

/** All concepts of a version, keyed by code. */
export async function conceptsOf(versionId: string, executor: Executor = db) {
  const rows = await executor
    .select()
    .from(terminologyConcepts)
    .where(eq(terminologyConcepts.versionId, versionId));
  return new Map(rows.map((r) => [r.code, r]));
}

/** Concept search in one version: code prefix, or words of the display in en, sq or sr. */
export async function searchConcepts(
  versionId: string,
  opts: { q?: string; activeOnly?: boolean; limit: number; offset: number },
) {
  const conds = [eq(terminologyConcepts.versionId, versionId)];
  if (opts.activeOnly) conds.push(eq(terminologyConcepts.active, true));
  const q = opts.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(
      or(
        ilike(terminologyConcepts.code, `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
        ilike(terminologyConcepts.display, like),
        ilike(terminologyConcepts.displaySq, like),
        ilike(terminologyConcepts.displaySr, like),
      )!,
    );
  }
  const where = and(...conds);
  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(terminologyConcepts)
      .where(where)
      // Exact code first, then codes before display matches, then by code.
      .orderBy(
        sql`CASE WHEN ${terminologyConcepts.code} = ${q ?? ''} THEN 0 WHEN ${terminologyConcepts.code} ILIKE ${`${q ?? ''}%`} THEN 1 ELSE 2 END`,
        asc(terminologyConcepts.code),
      )
      .limit(opts.limit)
      .offset(opts.offset),
    db.select({ n: count() }).from(terminologyConcepts).where(where),
  ]);
  return { items, total: total?.n ?? 0 };
}

export async function getMap(id: string, executor: Executor = db) {
  const [m] = await executor.select().from(conceptMaps).where(eq(conceptMaps.id, id));
  if (!m) throw notFound('Mapping not found');
  return m;
}

export async function mapByCodeOrUrl(codeOrUrl: string) {
  const [m] = await db
    .select()
    .from(conceptMaps)
    .where(or(eq(conceptMaps.code, codeOrUrl), eq(conceptMaps.url, codeOrUrl)));
  return m ?? null;
}

export async function activeMapVersionOf(mapId: string, executor: Executor = db) {
  const [v] = await executor
    .select()
    .from(conceptMapVersions)
    .where(and(eq(conceptMapVersions.mapId, mapId), eq(conceptMapVersions.status, 'ACTIVE')));
  return v ?? null;
}

export async function getMapVersion(id: string) {
  const [v] = await db.select().from(conceptMapVersions).where(eq(conceptMapVersions.id, id));
  if (!v) throw notFound('Version not found');
  return v;
}

/* --------------------------------------------------------------------------- diff ---------- */

type Concept = typeof terminologyConcepts.$inferSelect;

export interface ConceptDiff {
  against: { versionId: string; version: string } | null;
  counts: {
    added: number;
    removed: number;
    displayChanged: number;
    inactivated: number;
    reactivated: number;
    parentChanged: number;
    unchanged: number;
  };
  added: { code: string; display: string }[];
  removed: { code: string; display: string }[];
  displayChanged: {
    code: string;
    field: 'display' | 'displaySq' | 'displaySr';
    before: string | null;
    after: string | null;
  }[];
  inactivated: { code: string; display: string }[];
  reactivated: { code: string; display: string }[];
  parentChanged: { code: string; before: string | null; after: string | null }[];
  truncated: boolean;
}

/** Compares a version with another (normally the draft with the active version). */
export function diffConcepts(
  next: Map<string, Concept | ConceptRow>,
  prev: Map<string, Concept | ConceptRow>,
): Omit<ConceptDiff, 'against'> {
  const out: Omit<ConceptDiff, 'against'> = {
    counts: {
      added: 0,
      removed: 0,
      displayChanged: 0,
      inactivated: 0,
      reactivated: 0,
      parentChanged: 0,
      unchanged: 0,
    },
    added: [],
    removed: [],
    displayChanged: [],
    inactivated: [],
    reactivated: [],
    parentChanged: [],
    truncated: false,
  };
  const push = <T>(list: T[], item: T) => {
    if (list.length < MAX_LIST) list.push(item);
    else out.truncated = true;
  };
  for (const [code, c] of [...next].sort(([a], [b]) => a.localeCompare(b))) {
    const p = prev.get(code);
    if (!p) {
      out.counts.added++;
      push(out.added, { code, display: c.display });
      continue;
    }
    let changed = false;
    for (const field of ['display', 'displaySq', 'displaySr'] as const) {
      if ((p[field] ?? null) !== (c[field] ?? null)) {
        changed = true;
        out.counts.displayChanged++;
        push(out.displayChanged, {
          code,
          field,
          before: p[field] ?? null,
          after: c[field] ?? null,
        });
      }
    }
    if (p.active && !c.active) {
      changed = true;
      out.counts.inactivated++;
      push(out.inactivated, { code, display: c.display });
    } else if (!p.active && c.active) {
      changed = true;
      out.counts.reactivated++;
      push(out.reactivated, { code, display: c.display });
    }
    if ((p.parentCode ?? null) !== (c.parentCode ?? null)) {
      changed = true;
      out.counts.parentChanged++;
      push(out.parentChanged, { code, before: p.parentCode ?? null, after: c.parentCode ?? null });
    }
    if (!changed) out.counts.unchanged++;
  }
  for (const [code, p] of [...prev].sort(([a], [b]) => a.localeCompare(b))) {
    if (!next.has(code)) {
      out.counts.removed++;
      push(out.removed, { code, display: p.display });
    }
  }
  return out;
}

/* ---------------------------------------------------------------------- write paths -------- */

const CHUNK = 1000;

/** Stores a validated import as a new DRAFT version. */
export async function createSystemVersion(
  tx: Executor,
  system: CodeSystem,
  input: { version: string; notes: string | null; rows: ConceptRow[]; userId: string | null },
) {
  const [existing] = await tx
    .select({ id: codeSystemVersions.id })
    .from(codeSystemVersions)
    .where(
      and(
        eq(codeSystemVersions.codeSystemId, system.id),
        eq(codeSystemVersions.version, input.version),
      ),
    );
  if (existing) throw conflict('This version already exists for the code system');
  const [v] = await tx
    .insert(codeSystemVersions)
    .values({
      codeSystemId: system.id,
      version: input.version,
      status: 'DRAFT',
      notes: input.notes,
      conceptCount: input.rows.length,
      importedById: input.userId,
    })
    .returning();
  for (let i = 0; i < input.rows.length; i += CHUNK) {
    await tx
      .insert(terminologyConcepts)
      .values(input.rows.slice(i, i + CHUNK).map((r) => ({ ...r, versionId: v!.id })));
  }
  return v!;
}

/** Activates a DRAFT version; the previous active version is retired in the same transaction. */
export async function activateSystemVersion(tx: Executor, versionId: string, userId: string) {
  const [v] = await tx
    .select()
    .from(codeSystemVersions)
    .where(eq(codeSystemVersions.id, versionId))
    .for('update');
  if (!v) throw notFound('Version not found');
  // Serialise activations of the same system.
  await tx
    .select({ id: codeSystems.id })
    .from(codeSystems)
    .where(eq(codeSystems.id, v.codeSystemId))
    .for('update');
  if (v.status !== 'DRAFT') throw conflict('Only a draft version can be activated');
  const now = new Date();
  const retired = await tx
    .update(codeSystemVersions)
    .set({ status: 'RETIRED', retiredAt: now })
    .where(
      and(
        eq(codeSystemVersions.codeSystemId, v.codeSystemId),
        eq(codeSystemVersions.status, 'ACTIVE'),
      ),
    )
    .returning({ id: codeSystemVersions.id, version: codeSystemVersions.version });
  const [active] = await tx
    .update(codeSystemVersions)
    .set({ status: 'ACTIVE', activatedAt: now, activatedById: userId })
    .where(eq(codeSystemVersions.id, v.id))
    .returning();
  await tx.update(codeSystems).set({ updatedAt: now }).where(eq(codeSystems.id, v.codeSystemId));
  return { version: active!, retired: retired[0] ?? null };
}

export async function createMapVersion(
  tx: Executor,
  map: ConceptMap,
  input: { version: string; notes: string | null; rows: MapRow[]; userId: string | null },
) {
  const [existing] = await tx
    .select({ id: conceptMapVersions.id })
    .from(conceptMapVersions)
    .where(
      and(eq(conceptMapVersions.mapId, map.id), eq(conceptMapVersions.version, input.version)),
    );
  if (existing) throw conflict('This version already exists for the mapping');
  const [v] = await tx
    .insert(conceptMapVersions)
    .values({
      mapId: map.id,
      version: input.version,
      status: 'DRAFT',
      notes: input.notes,
      entryCount: input.rows.length,
      importedById: input.userId,
    })
    .returning();
  for (let i = 0; i < input.rows.length; i += CHUNK) {
    await tx
      .insert(conceptMapEntries)
      .values(input.rows.slice(i, i + CHUNK).map((r) => ({ ...r, mapVersionId: v!.id })));
  }
  return v!;
}

export async function activateMapVersion(tx: Executor, versionId: string, userId: string) {
  const [v] = await tx
    .select()
    .from(conceptMapVersions)
    .where(eq(conceptMapVersions.id, versionId))
    .for('update');
  if (!v) throw notFound('Version not found');
  await tx
    .select({ id: conceptMaps.id })
    .from(conceptMaps)
    .where(eq(conceptMaps.id, v.mapId))
    .for('update');
  if (v.status !== 'DRAFT') throw conflict('Only a draft version can be activated');
  const now = new Date();
  const retired = await tx
    .update(conceptMapVersions)
    .set({ status: 'RETIRED' })
    .where(and(eq(conceptMapVersions.mapId, v.mapId), eq(conceptMapVersions.status, 'ACTIVE')))
    .returning({ id: conceptMapVersions.id, version: conceptMapVersions.version });
  const [active] = await tx
    .update(conceptMapVersions)
    .set({ status: 'ACTIVE', activatedAt: now, activatedById: userId })
    .where(eq(conceptMapVersions.id, v.id))
    .returning();
  await tx.update(conceptMaps).set({ updatedAt: now }).where(eq(conceptMaps.id, v.mapId));
  return { version: active!, retired: retired[0] ?? null };
}

/** Source codes of the source system's active version that the map does not cover. */
export function unmappedSourceCodes(sourceCodes: Iterable<string>, rows: { sourceCode: string }[]) {
  const mapped = new Set(rows.map((r) => r.sourceCode));
  const missing = [...sourceCodes].filter((c) => !mapped.has(c)).sort();
  return { count: missing.length, codes: missing.slice(0, 50) };
}

/* ------------------------------------------------------------ lookups for other modules ---- */

interface CachedSystem {
  loadedAt: number;
  system: CodeSystem;
  versionId: string;
  version: string;
  concepts: Map<string, Concept>;
}
interface CachedMap {
  loadedAt: number;
  map: ConceptMap;
  version: string;
  targetSystem: CodeSystem;
  bySource: Map<string, (typeof conceptMapEntries.$inferSelect)[]>;
}

/** Entries expire after a while too, so other API instances pick up an activation. */
const CACHE_TTL_MS = 5 * 60_000;
const systemCache = new Map<string, CachedSystem | null>();
const mapCache = new Map<string, CachedMap | null>();
const loadedAt = new Map<string, number>();

/** Forget cached code systems and maps (called on every activation). */
export function invalidateTerminologyCache() {
  systemCache.clear();
  mapCache.clear();
  loadedAt.clear();
}

async function cachedSystem(systemCode: string): Promise<CachedSystem | null> {
  const at = loadedAt.get(`s:${systemCode}`);
  if (at !== undefined && Date.now() - at < CACHE_TTL_MS)
    return systemCache.get(systemCode) ?? null;
  const system = await systemByCodeOrUrl(systemCode);
  const version = system ? await activeVersionOf(system.id) : null;
  const entry =
    system && version
      ? {
          loadedAt: Date.now(),
          system,
          versionId: version.id,
          version: version.version,
          concepts: await conceptsOf(version.id),
        }
      : null;
  systemCache.set(systemCode, entry);
  loadedAt.set(`s:${systemCode}`, Date.now());
  return entry;
}

async function cachedMap(mapCode: string): Promise<CachedMap | null> {
  const at = loadedAt.get(`m:${mapCode}`);
  if (at !== undefined && Date.now() - at < CACHE_TTL_MS) return mapCache.get(mapCode) ?? null;
  const map = await mapByCodeOrUrl(mapCode);
  const version = map ? await activeMapVersionOf(map.id) : null;
  let entry: CachedMap | null = null;
  if (map && version) {
    const rows = await db
      .select()
      .from(conceptMapEntries)
      .where(eq(conceptMapEntries.mapVersionId, version.id));
    const bySource = new Map<string, typeof rows>();
    for (const r of rows) bySource.set(r.sourceCode, [...(bySource.get(r.sourceCode) ?? []), r]);
    entry = {
      loadedAt: Date.now(),
      map,
      version: version.version,
      targetSystem: await getSystem(map.targetSystemId),
      bySource,
    };
  }
  mapCache.set(mapCode, entry);
  loadedAt.set(`m:${mapCode}`, Date.now());
  return entry;
}

export interface LookupResult {
  system: string;
  systemUrl: string;
  version: string;
  code: string;
  display: string;
  displaySq: string | null;
  displaySr: string | null;
  parentCode: string | null;
  active: boolean;
}

/** A concept in the active version of a code system (by system code or canonical URL). */
export async function lookupConcept(
  systemCode: string,
  code: string,
): Promise<LookupResult | null> {
  const s = await cachedSystem(systemCode);
  const c = s?.concepts.get(code);
  if (!s || !c) return null;
  return {
    system: s.system.code,
    systemUrl: s.system.url,
    version: s.version,
    code: c.code,
    display: c.display,
    displaySq: c.displaySq,
    displaySr: c.displaySr,
    parentCode: c.parentCode,
    active: c.active,
  };
}

/** Whether a code is valid (present and active) in the active version, with the reason if not. */
export async function validateCode(
  systemCode: string,
  code: string,
  display?: string,
): Promise<{ valid: boolean; display?: string; version?: string; message?: string }> {
  const s = await cachedSystem(systemCode);
  if (!s) return { valid: false, message: 'Unknown code system or no active version' };
  const c = s.concepts.get(code);
  if (!c)
    return { valid: false, version: s.version, message: 'The code is not in the code system' };
  if (!c.active) {
    return {
      valid: false,
      display: c.display,
      version: s.version,
      message: 'The code is inactive',
    };
  }
  if (display !== undefined) {
    const known = [c.display, c.displaySq, c.displaySr]
      .filter(Boolean)
      .map((d) => d!.toLowerCase());
    if (!known.includes(display.trim().toLowerCase())) {
      return {
        valid: false,
        display: c.display,
        version: s.version,
        message: 'The display does not match the code',
      };
    }
  }
  return { valid: true, display: c.display, version: s.version };
}

export interface Translation {
  map: string;
  mapVersion: string;
  targetSystem: string;
  targetSystemUrl: string;
  matches: {
    code: string | null;
    display: string | null;
    equivalence: Equivalence;
    comment: string | null;
  }[];
}

/** The target codes of a source code in the active version of a mapping. */
export async function translateCode(
  mapCode: string,
  sourceCode: string,
): Promise<Translation | null> {
  const m = await cachedMap(mapCode);
  if (!m) return null;
  const target = await cachedSystem(m.targetSystem.code);
  const entries = m.bySource.get(sourceCode) ?? [];
  return {
    map: m.map.code,
    mapVersion: m.version,
    targetSystem: m.targetSystem.code,
    targetSystemUrl: m.targetSystem.url,
    matches: entries.map((e) => ({
      code: e.targetCode,
      display: e.targetCode ? (target?.concepts.get(e.targetCode)?.display ?? null) : null,
      equivalence: e.equivalence as Equivalence,
      comment: e.comment,
    })),
  };
}

/* ------------------------------------------------------------------------ helpers -------- */

/** Versions of several systems (for listings). */
export async function versionsBySystem(systemIds: string[]) {
  if (!systemIds.length) return new Map<string, (typeof codeSystemVersions.$inferSelect)[]>();
  const rows = await db
    .select()
    .from(codeSystemVersions)
    .where(inArray(codeSystemVersions.codeSystemId, systemIds))
    .orderBy(asc(codeSystemVersions.importedAt));
  const out = new Map<string, typeof rows>();
  for (const r of rows) out.set(r.codeSystemId, [...(out.get(r.codeSystemId) ?? []), r]);
  return out;
}

export function assertCsvBody(body: unknown): string {
  if (typeof body !== 'string' || !body.trim()) {
    throw badRequest('Send the CSV file as the request body (Content-Type: text/csv)');
  }
  return body;
}
