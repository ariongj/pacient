import { Router } from 'express';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  careAssignments,
  careProcessRecords,
  diagnoses,
  facilities,
  patients,
  registerEnrolments,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { paginated, PaginationSchema } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { assertClinicalWriteAccess, resolveAndAuditRead, WRITERS } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  DUE_SOON_DAYS,
  NEW_ENROLMENT_GRACE_DAYS,
  RECALL_INTERVAL_DAYS,
  recordProcess,
  REGISTER_CODES,
  REGISTERS,
  registersForIcd10,
  TARGETS,
  type RegisterCode,
} from './definitions.js';
import { evaluateRegister, type ProcessState } from './evaluate.js';
import { computeIndicators } from './indicators.js';
import { activeEnrolments, enrolPatient, loadPatientData } from './registers.service.js';

/**
 * Chronic disease registers: the patient's registers and review status (care team), manual
 * enrolment and leaving (doctors), recording review items (doctors and nurses), recall lists for
 * the patients in one's care, and aggregate quality indicators for directors (own facility) and
 * the Ministry (national, with small-cell suppression).
 */
export const registersRouter = Router();
registersRouter.use(authenticate);

const RegisterEnum = z.enum(REGISTER_CODES);
const PatientParam = z.object({ patientId: z.string().uuid() });

/* -------------------------------------------------------------------------- definitions -- */

registersRouter.get('/definitions', (_req, res) => {
  res.json({
    registers: REGISTER_CODES.map((code) => {
      const r = REGISTERS[code];
      return {
        code,
        label: r.label,
        icd10Prefixes: r.icd10Prefixes,
        processes: r.processes.map((p) => ({
          code: p.code,
          label: p.label,
          intervalDays: p.intervalDays,
          source: p.source.kind,
          results: p.results ?? null,
          target: p.target ? { code: p.target, ...TARGETS[p.target] } : null,
        })),
      };
    }),
    rules: {
      dueSoonDays: DUE_SOON_DAYS,
      newEnrolmentGraceDays: NEW_ENROLMENT_GRACE_DAYS,
      recallIntervalDays: RECALL_INTERVAL_DAYS,
    },
    disclaimer:
      'Intervals and targets are placeholders until confirmed by the national clinical guidelines.',
  });
});

/* ---------------------------------------------------------------------- patient view -- */

registersRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'registers');

  const enrolments = await db
    .select({
      id: registerEnrolments.id,
      register: registerEnrolments.register,
      status: registerEnrolments.status,
      source: registerEnrolments.source,
      enrolledAt: registerEnrolments.enrolledAt,
      leftAt: registerEnrolments.leftAt,
      leftReason: registerEnrolments.leftReason,
      facilityId: registerEnrolments.facilityId,
      facilityName: facilities.name,
      enrolledBy: users.fullName,
    })
    .from(registerEnrolments)
    .innerJoin(facilities, eq(facilities.id, registerEnrolments.facilityId))
    .leftJoin(users, eq(users.id, registerEnrolments.enrolledById))
    .where(eq(registerEnrolments.patientId, patientId))
    .orderBy(desc(registerEnrolments.enrolledAt));
  const data = (await loadPatientData([patientId])).get(patientId)!;
  const now = new Date();
  const active = enrolments.filter((e) => e.status === 'ACTIVE');

  // Registers suggested by current diagnoses the patient is not (or no longer) in.
  const dx = await db
    .select({ icd10Code: diagnoses.icd10Code, description: diagnoses.description })
    .from(diagnoses)
    .where(
      and(eq(diagnoses.patientId, patientId), inArray(diagnoses.status, ['ACTIVE', 'CHRONIC'])),
    );
  const suggested = new Map<RegisterCode, string>();
  for (const d of dx) {
    for (const r of registersForIcd10(d.icd10Code)) {
      if (!active.some((e) => e.register === r))
        suggested.set(r, `${d.icd10Code} ${d.description}`);
    }
  }

  const records = await db
    .select({
      id: careProcessRecords.id,
      register: careProcessRecords.register,
      process: careProcessRecords.process,
      result: careProcessRecords.result,
      notes: careProcessRecords.notes,
      performedAt: careProcessRecords.performedAt,
      recordedBy: users.fullName,
    })
    .from(careProcessRecords)
    .leftJoin(users, eq(users.id, careProcessRecords.recordedById))
    .where(eq(careProcessRecords.patientId, patientId))
    .orderBy(desc(careProcessRecords.performedAt))
    .limit(50);

  res.json({
    registers: active.map((e) => ({
      ...e,
      label: REGISTERS[e.register as RegisterCode].label,
      processes: evaluateRegister(e.register as RegisterCode, e.enrolledAt, data, now),
    })),
    history: enrolments.filter((e) => e.status !== 'ACTIVE'),
    suggested: [...suggested].map(([register, diagnosis]) => ({
      register,
      label: REGISTERS[register].label,
      diagnosis,
    })),
    records,
    canEnrol: ctx.role === 'DOCTOR',
    canRecord: WRITERS.careTeam.includes(ctx.role),
  });
});

const EnrolInput = z.object({
  register: RegisterEnum,
  reason: z.string().trim().max(200).optional(),
});

registersRouter.post('/patients/:patientId/enrolments', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(EnrolInput, req.body);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.doctorOnly);
  const row = await db.transaction(async (tx) => {
    const joined = await enrolPatient(
      patientId,
      [input.register],
      { source: 'MANUAL', enrolledById: ctx.userId },
      tx,
    );
    if (!joined.length) {
      throw conflict('The patient is already in this register (or the record is closed)');
    }
    const [created] = await tx
      .select()
      .from(registerEnrolments)
      .where(
        and(
          eq(registerEnrolments.patientId, patientId),
          eq(registerEnrolments.register, input.register),
          eq(registerEnrolments.status, 'ACTIVE'),
        ),
      );
    await audit(
      {
        action: AuditAction.REGISTER_ENROLLED,
        actor: ctx,
        resourceType: 'register_enrolment',
        resourceId: created!.id,
        patientId,
        meta,
        metadata: { register: input.register, source: 'MANUAL', reason: input.reason ?? null },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

const LeaveInput = z.object({ reason: z.string().trim().min(3).max(200) });

registersRouter.post('/enrolments/:id/leave', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const { reason } = parse(LeaveInput, req.body);
  const [enrolment] = await db
    .select()
    .from(registerEnrolments)
    .where(eq(registerEnrolments.id, id));
  if (!enrolment) throw notFound('Register enrolment not found');
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, enrolment.patientId, meta, WRITERS.doctorOnly);
  if (enrolment.status !== 'ACTIVE') throw conflict('The patient has already left this register');
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(registerEnrolments)
      .set({ status: 'LEFT', leftAt: new Date(), leftReason: reason })
      .where(and(eq(registerEnrolments.id, id), eq(registerEnrolments.status, 'ACTIVE')))
      .returning();
    if (!updated) throw conflict('The patient has already left this register');
    await audit(
      {
        action: AuditAction.REGISTER_LEFT,
        actor: ctx,
        resourceType: 'register_enrolment',
        resourceId: id,
        patientId: enrolment.patientId,
        meta,
        metadata: { register: enrolment.register, reason },
      },
      tx,
    );
    return updated;
  });
  res.json(row);
});

const CareProcessInput = z.object({
  register: RegisterEnum,
  process: z.string().trim().min(2).max(30),
  result: z.string().trim().min(2).max(30),
  notes: z.string().trim().max(500).optional().nullable(),
  performedAt: z.coerce
    .date()
    .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'The date cannot be in the future')
    .refine((d) => d.getTime() >= Date.now() - 2 * 365 * 86_400_000, 'The date is too far back')
    .optional(),
});

registersRouter.post(
  '/patients/:patientId/care-processes',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const input = parse(CareProcessInput, req.body);
    const meta = requestMeta(req);
    await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.careTeam);
    const def = recordProcess(input.register, input.process);
    if (!def) throw badRequest('This review item is not recorded by hand for this register');
    if (def.results && !def.results.includes(input.result)) {
      throw badRequest('Choose one of the listed results', { allowed: def.results });
    }
    const [enrolled] = await activeEnrolments([patientId]).then((rows) =>
      rows.filter((r) => r.register === input.register),
    );
    if (!enrolled) throw conflict('The patient is not in this register');
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(careProcessRecords)
        .values({
          patientId,
          register: input.register,
          process: input.process,
          result: input.result,
          notes: input.notes ?? null,
          performedAt: input.performedAt ?? new Date(),
          recordedById: ctx.userId,
          facilityId: ctx.facilityId,
        })
        .returning();
      await audit(
        {
          action: AuditAction.CARE_PROCESS_RECORDED,
          actor: ctx,
          resourceType: 'care_process_record',
          resourceId: created!.id,
          patientId,
          meta,
          metadata: { register: input.register, process: input.process },
        },
        tx,
      );
      return created!;
    });
    res.status(201).json(row);
  },
);

/* ------------------------------------------------------------------------ recall list -- */

const RecallQuery = PaginationSchema.extend({
  register: RegisterEnum.optional(),
  state: z.enum(['OVERDUE', 'DUE', 'ALL']).default('OVERDUE'),
  q: z.string().trim().max(100).optional(),
});

/**
 * Register members in the caller's care (active care-team membership) with their review items
 * that are overdue or due – the practice's recall list.
 */
registersRouter.get('/recalls', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(RecallQuery, req.query);
  const people = await db
    .selectDistinct({
      id: patients.id,
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      phone: patients.phone,
    })
    .from(registerEnrolments)
    .innerJoin(patients, eq(patients.id, registerEnrolments.patientId))
    .innerJoin(
      careAssignments,
      and(
        eq(careAssignments.patientId, patients.id),
        eq(careAssignments.doctorId, ctx.userId),
        isNull(careAssignments.endedAt),
      ),
    )
    .where(
      and(
        eq(registerEnrolments.status, 'ACTIVE'),
        q.register ? eq(registerEnrolments.register, q.register) : undefined,
        isNull(patients.mergedIntoId),
        isNull(patients.deceasedAt),
        q.q
          ? sql`(${patients.firstName} || ' ' || ${patients.lastName} ILIKE ${`%${q.q}%`} OR ${patients.nationalId} ILIKE ${`${q.q}%`})`
          : undefined,
      ),
    )
    .limit(5000);
  const ids = people.map((p) => p.id);
  const [data, enrolments] = await Promise.all([loadPatientData(ids), activeEnrolments(ids)]);
  const now = new Date();
  const wanted = (s: ProcessState) =>
    q.state === 'ALL'
      ? s !== 'UP_TO_DATE'
      : q.state === 'OVERDUE'
        ? s === 'OVERDUE'
        : s === 'OVERDUE' || s === 'DUE' || s === 'DUE_SOON';

  const all = people
    .map((p) => {
      const regs = enrolments
        .filter((e) => e.patientId === p.id && (!q.register || e.register === q.register))
        .map((e) => {
          const processes = evaluateRegister(
            e.register as RegisterCode,
            e.enrolledAt,
            data.get(p.id)!,
            now,
          );
          return {
            register: e.register,
            label: REGISTERS[e.register as RegisterCode].label,
            items: processes
              .filter((x) => wanted(x.state))
              .map((x) => ({ code: x.code, label: x.label, state: x.state, dueDate: x.dueDate })),
            targetsNotMet: processes
              .filter((x) => x.target && x.target.met === false)
              .map((x) => x.target!.code),
          };
        })
        .filter((r) => r.items.length);
      return { patient: p, registers: regs };
    })
    .filter((p) => p.registers.length);
  const overdueCount = (x: (typeof all)[number]) =>
    x.registers.reduce((a, r) => a + r.items.filter((i) => i.state === 'OVERDUE').length, 0);
  all.sort(
    (a, b) =>
      overdueCount(b) - overdueCount(a) ||
      a.patient.lastName.localeCompare(b.patient.lastName) ||
      a.patient.firstName.localeCompare(b.patient.firstName),
  );
  const start = (q.page - 1) * q.pageSize;
  res.json({
    ...paginated(all.slice(start, start + q.pageSize), all.length, q),
    counts: {
      patients: all.length,
      overdueItems: all.reduce((a, x) => a + overdueCount(x), 0),
      inCare: ids.length,
    },
  });
});

/* ------------------------------------------------------------------------- indicators -- */

const IndicatorQuery = z.object({
  register: RegisterEnum.optional(),
  groupBy: z.enum(['NONE', 'FACILITY', 'MUNICIPALITY']).default('NONE'),
  facilityId: z.string().uuid().optional(),
});

registersRouter.get('/indicators', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(IndicatorQuery, req.query);
  if (ctx.role === 'DIRECTOR') {
    if (!ctx.facilityId) throw forbidden();
    if (q.facilityId && q.facilityId !== ctx.facilityId) throw forbidden();
  }
  const facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId : (q.facilityId ?? null);
  const groupBy = ctx.role === 'DIRECTOR' ? 'NONE' : q.groupBy;
  const [total] = await computeIndicators({ facilityId, register: q.register, groupBy: 'NONE' });
  const rows =
    groupBy === 'NONE'
      ? []
      : await computeIndicators({ facilityId, register: q.register, groupBy });
  res.json({
    scope: facilityId ? 'FACILITY' : 'NATIONAL',
    groupBy,
    asOf: new Date().toISOString().slice(0, 10),
    threshold: SMALL_CELL_THRESHOLD,
    total: total?.registers ?? [],
    rows,
    disclaimer:
      'Targets are placeholders until confirmed by the national clinical guidelines. Counts below the threshold are suppressed.',
  });
});
