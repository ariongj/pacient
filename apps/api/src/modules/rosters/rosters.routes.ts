import { Router } from 'express';
import { and, asc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import { auditLogs, careUnits, rosterShifts, unitStaff, users } from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { toLocale, tr } from '../../i18n/index.js';
import { addDays, daysBetween } from '../scheduling/time.js';
import {
  DEFAULT_RATIO,
  DEFAULT_TIMES,
  facilityStaffMember,
  isMonday,
  localDate,
  localMidnight,
  localTime,
  MAX_WEEK_HOURS,
  MIN_REST_HOURS,
  ON_CALL_SPECIALTIES,
  onCallBoard,
  overlapping,
  ROSTERED_ROLES,
  SHIFT_KINDS,
  shiftWindow,
  staffing,
  toIcs,
  upcomingGaps,
  weekStartOf,
  workingTimeWarnings,
  type PlannedShift,
  type ShiftKind,
  type Warning,
} from './rosters.service.js';

/**
 * Staff rosters and on-call. Directors plan, change, cancel and publish shifts for their facility;
 * everyone who works rostered shifts at the facility reads the roster, their own shifts (also as
 * an iCalendar file) and who is on call now. Publishing a week sends each rostered person ONE
 * summary notification; later changes to a published week notify only the person concerned.
 * Creating or editing shifts before publishing notifies nobody.
 */
export const rostersRouter = Router();
rostersRouter.use(authenticate);

const readers = requireRole(...ROSTERED_ROLES);
const manager = requireRole('DIRECTOR');

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const TimeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const Id = z.object({ id: z.string().uuid() });

const facilityOf = (ctx: AuthContext) => {
  if (!ctx.facilityId) throw forbidden('Rosters belong to a facility');
  return ctx.facilityId;
};

const today = () => localDate(new Date());

/** "dd.mm.yyyy" – the date format used in Albanian and Serbian alike. */
const displayDate = (date: string) => date.split('-').reverse().join('.');

const Override = {
  acknowledgedWarnings: z.array(z.enum(['REST_PERIOD', 'WEEKLY_HOURS'])).default([]),
  overrideReason: z.string().trim().min(10).max(300).optional(),
};

const ShiftInput = z
  .object({
    userId: z.string().uuid(),
    unitId: z.string().uuid().nullable().optional(),
    kind: z.enum(SHIFT_KINDS),
    specialty: z.enum(ON_CALL_SPECIALTIES).nullable().optional(),
    date: DateString,
    startTime: TimeString.optional(),
    endTime: TimeString.optional(),
    note: z.string().trim().max(300).nullable().optional(),
    ...Override,
  })
  .refine((s) => (s.kind === 'ON_CALL') === Boolean(s.specialty), {
    message: 'An on-call shift needs a specialty; other shifts have none',
    path: ['specialty'],
  });

async function assertUnit(facilityId: string, unitId: string | null | undefined) {
  if (!unitId) return null;
  const [u] = await db
    .select({ id: careUnits.id, name: careUnits.name })
    .from(careUnits)
    .where(and(eq(careUnits.id, unitId), eq(careUnits.facilityId, facilityId)));
  if (!u) throw badRequest('The unit is not part of your facility');
  return u;
}

async function assertPerson(facilityId: string, userId: string, kind: ShiftKind) {
  const person = await facilityStaffMember(facilityId, userId);
  if (!person) throw badRequest('The person is not active staff of your facility');
  if (kind === 'ON_CALL' && person.role !== 'DOCTOR') {
    throw badRequest('Only doctors are put on call');
  }
  return person;
}

function windowOrThrow(date: string, kind: ShiftKind, start?: string, end?: string) {
  const w = shiftWindow(date, kind, start, end);
  if (!w) throw badRequest('That local time does not exist (the clocks go forward)');
  return w;
}

/** Refuse unless every warning was acknowledged with a reason. */
function checkWarnings(
  warnings: (Warning & { userId?: string; date?: string })[],
  acknowledged: string[],
  reason: string | undefined,
) {
  if (!warnings.length) return;
  const open = warnings.filter((w) => !acknowledged.includes(w.code));
  if (open.length || !reason) {
    throw new HttpError(
      409,
      'WORKING_TIME_WARNINGS',
      'The shift breaks the working-time rules. Confirm with a reason to continue.',
      warnings.map((w) => ({
        code: w.code,
        hours: w.hours,
        limit: w.code === 'REST_PERIOD' ? MIN_REST_HOURS : MAX_WEEK_HOURS,
        userId: w.userId,
        date: w.date,
      })),
    );
  }
}

/** Serialise per person so two directors cannot double-book someone. */
const lockPeople = async (tx: Executor, userIds: string[]) => {
  for (const id of [...new Set(userIds)].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'roster:' + id}))`);
  }
};

async function weekPublished(facilityId: string, weekStart: string, unitId: string | null) {
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, AuditAction.ROSTER_CHANGED),
        eq(auditLogs.actorFacilityId, facilityId),
        sql`${auditLogs.metadata}->>'event' = 'PUBLISHED'`,
        sql`${auditLogs.metadata}->>'weekStart' = ${weekStart}`,
        sql`(${auditLogs.metadata}->>'unitId' IS NULL OR ${auditLogs.metadata}->>'unitId' = ${unitId ?? ''})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function notifyChange(
  facilityId: string,
  row: { userId: string; unitId: string | null; startsAt: Date },
  cancelled: boolean,
  tx: Executor,
) {
  const date = localDate(row.startsAt);
  if (!(await weekPublished(facilityId, weekStartOf(date), row.unitId))) return;
  await notifyUsers(
    [row.userId],
    {
      type: 'roster',
      title: cancelled ? 'Your shift on {date} was cancelled' : 'Your shift on {date} was changed',
      vars: { date: displayDate(date) },
      link: `/rosters?week=${weekStartOf(date)}`,
    },
    tx,
  );
}

const shiftColumns = {
  id: rosterShifts.id,
  userId: rosterShifts.userId,
  userName: users.fullName,
  userRole: users.role,
  unitId: rosterShifts.unitId,
  unitName: careUnits.name,
  kind: rosterShifts.kind,
  specialty: rosterShifts.specialty,
  startsAt: rosterShifts.startsAt,
  endsAt: rosterShifts.endsAt,
  status: rosterShifts.status,
  note: rosterShifts.note,
};

const present = (r: { startsAt: Date; endsAt: Date; [k: string]: unknown }) => ({
  ...r,
  date: localDate(r.startsAt),
  startTime: localTime(r.startsAt),
  endTime: localTime(r.endsAt),
  hours: Math.round(((r.endsAt.getTime() - r.startsAt.getTime()) / 3_600_000) * 10) / 10,
});

/* ------------------------------------------------------------------ reading -------------- */

rostersRouter.get('/meta', readers, (req, res) => {
  const ctx = requireAuth(req);
  res.json({
    kinds: SHIFT_KINDS,
    defaultTimes: DEFAULT_TIMES,
    specialties: ON_CALL_SPECIALTIES,
    rules: { minRestHours: MIN_REST_HOURS, maxWeekHours: MAX_WEEK_HOURS },
    defaultRatio: DEFAULT_RATIO,
    today: today(),
    canManage: ctx.role === 'DIRECTOR',
  });
});

/** Staff the director can roster, with their units. */
rostersRouter.get('/staff', manager, async (req, res) => {
  const facilityId = facilityOf(requireAuth(req));
  const people = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      role: users.role,
      specialty: users.specialty,
    })
    .from(users)
    .where(
      and(
        eq(users.facilityId, facilityId),
        eq(users.isActive, true),
        inArray(users.role, [...ROSTERED_ROLES]),
      ),
    )
    .orderBy(asc(users.role), asc(users.fullName));
  const memberships = people.length
    ? await db
        .select({ userId: unitStaff.userId, unitId: unitStaff.unitId })
        .from(unitStaff)
        .where(
          inArray(
            unitStaff.userId,
            people.map((p) => p.id),
          ),
        )
    : [];
  const units = await db
    .select({ id: careUnits.id, name: careUnits.name, type: careUnits.type })
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.isActive, true)))
    .orderBy(asc(careUnits.name));
  res.json({
    staff: people.map((p) => ({
      ...p,
      unitIds: memberships.filter((m) => m.userId === p.id).map((m) => m.unitId),
    })),
    units,
  });
});

const WeekQuery = z.object({
  start: DateString.optional(),
  unitId: z.string().uuid().optional(),
});

/** The facility's roster for one week (Monday–Sunday), optionally for one unit. */
rostersRouter.get('/week', readers, async (req, res) => {
  const facilityId = facilityOf(requireAuth(req));
  const q = parse(WeekQuery, req.query);
  const start = weekStartOf(q.start ?? today());
  const from = localMidnight(start);
  const to = localMidnight(addDays(start, 7));
  const rows = await db
    .select(shiftColumns)
    .from(rosterShifts)
    .innerJoin(users, eq(users.id, rosterShifts.userId))
    .leftJoin(careUnits, eq(careUnits.id, rosterShifts.unitId))
    .where(
      and(
        eq(rosterShifts.facilityId, facilityId),
        gte(rosterShifts.startsAt, from),
        lt(rosterShifts.startsAt, to),
        q.unitId ? eq(rosterShifts.unitId, q.unitId) : undefined,
      ),
    )
    .orderBy(asc(rosterShifts.startsAt), asc(users.fullName));
  const units = await db
    .select({ id: careUnits.id, name: careUnits.name, type: careUnits.type })
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.isActive, true)))
    .orderBy(asc(careUnits.name));
  const publications = await db
    .select({ at: auditLogs.occurredAt, metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, AuditAction.ROSTER_CHANGED),
        eq(auditLogs.actorFacilityId, facilityId),
        sql`${auditLogs.metadata}->>'event' = 'PUBLISHED'`,
        sql`${auditLogs.metadata}->>'weekStart' = ${start}`,
      ),
    )
    .orderBy(asc(auditLogs.occurredAt));
  res.json({
    start,
    days: Array.from({ length: 7 }, (_, i) => addDays(start, i)),
    units,
    shifts: rows.map(present),
    publications: publications.map((p) => ({
      at: p.at,
      unitId: (p.metadata?.unitId as string | null | undefined) ?? null,
    })),
  });
});

const MineQuery = z.object({ from: DateString.optional(), to: DateString.optional() });

/** My shifts (default: from 7 days ago to 6 weeks ahead). */
rostersRouter.get('/mine', readers, async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(MineQuery, req.query);
  const fromDate = q.from ?? addDays(today(), -7);
  const toDate = q.to ?? addDays(today(), 42);
  if (daysBetween(fromDate, toDate) < 0 || daysBetween(fromDate, toDate) > 400) {
    throw badRequest('Choose a range of at most 400 days');
  }
  const rows = await db
    .select(shiftColumns)
    .from(rosterShifts)
    .innerJoin(users, eq(users.id, rosterShifts.userId))
    .leftJoin(careUnits, eq(careUnits.id, rosterShifts.unitId))
    .where(
      and(
        eq(rosterShifts.userId, ctx.userId),
        gt(rosterShifts.endsAt, localMidnight(fromDate)),
        lt(rosterShifts.startsAt, localMidnight(addDays(toDate, 1))),
      ),
    )
    .orderBy(asc(rosterShifts.startsAt));
  res.json({ from: fromDate, to: toDate, items: rows.map(present) });
});

const KIND_SUMMARY: Record<ShiftKind, string> = {
  DAY: 'Day shift',
  LATE: 'Late shift',
  NIGHT: 'Night shift',
  ON_CALL: 'On call',
};

/** My shifts as an iCalendar file (authenticated download, not a public feed URL). */
rostersRouter.get('/mine.ics', readers, async (req, res) => {
  const ctx = requireAuth(req);
  const [me] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, ctx.userId));
  const locale = toLocale(me?.locale);
  const rows = await db
    .select(shiftColumns)
    .from(rosterShifts)
    .innerJoin(users, eq(users.id, rosterShifts.userId))
    .leftJoin(careUnits, eq(careUnits.id, rosterShifts.unitId))
    .where(
      and(
        eq(rosterShifts.userId, ctx.userId),
        gt(rosterShifts.endsAt, localMidnight(addDays(today(), -30))),
        lt(rosterShifts.startsAt, localMidnight(addDays(today(), 120))),
      ),
    )
    .orderBy(asc(rosterShifts.startsAt));
  const body = toIcs(
    rows.map((r) => ({
      id: r.id,
      summary: tr(locale, KIND_SUMMARY[r.kind as ShiftKind]),
      location: r.unitName,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      cancelled: r.status === 'CANCELLED',
    })),
  );
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pacient-shifts.ics"');
  res.setHeader('Cache-Control', 'no-store');
  res.send(body);
});

/** Who is on call now and next, per specialty – for nurses at night. */
rostersRouter.get('/on-call', readers, async (req, res) => {
  const facilityId = facilityOf(requireAuth(req));
  res.json({ at: new Date(), items: await onCallBoard(facilityId) });
});

const StaffingQuery = z.object({
  date: DateString.optional(),
  ratioGeneral: z.coerce.number().min(1).max(30).optional(),
  ratioIntensive: z.coerce.number().min(0.5).max(10).optional(),
});

/** Nurses rostered per ward and shift against occupied beds, and gaps in the next 7 days. */
rostersRouter.get('/staffing', manager, async (req, res) => {
  const facilityId = facilityOf(requireAuth(req));
  const q = parse(StaffingQuery, req.query);
  const date = q.date ?? today();
  const ratio = {
    general: q.ratioGeneral ?? DEFAULT_RATIO.general,
    intensive: q.ratioIntensive ?? DEFAULT_RATIO.intensive,
  };
  const [wards, gaps] = await Promise.all([
    staffing(facilityId, date, ratio),
    upcomingGaps(facilityId, today(), 7),
  ]);
  res.json({ date, ratio, wards, gaps });
});

/* ------------------------------------------------------------------ changing ------------- */

rostersRouter.post('/shifts', manager, async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const input = parse(ShiftInput, req.body);
  await assertPerson(facilityId, input.userId, input.kind);
  await assertUnit(facilityId, input.unitId);
  const w = windowOrThrow(input.date, input.kind, input.startTime, input.endTime);
  const created = await db.transaction(async (tx) => {
    await lockPeople(tx, [input.userId]);
    if ((await overlapping(tx, input.userId, w.startsAt, w.endsAt)).length) {
      throw conflict('The person already has a shift at that time');
    }
    const warnings = await workingTimeWarnings(tx, {
      userId: input.userId,
      kind: input.kind,
      ...w,
    });
    checkWarnings(warnings, input.acknowledgedWarnings, input.overrideReason);
    const [row] = await tx
      .insert(rosterShifts)
      .values({
        facilityId,
        unitId: input.unitId ?? null,
        userId: input.userId,
        kind: input.kind,
        specialty: input.specialty ?? null,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        note: input.note ?? null,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.ROSTER_CHANGED,
        actor: ctx,
        resourceType: 'roster_shift',
        resourceId: row!.id,
        meta: requestMeta(req),
        metadata: {
          event: 'CREATED',
          userId: input.userId,
          kind: input.kind,
          date: input.date,
          ...(warnings.length
            ? { warnings: warnings.map((x) => x.code), overrideReason: input.overrideReason }
            : {}),
        },
      },
      tx,
    );
    await notifyChange(facilityId, row!, false, tx);
    return row!;
  });
  res.status(201).json(present(created));
});

const ShiftPatch = z
  .object({
    unitId: z.string().uuid().nullable().optional(),
    kind: z.enum(SHIFT_KINDS).optional(),
    specialty: z.enum(ON_CALL_SPECIALTIES).nullable().optional(),
    date: DateString.optional(),
    startTime: TimeString.optional(),
    endTime: TimeString.optional(),
    note: z.string().trim().max(300).nullable().optional(),
    ...Override,
  })
  .strict();

async function loadShift(facilityId: string, id: string) {
  const [row] = await db
    .select()
    .from(rosterShifts)
    .where(and(eq(rosterShifts.id, id), eq(rosterShifts.facilityId, facilityId)));
  if (!row) throw notFound('Shift not found');
  return row;
}

rostersRouter.patch('/shifts/:id', manager, async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const { id } = parse(Id, req.params);
  const input = parse(ShiftPatch, req.body);
  const row = await loadShift(facilityId, id);
  if (row.status === 'CANCELLED') throw conflict('A cancelled shift cannot be changed');
  const kind = input.kind ?? (row.kind as ShiftKind);
  const specialty = input.specialty !== undefined ? input.specialty : row.specialty;
  if ((kind === 'ON_CALL') !== Boolean(specialty)) {
    throw badRequest('An on-call shift needs a specialty; other shifts have none');
  }
  await assertPerson(facilityId, row.userId, kind);
  const unitId = input.unitId !== undefined ? input.unitId : row.unitId;
  await assertUnit(facilityId, unitId);
  const w = windowOrThrow(
    input.date ?? localDate(row.startsAt),
    kind,
    input.startTime ?? (input.kind ? undefined : localTime(row.startsAt)),
    input.endTime ?? (input.kind ? undefined : localTime(row.endsAt)),
  );
  const updated = await db.transaction(async (tx) => {
    await lockPeople(tx, [row.userId]);
    if ((await overlapping(tx, row.userId, w.startsAt, w.endsAt, [id])).length) {
      throw conflict('The person already has a shift at that time');
    }
    const warnings = await workingTimeWarnings(
      tx,
      { userId: row.userId, kind, ...w },
      { excludeIds: [id] },
    );
    checkWarnings(warnings, input.acknowledgedWarnings, input.overrideReason);
    const [u] = await tx
      .update(rosterShifts)
      .set({
        unitId: unitId ?? null,
        kind,
        specialty: specialty ?? null,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        ...(input.note !== undefined ? { note: input.note } : {}),
      })
      .where(eq(rosterShifts.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.ROSTER_CHANGED,
        actor: ctx,
        resourceType: 'roster_shift',
        resourceId: id,
        meta: requestMeta(req),
        metadata: {
          event: 'UPDATED',
          userId: row.userId,
          from: { kind: row.kind, startsAt: row.startsAt, endsAt: row.endsAt },
          to: { kind, startsAt: w.startsAt, endsAt: w.endsAt },
          ...(warnings.length
            ? { warnings: warnings.map((x) => x.code), overrideReason: input.overrideReason }
            : {}),
        },
      },
      tx,
    );
    await notifyChange(facilityId, u!, false, tx);
    return u!;
  });
  res.json(present(updated));
});

const CancelInput = z.object({ reason: z.string().trim().min(3).max(300) });

rostersRouter.post('/shifts/:id/cancel', manager, async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const { id } = parse(Id, req.params);
  const { reason } = parse(CancelInput, req.body);
  const row = await loadShift(facilityId, id);
  if (row.status === 'CANCELLED') throw conflict('The shift is already cancelled');
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(rosterShifts)
      .set({ status: 'CANCELLED' })
      .where(and(eq(rosterShifts.id, id), eq(rosterShifts.status, 'PLANNED')))
      .returning();
    if (!u) throw conflict('The shift is already cancelled');
    await audit(
      {
        action: AuditAction.ROSTER_CHANGED,
        actor: ctx,
        resourceType: 'roster_shift',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { event: 'CANCELLED', userId: row.userId, reason },
      },
      tx,
    );
    await notifyChange(facilityId, u, true, tx);
    return u;
  });
  res.json(present(updated));
});

const BulkInput = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('PATTERN'),
    userId: z.string().uuid(),
    unitId: z.string().uuid().nullable().optional(),
    weekStart: DateString,
    /** Monday … Sunday; null = day off. */
    pattern: z.array(z.enum(SHIFT_KINDS).nullable()).length(7),
    specialty: z.enum(ON_CALL_SPECIALTIES).nullable().optional(),
    ...Override,
  }),
  z.object({
    mode: z.literal('COPY'),
    fromWeekStart: DateString,
    weekStart: DateString,
    unitId: z.string().uuid().nullable().optional(),
    ...Override,
  }),
]);

/**
 * Create a week at once: one person's pattern (e.g. D D L L N N –) or a copy of another week's
 * planned shifts (whole facility or one unit). All or nothing: overlaps are refused with the list,
 * working-time warnings need one confirmation with a reason for the whole batch.
 */
rostersRouter.post('/bulk', manager, async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const input = parse(BulkInput, req.body);
  if (!isMonday(input.weekStart)) throw badRequest('A week starts on a Monday');
  type Draft = PlannedShift & {
    unitId: string | null;
    specialty: string | null;
    note: string | null;
    date: string;
  };
  const drafts: Draft[] = [];
  if (input.mode === 'PATTERN') {
    for (const kind of input.pattern) {
      if (kind) await assertPerson(facilityId, input.userId, kind);
    }
    if (input.pattern.includes('ON_CALL') && !input.specialty) {
      throw badRequest('An on-call shift needs a specialty; other shifts have none');
    }
    await assertUnit(facilityId, input.unitId);
    input.pattern.forEach((kind, i) => {
      if (!kind) return;
      const date = addDays(input.weekStart, i);
      drafts.push({
        userId: input.userId,
        kind,
        ...windowOrThrow(date, kind),
        unitId: input.unitId ?? null,
        specialty: kind === 'ON_CALL' ? (input.specialty ?? null) : null,
        note: null,
        date,
      });
    });
  } else {
    if (!isMonday(input.fromWeekStart)) throw badRequest('A week starts on a Monday');
    await assertUnit(facilityId, input.unitId);
    const shiftBy = daysBetween(input.fromWeekStart, input.weekStart);
    const source = await db
      .select()
      .from(rosterShifts)
      .innerJoin(users, eq(users.id, rosterShifts.userId))
      .where(
        and(
          eq(rosterShifts.facilityId, facilityId),
          eq(rosterShifts.status, 'PLANNED'),
          eq(users.isActive, true),
          gte(rosterShifts.startsAt, localMidnight(input.fromWeekStart)),
          lt(rosterShifts.startsAt, localMidnight(addDays(input.fromWeekStart, 7))),
          input.unitId ? eq(rosterShifts.unitId, input.unitId) : undefined,
        ),
      );
    for (const { roster_shifts: s } of source) {
      const date = addDays(localDate(s.startsAt), shiftBy);
      drafts.push({
        userId: s.userId,
        kind: s.kind as ShiftKind,
        ...windowOrThrow(date, s.kind as ShiftKind, localTime(s.startsAt), localTime(s.endsAt)),
        unitId: s.unitId,
        specialty: s.specialty,
        note: s.note,
        date,
      });
    }
  }
  if (!drafts.length) throw badRequest('Nothing to create');

  const created = await db.transaction(async (tx) => {
    await lockPeople(
      tx,
      drafts.map((d) => d.userId),
    );
    const clashes: { userId: string; date: string }[] = [];
    for (const d of drafts) {
      const stored = await overlapping(tx, d.userId, d.startsAt, d.endsAt);
      const inBatch = drafts.some(
        (o) => o !== d && o.userId === d.userId && o.startsAt < d.endsAt && o.endsAt > d.startsAt,
      );
      if (stored.length || inBatch) clashes.push({ userId: d.userId, date: d.date });
    }
    if (clashes.length) {
      throw new HttpError(
        409,
        'SHIFT_OVERLAP',
        'Some people already have shifts at those times',
        clashes,
      );
    }
    const warnings: (Warning & { userId: string; date: string })[] = [];
    for (const d of drafts) {
      for (const w of await workingTimeWarnings(tx, d, { pending: drafts })) {
        warnings.push({ ...w, userId: d.userId, date: d.date });
      }
    }
    checkWarnings(warnings, input.acknowledgedWarnings, input.overrideReason);
    const rows = await tx
      .insert(rosterShifts)
      .values(
        drafts.map((d) => ({
          facilityId,
          unitId: d.unitId,
          userId: d.userId,
          kind: d.kind,
          specialty: d.specialty,
          startsAt: d.startsAt,
          endsAt: d.endsAt,
          note: d.note,
          createdById: ctx.userId,
        })),
      )
      .returning();
    await audit(
      {
        action: AuditAction.ROSTER_CHANGED,
        actor: ctx,
        resourceType: 'roster_shift',
        meta: requestMeta(req),
        metadata: {
          event: 'BULK',
          mode: input.mode,
          weekStart: input.weekStart,
          created: rows.length,
          ...(warnings.length
            ? { warnings: warnings.map((x) => x.code), overrideReason: input.overrideReason }
            : {}),
        },
      },
      tx,
    );
    return rows;
  });
  res.status(201).json({ created: created.length, items: created.map(present) });
});

const PublishInput = z.object({
  weekStart: DateString,
  unitId: z.string().uuid().nullable().optional(),
});

/** Publish a week: every rostered person gets ONE summary notification of their shifts. */
rostersRouter.post('/publish', manager, async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = facilityOf(ctx);
  const input = parse(PublishInput, req.body);
  if (!isMonday(input.weekStart)) throw badRequest('A week starts on a Monday');
  await assertUnit(facilityId, input.unitId);
  const perPerson = await db
    .select({ userId: rosterShifts.userId, n: sql<number>`count(*)::int` })
    .from(rosterShifts)
    .where(
      and(
        eq(rosterShifts.facilityId, facilityId),
        eq(rosterShifts.status, 'PLANNED'),
        gte(rosterShifts.startsAt, localMidnight(input.weekStart)),
        lt(rosterShifts.startsAt, localMidnight(addDays(input.weekStart, 7))),
        input.unitId ? eq(rosterShifts.unitId, input.unitId) : undefined,
      ),
    )
    .groupBy(rosterShifts.userId);
  if (!perPerson.length) throw badRequest('There are no shifts to publish in that week');
  await db.transaction(async (tx) => {
    for (const p of perPerson) {
      await notifyUsers(
        [p.userId],
        {
          type: 'roster',
          title: 'Your roster for the week of {date} is published: {count} shifts',
          vars: { date: displayDate(input.weekStart), count: p.n },
          link: `/rosters?week=${input.weekStart}`,
        },
        tx,
      );
    }
    await audit(
      {
        action: AuditAction.ROSTER_CHANGED,
        actor: ctx,
        resourceType: 'roster_week',
        meta: requestMeta(req),
        metadata: {
          event: 'PUBLISHED',
          weekStart: input.weekStart,
          unitId: input.unitId ?? null,
          people: perPerson.length,
          shifts: perPerson.reduce((s, p) => s + p.n, 0),
        },
      },
      tx,
    );
  });
  res.json({
    weekStart: input.weekStart,
    notified: perPerson.length,
    shifts: perPerson.reduce((s, p) => s + p.n, 0),
  });
});
