import { publishBoardChanges } from '../../lib/events.js';
import { Router } from 'express';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  edArrivalModeEnum,
  edVisits,
  facilities,
  patients,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { assertNotMerged, resolveAndAuditRead } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import {
  assertCanRegister,
  assertCanViewBoard,
  assertEdClinician,
  edUnitFor,
  isEdClinician,
  minutesBetween,
  OPEN_STATUSES,
  TARGET_MINUTES,
  TRIAGE_TARGET_MINUTES,
  unitStaffIds,
  type EdUnit,
  type TriageLevel,
} from './ed.service.js';

/**
 * Emergency department: arrival → triage (five levels) → treatment → departure (discharge,
 * transfer, left without being seen, or admission – the latter through the inpatient module,
 * which closes the attendance). Staff assigned to the emergency department get access to the
 * patient's record while the attendance is open (see access/policy.ts).
 */
export const edRouter = Router();
edRouter.use(
  authenticate,
  requireRole('DOCTOR', 'NURSE', 'RECEPTION'),
  publishBoardChanges('ed.board', ['DOCTOR', 'NURSE', 'RECEPTION']),
);

const UnitQuery = z.object({ unitId: z.string().uuid().optional() });
const IdParam = z.object({ id: z.string().uuid() });

const ArrivalSchema = z.object({
  patientId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  arrivalMode: z.enum(edArrivalModeEnum.enumValues),
  chiefComplaint: z.string().trim().min(3).max(300),
  arrivedAt: z.coerce.date().optional(),
});

const VitalsSchema = z
  .object({
    systolic: z.number().int().min(40).max(300).optional(),
    diastolic: z.number().int().min(20).max(200).optional(),
    heartRate: z.number().int().min(20).max(300).optional(),
    respiratoryRate: z.number().int().min(4).max(80).optional(),
    temperature: z.number().min(25).max(45).optional(),
    spo2: z.number().int().min(30).max(100).optional(),
    painScore: z.number().int().min(0).max(10).optional(),
  })
  .strict();

const TriageSchema = z.object({
  level: z.number().int().min(1).max(5),
  note: z.string().trim().max(900).optional().nullable(),
  vitals: VitalsSchema.optional(),
});

const StartSchema = z.object({ doctorId: z.string().uuid().optional() });
const DepartSchema = z.object({
  status: z.enum(['DISCHARGED', 'TRANSFERRED', 'LEFT_WITHOUT_BEING_SEEN']),
  note: z.string().trim().max(1000).optional().nullable(),
});

const doctor = alias(users, 'ed_doctor');

/** The visit, which must belong to the caller's facility. */
async function visitAtMyFacility(ctx: AuthContext, id: string) {
  const [visit] = await db.select().from(edVisits).where(eq(edVisits.id, id));
  if (!visit || visit.facilityId !== ctx.facilityId) throw notFound('Emergency visit not found');
  return visit;
}

function assertOpen(visit: typeof edVisits.$inferSelect) {
  if (!(OPEN_STATUSES as readonly string[]).includes(visit.status)) {
    throw conflict('This emergency visit has already ended');
  }
}

async function unitOf(ctx: AuthContext, visit: typeof edVisits.$inferSelect): Promise<EdUnit> {
  return edUnitFor(ctx, visit.unitId);
}

/* ------------------------------------------------------------------ units ----------------------- */

/** The facility's emergency departments and whether the caller works in them. */
edRouter.get('/units', async (req, res) => {
  const ctx = requireAuth(req);
  const unit = await edUnitFor(ctx);
  res.json({
    items: [{ id: unit.id, name: unit.name, code: unit.code }],
    canTreat: await isEdClinician(ctx, unit),
  });
});

/* ------------------------------------------------------------------ arrivals -------------------- */

edRouter.post('/arrivals', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(ArrivalSchema, req.body);
  const unit = await edUnitFor(ctx, input.unitId);
  await assertCanRegister(ctx, unit);
  const [patient] = await db.select().from(patients).where(eq(patients.id, input.patientId));
  if (!patient) throw notFound('Patient not found');
  assertNotMerged(patient);
  if (input.arrivedAt && input.arrivedAt.getTime() > Date.now() + 5 * 60_000) {
    throw badRequest('The arrival time cannot be in the future');
  }

  const visit = await db.transaction(async (tx) => {
    const [open] = await tx
      .select({ id: edVisits.id })
      .from(edVisits)
      .where(and(eq(edVisits.patientId, patient.id), inArray(edVisits.status, OPEN_STATUSES)));
    if (open) throw conflict('This patient is already in the emergency department');
    const [created] = await tx
      .insert(edVisits)
      .values({
        patientId: patient.id,
        facilityId: unit.facilityId,
        unitId: unit.id,
        arrivalMode: input.arrivalMode,
        chiefComplaint: input.chiefComplaint,
        arrivedAt: input.arrivedAt ?? new Date(),
        registeredById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.ED_ARRIVAL_REGISTERED,
        actor: ctx,
        resourceType: 'ed_visit',
        resourceId: created!.id,
        patientId: patient.id,
        meta: requestMeta(req),
        metadata: { arrivalMode: input.arrivalMode },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(visit);
});

/* ------------------------------------------------------------------ triage ---------------------- */

edRouter.post('/visits/:id/triage', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(TriageSchema, req.body);
  const visit = await visitAtMyFacility(ctx, id);
  assertOpen(visit);
  const unit = await unitOf(ctx, visit);
  await assertEdClinician(ctx, unit);

  const v = input.vitals ?? {};
  const note =
    [input.note?.trim(), v.painScore !== undefined ? `VAS ${v.painScore}/10` : null]
      .filter(Boolean)
      .join(' · ') || null;
  const hasVitals = [
    v.systolic,
    v.diastolic,
    v.heartRate,
    v.respiratoryRate,
    v.temperature,
    v.spo2,
  ].some((x) => x !== undefined);
  const previousLevel = visit.triageLevel;

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(edVisits)
      .set({
        triageLevel: input.level,
        triageNote: note,
        triagedById: ctx.userId,
        triagedAt: new Date(),
      })
      .where(and(eq(edVisits.id, visit.id), inArray(edVisits.status, OPEN_STATUSES)))
      .returning();
    if (!row) throw conflict('This emergency visit has already ended');
    if (hasVitals) {
      await tx.insert(vitalSigns).values({
        patientId: visit.patientId,
        recordedById: ctx.userId,
        systolic: v.systolic ?? null,
        diastolic: v.diastolic ?? null,
        heartRate: v.heartRate ?? null,
        respiratoryRate: v.respiratoryRate ?? null,
        temperatureC: v.temperature !== undefined ? String(v.temperature) : null,
        oxygenSaturation: v.spo2 ?? null,
      });
    }
    await audit(
      {
        action: AuditAction.ED_TRIAGED,
        actor: ctx,
        resourceType: 'ed_visit',
        resourceId: visit.id,
        patientId: visit.patientId,
        meta: requestMeta(req),
        metadata: { level: input.level, previousLevel, vitals: hasVitals },
      },
      tx,
    );
    // Very urgent patients: tell the department's doctors at once.
    const becameUrgent = input.level <= 2 && (previousLevel === null || previousLevel > 2);
    if (becameUrgent) {
      const doctors = (await unitStaffIds(unit.id, ['DOCTOR'], tx)).filter((d) => d !== ctx.userId);
      await notifyUsers(
        doctors,
        {
          type: 'ed.urgent',
          title: 'Very urgent patient in the emergency department (level {level})',
          vars: { level: input.level },
          link: '/ed',
          important: true,
        },
        tx,
      );
    }
    return row;
  });
  res.json(updated);
});

/* ------------------------------------------------------------------ treatment ------------------- */

edRouter.post('/visits/:id/start', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(StartSchema, req.body ?? {});
  const visit = await visitAtMyFacility(ctx, id);
  assertOpen(visit);
  const unit = await unitOf(ctx, visit);
  await assertEdClinician(ctx, unit);

  const chosen = input.doctorId ?? (ctx.role === 'DOCTOR' ? ctx.userId : null);
  if (!chosen) throw badRequest('Choose the doctor who takes over the patient');
  const doctorId: string = chosen;
  const edDoctors = await unitStaffIds(unit.id, ['DOCTOR']);
  if (!edDoctors.includes(doctorId)) {
    throw badRequest('The doctor must work in the emergency department');
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(edVisits)
      .set({
        status: 'IN_TREATMENT',
        assignedDoctorId: doctorId,
        seenAt: visit.seenAt ?? new Date(),
      })
      .where(and(eq(edVisits.id, visit.id), inArray(edVisits.status, OPEN_STATUSES)))
      .returning();
    if (!row) throw conflict('This emergency visit has already ended');
    await audit(
      {
        action: AuditAction.ED_STATUS_CHANGED,
        actor: ctx,
        resourceType: 'ed_visit',
        resourceId: visit.id,
        patientId: visit.patientId,
        meta: requestMeta(req),
        metadata: { from: visit.status, to: 'IN_TREATMENT', doctorId },
      },
      tx,
    );
    if (doctorId !== ctx.userId) {
      await notifyUsers(
        [doctorId],
        {
          type: 'ed.assigned',
          title: 'A patient in the emergency department was assigned to you',
          link: '/ed',
        },
        tx,
      );
    }
    return row;
  });
  res.json(updated);
});

edRouter.post('/visits/:id/depart', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(DepartSchema, req.body);
  const visit = await visitAtMyFacility(ctx, id);
  assertOpen(visit);
  const unit = await unitOf(ctx, visit);
  await assertEdClinician(ctx, unit);
  if (input.status !== 'LEFT_WITHOUT_BEING_SEEN' && ctx.role !== 'DOCTOR') {
    throw badRequest('A doctor discharges or transfers a patient');
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(edVisits)
      .set({
        status: input.status,
        departedAt: new Date(),
        dispositionNote: input.note ?? null,
      })
      .where(and(eq(edVisits.id, visit.id), inArray(edVisits.status, OPEN_STATUSES)))
      .returning();
    if (!row) throw conflict('This emergency visit has already ended');
    await audit(
      {
        action: AuditAction.ED_STATUS_CHANGED,
        actor: ctx,
        resourceType: 'ed_visit',
        resourceId: visit.id,
        patientId: visit.patientId,
        meta: requestMeta(req),
        metadata: { from: visit.status, to: input.status },
      },
      tx,
    );
    return row;
  });
  res.json(updated);
});

/* ------------------------------------------------------------------ board ----------------------- */

const patientColumns = {
  id: patients.id,
  firstName: patients.firstName,
  lastName: patients.lastName,
  nationalId: patients.nationalId,
  dateOfBirth: patients.dateOfBirth,
  sex: patients.sex,
  temporaryIdentity: patients.temporaryIdentity,
};

/**
 * Live board: open attendances – awaiting triage first, then by triage level and arrival – with
 * waiting times against the target for their level, and departures of the last 12 hours.
 * Reception sees the operational picture only (no triage notes or vital signs).
 */
edRouter.get('/board', async (req, res) => {
  const ctx = requireAuth(req);
  const { unitId } = parse(UnitQuery, req.query);
  const unit = await edUnitFor(ctx, unitId);
  await assertCanViewBoard(ctx, unit);
  const clinical = await isEdClinician(ctx, unit);
  const now = new Date();

  const [open, departed, edDoctors] = await Promise.all([
    db
      .select({
        visit: edVisits,
        patient: patientColumns,
        doctorName: doctor.fullName,
      })
      .from(edVisits)
      .innerJoin(patients, eq(patients.id, edVisits.patientId))
      .leftJoin(doctor, eq(doctor.id, edVisits.assignedDoctorId))
      .where(and(eq(edVisits.unitId, unit.id), inArray(edVisits.status, OPEN_STATUSES)))
      .orderBy(
        sql`${edVisits.triageLevel} IS NOT NULL`,
        asc(edVisits.triageLevel),
        asc(edVisits.arrivedAt),
      ),
    db
      .select({
        id: edVisits.id,
        status: edVisits.status,
        triageLevel: edVisits.triageLevel,
        arrivedAt: edVisits.arrivedAt,
        departedAt: edVisits.departedAt,
        admissionId: edVisits.admissionId,
        patient: patientColumns,
      })
      .from(edVisits)
      .innerJoin(patients, eq(patients.id, edVisits.patientId))
      .where(
        and(
          eq(edVisits.unitId, unit.id),
          gt(edVisits.departedAt, new Date(now.getTime() - 12 * 3_600_000)),
        ),
      )
      .orderBy(desc(edVisits.departedAt))
      .limit(50),
    db
      .select({ id: users.id, fullName: users.fullName })
      .from(users)
      .where(inArray(users.id, await unitStaffIds(unit.id, ['DOCTOR'])))
      .orderBy(users.fullName),
  ]);

  // Latest vital signs since arrival, for clinicians only.
  const vitalsByPatient = new Map<string, typeof vitalSigns.$inferSelect>();
  if (clinical && open.length) {
    const rows = await db
      .select()
      .from(vitalSigns)
      .where(
        inArray(
          vitalSigns.patientId,
          open.map((o) => o.visit.patientId),
        ),
      )
      .orderBy(desc(vitalSigns.recordedAt));
    for (const r of rows) {
      const visit = open.find((o) => o.visit.patientId === r.patientId)!.visit;
      if (r.recordedAt >= visit.arrivedAt && !vitalsByPatient.has(r.patientId)) {
        vitalsByPatient.set(r.patientId, r);
      }
    }
  }

  const counts = { awaitingTriage: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, waiting: 0, inTreatment: 0 };
  const items = open.map(({ visit, patient, doctorName }) => {
    const level = visit.triageLevel as TriageLevel | null;
    if (level) counts[level]++;
    else counts.awaitingTriage++;
    if (visit.status === 'WAITING') counts.waiting++;
    else counts.inTreatment++;
    const waitedUntil = visit.seenAt ?? now;
    const minutesWaiting = minutesBetween(visit.arrivedAt, waitedUntil);
    const targetMinutes = level ? TARGET_MINUTES[level] : TRIAGE_TARGET_MINUTES;
    const breached =
      visit.status === 'WAITING' &&
      (level ? minutesWaiting > targetMinutes : minutesWaiting > TRIAGE_TARGET_MINUTES);
    const vitals = vitalsByPatient.get(visit.patientId);
    return {
      id: visit.id,
      patient,
      arrivedAt: visit.arrivedAt,
      arrivalMode: visit.arrivalMode,
      chiefComplaint: visit.chiefComplaint,
      status: visit.status,
      triageLevel: level,
      triagedAt: visit.triagedAt,
      triageNote: clinical ? visit.triageNote : null,
      assignedDoctor: visit.assignedDoctorId
        ? { id: visit.assignedDoctorId, fullName: doctorName }
        : null,
      seenAt: visit.seenAt,
      minutesWaiting,
      minutesInDepartment: minutesBetween(visit.arrivedAt, now),
      targetMinutes,
      breached,
      vitals:
        clinical && vitals
          ? {
              recordedAt: vitals.recordedAt,
              systolic: vitals.systolic,
              diastolic: vitals.diastolic,
              heartRate: vitals.heartRate,
              respiratoryRate: vitals.respiratoryRate,
              temperature: vitals.temperatureC,
              spo2: vitals.oxygenSaturation,
            }
          : null,
    };
  });

  res.json({
    unit: { id: unit.id, name: unit.name, code: unit.code },
    canTreat: clinical,
    targets: { triage: TRIAGE_TARGET_MINUTES, ...TARGET_MINUTES },
    counts,
    items,
    departed,
    doctors: edDoctors,
    generatedAt: now,
  });
});

/* ------------------------------------------------------------------ chart ----------------------- */

/** A patient's emergency attendances, for the chart (clinical access required). */
edRouter.get('/patients/:patientId/visits', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(z.object({ patientId: z.string().uuid() }), req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'emergency-visits');
  const triager = alias(users, 'ed_triager');
  const rows = await db
    .select({
      id: edVisits.id,
      arrivedAt: edVisits.arrivedAt,
      arrivalMode: edVisits.arrivalMode,
      chiefComplaint: edVisits.chiefComplaint,
      triageLevel: edVisits.triageLevel,
      triageNote: edVisits.triageNote,
      triagedAt: edVisits.triagedAt,
      triagedBy: triager.fullName,
      seenAt: edVisits.seenAt,
      assignedDoctor: doctor.fullName,
      status: edVisits.status,
      departedAt: edVisits.departedAt,
      dispositionNote: edVisits.dispositionNote,
      admissionId: edVisits.admissionId,
      facilityName: facilities.name,
    })
    .from(edVisits)
    .innerJoin(facilities, eq(facilities.id, edVisits.facilityId))
    .leftJoin(doctor, eq(doctor.id, edVisits.assignedDoctorId))
    .leftJoin(triager, eq(triager.id, edVisits.triagedById))
    .where(eq(edVisits.patientId, patientId))
    .orderBy(desc(edVisits.arrivedAt))
    .limit(100);
  res.json({ items: rows });
});
