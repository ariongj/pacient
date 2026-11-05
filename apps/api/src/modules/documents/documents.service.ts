import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { patientDocuments, users } from '../../db/schema.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { openBuffer } from '../../lib/secret-box.js';
import type { ViewOptions } from '../clinical/clinical.service.js';
import { readSealedContent, StorageUnavailableError } from '../storage/storage.js';

export const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type AllowedType = (typeof ALLOWED_TYPES)[number];
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

const MAGIC: Record<AllowedType, Buffer> = {
  'application/pdf': Buffer.from('%PDF-', 'latin1'),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
};

/** The declared type must match the file's signature (no "PDF" that is really an executable). */
export function matchesSignature(type: AllowedType, content: Buffer): boolean {
  const magic = MAGIC[type];
  return content.length > magic.length && content.subarray(0, magic.length).equals(magic);
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Keeps a display-safe file name: no paths, control or reserved characters. */
export function safeFileName(raw: string | undefined, type: AllowedType): string {
  let name = '';
  try {
    name = decodeURIComponent(raw ?? '');
  } catch {
    name = raw ?? '';
  }
  name = name
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  const ext = type === 'application/pdf' ? 'pdf' : type === 'image/png' ? 'png' : 'jpg';
  return name || `document.${ext}`;
}

/**
 * Visibility rules shared by the list, the content download and the FHIR export:
 * patients see current documents shared with them; guardians additionally never see documents
 * marked confidential or recorded during a visit that is confidential from guardians.
 */
export function visibilityFilter(view: ViewOptions): SQL | undefined {
  if (!view.patientView) return undefined;
  const filters: SQL[] = [
    eq(patientDocuments.status, 'CURRENT'),
    eq(patientDocuments.visibleToPatient, true),
  ];
  if (view.hideConfidential) {
    filters.push(eq(patientDocuments.confidentialFromGuardians, false));
    filters.push(
      sql`NOT EXISTS (SELECT 1 FROM encounters ce WHERE ce.id = ${patientDocuments.encounterId} AND ce.confidential_from_guardians)`,
    );
  }
  return and(...filters);
}

const documentColumns = {
  id: patientDocuments.id,
  patientId: patientDocuments.patientId,
  encounterId: patientDocuments.encounterId,
  category: patientDocuments.category,
  title: patientDocuments.title,
  fileName: patientDocuments.fileName,
  mimeType: patientDocuments.mimeType,
  sizeBytes: patientDocuments.sizeBytes,
  sha256: patientDocuments.sha256,
  scanStatus: patientDocuments.scanStatus,
  source: patientDocuments.source,
  visibleToPatient: patientDocuments.visibleToPatient,
  confidentialFromGuardians: patientDocuments.confidentialFromGuardians,
  status: patientDocuments.status,
  errorReason: patientDocuments.errorReason,
  markedInErrorAt: patientDocuments.markedInErrorAt,
  storageBackend: patientDocuments.storageBackend,
  storageKey: patientDocuments.storageKey,
  version: patientDocuments.version,
  previousVersionId: patientDocuments.previousVersionId,
  supersededAt: patientDocuments.supersededAt,
  createdAt: patientDocuments.createdAt,
  uploadedById: patientDocuments.uploadedById,
  uploadedBy: users.fullName,
  uploadedByRole: users.role,
};

export type DocumentRow = Awaited<ReturnType<typeof getDocument>>;

/** Internal storage fields and the content hash are never sent to clients. */
export function publicDocument<
  T extends { sha256: string; storageKey: string | null; storageBackend: string },
>(d: T) {
  const { sha256: _h, storageKey: _k, storageBackend: _b, ...rest } = d;
  return rest;
}

/**
 * The latest version of each document (older versions are listed by listVersions). `version` is
 * also the number of versions, since every new version increments it by one.
 */
export async function listDocuments(patientId: string, view: ViewOptions) {
  return db
    .select(documentColumns)
    .from(patientDocuments)
    .innerJoin(users, eq(users.id, patientDocuments.uploadedById))
    .where(
      and(
        eq(patientDocuments.patientId, patientId),
        isNull(patientDocuments.supersededAt),
        visibilityFilter(view),
      ),
    )
    .orderBy(desc(patientDocuments.createdAt))
    .limit(500);
}

/** Every version of the document that `documentId` belongs to (newest first), as visible to the caller. */
export async function listVersions(patientId: string, documentId: string, view: ViewOptions) {
  const chain = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE older AS (
      SELECT id, previous_version_id FROM patient_documents
      WHERE id = ${documentId} AND patient_id = ${patientId}
      UNION
      SELECT d.id, d.previous_version_id FROM patient_documents d JOIN older o ON d.id = o.previous_version_id
    ), newer AS (
      SELECT id FROM patient_documents WHERE id = ${documentId} AND patient_id = ${patientId}
      UNION
      SELECT d.id FROM patient_documents d JOIN newer n ON d.previous_version_id = n.id
    )
    SELECT id FROM older UNION SELECT id FROM newer`);
  const ids = chain.rows.map((r) => r.id);
  if (!ids.length) return [];
  return db
    .select(documentColumns)
    .from(patientDocuments)
    .innerJoin(users, eq(users.id, patientDocuments.uploadedById))
    .where(
      and(
        inArray(patientDocuments.id, ids),
        eq(patientDocuments.patientId, patientId),
        visibilityFilter(view),
      ),
    )
    .orderBy(desc(patientDocuments.version));
}

export async function getDocument(patientId: string, documentId: string, view: ViewOptions) {
  const [row] = await db
    .select(documentColumns)
    .from(patientDocuments)
    .innerJoin(users, eq(users.id, patientDocuments.uploadedById))
    .where(
      and(
        eq(patientDocuments.id, documentId),
        eq(patientDocuments.patientId, patientId),
        visibilityFilter(view),
      ),
    );
  // A document the caller may not see is indistinguishable from one that does not exist.
  if (!row) throw notFound('Document not found');
  return row;
}

/**
 * Reads a document from its storage backend, decrypts it and checks it against the hash taken at
 * upload (so a swapped, truncated or altered object is never served).
 */
export async function readContent(doc: {
  id: string;
  sha256: string;
  storageBackend: string;
  storageKey: string | null;
}): Promise<Buffer> {
  const documentId = doc.id;
  const expectedSha256 = doc.sha256;
  let sealed: Buffer | null;
  try {
    sealed = await readSealedContent(doc);
  } catch (err) {
    if (err instanceof StorageUnavailableError) {
      logger.error({ err, documentId }, 'Document storage unavailable');
      throw new HttpError(
        503,
        'STORAGE_UNAVAILABLE',
        'The document store is temporarily unavailable. Please try again shortly.',
      );
    }
    throw err;
  }
  if (!sealed) {
    if (doc.storageBackend === 'S3') {
      logger.error({ documentId }, 'Document object missing from object storage');
      throw new HttpError(500, 'INTEGRITY_ERROR', 'The document could not be read');
    }
    throw notFound('Document content not found');
  }
  let plain: Buffer;
  try {
    plain = openBuffer(sealed);
  } catch (err) {
    logger.error({ err, documentId }, 'Document content failed authentication');
    throw new HttpError(500, 'INTEGRITY_ERROR', 'The document could not be read');
  }
  if (sha256(plain) !== expectedSha256) {
    logger.error({ documentId }, 'Document content does not match its recorded hash');
    throw new HttpError(500, 'INTEGRITY_ERROR', 'The document could not be read');
  }
  return plain;
}
