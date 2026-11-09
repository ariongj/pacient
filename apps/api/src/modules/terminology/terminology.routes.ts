import express, { Router, type Response } from 'express';
import { and, asc, count, desc, eq, ilike, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  codeSystems,
  codeSystemVersions,
  conceptMapEntries,
  conceptMaps,
  conceptMapVersions,
  STAFF_ROLES,
  terminologyConcepts,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  activateMapVersion,
  activateSystemVersion,
  activeMapVersionOf,
  activeVersionOf,
  assertCanManageSystem,
  assertCsvBody,
  canManageMap,
  canManageSystem,
  conceptsOf,
  createMapVersion,
  createSystemVersion,
  csvLine,
  diffConcepts,
  getMap,
  getMapVersion,
  getSystem,
  getSystemVersion,
  invalidateTerminologyCache,
  lookupConcept,
  mapByCodeOrUrl,
  mapOwner,
  MAX_CSV_BYTES,
  searchConcepts,
  systemByCodeOrUrl,
  translateCode,
  unmappedSourceCodes,
  validateCode,
  validateConceptCsv,
  validateMapCsv,
  versionsBySystem,
  type CodeSystem,
} from './terminology.service.js';

/**
 * Terminology: code systems, versions, concepts and versioned mappings. Every staff member reads;
 * the Ministry manages national (EXTERNAL) systems and maps, a director the LOCAL ones of their
 * facility. Imports are CSV request bodies (text/csv) and become DRAFT versions until activated.
 */
export const terminologyRouter = Router();
terminologyRouter.use(authenticate);
terminologyRouter.use(requireRole(...STAFF_ROLES));

const csvBody = express.text({
  type: ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'],
  limit: MAX_CSV_BYTES,
});

const IdParam = z.object({ id: z.string().uuid() });
const Page = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const flag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const systemView = (
  s: CodeSystem,
  ctx: AuthContext,
  versions: (typeof codeSystemVersions.$inferSelect)[] = [],
) => {
  const active = versions.find((v) => v.status === 'ACTIVE') ?? null;
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    url: s.url,
    publisher: s.publisher,
    kind: s.kind,
    facilityId: s.facilityId,
    description: s.description,
    activeVersion: active
      ? { id: active.id, version: active.version, conceptCount: active.conceptCount }
      : null,
    drafts: versions.filter((v) => v.status === 'DRAFT').length,
    canManage: canManageSystem(ctx, s),
    updatedAt: s.updatedAt,
  };
};

/* ------------------------------------------------------------------ code systems ----------- */

terminologyRouter.get('/systems', async (req, res) => {
  const ctx = requireAuth(req);
  const systems = await db
    .select()
    .from(codeSystems)
    .orderBy(asc(codeSystems.kind), asc(codeSystems.code));
  const versions = await versionsBySystem(systems.map((s) => s.id));
  res.json({ items: systems.map((s) => systemView(s, ctx, versions.get(s.id))) });
});

const SystemInput = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,39}$/, 'Use 2–40 capital letters, digits and hyphens'),
  name: z.string().trim().min(3).max(200),
  url: z.string().trim().url().max(300),
  publisher: z.string().trim().max(200).optional(),
  kind: z.enum(['EXTERNAL', 'LOCAL']),
  description: z.string().trim().max(4000).optional(),
});

terminologyRouter.post('/systems', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(SystemInput, req.body);
  const facilityId = input.kind === 'LOCAL' ? ctx.facilityId : null;
  if (!canManageSystem(ctx, { kind: input.kind, facilityId })) {
    throw forbidden(
      ctx.role === 'MINISTRY'
        ? 'The Ministry creates national code systems; local ones belong to a facility'
        : 'A director creates local code systems of their own facility',
    );
  }
  const clash = await db
    .select({ id: codeSystems.id })
    .from(codeSystems)
    .where(or(eq(codeSystems.code, input.code), eq(codeSystems.url, input.url)));
  if (clash.length) throw conflict('A code system with this code or URL already exists');
  const row = await db.transaction(async (tx) => {
    const [s] = await tx
      .insert(codeSystems)
      .values({
        ...input,
        publisher: input.publisher ?? null,
        description: input.description ?? null,
        facilityId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.TERMINOLOGY_IMPORTED,
        actor: ctx,
        resourceType: 'code_system',
        resourceId: s!.id,
        meta: requestMeta(req),
        metadata: { event: 'SYSTEM_CREATED', code: s!.code, kind: s!.kind },
      },
      tx,
    );
    return s!;
  });
  res.status(201).json(systemView(row, ctx));
});

terminologyRouter.get('/systems/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const system = await getSystem(id);
  const versions = (await versionsBySystem([id])).get(id) ?? [];
  res.json({
    ...systemView(system, ctx, versions),
    versions: versions
      .map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        conceptCount: v.conceptCount,
        notes: v.notes,
        importedAt: v.importedAt,
        activatedAt: v.activatedAt,
        retiredAt: v.retiredAt,
      }))
      .reverse(),
  });
});

const SystemPatch = z
  .object({
    name: z.string().trim().min(3).max(200).optional(),
    publisher: z.string().trim().max(200).nullable().optional(),
    description: z.string().trim().max(4000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

terminologyRouter.patch('/systems/:id', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(SystemPatch, req.body);
  const system = await getSystem(id);
  assertCanManageSystem(ctx, system);
  const [row] = await db
    .update(codeSystems)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(codeSystems.id, id))
    .returning();
  await audit({
    action: AuditAction.TERMINOLOGY_IMPORTED,
    actor: ctx,
    resourceType: 'code_system',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { event: 'SYSTEM_CHANGED', fields: Object.keys(input) },
  });
  res.json(systemView(row!, ctx, (await versionsBySystem([id])).get(id)));
});

const ConceptQuery = Page.extend({
  q: z.string().trim().max(100).optional(),
  versionId: z.string().uuid().optional(),
  activeOnly: flag,
});

async function versionFor(systemId: string, versionId?: string) {
  if (versionId) {
    const v = await getSystemVersion(versionId);
    if (v.codeSystemId !== systemId) throw notFound('Version not found');
    return v;
  }
  const v = await activeVersionOf(systemId);
  if (!v) throw notFound('The code system has no active version');
  return v;
}

terminologyRouter.get('/systems/:id/concepts', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const q = parse(ConceptQuery, req.query);
  await getSystem(id);
  const version = await versionFor(id, q.versionId);
  const { items, total } = await searchConcepts(version.id, {
    q: q.q,
    activeOnly: q.activeOnly,
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  });
  res.json({
    version: { id: version.id, version: version.version, status: version.status },
    items: items.map(({ id: _id, versionId: _v, ...c }) => c),
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  });
});

const ConceptDetailQuery = z.object({
  code: z.string().trim().min(1).max(40),
  versionId: z.string().uuid().optional(),
});

/** A concept with its parent, children and the active mappings that use it. */
terminologyRouter.get('/systems/:id/concept', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const q = parse(ConceptDetailQuery, req.query);
  const system = await getSystem(id);
  const version = await versionFor(id, q.versionId);
  const inVersion = (code: string) =>
    and(eq(terminologyConcepts.versionId, version.id), eq(terminologyConcepts.code, code));
  const [concept] = await db.select().from(terminologyConcepts).where(inVersion(q.code));
  if (!concept) throw notFound('The code is not in the code system');
  const [parent] = concept.parentCode
    ? await db.select().from(terminologyConcepts).where(inVersion(concept.parentCode))
    : [];
  const children = await db
    .select({
      code: terminologyConcepts.code,
      display: terminologyConcepts.display,
      active: terminologyConcepts.active,
    })
    .from(terminologyConcepts)
    .where(
      and(
        eq(terminologyConcepts.versionId, version.id),
        eq(terminologyConcepts.parentCode, concept.code),
      ),
    )
    .orderBy(asc(terminologyConcepts.code))
    .limit(200);
  // Mappings (active versions) where this code is the source or the target.
  const maps = await db
    .select({ map: conceptMaps, version: conceptMapVersions })
    .from(conceptMaps)
    .innerJoin(
      conceptMapVersions,
      and(eq(conceptMapVersions.mapId, conceptMaps.id), eq(conceptMapVersions.status, 'ACTIVE')),
    )
    .where(
      or(eq(conceptMaps.sourceSystemId, system.id), eq(conceptMaps.targetSystemId, system.id)),
    );
  const mappings = [];
  for (const m of maps) {
    const asSource = m.map.sourceSystemId === system.id;
    const entries = await db
      .select()
      .from(conceptMapEntries)
      .where(
        and(
          eq(conceptMapEntries.mapVersionId, m.version.id),
          asSource
            ? eq(conceptMapEntries.sourceCode, concept.code)
            : eq(conceptMapEntries.targetCode, concept.code),
        ),
      )
      .limit(50);
    if (entries.length) {
      mappings.push({
        mapId: m.map.id,
        map: m.map.code,
        name: m.map.name,
        direction: asSource ? 'SOURCE' : 'TARGET',
        entries: entries.map((e) => ({
          sourceCode: e.sourceCode,
          targetCode: e.targetCode,
          equivalence: e.equivalence,
          comment: e.comment,
        })),
      });
    }
  }
  const strip = <T extends { id: string; versionId: string }>({ id: _i, versionId: _v, ...c }: T) =>
    c;
  res.json({
    system: { id: system.id, code: system.code, url: system.url, name: system.name },
    version: { id: version.id, version: version.version, status: version.status },
    concept: strip(concept),
    parent: parent ? strip(parent) : null,
    children,
    mappings,
  });
});

/* ---------------------------------------------------------------------- imports ------------ */

const ImportQuery = z.object({
  version: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/, 'Use up to 40 letters, digits, dots, hyphens'),
  notes: z.string().trim().max(2000).optional(),
  dryRun: flag,
});

/** Import a code system version from CSV (code,display,display_sq,display_sr,parent,active). */
terminologyRouter.post(
  '/systems/:id/versions',
  requireRole('MINISTRY', 'DIRECTOR'),
  csvBody,
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const q = parse(ImportQuery, req.query);
    const system = await getSystem(id);
    assertCanManageSystem(ctx, system);
    const text = assertCsvBody(req.body);
    const { rows, errors, errorCount } = validateConceptCsv(text);
    if (errorCount) {
      throw badRequest('The file has errors; nothing was imported', errors);
    }
    if (!rows.length) throw badRequest('The file has no codes');
    const active = await activeVersionOf(system.id);
    const diff = diffConcepts(
      new Map(rows.map((r) => [r.code, r])),
      active ? await conceptsOf(active.id) : new Map(),
    );
    const against = active ? { versionId: active.id, version: active.version } : null;
    if (q.dryRun) {
      res.json({ dryRun: true, conceptCount: rows.length, diff: { against, ...diff } });
      return;
    }
    const version = await db.transaction(async (tx) => {
      const v = await createSystemVersion(tx, system, {
        version: q.version,
        notes: q.notes ?? null,
        rows,
        userId: ctx.userId,
      });
      await audit(
        {
          action: AuditAction.TERMINOLOGY_IMPORTED,
          actor: ctx,
          resourceType: 'code_system_version',
          resourceId: v.id,
          meta: requestMeta(req),
          metadata: {
            system: system.code,
            version: v.version,
            concepts: rows.length,
            ...diff.counts,
          },
        },
        tx,
      );
      return v;
    });
    res.status(201).json({
      id: version.id,
      version: version.version,
      status: version.status,
      conceptCount: version.conceptCount,
      diff: { against, ...diff },
    });
  },
);

/** Compare a version with the active one (or, for the active version, with the previous). */
terminologyRouter.get('/versions/:id/diff', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const version = await getSystemVersion(id);
  let other = version.status === 'ACTIVE' ? null : await activeVersionOf(version.codeSystemId);
  if (version.status === 'ACTIVE') {
    // The active version is compared with the one it replaced.
    const [prev] = await db
      .select()
      .from(codeSystemVersions)
      .where(
        and(
          eq(codeSystemVersions.codeSystemId, version.codeSystemId),
          eq(codeSystemVersions.status, 'RETIRED'),
        ),
      )
      .orderBy(desc(codeSystemVersions.retiredAt))
      .limit(1);
    other = prev ?? null;
  }
  const diff = diffConcepts(
    await conceptsOf(version.id),
    other ? await conceptsOf(other.id) : new Map(),
  );
  res.json({
    version: { id: version.id, version: version.version, status: version.status },
    against: other ? { versionId: other.id, version: other.version } : null,
    ...diff,
  });
});

function sendCsv(res: Response, filename: string, lines: string[]) {
  res
    .status(200)
    .type('text/csv; charset=utf-8')
    .setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`\uFEFF${lines.join('\r\n')}\r\n`);
}

terminologyRouter.get('/versions/:id/export', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const version = await getSystemVersion(id);
  const system = await getSystem(version.codeSystemId);
  const rows = await db
    .select()
    .from(terminologyConcepts)
    .where(eq(terminologyConcepts.versionId, id))
    .orderBy(asc(terminologyConcepts.code));
  sendCsv(res, `${system.code}-${version.version}.csv`.replace(/[^A-Za-z0-9._-]/g, '_'), [
    csvLine(['code', 'display', 'display_sq', 'display_sr', 'parent', 'active']),
    ...rows.map((r) =>
      csvLine([r.code, r.display, r.displaySq, r.displaySr, r.parentCode, r.active]),
    ),
  ]);
});

terminologyRouter.post(
  '/versions/:id/activate',
  requireRole('MINISTRY', 'DIRECTOR'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const version = await getSystemVersion(id);
    const system = await getSystem(version.codeSystemId);
    assertCanManageSystem(ctx, system);
    const result = await db.transaction(async (tx) => {
      const r = await activateSystemVersion(tx, id, ctx.userId);
      await audit(
        {
          action: AuditAction.TERMINOLOGY_ACTIVATED,
          actor: ctx,
          resourceType: 'code_system_version',
          resourceId: id,
          meta: requestMeta(req),
          metadata: {
            system: system.code,
            version: r.version.version,
            retired: r.retired?.version ?? null,
          },
        },
        tx,
      );
      return r;
    });
    invalidateTerminologyCache();
    res.json({
      id: result.version.id,
      version: result.version.version,
      status: result.version.status,
      retired: result.retired,
    });
  },
);

/** Discard a draft version. */
terminologyRouter.delete('/versions/:id', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const version = await getSystemVersion(id);
  const system = await getSystem(version.codeSystemId);
  assertCanManageSystem(ctx, system);
  if (version.status !== 'DRAFT') throw conflict('Only a draft version can be discarded');
  await db.transaction(async (tx) => {
    await tx
      .delete(codeSystemVersions)
      .where(and(eq(codeSystemVersions.id, id), eq(codeSystemVersions.status, 'DRAFT')));
    await audit(
      {
        action: AuditAction.TERMINOLOGY_IMPORTED,
        actor: ctx,
        resourceType: 'code_system_version',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { event: 'DRAFT_DISCARDED', system: system.code, version: version.version },
      },
      tx,
    );
  });
  res.status(204).end();
});

/* ------------------------------------------------------------------------- maps ------------ */

async function mapView(m: typeof conceptMaps.$inferSelect, ctx: AuthContext) {
  const [source, target] = await Promise.all([
    getSystem(m.sourceSystemId),
    getSystem(m.targetSystemId),
  ]);
  const versions = await db
    .select()
    .from(conceptMapVersions)
    .where(eq(conceptMapVersions.mapId, m.id))
    .orderBy(asc(conceptMapVersions.importedAt));
  const active = versions.find((v) => v.status === 'ACTIVE') ?? null;
  return {
    id: m.id,
    code: m.code,
    name: m.name,
    url: m.url,
    source: { id: source.id, code: source.code, name: source.name },
    target: { id: target.id, code: target.code, name: target.name },
    activeVersion: active
      ? { id: active.id, version: active.version, entryCount: active.entryCount }
      : null,
    versions: versions
      .map((v) => ({
        id: v.id,
        version: v.version,
        status: v.status,
        entryCount: v.entryCount,
        notes: v.notes,
        importedAt: v.importedAt,
        activatedAt: v.activatedAt,
      }))
      .reverse(),
    canManage: canManageMap(ctx, source, target),
  };
}

terminologyRouter.get('/maps', async (req, res) => {
  const ctx = requireAuth(req);
  const maps = await db.select().from(conceptMaps).orderBy(asc(conceptMaps.code));
  res.json({ items: await Promise.all(maps.map((m) => mapView(m, ctx))) });
});

const MapInput = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,59}$/, 'Use 2–60 capital letters, digits and hyphens'),
  name: z.string().trim().min(3).max(200),
  url: z.string().trim().url().max(300),
  sourceSystemId: z.string().uuid(),
  targetSystemId: z.string().uuid(),
});

terminologyRouter.post('/maps', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(MapInput, req.body);
  if (input.sourceSystemId === input.targetSystemId) {
    throw badRequest('The source and target code systems must differ');
  }
  const [source, target] = await Promise.all([
    getSystem(input.sourceSystemId),
    getSystem(input.targetSystemId),
  ]);
  if (mapOwner(source, target) === 'INVALID') {
    throw badRequest('A mapping cannot connect local code systems of two facilities');
  }
  if (!canManageMap(ctx, source, target)) {
    throw forbidden(
      'Mappings with a local code system belong to its facility; national ones to the Ministry',
    );
  }
  const clash = await db
    .select({ id: conceptMaps.id })
    .from(conceptMaps)
    .where(or(eq(conceptMaps.code, input.code), eq(conceptMaps.url, input.url)));
  if (clash.length) throw conflict('A mapping with this code or URL already exists');
  const row = await db.transaction(async (tx) => {
    const [m] = await tx.insert(conceptMaps).values(input).returning();
    await audit(
      {
        action: AuditAction.TERMINOLOGY_IMPORTED,
        actor: ctx,
        resourceType: 'concept_map',
        resourceId: m!.id,
        meta: requestMeta(req),
        metadata: { event: 'MAP_CREATED', code: m!.code, source: source.code, target: target.code },
      },
      tx,
    );
    return m!;
  });
  res.status(201).json(await mapView(row, ctx));
});

terminologyRouter.get('/maps/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  res.json(await mapView(await getMap(id), ctx));
});

const EntryQuery = Page.extend({
  q: z.string().trim().max(100).optional(),
  versionId: z.string().uuid().optional(),
  equivalence: z.enum(['EQUIVALENT', 'WIDER', 'NARROWER', 'RELATEDTO', 'UNMATCHED']).optional(),
});

terminologyRouter.get('/maps/:id/entries', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const q = parse(EntryQuery, req.query);
  const map = await getMap(id);
  const version = q.versionId ? await getMapVersion(q.versionId) : await activeMapVersionOf(map.id);
  if (!version || version.mapId !== map.id) throw notFound('The mapping has no active version');
  const conds = [eq(conceptMapEntries.mapVersionId, version.id)];
  if (q.equivalence) conds.push(eq(conceptMapEntries.equivalence, q.equivalence));
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(
      or(
        ilike(conceptMapEntries.sourceCode, like),
        ilike(conceptMapEntries.targetCode, like),
        ilike(conceptMapEntries.sourceDisplay, like),
      )!,
    );
  }
  const where = and(...conds);
  const [items, [total]] = await Promise.all([
    db
      .select()
      .from(conceptMapEntries)
      .where(where)
      .orderBy(asc(conceptMapEntries.sourceCode), asc(conceptMapEntries.targetCode))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize),
    db.select({ n: count() }).from(conceptMapEntries).where(where),
  ]);
  // Target displays from the target system's active version.
  const targetVersion = await activeVersionOf(map.targetSystemId);
  const targetCodes = items.map((i) => i.targetCode).filter((c): c is string => !!c);
  const displays =
    targetVersion && targetCodes.length
      ? new Map(
          (
            await db
              .select({ code: terminologyConcepts.code, display: terminologyConcepts.display })
              .from(terminologyConcepts)
              .where(
                and(
                  eq(terminologyConcepts.versionId, targetVersion.id),
                  inArray(terminologyConcepts.code, targetCodes),
                ),
              )
          ).map((r) => [r.code, r.display]),
        )
      : new Map<string, string>();
  const n = total?.n ?? 0;
  res.json({
    version: { id: version.id, version: version.version, status: version.status },
    items: items.map((e) => ({
      sourceCode: e.sourceCode,
      sourceDisplay: e.sourceDisplay,
      targetCode: e.targetCode,
      targetDisplay: e.targetCode ? (displays.get(e.targetCode) ?? null) : null,
      equivalence: e.equivalence,
      comment: e.comment,
    })),
    page: q.page,
    pageSize: q.pageSize,
    total: n,
    totalPages: Math.max(1, Math.ceil(n / q.pageSize)),
  });
});

/** Import a mapping version from CSV (source_code,target_code,equivalence,comment[,source_display]). */
terminologyRouter.post(
  '/maps/:id/versions',
  requireRole('MINISTRY', 'DIRECTOR'),
  csvBody,
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const q = parse(ImportQuery, req.query);
    const map = await getMap(id);
    const [source, target] = await Promise.all([
      getSystem(map.sourceSystemId),
      getSystem(map.targetSystemId),
    ]);
    if (!canManageMap(ctx, source, target)) {
      throw forbidden(
        'Mappings with a local code system belong to its facility; national ones to the Ministry',
      );
    }
    const text = assertCsvBody(req.body);
    const [sourceVersion, targetVersion] = await Promise.all([
      activeVersionOf(source.id),
      activeVersionOf(target.id),
    ]);
    if (!sourceVersion || !targetVersion) {
      throw conflict('Both code systems need an active version before a mapping can be imported');
    }
    const [sourceConcepts, targetConcepts] = await Promise.all([
      conceptsOf(sourceVersion.id),
      conceptsOf(targetVersion.id),
    ]);
    const { rows, errors, errorCount, warnings } = validateMapCsv(
      text,
      new Set(sourceConcepts.keys()),
      targetConcepts,
    );
    if (errorCount) {
      throw badRequest('The file has errors; nothing was imported', errors);
    }
    if (!rows.length) throw badRequest('The file has no mappings');
    const activeSource = [...sourceConcepts.values()].filter((c) => c.active).map((c) => c.code);
    const unmapped = unmappedSourceCodes(activeSource, rows);
    const counts = Object.fromEntries(
      ['EQUIVALENT', 'WIDER', 'NARROWER', 'RELATEDTO', 'UNMATCHED'].map((e) => [
        e,
        rows.filter((r) => r.equivalence === e).length,
      ]),
    );
    const report = {
      entryCount: rows.length,
      byEquivalence: counts,
      unmappedSourceCodes: unmapped,
      warnings,
      sourceVersion: sourceVersion.version,
      targetVersion: targetVersion.version,
    };
    if (q.dryRun) {
      res.json({ dryRun: true, ...report });
      return;
    }
    const version = await db.transaction(async (tx) => {
      const v = await createMapVersion(tx, map, {
        version: q.version,
        notes: q.notes ?? null,
        rows,
        userId: ctx.userId,
      });
      await audit(
        {
          action: AuditAction.TERMINOLOGY_IMPORTED,
          actor: ctx,
          resourceType: 'concept_map_version',
          resourceId: v.id,
          meta: requestMeta(req),
          metadata: {
            map: map.code,
            version: v.version,
            entries: rows.length,
            unmapped: unmapped.count,
          },
        },
        tx,
      );
      return v;
    });
    res
      .status(201)
      .json({ id: version.id, version: version.version, status: version.status, ...report });
  },
);

async function mapVersionForManager(ctx: AuthContext, id: string) {
  const version = await getMapVersion(id);
  const map = await getMap(version.mapId);
  const [source, target] = await Promise.all([
    getSystem(map.sourceSystemId),
    getSystem(map.targetSystemId),
  ]);
  if (!canManageMap(ctx, source, target)) {
    throw forbidden(
      'Mappings with a local code system belong to its facility; national ones to the Ministry',
    );
  }
  return { version, map };
}

terminologyRouter.get('/map-versions/:id/export', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const version = await getMapVersion(id);
  const map = await getMap(version.mapId);
  const rows = await db
    .select()
    .from(conceptMapEntries)
    .where(eq(conceptMapEntries.mapVersionId, id))
    .orderBy(asc(conceptMapEntries.sourceCode));
  sendCsv(res, `${map.code}-${version.version}.csv`.replace(/[^A-Za-z0-9._-]/g, '_'), [
    csvLine(['source_code', 'target_code', 'equivalence', 'comment', 'source_display']),
    ...rows.map((r) =>
      csvLine([r.sourceCode, r.targetCode, r.equivalence, r.comment, r.sourceDisplay]),
    ),
  ]);
});

terminologyRouter.post(
  '/map-versions/:id/activate',
  requireRole('MINISTRY', 'DIRECTOR'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const { map } = await mapVersionForManager(ctx, id);
    const result = await db.transaction(async (tx) => {
      const r = await activateMapVersion(tx, id, ctx.userId);
      await audit(
        {
          action: AuditAction.TERMINOLOGY_ACTIVATED,
          actor: ctx,
          resourceType: 'concept_map_version',
          resourceId: id,
          meta: requestMeta(req),
          metadata: {
            map: map.code,
            version: r.version.version,
            retired: r.retired?.version ?? null,
          },
        },
        tx,
      );
      return r;
    });
    invalidateTerminologyCache();
    res.json({
      id: result.version.id,
      version: result.version.version,
      status: result.version.status,
      retired: result.retired,
    });
  },
);

terminologyRouter.delete(
  '/map-versions/:id',
  requireRole('MINISTRY', 'DIRECTOR'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const { version, map } = await mapVersionForManager(ctx, id);
    if (version.status !== 'DRAFT') throw conflict('Only a draft version can be discarded');
    await db.transaction(async (tx) => {
      await tx
        .delete(conceptMapVersions)
        .where(and(eq(conceptMapVersions.id, id), eq(conceptMapVersions.status, 'DRAFT')));
      await audit(
        {
          action: AuditAction.TERMINOLOGY_IMPORTED,
          actor: ctx,
          resourceType: 'concept_map_version',
          resourceId: id,
          meta: requestMeta(req),
          metadata: { event: 'DRAFT_DISCARDED', map: map.code, version: version.version },
        },
        tx,
      );
    });
    res.status(204).end();
  },
);

const TranslateQuery = z.object({
  map: z.string().trim().min(1).max(300),
  code: z.string().trim().min(1).max(40),
});

/** Translate one code with the active version of a mapping (by map code or URL). */
terminologyRouter.get('/translate', async (req, res) => {
  const q = parse(TranslateQuery, req.query);
  const result = await translateCode(q.map, q.code);
  if (!result) throw notFound('Mapping not found or without an active version');
  res.json({ code: q.code, ...result });
});

/* ------------------------------------------------------------------------- FHIR ------------ */

const FHIR_JSON = 'application/fhir+json; charset=utf-8';
const fhir = (res: Response, status: number, body: unknown) =>
  res.status(status).type(FHIR_JSON).send(JSON.stringify(body));
const outcome = (code: string, diagnostics: string) => ({
  resourceType: 'OperationOutcome',
  issue: [{ severity: 'error', code, diagnostics }],
});
const PUBLISHER_FALLBACK = 'Ministry of Health (Kosovo)';
const MAX_FHIR_CONCEPTS = 5000;

async function fhirCodeSystem(system: CodeSystem, withConcepts: boolean) {
  const version = await activeVersionOf(system.id);
  const resource: Record<string, unknown> = {
    resourceType: 'CodeSystem',
    id: system.id,
    url: system.url,
    identifier: [{ value: system.code }],
    version: version?.version,
    name: system.code.replace(/[^A-Za-z0-9]/g, ''),
    title: system.name,
    status: version ? 'active' : 'draft',
    publisher: system.publisher ?? PUBLISHER_FALLBACK,
    description: system.description ?? undefined,
    caseSensitive: true,
    hierarchyMeaning: 'is-a',
    count: version?.conceptCount ?? 0,
    content: 'not-present',
    property: [{ code: 'inactive', type: 'boolean' }],
  };
  if (withConcepts && version && version.conceptCount <= MAX_FHIR_CONCEPTS) {
    const concepts = [...(await conceptsOf(version.id)).values()].sort((a, b) =>
      a.code.localeCompare(b.code),
    );
    const childrenOf = new Map<string | null, typeof concepts>();
    for (const c of concepts) {
      const key =
        c.parentCode && concepts.some((p) => p.code === c.parentCode) ? c.parentCode : null;
      childrenOf.set(key, [...(childrenOf.get(key) ?? []), c]);
    }
    const build = (parent: string | null, depth: number): unknown[] =>
      (childrenOf.get(parent) ?? []).map((c) => ({
        code: c.code,
        display: c.display,
        designation: [
          ...(c.displaySq ? [{ language: 'sq', value: c.displaySq }] : []),
          ...(c.displaySr ? [{ language: 'sr-Latn', value: c.displaySr }] : []),
        ],
        ...(c.active ? {} : { property: [{ code: 'inactive', valueBoolean: true }] }),
        ...(depth < 50 && childrenOf.has(c.code) ? { concept: build(c.code, depth + 1) } : {}),
      }));
    resource.content = 'complete';
    resource.concept = build(null, 0);
  }
  return resource;
}

const bundle = (entries: unknown[]) => ({
  resourceType: 'Bundle',
  type: 'searchset',
  total: entries.length,
  entry: entries.map((resource) => ({ resource })),
});

const FhirSearch = z.object({
  url: z.string().trim().max(300).optional(),
  name: z.string().trim().max(200).optional(),
});

terminologyRouter.get('/fhir/CodeSystem', async (req, res) => {
  const q = parse(FhirSearch, req.query);
  const systems = await db
    .select()
    .from(codeSystems)
    .where(
      and(
        q.url ? eq(codeSystems.url, q.url) : undefined,
        q.name
          ? or(ilike(codeSystems.name, `%${q.name}%`), ilike(codeSystems.code, `%${q.name}%`))
          : undefined,
      ),
    )
    .orderBy(asc(codeSystems.code));
  fhir(res, 200, bundle(await Promise.all(systems.map((s) => fhirCodeSystem(s, false)))));
});

const LookupQuery = z.object({
  system: z.string().trim().min(1).max(300),
  code: z.string().trim().min(1).max(40),
});

/** CodeSystem $lookup: display, designations and properties of a code. */
terminologyRouter.get('/fhir/CodeSystem/$lookup', async (req, res) => {
  const q = parse(LookupQuery, req.query);
  const c = await lookupConcept(q.system, q.code);
  if (!c) {
    fhir(res, 404, outcome('not-found', `Code ${q.code} was not found in ${q.system}`));
    return;
  }
  const system = await systemByCodeOrUrl(q.system);
  fhir(res, 200, {
    resourceType: 'Parameters',
    parameter: [
      { name: 'name', valueString: system?.name ?? c.system },
      { name: 'version', valueString: c.version },
      { name: 'display', valueString: c.display },
      ...(c.displaySq
        ? [
            {
              name: 'designation',
              part: [
                { name: 'language', valueCode: 'sq' },
                { name: 'value', valueString: c.displaySq },
              ],
            },
          ]
        : []),
      ...(c.displaySr
        ? [
            {
              name: 'designation',
              part: [
                { name: 'language', valueCode: 'sr-Latn' },
                { name: 'value', valueString: c.displaySr },
              ],
            },
          ]
        : []),
      {
        name: 'property',
        part: [
          { name: 'code', valueCode: 'inactive' },
          { name: 'value', valueBoolean: !c.active },
        ],
      },
      ...(c.parentCode
        ? [
            {
              name: 'property',
              part: [
                { name: 'code', valueCode: 'parent' },
                { name: 'value', valueCode: c.parentCode },
              ],
            },
          ]
        : []),
    ],
  });
});

const ValidateQuery = z.object({
  url: z.string().trim().min(1).max(300).optional(),
  system: z.string().trim().min(1).max(300).optional(),
  code: z.string().trim().min(1).max(40),
  display: z.string().trim().max(400).optional(),
});

/** CodeSystem $validate-code. */
terminologyRouter.get('/fhir/CodeSystem/$validate-code', async (req, res) => {
  const q = parse(ValidateQuery, req.query);
  const systemRef = q.url ?? q.system;
  if (!systemRef) {
    fhir(res, 400, outcome('required', 'Give the code system as url or system'));
    return;
  }
  const r = await validateCode(systemRef, q.code, q.display);
  fhir(res, 200, {
    resourceType: 'Parameters',
    parameter: [
      { name: 'result', valueBoolean: r.valid },
      ...(r.message ? [{ name: 'message', valueString: r.message }] : []),
      ...(r.display ? [{ name: 'display', valueString: r.display }] : []),
      ...(r.version ? [{ name: 'version', valueString: r.version }] : []),
    ],
  });
});

terminologyRouter.get('/fhir/CodeSystem/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const [system] = await db.select().from(codeSystems).where(eq(codeSystems.id, id));
  if (!system) {
    fhir(res, 404, outcome('not-found', 'CodeSystem not found'));
    return;
  }
  fhir(res, 200, await fhirCodeSystem(system, true));
});

async function fhirConceptMap(map: typeof conceptMaps.$inferSelect, withGroups: boolean) {
  const [source, target, version] = await Promise.all([
    getSystem(map.sourceSystemId),
    getSystem(map.targetSystemId),
    activeMapVersionOf(map.id),
  ]);
  const resource: Record<string, unknown> = {
    resourceType: 'ConceptMap',
    id: map.id,
    url: map.url,
    identifier: { value: map.code },
    version: version?.version,
    name: map.code.replace(/[^A-Za-z0-9]/g, ''),
    title: map.name,
    status: version ? 'active' : 'draft',
    sourceUri: source.url,
    targetUri: target.url,
  };
  if (withGroups && version) {
    const entries = await db
      .select()
      .from(conceptMapEntries)
      .where(eq(conceptMapEntries.mapVersionId, version.id))
      .orderBy(asc(conceptMapEntries.sourceCode));
    const bySource = new Map<string, typeof entries>();
    for (const e of entries) bySource.set(e.sourceCode, [...(bySource.get(e.sourceCode) ?? []), e]);
    resource.group = [
      {
        source: source.url,
        target: target.url,
        element: [...bySource].map(([code, es]) => ({
          code,
          display: es[0]!.sourceDisplay ?? undefined,
          target: es.map((e) => ({
            ...(e.targetCode ? { code: e.targetCode } : {}),
            equivalence: e.equivalence.toLowerCase(),
            ...(e.comment ? { comment: e.comment } : {}),
          })),
        })),
      },
    ];
  }
  return resource;
}

terminologyRouter.get('/fhir/ConceptMap', async (req, res) => {
  const q = parse(FhirSearch, req.query);
  const maps = await db
    .select()
    .from(conceptMaps)
    .where(
      and(
        q.url ? eq(conceptMaps.url, q.url) : undefined,
        q.name
          ? or(ilike(conceptMaps.name, `%${q.name}%`), ilike(conceptMaps.code, `%${q.name}%`))
          : undefined,
      ),
    )
    .orderBy(asc(conceptMaps.code));
  fhir(res, 200, bundle(await Promise.all(maps.map((m) => fhirConceptMap(m, false)))));
});

const FhirTranslateQuery = z.object({
  url: z.string().trim().min(1).max(300),
  code: z.string().trim().min(1).max(40),
  system: z.string().trim().max(300).optional(),
});

/** ConceptMap $translate with the active version of the mapping. */
terminologyRouter.get('/fhir/ConceptMap/$translate', async (req, res) => {
  const q = parse(FhirTranslateQuery, req.query);
  const map = await mapByCodeOrUrl(q.url);
  if (map && q.system) {
    const source = await getSystem(map.sourceSystemId);
    if (q.system !== source.url && q.system !== source.code) {
      fhir(res, 400, outcome('invalid', 'The system is not the source of this ConceptMap'));
      return;
    }
  }
  const t = map ? await translateCode(map.code, q.code) : null;
  if (!t) {
    fhir(res, 404, outcome('not-found', 'ConceptMap not found or without an active version'));
    return;
  }
  const matches = t.matches.filter((m) => m.equivalence !== 'UNMATCHED');
  fhir(res, 200, {
    resourceType: 'Parameters',
    parameter: [
      { name: 'result', valueBoolean: matches.length > 0 },
      ...(matches.length
        ? []
        : [
            {
              name: 'message',
              valueString: `No mapping for ${q.code} in ${t.map} ${t.mapVersion}`,
            },
          ]),
      ...matches.map((m) => ({
        name: 'match',
        part: [
          { name: 'equivalence', valueCode: m.equivalence.toLowerCase() },
          {
            name: 'concept',
            valueCoding: {
              system: t.targetSystemUrl,
              code: m.code,
              ...(m.display ? { display: m.display } : {}),
            },
          },
          ...(m.comment ? [{ name: 'comment', valueString: m.comment }] : []),
        ],
      })),
    ],
  });
});

terminologyRouter.get('/fhir/ConceptMap/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const [map] = await db.select().from(conceptMaps).where(eq(conceptMaps.id, id));
  if (!map) {
    fhir(res, 404, outcome('not-found', 'ConceptMap not found'));
    return;
  }
  fhir(res, 200, await fhirConceptMap(map, true));
});
