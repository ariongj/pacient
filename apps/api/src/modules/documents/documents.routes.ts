import { randomUUID } from 'node:crypto';
import express, { Router, type Request, type RequestHandler } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import { documentCategoryEnum, encounters, patientDocuments } from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { sealBuffer } from '../../lib/secret-box.js';
import { authenticate } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  resolveAndAuditRead,
  resolveClinicalReadAccess,
  WRITERS,
  type ClinicalAccessBasis,
} from '../access/policy.js';
import { audit, AuditAction, auditSafe } from '../audit/audit.service.js';
import { assertEncounterBelongsToPatient, viewFor } from '../clinical/clinical.service.js';
import { notifyCareTeam, notifyPatient } from '../notifications/notifications.service.js';
import {
  ALLOWED_TYPES,
  getDocument,
  listDocuments,
  listVersions,
  matchesSignature,
  MAX_DOCUMENT_BYTES,
  publicDocument,
  readContent,
  safeFileName,
  sha256,
  type AllowedType,
} from './documents.service.js';
import { getScanner } from './scanner.js';
import {
  configuredBackend,
  documentKey,
  StorageUnavailableError,
  writeSealedContent,
  type StorageBackend,
} from '../storage/storage.js';

/**
 * Documents in a patient's record: scanned letters, reports, photos and signed consent forms.
 *
 * - Content is checked against its declared type (file signature), optionally malware-scanned,
 *   hashed and stored encrypted; it is never written to disk or logs.
 * - The care team uploads and decides what is shared with the patient. Patients (and guardians
 *   with full access) can add their own documents, e.g. results from a clinic abroad.
 * - Documents are never deleted: a wrong upload is marked "entered in error" with a reason.
 * - Every upload, rejection, view and change is audited against the patient.
 */
export const documentsRouter = Router({ mergeParams: true });
documentsRouter.use(authenticate);

const PatientParam = z.object({ patientId: z.string().uuid() });
const DocumentParams = PatientParam.extend({ documentId: z.string().uuid() });
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');

const UploadQuery = z.object({
  category: z.enum(documentCategoryEnum.enumValues).optional(),
  title: z.string().trim().min(2).max(200).optional(),
  encounterId: z.string().uuid().optional(),
  visibleToPatient: flag.optional(),
  confidentialFromGuardians: flag.optional(),
});

declare module 'express-serve-static-core' {
  interface Request {
    documentAccess?: ClinicalAccessBasis;
  }
}

/** Authorise before the body is read, so refused callers never get to upload 10 MB. */
const authoriseUpload: RequestHandler = async (req, _res, next) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  req.documentAccess =
    ctx.role === 'PATIENT'
      ? await resolveClinicalReadAccess(ctx, patientId, requestMeta(req))
      : await assertClinicalWriteAccess(ctx, patientId, requestMeta(req), WRITERS.careTeam);
  next();
};

const rawBody = express.raw({ type: [...ALLOWED_TYPES], limit: MAX_DOCUMENT_BYTES });

/**
 * Checks an uploaded body (declared type, file signature, optional malware scan). Rejections are
 * audited against the patient.
 */
async function checkUpload(req: Request, ctx: AuthContext, patientId: string) {
  const meta = requestMeta(req);
  const declared = (req.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!ALLOWED_TYPES.includes(declared as AllowedType) || !Buffer.isBuffer(req.body)) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload a PDF, JPEG or PNG file');
  }
  const type = declared as AllowedType;
  const content = req.body as Buffer;
  if (!content.length) throw badRequest('The file is empty');
  const fileName = safeFileName(req.get('x-file-name'), type);

  const reject = async (reason: string) =>
    auditSafe({
      action: AuditAction.DOCUMENT_REJECTED,
      actor: ctx,
      resourceType: 'patient',
      resourceId: patientId,
      patientId,
      outcome: 'FAILURE',
      meta,
      metadata: { reason, declaredType: type, sizeBytes: content.length },
    });

  if (!matchesSignature(type, content)) {
    await reject('signature_mismatch');
    throw new HttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'The file content does not match its type. Upload a real PDF, JPEG or PNG file.',
    );
  }

  const scanner = getScanner();
  let scanStatus: 'CLEAN' | 'NOT_SCANNED' = 'NOT_SCANNED';
  if (scanner) {
    let result;
    try {
      result = await scanner(content);
    } catch (err) {
      logger.error({ err }, 'Malware scanner unavailable');
      throw new HttpError(
        503,
        'SCANNER_UNAVAILABLE',
        'Uploads are temporarily unavailable. Please try again shortly.',
      );
    }
    if (!result.clean) {
      await reject(`malware:${result.signature}`);
      throw new HttpError(
        422,
        'MALWARE_DETECTED',
        'This file was blocked because it appears to contain malware.',
      );
    }
    scanStatus = 'CLEAN';
  }
  return { type, content, fileName, scanStatus };
}

/** Encrypts and stores new content; storage outages become 503 (nothing is recorded). */
/** Backend and object key for a new document (decided before the row is written). */
function plannedStorage(id: string, createdAt: Date) {
  const storageBackend = configuredBackend();
  return {
    storageBackend,
    storageKey: storageBackend === 'S3' ? documentKey(id, createdAt) : null,
  };
}

async function storeContent(
  tx: Executor,
  doc: { id: string; createdAt: Date },
  content: Buffer,
  backend: StorageBackend,
) {
  try {
    return await writeSealedContent(tx, doc, sealBuffer(content), backend);
  } catch (err) {
    if (err instanceof StorageUnavailableError) {
      logger.error({ err, documentId: doc.id }, 'Document storage unavailable');
      throw new HttpError(
        503,
        'STORAGE_UNAVAILABLE',
        'Uploads are temporarily unavailable. Please try again shortly.',
      );
    }
    throw err;
  }
}

documentsRouter.post('/', authoriseUpload, rawBody, async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const q = parse(UploadQuery, req.query);
  const meta = requestMeta(req);
  const { type, content, fileName, scanStatus } = await checkUpload(req, ctx, patientId);

  const fromPatient = ctx.role === 'PATIENT';
  if (!fromPatient && !q.category) throw badRequest('Choose a document category');
  if (!fromPatient && q.encounterId)
    await assertEncounterBelongsToPatient(q.encounterId, patientId);
  // A document of a visit hidden from guardians is hidden from them too (and not announced).
  const encounterConfidential =
    !fromPatient && q.encounterId
      ? (
          await db
            .select({ c: encounters.confidentialFromGuardians })
            .from(encounters)
            .where(eq(encounters.id, q.encounterId))
        )[0]?.c === true
      : false;
  const id = randomUUID();
  const createdAt = new Date();
  const placement = plannedStorage(id, createdAt);
  const values = {
    id,
    createdAt,
    ...placement,
    patientId,
    encounterId: fromPatient ? null : (q.encounterId ?? null),
    category: fromPatient ? ('PATIENT_PROVIDED' as const) : q.category!,
    title: q.title ?? fileName.replace(/\.[a-z0-9]+$/i, ''),
    fileName,
    mimeType: type,
    sizeBytes: content.length,
    sha256: sha256(content),
    scanStatus,
    source: fromPatient ? 'PATIENT' : 'STAFF',
    visibleToPatient: fromPatient ? true : (q.visibleToPatient ?? false),
    confidentialFromGuardians: fromPatient
      ? false
      : encounterConfidential || (q.confidentialFromGuardians ?? false),
    facilityId: ctx.facilityId ?? null,
    uploadedById: ctx.userId,
  };

  const doc = await db.transaction(async (tx) => {
    const [row] = await tx.insert(patientDocuments).values(values).returning();
    const stored = await storeContent(tx, { id, createdAt }, content, placement.storageBackend);
    await audit(
      {
        action: AuditAction.DOCUMENT_UPLOADED,
        actor: ctx,
        resourceType: 'document',
        resourceId: row!.id,
        patientId,
        meta,
        metadata: {
          category: row!.category,
          sizeBytes: row!.sizeBytes,
          scanStatus,
          basis: req.documentAccess,
          sharedWithPatient: row!.visibleToPatient,
          storage: stored.storageBackend,
        },
      },
      tx,
    );
    if (fromPatient) {
      await notifyCareTeam(
        patientId,
        {
          type: 'document',
          title: 'A patient added a document to their record',
          link: `/doctor/patients/${patientId}?tab=documents`,
        },
        tx,
      );
    } else if (row!.visibleToPatient) {
      await notifyPatient(
        patientId,
        {
          type: 'document',
          title: 'A new document is available in your record',
          link: '/portal/documents',
        },
        tx,
        { guardians: row!.confidentialFromGuardians ? 'none' : 'full' },
      );
    }
    return row!;
  });
  res.status(201).json(publicDocument(doc));
});

const VersionQuery = z.object({ title: z.string().trim().min(2).max(200).optional() });

/**
 * A new version of a document (e.g. a corrected or signed letter). It keeps the category,
 * visit and sharing of the version it replaces; that version stays readable in the history.
 * Staff version care-team documents, patients version the documents they provided. Only the
 * latest version can be replaced – the unique index on previous_version_id guarantees a single
 * line of versions even when two people upload at the same moment.
 */
documentsRouter.post('/:documentId/versions', authoriseUpload, rawBody, async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId, documentId } = parse(DocumentParams, req.params);
  const q = parse(VersionQuery, req.query);
  const meta = requestMeta(req);
  const basis = req.documentAccess!;
  const previous = await getDocument(patientId, documentId, viewFor(basis));
  const fromPatient = ctx.role === 'PATIENT';
  if (fromPatient ? previous.source !== 'PATIENT' : previous.source !== 'STAFF') {
    throw forbidden(
      fromPatient
        ? 'You can only replace documents you added yourself'
        : 'Documents provided by the patient can only be replaced by the patient',
    );
  }
  if (previous.supersededAt) throw conflict('A newer version of this document already exists');
  if (previous.status !== 'CURRENT') throw conflict('This document was entered in error');
  const { type, content, fileName, scanStatus } = await checkUpload(req, ctx, patientId);

  const id = randomUUID();
  const createdAt = new Date();
  const placement = plannedStorage(id, createdAt);
  let doc;
  try {
    doc = await db.transaction(async (tx) => {
      // Lock the version being replaced so concurrent uploads cannot both succeed.
      const [locked] = await tx
        .update(patientDocuments)
        .set({ supersededAt: createdAt })
        .where(
          and(
            eq(patientDocuments.id, previous.id),
            isNull(patientDocuments.supersededAt),
            eq(patientDocuments.status, 'CURRENT'),
          ),
        )
        .returning({ id: patientDocuments.id });
      if (!locked) throw conflict('A newer version of this document already exists');
      const [row] = await tx
        .insert(patientDocuments)
        .values({
          id,
          createdAt,
          ...placement,
          patientId,
          encounterId: previous.encounterId,
          category: previous.category,
          title: q.title ?? previous.title,
          fileName,
          mimeType: type,
          sizeBytes: content.length,
          sha256: sha256(content),
          scanStatus,
          source: previous.source,
          visibleToPatient: previous.visibleToPatient,
          confidentialFromGuardians: previous.confidentialFromGuardians,
          facilityId: ctx.facilityId ?? null,
          uploadedById: ctx.userId,
          version: previous.version + 1,
          previousVersionId: previous.id,
        })
        .returning();
      const stored = await storeContent(tx, { id, createdAt }, content, placement.storageBackend);
      await audit(
        {
          action: AuditAction.DOCUMENT_VERSION_ADDED,
          actor: ctx,
          resourceType: 'document',
          resourceId: id,
          patientId,
          meta,
          metadata: {
            previousVersionId: previous.id,
            version: row!.version,
            category: row!.category,
            sizeBytes: row!.sizeBytes,
            scanStatus,
            basis,
            storage: stored.storageBackend,
          },
        },
        tx,
      );
      if (fromPatient) {
        await notifyCareTeam(
          patientId,
          {
            type: 'document',
            title: 'A patient added a document to their record',
            link: `/doctor/patients/${patientId}?tab=documents`,
          },
          tx,
        );
      } else if (row!.visibleToPatient) {
        await notifyPatient(
          patientId,
          {
            type: 'document',
            title: 'A new document is available in your record',
            link: '/portal/documents',
          },
          tx,
          { guardians: row!.confidentialFromGuardians ? 'none' : 'full' },
        );
      }
      return row!;
    });
  } catch (err) {
    // Unique index on previous_version_id: someone else replaced it first.
    if (
      (err as { code?: string; cause?: { code?: string } }).code === '23505' ||
      (err as { cause?: { code?: string } }).cause?.code === '23505'
    ) {
      throw conflict('A newer version of this document already exists');
    }
    throw err;
  }
  res.status(201).json(publicDocument(doc));
});

/** All versions of a document, newest first (each as visible to the caller). */
documentsRouter.get('/:documentId/versions', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId, documentId } = parse(DocumentParams, req.params);
  const basis = await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'documents');
  const view = viewFor(basis);
  await getDocument(patientId, documentId, view);
  const items = await listVersions(patientId, documentId, view);
  res.json({ items: items.map(publicDocument) });
});

documentsRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const basis = await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'documents');
  const items = await listDocuments(patientId, viewFor(basis));
  res.json({ items: items.map(publicDocument) });
});

documentsRouter.get('/:documentId/content', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId, documentId } = parse(DocumentParams, req.params);
  const meta = requestMeta(req);
  const basis = await resolveClinicalReadAccess(ctx, patientId, meta);
  const doc = await getDocument(patientId, documentId, viewFor(basis));
  const content = await readContent(doc);
  await audit({
    action: AuditAction.DOCUMENT_VIEWED,
    actor: ctx,
    resourceType: 'document',
    resourceId: doc.id,
    patientId,
    meta,
    metadata: { basis, category: doc.category },
  });
  const ascii = doc.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res
    .status(200)
    .set({
      'Content-Type': doc.mimeType,
      'Content-Length': String(content.length),
      'Content-Disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'",
      'Cache-Control': 'no-store',
    })
    .end(content);
});

const PatchSchema = z
  .object({
    visibleToPatient: z.boolean().optional(),
    confidentialFromGuardians: z.boolean().optional(),
  })
  .refine(
    (v) => v.visibleToPatient !== undefined || v.confidentialFromGuardians !== undefined,
    'Nothing to change',
  );

/** Doctors decide what is shared with the patient and what is withheld from guardians. */
documentsRouter.patch('/:documentId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId, documentId } = parse(DocumentParams, req.params);
  const input = parse(PatchSchema, req.body);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.doctorOnly);
  const doc = await getDocument(patientId, documentId, {
    patientView: false,
    hideConfidential: false,
  });
  if (doc.status !== 'CURRENT') throw conflict('This document was entered in error');
  if (doc.supersededAt) throw conflict('Change the sharing of the latest version instead');
  if (doc.source === 'PATIENT' && input.visibleToPatient === false) {
    throw badRequest('Documents the patient provided always stay visible to them');
  }
  const newlyShared = input.visibleToPatient === true && !doc.visibleToPatient;
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(patientDocuments)
      .set(input)
      .where(eq(patientDocuments.id, documentId))
      .returning();
    await audit(
      {
        action: AuditAction.DOCUMENT_SHARED,
        actor: ctx,
        resourceType: 'document',
        resourceId: documentId,
        patientId,
        meta,
        metadata: input,
      },
      tx,
    );
    if (newlyShared) {
      await notifyPatient(
        patientId,
        {
          type: 'document',
          title: 'A new document is available in your record',
          link: '/portal/documents',
        },
        tx,
        { guardians: row!.confidentialFromGuardians ? 'none' : 'full' },
      );
    }
    return row!;
  });
  res.json(publicDocument(updated));
});

documentsRouter.post('/:documentId/entered-in-error', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId, documentId } = parse(DocumentParams, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(300) }), req.body);
  const meta = requestMeta(req);
  const basis = await resolveClinicalReadAccess(ctx, patientId, meta);
  const doc = await getDocument(patientId, documentId, viewFor(basis));
  const isUploader = doc.uploadedById === ctx.userId;
  if (!isUploader) {
    if (ctx.role !== 'DOCTOR') {
      throw forbidden('Only the person who uploaded it or a treating doctor can do this');
    }
    await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.doctorOnly);
  }
  if (doc.status !== 'CURRENT') throw conflict('Already marked as entered in error');
  const [row] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(patientDocuments)
      .set({
        status: 'ENTERED_IN_ERROR',
        errorReason: reason,
        markedInErrorById: ctx.userId,
        markedInErrorAt: new Date(),
      })
      .where(and(eq(patientDocuments.id, documentId), eq(patientDocuments.status, 'CURRENT')))
      .returning();
    await audit(
      {
        action: AuditAction.DOCUMENT_MARKED_IN_ERROR,
        actor: ctx,
        resourceType: 'document',
        resourceId: documentId,
        patientId,
        meta,
        metadata: { reason },
      },
      tx,
    );
    return rows;
  });
  if (!row) throw conflict('Already marked as entered in error');
  res.json(publicDocument(row));
});
