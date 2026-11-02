import { createHash } from 'node:crypto';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { documentContents, patientDocuments, users } from '../../db/schema.js';
import { HttpError, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { openBuffer } from '../../lib/secret-box.js';
import type { ViewOptions } from '../clinical/clinical.service.js';

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
  createdAt: patientDocuments.createdAt,
  uploadedById: patientDocuments.uploadedById,
  uploadedBy: users.fullName,
  uploadedByRole: users.role,
};

export async function listDocuments(patientId: string, view: ViewOptions) {
  return db
    .select(documentColumns)
    .from(patientDocuments)
    .innerJoin(users, eq(users.id, patientDocuments.uploadedById))
    .where(and(eq(patientDocuments.patientId, patientId), visibilityFilter(view)))
    .orderBy(desc(patientDocuments.createdAt))
    .limit(500);
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

/** Decrypts a document and checks it against the hash taken at upload. */
export async function readContent(documentId: string, expectedSha256: string): Promise<Buffer> {
  const [row] = await db
    .select({ content: documentContents.content })
    .from(documentContents)
    .where(eq(documentContents.documentId, documentId));
  if (!row) throw notFound('Document content not found');
  let plain: Buffer;
  try {
    plain = openBuffer(row.content);
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
