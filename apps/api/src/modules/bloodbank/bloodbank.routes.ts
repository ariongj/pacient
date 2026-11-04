import { Router } from 'express';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, count, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  admissions,
  bloodGroupTests,
  bloodProductEnum,
  bloodUnits,
  patients,
  surgicalCases,
  transfusionRequests,
  transfusionRequestStatusEnum,
  transfusions,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  getPatientOrThrow,
  resolveClinicalReadAccess,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import {
  ABO_GROUPS,
  bloodBankStaff,
  checkCompatibility,
  currentBloodGroup,
  facilityClinicians,
  isBloodBankStaff,
  isWomanOfChildbearingAge,
  publishBloodBank,
  RHD,
  type Abo,
  type RhD,
} from './bloodbank.service.js';

/**
 * Blood bank and transfusion: blood groups, unit stock, transfusion requests with crossmatch and
 * ABO/RhD compatibility, issue, the bedside two-person check, observations and reactions
 * (haemovigilance). Blood bank staff are the staff of the facility's BLOOD_BANK care units.
 */
export const bloodBankRouter = Router();
bloodBankRouter.use(authenticate);

const IdParam = z.object({ id: z.string().uuid() });
const Abo = z.enum(ABO_GROUPS as [Abo, ...Abo[]]);
const Rh = z.enum(RHD as [RhD, ...RhD[]]);
const Product = z.enum(bloodProductEnum.enumValues);
const Vitals = z
  .object({
    systolic: z.number().int().min(40).max(300).optional(),
    diastolic: z.number().int().min(20).max(200).optional(),
    heartRate: z.number().int().min(20).max(250).optional(),
    respiratoryRate: z.number().int().min(4).max(80).optional(),
    temperature: z.number().min(30).max(44).optional(),
    spo2: z.number().int().min(50).max(100).optional(),
  })
  .strict();

const SECOND_CHECK_MINUTES = 10;
const EXPIRING_DAYS = 3;
const SUPPRESS_BELOW = 5;

async function assertStaff(ctx: AuthContext) {
  if (!(await isBloodBankStaff(ctx.userId, ctx.facilityId))) {
    throw forbidden('Only blood bank staff can do this');
  }
}

/** Blood bank staff may look up patients who are registered or have a request at their facility. */
async function assertPatientRead(
  ctx: AuthContext,
  patientId: string,
  meta?: ReturnType<typeof requestMeta>,
) {
  const patient = await getPatientOrThrow(patientId);
  if (await isBloodBankStaff(ctx.userId, ctx.facilityId)) {
    if (patient.primaryFacilityId === ctx.facilityId) return patient;
    const [r] = await db
      .select({ id: transfusionRequests.id })
      .from(transfusionRequests)
      .where(
        and(
          eq(transfusionRequests.patientId, patientId),
          eq(transfusionRequests.facilityId, ctx.facilityId!),
        ),
      )
      .limit(1);
    if (r) return patient;
  }
  await resolveClinicalReadAccess(ctx, patientId, meta);
  return patient;
}

const unitIsExpired = (u: { expiresAt: Date }, now = new Date()) => u.expiresAt <= now;
const groupOf = (u: { abo: string; rhD: string }) => ({ abo: u.abo as Abo, rhD: u.rhD as RhD });
const requestedBy = alias(users, 'requested_by');

/* ------------------------------------------------------------------ who am I ------------------ */

bloodBankRouter.get('/me', async (req, res) => {
  const ctx = requireAuth(req);
  res.json({ isStaff: await isBloodBankStaff(ctx.userId, ctx.facilityId) });
});

bloodBankRouter.get('/colleagues', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  res.json({ items: await facilityClinicians(ctx.facilityId, ctx.userId) });
});

/* ------------------------------------------------------------------ blood groups -------------- */

const GroupInput = z.object({
  abo: Abo,
  rhD: Rh,
  antibodyScreen: z.enum(['NEGATIVE', 'POSITIVE']).default('NEGATIVE'),
  antibodies: z.string().trim().max(200).optional().nullable(),
});

bloodBankRouter.post('/patients/:id/blood-group', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(GroupInput, req.body);
  await assertStaff(ctx);
  await getPatientOrThrow(id);
  if (input.antibodyScreen === 'POSITIVE' && !input.antibodies) {
    throw badRequest('Name the antibodies found when the screen is positive');
  }
  const before = await currentBloodGroup(id);
  const [row] = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(bloodGroupTests)
      .values({
        patientId: id,
        facilityId: ctx.facilityId!,
        abo: input.abo,
        rhD: input.rhD,
        antibodyScreen: input.antibodyScreen,
        antibodies: input.antibodies ?? null,
        testedById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.BLOOD_GROUP_RECORDED,
        actor: ctx,
        resourceType: 'blood_group_test',
        resourceId: inserted[0]!.id,
        patientId: id,
        meta: requestMeta(req),
        metadata: { abo: input.abo, rhD: input.rhD, antibodyScreen: input.antibodyScreen },
      },
      tx,
    );
    return inserted;
  });
  const after = await currentBloodGroup(id);
  const warnings: string[] = [];
  if (before.group && (before.group.abo !== input.abo || before.group.rhD !== input.rhD)) {
    warnings.push(
      'This result differs from the previous blood group – take a new sample and repeat the test before issuing group-specific blood',
    );
  }
  res.status(201).json({ test: row, current: after, warnings });
});

/** Everything about a patient's transfusion history (blood group, requests, transfusions). */
bloodBankRouter.get('/patients/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const patient = await assertPatientRead(ctx, id, requestMeta(req));
  const group = await currentBloodGroup(id);
  const [requests, given] = await Promise.all([
    db
      .select({
        id: transfusionRequests.id,
        product: transfusionRequests.product,
        units: transfusionRequests.units,
        urgency: transfusionRequests.urgency,
        indication: transfusionRequests.indication,
        haemoglobinGl: transfusionRequests.haemoglobinGl,
        status: transfusionRequests.status,
        createdAt: transfusionRequests.createdAt,
        crossmatchedAt: transfusionRequests.crossmatchedAt,
        requestedBy: requestedBy.fullName,
        requestedById: transfusionRequests.requestedById,
      })
      .from(transfusionRequests)
      .innerJoin(requestedBy, eq(requestedBy.id, transfusionRequests.requestedById))
      .where(eq(transfusionRequests.patientId, id))
      .orderBy(desc(transfusionRequests.createdAt))
      .limit(50),
    transfusionList(eq(transfusions.patientId, id)),
  ]);
  const reserved = requests.length
    ? await db
        .select({
          id: bloodUnits.id,
          unitNumber: bloodUnits.unitNumber,
          product: bloodUnits.product,
          abo: bloodUnits.abo,
          rhD: bloodUnits.rhD,
          expiresAt: bloodUnits.expiresAt,
          requestId: bloodUnits.reservedForRequestId,
        })
        .from(bloodUnits)
        .where(
          and(
            inArray(
              bloodUnits.reservedForRequestId,
              requests.map((r) => r.id),
            ),
            eq(bloodUnits.status, 'RESERVED'),
          ),
        )
    : [];
  res.json({
    patient: {
      id: patient.id,
      firstName: patient.firstName,
      lastName: patient.lastName,
      sex: patient.sex,
      dateOfBirth: patient.dateOfBirth,
      nationalId: patient.nationalId,
    },
    bloodGroup: {
      group: group.group,
      confirmed: group.confirmed,
      concordantTests: group.concordantTests,
      discordant: group.discordant,
      history: group.tests.map((t) => ({
        id: t.id,
        abo: t.abo,
        rhD: t.rhD,
        antibodyScreen: t.antibodyScreen,
        antibodies: t.antibodies,
        testedAt: t.testedAt,
      })),
    },
    requests: requests.map((r) => ({
      ...r,
      reservedUnits: reserved.filter((u) => u.requestId === r.id),
    })),
    transfusions: given,
    isStaff: await isBloodBankStaff(ctx.userId, ctx.facilityId),
  });
});

/* ------------------------------------------------------------------ stock --------------------- */

const UnitInput = z.object({
  unitNumber: z
    .string()
    .trim()
    .min(4)
    .max(30)
    .regex(/^[A-Za-z0-9-]+$/, 'Unit numbers contain letters, digits and dashes only'),
  product: Product,
  abo: Abo,
  rhD: Rh,
  volumeMl: z.number().int().min(10).max(1000),
  collectedAt: z.coerce.date(),
  expiresAt: z.coerce.date(),
});

bloodBankRouter.post('/units', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(UnitInput, req.body);
  await assertStaff(ctx);
  if (input.expiresAt <= input.collectedAt) throw badRequest('Expiry must be after collection');
  if (input.expiresAt <= new Date()) throw badRequest('This unit has already expired');
  const [exists] = await db
    .select({ id: bloodUnits.id })
    .from(bloodUnits)
    .where(eq(bloodUnits.unitNumber, input.unitNumber));
  if (exists) throw conflict('A unit with this number is already registered');
  const row = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(bloodUnits)
      .values({ ...input, facilityId: ctx.facilityId!, receivedById: ctx.userId })
      .returning();
    await audit(
      {
        action: AuditAction.BLOOD_UNIT_RECEIVED,
        actor: ctx,
        resourceType: 'blood_unit',
        resourceId: u!.id,
        meta: requestMeta(req),
        metadata: { unitNumber: u!.unitNumber, product: u!.product, abo: u!.abo, rhD: u!.rhD },
      },
      tx,
    );
    return u!;
  });
  await publishBloodBank(ctx.facilityId!);
  res.status(201).json(row);
});

/** Stock by product and group; unit list for blood bank staff. Expired units are flagged. */
bloodBankRouter.get('/stock', requireRole('DOCTOR', 'NURSE', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const now = new Date();
  const soon = new Date(now.getTime() + EXPIRING_DAYS * 86_400_000);
  const units = await db
    .select()
    .from(bloodUnits)
    .where(
      and(
        eq(bloodUnits.facilityId, ctx.facilityId),
        inArray(bloodUnits.status, ['AVAILABLE', 'RESERVED']),
      ),
    )
    .orderBy(asc(bloodUnits.expiresAt));
  const matrix: Record<string, Record<string, { available: number; reserved: number }>> = {};
  let expiring = 0;
  let expired = 0;
  for (const u of units) {
    if (unitIsExpired(u, now)) {
      expired++;
      continue;
    }
    if (u.expiresAt <= soon) expiring++;
    const group = `${u.abo}${u.rhD === 'POS' ? '+' : '-'}`;
    const cell = ((matrix[u.product] ??= {})[group] ??= { available: 0, reserved: 0 });
    if (u.status === 'AVAILABLE') cell.available++;
    else cell.reserved++;
  }
  const staff = await isBloodBankStaff(ctx.userId, ctx.facilityId);
  res.json({
    matrix,
    expiringCount: expiring,
    expiredCount: expired,
    isStaff: staff,
    units: staff
      ? units.map((u) => ({
          ...u,
          expired: unitIsExpired(u, now),
          expiringSoon: !unitIsExpired(u, now) && u.expiresAt <= soon,
        }))
      : [],
  });
});

bloodBankRouter.post('/units/:id/discard', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
  await assertStaff(ctx);
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .select()
      .from(bloodUnits)
      .where(and(eq(bloodUnits.id, id), eq(bloodUnits.facilityId, ctx.facilityId!)))
      .for('update');
    if (!u) throw notFound('Unit not found');
    if (!['AVAILABLE', 'RESERVED', 'RETURNED'].includes(u.status)) {
      throw conflict('Only units in stock can be discarded');
    }
    const [row] = await tx
      .update(bloodUnits)
      .set({ status: 'DISCARDED', discardReason: reason, reservedForRequestId: null })
      .where(eq(bloodUnits.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.BLOOD_UNIT_DISCARDED,
        actor: ctx,
        resourceType: 'blood_unit',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { unitNumber: u.unitNumber, reason },
      },
      tx,
    );
    return row!;
  });
  await publishBloodBank(ctx.facilityId!);
  res.json(updated);
});

/* ------------------------------------------------------------------ requests ------------------ */

const RequestInput = z.object({
  patientId: z.string().uuid(),
  product: Product,
  units: z.number().int().min(1).max(20),
  urgency: z.enum(['ROUTINE', 'URGENT', 'EMERGENCY']),
  indication: z.string().trim().min(5).max(800),
  haemoglobinGl: z.number().int().min(10).max(250).optional().nullable(),
  exceptionReason: z.string().trim().min(5).max(180).optional().nullable(),
  admissionId: z.string().uuid().optional().nullable(),
  surgicalCaseId: z.string().uuid().optional().nullable(),
});

bloodBankRouter.post('/requests', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(RequestInput, req.body);
  await assertClinicalWriteAccess(ctx, input.patientId, requestMeta(req), WRITERS.doctorOnly);
  if (!ctx.facilityId) throw forbidden();
  if (input.admissionId) {
    const [a] = await db
      .select({ id: admissions.id })
      .from(admissions)
      .where(and(eq(admissions.id, input.admissionId), eq(admissions.patientId, input.patientId)));
    if (!a) throw badRequest('The hospital stay does not belong to this patient');
  }
  if (input.surgicalCaseId) {
    const [c] = await db
      .select({ id: surgicalCases.id })
      .from(surgicalCases)
      .where(
        and(
          eq(surgicalCases.id, input.surgicalCaseId),
          eq(surgicalCases.patientId, input.patientId),
        ),
      );
    if (!c) throw badRequest('The operation does not belong to this patient');
  }
  const warnings: string[] = [];
  const isRedCells = input.product === 'RED_CELLS' || input.product === 'WHOLE_BLOOD';
  if (
    isRedCells &&
    input.haemoglobinGl != null &&
    input.haemoglobinGl > 80 &&
    !input.exceptionReason
  ) {
    warnings.push(
      'Haemoglobin is above 80 g/L – a restrictive threshold usually applies. State the reason for transfusing (e.g. active bleeding, symptomatic anaemia, cardiac disease).',
    );
  }
  if (isRedCells && input.haemoglobinGl == null && input.urgency !== 'EMERGENCY') {
    warnings.push('No recent haemoglobin value was given');
  }
  const indication = input.exceptionReason
    ? `${input.indication} — ${input.exceptionReason}`
    : input.indication;
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(transfusionRequests)
      .values({
        patientId: input.patientId,
        facilityId: ctx.facilityId!,
        admissionId: input.admissionId ?? null,
        surgicalCaseId: input.surgicalCaseId ?? null,
        product: input.product,
        units: input.units,
        urgency: input.urgency,
        indication,
        haemoglobinGl: input.haemoglobinGl ?? null,
        requestedById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.TRANSFUSION_REQUESTED,
        actor: ctx,
        resourceType: 'transfusion_request',
        resourceId: r!.id,
        patientId: input.patientId,
        meta: requestMeta(req),
        metadata: { product: input.product, units: input.units, urgency: input.urgency },
      },
      tx,
    );
    const staff = await bloodBankStaff(ctx.facilityId!, tx);
    await notifyUsers(
      staff,
      input.urgency === 'EMERGENCY'
        ? {
            type: 'bloodbank',
            title: 'EMERGENCY transfusion request – act now',
            link: '/blood-bank',
            important: true,
          }
        : {
            type: 'bloodbank',
            title:
              input.urgency === 'URGENT'
                ? 'New urgent transfusion request'
                : 'New transfusion request',
            link: '/blood-bank',
            important: input.urgency === 'URGENT',
          },
      tx,
    );
    return r!;
  });
  await publishBloodBank(ctx.facilityId, row.id);
  res.status(201).json({ ...row, warnings });
});

/** The facility's queue (blood bank staff). */
bloodBankRouter.get('/requests', async (req, res) => {
  const ctx = requireAuth(req);
  const { status } = parse(
    z.object({ status: z.enum(transfusionRequestStatusEnum.enumValues).optional() }),
    req.query,
  );
  await assertStaff(ctx);
  const filters: SQL[] = [eq(transfusionRequests.facilityId, ctx.facilityId!)];
  if (status) filters.push(eq(transfusionRequests.status, status));
  else
    filters.push(
      inArray(transfusionRequests.status, [
        'REQUESTED',
        'SAMPLE_RECEIVED',
        'CROSSMATCHED',
        'ISSUED',
      ]),
    );
  const rows = await db
    .select({
      id: transfusionRequests.id,
      patientId: transfusionRequests.patientId,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      product: transfusionRequests.product,
      units: transfusionRequests.units,
      urgency: transfusionRequests.urgency,
      indication: transfusionRequests.indication,
      haemoglobinGl: transfusionRequests.haemoglobinGl,
      status: transfusionRequests.status,
      sampleReceivedAt: transfusionRequests.sampleReceivedAt,
      crossmatchedAt: transfusionRequests.crossmatchedAt,
      createdAt: transfusionRequests.createdAt,
      requestedBy: requestedBy.fullName,
    })
    .from(transfusionRequests)
    .innerJoin(patients, eq(patients.id, transfusionRequests.patientId))
    .innerJoin(requestedBy, eq(requestedBy.id, transfusionRequests.requestedById))
    .where(and(...filters))
    .orderBy(
      sql`CASE ${transfusionRequests.urgency} WHEN 'EMERGENCY' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END`,
      asc(transfusionRequests.createdAt),
    )
    .limit(200);
  const ids = rows.map((r) => r.id);
  const [reserved, issued] = ids.length
    ? await Promise.all([
        db
          .select({
            id: bloodUnits.id,
            unitNumber: bloodUnits.unitNumber,
            abo: bloodUnits.abo,
            rhD: bloodUnits.rhD,
            expiresAt: bloodUnits.expiresAt,
            requestId: bloodUnits.reservedForRequestId,
          })
          .from(bloodUnits)
          .where(
            and(inArray(bloodUnits.reservedForRequestId, ids), eq(bloodUnits.status, 'RESERVED')),
          ),
        db
          .select({ requestId: transfusions.requestId, n: count() })
          .from(transfusions)
          .where(and(inArray(transfusions.requestId, ids), sqlNotReturned()))
          .groupBy(transfusions.requestId),
      ])
    : [[], []];
  const groups = new Map<string, Awaited<ReturnType<typeof currentBloodGroup>>>();
  for (const r of rows) {
    if (!groups.has(r.patientId)) groups.set(r.patientId, await currentBloodGroup(r.patientId));
  }
  res.json({
    items: rows.map((r) => {
      const g = groups.get(r.patientId)!;
      return {
        ...r,
        bloodGroup: g.group ? { abo: g.group.abo, rhD: g.group.rhD } : null,
        groupConfirmed: g.confirmed,
        groupDiscordant: g.discordant,
        antibodyScreen: g.group?.antibodyScreen ?? null,
        reservedUnits: reserved.filter((u) => u.requestId === r.id),
        issuedCount: issued.find((i) => i.requestId === r.id)?.n ?? 0,
      };
    }),
  });
});

function sqlNotReturned() {
  return sql`${transfusions.status} <> 'RETURNED'`;
}

async function loadRequest(id: string, facilityId: string | null) {
  const [r] = await db.select().from(transfusionRequests).where(eq(transfusionRequests.id, id));
  if (!r || r.facilityId !== facilityId) throw notFound('Request not found');
  return r;
}

bloodBankRouter.post('/requests/:id/sample', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  await assertStaff(ctx);
  const r = await loadRequest(id, ctx.facilityId);
  if (r.status !== 'REQUESTED') throw conflict('The sample was already received');
  const [row] = await db
    .update(transfusionRequests)
    .set({ status: 'SAMPLE_RECEIVED', sampleReceivedAt: new Date() })
    .where(eq(transfusionRequests.id, id))
    .returning();
  await publishBloodBank(r.facilityId, id);
  res.json(row);
});

/** Units of the requested product that are compatible with the patient, for the crossmatch picker. */
bloodBankRouter.get('/requests/:id/compatible-units', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  await assertStaff(ctx);
  const r = await loadRequest(id, ctx.facilityId);
  const patient = await getPatientOrThrow(r.patientId);
  const g = await currentBloodGroup(r.patientId);
  const recipient = g.confirmed && g.group ? { abo: g.group.abo, rhD: g.group.rhD } : null;
  const now = new Date();
  const units = await db
    .select()
    .from(bloodUnits)
    .where(
      and(
        eq(bloodUnits.facilityId, r.facilityId),
        eq(bloodUnits.product, r.product),
        eq(bloodUnits.status, 'AVAILABLE'),
        gte(bloodUnits.expiresAt, now),
      ),
    )
    .orderBy(asc(bloodUnits.expiresAt));
  const preferRhNegative = isWomanOfChildbearingAge(patient);
  res.json({
    recipient,
    groupConfirmed: g.confirmed,
    items: units
      .map((u) => ({
        ...u,
        compatibility: checkCompatibility(r.product, recipient, groupOf(u), { preferRhNegative }),
      }))
      .filter((u) => u.compatibility.ok),
  });
});

bloodBankRouter.post('/requests/:id/crossmatch', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { unitIds, emergencyReason } = parse(
    z.object({
      unitIds: z.array(z.string().uuid()).min(1).max(20),
      emergencyReason: z.string().trim().min(10).max(300).optional().nullable(),
    }),
    req.body,
  );
  await assertStaff(ctx);
  const r = await loadRequest(id, ctx.facilityId);
  if (!['REQUESTED', 'SAMPLE_RECEIVED', 'CROSSMATCHED'].includes(r.status)) {
    throw conflict('This request can no longer be crossmatched');
  }
  if (r.status === 'REQUESTED' && r.urgency !== 'EMERGENCY') {
    throw conflict('Receive the patient sample before crossmatching');
  }
  const patient = await getPatientOrThrow(r.patientId);
  const g = await currentBloodGroup(r.patientId);
  if (g.discordant) {
    throw new HttpError(
      409,
      'GROUP_DISCORDANT',
      'Blood group results disagree – repeat the blood group on a new sample',
    );
  }
  const recipient = g.confirmed && g.group ? { abo: g.group.abo, rhD: g.group.rhD } : null;
  const preferRhNegative = isWomanOfChildbearingAge(patient);
  const warnings: string[] = [];
  const result = await db.transaction(async (tx) => {
    const already = await tx
      .select({ id: bloodUnits.id })
      .from(bloodUnits)
      .where(and(eq(bloodUnits.reservedForRequestId, id), eq(bloodUnits.status, 'RESERVED')));
    if (already.length + unitIds.length > r.units) {
      throw badRequest('More units than requested');
    }
    const units = await tx
      .select()
      .from(bloodUnits)
      .where(inArray(bloodUnits.id, unitIds))
      .for('update');
    if (units.length !== unitIds.length) throw notFound('Unit not found');
    const now = new Date();
    for (const u of units) {
      if (u.facilityId !== r.facilityId) throw notFound('Unit not found');
      if (u.status !== 'AVAILABLE') {
        throw conflict('A selected unit is not available');
      }
      if (unitIsExpired(u, now)) {
        throw new HttpError(409, 'UNIT_EXPIRED', 'A selected unit has expired');
      }
      if (u.product !== r.product) throw badRequest('A selected unit is a different product');
      const c = checkCompatibility(r.product, recipient, groupOf(u), {
        preferRhNegative,
        emergencyReason,
      });
      if (!c.ok) {
        throw new HttpError(409, 'INCOMPATIBLE', c.reason ?? 'Incompatible unit', {
          reason: c.reason,
          unitNumber: u.unitNumber,
        });
      }
      warnings.push(...c.warnings);
    }
    await tx
      .update(bloodUnits)
      .set({ status: 'RESERVED', reservedForRequestId: id })
      .where(inArray(bloodUnits.id, unitIds));
    const [row] = await tx
      .update(transfusionRequests)
      .set({
        status: 'CROSSMATCHED',
        crossmatchedById: ctx.userId,
        crossmatchedAt: new Date(),
        sampleReceivedAt: r.sampleReceivedAt ?? new Date(),
      })
      .where(eq(transfusionRequests.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.TRANSFUSION_CROSSMATCHED,
        actor: ctx,
        resourceType: 'transfusion_request',
        resourceId: id,
        patientId: r.patientId,
        meta: requestMeta(req),
        metadata: {
          units: units.map((u) => u.unitNumber),
          recipient: recipient ?? 'UNCONFIRMED',
          emergencyReason: emergencyReason ?? undefined,
        },
      },
      tx,
    );
    await notifyUsers(
      [r.requestedById],
      {
        type: 'bloodbank',
        title: 'Blood is crossmatched and ready to issue',
        link: `/doctor/patients/${r.patientId}?tab=transfusion`,
        important: r.urgency !== 'ROUTINE',
      },
      tx,
    );
    return row!;
  });
  await publishBloodBank(r.facilityId, id);
  res.json({ ...result, warnings: [...new Set(warnings)] });
});

async function createTransfusion(
  ctx: AuthContext,
  r: typeof transfusionRequests.$inferSelect,
  unitId: string,
  meta: ReturnType<typeof requestMeta>,
  emergency: { reason: string } | null,
) {
  return db.transaction(async (tx) => {
    const [u] = await tx.select().from(bloodUnits).where(eq(bloodUnits.id, unitId)).for('update');
    if (!u || u.facilityId !== r.facilityId) throw notFound('Unit not found');
    if (unitIsExpired(u)) {
      throw new HttpError(409, 'UNIT_EXPIRED', 'This unit has expired and cannot be issued');
    }
    if (emergency) {
      if (u.status !== 'AVAILABLE') throw conflict('A selected unit is not available');
      if (u.product !== 'RED_CELLS' || u.abo !== 'O' || u.rhD !== 'NEG') {
        throw badRequest('Uncrossmatched emergency blood must be group O RhD-negative red cells');
      }
    } else if (u.status !== 'RESERVED' || u.reservedForRequestId !== r.id) {
      throw conflict('This unit is not crossmatched for this request');
    }
    const [t] = await tx
      .insert(transfusions)
      .values({
        requestId: r.id,
        unitId: u.id,
        patientId: r.patientId,
        issuedById: ctx.userId,
        status: 'ISSUED',
      })
      .returning();
    await tx
      .update(bloodUnits)
      .set({ status: 'ISSUED', reservedForRequestId: r.id })
      .where(eq(bloodUnits.id, u.id));
    await tx
      .update(transfusionRequests)
      .set({ status: 'ISSUED' })
      .where(eq(transfusionRequests.id, r.id));
    await audit(
      {
        action: AuditAction.BLOOD_UNIT_ISSUED,
        actor: ctx,
        resourceType: 'transfusion',
        resourceId: t!.id,
        patientId: r.patientId,
        meta,
        metadata: {
          unitNumber: u.unitNumber,
          product: u.product,
          group: `${u.abo} ${u.rhD}`,
          emergencyUncrossmatched: emergency ? true : undefined,
          reason: emergency?.reason,
        },
      },
      tx,
    );
    await notifyUsers(
      [r.requestedById],
      {
        type: 'bloodbank',
        title: 'Blood unit issued – start the bedside check',
        link: `/doctor/patients/${r.patientId}?tab=transfusion`,
        important: r.urgency !== 'ROUTINE',
      },
      tx,
    );
    return t!;
  });
}

bloodBankRouter.post('/requests/:id/issue', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { unitId } = parse(z.object({ unitId: z.string().uuid() }), req.body);
  await assertStaff(ctx);
  const r = await loadRequest(id, ctx.facilityId);
  if (!['CROSSMATCHED', 'ISSUED'].includes(r.status)) {
    throw conflict('Crossmatch the request before issuing');
  }
  const t = await createTransfusion(ctx, r, unitId, requestMeta(req), null);
  await publishBloodBank(r.facilityId, id);
  res.status(201).json(t);
});

/** Uncrossmatched group O RhD-negative red cells for a life-threatening emergency. */
bloodBankRouter.post('/requests/:id/emergency-issue', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { unitId, reason } = parse(
    z.object({ unitId: z.string().uuid(), reason: z.string().trim().min(10).max(300) }),
    req.body,
  );
  await assertStaff(ctx);
  const r = await loadRequest(id, ctx.facilityId);
  if (r.urgency !== 'EMERGENCY') {
    throw conflict('Uncrossmatched blood can only be issued for emergency requests');
  }
  if (r.product !== 'RED_CELLS') throw badRequest('Emergency issue applies to red cells only');
  if (['COMPLETED', 'CANCELLED'].includes(r.status)) throw conflict('The request is closed');
  const t = await createTransfusion(ctx, r, unitId, requestMeta(req), { reason });
  await publishBloodBank(r.facilityId, id);
  res.status(201).json(t);
});

bloodBankRouter.post('/requests/:id/cancel', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
  const r = await loadRequest(id, ctx.facilityId);
  if (r.requestedById !== ctx.userId && !(await isBloodBankStaff(ctx.userId, ctx.facilityId))) {
    throw forbidden('Only the requesting doctor or the blood bank can cancel');
  }
  if (['COMPLETED', 'CANCELLED'].includes(r.status)) throw conflict('The request is closed');
  await db.transaction(async (tx) => {
    const running = await tx
      .select({ id: transfusions.id })
      .from(transfusions)
      .where(
        and(
          eq(transfusions.requestId, id),
          inArray(transfusions.status, ['AWAITING_CHECK', 'IN_PROGRESS']),
        ),
      );
    if (running.length) throw conflict('A transfusion is in progress – stop it first');
    // Issued but not started units go back to stock (returned within the cold-chain window).
    const notStarted = await tx
      .select({ id: transfusions.id, unitId: transfusions.unitId })
      .from(transfusions)
      .where(and(eq(transfusions.requestId, id), eq(transfusions.status, 'ISSUED')));
    if (notStarted.length) {
      await tx
        .update(transfusions)
        .set({ status: 'RETURNED' })
        .where(
          inArray(
            transfusions.id,
            notStarted.map((n) => n.id),
          ),
        );
    }
    await tx
      .update(bloodUnits)
      .set({ status: 'AVAILABLE', reservedForRequestId: null })
      .where(
        and(
          eq(bloodUnits.reservedForRequestId, id),
          inArray(bloodUnits.status, ['RESERVED', 'ISSUED']),
        ),
      );
    await tx
      .update(transfusionRequests)
      .set({ status: 'CANCELLED', cancelReason: reason })
      .where(eq(transfusionRequests.id, id));
  });
  await publishBloodBank(r.facilityId, id);
  res.status(204).end();
});

/* ------------------------------------------------------------------ bedside ------------------- */

const issuedBy = alias(users, 'issued_by');
const checkedBy = alias(users, 'checked_by');
const secondChecker = alias(users, 'second_checker');

async function transfusionList(where: SQL) {
  return db
    .select({
      id: transfusions.id,
      requestId: transfusions.requestId,
      patientId: transfusions.patientId,
      status: transfusions.status,
      issuedAt: transfusions.issuedAt,
      startedAt: transfusions.startedAt,
      endedAt: transfusions.endedAt,
      observations: transfusions.observations,
      reaction: transfusions.reaction,
      reactionType: transfusions.reactionType,
      reactionSeverity: transfusions.reactionSeverity,
      reactionDetails: transfusions.reactionDetails,
      unitId: bloodUnits.id,
      unitNumber: bloodUnits.unitNumber,
      product: bloodUnits.product,
      abo: bloodUnits.abo,
      rhD: bloodUnits.rhD,
      volumeMl: bloodUnits.volumeMl,
      expiresAt: bloodUnits.expiresAt,
      issuedBy: issuedBy.fullName,
      checkedById: transfusions.checkedById,
      checkedBy: checkedBy.fullName,
      secondCheckerId: transfusions.secondCheckerId,
      secondChecker: secondChecker.fullName,
    })
    .from(transfusions)
    .innerJoin(bloodUnits, eq(bloodUnits.id, transfusions.unitId))
    .innerJoin(issuedBy, eq(issuedBy.id, transfusions.issuedById))
    .leftJoin(checkedBy, eq(checkedBy.id, transfusions.checkedById))
    .leftJoin(secondChecker, eq(secondChecker.id, transfusions.secondCheckerId))
    .where(where)
    .orderBy(desc(transfusions.issuedAt))
    .limit(100);
}

async function loadTransfusion(id: string) {
  const [row] = await db
    .select({ t: transfusions, unit: bloodUnits, request: transfusionRequests })
    .from(transfusions)
    .innerJoin(bloodUnits, eq(bloodUnits.id, transfusions.unitId))
    .innerJoin(transfusionRequests, eq(transfusionRequests.id, transfusions.requestId))
    .where(eq(transfusions.id, id));
  if (!row) throw notFound('Transfusion not found');
  return row;
}

type Observation = Record<string, unknown> & { phase: string; at: string; by: string };

const StartInput = z.object({
  nationalId: z.string().trim().min(3).max(20),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  unitNumber: z.string().trim().min(4).max(30),
  secondCheckerId: z.string().uuid(),
  vitals: Vitals,
});

/** First person of the two-person bedside check: identity, unit, baseline observations. */
bloodBankRouter.post(
  '/transfusions/:id/start',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const input = parse(StartInput, req.body);
    const { t, unit } = await loadTransfusion(id);
    await assertClinicalWriteAccess(ctx, t.patientId, requestMeta(req), WRITERS.careTeam);
    if (!['ISSUED', 'AWAITING_CHECK'].includes(t.status)) {
      throw conflict('This transfusion has already started or ended');
    }
    const patient = await getPatientOrThrow(t.patientId);
    if (input.nationalId !== patient.nationalId || input.dateOfBirth !== patient.dateOfBirth) {
      throw new HttpError(
        409,
        'IDENTITY_MISMATCH',
        'Patient identity does not match the blood unit – STOP and contact the blood bank',
      );
    }
    if (input.unitNumber.toUpperCase() !== unit.unitNumber.toUpperCase()) {
      throw new HttpError(
        409,
        'UNIT_MISMATCH',
        'The unit number does not match the issued unit – STOP and contact the blood bank',
      );
    }
    if (unitIsExpired(unit)) {
      throw new HttpError(409, 'UNIT_EXPIRED', 'This unit has expired – do not transfuse');
    }
    if (input.secondCheckerId === ctx.userId) {
      throw badRequest('The second check must be done by a different person');
    }
    const [checker] = await db
      .select({
        id: users.id,
        role: users.role,
        facilityId: users.facilityId,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.id, input.secondCheckerId));
    if (
      !checker ||
      !checker.isActive ||
      !['DOCTOR', 'NURSE'].includes(checker.role) ||
      checker.facilityId !== ctx.facilityId
    ) {
      throw badRequest('The second checker must be a doctor or nurse of this facility');
    }
    const pre: Observation = {
      phase: 'PRE',
      at: new Date().toISOString(),
      by: ctx.userId,
      ...input.vitals,
    };
    const observations = [
      ...(t.observations as Observation[]).filter((o) => o.phase !== 'PRE'),
      pre,
    ];
    const [row] = await db
      .update(transfusions)
      .set({
        checkedById: ctx.userId,
        secondCheckerId: input.secondCheckerId,
        status: 'AWAITING_CHECK',
        observations,
      })
      .where(eq(transfusions.id, id))
      .returning();
    await notifyUsers([input.secondCheckerId], {
      type: 'bloodbank',
      title: 'Please confirm the bedside check for a blood transfusion',
      link: `/doctor/patients/${t.patientId}?tab=transfusion`,
      important: true,
    });
    res.json(row);
  },
);

/** Second person of the two-person check, with their own sign-in, within 10 minutes. */
bloodBankRouter.post(
  '/transfusions/:id/confirm-check',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const { t, request } = await loadTransfusion(id);
    if (t.status !== 'AWAITING_CHECK') throw conflict('No bedside check is waiting');
    if (t.secondCheckerId !== ctx.userId) {
      throw forbidden('Only the named second checker can confirm');
    }
    if (t.checkedById === ctx.userId) throw badRequest('The two checkers must be different people');
    const pre = (t.observations as Observation[]).find((o) => o.phase === 'PRE');
    const startedCheck = pre ? new Date(pre.at) : null;
    if (!startedCheck || Date.now() - startedCheck.getTime() > SECOND_CHECK_MINUTES * 60_000) {
      await db
        .update(transfusions)
        .set({ status: 'ISSUED', secondCheckerId: null })
        .where(eq(transfusions.id, id));
      throw new HttpError(
        409,
        'CHECK_EXPIRED',
        'The bedside check is older than 10 minutes – repeat it at the bedside',
      );
    }
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(transfusions)
        .set({ status: 'IN_PROGRESS', startedAt: new Date() })
        .where(eq(transfusions.id, id))
        .returning();
      await audit(
        {
          action: AuditAction.TRANSFUSION_RECORDED,
          actor: ctx,
          resourceType: 'transfusion',
          resourceId: id,
          patientId: t.patientId,
          meta: requestMeta(req),
          metadata: { phase: 'START', checkedBy: t.checkedById, secondChecker: ctx.userId },
        },
        tx,
      );
      return updated!;
    });
    await publishBloodBank(request.facilityId, request.id);
    res.json(row);
  },
);

bloodBankRouter.post(
  '/transfusions/:id/observation',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const input = parse(
      z.object({
        phase: z.enum(['T15', 'HOURLY', 'OTHER']),
        vitals: Vitals,
        note: z.string().trim().max(300).optional().nullable(),
      }),
      req.body,
    );
    const { t } = await loadTransfusion(id);
    await assertClinicalWriteAccess(ctx, t.patientId, requestMeta(req), WRITERS.careTeam);
    if (t.status !== 'IN_PROGRESS') throw conflict('The transfusion is not running');
    const obs: Observation = {
      phase: input.phase,
      at: new Date().toISOString(),
      by: ctx.userId,
      ...input.vitals,
      ...(input.note ? { note: input.note } : {}),
    };
    const [row] = await db
      .update(transfusions)
      .set({ observations: [...(t.observations as Observation[]), obs] })
      .where(eq(transfusions.id, id))
      .returning();
    res.json(row);
  },
);

bloodBankRouter.post(
  '/transfusions/:id/complete',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const input = parse(
      z.object({ volumeGivenMl: z.number().int().min(1).max(1500), vitals: Vitals.optional() }),
      req.body,
    );
    const { t, unit, request } = await loadTransfusion(id);
    await assertClinicalWriteAccess(ctx, t.patientId, requestMeta(req), WRITERS.careTeam);
    if (t.status !== 'IN_PROGRESS') throw conflict('The transfusion is not running');
    const end: Observation = {
      phase: 'END',
      at: new Date().toISOString(),
      by: ctx.userId,
      volumeGivenMl: input.volumeGivenMl,
      ...(input.vitals ?? {}),
    };
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(transfusions)
        .set({
          status: 'COMPLETED',
          endedAt: new Date(),
          observations: [...(t.observations as Observation[]), end],
        })
        .where(eq(transfusions.id, id))
        .returning();
      await tx.update(bloodUnits).set({ status: 'TRANSFUSED' }).where(eq(bloodUnits.id, unit.id));
      const [{ n } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(transfusions)
        .where(
          and(
            eq(transfusions.requestId, request.id),
            inArray(transfusions.status, ['COMPLETED', 'STOPPED']),
          ),
        );
      if (n >= request.units) {
        await tx
          .update(transfusionRequests)
          .set({ status: 'COMPLETED' })
          .where(eq(transfusionRequests.id, request.id));
      }
      await audit(
        {
          action: AuditAction.TRANSFUSION_RECORDED,
          actor: ctx,
          resourceType: 'transfusion',
          resourceId: id,
          patientId: t.patientId,
          meta: requestMeta(req),
          metadata: {
            phase: 'END',
            unitNumber: unit.unitNumber,
            volumeGivenMl: input.volumeGivenMl,
          },
        },
        tx,
      );
      return updated!;
    });
    await publishBloodBank(request.facilityId, request.id);
    res.json(row);
  },
);

const ReactionInput = z.object({
  type: z.enum(['FEBRILE', 'ALLERGIC', 'HAEMOLYTIC', 'TACO', 'TRALI', 'ANAPHYLAXIS', 'OTHER']),
  severity: z.enum(['MILD', 'MODERATE', 'SEVERE', 'LIFE_THREATENING']),
  details: z.string().trim().min(5).max(1500),
  actionsTaken: z.string().trim().max(400).optional().nullable(),
  vitals: Vitals.optional(),
});

/** A suspected transfusion reaction stops the transfusion and alerts the doctor and blood bank. */
bloodBankRouter.post(
  '/transfusions/:id/reaction',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const input = parse(ReactionInput, req.body);
    const { t, unit, request } = await loadTransfusion(id);
    await assertClinicalWriteAccess(ctx, t.patientId, requestMeta(req), WRITERS.careTeam);
    const lateWindow = t.endedAt && Date.now() - t.endedAt.getTime() < 24 * 3_600_000;
    if (!(t.status === 'IN_PROGRESS' || (t.status === 'COMPLETED' && lateWindow))) {
      throw conflict('Reactions are recorded during a transfusion or within 24 hours after it');
    }
    const wasRunning = t.status === 'IN_PROGRESS';
    const obs: Observation = {
      phase: 'REACTION',
      at: new Date().toISOString(),
      by: ctx.userId,
      ...(input.vitals ?? {}),
      ...(input.actionsTaken ? { actionsTaken: input.actionsTaken } : {}),
    };
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(transfusions)
        .set({
          reaction: true,
          reactionType: input.type,
          reactionSeverity: input.severity,
          reactionDetails: input.details,
          status: wasRunning ? 'STOPPED' : t.status,
          endedAt: wasRunning ? new Date() : t.endedAt,
          observations: [...(t.observations as Observation[]), obs],
        })
        .where(eq(transfusions.id, id))
        .returning();
      if (wasRunning) {
        await tx.update(bloodUnits).set({ status: 'TRANSFUSED' }).where(eq(bloodUnits.id, unit.id));
      }
      await audit(
        {
          action: AuditAction.TRANSFUSION_REACTION,
          actor: ctx,
          resourceType: 'transfusion',
          resourceId: id,
          patientId: t.patientId,
          meta: requestMeta(req),
          metadata: { type: input.type, severity: input.severity, unitNumber: unit.unitNumber },
        },
        tx,
      );
      const staff = await bloodBankStaff(request.facilityId, tx);
      await notifyUsers(
        [request.requestedById, ...staff],
        {
          type: 'bloodbank',
          title: 'Transfusion reaction reported – review now',
          link: `/doctor/patients/${t.patientId}?tab=transfusion`,
          important: true,
        },
        tx,
      );
      return updated!;
    });
    await publishBloodBank(request.facilityId, request.id);
    res.json(row);
  },
);

/* ------------------------------------------------------------------ haemovigilance ------------ */

bloodBankRouter.get('/reactions', requireRole('DOCTOR', 'NURSE', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const q = parse(
    z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }),
    req.query,
  );
  const filters: SQL[] = [
    eq(transfusions.reaction, true),
    eq(transfusionRequests.facilityId, ctx.facilityId),
  ];
  if (q.from) filters.push(gte(transfusions.issuedAt, q.from));
  if (q.to) filters.push(lte(transfusions.issuedAt, q.to));
  const where = and(...filters);
  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(transfusions)
    .innerJoin(transfusionRequests, eq(transfusionRequests.id, transfusions.requestId))
    .where(
      and(
        eq(transfusionRequests.facilityId, ctx.facilityId),
        q.from ? gte(transfusions.issuedAt, q.from) : undefined,
        q.to ? lte(transfusions.issuedAt, q.to) : undefined,
        sqlNotReturned(),
      ),
    );
  const byType = await db
    .select({
      type: transfusions.reactionType,
      severity: transfusions.reactionSeverity,
      n: count(),
    })
    .from(transfusions)
    .innerJoin(transfusionRequests, eq(transfusionRequests.id, transfusions.requestId))
    .where(where)
    .groupBy(transfusions.reactionType, transfusions.reactionSeverity);

  if (ctx.role === 'DIRECTOR') {
    // Directors see counts only, with small numbers suppressed.
    res.json({
      transfusions: total,
      counts: byType.map((c) => ({
        type: c.type,
        severity: c.severity,
        count: c.n < SUPPRESS_BELOW ? null : c.n,
        suppressed: c.n < SUPPRESS_BELOW,
      })),
      items: [],
    });
    return;
  }
  await assertStaff(ctx);
  const items = await db
    .select({
      id: transfusions.id,
      patientId: transfusions.patientId,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      unitNumber: bloodUnits.unitNumber,
      product: bloodUnits.product,
      type: transfusions.reactionType,
      severity: transfusions.reactionSeverity,
      details: transfusions.reactionDetails,
      issuedAt: transfusions.issuedAt,
      endedAt: transfusions.endedAt,
      status: transfusions.status,
    })
    .from(transfusions)
    .innerJoin(transfusionRequests, eq(transfusionRequests.id, transfusions.requestId))
    .innerJoin(bloodUnits, eq(bloodUnits.id, transfusions.unitId))
    .innerJoin(patients, eq(patients.id, transfusions.patientId))
    .where(where)
    .orderBy(desc(transfusions.issuedAt))
    .limit(200);
  res.json({
    transfusions: total,
    counts: byType.map((c) => ({
      type: c.type,
      severity: c.severity,
      count: c.n,
      suppressed: false,
    })),
    items,
  });
});
