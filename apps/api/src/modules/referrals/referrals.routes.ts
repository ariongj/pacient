import { Router } from 'express';
import { aliasedTable, and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  careAssignments,
  facilities,
  patients,
  referralPriorityEnum,
  referrals,
  referralStatusEnum,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertFullProxyScope,
  hasActiveCareAssignment,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  notifyFacilityRole,
  notifyPatient,
  notifyUsers,
} from '../notifications/notifications.service.js';

/**
 * Referrals are the only route by which a patient's record becomes visible to another
 * institution. The referring doctor writes a purpose-specific summary; the receiving facility sees
 * that summary and minimal demographics while the referral is pending. Only acceptance creates a
 * care relationship for a named receiving doctor, and every step is audited and visible to the
 * patient.
 */
const CreateSchema = z.object({
  patientId: z.string().uuid(),
  toFacilityId: z.string().uuid(),
  toDoctorId: z.string().uuid().optional().nullable(),
  specialty: z.string().trim().min(2).max(120),
  priority: z.enum(referralPriorityEnum.enumValues).default('ROUTINE'),
  reason: z.string().trim().min(5).max(500),
  clinicalSummary: z.string().trim().min(20).max(10_000),
});
const ListQuery = z.object({
  direction: z.enum(['incoming', 'outgoing']).optional(),
  status: z.enum(referralStatusEnum.enumValues).optional(),
});
const IdParam = z.object({ id: z.string().uuid() });
const AcceptSchema = z.object({
  doctorId: z.string().uuid().optional(),
  responseNote: z.string().trim().max(2000).optional(),
});
const NoteSchema = z.object({ responseNote: z.string().trim().min(3).max(2000) });

const fromDoctor = aliasedTable(users, 'from_doctor');
const fromFacility = aliasedTable(facilities, 'from_facility');
const toFacility = aliasedTable(facilities, 'to_facility');

const columns = {
  id: referrals.id,
  status: referrals.status,
  priority: referrals.priority,
  specialty: referrals.specialty,
  reason: referrals.reason,
  clinicalSummary: referrals.clinicalSummary,
  responseNote: referrals.responseNote,
  respondedAt: referrals.respondedAt,
  createdAt: referrals.createdAt,
  patientId: referrals.patientId,
  patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
  patientDateOfBirth: patients.dateOfBirth,
  patientSex: patients.sex,
  fromDoctorId: referrals.fromDoctorId,
  fromDoctorName: fromDoctor.fullName,
  fromFacilityId: referrals.fromFacilityId,
  fromFacilityName: fromFacility.name,
  toFacilityId: referrals.toFacilityId,
  toFacilityName: toFacility.name,
  toDoctorId: referrals.toDoctorId,
  // Subquery rather than a second alias of `users` (Drizzle cannot type two aliases of one table
  // when one join is nullable).
  toDoctorName: sql<
    string | null
  >`(SELECT u.full_name FROM users u WHERE u.id = ${referrals.toDoctorId})`,
};

function baseQuery() {
  return db
    .select(columns)
    .from(referrals)
    .innerJoin(patients, eq(patients.id, referrals.patientId))
    .innerJoin(fromDoctor, eq(fromDoctor.id, referrals.fromDoctorId))
    .innerJoin(fromFacility, eq(fromFacility.id, referrals.fromFacilityId))
    .innerJoin(toFacility, eq(toFacility.id, referrals.toFacilityId))
    .$dynamic();
}

/** Who may see a referral: both ends, the facility directors on both ends, and the patient. */
function visibility(ctx: AuthContext, direction?: 'incoming' | 'outgoing'): SQL {
  switch (ctx.role) {
    case 'PATIENT':
      return eq(referrals.patientId, ctx.patientId ?? '00000000-0000-0000-0000-000000000000');
    case 'DOCTOR': {
      const incoming = and(
        eq(referrals.toFacilityId, ctx.facilityId!),
        or(isNull(referrals.toDoctorId), eq(referrals.toDoctorId, ctx.userId)),
      )!;
      const outgoing = eq(referrals.fromDoctorId, ctx.userId);
      return direction === 'incoming'
        ? incoming
        : direction === 'outgoing'
          ? outgoing
          : or(incoming, outgoing)!;
    }
    case 'DIRECTOR': {
      const incoming = eq(referrals.toFacilityId, ctx.facilityId!);
      const outgoing = eq(referrals.fromFacilityId, ctx.facilityId!);
      return direction === 'incoming'
        ? incoming
        : direction === 'outgoing'
          ? outgoing
          : or(incoming, outgoing)!;
    }
    default:
      throw forbidden();
  }
}

type ReferralRow = Awaited<ReturnType<ReturnType<typeof baseQuery>['execute']>>[number];

async function loadVisible(ctx: AuthContext, id: string): Promise<ReferralRow> {
  const [row] = await baseQuery().where(and(eq(referrals.id, id), visibility(ctx)));
  if (!row) throw notFound('Referral not found');
  return row;
}

/** Receiving side: a director of the receiving facility, or a doctor there it may be routed to. */
function assertReceiver(
  ctx: AuthContext,
  r: { toFacilityId: string; toDoctorId: string | null },
): void {
  if (ctx.facilityId !== r.toFacilityId) throw forbidden();
  if (ctx.role === 'DOCTOR' && r.toDoctorId && r.toDoctorId !== ctx.userId) throw forbidden();
  if (ctx.role !== 'DOCTOR' && ctx.role !== 'DIRECTOR') throw forbidden();
}

export const referralsRouter = Router();
referralsRouter.use(
  authenticate,
  requireRole('PATIENT', 'DOCTOR', 'DIRECTOR'),
  (req, _res, next) => {
    // Referral summaries are clinical: guardians need full scope.
    assertFullProxyScope(requireAuth(req));
    next();
  },
);

referralsRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ListQuery, req.query);
  const rows = await baseQuery()
    .where(and(visibility(ctx, q.direction), q.status ? eq(referrals.status, q.status) : undefined))
    .orderBy(desc(referrals.createdAt))
    .limit(200);
  res.json({ items: rows });
});

referralsRouter.get('/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  res.json(await loadVisible(ctx, id));
});

referralsRouter.post('/', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(CreateSchema, req.body);
  await assertClinicalWriteAccess(ctx, input.patientId, requestMeta(req));
  if (input.toFacilityId === ctx.facilityId) {
    throw badRequest('Within your own facility, add the colleague to the care team instead');
  }
  const [facility] = await db
    .select({ isActive: facilities.isActive })
    .from(facilities)
    .where(eq(facilities.id, input.toFacilityId));
  if (!facility?.isActive) throw badRequest('Receiving facility not found or inactive');
  if (input.toDoctorId) {
    const [doc] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, input.toDoctorId),
          eq(users.role, 'DOCTOR'),
          eq(users.facilityId, input.toFacilityId),
          eq(users.isActive, true),
        ),
      );
    if (!doc) throw badRequest('Receiving doctor not found at that facility');
  }

  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(referrals)
      .values({ ...input, fromDoctorId: ctx.userId, fromFacilityId: ctx.facilityId! })
      .returning();
    await audit(
      {
        action: AuditAction.REFERRAL_CREATED,
        actor: ctx,
        resourceType: 'referral',
        resourceId: created!.id,
        patientId: input.patientId,
        meta: requestMeta(req),
        metadata: { toFacilityId: input.toFacilityId, priority: input.priority },
      },
      tx,
    );
    const n = {
      type: 'referral',
      title: input.priority === 'URGENT' ? 'New URGENT referral received' : 'New referral received',
      important: input.priority === 'URGENT',
      link: '/referrals',
    };
    if (input.toDoctorId)
      await notifyUsers([input.toDoctorId], { ...n, link: '/doctor/referrals' }, tx);
    await notifyFacilityRole(
      input.toFacilityId,
      ['DIRECTOR'],
      { ...n, link: '/director/referrals' },
      tx,
    );
    await notifyPatient(
      input.patientId,
      {
        type: 'referral',
        title: 'You have been referred to another facility',
        important: true,
        link: '/portal/referrals',
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

referralsRouter.post('/:id/accept', requireRole('DOCTOR', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(AcceptSchema, req.body ?? {});
  const r = await loadVisible(ctx, id);
  assertReceiver(ctx, r);
  if (r.status !== 'PENDING') throw conflict(`Referral is already ${r.status.toLowerCase()}`);

  const doctorId = ctx.role === 'DOCTOR' ? ctx.userId : (input.doctorId ?? r.toDoctorId);
  if (!doctorId) throw badRequest('Choose the doctor who will see the patient');
  const [doc] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.id, doctorId),
        eq(users.role, 'DOCTOR'),
        eq(users.facilityId, r.toFacilityId),
        eq(users.isActive, true),
      ),
    );
  if (!doc) throw badRequest('Doctor not found in the receiving facility');

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(referrals)
      .set({
        status: 'ACCEPTED',
        toDoctorId: doctorId,
        respondedById: ctx.userId,
        respondedAt: new Date(),
        responseNote: input.responseNote ?? null,
      })
      .where(and(eq(referrals.id, id), eq(referrals.status, 'PENDING')))
      .returning({ id: referrals.id });
    if (!updated.length) throw conflict('Referral was updated by someone else');
    // Acceptance is what grants the receiving doctor access to the record.
    if (!(await hasActiveCareAssignment(doctorId, r.patientId, tx))) {
      await tx
        .insert(careAssignments)
        .values({ patientId: r.patientId, doctorId, assignedById: ctx.userId });
    }
    await audit(
      {
        action: AuditAction.REFERRAL_ACCEPTED,
        actor: ctx,
        resourceType: 'referral',
        resourceId: id,
        patientId: r.patientId,
        meta: requestMeta(req),
        metadata: { doctorId },
      },
      tx,
    );
    await notifyUsers(
      [r.fromDoctorId],
      {
        type: 'referral',
        title: 'Your referral was accepted',
        important: true,
        link: '/doctor/referrals',
      },
      tx,
    );
    if (ctx.role === 'DIRECTOR') {
      await notifyUsers(
        [doctorId],
        {
          type: 'referral',
          title: 'A referred patient was assigned to you',
          important: true,
          link: '/doctor/referrals',
        },
        tx,
      );
    }
    await notifyPatient(
      r.patientId,
      {
        type: 'referral',
        title: 'Your referral was accepted',
        important: true,
        link: '/portal/referrals',
      },
      tx,
    );
  });
  res.json(await loadVisible(ctx, id));
});

referralsRouter.post('/:id/decline', requireRole('DOCTOR', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { responseNote } = parse(NoteSchema, req.body);
  const r = await loadVisible(ctx, id);
  assertReceiver(ctx, r);
  if (r.status !== 'PENDING') throw conflict(`Referral is already ${r.status.toLowerCase()}`);
  await db.transaction(async (tx) => {
    await tx
      .update(referrals)
      .set({ status: 'DECLINED', responseNote, respondedById: ctx.userId, respondedAt: new Date() })
      .where(eq(referrals.id, id));
    await audit(
      {
        action: AuditAction.REFERRAL_DECLINED,
        actor: ctx,
        resourceType: 'referral',
        resourceId: id,
        patientId: r.patientId,
        meta: requestMeta(req),
      },
      tx,
    );
    await notifyUsers(
      [r.fromDoctorId],
      {
        type: 'referral',
        title: 'Your referral was declined',
        important: true,
        link: '/doctor/referrals',
      },
      tx,
    );
    await notifyPatient(
      r.patientId,
      {
        type: 'referral',
        title: 'A referral was declined',
        important: true,
        link: '/portal/referrals',
      },
      tx,
    );
  });
  res.json(await loadVisible(ctx, id));
});

referralsRouter.post('/:id/complete', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { responseNote } = parse(NoteSchema, req.body);
  const r = await loadVisible(ctx, id);
  if (r.toDoctorId !== ctx.userId)
    throw forbidden('Only the receiving doctor can complete the referral');
  if (r.status !== 'ACCEPTED') throw conflict('Only accepted referrals can be completed');
  await db.transaction(async (tx) => {
    await tx
      .update(referrals)
      .set({ status: 'COMPLETED', responseNote, respondedAt: new Date() })
      .where(eq(referrals.id, id));
    await audit(
      {
        action: AuditAction.REFERRAL_COMPLETED,
        actor: ctx,
        resourceType: 'referral',
        resourceId: id,
        patientId: r.patientId,
        meta: requestMeta(req),
      },
      tx,
    );
    await notifyUsers(
      [r.fromDoctorId],
      { type: 'referral', title: 'A referral you made was completed', link: '/doctor/referrals' },
      tx,
    );
  });
  res.json(await loadVisible(ctx, id));
});

referralsRouter.post('/:id/cancel', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const r = await loadVisible(ctx, id);
  if (r.fromDoctorId !== ctx.userId) throw forbidden('Only the referring doctor can cancel');
  if (r.status !== 'PENDING') throw conflict('Only pending referrals can be cancelled');
  await db.transaction(async (tx) => {
    await tx
      .update(referrals)
      .set({ status: 'CANCELLED', respondedAt: new Date() })
      .where(eq(referrals.id, id));
    await audit(
      {
        action: AuditAction.REFERRAL_CANCELLED,
        actor: ctx,
        resourceType: 'referral',
        resourceId: id,
        patientId: r.patientId,
        meta: requestMeta(req),
      },
      tx,
    );
  });
  res.json(await loadVisible(ctx, id));
});
