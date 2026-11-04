import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { and, count, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  billableServices,
  charges,
  claims,
  facilities,
  insuranceCoverages,
  patients,
  payments,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { getPatientOrThrow } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { toCsv } from '../reports/reports.routes.js';
import {
  automaticExemption,
  captureCharges,
  COVERAGE_STATUSES,
  coverageOn,
  EXEMPTIONS,
  INSURERS,
  nextReceiptNumber,
  priceFor,
} from './billing.service.js';
import { ensureTariff, SERVICE_CATEGORIES } from './tariff.js';

/**
 * Billing for a facility (reception/billing office and the director) and for patients themselves:
 * insurance coverage, charges produced by care, co-payment receipts and claims to the Health
 * Insurance Fund. Amounts are euro cents. No clinical detail beyond the service name is exposed.
 */
export const billingRouter = Router();
billingRouter.use(authenticate);

const STAFF = ['RECEPTION', 'DIRECTOR'] as const;
const PatientParam = z.object({ patientId: z.string().uuid() });
const IdParam = z.object({ id: z.string().uuid() });
const isStaff = (ctx: AuthContext) => (STAFF as readonly string[]).includes(ctx.role);
const today = () => new Date().toISOString().slice(0, 10);

/** Patient (or a guardian with full access) for their own record. */
const isOwn = (ctx: AuthContext, patientId: string) =>
  ctx.role === 'PATIENT' && ctx.patientId === patientId && (!ctx.proxy || ctx.proxy.scope === 'FULL');

/**
 * Billing staff may handle a patient registered at their facility or one who received care there
 * (has charges at the facility).
 */
async function assertBillingStaffAccess(ctx: AuthContext, patientId: string) {
  if (!isStaff(ctx) || !ctx.facilityId) throw forbidden();
  const patient = await getPatientOrThrow(patientId);
  if (patient.primaryFacilityId === ctx.facilityId) return patient;
  const [row] = await db
    .select({ n: count() })
    .from(charges)
    .where(and(eq(charges.patientId, patientId), eq(charges.facilityId, ctx.facilityId)));
  if ((row?.n ?? 0) > 0) return patient;
  throw forbidden('This patient has no registration or care at your facility');
}

async function assertReadAccess(ctx: AuthContext, patientId: string) {
  if (isOwn(ctx, patientId)) return getPatientOrThrow(patientId);
  return assertBillingStaffAccess(ctx, patientId);
}

/* -------------------------------------------------------------------- insurance coverage */

const CoverageInput = z
  .object({
    insurer: z.enum(INSURERS),
    policyNumber: z.string().trim().max(60).optional().nullable(),
    status: z.enum(COVERAGE_STATUSES).default('ACTIVE'),
    exemption: z.enum(EXEMPTIONS).optional().nullable(),
    validFrom: z.string().date(),
    validUntil: z.string().date().optional().nullable(),
  })
  .refine((v) => !v.validUntil || v.validUntil >= v.validFrom, 'validUntil must be after validFrom');

billingRouter.get('/patients/:patientId/insurance', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const patient = await assertReadAccess(ctx, patientId);
  const history = await db
    .select()
    .from(insuranceCoverages)
    .where(eq(insuranceCoverages.patientId, patientId))
    .orderBy(desc(insuranceCoverages.createdAt));
  const current = await coverageOn(patientId, today());
  res.json({
    patient: {
      id: patient.id,
      firstName: patient.firstName,
      lastName: patient.lastName,
      nationalId: patient.nationalId,
      dateOfBirth: patient.dateOfBirth,
    },
    current: current ? history.find((h) => h.id === current.id) ?? null : null,
    automaticExemption: automaticExemption(patient.dateOfBirth),
    history,
    canEdit: isStaff(ctx),
  });
});

billingRouter.post('/patients/:patientId/insurance', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await assertBillingStaffAccess(ctx, patientId);
  const input = parse(CoverageInput, req.body);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(insuranceCoverages)
      .values({
        patientId,
        insurer: input.insurer,
        policyNumber: input.policyNumber ?? null,
        status: input.status,
        exemption: input.exemption ?? null,
        validFrom: input.validFrom,
        validUntil: input.validUntil ?? null,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.INSURANCE_CHANGED,
        actor: ctx,
        resourceType: 'insurance_coverage',
        resourceId: created!.id,
        patientId,
        meta: requestMeta(req),
        metadata: { insurer: input.insurer, status: input.status, exemption: input.exemption ?? null },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

const CoveragePatch = z
  .object({
    policyNumber: z.string().trim().max(60).nullable().optional(),
    status: z.enum(COVERAGE_STATUSES).optional(),
    exemption: z.enum(EXEMPTIONS).nullable().optional(),
    validUntil: z.string().date().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

billingRouter.patch(
  '/patients/:patientId/insurance/:id',
  requireRole(...STAFF),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId, id } = parse(PatientParam.extend({ id: z.string().uuid() }), req.params);
    await assertBillingStaffAccess(ctx, patientId);
    const input = parse(CoveragePatch, req.body);
    const [row] = await db
      .update(insuranceCoverages)
      .set(input)
      .where(and(eq(insuranceCoverages.id, id), eq(insuranceCoverages.patientId, patientId)))
      .returning();
    if (!row) throw notFound('Coverage not found');
    await audit({
      action: AuditAction.INSURANCE_CHANGED,
      actor: ctx,
      resourceType: 'insurance_coverage',
      resourceId: id,
      patientId,
      meta: requestMeta(req),
      metadata: input,
    });
    res.json(row);
  },
);

/**
 * Simulated eligibility check with the Health Insurance Fund. DEMO RULE: every permanent national
 * ID (10 digits) is insured with FSSH; temporary numbers (newborns, unidentified patients) cannot
 * be verified until the civil registry issues a number. A real integration replaces this function.
 */
billingRouter.post(
  '/patients/:patientId/insurance/verify',
  requireRole(...STAFF),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const patient = await assertBillingStaffAccess(ctx, patientId);
    const eligible = /^\d{10}$/.test(patient.nationalId);
    if (!eligible) {
      res.json({
        eligible: false,
        message: 'This patient has a temporary number; eligibility can be checked once the civil registry issues a national ID.',
      });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const current = await coverageOn(patientId, today(), tx);
      let coverageId: string;
      if (current && current.insurer === 'FSSH') {
        coverageId = current.id;
        await tx
          .update(insuranceCoverages)
          .set({ verifiedAt: new Date() })
          .where(eq(insuranceCoverages.id, current.id));
      } else {
        const [created] = await tx
          .insert(insuranceCoverages)
          .values({
            patientId,
            insurer: 'FSSH',
            policyNumber: `FSSH-${patient.nationalId}`,
            status: 'ACTIVE',
            exemption: automaticExemption(patient.dateOfBirth),
            validFrom: today(),
            verifiedAt: new Date(),
            createdById: ctx.userId,
          })
          .returning({ id: insuranceCoverages.id });
        coverageId = created!.id;
      }
      await audit(
        {
          action: AuditAction.INSURANCE_CHANGED,
          actor: ctx,
          resourceType: 'insurance_coverage',
          resourceId: coverageId,
          patientId,
          meta: requestMeta(req),
          metadata: { verified: true, insurer: 'FSSH' },
        },
        tx,
      );
      return coverageId;
    });
    res.json({ eligible: true, insurer: 'FSSH', coverageId: result, message: 'Insured with the Health Insurance Fund.' });
  },
);

/* -------------------------------------------------------------------------- tariff */

billingRouter.get('/services', async (req, res) => {
  await ensureTariff();
  const q = parse(z.object({ category: z.enum(SERVICE_CATEGORIES).optional() }), req.query);
  const rows = await db
    .select()
    .from(billableServices)
    .where(q.category ? eq(billableServices.category, q.category) : undefined)
    .orderBy(billableServices.category, billableServices.code);
  res.json({ items: rows, demo: true });
});

const ServiceInput = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9-]{2,30}$/, 'Use capital letters, digits and dashes'),
    name: z.string().trim().min(3).max(200),
    category: z.enum(SERVICE_CATEGORIES),
    priceCents: z.number().int().min(0).max(10_000_000),
    copayCents: z.number().int().min(0).max(10_000_000),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.copayCents <= v.priceCents, 'The co-payment cannot exceed the price');

billingRouter.post('/services', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(ServiceInput, req.body);
  const [row] = await db
    .insert(billableServices)
    .values(input)
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict('A service with this code already exists');
  await audit({
    action: AuditAction.CHARGE_CREATED,
    actor: ctx,
    resourceType: 'billable_service',
    resourceId: row.id,
    meta: requestMeta(req),
    metadata: { tariff: 'created', code: row.code },
  });
  res.status(201).json(row);
});

billingRouter.patch('/services/:id', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(
    z
      .object({
        name: z.string().trim().min(3).max(200).optional(),
        priceCents: z.number().int().min(0).max(10_000_000).optional(),
        copayCents: z.number().int().min(0).max(10_000_000).optional(),
        isActive: z.boolean().optional(),
      })
      .refine((v) => Object.keys(v).length > 0, 'Nothing to change'),
    req.body,
  );
  const [existing] = await db.select().from(billableServices).where(eq(billableServices.id, id));
  if (!existing) throw notFound('Service not found');
  if ((input.copayCents ?? existing.copayCents) > (input.priceCents ?? existing.priceCents)) {
    throw badRequest('The co-payment cannot exceed the price');
  }
  const [row] = await db
    .update(billableServices)
    .set(input)
    .where(eq(billableServices.id, id))
    .returning();
  await audit({
    action: AuditAction.CHARGE_CREATED,
    actor: ctx,
    resourceType: 'billable_service',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { tariff: 'changed', ...input },
  });
  res.json(row);
});

/* -------------------------------------------------------------------------- charges */

const chargeColumns = {
  id: charges.id,
  patientId: charges.patientId,
  facilityId: charges.facilityId,
  facilityName: facilities.name,
  serviceCode: billableServices.code,
  serviceName: billableServices.name,
  category: billableServices.category,
  sourceType: charges.sourceType,
  quantity: charges.quantity,
  totalCents: charges.totalCents,
  copayCents: charges.copayCents,
  insurerCents: charges.insurerCents,
  status: charges.status,
  claimId: charges.claimId,
  serviceDate: charges.serviceDate,
  voidReason: charges.voidReason,
  createdAt: charges.createdAt,
};

/** Map of charge id → receipt (number, date) for charges whose co-payment was paid. */
async function receiptsFor(chargeIds: string[]) {
  if (!chargeIds.length) return new Map<string, { receiptNumber: string; paymentId: string }>();
  const result = await db.execute<{ charge_id: string; receipt_number: string; id: string }>(sql`
    SELECT c AS charge_id, p.receipt_number, p.id FROM payments p, unnest(p.charge_ids) c
    WHERE c = ANY(${sql.raw(`ARRAY[${chargeIds.map((i) => `'${i.replace(/[^0-9a-f-]/gi, '')}'`).join(',')}]::uuid[]`)})`);
  return new Map(
    result.rows.map((r) => [r.charge_id, { receiptNumber: r.receipt_number, paymentId: r.id }]),
  );
}

async function withPaymentState<T extends { id: string; copayCents: number }>(rows: T[]) {
  const receipts = await receiptsFor(rows.map((r) => r.id));
  return rows.map((r) => {
    const receipt = receipts.get(r.id);
    return {
      ...r,
      copayPaid: r.copayCents === 0 || Boolean(receipt),
      receiptNumber: receipt?.receiptNumber ?? null,
      paymentId: receipt?.paymentId ?? null,
    };
  });
}

billingRouter.get('/patients/:patientId/charges', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await assertReadAccess(ctx, patientId);
  const filters: SQL[] = [eq(charges.patientId, patientId)];
  // Staff see their facility's charges; patients see all of their own.
  if (!isOwn(ctx, patientId)) filters.push(eq(charges.facilityId, ctx.facilityId!));
  const rows = await db
    .select(chargeColumns)
    .from(charges)
    .innerJoin(billableServices, eq(billableServices.id, charges.serviceId))
    .innerJoin(facilities, eq(facilities.id, charges.facilityId))
    .where(and(...filters))
    .orderBy(desc(charges.serviceDate), desc(charges.createdAt))
    .limit(500);
  const items = await withPaymentState(rows);
  const paymentRows = await db
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      amountCents: payments.amountCents,
      method: payments.method,
      receivedAt: payments.receivedAt,
      facilityName: facilities.name,
      chargeIds: payments.chargeIds,
    })
    .from(payments)
    .innerJoin(facilities, eq(facilities.id, payments.facilityId))
    .where(
      isOwn(ctx, patientId)
        ? eq(payments.patientId, patientId)
        : and(eq(payments.patientId, patientId), eq(payments.facilityId, ctx.facilityId!)),
    )
    .orderBy(desc(payments.receivedAt));
  const live = items.filter((i) => i.status !== 'VOID');
  res.json({
    items,
    payments: paymentRows,
    totals: {
      openCopayCents: live.filter((i) => !i.copayPaid).reduce((a, i) => a + i.copayCents, 0),
      paidCopayCents: live.filter((i) => i.copayPaid).reduce((a, i) => a + i.copayCents, 0),
      insurerCents: live.reduce((a, i) => a + i.insurerCents, 0),
    },
  });
});

const ChargesQuery = PaginationSchema.extend({
  status: z.enum(['OPEN', 'CLAIMED', 'PAID', 'REJECTED', 'VOID']).optional(),
  category: z.enum(SERVICE_CATEGORIES).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  unpaidCopay: z.enum(['true', 'false']).optional(),
});

billingRouter.get('/charges', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ChargesQuery, req.query);
  const filters: SQL[] = [eq(charges.facilityId, ctx.facilityId!)];
  if (q.status) filters.push(eq(charges.status, q.status));
  if (q.category) filters.push(eq(billableServices.category, q.category));
  if (q.from) filters.push(sql`${charges.serviceDate} >= ${q.from}`);
  if (q.to) filters.push(sql`${charges.serviceDate} <= ${q.to}`);
  if (q.unpaidCopay === 'true') {
    filters.push(sql`${charges.copayCents} > 0 AND ${charges.status} <> 'VOID'
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE ${charges.id} = ANY(p.charge_ids))`);
  }
  const where = and(...filters);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        ...chargeColumns,
        patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
        nationalId: patients.nationalId,
      })
      .from(charges)
      .innerJoin(billableServices, eq(billableServices.id, charges.serviceId))
      .innerJoin(facilities, eq(facilities.id, charges.facilityId))
      .innerJoin(patients, eq(patients.id, charges.patientId))
      .where(where)
      .orderBy(desc(charges.serviceDate), desc(charges.createdAt))
      .limit(toOffset(q).limit)
      .offset(toOffset(q).offset),
    db
      .select({ total: count() })
      .from(charges)
      .innerJoin(billableServices, eq(billableServices.id, charges.serviceId))
      .where(where),
  ]);
  res.json(paginated(await withPaymentState(rows), total?.total ?? 0, q));
});

billingRouter.post('/charges', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(
    z.object({
      patientId: z.string().uuid(),
      serviceCode: z.string().trim().min(2).max(30),
      quantity: z.number().int().min(1).max(365).default(1),
      serviceDate: z.string().date().default(today()),
      note: z.string().trim().max(300).optional(),
    }),
    req.body,
  );
  const patient = await assertBillingStaffAccess(ctx, input.patientId);
  await ensureTariff();
  const [service] = await db
    .select()
    .from(billableServices)
    .where(and(eq(billableServices.code, input.serviceCode), eq(billableServices.isActive, true)));
  if (!service) throw badRequest('Unknown service code');
  const price = await priceFor(
    patient.id,
    service,
    input.quantity,
    input.serviceDate,
    patient.dateOfBirth,
  );
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(charges)
      .values({
        patientId: patient.id,
        facilityId: ctx.facilityId!,
        serviceId: service.id,
        sourceType: 'MANUAL',
        sourceId: null,
        quantity: input.quantity,
        totalCents: price.total,
        copayCents: price.copay,
        insurerCents: price.insurer,
        serviceDate: input.serviceDate,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.CHARGE_CREATED,
        actor: ctx,
        resourceType: 'charge',
        resourceId: created!.id,
        patientId: patient.id,
        meta: requestMeta(req),
        metadata: { serviceCode: service.code, quantity: input.quantity, note: input.note ?? null },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

billingRouter.post('/charges/:id/void', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(300) }), req.body);
  const [charge] = await db
    .select()
    .from(charges)
    .where(and(eq(charges.id, id), eq(charges.facilityId, ctx.facilityId!)));
  if (!charge) throw notFound('Charge not found');
  if (charge.status !== 'OPEN' || charge.claimId) {
    throw conflict('Only open charges that are not in a claim can be voided');
  }
  const receipts = await receiptsFor([id]);
  if (receipts.has(id)) {
    throw conflict('The co-payment of this charge was already paid; it cannot be voided here');
  }
  await db.transaction(async (tx) => {
    await tx.update(charges).set({ status: 'VOID', voidReason: reason }).where(eq(charges.id, id));
    await audit(
      {
        action: AuditAction.CHARGE_VOIDED,
        actor: ctx,
        resourceType: 'charge',
        resourceId: id,
        patientId: charge.patientId,
        meta: requestMeta(req),
        metadata: { reason },
      },
      tx,
    );
  });
  res.status(204).end();
});

/** Runs charge capture for my facility now (it also runs hourly). */
billingRouter.post('/capture', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const created = await captureCharges(ctx.facilityId!);
  res.json({ created });
});

/* -------------------------------------------------------------------------- payments */

billingRouter.post('/payments', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(
    z.object({
      patientId: z.string().uuid(),
      chargeIds: z.array(z.string().uuid()).min(1).max(200),
      method: z.enum(['CASH', 'CARD', 'TRANSFER']),
    }),
    req.body,
  );
  await assertBillingStaffAccess(ctx, input.patientId);
  const ids = [...new Set(input.chargeIds)];
  const payment = await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(charges)
      .where(
        and(
          inArray(charges.id, ids),
          eq(charges.patientId, input.patientId),
          eq(charges.facilityId, ctx.facilityId!),
        ),
      )
      .for('update');
    if (rows.length !== ids.length) throw badRequest('Some charges do not belong to this patient');
    if (rows.some((r) => r.status === 'VOID')) throw conflict('A voided charge cannot be paid');
    if (rows.some((r) => r.copayCents === 0)) {
      throw badRequest('Some charges have no co-payment to pay');
    }
    const paid = await tx.execute<{ c: string }>(sql`
      SELECT c FROM payments p, unnest(p.charge_ids) c
      WHERE c IN ${sql.raw(`(${ids.map((i) => `'${i}'`).join(',')})`)}`);
    if (paid.rows.length) throw conflict('Some of these co-payments were already paid');
    const amount = rows.reduce((a, r) => a + r.copayCents, 0);
    const receiptNumber = await nextReceiptNumber(tx, ctx.facilityId!);
    const [created] = await tx
      .insert(payments)
      .values({
        patientId: input.patientId,
        facilityId: ctx.facilityId!,
        receiptNumber,
        amountCents: amount,
        method: input.method,
        chargeIds: ids,
        receivedById: ctx.userId,
      })
      .returning();
    // Charges with nothing left for the insurer are settled by the patient's payment.
    await tx
      .update(charges)
      .set({ status: 'PAID' })
      .where(and(inArray(charges.id, ids), eq(charges.insurerCents, 0), eq(charges.status, 'OPEN')));
    await audit(
      {
        action: AuditAction.PAYMENT_RECEIVED,
        actor: ctx,
        resourceType: 'payment',
        resourceId: created!.id,
        patientId: input.patientId,
        meta: requestMeta(req),
        metadata: { receiptNumber, amountCents: amount, method: input.method, charges: ids.length },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(await receipt(payment.id));
});

/** A printable receipt. */
async function receipt(paymentId: string) {
  const [p] = await db
    .select({
      id: payments.id,
      receiptNumber: payments.receiptNumber,
      amountCents: payments.amountCents,
      method: payments.method,
      receivedAt: payments.receivedAt,
      chargeIds: payments.chargeIds,
      patientId: payments.patientId,
      facilityId: payments.facilityId,
      facilityName: facilities.name,
      facilityCode: facilities.code,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      nationalId: patients.nationalId,
    })
    .from(payments)
    .innerJoin(facilities, eq(facilities.id, payments.facilityId))
    .innerJoin(patients, eq(patients.id, payments.patientId))
    .where(eq(payments.id, paymentId));
  if (!p) throw notFound('Receipt not found');
  const lines = await db
    .select({
      id: charges.id,
      serviceCode: billableServices.code,
      serviceName: billableServices.name,
      serviceDate: charges.serviceDate,
      quantity: charges.quantity,
      copayCents: charges.copayCents,
    })
    .from(charges)
    .innerJoin(billableServices, eq(billableServices.id, charges.serviceId))
    .where(inArray(charges.id, p.chargeIds));
  return { ...p, lines };
}

billingRouter.get('/payments/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const r = await receipt(id);
  if (isOwn(ctx, r.patientId)) {
    res.json(r);
    return;
  }
  if (!isStaff(ctx) || r.facilityId !== ctx.facilityId) throw notFound('Receipt not found');
  res.json(r);
});

/* ---------------------------------------------------------------------------- claims */

const claimColumns = {
  id: claims.id,
  reference: claims.reference,
  insurer: claims.insurer,
  periodFrom: claims.periodFrom,
  periodTo: claims.periodTo,
  status: claims.status,
  totalCents: claims.totalCents,
  paidCents: claims.paidCents,
  submittedAt: claims.submittedAt,
  respondedAt: claims.respondedAt,
  responseNote: claims.responseNote,
  createdAt: claims.createdAt,
  lineCount: sql<number>`(SELECT count(*)::int FROM charges c WHERE c.claim_id = ${claims.id})`,
};

billingRouter.get('/claims', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const rows = await db
    .select(claimColumns)
    .from(claims)
    .where(eq(claims.facilityId, ctx.facilityId!))
    .orderBy(desc(claims.periodFrom), desc(claims.createdAt))
    .limit(120);
  res.json({ items: rows });
});

/** Insured (FSSH) charges of my facility in the period that are not yet in a claim. */
const claimableWhere = (facilityId: string, from: string, to: string) => sql`
  c.facility_id = ${facilityId} AND c.status = 'OPEN' AND c.claim_id IS NULL AND c.insurer_cents > 0
  AND c.service_date BETWEEN ${from}::date AND ${to}::date
  AND EXISTS (SELECT 1 FROM insurance_coverages ic
    WHERE ic.patient_id = c.patient_id AND ic.insurer = 'FSSH' AND ic.status = 'ACTIVE'
      AND ic.valid_from <= c.service_date AND (ic.valid_until IS NULL OR ic.valid_until >= c.service_date))`;

billingRouter.post('/claims', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(
    z
      .object({ periodFrom: z.string().date(), periodTo: z.string().date() })
      .refine((v) => v.periodFrom <= v.periodTo, 'periodFrom must be before periodTo')
      .refine((v) => v.periodTo <= today(), 'A claim cannot include future dates'),
    req.body,
  );
  const claim = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`claims:${ctx.facilityId}`}))`);
    const [facility] = await tx.select().from(facilities).where(eq(facilities.id, ctx.facilityId!));
    const reference = `FSSH-${facility!.code}-${input.periodFrom.slice(0, 7).replace('-', '')}-${randomBytes(2).toString('hex').toUpperCase()}`;
    const [created] = await tx
      .insert(claims)
      .values({
        facilityId: ctx.facilityId!,
        insurer: 'FSSH',
        reference,
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        createdById: ctx.userId,
      })
      .returning();
    const lines = await tx.execute<{ insurer_cents: number }>(sql`
      UPDATE charges c SET claim_id = ${created!.id}
      WHERE ${claimableWhere(ctx.facilityId!, input.periodFrom, input.periodTo)}
      RETURNING c.insurer_cents`);
    if (!lines.rows.length) throw badRequest('There are no insured charges to claim in this period');
    const total = lines.rows.reduce((a, r) => a + Number(r.insurer_cents), 0);
    const [updated] = await tx
      .update(claims)
      .set({ totalCents: total })
      .where(eq(claims.id, created!.id))
      .returning();
    return updated!;
  });
  res.status(201).json(claim);
});

async function claimForFacility(id: string, facilityId: string) {
  const [claim] = await db
    .select()
    .from(claims)
    .where(and(eq(claims.id, id), eq(claims.facilityId, facilityId)));
  if (!claim) throw notFound('Claim not found');
  return claim;
}

/** Claim lines (shared with the partner API). */
export async function claimLines(claimId: string) {
  return db
    .select({
      id: charges.id,
      patientId: charges.patientId,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      nationalId: patients.nationalId,
      policyNumber: sql<string | null>`(SELECT ic.policy_number FROM insurance_coverages ic
        WHERE ic.patient_id = ${charges.patientId} AND ic.insurer = 'FSSH'
        ORDER BY ic.created_at DESC LIMIT 1)`,
      serviceCode: billableServices.code,
      serviceName: billableServices.name,
      serviceDate: charges.serviceDate,
      quantity: charges.quantity,
      totalCents: charges.totalCents,
      copayCents: charges.copayCents,
      insurerCents: charges.insurerCents,
      status: charges.status,
    })
    .from(charges)
    .innerJoin(billableServices, eq(billableServices.id, charges.serviceId))
    .innerJoin(patients, eq(patients.id, charges.patientId))
    .where(eq(charges.claimId, claimId))
    .orderBy(charges.serviceDate, patients.lastName);
}

billingRouter.get('/claims/:id', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { format } = parse(z.object({ format: z.enum(['json', 'csv']).default('json') }), req.query);
  const claim = await claimForFacility(id, ctx.facilityId!);
  const lines = await claimLines(id);
  if (format === 'csv') {
    const columns = [
      'nationalId',
      'policyNumber',
      'serviceCode',
      'serviceName',
      'serviceDate',
      'quantity',
      'totalCents',
      'copayCents',
      'insurerCents',
      'status',
    ];
    res
      .type('text/csv')
      .attachment(`${claim.reference}.csv`)
      .send(toCsv(columns, lines as unknown as Record<string, unknown>[]));
    return;
  }
  res.json({ ...claim, lines });
});

billingRouter.post('/claims/:id/submit', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const claim = await claimForFacility(id, ctx.facilityId!);
  if (claim.status !== 'DRAFT') throw conflict('Only draft claims can be submitted');
  const updated = await db.transaction(async (tx) => {
    await tx.update(charges).set({ status: 'CLAIMED' }).where(eq(charges.claimId, id));
    const [row] = await tx
      .update(claims)
      .set({ status: 'SUBMITTED', submittedAt: new Date() })
      .where(and(eq(claims.id, id), eq(claims.status, 'DRAFT')))
      .returning();
    if (!row) throw conflict('Only draft claims can be submitted');
    await audit(
      {
        action: AuditAction.CLAIM_SUBMITTED,
        actor: ctx,
        resourceType: 'claim',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { reference: claim.reference, totalCents: claim.totalCents },
      },
      tx,
    );
    return row;
  });
  res.json(updated);
});

billingRouter.post('/claims/:id/discard', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const claim = await claimForFacility(id, ctx.facilityId!);
  if (claim.status !== 'DRAFT') throw conflict('Only draft claims can be discarded');
  await db.transaction(async (tx) => {
    await tx.update(charges).set({ claimId: null }).where(eq(charges.claimId, id));
    await tx.delete(claims).where(and(eq(claims.id, id), eq(claims.status, 'DRAFT')));
  });
  res.status(204).end();
});

/** Facility billing overview: open co-payments, insurer amounts by status, this month's totals. */
billingRouter.get('/summary', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const result = await db.execute<Record<string, number>>(sql`
    SELECT
      coalesce(sum(c.copay_cents) FILTER (WHERE c.status <> 'VOID' AND c.copay_cents > 0
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE c.id = ANY(p.charge_ids))), 0)::int AS "openCopayCents",
      coalesce(sum(c.insurer_cents) FILTER (WHERE c.status = 'OPEN' AND c.claim_id IS NULL), 0)::int AS "unclaimedCents",
      coalesce(sum(c.insurer_cents) FILTER (WHERE c.status = 'CLAIMED'), 0)::int AS "claimedCents",
      coalesce(sum(c.insurer_cents) FILTER (WHERE c.status = 'PAID'), 0)::int AS "paidByInsurerCents",
      count(*) FILTER (WHERE c.status <> 'VOID' AND c.service_date >= date_trunc('month', now())::date)::int AS "chargesThisMonth"
    FROM charges c WHERE c.facility_id = ${ctx.facilityId!}`);
  const [cash] = await db.execute<{ total: number }>(sql`
    SELECT coalesce(sum(amount_cents), 0)::int AS total FROM payments
    WHERE facility_id = ${ctx.facilityId!} AND received_at >= date_trunc('month', now())`).then((r) => r.rows);
  res.json({ ...result.rows[0], copaymentsThisMonthCents: cash?.total ?? 0 });
});

/** Patients at my facility for the billing search (demographics only). */
billingRouter.get('/patients', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const { q } = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = await db
    .select({
      id: patients.id,
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
    })
    .from(patients)
    .where(
      and(
        isNull(patients.mergedIntoId),
        sql`(${patients.primaryFacilityId} = ${ctx.facilityId}
          OR EXISTS (SELECT 1 FROM charges c WHERE c.patient_id = ${patients.id} AND c.facility_id = ${ctx.facilityId}))`,
        sql`(${patients.firstName} || ' ' || ${patients.lastName} ILIKE ${like} OR ${patients.nationalId} LIKE ${like})`,
      ),
    )
    .orderBy(patients.lastName, patients.firstName)
    .limit(20);
  res.json({ items: rows });
});

