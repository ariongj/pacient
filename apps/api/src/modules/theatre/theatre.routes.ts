import { Router } from 'express';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import {
  admissions,
  anaesthesiaTypeEnum,
  consentRecords,
  lateralityEnum,
  patients,
  surgeryPriorityEnum,
  surgeryStatusEnum,
  surgicalCases,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { publishBoardChanges } from '../../lib/events.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  getPatientOrThrow,
  WRITERS,
  resolveAndAuditRead,
  auditRecordView,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { viewFor } from '../clinical/clinical.service.js';
import { notifyPatient, notifyUsers } from '../notifications/notifications.service.js';
import {
  attendingDoctorOf,
  CHECKLIST_STEPS,
  checklistProgress,
  isTheatreStaff,
  STEP_ORDER,
  surgeonConflict,
  theatreConflict,
  theatreStaff,
  theatreUnits,
  type Checklist,
  type ChecklistStep,
} from './theatre.service.js';

/**
 * Operating theatres: doctors request operations; theatre staff (or the surgeon) schedule them in
 * a theatre without overlaps; on the day the team works through the WHO Surgical Safety Checklist
 * (sign in → time out → sign out) and the surgeon signs the operation note, which is then
 * immutable (database trigger). Board changes are published as `hospital.board` live events.
 */
export const theatreRouter = Router();
theatreRouter.use(
  authenticate,
  publishBoardChanges('hospital.board', ['DOCTOR', 'NURSE', 'RECEPTION', 'DIRECTOR']),
);

const IdParam = z.object({ id: z.string().uuid() });
const PatientParam = z.object({ patientId: z.string().uuid() });
const reason = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500);

const surgeon = alias(users, 'surgeon');
const assistant = alias(users, 'assistant');
const anaesthetist = alias(users, 'anaesthetist');
const signer = alias(users, 'note_signer');

const CASE_COLUMNS = {
  id: surgicalCases.id,
  patientId: surgicalCases.patientId,
  facilityId: surgicalCases.facilityId,
  theatreUnitId: surgicalCases.theatreUnitId,
  admissionId: surgicalCases.admissionId,
  procedure: surgicalCases.procedure,
  procedureCode: surgicalCases.procedureCode,
  laterality: surgicalCases.laterality,
  priority: surgicalCases.priority,
  indication: surgicalCases.indication,
  primarySurgeonId: surgicalCases.primarySurgeonId,
  assistantId: surgicalCases.assistantId,
  anaesthetistId: surgicalCases.anaesthetistId,
  anaesthesiaType: surgicalCases.anaesthesiaType,
  scheduledStart: surgicalCases.scheduledStart,
  estimatedMinutes: surgicalCases.estimatedMinutes,
  status: surgicalCases.status,
  consentRecordId: surgicalCases.consentRecordId,
  checklist: surgicalCases.checklist,
  inTheatreAt: surgicalCases.inTheatreAt,
  incisionAt: surgicalCases.incisionAt,
  closureAt: surgicalCases.closureAt,
  outOfTheatreAt: surgicalCases.outOfTheatreAt,
  operationNote: surgicalCases.operationNote,
  complications: surgicalCases.complications,
  estimatedBloodLossMl: surgicalCases.estimatedBloodLossMl,
  noteSignedAt: surgicalCases.noteSignedAt,
  cancelReason: surgicalCases.cancelReason,
  createdAt: surgicalCases.createdAt,
  surgeon: surgeon.fullName,
  assistant: assistant.fullName,
  anaesthetist: anaesthetist.fullName,
  noteSignedBy: signer.fullName,
  patientFirstName: patients.firstName,
  patientLastName: patients.lastName,
  patientNationalId: patients.nationalId,
  patientDateOfBirth: patients.dateOfBirth,
  patientSex: patients.sex,
  patientTemporaryIdentity: patients.temporaryIdentity,
};

function selectCases(executor: Executor = db) {
  return executor
    .select(CASE_COLUMNS)
    .from(surgicalCases)
    .innerJoin(patients, eq(patients.id, surgicalCases.patientId))
    .innerJoin(surgeon, eq(surgeon.id, surgicalCases.primarySurgeonId))
    .leftJoin(assistant, eq(assistant.id, surgicalCases.assistantId))
    .leftJoin(anaesthetist, eq(anaesthetist.id, surgicalCases.anaesthetistId))
    .leftJoin(signer, eq(signer.id, surgicalCases.noteSignedById));
}
type CaseRow = Awaited<ReturnType<ReturnType<typeof selectCases>['where']>>[number];

/** Shapes a case for the caller: the indication and the note only for the clinical team. */
function present(r: CaseRow, clinical: boolean) {
  const checklist = (r.checklist ?? {}) as Checklist;
  const base = {
    ...r,
    checklist: clinical ? checklist : undefined,
    progress: checklistProgress(checklist),
  };
  if (clinical) return base;
  return {
    ...base,
    indication: undefined,
    operationNote: undefined,
    complications: undefined,
    estimatedBloodLossMl: undefined,
  };
}

async function loadCase(id: string, executor: Executor = db) {
  const [row] = await executor
    .select()
    .from(surgicalCases)
    .where(eq(surgicalCases.id, id))
    .for('update');
  if (!row) throw notFound('Operation not found');
  return row;
}

const teamOf = (c: {
  primarySurgeonId: string;
  assistantId: string | null;
  anaesthetistId: string | null;
}) => [c.primarySurgeonId, c.assistantId, c.anaesthetistId].filter((x): x is string => Boolean(x));

async function actorName(ctx: AuthContext, executor: Executor = db) {
  const [u] = await executor
    .select({ name: users.fullName })
    .from(users)
    .where(eq(users.id, ctx.userId));
  return { id: ctx.userId, name: u?.name ?? '' };
}

/** Theatre staff of the facility, or a member of the case's surgical team. */
async function assertTheatreTeam(
  ctx: AuthContext,
  c: typeof surgicalCases.$inferSelect,
  message: string,
  executor: Executor = db,
) {
  if (ctx.facilityId !== c.facilityId) throw forbidden(message);
  if (teamOf(c).includes(ctx.userId)) return;
  if (await isTheatreStaff(ctx.userId, c.facilityId, undefined, executor)) return;
  throw forbidden(message);
}

async function assertFacilityDoctor(
  id: string | null | undefined,
  facilityId: string,
  label: string,
  executor: Executor = db,
) {
  if (!id) return;
  const [u] = await executor
    .select({ role: users.role, facilityId: users.facilityId, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, id));
  if (!u || u.role !== 'DOCTOR' || u.facilityId !== facilityId || !u.isActive) {
    throw badRequest(`The ${label} must be an active doctor at this facility`);
  }
}

/** Granted treatment consent of this patient, or 400. */
async function assertTreatmentConsent(
  consentRecordId: string,
  patientId: string,
  executor: Executor = db,
) {
  const [c] = await executor
    .select()
    .from(consentRecords)
    .where(eq(consentRecords.id, consentRecordId));
  if (!c || c.patientId !== patientId || c.type !== 'TREATMENT' || c.decision !== 'GRANTED') {
    throw badRequest('Choose a granted treatment consent of this patient');
  }
  if (c.expiresAt && c.expiresAt < new Date()) throw badRequest('That consent has expired');
}

/* ------------------------------------------------------------------ requests ---------------- */

const CaseInput = z.object({
  patientId: z.string().uuid(),
  procedure: z.string().trim().min(3).max(300),
  procedureCode: z.string().trim().max(20).optional().nullable(),
  laterality: z.enum(lateralityEnum.enumValues, { error: 'Choose the side (or "not applicable")' }),
  priority: z.enum(surgeryPriorityEnum.enumValues).default('ELECTIVE'),
  indication: z.string().trim().min(5).max(1000),
  primarySurgeonId: z.string().uuid(),
  assistantId: z.string().uuid().optional().nullable(),
  anaesthetistId: z.string().uuid().optional().nullable(),
  anaesthesiaType: z.enum(anaesthesiaTypeEnum.enumValues).optional().nullable(),
  estimatedMinutes: z.coerce.number().int().min(5).max(1440).default(60),
  admissionId: z.string().uuid().optional().nullable(),
  consentRecordId: z.string().uuid().optional().nullable(),
});

theatreRouter.post('/cases', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(CaseInput, req.body);
  await assertClinicalWriteAccess(ctx, input.patientId, requestMeta(req), WRITERS.doctorOnly);
  await getPatientOrThrow(input.patientId);
  const facilityId = ctx.facilityId!;
  await assertFacilityDoctor(input.primarySurgeonId, facilityId, 'surgeon');
  await assertFacilityDoctor(input.assistantId, facilityId, 'assistant');
  await assertFacilityDoctor(input.anaesthetistId, facilityId, 'anaesthetist');
  if (input.consentRecordId) await assertTreatmentConsent(input.consentRecordId, input.patientId);
  let admissionId = input.admissionId ?? null;
  if (admissionId) {
    const [a] = await db
      .select({ patientId: admissions.patientId })
      .from(admissions)
      .where(eq(admissions.id, admissionId));
    if (a?.patientId !== input.patientId) {
      throw badRequest('The stay does not belong to this patient');
    }
  } else {
    admissionId = (await attendingDoctorOf(input.patientId))?.admissionId ?? null;
  }

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(surgicalCases)
      .values({
        patientId: input.patientId,
        facilityId,
        admissionId,
        procedure: input.procedure,
        procedureCode: input.procedureCode ?? null,
        laterality: input.laterality,
        priority: input.priority,
        indication: input.indication,
        primarySurgeonId: input.primarySurgeonId,
        assistantId: input.assistantId ?? null,
        anaesthetistId: input.anaesthetistId ?? null,
        anaesthesiaType: input.anaesthesiaType ?? null,
        estimatedMinutes: input.estimatedMinutes,
        consentRecordId: input.consentRecordId ?? null,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.SURGERY_REQUESTED,
        actor: ctx,
        resourceType: 'surgical_case',
        resourceId: row!.id,
        patientId: input.patientId,
        meta: requestMeta(req),
        metadata: { priority: input.priority, laterality: input.laterality },
      },
      tx,
    );
    const team = teamOf(row!).filter((id) => id !== ctx.userId);
    const staff = input.priority === 'ELECTIVE' ? [] : await theatreStaff(facilityId, {}, tx);
    await notifyUsers(
      [...team, ...staff],
      {
        type: 'theatre',
        title:
          input.priority === 'EMERGENCY'
            ? 'Emergency operation requested – theatre needed now'
            : input.priority === 'URGENT'
              ? 'Urgent operation requested'
              : 'You were added to an operation request',
        link: '/theatre',
        important: input.priority === 'EMERGENCY',
      },
      tx,
    );
    return row!;
  });
  res.status(201).json(created);
});

/* ------------------------------------------------------------------ scheduling -------------- */

const ScheduleInput = z.object({
  theatreUnitId: z.string().uuid(),
  scheduledStart: z.coerce.date(),
  estimatedMinutes: z.coerce.number().int().min(5).max(1440).optional(),
  consentWaiverReason: z.string().trim().min(10).max(500).optional(),
  force: z.boolean().optional(),
  forceReason: z.string().trim().min(5).max(500).optional(),
});

theatreRouter.post('/cases/:id/schedule', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(ScheduleInput, req.body);
  const result = await db.transaction(async (tx) => {
    const c = await loadCase(id, tx);
    if (ctx.facilityId !== c.facilityId)
      throw forbidden('Operations are scheduled by their facility');
    const isSurgeon = c.primarySurgeonId === ctx.userId;
    if (!isSurgeon && !(await isTheatreStaff(ctx.userId, c.facilityId, undefined, tx))) {
      throw forbidden('Theatre staff or the surgeon schedule operations');
    }
    if (!['REQUESTED', 'SCHEDULED', 'POSTPONED'].includes(c.status)) {
      throw conflict('Only requested, scheduled or postponed operations can be scheduled');
    }
    const theatres = await theatreUnits(c.facilityId, tx);
    if (!theatres.some((th) => th.id === input.theatreUnitId)) {
      throw badRequest('Choose an operating theatre of this facility');
    }
    const checklist = { ...((c.checklist ?? {}) as Checklist) };
    const by = await actorName(ctx, tx);
    if (!c.consentRecordId) {
      if (c.priority === 'ELECTIVE') {
        throw new HttpError(
          400,
          'CONSENT_REQUIRED',
          'An elective operation needs the patient’s recorded treatment consent before it is scheduled',
        );
      }
      if (!checklist.consentWaiver) {
        if (!input.consentWaiverReason) {
          throw new HttpError(
            400,
            'CONSENT_REQUIRED',
            'No treatment consent is recorded – give the reason the operation must go ahead',
          );
        }
        checklist.consentWaiver = {
          reason: input.consentWaiverReason,
          by,
          at: new Date().toISOString(),
        };
      }
    }
    const minutes = input.estimatedMinutes ?? c.estimatedMinutes;
    // Serialise bookings per theatre so two schedulers cannot take the same slot.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.theatreUnitId}))`);
    const clash = await theatreConflict(input.theatreUnitId, input.scheduledStart, minutes, id, tx);
    if (clash) {
      throw new HttpError(409, 'THEATRE_BOOKED', 'The theatre is already booked at that time', {
        caseId: clash.id,
        procedure: clash.procedure,
        scheduledStart: clash.scheduled_start,
      });
    }
    for (const doctor of [c.primarySurgeonId, c.assistantId].filter((x): x is string => !!x)) {
      const busy = await surgeonConflict(doctor, input.scheduledStart, minutes, id, tx);
      if (busy && !(input.force && input.forceReason)) {
        throw new HttpError(
          409,
          'SURGEON_DOUBLE_BOOKED',
          'A surgeon of this operation is already booked at that time',
          { caseId: busy.id, procedure: busy.procedure, scheduledStart: busy.scheduled_start },
        );
      }
      if (busy)
        checklist.forcedBooking = { reason: input.forceReason!, by, at: new Date().toISOString() };
    }
    const [updated] = await tx
      .update(surgicalCases)
      .set({
        status: 'SCHEDULED',
        theatreUnitId: input.theatreUnitId,
        scheduledStart: input.scheduledStart,
        estimatedMinutes: minutes,
        checklist,
      })
      .where(eq(surgicalCases.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.SURGERY_SCHEDULED,
        actor: ctx,
        resourceType: 'surgical_case',
        resourceId: id,
        patientId: c.patientId,
        meta: requestMeta(req),
        metadata: {
          theatreUnitId: input.theatreUnitId,
          scheduledStart: input.scheduledStart.toISOString(),
          consentWaived: Boolean(checklist.consentWaiver),
          forced: Boolean(checklist.forcedBooking),
        },
      },
      tx,
    );
    const attending = await attendingDoctorOf(c.patientId, tx);
    await notifyUsers(
      [...teamOf(c), attending?.id].filter((u) => u && u !== ctx.userId),
      {
        type: 'theatre',
        title: 'Operation scheduled for {date}',
        vars: { date: input.scheduledStart },
        link: '/theatre',
      },
      tx,
    );
    if (c.priority === 'ELECTIVE') {
      await notifyPatient(
        c.patientId,
        {
          type: 'appointment',
          title: 'Your operation has been scheduled for {date}',
          vars: { date: input.scheduledStart },
          link: '/portal/appointments',
        },
        tx,
      );
    }
    return updated!;
  });
  res.json(result);
});

theatreRouter.post('/cases/:id/postpone', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const body = parse(z.object({ reason }), req.body);
  res.json(await changeStatus(ctx, id, 'POSTPONED', body.reason, requestMeta(req)));
});

theatreRouter.post('/cases/:id/cancel', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const body = parse(z.object({ reason }), req.body);
  res.json(await changeStatus(ctx, id, 'CANCELLED', body.reason, requestMeta(req)));
});

async function changeStatus(
  ctx: AuthContext,
  id: string,
  status: 'POSTPONED' | 'CANCELLED',
  why: string,
  meta: ReturnType<typeof requestMeta>,
) {
  return db.transaction(async (tx) => {
    const c = await loadCase(id, tx);
    await assertTheatreTeam(
      ctx,
      c,
      'Only the surgical team or theatre staff can change this operation',
      tx,
    );
    if (!['REQUESTED', 'SCHEDULED', 'POSTPONED'].includes(c.status)) {
      throw conflict('Operations that have started or finished cannot be postponed or cancelled');
    }
    const checklist = { ...((c.checklist ?? {}) as Checklist) };
    const set: Partial<typeof surgicalCases.$inferInsert> = { status };
    if (status === 'POSTPONED') {
      checklist.postponements = [
        ...(checklist.postponements ?? []),
        { reason: why, by: await actorName(ctx, tx), at: new Date().toISOString() },
      ];
      set.checklist = checklist;
    } else {
      set.cancelReason = why;
    }
    const [updated] = await tx
      .update(surgicalCases)
      .set(set)
      .where(eq(surgicalCases.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.SURGERY_STATUS_CHANGED,
        actor: ctx,
        resourceType: 'surgical_case',
        resourceId: id,
        patientId: c.patientId,
        meta,
        metadata: { from: c.status, to: status, reason: why },
      },
      tx,
    );
    await notifyUsers(
      teamOf(c).filter((u) => u !== ctx.userId),
      {
        type: 'theatre',
        title: status === 'POSTPONED' ? 'An operation was postponed' : 'An operation was cancelled',
        link: '/theatre',
      },
      tx,
    );
    if (c.status === 'SCHEDULED' && c.priority === 'ELECTIVE') {
      await notifyPatient(
        c.patientId,
        {
          type: 'appointment',
          title:
            status === 'POSTPONED'
              ? 'Your operation has been postponed – the team will contact you'
              : 'Your operation has been cancelled – the team will contact you',
          link: '/portal/appointments',
        },
        tx,
      );
    }
    return updated!;
  });
}

/* ------------------------------------------------------------------ WHO checklist ----------- */

const STEP_ROUTES: Record<string, ChecklistStep> = {
  'sign-in': 'signIn',
  'time-out': 'timeOut',
  'sign-out': 'signOut',
};

for (const [path, step] of Object.entries(STEP_ROUTES)) {
  theatreRouter.post(`/cases/:id/${path}`, requireRole('DOCTOR', 'NURSE'), async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const answers = parse(CHECKLIST_STEPS[step], req.body);
    const updated = await db.transaction(async (tx) => {
      const c = await loadCase(id, tx);
      await assertTheatreTeam(
        ctx,
        c,
        'Only the surgical team or theatre staff complete the checklist',
        tx,
      );
      const checklist = { ...((c.checklist ?? {}) as Checklist) };
      if (checklist[step]) throw conflict('This checklist step is already complete');
      const index = STEP_ORDER.indexOf(step);
      const previous = STEP_ORDER[index - 1];
      if (previous && !checklist[previous]) {
        throw conflict('Complete the previous checklist step first');
      }
      if (step === 'signIn' && c.status !== 'SCHEDULED') {
        throw conflict('Only a scheduled operation can start');
      }
      if (step !== 'signIn' && c.status !== 'IN_THEATRE') {
        throw conflict('The patient is not in theatre');
      }
      const now = new Date();
      checklist[step] = { answers, by: await actorName(ctx, tx), at: now.toISOString() };
      const set: Partial<typeof surgicalCases.$inferInsert> = { checklist };
      if (step === 'signIn') Object.assign(set, { status: 'IN_THEATRE', inTheatreAt: now });
      if (step === 'timeOut') set.incisionAt = now;
      if (step === 'signOut') set.closureAt = now;
      const [row] = await tx
        .update(surgicalCases)
        .set(set)
        .where(eq(surgicalCases.id, id))
        .returning();
      await audit(
        {
          action: AuditAction.SURGERY_CHECKLIST_COMPLETED,
          actor: ctx,
          resourceType: 'surgical_case',
          resourceId: id,
          patientId: c.patientId,
          meta: requestMeta(req),
          metadata: { step },
        },
        tx,
      );
      return row!;
    });
    res.json(updated);
  });
}

const CompleteInput = z.object({
  operationNote: z.string().trim().min(20, 'Write the operation note').max(20_000),
  complications: z.string().trim().max(2000).optional().nullable(),
  estimatedBloodLossMl: z.coerce.number().int().min(0).max(20_000).optional().nullable(),
});

theatreRouter.post('/cases/:id/complete', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(CompleteInput, req.body);
  const updated = await db.transaction(async (tx) => {
    const c = await loadCase(id, tx);
    if (ctx.userId !== c.primarySurgeonId && ctx.userId !== c.assistantId) {
      throw forbidden('Only the operating surgeons sign the operation note');
    }
    if (c.status !== 'IN_THEATRE') throw conflict('The patient is not in theatre');
    if (!(c.checklist as Checklist | null)?.signOut) {
      throw conflict('Complete the sign-out step of the checklist first');
    }
    const now = new Date();
    const [row] = await tx
      .update(surgicalCases)
      .set({
        status: 'COMPLETED',
        outOfTheatreAt: now,
        operationNote: input.operationNote,
        complications: input.complications ?? null,
        estimatedBloodLossMl: input.estimatedBloodLossMl ?? null,
        noteSignedById: ctx.userId,
        noteSignedAt: now,
      })
      .where(eq(surgicalCases.id, id))
      .returning();
    for (const action of [AuditAction.OPERATION_NOTE_SIGNED, AuditAction.SURGERY_STATUS_CHANGED]) {
      await audit(
        {
          action,
          actor: ctx,
          resourceType: 'surgical_case',
          resourceId: id,
          patientId: c.patientId,
          meta: requestMeta(req),
          metadata: { from: c.status, to: 'COMPLETED' },
        },
        tx,
      );
    }
    const attending = await attendingDoctorOf(c.patientId, tx);
    await notifyUsers(
      [attending?.id, c.primarySurgeonId].filter((u) => u && u !== ctx.userId),
      {
        type: 'theatre',
        title: 'Operation completed – the operation note is signed',
        link: `/doctor/patients/${c.patientId}?tab=surgery`,
      },
      tx,
    );
    return row!;
  });
  res.json(updated);
});

/* ------------------------------------------------------------------ reads ------------------- */

const STAFF_ROLES = ['DOCTOR', 'NURSE', 'RECEPTION', 'DIRECTOR'] as const;

theatreRouter.get('/theatres', requireRole(...STAFF_ROLES), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const units = await theatreUnits(ctx.facilityId);
  res.json({
    items: units,
    isTheatreStaff: await isTheatreStaff(ctx.userId, ctx.facilityId),
  });
});

/** Doctors of my facility, for the surgical team selects. */
theatreRouter.get('/doctors', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const rows = await db
    .select({ id: users.id, fullName: users.fullName, specialty: users.specialty })
    .from(users)
    .where(
      and(
        eq(users.facilityId, ctx.facilityId!),
        eq(users.role, 'DOCTOR'),
        eq(users.isActive, true),
      ),
    )
    .orderBy(asc(users.fullName));
  res.json({ items: rows });
});

/** Can this user see clinical details (indication, note) of cases at the facility's theatres? */
async function seesClinical(ctx: AuthContext) {
  if (ctx.role !== 'DOCTOR' && ctx.role !== 'NURSE') return () => false;
  const staff = await isTheatreStaff(ctx.userId, ctx.facilityId);
  return (r: CaseRow) => staff || teamOf(r).includes(ctx.userId);
}

const ScheduleQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  theatreUnitId: z.string().uuid().optional(),
});

/** One day's list per theatre (Kosovo time). */
theatreRouter.get('/schedule', requireRole(...STAFF_ROLES), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const q = parse(ScheduleQuery, req.query);
  const date =
    q.date ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(new Date());
  const filters: SQL[] = [
    eq(surgicalCases.facilityId, ctx.facilityId),
    inArray(surgicalCases.status, [
      'SCHEDULED',
      'IN_THEATRE',
      'COMPLETED',
      'POSTPONED',
      'CANCELLED',
    ]),
    sql`(${surgicalCases.scheduledStart} AT TIME ZONE 'Europe/Belgrade')::date = ${date}::date`,
  ];
  if (q.theatreUnitId) filters.push(eq(surgicalCases.theatreUnitId, q.theatreUnitId));
  const [rows, theatres, clinical] = await Promise.all([
    selectCases()
      .where(and(...filters))
      .orderBy(asc(surgicalCases.scheduledStart)),
    theatreUnits(ctx.facilityId),
    seesClinical(ctx),
  ]);
  res.json({
    date,
    theatres,
    items: rows.map((r) => present(r, clinical(r))),
    isTheatreStaff: await isTheatreStaff(ctx.userId, ctx.facilityId),
  });
});

/** Operations requested (or postponed) and not yet scheduled, most urgent first. */
theatreRouter.get('/requests', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const [rows, clinical] = await Promise.all([
    selectCases()
      .where(
        and(
          eq(surgicalCases.facilityId, ctx.facilityId!),
          inArray(surgicalCases.status, ['REQUESTED', 'POSTPONED']),
        ),
      )
      .orderBy(
        sql`CASE ${surgicalCases.priority} WHEN 'EMERGENCY' THEN 0 WHEN 'URGENT' THEN 1 ELSE 2 END`,
        asc(surgicalCases.createdAt),
      )
      .limit(200),
    seesClinical(ctx),
  ]);
  res.json({ items: rows.map((r) => present(r, clinical(r))) });
});

theatreRouter.get('/cases/:id', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const [row] = await selectCases().where(eq(surgicalCases.id, id));
  if (!row) throw notFound('Operation not found');
  const clinical = await seesClinical(ctx);
  if (!clinical(row) || row.facilityId !== ctx.facilityId) {
    await resolveAndAuditRead(ctx, row.patientId, requestMeta(req), 'operations');
  } else {
    await auditRecordView(ctx, row.patientId, 'UNIT', 'operations', requestMeta(req));
  }
  res.json(present(row, true));
});

const PatientCasesQuery = z.object({ status: z.enum(surgeryStatusEnum.enumValues).optional() });

theatreRouter.get('/patients/:patientId/cases', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const q = parse(PatientCasesQuery, req.query);
  const view = viewFor(await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'operations'));
  const filters: SQL[] = [eq(surgicalCases.patientId, patientId)];
  if (q.status) filters.push(eq(surgicalCases.status, q.status));
  if (view.patientView) filters.push(inArray(surgicalCases.status, ['SCHEDULED', 'COMPLETED']));
  const rows = await selectCases()
    .where(and(...filters))
    .orderBy(desc(sql`coalesce(${surgicalCases.scheduledStart}, ${surgicalCases.createdAt})`))
    .limit(200);
  const items = view.patientView
    ? rows.map((r) => ({
        id: r.id,
        procedure: r.procedure,
        laterality: r.laterality,
        status: r.status,
        scheduledStart: r.scheduledStart,
        outOfTheatreAt: r.outOfTheatreAt,
        surgeon: r.surgeon,
      }))
    : rows.map((r) => present(r, true));
  res.json({ items });
});
