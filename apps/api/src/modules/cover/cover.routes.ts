import { Router } from 'express';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  coverArrangements,
  labResults,
  patients,
  resultEscalations,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { ESCALATION_LEVELS } from './escalation.js';

const MAX_DAYS = 60;
const absent = alias(users, 'absent_doctor');
const cover = alias(users, 'cover_doctor');

const CreateSchema = z.object({
  coverDoctorId: z.string().uuid(),
  doctorId: z.string().uuid().optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  note: z.string().trim().max(300).optional(),
});

const fmt = (d: Date) =>
  d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Belgrade',
  });

const arrangementColumns = {
  id: coverArrangements.id,
  doctorId: coverArrangements.doctorId,
  doctorName: absent.fullName,
  coverDoctorId: coverArrangements.coverDoctorId,
  coverDoctorName: cover.fullName,
  startsAt: coverArrangements.startsAt,
  endsAt: coverArrangements.endsAt,
  note: coverArrangements.note,
  cancelledAt: coverArrangements.cancelledAt,
  createdById: coverArrangements.createdById,
  createdAt: coverArrangements.createdAt,
};

function listArrangements(where: ReturnType<typeof and>) {
  return db
    .select(arrangementColumns)
    .from(coverArrangements)
    .innerJoin(absent, eq(absent.id, coverArrangements.doctorId))
    .innerJoin(cover, eq(cover.id, coverArrangements.coverDoctorId))
    .where(where)
    .orderBy(asc(coverArrangements.startsAt))
    .limit(200);
}

/**
 * Result cover while a doctor is away. Doctors arrange their own cover; directors can arrange it
 * for any doctor of their facility. The cover doctor gets the absent doctor's result
 * notifications, sees their unreviewed results and may review them for their patients.
 */
export const coverRouter = Router();
coverRouter.use(authenticate, requireRole('DOCTOR', 'DIRECTOR'));

coverRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  // Current, upcoming and the last two weeks (including cancelled, for context).
  const recent = or(
    gt(coverArrangements.endsAt, sql`now() - interval '14 days'`),
    gt(coverArrangements.createdAt, sql`now() - interval '14 days'`),
  );
  if (ctx.role === 'DIRECTOR') {
    const items = await listArrangements(
      and(eq(coverArrangements.facilityId, ctx.facilityId!), recent),
    );
    res.json({ items });
    return;
  }
  const [mine, coveringFor] = await Promise.all([
    listArrangements(and(eq(coverArrangements.doctorId, ctx.userId), recent)),
    listArrangements(and(eq(coverArrangements.coverDoctorId, ctx.userId), recent)),
  ]);
  res.json({ mine, coveringFor });
});

/** Doctors at my facility who can cover (or be covered, for directors). */
coverRouter.get('/colleagues', async (req, res) => {
  const ctx = requireAuth(req);
  const items = await db
    .select({ id: users.id, fullName: users.fullName, specialty: users.specialty })
    .from(users)
    .where(
      and(
        eq(users.facilityId, ctx.facilityId!),
        eq(users.role, 'DOCTOR'),
        eq(users.isActive, true),
        ne(users.id, ctx.userId),
      ),
    )
    .orderBy(asc(users.fullName));
  res.json({ items });
});

coverRouter.post('/', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(CreateSchema, req.body);
  let doctorId = ctx.userId;
  if (ctx.role === 'DIRECTOR') {
    if (!input.doctorId) throw badRequest('Choose the doctor who will be away');
    doctorId = input.doctorId;
  } else if (input.doctorId && input.doctorId !== ctx.userId) {
    throw forbidden('Only a director can arrange cover for another doctor');
  }
  if (doctorId === input.coverDoctorId) throw badRequest('A doctor cannot cover for themself');
  if (input.endsAt <= input.startsAt) throw badRequest('The end must be after the start');
  if (input.endsAt <= new Date()) throw badRequest('The cover period has already ended');
  if (input.endsAt.getTime() - input.startsAt.getTime() > MAX_DAYS * 86_400_000) {
    throw badRequest(`Cover can be arranged for at most ${MAX_DAYS} days at a time`);
  }

  const people = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      role: users.role,
      facilityId: users.facilityId,
      isActive: users.isActive,
    })
    .from(users)
    .where(inArray(users.id, [doctorId, input.coverDoctorId]));
  const away = people.find((p) => p.id === doctorId);
  const coverer = people.find((p) => p.id === input.coverDoctorId);
  if (!away || away.role !== 'DOCTOR' || away.facilityId !== ctx.facilityId) {
    throw badRequest('The absent doctor must be a doctor at your facility');
  }
  if (
    !coverer ||
    coverer.role !== 'DOCTOR' ||
    !coverer.isActive ||
    coverer.facilityId !== ctx.facilityId
  ) {
    throw badRequest('The cover doctor must be an active doctor at the same facility');
  }

  const row = await db.transaction(async (tx) => {
    // Serialise arrangements for the same doctor so concurrent requests cannot overlap.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'cover:' + doctorId}))`);
    const [overlap] = await tx
      .select({ id: coverArrangements.id })
      .from(coverArrangements)
      .where(
        and(
          eq(coverArrangements.doctorId, doctorId),
          isNull(coverArrangements.cancelledAt),
          lte(coverArrangements.startsAt, input.endsAt),
          gt(coverArrangements.endsAt, input.startsAt),
        ),
      )
      .limit(1);
    if (overlap) throw conflict('Cover is already arranged for part of this period');
    const [created] = await tx
      .insert(coverArrangements)
      .values({
        doctorId,
        coverDoctorId: input.coverDoctorId,
        facilityId: ctx.facilityId!,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        note: input.note || null,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.COVER_CREATED,
        actor: ctx,
        resourceType: 'cover_arrangement',
        resourceId: created!.id,
        meta: requestMeta(req),
        metadata: { doctorId, coverDoctorId: input.coverDoctorId },
      },
      tx,
    );
    await notifyUsers(
      [input.coverDoctorId],
      {
        type: 'cover',
        title: `You are covering results for ${away.fullName} from ${fmt(input.startsAt)} to ${fmt(input.endsAt)}`,
        link: '/doctor/cover',
        important: true,
      },
      tx,
    );
    if (doctorId !== ctx.userId) {
      await notifyUsers(
        [doctorId],
        {
          type: 'cover',
          title: `${coverer.fullName} will cover your results from ${fmt(input.startsAt)} to ${fmt(input.endsAt)}`,
          link: '/doctor/cover',
        },
        tx,
      );
    }
    return created!;
  });
  res.status(201).json(row);
});

coverRouter.post('/:id/cancel', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const [row] = await db.select().from(coverArrangements).where(eq(coverArrangements.id, id));
  if (!row || row.facilityId !== ctx.facilityId) throw notFound('Cover arrangement not found');
  const allowed =
    row.doctorId === ctx.userId || row.createdById === ctx.userId || ctx.role === 'DIRECTOR';
  if (!allowed) throw forbidden('Only the absent doctor, whoever arranged it or the director');
  if (row.cancelledAt) throw conflict('This cover was already cancelled');
  if (row.endsAt <= new Date()) throw conflict('This cover has already ended');
  const [updated] = await db
    .update(coverArrangements)
    .set({ cancelledAt: new Date() })
    .where(eq(coverArrangements.id, id))
    .returning();
  await audit({
    action: AuditAction.COVER_CANCELLED,
    actor: ctx,
    resourceType: 'cover_arrangement',
    resourceId: id,
    meta: requestMeta(req),
  });
  if (row.coverDoctorId !== ctx.userId) {
    await notifyUsers([row.coverDoctorId], {
      type: 'cover',
      title: 'A cover arrangement you were part of was cancelled',
      link: '/doctor/cover',
    });
  }
  res.json(updated);
});

/**
 * Critical results at the facility still waiting for review. Directors run the facility, they do
 * not read records: no patient identity and no values – only who owns the result and how long it
 * has waited, so they can make sure someone acts.
 */
coverRouter.get('/escalations', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const orderer = alias(users, 'orderer');
  const level = sql<number>`coalesce((SELECT max(${resultEscalations.level}) FROM ${resultEscalations} WHERE ${resultEscalations.labResultId} = ${labResults.id}), 0)`;
  const rows = await db
    .select({
      id: labResults.id,
      orderingDoctorId: labResults.orderedById,
      orderingDoctor: orderer.fullName,
      createdAt: labResults.createdAt,
      level,
    })
    .from(labResults)
    .innerJoin(orderer, eq(orderer.id, labResults.orderedById))
    .innerJoin(patients, eq(patients.id, labResults.patientId))
    .where(
      and(
        eq(labResults.flag, 'CRITICAL'),
        isNull(labResults.acknowledgedAt),
        isNull(labResults.supersededById),
        or(
          eq(orderer.facilityId, ctx.facilityId!),
          eq(patients.primaryFacilityId, ctx.facilityId!),
        ),
        lte(
          labResults.createdAt,
          sql`now() - make_interval(mins => ${ESCALATION_LEVELS[0]!.afterMinutes})`,
        ),
      ),
    )
    .orderBy(asc(labResults.createdAt))
    .limit(100);
  const doctorIds = [...new Set(rows.map((r) => r.orderingDoctorId))];
  const covers = doctorIds.length
    ? await db
        .select({ doctorId: coverArrangements.doctorId, name: cover.fullName })
        .from(coverArrangements)
        .innerJoin(cover, eq(cover.id, coverArrangements.coverDoctorId))
        .where(
          and(
            inArray(coverArrangements.doctorId, doctorIds),
            isNull(coverArrangements.cancelledAt),
            lte(coverArrangements.startsAt, sql`now()`),
            gt(coverArrangements.endsAt, sql`now()`),
          ),
        )
    : [];
  const now = Date.now();
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      orderingDoctor: r.orderingDoctor,
      minutesWaiting: Math.floor((now - r.createdAt.getTime()) / 60_000),
      level: Number(r.level),
      coveredBy: covers.filter((c) => c.doctorId === r.orderingDoctorId).map((c) => c.name),
    })),
  });
});
