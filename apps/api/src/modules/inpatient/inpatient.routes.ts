import { publishBoardChanges } from '../../lib/events.js';
import { Router } from 'express';
import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  admissionSourceEnum,
  admissions,
  bedMovements,
  beds,
  careAssignments,
  careUnitTypeEnum,
  careUnits,
  dischargeDispositionEnum,
  edVisits,
  patients,
  unitStaff,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertNotMerged,
  getPatientOrThrow,
  resolveClinicalReadAccess,
  WRITERS,
  resolveAndAuditRead,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { viewFor } from '../clinical/clinical.service.js';
import { tr } from '../../i18n/index.js';
import { notifyPatient, notifyUsers } from '../notifications/notifications.service.js';
import {
  assertFacilityStaff,
  bedLabels,
  buildSummaryDraft,
  isWardType,
  localeOf,
  lockAvailableBed,
  unitAtFacility,
  unitNames,
  unitNurses,
  wardAtFacility,
} from './inpatient.service.js';

/**
 * Inpatient care: wards and beds (configured by the director), admission, transfer and discharge
 * with a signed discharge summary, and the facility's bed board. Directors and reception see the
 * board (who is in which bed) but never the clinical reason for admission.
 */
export const inpatientRouter = Router();
inpatientRouter.use(
  authenticate,
  publishBoardChanges('hospital.board', ['DOCTOR', 'NURSE', 'RECEPTION', 'DIRECTOR']),
);

const Id = z.object({ id: z.string().uuid() });
const attending = alias(users, 'attending');

function assertDirector(ctx: AuthContext) {
  if (ctx.role !== 'DIRECTOR' || !ctx.facilityId) {
    throw forbidden('Only the facility director can configure wards and units');
  }
  return ctx.facilityId;
}

const pgUnique = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

/* ------------------------------------------------------------------ units, beds, staff */

const UnitsQuery = z.object({
  type: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()) : undefined))
    .pipe(z.array(z.enum(careUnitTypeEnum.enumValues)).optional()),
  includeInactive: z.enum(['true', 'false']).optional(),
});

/** Units of my facility with their beds and occupancy. Contract also used by the emergency board. */
inpatientRouter.get('/units', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertFacilityStaff(ctx);
  const q = parse(UnitsQuery, req.query);
  const units = await db
    .select()
    .from(careUnits)
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        q.type ? inArray(careUnits.type, q.type) : undefined,
        q.includeInactive === 'true' && ctx.role === 'DIRECTOR'
          ? undefined
          : eq(careUnits.isActive, true),
      ),
    )
    .orderBy(asc(careUnits.name));
  const ids = units.map((u) => u.id);
  const [bedRows, occupied, staffCounts] = await Promise.all([
    ids.length
      ? db
          .select({ id: beds.id, unitId: beds.unitId, label: beds.label, status: beds.status })
          .from(beds)
          .where(inArray(beds.unitId, ids))
          .orderBy(asc(beds.label))
      : [],
    ids.length
      ? db
          .select({ unitId: admissions.unitId, n: sql<number>`count(*)::int` })
          .from(admissions)
          .where(and(inArray(admissions.unitId, ids), eq(admissions.status, 'ADMITTED')))
          .groupBy(admissions.unitId)
      : [],
    ids.length
      ? db
          .select({ unitId: unitStaff.unitId, n: sql<number>`count(*)::int` })
          .from(unitStaff)
          .where(inArray(unitStaff.unitId, ids))
          .groupBy(unitStaff.unitId)
      : [],
  ]);
  const occ = new Map(occupied.map((o) => [o.unitId, o.n]));
  const staff = new Map(staffCounts.map((s) => [s.unitId, s.n]));
  res.json({
    items: units.map((u) => {
      const unitBeds = bedRows.filter((b) => b.unitId === u.id);
      return {
        id: u.id,
        name: u.name,
        code: u.code,
        type: u.type,
        isActive: u.isActive,
        beds: unitBeds.map(({ id, label, status }) => ({ id, label, status })),
        total: unitBeds.length,
        occupied: occ.get(u.id) ?? 0,
        available: unitBeds.filter((b) => b.status === 'AVAILABLE').length,
        staff: staff.get(u.id) ?? 0,
      };
    }),
  });
});

const UnitInput = z.object({
  name: z.string().trim().min(2).max(120),
  code: z
    .string()
    .trim()
    .min(1)
    .max(20)
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, - or _'),
  type: z.enum(careUnitTypeEnum.enumValues),
});

inpatientRouter.post('/units', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertDirector(ctx);
  const input = parse(UnitInput, req.body);
  try {
    const unit = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(careUnits)
        .values({ ...input, code: input.code.toUpperCase(), facilityId })
        .returning();
      await audit(
        {
          action: AuditAction.CARE_UNIT_CHANGED,
          actor: ctx,
          resourceType: 'care_unit',
          resourceId: row!.id,
          meta: requestMeta(req),
          metadata: { change: 'created', ...input },
        },
        tx,
      );
      return row!;
    });
    res.status(201).json(unit);
  } catch (err) {
    if (pgUnique(err)) throw conflict('A unit with this code already exists');
    throw err;
  }
});

inpatientRouter.patch('/units/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertDirector(ctx);
  const { id } = parse(Id, req.params);
  const input = parse(
    z
      .object({
        name: z.string().trim().min(2).max(120).optional(),
        isActive: z.boolean().optional(),
      })
      .refine((v) => v.name !== undefined || v.isActive !== undefined, 'Nothing to change'),
    req.body,
  );
  await unitAtFacility(id, facilityId);
  if (input.isActive === false) {
    const [busy] = await db
      .select({ id: admissions.id })
      .from(admissions)
      .where(and(eq(admissions.unitId, id), eq(admissions.status, 'ADMITTED')))
      .limit(1);
    if (busy) throw conflict('Patients are still admitted to this unit');
  }
  const [row] = await db.update(careUnits).set(input).where(eq(careUnits.id, id)).returning();
  await audit({
    action: AuditAction.CARE_UNIT_CHANGED,
    actor: ctx,
    resourceType: 'care_unit',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { change: 'updated', ...input },
  });
  res.json(row);
});

const BedsInput = z
  .object({
    labels: z.array(z.string().trim().min(1).max(20)).min(1).max(100).optional(),
    prefix: z.string().trim().max(10).optional(),
    from: z.number().int().min(0).max(999).optional(),
    to: z.number().int().min(0).max(999).optional(),
  })
  .refine(
    (v) =>
      v.labels ||
      (v.from !== undefined && v.to !== undefined && v.to >= v.from && v.to - v.from < 100),
    'Give bed labels, or a range (from–to, at most 100 beds)',
  );

inpatientRouter.post('/units/:id/beds', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertDirector(ctx);
  const { id } = parse(Id, req.params);
  const input = parse(BedsInput, req.body);
  const unit = await unitAtFacility(id, facilityId);
  if (!isWardType(unit.type)) throw badRequest('Only wards have beds');
  const labels =
    input.labels ??
    Array.from(
      { length: input.to! - input.from! + 1 },
      (_, i) => `${input.prefix ?? ''}${input.from! + i}`,
    );
  const created = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(beds)
      .values(labels.map((label) => ({ unitId: id, label })))
      .onConflictDoNothing()
      .returning({ id: beds.id, label: beds.label, status: beds.status });
    await audit(
      {
        action: AuditAction.CARE_UNIT_CHANGED,
        actor: ctx,
        resourceType: 'care_unit',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { change: 'beds_added', count: rows.length },
      },
      tx,
    );
    return rows;
  });
  res.status(201).json({ items: created, skipped: labels.length - created.length });
});

inpatientRouter.patch('/beds/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertFacilityStaff(ctx, ['NURSE', 'RECEPTION', 'DIRECTOR']);
  const { id } = parse(Id, req.params);
  const input = parse(
    z.object({
      status: z.enum(['AVAILABLE', 'CLEANING', 'OUT_OF_SERVICE']),
      note: z.string().trim().max(200).optional().nullable(),
    }),
    req.body,
  );
  const [bed] = await db
    .select({ bed: beds, facilityId: careUnits.facilityId })
    .from(beds)
    .innerJoin(careUnits, eq(careUnits.id, beds.unitId))
    .where(eq(beds.id, id));
  if (!bed || bed.facilityId !== facilityId) throw notFound('Bed not found');
  const [occupant] = await db
    .select({ id: admissions.id })
    .from(admissions)
    .where(and(eq(admissions.bedId, id), eq(admissions.status, 'ADMITTED')))
    .limit(1);
  if (occupant || bed.bed.status === 'OCCUPIED') {
    throw conflict('This bed is occupied – transfer or discharge the patient first');
  }
  const [row] = await db
    .update(beds)
    .set({ status: input.status, note: input.note ?? null, updatedAt: new Date() })
    .where(eq(beds.id, id))
    .returning();
  await audit({
    action: AuditAction.BED_STATUS_CHANGED,
    actor: ctx,
    resourceType: 'bed',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { from: bed.bed.status, to: input.status },
  });
  res.json(row);
});

inpatientRouter.get('/units/:id/staff', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertFacilityStaff(ctx);
  const { id } = parse(Id, req.params);
  await unitAtFacility(id, facilityId);
  const rows = await db
    .select({
      userId: users.id,
      fullName: users.fullName,
      role: users.role,
      specialty: users.specialty,
      assignedAt: unitStaff.createdAt,
    })
    .from(unitStaff)
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(eq(unitStaff.unitId, id))
    .orderBy(asc(users.role), asc(users.fullName));
  res.json({ items: rows });
});

inpatientRouter.post('/units/:id/staff', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertDirector(ctx);
  const { id } = parse(Id, req.params);
  const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
  const unit = await unitAtFacility(id, facilityId);
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (
    !user ||
    user.facilityId !== facilityId ||
    !user.isActive ||
    !['DOCTOR', 'NURSE', 'RECEPTION'].includes(user.role)
  ) {
    throw badRequest('Choose an active doctor, nurse or receptionist of this facility');
  }
  await db.transaction(async (tx) => {
    await tx
      .insert(unitStaff)
      .values({ unitId: id, userId, assignedById: ctx.userId })
      .onConflictDoNothing();
    await audit(
      {
        action: AuditAction.UNIT_STAFF_CHANGED,
        actor: ctx,
        resourceType: 'care_unit',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { change: 'assigned', userId },
      },
      tx,
    );
    await notifyUsers(
      [userId],
      {
        type: 'unit',
        title: 'You were assigned to {unit}',
        vars: { unit: unit.name },
        link: '/wards',
      },
      tx,
    );
  });
  res.status(201).json({ unitId: id, userId });
});

inpatientRouter.delete('/units/:id/staff/:userId', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertDirector(ctx);
  const { id, userId } = parse(
    z.object({ id: z.string().uuid(), userId: z.string().uuid() }),
    req.params,
  );
  await unitAtFacility(id, facilityId);
  const rows = await db
    .delete(unitStaff)
    .where(and(eq(unitStaff.unitId, id), eq(unitStaff.userId, userId)))
    .returning({ id: unitStaff.id });
  if (!rows.length) throw notFound('This person is not assigned to the unit');
  await audit({
    action: AuditAction.UNIT_STAFF_CHANGED,
    actor: ctx,
    resourceType: 'care_unit',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { change: 'removed', userId },
  });
  res.status(204).end();
});

/* ------------------------------------------------------------------ bed board */

inpatientRouter.get('/board', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertFacilityStaff(ctx);
  const q = parse(
    z.object({ unitId: z.string().uuid().optional(), mine: z.enum(['true', 'false']).optional() }),
    req.query,
  );
  const clinicalViewer = ctx.role === 'DOCTOR' || ctx.role === 'NURSE';
  // The reason for admission is clinical: shown only to the attending doctor, staff of the unit
  // and the patient's care team.
  const reasonVisible = clinicalViewer
    ? sql<boolean>`(${admissions.attendingDoctorId} = ${ctx.userId}
        OR EXISTS (SELECT 1 FROM unit_staff us WHERE us.unit_id = ${admissions.unitId} AND us.user_id = ${ctx.userId})
        OR EXISTS (SELECT 1 FROM care_assignments ca WHERE ca.patient_id = ${admissions.patientId} AND ca.doctor_id = ${ctx.userId} AND ca.ended_at IS NULL))`
    : sql<boolean>`false`;

  const units = await db
    .select()
    .from(careUnits)
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        eq(careUnits.isActive, true),
        inArray(careUnits.type, [
          'GENERAL_WARD',
          'SURGICAL_WARD',
          'ICU',
          'MATERNITY',
          'PAEDIATRIC',
          'NEONATAL',
        ]),
        q.unitId ? eq(careUnits.id, q.unitId) : undefined,
      ),
    )
    .orderBy(asc(careUnits.name));
  const ids = units.map((u) => u.id);
  if (!ids.length) {
    res.json({ units: [], myUnitIds: [] });
    return;
  }
  const [bedRows, stays, mine] = await Promise.all([
    db
      .select()
      .from(beds)
      .where(inArray(beds.unitId, ids))
      .orderBy(sql`length(${beds.label})`, asc(beds.label)),
    db
      .select({
        id: admissions.id,
        unitId: admissions.unitId,
        bedId: admissions.bedId,
        patientId: admissions.patientId,
        firstName: patients.firstName,
        lastName: patients.lastName,
        dateOfBirth: patients.dateOfBirth,
        sex: patients.sex,
        temporaryIdentity: patients.temporaryIdentity,
        attendingDoctorId: admissions.attendingDoctorId,
        attendingDoctorName: attending.fullName,
        source: admissions.source,
        admittedAt: admissions.admittedAt,
        expectedDischargeAt: admissions.expectedDischargeAt,
        reasonVisible,
        reason: admissions.reason,
      })
      .from(admissions)
      .innerJoin(patients, eq(patients.id, admissions.patientId))
      .innerJoin(attending, eq(attending.id, admissions.attendingDoctorId))
      .where(and(inArray(admissions.unitId, ids), eq(admissions.status, 'ADMITTED')))
      .orderBy(asc(admissions.admittedAt)),
    db
      .select({ unitId: unitStaff.unitId })
      .from(unitStaff)
      .where(and(eq(unitStaff.userId, ctx.userId), inArray(unitStaff.unitId, ids))),
  ]);
  const now = Date.now();
  const stayView = (s: (typeof stays)[number]) => ({
    admissionId: s.id,
    patientId: s.patientId,
    firstName: s.firstName,
    lastName: s.lastName,
    dateOfBirth: s.dateOfBirth,
    sex: s.sex,
    temporaryIdentity: s.temporaryIdentity,
    attendingDoctorId: s.attendingDoctorId,
    attendingDoctorName: s.attendingDoctorName,
    source: s.source,
    admittedAt: s.admittedAt,
    daysInHospital: Math.max(0, Math.floor((now - s.admittedAt.getTime()) / 86_400_000)),
    expectedDischargeAt: s.expectedDischargeAt,
    reason: s.reasonVisible ? s.reason : null,
    mine: s.attendingDoctorId === ctx.userId,
  });
  const filtered =
    q.mine === 'true' ? stays.filter((s) => s.attendingDoctorId === ctx.userId) : stays;
  res.json({
    myUnitIds: mine.map((m) => m.unitId),
    units: units.map((u) => {
      const unitBeds = bedRows.filter((b) => b.unitId === u.id);
      const unitStays = filtered.filter((s) => s.unitId === u.id);
      return {
        id: u.id,
        name: u.name,
        code: u.code,
        type: u.type,
        total: unitBeds.length,
        occupied: stays.filter((s) => s.unitId === u.id && s.bedId).length,
        available: unitBeds.filter((b) => b.status === 'AVAILABLE').length,
        beds: unitBeds.map((b) => {
          const stay = unitStays.find((s) => s.bedId === b.id);
          return {
            id: b.id,
            label: b.label,
            status: b.status,
            note: b.note,
            stay: stay ? stayView(stay) : null,
          };
        }),
        /** Admitted without a bed: rooming-in newborns, or waiting for a bed. */
        withoutBed: unitStays.filter((s) => !s.bedId).map(stayView),
      };
    }),
  });
});

/* ------------------------------------------------------------------ admission */

const AdmitSchema = z.object({
  patientId: z.string().uuid(),
  unitId: z.string().uuid(),
  bedId: z.string().uuid().optional().nullable(),
  attendingDoctorId: z.string().uuid().optional(),
  source: z.enum(admissionSourceEnum.enumValues),
  reason: z.string().trim().min(3).max(500),
  expectedDischargeAt: z.coerce.date().optional().nullable(),
  edVisitId: z.string().uuid().optional().nullable(),
});

inpatientRouter.post('/admissions', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(AdmitSchema, req.body);
  if (ctx.role !== 'DOCTOR' || !ctx.facilityId) throw forbidden('Only doctors can admit patients');
  await assertClinicalWriteAccess(ctx, input.patientId, requestMeta(req), WRITERS.doctorOnly);
  const facilityId = ctx.facilityId;
  const unit = await wardAtFacility(input.unitId, facilityId);
  const attendingId = input.attendingDoctorId ?? ctx.userId;
  const [doc] = await db.select().from(users).where(eq(users.id, attendingId));
  if (!doc || doc.role !== 'DOCTOR' || doc.facilityId !== facilityId || !doc.isActive) {
    throw badRequest('The attending doctor must be an active doctor of this facility');
  }

  let admission;
  try {
    admission = await db.transaction(async (tx) => {
      const patient = await getPatientOrThrow(input.patientId, tx);
      assertNotMerged(patient);
      if (input.bedId) await lockAvailableBed(input.bedId, unit.id, tx);
      if (input.edVisitId) {
        const [visit] = await tx
          .select()
          .from(edVisits)
          .where(eq(edVisits.id, input.edVisitId))
          .for('update');
        if (
          !visit ||
          visit.patientId !== input.patientId ||
          visit.facilityId !== facilityId ||
          !['WAITING', 'IN_TREATMENT'].includes(visit.status)
        ) {
          throw badRequest('This emergency attendance cannot be admitted');
        }
      }
      const [row] = await tx
        .insert(admissions)
        .values({
          patientId: input.patientId,
          facilityId,
          unitId: unit.id,
          bedId: input.bedId ?? null,
          admittingDoctorId: ctx.userId,
          attendingDoctorId: attendingId,
          source: input.edVisitId ? 'EMERGENCY' : input.source,
          reason: input.reason,
          edVisitId: input.edVisitId ?? null,
          expectedDischargeAt: input.expectedDischargeAt ?? null,
        })
        .returning();
      if (input.bedId) {
        await tx
          .update(beds)
          .set({ status: 'OCCUPIED', updatedAt: new Date() })
          .where(eq(beds.id, input.bedId));
      }
      await tx.insert(bedMovements).values({
        admissionId: row!.id,
        toUnitId: unit.id,
        toBedId: input.bedId ?? null,
        reason: 'Admission',
        movedById: ctx.userId,
      });
      const [assigned] = await tx
        .select({ id: careAssignments.id })
        .from(careAssignments)
        .where(
          and(
            eq(careAssignments.patientId, input.patientId),
            eq(careAssignments.doctorId, attendingId),
            isNull(careAssignments.endedAt),
          ),
        );
      if (!assigned) {
        await tx.insert(careAssignments).values({
          patientId: input.patientId,
          doctorId: attendingId,
          assignedById: ctx.userId,
        });
      }
      if (input.edVisitId) {
        await tx
          .update(edVisits)
          .set({ status: 'ADMITTED', departedAt: new Date(), admissionId: row!.id })
          .where(eq(edVisits.id, input.edVisitId));
      }
      await audit(
        {
          action: AuditAction.PATIENT_ADMITTED,
          actor: ctx,
          resourceType: 'admission',
          resourceId: row!.id,
          patientId: input.patientId,
          meta: requestMeta(req),
          metadata: { unitId: unit.id, bedId: input.bedId ?? null, source: row!.source },
        },
        tx,
      );
      const nurses = await unitNurses(unit.id, tx);
      await notifyUsers(
        [attendingId, ...nurses].filter((id) => id !== ctx.userId),
        {
          type: 'admission',
          title: 'New admission to {unit}',
          vars: { unit: unit.name },
          link: '/wards',
        },
        tx,
      );
      return row!;
    });
  } catch (err) {
    if (pgUnique(err)) {
      const msg = String((err as { constraint?: string }).constraint ?? '');
      throw conflict(
        msg.includes('bed') ? 'This bed is already occupied' : 'This patient is already admitted',
      );
    }
    throw err;
  }
  res.status(201).json(admission);
});

async function loadAdmission(id: string) {
  const [row] = await db.select().from(admissions).where(eq(admissions.id, id));
  if (!row) throw notFound('Admission not found');
  return row;
}

/** An admission of my facility that the caller may work on clinically. */
async function admissionForClinician(
  ctx: AuthContext,
  id: string,
  meta: ReturnType<typeof requestMeta>,
  roles: ('DOCTOR' | 'NURSE')[] = ['DOCTOR'],
) {
  const row = await loadAdmission(id);
  if (!roles.includes(ctx.role as 'DOCTOR') || ctx.facilityId !== row.facilityId) {
    throw forbidden(
      roles.length === 1 ? 'Only doctors can do this' : 'Only the care team can do this',
    );
  }
  await assertClinicalWriteAccess(ctx, row.patientId, meta, roles);
  return row;
}

inpatientRouter.get('/admissions/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(Id, req.params);
  const row = await loadAdmission(id);
  const basis = await resolveAndAuditRead(ctx, row.patientId, requestMeta(req), 'admissions');
  const [detail] = await stayDetails([row], viewFor(basis).patientView);
  res.json(detail);
});

const TransferSchema = z.object({
  unitId: z.string().uuid(),
  bedId: z.string().uuid().optional().nullable(),
  reason: z.string().trim().min(3).max(300),
});

inpatientRouter.post('/admissions/:id/transfer', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(Id, req.params);
  const input = parse(TransferSchema, req.body);
  const row = await admissionForClinician(ctx, id, requestMeta(req), ['DOCTOR', 'NURSE']);
  if (row.status !== 'ADMITTED') throw conflict('The patient is no longer admitted');
  const unit = await wardAtFacility(input.unitId, row.facilityId);
  if (unit.id === row.unitId && (input.bedId ?? null) === row.bedId) {
    throw badRequest('The patient is already in this bed');
  }
  try {
    const updated = await db.transaction(async (tx) => {
      if (input.bedId) await lockAvailableBed(input.bedId, unit.id, tx);
      if (row.bedId) {
        await tx
          .update(beds)
          .set({ status: 'CLEANING', updatedAt: new Date() })
          .where(eq(beds.id, row.bedId));
      }
      const [u] = await tx
        .update(admissions)
        .set({ unitId: unit.id, bedId: input.bedId ?? null })
        .where(and(eq(admissions.id, id), eq(admissions.status, 'ADMITTED')))
        .returning();
      if (!u) throw conflict('The patient is no longer admitted');
      if (input.bedId) {
        await tx
          .update(beds)
          .set({ status: 'OCCUPIED', updatedAt: new Date() })
          .where(eq(beds.id, input.bedId));
      }
      await tx.insert(bedMovements).values({
        admissionId: id,
        fromUnitId: row.unitId,
        fromBedId: row.bedId,
        toUnitId: unit.id,
        toBedId: input.bedId ?? null,
        reason: input.reason,
        movedById: ctx.userId,
      });
      await audit(
        {
          action: AuditAction.PATIENT_TRANSFERRED,
          actor: ctx,
          resourceType: 'admission',
          resourceId: id,
          patientId: row.patientId,
          meta: requestMeta(req),
          metadata: {
            fromUnitId: row.unitId,
            fromBedId: row.bedId,
            toUnitId: unit.id,
            toBedId: input.bedId ?? null,
          },
        },
        tx,
      );
      if (unit.id !== row.unitId) {
        const nurses = await unitNurses(unit.id, tx);
        await notifyUsers(
          nurses.filter((n) => n !== ctx.userId),
          {
            type: 'admission',
            title: 'A patient is being transferred to {unit}',
            vars: { unit: unit.name },
            link: '/wards',
          },
          tx,
        );
      }
      return u;
    });
    res.json(updated);
  } catch (err) {
    if (pgUnique(err)) throw conflict('This bed is already occupied');
    throw err;
  }
});

inpatientRouter.post('/admissions/:id/cancel', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(Id, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(300) }), req.body);
  const row = await admissionForClinician(ctx, id, requestMeta(req));
  if (row.status !== 'ADMITTED') throw conflict('Only a current admission can be cancelled');
  if (Date.now() - row.admittedAt.getTime() > 24 * 3_600_000) {
    throw conflict('An admission can only be cancelled within 24 hours – discharge instead');
  }
  await db.transaction(async (tx) => {
    await tx.update(admissions).set({ status: 'CANCELLED' }).where(eq(admissions.id, id));
    if (row.bedId) {
      await tx
        .update(beds)
        .set({ status: 'AVAILABLE', updatedAt: new Date() })
        .where(eq(beds.id, row.bedId));
    }
    if (row.edVisitId) {
      await tx
        .update(edVisits)
        .set({ status: 'IN_TREATMENT', departedAt: null, admissionId: null })
        .where(and(eq(edVisits.id, row.edVisitId), eq(edVisits.status, 'ADMITTED')));
    }
    await audit(
      {
        action: AuditAction.PATIENT_DISCHARGED,
        actor: ctx,
        resourceType: 'admission',
        resourceId: id,
        patientId: row.patientId,
        meta: requestMeta(req),
        metadata: { cancelled: true, reason },
      },
      tx,
    );
  });
  res.status(204).end();
});

/* ------------------------------------------------------------------ discharge */

inpatientRouter.get('/admissions/:id/summary-draft', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(Id, req.params);
  const row = await admissionForClinician(ctx, id, requestMeta(req));
  if (row.dischargeSignedAt) {
    res.json({ dischargeSummary: row.dischargeSummary, signed: true });
    return;
  }
  // A saved draft wins over a freshly generated one.
  const text = row.dischargeSummary ?? (await buildSummaryDraft(row, await localeOf(ctx.userId)));
  res.json({ dischargeSummary: text, signed: false, generated: !row.dischargeSummary });
});

inpatientRouter.put('/admissions/:id/summary', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(Id, req.params);
  const { dischargeSummary } = parse(
    z.object({ dischargeSummary: z.string().trim().min(1).max(20_000) }),
    req.body,
  );
  const row = await admissionForClinician(ctx, id, requestMeta(req));
  if (row.dischargeSignedAt) throw conflict('The discharge summary is already signed');
  if (row.status === 'CANCELLED') throw conflict('This admission was cancelled');
  await db.update(admissions).set({ dischargeSummary }).where(eq(admissions.id, id));
  res.json({ saved: true });
});

const DischargeSchema = z.object({
  disposition: z.enum(dischargeDispositionEnum.enumValues),
  dischargeSummary: z.string().trim().min(20, 'Write the discharge summary').max(20_000),
  followUp: z.string().trim().max(1000).optional(),
});

inpatientRouter.post('/admissions/:id/discharge', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(Id, req.params);
  const input = parse(DischargeSchema, req.body);
  const row = await admissionForClinician(ctx, id, requestMeta(req));
  if (row.status !== 'ADMITTED') throw conflict('The patient is not currently admitted');
  const locale = await localeOf(ctx.userId);
  const summary = input.followUp
    ? `${input.dischargeSummary}\n\n${tr(locale, 'Follow-up')}: ${input.followUp}`
    : input.dischargeSummary;
  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(admissions)
      .set({
        status: 'DISCHARGED',
        dischargedAt: now,
        dischargedById: ctx.userId,
        disposition: input.disposition,
        dischargeSummary: summary,
        dischargeSignedAt: now,
      })
      .where(and(eq(admissions.id, id), eq(admissions.status, 'ADMITTED')))
      .returning();
    if (!u) throw conflict('The patient is not currently admitted');
    if (row.bedId) {
      await tx
        .update(beds)
        .set({ status: 'CLEANING', updatedAt: now })
        .where(eq(beds.id, row.bedId));
    }
    const base = {
      actor: ctx,
      resourceType: 'admission',
      resourceId: id,
      patientId: row.patientId,
      meta: requestMeta(req),
    };
    await audit(
      {
        ...base,
        action: AuditAction.PATIENT_DISCHARGED,
        metadata: { disposition: input.disposition },
      },
      tx,
    );
    await audit({ ...base, action: AuditAction.DISCHARGE_SUMMARY_SIGNED }, tx);
    const nurses = await unitNurses(row.unitId, tx);
    await notifyUsers(
      nurses.filter((n) => n !== ctx.userId),
      {
        type: 'admission',
        title: 'A patient was discharged – the bed needs cleaning',
        link: '/wards',
      },
      tx,
    );
    return u;
  });
  res.json(updated);
});

inpatientRouter.post('/admissions/:id/release', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(Id, req.params);
  const row = await admissionForClinician(ctx, id, requestMeta(req));
  if (!row.dischargeSignedAt) throw conflict('Sign the discharge summary before releasing it');
  if (row.releasedToPatientAt) throw conflict('Already released to the patient');
  await db.transaction(async (tx) => {
    await tx
      .update(admissions)
      .set({ releasedToPatientAt: new Date() })
      .where(eq(admissions.id, id));
    await audit(
      {
        action: AuditAction.DISCHARGE_SUMMARY_SIGNED,
        actor: ctx,
        resourceType: 'admission',
        resourceId: id,
        patientId: row.patientId,
        meta: requestMeta(req),
        metadata: { released: true },
      },
      tx,
    );
    await notifyPatient(
      row.patientId,
      {
        type: 'admission',
        title: 'Your discharge letter is available',
        link: '/portal/stays',
        important: true,
      },
      tx,
    );
  });
  res.json({ released: true });
});

/* ------------------------------------------------------------------ a patient's stays */

async function stayDetails(rows: (typeof admissions.$inferSelect)[], patientView: boolean) {
  const ids = rows.map((r) => r.id);
  const moves = ids.length
    ? await db
        .select()
        .from(bedMovements)
        .where(inArray(bedMovements.admissionId, ids))
        .orderBy(asc(bedMovements.movedAt))
    : [];
  const unitIds = [
    ...new Set([
      ...rows.map((r) => r.unitId),
      ...moves.flatMap((m) => [m.toUnitId, m.fromUnitId].filter((x): x is string => Boolean(x))),
    ]),
  ];
  const bedIds = [
    ...new Set(
      [...rows.map((r) => r.bedId), ...moves.flatMap((m) => [m.toBedId, m.fromBedId])].filter(
        (x): x is string => Boolean(x),
      ),
    ),
  ];
  const doctorIds = [
    ...new Set(rows.flatMap((r) => [r.attendingDoctorId, r.admittingDoctorId, r.dischargedById])),
  ].filter((x): x is string => Boolean(x));
  const [units, bedMap, doctors] = await Promise.all([
    unitNames(unitIds),
    bedLabels(bedIds),
    doctorIds.length
      ? db
          .select({ id: users.id, name: users.fullName })
          .from(users)
          .where(inArray(users.id, doctorIds))
      : [],
  ]);
  const doc = new Map(doctors.map((d) => [d.id, d.name]));
  return rows.map((r) => {
    const showSummary = !patientView || Boolean(r.releasedToPatientAt);
    return {
      id: r.id,
      patientId: r.patientId,
      status: r.status,
      source: r.source,
      reason: r.reason,
      unitId: r.unitId,
      unitName: units.get(r.unitId) ?? null,
      bedId: r.bedId,
      bedLabel: r.bedId ? (bedMap.get(r.bedId) ?? null) : null,
      attendingDoctorId: r.attendingDoctorId,
      attendingDoctorName: doc.get(r.attendingDoctorId) ?? null,
      admittingDoctorName: doc.get(r.admittingDoctorId) ?? null,
      admittedAt: r.admittedAt,
      expectedDischargeAt: r.expectedDischargeAt,
      dischargedAt: r.dischargedAt,
      dischargedByName: r.dischargedById ? (doc.get(r.dischargedById) ?? null) : null,
      disposition: r.disposition,
      dischargeSummary:
        showSummary && (!patientView || r.dischargeSignedAt) ? r.dischargeSummary : null,
      summarySigned: Boolean(r.dischargeSignedAt),
      dischargeSignedAt: r.dischargeSignedAt,
      releasedToPatientAt: r.releasedToPatientAt,
      edVisitId: r.edVisitId,
      movements: patientView
        ? []
        : moves
            .filter((m) => m.admissionId === r.id)
            .map((m) => ({
              id: m.id,
              movedAt: m.movedAt,
              reason: m.reason,
              fromUnitName: m.fromUnitId ? (units.get(m.fromUnitId) ?? null) : null,
              fromBedLabel: m.fromBedId ? (bedMap.get(m.fromBedId) ?? null) : null,
              toUnitName: units.get(m.toUnitId) ?? null,
              toBedLabel: m.toBedId ? (bedMap.get(m.toBedId) ?? null) : null,
            })),
    };
  });
}

inpatientRouter.get('/patients/:patientId/admissions', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(z.object({ patientId: z.string().uuid() }), req.params);
  const basis = await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'admissions');
  const { patientView } = viewFor(basis);
  const rows = await db
    .select()
    .from(admissions)
    .where(
      and(
        eq(admissions.patientId, patientId),
        patientView ? ne(admissions.status, 'CANCELLED') : undefined,
      ),
    )
    .orderBy(desc(admissions.admittedAt))
    .limit(100);
  res.json({ items: await stayDetails(rows, patientView) });
});

/** Today's movement at my facility (dashboard): admissions, discharges, available beds. */
inpatientRouter.get('/today', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertFacilityStaff(ctx);
  const result = await db.execute<{
    admissions: number;
    discharges: number;
    inpatients: number;
    beds: number;
    available: number;
    expectedToday: number;
  }>(sql`
    SELECT
      (SELECT count(*)::int FROM admissions a WHERE a.facility_id = ${facilityId}
        AND a.status <> 'CANCELLED' AND a.admitted_at >= date_trunc('day', now())) AS admissions,
      (SELECT count(*)::int FROM admissions a WHERE a.facility_id = ${facilityId}
        AND a.status = 'DISCHARGED' AND a.discharged_at >= date_trunc('day', now())) AS discharges,
      (SELECT count(*)::int FROM admissions a WHERE a.facility_id = ${facilityId}
        AND a.status = 'ADMITTED') AS inpatients,
      (SELECT count(*)::int FROM beds b JOIN care_units u ON u.id = b.unit_id
        WHERE u.facility_id = ${facilityId} AND u.is_active) AS beds,
      (SELECT count(*)::int FROM beds b JOIN care_units u ON u.id = b.unit_id
        WHERE u.facility_id = ${facilityId} AND u.is_active AND b.status = 'AVAILABLE') AS available,
      (SELECT count(*)::int FROM admissions a WHERE a.facility_id = ${facilityId}
        AND a.status = 'ADMITTED' AND a.expected_discharge_at < date_trunc('day', now()) + interval '1 day') AS "expectedToday"`);
  res.json(result.rows[0]);
});

/** Doctors of my facility who can be attending (for the admit dialog). */
inpatientRouter.get('/doctors', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertFacilityStaff(ctx);
  const rows = await db
    .select({ id: users.id, fullName: users.fullName, specialty: users.specialty })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DOCTOR'), eq(users.isActive, true)),
    )
    .orderBy(asc(users.fullName));
  res.json({ items: rows });
});

/** Staff who can be assigned to units (director). */
inpatientRouter.get('/assignable-staff', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = assertDirector(ctx);
  const rows = await db
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
        inArray(users.role, ['DOCTOR', 'NURSE', 'RECEPTION']),
        eq(users.isActive, true),
      ),
    )
    .orderBy(asc(users.role), asc(users.fullName));
  res.json({ items: rows });
});
