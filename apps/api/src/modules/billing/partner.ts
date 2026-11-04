import { Router } from 'express';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { charges, claims, facilities } from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse } from '../../lib/http.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyFacilityRole } from '../notifications/notifications.service.js';
import { auditPartner, requireScope } from '../partner/partner.auth.js';
import { claimLines } from './billing.routes.js';

/**
 * Partner API for the Health Insurance Fund (scope claims.read): read submitted claims and their
 * lines, and record payment decisions. Mounted at /api/v1/partner/claims; the partner key is
 * already authenticated. Line-level reads are audited per patient, so they appear in each
 * patient's "who viewed my record".
 */
export const billingPartnerRouter = Router();
billingPartnerRouter.use(requireScope('claims.read'));

const IdParam = z.object({ id: z.string().uuid() });

billingPartnerRouter.get('/', async (req, res) => {
  const q = parse(
    z.object({
      status: z
        .enum(['SUBMITTED', 'ACCEPTED', 'PARTIALLY_PAID', 'PAID', 'REJECTED'])
        .default('SUBMITTED'),
    }),
    req.query,
  );
  const filters: SQL[] = [eq(claims.status, q.status), eq(claims.insurer, 'FSSH')];
  const rows = await db
    .select({
      id: claims.id,
      reference: claims.reference,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      periodFrom: claims.periodFrom,
      periodTo: claims.periodTo,
      status: claims.status,
      totalCents: claims.totalCents,
      paidCents: claims.paidCents,
      submittedAt: claims.submittedAt,
      lineCount: sql<number>`(SELECT count(*)::int FROM charges c WHERE c.claim_id = ${claims.id})`,
    })
    .from(claims)
    .innerJoin(facilities, eq(facilities.id, claims.facilityId))
    .where(and(...filters))
    .orderBy(desc(claims.submittedAt))
    .limit(200);
  await auditPartner(req, req.partner!, {
    scope: 'claims.read',
    result: 'claims_listed',
    extra: { status: q.status, count: rows.length },
  });
  res.json({ items: rows });
});

billingPartnerRouter.get('/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const [claim] = await db
    .select({
      id: claims.id,
      reference: claims.reference,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      periodFrom: claims.periodFrom,
      periodTo: claims.periodTo,
      status: claims.status,
      totalCents: claims.totalCents,
      paidCents: claims.paidCents,
      submittedAt: claims.submittedAt,
    })
    .from(claims)
    .innerJoin(facilities, eq(facilities.id, claims.facilityId))
    .where(and(eq(claims.id, id), eq(claims.insurer, 'FSSH')));
  if (!claim || claim.status === 'DRAFT') throw notFound('Claim not found');
  const lines = await claimLines(id);
  // One audit entry per patient whose data the Fund read.
  const patientIds = [...new Set(lines.map((l) => l.patientId))];
  for (const patientId of patientIds) {
    await auditPartner(req, req.partner!, {
      scope: 'claims.read',
      purpose: 'PAYMENT',
      patientId,
      result: 'claim_lines_read',
      extra: { claimId: id, reference: claim.reference },
    });
  }
  res.json({
    ...claim,
    // Minimal data for payment: identifiers, service, date and amounts – no clinical detail.
    lines: lines.map((l) => ({
      id: l.id,
      nationalId: l.nationalId,
      policyNumber: l.policyNumber,
      serviceCode: l.serviceCode,
      serviceName: l.serviceName,
      serviceDate: l.serviceDate,
      quantity: l.quantity,
      insurerCents: l.insurerCents,
      status: l.status,
    })),
  });
});

const Decision = z.object({
  status: z.enum(['ACCEPTED', 'PARTIALLY_PAID', 'PAID', 'REJECTED']),
  paidCents: z.number().int().min(0).default(0),
  note: z.string().trim().max(1000).optional(),
  rejectedLineIds: z.array(z.string().uuid()).max(5000).default([]),
});

billingPartnerRouter.post('/:id/decision', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const input = parse(Decision, req.body);
  const [claim] = await db.select().from(claims).where(eq(claims.id, id));
  if (!claim || claim.insurer !== 'FSSH' || claim.status === 'DRAFT') {
    throw notFound('Claim not found');
  }
  if (['PAID', 'REJECTED'].includes(claim.status)) throw conflict('This claim is already closed');
  if (input.paidCents > claim.totalCents) throw badRequest('paidCents exceeds the claim total');
  if (input.status === 'PAID' && input.rejectedLineIds.length) {
    throw badRequest('A fully paid claim cannot have rejected lines; use PARTIALLY_PAID');
  }
  if (input.status === 'PARTIALLY_PAID' && !input.rejectedLineIds.length && input.paidCents === 0) {
    throw badRequest('A partial payment needs rejected lines or a paid amount');
  }
  const updated = await db.transaction(async (tx) => {
    if (input.rejectedLineIds.length) {
      const own = await tx
        .select({ id: charges.id })
        .from(charges)
        .where(and(eq(charges.claimId, id), inArray(charges.id, input.rejectedLineIds)));
      if (own.length !== new Set(input.rejectedLineIds).size) {
        throw badRequest('Some rejected lines are not part of this claim');
      }
    }
    if (input.status === 'REJECTED') {
      await tx.update(charges).set({ status: 'REJECTED' }).where(eq(charges.claimId, id));
    } else if (input.status === 'PAID' || input.status === 'PARTIALLY_PAID') {
      if (input.rejectedLineIds.length) {
        await tx
          .update(charges)
          .set({ status: 'REJECTED' })
          .where(and(eq(charges.claimId, id), inArray(charges.id, input.rejectedLineIds)));
      }
      await tx
        .update(charges)
        .set({ status: 'PAID' })
        .where(and(eq(charges.claimId, id), eq(charges.status, 'CLAIMED')));
    }
    const paidCents =
      input.status === 'PAID' && input.paidCents === 0 ? claim.totalCents : input.paidCents;
    const [row] = await tx
      .update(claims)
      .set({
        status: input.status,
        paidCents,
        respondedAt: new Date(),
        responseNote: input.note ?? null,
      })
      .where(eq(claims.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.CLAIM_DECIDED,
        actor: null,
        resourceType: 'claim',
        resourceId: id,
        metadata: {
          via: 'PARTNER_API',
          clientName: req.partner!.name,
          status: input.status,
          paidCents,
          rejectedLines: input.rejectedLineIds.length,
        },
      },
      tx,
    );
    await notifyFacilityRole(
      claim.facilityId,
      ['DIRECTOR', 'RECEPTION'],
      {
        type: 'billing',
        title: 'Health Insurance Fund decision on claim {reference}',
        vars: { reference: claim.reference },
        link: '/billing?tab=claims',
      },
      tx,
    );
    return row!;
  });
  await auditPartner(req, req.partner!, {
    scope: 'claims.read',
    result: 'claim_decided',
    extra: { claimId: id, status: input.status },
  });
  res.json(updated);
});
