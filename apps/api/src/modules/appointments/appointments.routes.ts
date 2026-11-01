import { Router } from 'express';
import { aliasedTable, and, asc, eq, gte, inArray, lte, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  appointments,
  appointmentStatusEnum,
  facilities,
  patients,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { hasActiveCareAssignment, resolveClinicalReadAccess } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';

type Status = (typeof appointmentStatusEnum.enumValues)[number];

const CreateSchema = z.object({
  patientId: z.string().uuid().optional(),
  doctorId: z.string().uuid().optional(),
  scheduledAt: z
    .string()
    .datetime({ offset: true })
    .refine((d) => new Date(d) > new Date(), 'Appointment must be in the future'),
  durationMinutes: z.number().int().min(5).max(480).default(20),
  reason: z.string().trim().min(2).max(500),
});

const ListQuery = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  status: z.enum(appointmentStatusEnum.enumValues).optional(),
});

const StatusSchema = z.object({ status: z.enum(appointmentStatusEnum.enumValues) });
const IdParam = z.object({ id: z.string().uuid() });

/**
 * Allowed status transitions per role. Patients can only cancel; doctors run their own schedule.
 */
const TRANSITIONS: Record<'PATIENT' | 'DOCTOR', Partial<Record<Status, Status[]>>> = {
  PATIENT: { REQUESTED: ['CANCELLED'], CONFIRMED: ['CANCELLED'] },
  DOCTOR: {
    REQUESTED: ['CONFIRMED', 'CANCELLED'],
    CONFIRMED: ['COMPLETED', 'CANCELLED', 'NO_SHOW'],
  },
};

const doctor = aliasedTable(users, 'doctor');

function scopeFilter(ctx: AuthContext): SQL {
  switch (ctx.role) {
    case 'PATIENT':
      return eq(appointments.patientId, ctx.patientId ?? '00000000-0000-0000-0000-000000000000');
    case 'DOCTOR':
      return eq(appointments.doctorId, ctx.userId);
    case 'DIRECTOR':
      return eq(appointments.facilityId, ctx.facilityId!);
    default:
      throw forbidden();
  }
}

async function assertNoOverlap(doctorId: string, start: Date, minutes: number, excludeId?: string) {
  const end = new Date(start.getTime() + minutes * 60_000);
  const [clash] = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, doctorId),
        inArray(appointments.status, ['CONFIRMED']),
        excludeId ? ne(appointments.id, excludeId) : undefined,
        sql`${appointments.scheduledAt} < ${end.toISOString()}`,
        sql`${appointments.scheduledAt} + make_interval(mins => ${appointments.durationMinutes}) > ${start.toISOString()}`,
      ),
    )
    .limit(1);
  if (clash) throw conflict('The doctor already has a confirmed appointment in this time slot');
}

export const appointmentsRouter = Router();
appointmentsRouter.use(authenticate, requireRole('PATIENT', 'DOCTOR', 'DIRECTOR'));

appointmentsRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [scopeFilter(ctx)];
  if (q.from) filters.push(gte(appointments.scheduledAt, new Date(q.from)));
  if (q.to) filters.push(lte(appointments.scheduledAt, new Date(q.to)));
  if (q.status) filters.push(eq(appointments.status, q.status));

  const rows = await db
    .select({
      id: appointments.id,
      scheduledAt: appointments.scheduledAt,
      durationMinutes: appointments.durationMinutes,
      reason: appointments.reason,
      status: appointments.status,
      patientId: appointments.patientId,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      doctorId: appointments.doctorId,
      doctorName: doctor.fullName,
      doctorSpecialty: doctor.specialty,
      facilityId: appointments.facilityId,
      facilityName: facilities.name,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .innerJoin(doctor, eq(doctor.id, appointments.doctorId))
    .innerJoin(facilities, eq(facilities.id, appointments.facilityId))
    .where(and(...filters))
    .orderBy(asc(appointments.scheduledAt))
    .limit(500);
  res.json({ items: rows });
});

appointmentsRouter.post('/', requireRole('PATIENT', 'DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(CreateSchema, req.body);

  let patientId: string;
  let doctorId: string;
  let status: Status;
  if (ctx.role === 'PATIENT') {
    if (!ctx.patientId) throw forbidden('No patient record is linked to this account');
    if (!input.doctorId) throw badRequest('doctorId is required');
    patientId = ctx.patientId;
    doctorId = input.doctorId;
    // Patients may book with doctors in their care team; the doctor then confirms.
    if (!(await hasActiveCareAssignment(doctorId, patientId))) {
      throw forbidden('You can only book appointments with doctors in your care team');
    }
    status = 'REQUESTED';
  } else {
    if (!input.patientId) throw badRequest('patientId is required');
    patientId = input.patientId;
    doctorId = ctx.userId;
    await resolveClinicalReadAccess(ctx, patientId);
    status = 'CONFIRMED';
  }

  const [doc] = await db
    .select({ facilityId: users.facilityId, isActive: users.isActive })
    .from(users)
    .where(and(eq(users.id, doctorId), eq(users.role, 'DOCTOR')));
  if (!doc?.isActive || !doc.facilityId) throw badRequest('Doctor not available');

  const scheduledAt = new Date(input.scheduledAt);
  if (status === 'CONFIRMED') await assertNoOverlap(doctorId, scheduledAt, input.durationMinutes);

  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(appointments)
      .values({
        patientId,
        doctorId,
        facilityId: doc.facilityId!,
        scheduledAt,
        durationMinutes: input.durationMinutes,
        reason: input.reason,
        status,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.APPOINTMENT_CREATED,
        actor: ctx,
        resourceType: 'appointment',
        resourceId: created!.id,
        patientId,
        meta: requestMeta(req),
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

appointmentsRouter.patch('/:id/status', requireRole('PATIENT', 'DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { status } = parse(StatusSchema, req.body);

  const [appt] = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, id), scopeFilter(ctx)));
  if (!appt) throw notFound('Appointment not found');

  const allowed = TRANSITIONS[ctx.role as 'PATIENT' | 'DOCTOR'][appt.status] ?? [];
  if (!allowed.includes(status)) {
    throw badRequest(`Cannot change an appointment from ${appt.status} to ${status}`);
  }
  if (status === 'CONFIRMED') {
    await assertNoOverlap(appt.doctorId, appt.scheduledAt, appt.durationMinutes, appt.id);
  }

  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(appointments)
      .set({ status })
      .where(eq(appointments.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.APPOINTMENT_UPDATED,
        actor: ctx,
        resourceType: 'appointment',
        resourceId: id,
        patientId: appt.patientId,
        meta: requestMeta(req),
        metadata: { from: appt.status, to: status },
      },
      tx,
    );
    return updated!;
  });
  res.json(row);
});
