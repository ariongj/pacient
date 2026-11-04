import { Router } from 'express';
import { and, asc, count, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  appointments,
  availabilityExceptions,
  careAssignments,
  doctorAvailability,
  facilities,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { getPatientOrThrow } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { freeSlots } from './slots.service.js';
import { addDays, daysBetween, localDate, toMinutes } from './time.js';

/** Patients may book from tomorrow up to this many days ahead, and hold this many bookings. */
export const PORTAL_HORIZON_DAYS = 60;
export const PORTAL_MAX_FUTURE_BOOKINGS = 3;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const DoctorParam = z.object({ doctorId: z.string().uuid() });

const BlockSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startTime: HHMM,
    endTime: HHMM,
    slotMinutes: z.number().int().min(5).max(240),
    portalBookable: z.boolean().default(true),
    validFrom: DateStr.nullish(),
    validUntil: DateStr.nullish(),
  })
  .refine((b) => b.startTime < b.endTime, 'The end time must be after the start time')
  .refine(
    (b) => toMinutes(b.endTime) - toMinutes(b.startTime) >= b.slotMinutes,
    'The block is shorter than one slot',
  )
  .refine(
    (b) => !b.validFrom || !b.validUntil || b.validFrom <= b.validUntil,
    'The validity period ends before it starts',
  );

const AvailabilitySchema = z.object({ blocks: z.array(BlockSchema).max(50) });

const ExceptionSchema = z
  .object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((e) => new Date(e.endsAt) > new Date(e.startsAt), 'The end must be after the start');

const SlotsQuery = z.object({
  doctorId: z.string().uuid(),
  from: DateStr,
  to: DateStr,
});

const BookSchema = z.object({
  doctorId: z.string().uuid(),
  start: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(2).max(500),
  /** Any online-bookable slot can be booked as a video visit. */
  mode: z.enum(['IN_PERSON', 'VIDEO']).default('IN_PERSON'),
});

async function getDoctor(doctorId: string) {
  const [doctor] = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      specialty: users.specialty,
      facilityId: users.facilityId,
      isActive: users.isActive,
    })
    .from(users)
    .where(and(eq(users.id, doctorId), eq(users.role, 'DOCTOR')));
  if (!doctor?.isActive || !doctor.facilityId) throw notFound('Doctor not found');
  return doctor as typeof doctor & { facilityId: string };
}

/** The doctor themself, or the director/reception of the doctor's facility. */
function assertManagesHours(ctx: AuthContext, doctor: { id: string; facilityId: string }) {
  if (ctx.role === 'DOCTOR' && ctx.userId === doctor.id) return;
  if ((ctx.role === 'DIRECTOR' || ctx.role === 'RECEPTION') && ctx.facilityId === doctor.facilityId)
    return;
  throw forbidden(
    'Only the doctor or their facility’s director or reception can change consulting hours',
  );
}

/** Staff of the doctor's facility may see the doctor's free slots; patients see doctors they may book. */
async function assertMaySeeSlots(ctx: AuthContext, doctor: { id: string; facilityId: string }) {
  if (ctx.role === 'PATIENT') {
    if (!ctx.patientId) throw forbidden('No patient record is linked to this account');
    if (!(await patientMayBook(ctx.patientId, doctor))) {
      throw forbidden('You can book doctors of your registration facility or your care team');
    }
    return;
  }
  if (ctx.facilityId !== doctor.facilityId)
    throw forbidden('This doctor works at another facility');
}

async function patientMayBook(patientId: string, doctor: { id: string; facilityId: string }) {
  const patient = await getPatientOrThrow(patientId);
  if (patient.mergedIntoId) return false;
  if (patient.primaryFacilityId === doctor.facilityId) return true;
  const [care] = await db
    .select({ id: careAssignments.id })
    .from(careAssignments)
    .where(
      and(
        eq(careAssignments.patientId, patientId),
        eq(careAssignments.doctorId, doctor.id),
        isNull(careAssignments.endedAt),
      ),
    )
    .limit(1);
  return Boolean(care);
}

const todayLocal = () => localDate(new Date());

export const schedulingRouter = Router();
schedulingRouter.use(authenticate);

/** Doctors that can be booked: patients see their facility's and their care team's doctors. */
schedulingRouter.get('/doctors', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(
    z.object({
      specialty: z.string().trim().max(120).optional(),
      facilityId: z.string().uuid().optional(),
    }),
    req.query,
  );
  // Explicitly qualified SQL: correlated subqueries must reference the outer "users" row.
  const hasHours = (portalOnly: boolean) =>
    sql<boolean>`EXISTS (SELECT 1 FROM doctor_availability da
      WHERE da.doctor_id = "users"."id" AND da.is_active
      ${portalOnly ? sql`AND da.portal_bookable` : sql``})`;
  let scope;
  let inCareTeam = sql<boolean>`false`;
  if (ctx.role === 'PATIENT') {
    if (!ctx.patientId) throw forbidden('No patient record is linked to this account');
    const patient = await getPatientOrThrow(ctx.patientId);
    const careTeam = sql<boolean>`EXISTS (SELECT 1 FROM care_assignments ca
      WHERE ca.doctor_id = "users"."id" AND ca.patient_id = ${patient.id} AND ca.ended_at IS NULL)`;
    inCareTeam = sql<boolean>`${careTeam}`;
    scope = and(or(eq(users.facilityId, patient.primaryFacilityId), careTeam), hasHours(true));
  } else if (['DOCTOR', 'NURSE', 'RECEPTION', 'DIRECTOR'].includes(ctx.role)) {
    scope = eq(
      users.facilityId,
      q.facilityId && q.facilityId === ctx.facilityId ? q.facilityId : ctx.facilityId!,
    );
  } else {
    throw forbidden();
  }
  const rows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      specialty: users.specialty,
      facilityId: users.facilityId,
      facilityName: facilities.name,
      hasConsultingHours: hasHours(false),
      portalBookable: hasHours(true),
      inCareTeam,
    })
    .from(users)
    .leftJoin(facilities, eq(facilities.id, users.facilityId))
    .where(
      and(
        eq(users.role, 'DOCTOR'),
        eq(users.isActive, true),
        scope,
        q.specialty ? sql`${users.specialty} ILIKE ${`%${q.specialty}%`}` : undefined,
      ),
    )
    .orderBy(asc(users.fullName))
    .limit(200);
  res.json({ items: rows });
});

schedulingRouter.get('/doctors/:doctorId/availability', async (req, res) => {
  const ctx = requireAuth(req);
  const { doctorId } = parse(DoctorParam, req.params);
  const doctor = await getDoctor(doctorId);
  if (ctx.role === 'PATIENT' || ctx.facilityId !== doctor.facilityId) {
    throw forbidden('This doctor works at another facility');
  }
  const [blocks, exceptions] = await Promise.all([
    db
      .select()
      .from(doctorAvailability)
      .where(and(eq(doctorAvailability.doctorId, doctorId), eq(doctorAvailability.isActive, true)))
      .orderBy(asc(doctorAvailability.weekday), asc(doctorAvailability.startTime)),
    db
      .select()
      .from(availabilityExceptions)
      .where(
        and(
          eq(availabilityExceptions.doctorId, doctorId),
          gt(availabilityExceptions.endsAt, new Date()),
        ),
      )
      .orderBy(asc(availabilityExceptions.startsAt)),
  ]);
  const canEdit =
    (ctx.role === 'DOCTOR' && ctx.userId === doctor.id) ||
    ctx.role === 'DIRECTOR' ||
    ctx.role === 'RECEPTION';
  res.json({ doctor, blocks, exceptions, canEdit });
});

/** Replaces the doctor's weekly consulting hours. Existing appointments are not affected. */
schedulingRouter.put('/doctors/:doctorId/availability', async (req, res) => {
  const ctx = requireAuth(req);
  const { doctorId } = parse(DoctorParam, req.params);
  const { blocks } = parse(AvailabilitySchema, req.body);
  const doctor = await getDoctor(doctorId);
  assertManagesHours(ctx, doctor);

  // Blocks of the same weekday must not overlap while both are valid.
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i]!;
      const b = blocks[j]!;
      if (a.weekday !== b.weekday) continue;
      const periodsOverlap =
        (a.validUntil ?? '9999-12-31') >= (b.validFrom ?? '0000-01-01') &&
        (b.validUntil ?? '9999-12-31') >= (a.validFrom ?? '0000-01-01');
      if (periodsOverlap && a.startTime < b.endTime && b.startTime < a.endTime) {
        throw badRequest('Two consulting-hour blocks on the same day overlap');
      }
    }
  }

  const saved = await db.transaction(async (tx) => {
    await tx.delete(doctorAvailability).where(eq(doctorAvailability.doctorId, doctorId));
    const rows = blocks.length
      ? await tx
          .insert(doctorAvailability)
          .values(
            blocks.map((b) => ({
              doctorId,
              facilityId: doctor.facilityId,
              weekday: b.weekday,
              startTime: b.startTime,
              endTime: b.endTime,
              slotMinutes: b.slotMinutes,
              portalBookable: b.portalBookable,
              validFrom: b.validFrom ?? null,
              validUntil: b.validUntil ?? null,
            })),
          )
          .returning()
      : [];
    await audit(
      {
        action: AuditAction.AVAILABILITY_CHANGED,
        actor: ctx,
        resourceType: 'doctor_availability',
        resourceId: doctorId,
        meta: requestMeta(req),
        metadata: { blocks: blocks.length },
      },
      tx,
    );
    return rows;
  });
  res.json({ blocks: saved });
});

schedulingRouter.post('/doctors/:doctorId/exceptions', async (req, res) => {
  const ctx = requireAuth(req);
  const { doctorId } = parse(DoctorParam, req.params);
  const input = parse(ExceptionSchema, req.body);
  const doctor = await getDoctor(doctorId);
  assertManagesHours(ctx, doctor);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(availabilityExceptions)
      .values({
        doctorId,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        reason: input.reason ?? null,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.AVAILABILITY_CHANGED,
        actor: ctx,
        resourceType: 'availability_exception',
        resourceId: created!.id,
        meta: requestMeta(req),
        metadata: { doctorId, startsAt: input.startsAt, endsAt: input.endsAt },
      },
      tx,
    );
    return created!;
  });
  // Appointments already booked in this period are kept; tell the caller so they can rebook.
  const [affected] = await db
    .select({ n: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, doctorId),
        inArray(appointments.status, ['REQUESTED', 'CONFIRMED']),
        sql`${appointments.scheduledAt} < ${row.endsAt.toISOString()}`,
        sql`${appointments.scheduledAt} + make_interval(mins => ${appointments.durationMinutes}) > ${row.startsAt.toISOString()}`,
      ),
    );
  res.status(201).json({ ...row, affectedAppointments: affected?.n ?? 0 });
});

schedulingRouter.delete('/doctors/:doctorId/exceptions/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { doctorId, id } = parse(DoctorParam.extend({ id: z.string().uuid() }), req.params);
  const doctor = await getDoctor(doctorId);
  assertManagesHours(ctx, doctor);
  const deleted = await db
    .delete(availabilityExceptions)
    .where(and(eq(availabilityExceptions.id, id), eq(availabilityExceptions.doctorId, doctorId)))
    .returning({ id: availabilityExceptions.id });
  if (!deleted.length) throw notFound('Not found');
  await audit({
    action: AuditAction.AVAILABILITY_CHANGED,
    actor: ctx,
    resourceType: 'availability_exception',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { doctorId, removed: true },
  });
  res.status(204).end();
});

/** Free slots of a doctor between two local dates (inclusive, at most 31 days). */
schedulingRouter.get('/slots', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(SlotsQuery, req.query);
  const doctor = await getDoctor(q.doctorId);
  await assertMaySeeSlots(ctx, doctor);
  let from = q.from;
  let to = q.to;
  if (daysBetween(from, to) < 0) throw badRequest('"to" must not be before "from"');
  if (daysBetween(from, to) > 30) throw badRequest('Ask for at most 31 days at a time');
  const isPatient = ctx.role === 'PATIENT';
  if (isPatient) {
    const tomorrow = addDays(todayLocal(), 1);
    const last = addDays(todayLocal(), PORTAL_HORIZON_DAYS);
    if (from < tomorrow) from = tomorrow;
    if (to > last) to = last;
  }
  const items =
    from > to
      ? []
      : await freeSlots(doctor.id, from, to, { portalOnly: isPatient, notBefore: new Date() });
  res.json({ doctor, from, to, items });
});

/** Patients (and guardians acting for a child) book a published slot; confirmed immediately. */
schedulingRouter.post('/book', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(BookSchema, req.body);
  if (!ctx.patientId) throw forbidden('No patient record is linked to this account');
  const patientId = ctx.patientId;
  const doctor = await getDoctor(input.doctorId);
  if (!(await patientMayBook(patientId, doctor))) {
    throw forbidden('You can book doctors of your registration facility or your care team');
  }
  const start = new Date(input.start);
  const date = localDate(start);
  if (date < addDays(todayLocal(), 1) || date > addDays(todayLocal(), PORTAL_HORIZON_DAYS)) {
    throw badRequest('Online booking is possible from tomorrow up to 60 days ahead');
  }

  const row = await db.transaction(async (tx) => {
    // One booking at a time per doctor: parallel requests for the same slot cannot both win.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`slots:${doctor.id}`}))`);
    const slots = await freeSlots(doctor.id, date, date, { portalOnly: true }, tx);
    const slot = slots.find((s) => s.start === start.toISOString());
    if (!slot) throw conflict('This time is no longer available. Please choose another slot.');

    const [mine] = await tx
      .select({ n: count() })
      .from(appointments)
      .where(
        and(
          eq(appointments.patientId, patientId),
          eq(appointments.bookedVia, 'PORTAL'),
          inArray(appointments.status, ['REQUESTED', 'CONFIRMED']),
          gte(appointments.scheduledAt, new Date()),
        ),
      );
    if ((mine?.n ?? 0) >= PORTAL_MAX_FUTURE_BOOKINGS) {
      throw conflict(
        'You already have 3 upcoming online bookings. Cancel one or call the facility to book more.',
      );
    }

    const [created] = await tx
      .insert(appointments)
      .values({
        patientId,
        doctorId: doctor.id,
        facilityId: doctor.facilityId,
        scheduledAt: start,
        durationMinutes: slot.minutes,
        reason: input.reason,
        status: 'CONFIRMED',
        bookedVia: 'PORTAL',
        mode: input.mode,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.APPOINTMENT_SELF_BOOKED,
        actor: ctx,
        resourceType: 'appointment',
        resourceId: created!.id,
        patientId,
        meta: requestMeta(req),
        metadata: ctx.proxy ? { guardianshipId: ctx.proxy.guardianshipId } : undefined,
      },
      tx,
    );
    await notifyUsers(
      [doctor.id],
      {
        type: 'appointment',
        title:
          input.mode === 'VIDEO'
            ? 'New video visit booked online for {time}'
            : 'New appointment booked online for {time}',
        vars: { time: start },
        link: '/doctor/schedule',
      },
      tx,
    );
    return created!;
  });
  res.status(201).json({ ...row, doctorName: doctor.fullName });
});
