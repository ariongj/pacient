/**
 * Moves document contents from PostgreSQL (document_contents) to S3-compatible object storage.
 *
 *   npm run documents:migrate-to-s3 -w apps/api -- [--batch 100] [--limit N] [--dry-run]
 *                                                  [--delete-db-copies]
 *
 * For each document still stored in the database it uploads the (already encrypted) bytes to
 * documents/<yyyy>/<mm>/<id>, reads the object back and checks it – same ciphertext hash, and it
 * decrypts to the plaintext hash recorded at upload – and only then switches the row to S3.
 * Database copies are KEPT unless --delete-db-copies is given; with that flag, copies of documents
 * already on S3 are removed too, each after the same verification. Safe to stop and re-run at any
 * time (idempotent). Requires STORAGE_S3_* settings.
 */
import { pathToFileURL } from 'node:url';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db, pool } from './client.js';
import { documentContents, patientDocuments } from './schema.js';
import { openBuffer } from '../lib/secret-box.js';
import { sha256 } from '../modules/documents/documents.service.js';
import { documentKey, objectStore, type ObjectStore } from '../modules/storage/storage.js';

export interface MigrateOptions {
  store?: ObjectStore;
  batchSize?: number;
  /** Stop after this many documents (0 = all). */
  limit?: number;
  dryRun?: boolean;
  deleteDbCopies?: boolean;
  log?: (line: string) => void;
}

export interface MigrateResult {
  migrated: number;
  verifiedCopiesDeleted: number;
  failed: { documentId: string; reason: string }[];
  remaining: number;
}

/** The object must hold exactly these sealed bytes, and they must open to the recorded hash. */
async function verifyObject(
  store: ObjectStore,
  key: string,
  sealed: Buffer,
  plaintextSha256: string,
): Promise<string | null> {
  const head = await store.head(key);
  if (!head) return 'object missing after upload';
  if (head.size !== sealed.length) return `size mismatch (${head.size} ≠ ${sealed.length})`;
  const back = await store.get(key);
  if (!back) return 'object missing on read-back';
  if (sha256(back) !== sha256(sealed)) return 'read-back differs from the stored ciphertext';
  try {
    if (sha256(openBuffer(back)) !== plaintextSha256) return 'content hash mismatch';
  } catch {
    return 'content does not decrypt';
  }
  return null;
}

export async function migrateDocumentsToS3(opts: MigrateOptions = {}): Promise<MigrateResult> {
  const store = opts.store ?? objectStore();
  const batchSize = opts.batchSize ?? 100;
  const log = opts.log ?? ((l: string) => console.log(l));
  const result: MigrateResult = { migrated: 0, verifiedCopiesDeleted: 0, failed: [], remaining: 0 };
  let cursor = '00000000-0000-0000-0000-000000000000';
  let processed = 0;

  // 1. Documents still on the database backend.
  for (;;) {
    if (opts.limit && processed >= opts.limit) break;
    const take = opts.limit ? Math.min(batchSize, opts.limit - processed) : batchSize;
    const rows = await db
      .select({
        id: patientDocuments.id,
        createdAt: patientDocuments.createdAt,
        sha256: patientDocuments.sha256,
        content: documentContents.content,
      })
      .from(patientDocuments)
      .innerJoin(documentContents, eq(documentContents.documentId, patientDocuments.id))
      .where(and(eq(patientDocuments.storageBackend, 'DB'), gt(patientDocuments.id, cursor)))
      .orderBy(asc(patientDocuments.id))
      .limit(take);
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      processed++;
      const key = documentKey(row.id, row.createdAt);
      if (opts.dryRun) {
        log(`would move ${row.id} → ${key} (${row.content.length} bytes)`);
        continue;
      }
      try {
        // Idempotent: an object left by an interrupted run is simply overwritten.
        await store.put(key, row.content);
        const problem = await verifyObject(store, key, row.content, row.sha256);
        if (problem) {
          result.failed.push({ documentId: row.id, reason: problem });
          log(`FAILED ${row.id}: ${problem} (left on the database backend)`);
          continue;
        }
        await db.transaction(async (tx) => {
          await tx
            .update(patientDocuments)
            .set({ storageBackend: 'S3', storageKey: key })
            .where(and(eq(patientDocuments.id, row.id), eq(patientDocuments.storageBackend, 'DB')));
          if (opts.deleteDbCopies) {
            await tx.delete(documentContents).where(eq(documentContents.documentId, row.id));
          }
        });
        result.migrated++;
        if (opts.deleteDbCopies) result.verifiedCopiesDeleted++;
      } catch (err) {
        result.failed.push({ documentId: row.id, reason: (err as Error).message });
        log(`FAILED ${row.id}: ${(err as Error).message}`);
      }
    }
    log(`… ${processed} processed, ${result.migrated} moved, ${result.failed.length} failed`);
  }

  // 2. With --delete-db-copies: remove database copies of documents already on S3 (re-verified).
  if (opts.deleteDbCopies && !opts.dryRun) {
    cursor = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const rows = await db
        .select({
          id: patientDocuments.id,
          storageKey: patientDocuments.storageKey,
          sha256: patientDocuments.sha256,
          content: documentContents.content,
        })
        .from(patientDocuments)
        .innerJoin(documentContents, eq(documentContents.documentId, patientDocuments.id))
        .where(and(eq(patientDocuments.storageBackend, 'S3'), gt(patientDocuments.id, cursor)))
        .orderBy(asc(patientDocuments.id))
        .limit(batchSize);
      if (!rows.length) break;
      const verified: string[] = [];
      for (const row of rows) {
        cursor = row.id;
        const problem = row.storageKey
          ? await verifyObject(store, row.storageKey, row.content, row.sha256).catch(
              (e: Error) => e.message,
            )
          : 'no object key';
        if (problem) {
          result.failed.push({ documentId: row.id, reason: problem });
          log(`KEPT database copy of ${row.id}: ${problem}`);
        } else verified.push(row.id);
      }
      if (verified.length) {
        await db.delete(documentContents).where(inArray(documentContents.documentId, verified));
        result.verifiedCopiesDeleted += verified.length;
      }
    }
  }

  const [left] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(patientDocuments)
    .where(eq(patientDocuments.storageBackend, 'DB'));
  result.remaining = left?.n ?? 0;
  return result;
}

function flag(name: string) {
  return process.argv.includes(`--${name}`);
}
function value(name: string, fallback: number) {
  const i = process.argv.indexOf(`--${name}`);
  const n = i > -1 ? Number(process.argv[i + 1]) : fallback;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  migrateDocumentsToS3({
    batchSize: value('batch', 100) || 100,
    limit: value('limit', 0),
    dryRun: flag('dry-run'),
    deleteDbCopies: flag('delete-db-copies'),
  })
    .then(async (r) => {
      console.log(
        `Done: ${r.migrated} moved, ${r.verifiedCopiesDeleted} database copies deleted, ` +
          `${r.failed.length} failed, ${r.remaining} still on the database backend.`,
      );
      await pool.end();
      process.exit(r.failed.length ? 1 : 0);
    })
    .catch(async (err) => {
      console.error(err);
      await pool.end();
      process.exit(1);
    });
}
