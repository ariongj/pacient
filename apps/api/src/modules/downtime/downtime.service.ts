import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { env, isTest } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  admissions,
  auditLogs,
  beds,
  careUnits,
  downtimeExports,
  facilities,
  FACILITY_ROLES,
  medicationAdministrations,
  patients,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { toLocale, type Locale } from '../../i18n/index.js';
import { conflict, notFound } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { openBuffer, sealBuffer } from '../../lib/secret-box.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyFacilityRole } from '../notifications/notifications.service.js';
import { collectPackData, renderPackHtml } from './pack.js';

/** Number of packs kept per facility (and per kind); older ones are deleted with their files. */
export const PACK_RETENTION = 48;
export const PACK_INTERVAL_MS = 60 * 60 * 1000;
const PURPOSE = 'downtime';

/** Where packs are written. Mutable so tests can point it at a temporary directory. */
export const downtimeConfig: { dir: string; ageRecipient: string | undefined; ageBinary: string } = {
  dir: env.DOWNTIME_DIR,
  ageRecipient: env.DOWNTIME_AGE_RECIPIENT,
  ageBinary: 'age',
};

export type PackKind = 'HTML_AES' | 'HTML_AGE';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** File-system-safe directory name for a facility (its code, falling back to the id). */
const facilityDir = (f: { id: string; code: string }) =>
  /^[A-Za-z0-9_-]{1,32}$/.test(f.code) ? f.code : f.id;

/** Absolute path of a stored pack, refusing anything that would escape the pack directory. */
function packPath(fileName: string): string {
  const root = path.resolve(downtimeConfig.dir);
  const full = path.resolve(root, fileName);
  if (!full.startsWith(root + path.sep)) throw new Error('Invalid downtime pack path');
  return full;
}

/** Encrypts with the age CLI for an offline recipient key (the private key never touches the server). */
function ageEncrypt(plain: Buffer, recipient: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(downtimeConfig.ageBinary, ['-r', recipient], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => errOut.push(d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(out))
        : reject(new Error(`age exited with ${code}: ${Buffer.concat(errOut).toString().trim()}`)),
    );
    child.stdin.end(plain);
  });
}

/** The language a facility's packs are written in: its (first) director's, else Albanian. */
async function facilityLocale(facilityId: string): Promise<Locale> {
  const [d] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR'), eq(users.isActive, true)),
    )
    .orderBy(asc(users.createdAt))
    .limit(1);
  return toLocale(d?.locale);
}

export interface GeneratedPack {
  id: string;
  facilityId: string;
  kind: PackKind;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  patientCount: number;
  generatedAt: Date;
}

interface GenerateOptions {
  locale?: Locale;
  actor?: AuthContext;
  meta?: RequestMeta;
}

/**
 * Generates a downtime pack for one facility (or every active facility with inpatient wards when
 * `facilityId` is omitted): renders the HTML, encrypts it, writes it under
 * DOWNTIME_DIR/<facility>/<timestamp>.html.enc (plus .html.age when DOWNTIME_AGE_RECIPIENT is set),
 * records a row per file, applies retention and audits.
 */
export async function generateDowntimePacks(
  facilityId?: string,
  now: Date = new Date(),
  opts: GenerateOptions = {},
): Promise<GeneratedPack[]> {
  const targets = facilityId
    ? await db
        .select({ id: facilities.id, code: facilities.code })
        .from(facilities)
        .where(eq(facilities.id, facilityId))
    : await db
        .selectDistinct({ id: facilities.id, code: facilities.code })
        .from(facilities)
        .innerJoin(careUnits, eq(careUnits.facilityId, facilities.id))
        .where(eq(facilities.isActive, true));
  if (facilityId && targets.length === 0) throw notFound('Facility not found');

  const out: GeneratedPack[] = [];
  for (const f of targets) {
    try {
      out.push(...(await generateForFacility(f, now, opts)));
    } catch (err) {
      if (facilityId) throw err;
      logger.error({ err, facilityId: f.id }, 'Downtime pack generation failed');
    }
  }
  return out;
}

async function generateForFacility(
  f: { id: string; code: string },
  now: Date,
  opts: GenerateOptions,
): Promise<GeneratedPack[]> {
  const locale = opts.locale ?? (await facilityLocale(f.id));
  const data = await collectPackData(f.id, now, locale);
  const html = Buffer.from(renderPackHtml(data), 'utf8');
  const digest = sha256(html);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = facilityDir(f);
  await mkdir(path.join(path.resolve(downtimeConfig.dir), dir), { recursive: true, mode: 0o700 });

  const files: { kind: PackKind; fileName: string; content: Buffer }[] = [
    { kind: 'HTML_AES', fileName: `${dir}/${stamp}.html.enc`, content: sealBuffer(html, PURPOSE) },
  ];
  if (downtimeConfig.ageRecipient) {
    try {
      files.push({
        kind: 'HTML_AGE',
        fileName: `${dir}/${stamp}.html.age`,
        content: await ageEncrypt(html, downtimeConfig.ageRecipient),
      });
    } catch (err) {
      // The AES copy is still written; an operator must fix the age set-up.
      logger.error({ err, facilityId: f.id }, 'age encryption of downtime pack failed');
    }
  }

  const rows: GeneratedPack[] = [];
  for (const file of files) {
    await writeFile(packPath(file.fileName), file.content, { mode: 0o600 });
    const [row] = await db
      .insert(downtimeExports)
      .values({
        facilityId: f.id,
        kind: file.kind,
        fileName: file.fileName,
        sha256: digest,
        sizeBytes: html.length,
        patientCount: data.patients.length,
        generatedAt: now,
      })
      .returning();
    rows.push(row as GeneratedPack);
    await audit({
      action: AuditAction.DOWNTIME_PACK_GENERATED,
      actor: opts.actor,
      meta: opts.meta,
      resourceType: 'downtime_export',
      resourceId: row!.id,
      metadata: {
        facilityId: f.id,
        kind: file.kind,
        patientCount: data.patients.length,
        sha256: digest,
        locale,
        trigger: opts.actor ? 'manual' : 'scheduled',
      },
    });
  }
  await applyRetention(f.id);
  return rows;
}

/** Keeps the newest PACK_RETENTION packs of each kind for a facility; deletes rows and files. */
export async function applyRetention(facilityId: string, keep = PACK_RETENTION): Promise<number> {
  const old = await db
    .select({ id: downtimeExports.id, fileName: downtimeExports.fileName })
    .from(downtimeExports)
    .where(
      and(
        eq(downtimeExports.facilityId, facilityId),
        sql`${downtimeExports.id} NOT IN (
          SELECT id FROM (
            SELECT id, row_number() OVER (PARTITION BY kind ORDER BY generated_at DESC, id DESC) AS rn
            FROM ${downtimeExports} WHERE facility_id = ${facilityId}
          ) ranked WHERE rn <= ${keep})`,
      ),
    );
  for (const o of old) {
    try {
      await rm(packPath(o.fileName), { force: true });
    } catch (err) {
      logger.warn({ err, fileName: o.fileName }, 'Could not delete old downtime pack');
    }
  }
  if (old.length) {
    await db.delete(downtimeExports).where(
      inArray(
        downtimeExports.id,
        old.map((o) => o.id),
      ),
    );
  }
  return old.length;
}

export async function listPacks(facilityId: string, limit = PACK_RETENTION * 2) {
  return db
    .select({
      id: downtimeExports.id,
      kind: downtimeExports.kind,
      fileName: downtimeExports.fileName,
      sha256: downtimeExports.sha256,
      sizeBytes: downtimeExports.sizeBytes,
      patientCount: downtimeExports.patientCount,
      generatedAt: downtimeExports.generatedAt,
    })
    .from(downtimeExports)
    .where(eq(downtimeExports.facilityId, facilityId))
    .orderBy(desc(downtimeExports.generatedAt), asc(downtimeExports.kind))
    .limit(limit);
}

/** Decrypts a stored pack and verifies it against the recorded SHA-256. */
export async function readPack(facilityId: string, id: string) {
  const [row] = await db
    .select()
    .from(downtimeExports)
    .where(and(eq(downtimeExports.id, id), eq(downtimeExports.facilityId, facilityId)));
  if (!row) throw notFound('Downtime pack not found');
  if (row.kind !== 'HTML_AES') {
    throw conflict('This copy is encrypted for the offline key and can only be opened with it');
  }
  let sealed: Buffer;
  try {
    sealed = await readFile(packPath(row.fileName));
  } catch {
    throw notFound('The downtime pack file is missing');
  }
  const html = openBuffer(sealed, PURPOSE);
  if (sha256(html) !== row.sha256) throw new Error('Downtime pack failed its integrity check');
  return { row, html };
}

export function latestPack(facilityId: string) {
  return db
    .select({
      id: downtimeExports.id,
      generatedAt: downtimeExports.generatedAt,
      patientCount: downtimeExports.patientCount,
      sha256: downtimeExports.sha256,
    })
    .from(downtimeExports)
    .where(and(eq(downtimeExports.facilityId, facilityId), eq(downtimeExports.kind, 'HTML_AES')))
    .orderBy(desc(downtimeExports.generatedAt))
    .limit(1)
    .then((r) => r[0] ?? null);
}

/* -------------------------------------------------------------- downtime mode */

export async function downtimeStatus(facilityId: string) {
  const [f] = await db
    .select({
      id: facilities.id,
      name: facilities.name,
      since: facilities.downtimeSince,
      note: facilities.downtimeNote,
    })
    .from(facilities)
    .where(eq(facilities.id, facilityId));
  if (!f) throw notFound('Facility not found');
  const last = await lastDowntimeWindow(facilityId);
  return {
    facilityId: f.id,
    facilityName: f.name,
    active: f.since !== null,
    since: f.since,
    note: f.note,
    latestPack: await latestPack(facilityId),
    lastWindow: f.since ? null : last,
  };
}

const NOTIFY_ROLES = [...FACILITY_ROLES];

export async function startDowntime(ctx: AuthContext, note: string | undefined, meta: RequestMeta) {
  const facilityId = ctx.facilityId!;
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(facilities)
      .set({ downtimeSince: now, downtimeNote: note?.trim() || null })
      .where(and(eq(facilities.id, facilityId), isNull(facilities.downtimeSince)))
      .returning({ since: facilities.downtimeSince, note: facilities.downtimeNote });
    if (!updated) throw conflict('Downtime procedures are already in effect');
    await audit(
      {
        action: AuditAction.DOWNTIME_STARTED,
        actor: ctx,
        meta,
        resourceType: 'facility',
        resourceId: facilityId,
        metadata: { since: now.toISOString(), note: updated.note },
      },
      tx,
    );
    await notifyFacilityRole(
      facilityId,
      NOTIFY_ROLES,
      {
        type: 'DOWNTIME',
        title: 'Downtime procedures are in effect – record on paper',
        link: '/downtime',
        important: true,
      },
      tx,
    );
    return updated;
  });
  return result;
}

export async function endDowntime(ctx: AuthContext, meta: RequestMeta) {
  const facilityId = ctx.facilityId!;
  const now = new Date();
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ since: facilities.downtimeSince })
      .from(facilities)
      .where(eq(facilities.id, facilityId))
      .for('update');
    if (!before?.since) throw conflict('Downtime procedures are not in effect');
    await tx
      .update(facilities)
      .set({ downtimeSince: null, downtimeNote: null })
      .where(eq(facilities.id, facilityId));
    const minutes = Math.round((now.getTime() - before.since.getTime()) / 60_000);
    await audit(
      {
        action: AuditAction.DOWNTIME_ENDED,
        actor: ctx,
        meta,
        resourceType: 'facility',
        resourceId: facilityId,
        metadata: { since: before.since.toISOString(), endedAt: now.toISOString(), minutes },
      },
      tx,
    );
    await notifyFacilityRole(
      facilityId,
      NOTIFY_ROLES,
      {
        type: 'DOWNTIME',
        title: 'Downtime has ended – back-enter paper records',
        link: '/downtime',
        important: true,
      },
      tx,
    );
    return { since: before.since, endedAt: now, minutes };
  });
}

/** The most recent finished downtime window, from the audit trail. */
async function lastDowntimeWindow(facilityId: string) {
  const [row] = await db
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(
      and(eq(auditLogs.action, AuditAction.DOWNTIME_ENDED), eq(auditLogs.resourceId, facilityId)),
    )
    .orderBy(desc(auditLogs.occurredAt))
    .limit(1);
  const m = row?.metadata as { since?: string; endedAt?: string } | null | undefined;
  if (!m?.since || !m.endedAt) return null;
  return { since: new Date(m.since), endedAt: new Date(m.endedAt) };
}

/* ------------------------------------------------------------- back-entry */

export const BACK_ENTRY_NOTE = 'Back-entered after downtime';

/**
 * Checklist after (or during) downtime: every inpatient of the facility during the downtime window
 * with how many medicine administrations and observations have been entered for that window so
 * far, and how many of them were back-entered (recorded after the time they happened).
 */
export async function backEntryChecklist(facilityId: string) {
  const [f] = await db
    .select({ since: facilities.downtimeSince })
    .from(facilities)
    .where(eq(facilities.id, facilityId));
  if (!f) throw notFound('Facility not found');
  const window = f.since
    ? { since: f.since, endedAt: null as Date | null, active: true }
    : { ...(await lastDowntimeWindow(facilityId)), active: false };
  if (!window.since) return { window: null, patients: [] };
  const since = window.since;
  const until = window.endedAt ?? new Date();

  const rows = await db
    .select({
      admissionId: admissions.id,
      patientId: patients.id,
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      unitName: careUnits.name,
      bed: beds.label,
      status: admissions.status,
      administrations: sql<number>`(
        SELECT count(*)::int FROM ${medicationAdministrations}
        WHERE ${medicationAdministrations.patientId} = ${patients.id}
          AND ${medicationAdministrations.administeredAt} BETWEEN ${since} AND ${until})`,
      administrationsBackEntered: sql<number>`(
        SELECT count(*)::int FROM ${medicationAdministrations}
        WHERE ${medicationAdministrations.patientId} = ${patients.id}
          AND ${medicationAdministrations.administeredAt} BETWEEN ${since} AND ${until}
          AND ${medicationAdministrations.createdAt} > ${medicationAdministrations.administeredAt} + interval '15 minutes')`,
      observations: sql<number>`(
        SELECT count(*)::int FROM ${vitalSigns}
        WHERE ${vitalSigns.patientId} = ${patients.id}
          AND ${vitalSigns.recordedAt} BETWEEN ${since} AND ${until})`,
    })
    .from(admissions)
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .leftJoin(beds, eq(beds.id, admissions.bedId))
    .where(
      and(
        eq(admissions.facilityId, facilityId),
        lte(admissions.admittedAt, until),
        or(isNull(admissions.dischargedAt), gte(admissions.dischargedAt, since)),
      ),
    )
    .orderBy(asc(careUnits.name), sql`${beds.label} NULLS LAST`, asc(patients.lastName));

  return {
    window: { since, endedAt: window.endedAt ?? null, active: window.active },
    patients: rows,
  };
}

/* ------------------------------------------------------------------ worker */

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

/** Hourly pack generation for every facility with wards. No-op in tests or when DOWNTIME_WORKER=false. */
export function startDowntimeWorker(intervalMs = PACK_INTERVAL_MS) {
  if (isTest || env.DOWNTIME_WORKER === 'false' || timer) return;
  const run = () =>
    generateDowntimePacks(undefined, new Date()).then(
      (packs) => logger.info({ packs: packs.length }, 'Downtime packs generated'),
      (err: unknown) => logger.error({ err }, 'Downtime pack generation failed'),
    );
  first = setTimeout(run, 60_000);
  first.unref();
  timer = setInterval(run, intervalMs);
  timer.unref();
}

export function stopDowntimeWorker() {
  clearTimeout(first);
  clearInterval(timer);
  first = undefined;
  timer = undefined;
}
