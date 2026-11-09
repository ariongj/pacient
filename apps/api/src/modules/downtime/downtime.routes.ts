import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { downtimeExports, facilities, type Role } from '../../db/schema.js';
import { conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  backEntryChecklist,
  downtimeConfig,
  downtimeStatus,
  endDowntime,
  generateDowntimePacks,
  listPacks,
  readPack,
  startDowntime,
} from './downtime.service.js';

/**
 * Business continuity: encrypted hourly downtime packs (printable ward lists for working on paper),
 * a facility-wide "downtime procedures in effect" indicator, and a back-entry checklist for
 * afterwards. See docs/DOWNTIME.md.
 */
export const downtimeRouter = Router({ mergeParams: true });

const PACK_ROLES: Role[] = ['DIRECTOR', 'DOCTOR', 'NURSE', 'RECEPTION'];
const BACK_ENTRY_ROLES: Role[] = ['DIRECTOR', 'DOCTOR', 'NURSE'];
const STATUS_ROLES: Role[] = [
  'DIRECTOR',
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
  'LAB_TECHNICIAN',
  'IT_SUPPORT',
];

/* ----------------------------------------------------------- sync (ward PC) */

/** facility code → sha256 hashes of its downtime-PC keys (from DOWNTIME_SYNC_KEYS). */
function syncKeyMap(config: string | undefined): Map<string, string> {
  const byHash = new Map<string, string>();
  for (const pair of (config ?? '').split(',').filter(Boolean)) {
    const [code, hash] = pair.split(':');
    if (code && hash) byHash.set(hash, code);
  }
  return byHash;
}
let syncKeys = syncKeyMap(env.DOWNTIME_SYNC_KEYS);
/** Tests only: replace the configured sync keys. */
export function setSyncKeysForTests(value: string | undefined) {
  syncKeys = syncKeyMap(value);
}

/**
 * The latest age-encrypted pack for the facility the key belongs to. The server never holds the
 * matching private key, so the file stays unreadable until the ward PC decrypts it during an outage.
 */
downtimeRouter.get('/sync/latest', async (req, res) => {
  const header = req.get('authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!/^dts_[A-Za-z0-9_-]{32,128}$/.test(key)) throw unauthorized('Invalid downtime sync key');
  const code = syncKeys.get(createHash('sha256').update(key).digest('hex'));
  if (!code) throw unauthorized('Invalid downtime sync key');
  const [facility] = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(and(eq(facilities.code, code), eq(facilities.isActive, true)));
  if (!facility) throw unauthorized('Invalid downtime sync key');
  const [row] = await db
    .select()
    .from(downtimeExports)
    .where(and(eq(downtimeExports.facilityId, facility.id), eq(downtimeExports.kind, 'HTML_AGE')))
    .orderBy(desc(downtimeExports.generatedAt))
    .limit(1);
  if (!row) {
    throw conflict(
      'No age-encrypted pack is available – set DOWNTIME_AGE_RECIPIENT and wait for the next pack',
    );
  }
  const root = path.resolve(downtimeConfig.dir);
  const full = path.resolve(root, row.fileName);
  if (!full.startsWith(root + path.sep)) throw notFound();
  const content = await readFile(full).catch(() => {
    throw notFound('The downtime pack file is missing');
  });
  await audit({
    action: AuditAction.DOWNTIME_PACK_DOWNLOADED,
    meta: requestMeta(req),
    resourceType: 'downtime_export',
    resourceId: row.id,
    metadata: {
      facilityId: facility.id,
      via: 'sync-key',
      kind: row.kind,
      patientCount: row.patientCount,
    },
  });
  res
    .status(200)
    .set({
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${path.basename(row.fileName)}"`,
      'Cache-Control': 'no-store',
      'X-Pack-Generated-At': row.generatedAt.toISOString(),
      'X-Pack-Sha256': row.sha256,
    })
    .send(content);
});

/* ------------------------------------------------------------ staff routes */

downtimeRouter.use(authenticate);

function facilityOf(req: Request, roles: Role[]): AuthContext & { facilityId: string } {
  const ctx = requireAuth(req);
  if (!roles.includes(ctx.role) || !ctx.facilityId) throw forbidden();
  return ctx as AuthContext & { facilityId: string };
}

const IdParam = z.object({ id: z.string().uuid() });
const GenerateInput = z.object({ locale: z.enum(['sq', 'sr', 'en']).optional() }).strict();
const StartInput = z.object({ note: z.string().trim().max(300).optional() }).strict();

downtimeRouter.get('/status', async (req, res) => {
  const ctx = facilityOf(req, STATUS_ROLES);
  res.json(await downtimeStatus(ctx.facilityId));
});

downtimeRouter.post('/start', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = facilityOf(req, ['DIRECTOR']);
  const input = parse(StartInput, req.body ?? {});
  await startDowntime(ctx, input.note, requestMeta(req));
  res.status(201).json(await downtimeStatus(ctx.facilityId));
});

downtimeRouter.post('/end', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = facilityOf(req, ['DIRECTOR']);
  const ended = await endDowntime(ctx, requestMeta(req));
  res.json({ ...(await downtimeStatus(ctx.facilityId)), ended });
});

downtimeRouter.get('/packs', async (req, res) => {
  const ctx = facilityOf(req, PACK_ROLES);
  res.json({
    data: await listPacks(ctx.facilityId),
    ageEnabled: Boolean(downtimeConfig.ageRecipient),
  });
});

downtimeRouter.post('/packs/generate', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = facilityOf(req, ['DIRECTOR']);
  const input = parse(GenerateInput, req.body ?? {});
  const packs = await generateDowntimePacks(ctx.facilityId, new Date(), {
    locale: input.locale,
    actor: ctx,
    meta: requestMeta(req),
  });
  res.status(201).json({ data: packs });
});

downtimeRouter.get('/packs/:id/download', async (req, res) => {
  const ctx = facilityOf(req, PACK_ROLES);
  const { id } = parse(IdParam, req.params);
  const { row, html } = await readPack(ctx.facilityId, id);
  await audit({
    action: AuditAction.DOWNTIME_PACK_DOWNLOADED,
    actor: ctx,
    meta: requestMeta(req),
    resourceType: 'downtime_export',
    resourceId: row.id,
    metadata: { facilityId: ctx.facilityId, via: 'web', patientCount: row.patientCount },
  });
  const name = path.basename(row.fileName).replace(/\.enc$/, '');
  res
    .status(200)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="downtime-${name}"`,
      'Cache-Control': 'no-store',
      // The pack is static: no scripts, inline styles only.
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
    })
    .send(html);
});

downtimeRouter.get('/back-entry', async (req, res) => {
  const ctx = facilityOf(req, BACK_ENTRY_ROLES);
  res.json(await backEntryChecklist(ctx.facilityId));
});
