import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import type { Executor } from '../../db/client.js';
import { db } from '../../db/client.js';
import { documentContents } from '../../db/schema.js';
import { S3Client, S3Error } from './s3.js';

/**
 * Where encrypted document bytes live. Two backends coexist: DB (document_contents, the default)
 * and S3-compatible object storage. New documents go to the configured backend; every document is
 * read from the backend recorded on its row, so moving to object storage needs no downtime.
 *
 * Only ciphertext is ever handed to a backend (the caller seals the bytes first), and object keys
 * carry no patient identifiers: documents/<yyyy>/<mm>/<document id>.
 */
export type StorageBackend = 'DB' | 'S3';

export interface ObjectStore {
  put(key: string, bytes: Buffer): Promise<void>;
  /** null when the object does not exist */
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<{ size: number } | null>;
}

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageUnavailableError';
  }
}

function s3FromEnv(): ObjectStore {
  if (
    !env.STORAGE_S3_ENDPOINT ||
    !env.STORAGE_S3_BUCKET ||
    !env.STORAGE_S3_ACCESS_KEY_ID ||
    !env.STORAGE_S3_SECRET_ACCESS_KEY
  ) {
    throw new StorageUnavailableError('Object storage is not configured (STORAGE_S3_*)');
  }
  return s3Store(
    new S3Client({
      endpoint: env.STORAGE_S3_ENDPOINT,
      region: env.STORAGE_S3_REGION,
      bucket: env.STORAGE_S3_BUCKET,
      accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID,
      secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.STORAGE_S3_FORCE_PATH_STYLE === 'true',
      serverSideEncryption: env.STORAGE_S3_SSE,
      timeoutMs: env.STORAGE_S3_TIMEOUT_MS,
    }),
  );
}

/** Wraps an S3 client as an object store; network and server errors become StorageUnavailable. */
export function s3Store(client: S3Client): ObjectStore {
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof S3Error) throw new StorageUnavailableError(err.message);
      throw err;
    }
  };
  return {
    put: (key, bytes) => wrap(() => client.putObject(key, bytes)),
    get: (key) => wrap(() => client.getObject(key)),
    head: (key) => wrap(() => client.headObject(key)),
  };
}

let override: { backend: StorageBackend; store: ObjectStore | null } | null = null;
let cached: ObjectStore | null = null;

/** Tests: choose the backend for new documents and the object store to use (null = from env). */
export function setStorageForTests(
  config: { backend: StorageBackend; store?: ObjectStore | null } | null,
) {
  override = config ? { backend: config.backend, store: config.store ?? null } : null;
}

/** Backend for new documents. */
export function configuredBackend(): StorageBackend {
  if (override) return override.backend;
  return env.STORAGE_BACKEND === 's3' ? 'S3' : 'DB';
}

export function objectStore(): ObjectStore {
  if (override?.store) return override.store;
  cached ??= s3FromEnv();
  return cached;
}

/** documents/<yyyy>/<mm>/<id> – spreads objects over prefixes without revealing anything. */
export function documentKey(documentId: string, createdAt: Date): string {
  const yyyy = createdAt.getUTCFullYear();
  const mm = String(createdAt.getUTCMonth() + 1).padStart(2, '0');
  return `documents/${yyyy}/${mm}/${documentId}`;
}

/**
 * Stores sealed bytes for a new document. For S3 the object is written first (before the row
 * commits): if the transaction then fails, an orphaned ciphertext object remains, which is
 * harmless; the reverse order could commit a row whose content does not exist.
 */
export async function writeSealedContent(
  tx: Executor,
  doc: { id: string; createdAt: Date },
  sealed: Buffer,
  backend: StorageBackend = configuredBackend(),
): Promise<{ storageBackend: StorageBackend; storageKey: string | null }> {
  if (backend === 'S3') {
    const key = documentKey(doc.id, doc.createdAt);
    await objectStore().put(key, sealed);
    return { storageBackend: 'S3', storageKey: key };
  }
  await tx.insert(documentContents).values({ documentId: doc.id, content: sealed });
  return { storageBackend: 'DB', storageKey: null };
}

/** Sealed bytes of a document, from the backend recorded on its row; null when missing. */
export async function readSealedContent(doc: {
  id: string;
  storageBackend: string;
  storageKey: string | null;
}): Promise<Buffer | null> {
  if (doc.storageBackend === 'S3') {
    if (!doc.storageKey) return null;
    return objectStore().get(doc.storageKey);
  }
  const [row] = await db
    .select({ content: documentContents.content })
    .from(documentContents)
    .where(eq(documentContents.documentId, doc.id));
  return row?.content ?? null;
}
