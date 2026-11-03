import type { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { encounters, imagingOrders, patients } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { requireRole } from '../../middleware/auth.js';
import { resolveClinicalReadAccess } from '../access/policy.js';
import { audit, AuditAction, auditSafe } from '../audit/audit.service.js';
import { viewFor } from '../clinical/clinical.service.js';
import {
  findStudyByAccession,
  isUid,
  listSeries,
  pacsConfig,
  renderImage,
  studyExists,
  windowPresets,
  type StudyRef,
} from '../pacs/index.js';
import { isRadiologyStaff } from './imaging.service.js';

/**
 * Image viewing through an authorised proxy: the browser asks Pacient, Pacient checks access and
 * fetches from the PACS (DICOMweb) or the development demo archive. PACS addresses and
 * credentials never reach the client.
 */
const IdParam = z.object({ id: z.string().uuid() });
const ImageParams = IdParam.extend({
  seriesUid: z.string().max(64),
  instanceUid: z.string().max(64),
});
const RenderQuery = z.object({
  window: z.coerce.number().int().min(1).max(10_000).optional(),
  level: z.coerce.number().int().min(-2000).max(10_000).optional(),
});

type Order = typeof imagingOrders.$inferSelect;

async function getOrder(id: string): Promise<Order> {
  const [row] = await db.select().from(imagingOrders).where(eq(imagingOrders.id, id));
  if (!row) throw notFound('Imaging order not found');
  return row;
}

/* Positive access decisions are cached briefly: a viewer loads dozens of images per minute. */
const accessCache = new Map<string, { at: number; patientView: boolean }>();
const viewAudits = new Map<string, number>();

async function assertCanView(ctx: AuthContext, order: Order, meta: ReturnType<typeof requestMeta>) {
  const key = `${ctx.userId}:${ctx.proxy?.guardianshipId ?? '-'}:${order.id}`;
  const cached = accessCache.get(key);
  if (cached && cached.at > Date.now() - 60_000) return cached;
  let patientView = false;
  const radiology =
    (ctx.role === 'DOCTOR' || ctx.role === 'NURSE') &&
    ctx.facilityId === order.facilityId &&
    (await isRadiologyStaff(ctx.userId, order.facilityId));
  if (!radiology) {
    const view = viewFor(await resolveClinicalReadAccess(ctx, order.patientId, meta));
    patientView = view.patientView;
    if (view.patientView && !(order.status === 'REPORTED' && order.releasedAt)) {
      throw forbidden('Images become available once your report has been released');
    }
    if (view.hideConfidential && order.encounterId) {
      const [enc] = await db
        .select({ confidential: encounters.confidentialFromGuardians })
        .from(encounters)
        .where(eq(encounters.id, order.encounterId));
      if (enc?.confidential) throw forbidden('These images are not available to guardians');
    }
  }
  const decision = { at: Date.now(), patientView };
  accessCache.set(key, decision);
  if (accessCache.size > 5000) accessCache.clear();
  return decision;
}

/** One audit entry per person, examination and 10 minutes – visible in the patient's access log. */
async function auditViewing(ctx: AuthContext, order: Order, meta: ReturnType<typeof requestMeta>) {
  const key = `${ctx.userId}:${order.id}`;
  const now = Date.now();
  if ((viewAudits.get(key) ?? 0) > now - 10 * 60_000) return;
  viewAudits.set(key, now);
  if (viewAudits.size > 10_000) viewAudits.clear();
  await auditSafe({
    action: AuditAction.IMAGES_VIEWED,
    actor: ctx,
    resourceType: 'imaging_order',
    resourceId: order.id,
    patientId: order.patientId,
    meta,
    metadata: { accessionNumber: order.accessionNumber, modality: order.modality },
  });
}

const studyRef = (order: Order): StudyRef => {
  if (!order.studyInstanceUid) throw notFound('No images are linked to this examination yet');
  return {
    studyInstanceUid: order.studyInstanceUid,
    accessionNumber: order.accessionNumber,
    modality: order.modality,
    bodyPart: order.bodyPart,
  };
};

async function linkStudy(
  ctx: AuthContext,
  order: Order,
  studyInstanceUid: string,
  via: 'MANUAL' | 'LOOKUP' | 'DEMO',
  meta: ReturnType<typeof requestMeta>,
) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(imagingOrders)
      .set({ studyInstanceUid, imagesAvailableAt: order.imagesAvailableAt ?? new Date() })
      .where(eq(imagingOrders.id, order.id))
      .returning();
    await audit(
      {
        action: AuditAction.IMAGING_STATUS_CHANGED,
        actor: ctx,
        resourceType: 'imaging_order',
        resourceId: order.id,
        patientId: order.patientId,
        meta,
        metadata: { studyLinked: studyInstanceUid, via },
      },
      tx,
    );
    return updated!;
  });
}

async function assertCanLink(ctx: AuthContext, order: Order) {
  if (
    ctx.facilityId !== order.facilityId ||
    !(await isRadiologyStaff(ctx.userId, order.facilityId))
  ) {
    throw forbidden('Only radiology staff link images to an examination');
  }
  if (!['PERFORMED', 'REPORTED'].includes(order.status)) {
    throw conflict('Images can be linked once the examination has been performed');
  }
}

export function registerImageRoutes(router: Router) {
  /** Link a known Study Instance UID. */
  router.post('/orders/:id/study', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const { studyInstanceUid } = parse(
      z.object({ studyInstanceUid: z.string().trim().max(64) }),
      req.body,
    );
    if (!isUid(studyInstanceUid)) throw badRequest('Enter a valid DICOM Study Instance UID');
    const order = await getOrder(id);
    await assertCanLink(ctx, order);
    if (!(await studyExists(studyInstanceUid))) {
      throw notFound('This study was not found in the PACS');
    }
    res.json(await linkStudy(ctx, order, studyInstanceUid, 'MANUAL', requestMeta(req)));
  });

  /** Find the study in the PACS by accession number and link it. */
  router.post('/orders/:id/study/lookup', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const order = await getOrder(id);
    await assertCanLink(ctx, order);
    const uid = await findStudyByAccession(order.accessionNumber);
    if (!uid) throw notFound('No study with this accession number was found in the PACS');
    res.json(
      await linkStudy(
        ctx,
        order,
        uid,
        pacsConfig().mode === 'demo' ? 'DEMO' : 'LOOKUP',
        requestMeta(req),
      ),
    );
  });

  /** Series and images of the examination (no pixel data). */
  router.get('/orders/:id/images', async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const order = await getOrder(id);
    const meta = requestMeta(req);
    const decision = await assertCanView(ctx, order, meta);
    const series = await listSeries(studyRef(order));
    await auditViewing(ctx, order, meta);
    const [patient] = await db
      .select({
        firstName: patients.firstName,
        lastName: patients.lastName,
        dateOfBirth: patients.dateOfBirth,
        sex: patients.sex,
        temporaryIdentity: patients.temporaryIdentity,
      })
      .from(patients)
      .where(eq(patients.id, order.patientId));
    res.set('Cache-Control', 'no-store');
    res.json({
      order: {
        id: order.id,
        patientId: order.patientId,
        accessionNumber: order.accessionNumber,
        modality: order.modality,
        bodyPart: order.bodyPart,
        status: order.status,
        performedAt: order.performedAt,
        reportedAt: order.reportedAt,
        impression: order.status === 'REPORTED' ? order.impression : null,
        critical: decision.patientView ? undefined : order.critical,
      },
      patient,
      mode: pacsConfig().mode,
      presets: windowPresets(order.modality),
      series,
    });
  });

  /** One display image (PNG/JPEG) – from the PACS or the demo archive. */
  router.get('/orders/:id/images/:seriesUid/:instanceUid/rendered', async (req, res) => {
    const ctx = requireAuth(req);
    const { id, seriesUid, instanceUid } = parse(ImageParams, req.params);
    const q = parse(RenderQuery, req.query);
    const order = await getOrder(id);
    const meta = requestMeta(req);
    const decision = await assertCanView(ctx, order, meta);
    const window =
      q.window !== undefined && q.level !== undefined
        ? { width: q.window, level: q.level }
        : undefined;
    const image = await renderImage(studyRef(order), seriesUid, instanceUid, window);
    await auditViewing(ctx, order, meta);
    res
      .status(200)
      .type(image.contentType)
      .set('Cache-Control', decision.patientView ? 'no-store' : 'private, max-age=300')
      .set('X-Content-Type-Options', 'nosniff')
      .send(image.body);
  });
}

/** In demo mode, performing an examination creates its synthetic study immediately. */
export async function demoStudyOnPerform(order: Order): Promise<Partial<Order>> {
  if (pacsConfig().mode !== 'demo' || order.studyInstanceUid) return {};
  const uid = await findStudyByAccession(order.accessionNumber);
  return uid ? { studyInstanceUid: uid, imagesAvailableAt: new Date() } : {};
}
