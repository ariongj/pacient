import { Router } from 'express';
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  ambulanceUnits,
  careUnits,
  edVisits,
  emsCareRecords,
  emsIncidents,
  facilities,
  patients,
  sexEnum,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertNotMerged,
  auditRecordView,
  resolveAndAuditRead,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { OPEN_STATUSES as ED_OPEN_STATUSES } from '../ed/ed.service.js';
import {
  kosovoDate,
  newTemporaryNumber,
  shortCode,
  UNKNOWN_FIRST_NAME,
} from '../identity/identity.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  ageBandOf,
  earlyWarningFor,
  edClinicianIds,
  edUnitsOf,
  isEdClinicianAt,
  isServiceStaff,
  minutesBetween,
  myServices,
  nextReference,
  observationsOf,
  OBSERVATION_RANGES,
  ON_SCENE_OUTCOMES,
  OPEN_STATUSES,
  OUTCOMES,
  P1_TARGET_MINUTES,
  PRIORITIES,
  priorityFor,
  serviceUnit,
  type EmsStatus,
} from './ems.service.js';

/**
 * Ambulance service (see ems.service.ts). Staff of an AMBULANCE_SERVICE unit take calls, dispatch
 * vehicles and record pre-hospital care; the destination emergency department sees incoming
 * ambulances and takes the handover, which opens the attendance. Directors and the Ministry see
 * statistics only.
 */
export const emsRouter = Router();
emsRouter.use(authenticate);

const IdParam = z.object({ id: z.string().uuid() });
const ServiceQuery = z.object({ serviceId: z.string().uuid().optional() });

type Incident = typeof emsIncidents.$inferSelect;

async function loadIncident(id: string) {
  const [row] = await db.select().from(emsIncidents).where(eq(emsIncidents.id, id));
  if (!row) throw notFound('Ambulance call not found');
  return row;
}

/** Crew and dispatchers of the incident's service. */
async function incidentForStaff(ctx: AuthContext, id: string) {
  const row = await loadIncident(id);
  if (!(await isServiceStaff(ctx, row.serviceUnitId))) throw notFound('Ambulance call not found');
  return row;
}

/** Picks the caller's service: the one asked for (must be theirs) or their only/first one. */
async function serviceFor(ctx: AuthContext, serviceId?: string) {
  const mine = await myServices(ctx);
  if (serviceId) {
    const found = mine.find((s) => s.id === serviceId);
    if (!found) throw forbidden('Only staff of this ambulance service can do this');
    return found;
  }
  const first = mine[0];
  if (!first) throw forbidden('You are not assigned to an ambulance service');
  return first;
}

async function auditUpdate(
  ctx: AuthContext,
  row: Incident,
  meta: ReturnType<typeof requestMeta>,
  metadata: Record<string, unknown>,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db = db,
) {
  await audit(
    {
      action: AuditAction.EMS_INCIDENT_UPDATED,
      actor: ctx,
      resourceType: 'ems_incident',
      resourceId: row.id,
      patientId: row.patientId,
      meta,
      metadata: { reference: row.reference, ...metadata },
    },
    tx,
  );
}

/* ------------------------------------------------------------------ services & vehicles --- */

/** The services the caller works in (crew and dispatch) and whether they can see statistics. */
emsRouter.get('/services', async (req, res) => {
  const ctx = requireAuth(req);
  const mine = await myServices(ctx);
  let atFacility: { id: string; name: string; code: string }[] = [];
  if (ctx.role === 'DIRECTOR' && ctx.facilityId) {
    atFacility = await db
      .select({ id: careUnits.id, name: careUnits.name, code: careUnits.code })
      .from(careUnits)
      .where(
        and(eq(careUnits.facilityId, ctx.facilityId), eq(careUnits.type, 'AMBULANCE_SERVICE')),
      );
  }
  const canTakeHandover =
    ctx.facilityId !== null ? await isEdClinicianAt(ctx, ctx.facilityId) : false;
  res.json({
    mine,
    atFacility,
    canSeeStats: ctx.role === 'MINISTRY' || (ctx.role === 'DIRECTOR' && atFacility.length > 0),
    canTakeHandover,
    p1TargetMinutes: P1_TARGET_MINUTES,
  });
});

/** Facilities with an emergency department (transport destinations). */
emsRouter.get('/destinations', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!(await myServices(ctx)).length)
    throw forbidden('You are not assigned to an ambulance service');
  const rows = await db
    .selectDistinct({
      id: facilities.id,
      name: facilities.name,
      code: facilities.code,
      municipality: facilities.municipality,
    })
    .from(facilities)
    .innerJoin(careUnits, eq(careUnits.facilityId, facilities.id))
    .where(
      and(
        eq(careUnits.type, 'EMERGENCY'),
        eq(careUnits.isActive, true),
        eq(facilities.isActive, true),
      ),
    )
    .orderBy(asc(facilities.name));
  res.json({ items: rows });
});

const VehicleInput = z.object({
  serviceId: z.string().uuid(),
  callSign: z.string().trim().min(2).max(20),
  level: z.enum(['BLS', 'ALS']),
});

/** Directors add vehicles to an ambulance service of their facility. */
emsRouter.post('/vehicles', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(VehicleInput, req.body);
  const unit = await serviceUnit(input.serviceId);
  if (unit.facilityId !== ctx.facilityId) throw notFound('Ambulance service not found');
  const [existing] = await db
    .select({ id: ambulanceUnits.id })
    .from(ambulanceUnits)
    .where(eq(ambulanceUnits.callSign, input.callSign));
  if (existing) throw conflict('A vehicle with this call sign already exists');
  const [row] = await db
    .insert(ambulanceUnits)
    .values({ stationUnitId: unit.id, callSign: input.callSign, level: input.level })
    .returning();
  await audit({
    action: AuditAction.EMS_INCIDENT_UPDATED,
    actor: ctx,
    resourceType: 'ambulance_unit',
    resourceId: row!.id,
    meta: requestMeta(req),
    metadata: { callSign: row!.callSign, change: 'vehicle_added' },
  });
  res.status(201).json(row);
});

const VehicleStatusInput = z.object({ status: z.enum(['AVAILABLE', 'OUT_OF_SERVICE']) });

/** Take an idle vehicle out of service (or back): crew of the service or the director. */
emsRouter.patch('/vehicles/:id', requireRole('DOCTOR', 'NURSE', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { status } = parse(VehicleStatusInput, req.body);
  const [vehicle] = await db.select().from(ambulanceUnits).where(eq(ambulanceUnits.id, id));
  if (!vehicle) throw notFound('Vehicle not found');
  const unit = await serviceUnit(vehicle.stationUnitId);
  const allowed =
    ctx.role === 'DIRECTOR'
      ? unit.facilityId === ctx.facilityId
      : await isServiceStaff(ctx, unit.id);
  if (!allowed) throw notFound('Vehicle not found');
  if (!['AVAILABLE', 'OUT_OF_SERVICE'].includes(vehicle.status)) {
    throw conflict('The vehicle is on a call');
  }
  const [updated] = await db
    .update(ambulanceUnits)
    .set({ status })
    .where(eq(ambulanceUnits.id, id))
    .returning();
  await audit({
    action: AuditAction.EMS_INCIDENT_UPDATED,
    actor: ctx,
    resourceType: 'ambulance_unit',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { callSign: vehicle.callSign, status },
  });
  res.json(updated);
});

/* ------------------------------------------------------------------ board ---------------- */

const patientCols = {
  id: patients.id,
  firstName: patients.firstName,
  lastName: patients.lastName,
  nationalId: patients.nationalId,
  dateOfBirth: patients.dateOfBirth,
  sex: patients.sex,
  temporaryIdentity: patients.temporaryIdentity,
};

/** Open calls (by priority, oldest first) and the service's vehicles. */
emsRouter.get('/board', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { serviceId } = parse(ServiceQuery, req.query);
  const service = await serviceFor(ctx, serviceId);
  const [items, vehicles] = await Promise.all([
    db
      .select({ incident: emsIncidents, patient: patientCols, vehicle: ambulanceUnits.callSign })
      .from(emsIncidents)
      .leftJoin(patients, eq(patients.id, emsIncidents.patientId))
      .leftJoin(ambulanceUnits, eq(ambulanceUnits.id, emsIncidents.ambulanceUnitId))
      .where(
        and(
          eq(emsIncidents.serviceUnitId, service.id),
          inArray(emsIncidents.status, OPEN_STATUSES),
        ),
      )
      .orderBy(asc(emsIncidents.priority), asc(emsIncidents.receivedAt)),
    db
      .select()
      .from(ambulanceUnits)
      .where(and(eq(ambulanceUnits.stationUnitId, service.id), eq(ambulanceUnits.isActive, true)))
      .orderBy(asc(ambulanceUnits.callSign)),
  ]);
  const now = new Date();
  res.json({
    service,
    now,
    items: items.map(({ incident, patient, vehicle }) => ({
      ...summary(incident),
      vehicle,
      patient: patient?.id ? patient : null,
      elapsedMinutes: minutesBetween(incident.receivedAt, now),
    })),
    vehicles,
  });
});

/** What any authorised viewer sees of a call (care records are added separately). */
function summary(r: Incident) {
  return {
    id: r.id,
    reference: r.reference,
    serviceUnitId: r.serviceUnitId,
    receivedAt: r.receivedAt,
    callerName: r.callerName,
    callerPhone: r.callerPhone,
    address: r.address,
    municipality: r.municipality,
    latitude: r.latitude,
    longitude: r.longitude,
    complaint: r.complaint,
    priority: r.priority,
    status: r.status,
    patientId: r.patientId,
    patientDescription: r.patientDescription,
    ambulanceUnitId: r.ambulanceUnitId,
    dispatchedAt: r.dispatchedAt,
    onSceneAt: r.onSceneAt,
    leftSceneAt: r.leftSceneAt,
    expectedAt: r.expectedAt,
    atHospitalAt: r.atHospitalAt,
    handedOverAt: r.handedOverAt,
    destinationFacilityId: r.destinationFacilityId,
    edVisitId: r.edVisitId,
    outcome: r.outcome,
    closedAt: r.closedAt,
    callToDispatchMinutes: minutesBetween(r.receivedAt, r.dispatchedAt),
    responseMinutes: minutesBetween(r.dispatchedAt, r.onSceneAt),
  };
}

/* ------------------------------------------------------------------ calls ---------------- */

const Answers = z.object({
  conscious: z.boolean(),
  breathingNormally: z.boolean(),
  chestPain: z.boolean().optional(),
  majorBleeding: z.boolean().optional(),
  strokeSigns: z.boolean().optional(),
  seriousInjury: z.boolean().optional(),
  severePain: z.boolean().optional(),
});

const CallInput = z
  .object({
    serviceId: z.string().uuid().optional(),
    receivedAt: z.coerce.date().optional(),
    callerName: z.string().trim().max(200).optional().nullable(),
    callerPhone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{6,40}$/, 'Enter a valid phone number')
      .optional()
      .nullable(),
    address: z.string().trim().min(3).max(300),
    municipality: z.string().trim().max(100).optional().nullable(),
    latitude: z.number().min(-90).max(90).optional().nullable(),
    longitude: z.number().min(-180).max(180).optional().nullable(),
    complaint: z.string().trim().min(3).max(300),
    answers: Answers,
    /** The dispatcher may raise or lower the computed category, with a reason. */
    priority: z.enum(PRIORITIES).optional(),
    priorityReason: z.string().trim().min(5).max(300).optional(),
    patientDescription: z.string().trim().max(300).optional().nullable(),
  })
  .refine((v) => (v.latitude == null) === (v.longitude == null), {
    message: 'Give both coordinates or neither',
    path: ['longitude'],
  });

/** Record an emergency call. */
emsRouter.post('/incidents', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(CallInput, req.body);
  const service = await serviceFor(ctx, input.serviceId);
  const computed = priorityFor(input.answers);
  const priority = input.priority ?? computed;
  if (priority !== computed && !input.priorityReason) {
    throw badRequest('Give the reason for changing the category', [
      { path: 'priorityReason', message: 'Give the reason for changing the category' },
    ]);
  }
  const receivedAt = input.receivedAt ?? new Date();
  if (receivedAt.getTime() > Date.now() + 5 * 60_000) {
    throw badRequest('The call time cannot be in the future');
  }
  const meta = requestMeta(req);
  const created = await db.transaction(async (tx) => {
    const reference = await nextReference(tx, receivedAt);
    const [row] = await tx
      .insert(emsIncidents)
      .values({
        reference,
        serviceUnitId: service.id,
        receivedAt,
        callerName: input.callerName ?? null,
        callerPhone: input.callerPhone ?? null,
        address: input.address,
        municipality: input.municipality ?? null,
        latitude: input.latitude?.toString() ?? null,
        longitude: input.longitude?.toString() ?? null,
        complaint: input.complaint,
        priority,
        patientDescription: input.patientDescription ?? null,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.EMS_INCIDENT_CREATED,
        actor: ctx,
        resourceType: 'ems_incident',
        resourceId: row!.id,
        meta,
        metadata: {
          reference,
          priority,
          computedPriority: computed,
          priorityReason: input.priorityReason ?? null,
        },
      },
      tx,
    );
    return row!;
  });
  res.status(201).json({ ...summary(created), computedPriority: computed });
});

/** A call with its pre-hospital record: crew of the service, or the destination ED. */
emsRouter.get('/incidents/:id', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const row = await loadIncident(id);
  const staff = await isServiceStaff(ctx, row.serviceUnitId);
  const edView =
    !staff &&
    row.destinationFacilityId !== null &&
    (row.status === 'TRANSPORTING' ||
      row.status === 'HANDED_OVER' ||
      (row.status === 'CLOSED' && row.edVisitId !== null)) &&
    (await isEdClinicianAt(ctx, row.destinationFacilityId));
  const meta = requestMeta(req);
  if (!staff && !edView) {
    // After the handover the crew's record belongs to the patient's record: anyone who may read
    // the chart (e.g. the ward that admitted the patient) sees what was given before hospital.
    const handedOver = row.status === 'HANDED_OVER' || (row.status === 'CLOSED' && row.edVisitId);
    if (!row.patientId || !handedOver) throw notFound('Ambulance call not found');
    await resolveAndAuditRead(ctx, row.patientId, meta, 'ems_incident');
  } else if (row.patientId) {
    await auditRecordView(ctx, row.patientId, 'UNIT', 'ems_incident', meta);
  }
  res.json(await present(row, staff));
});

async function present(row: Incident, staff: boolean) {
  const [patient] = row.patientId
    ? await db.select(patientCols).from(patients).where(eq(patients.id, row.patientId))
    : [];
  const records = await db
    .select({
      id: emsCareRecords.id,
      kind: emsCareRecords.kind,
      recordedAt: emsCareRecords.recordedAt,
      data: emsCareRecords.data,
      text: emsCareRecords.text,
      recordedBy: users.fullName,
    })
    .from(emsCareRecords)
    .innerJoin(users, eq(users.id, emsCareRecords.recordedById))
    .where(eq(emsCareRecords.incidentId, row.id))
    .orderBy(asc(emsCareRecords.recordedAt));
  const [vehicle] = row.ambulanceUnitId
    ? await db.select().from(ambulanceUnits).where(eq(ambulanceUnits.id, row.ambulanceUnitId))
    : [];
  const [destination] = row.destinationFacilityId
    ? await db
        .select({ id: facilities.id, name: facilities.name })
        .from(facilities)
        .where(eq(facilities.id, row.destinationFacilityId))
    : [];
  const warning = earlyWarningFor(
    records
      .filter((r) => r.kind === 'OBSERVATION')
      .map((r) => ({ recordedAt: r.recordedAt, data: r.data })),
    patient?.dateOfBirth ?? null,
  );
  const base = summary(row);
  const identityWithheld = !staff && row.status === 'TRANSPORTING' && Boolean(patient);
  return {
    ...base,
    // The receiving ED needs the patient and the clinical record, not who called or the exact
    // address of the scene (the municipality stays).
    ...(staff
      ? {}
      : { callerName: null, callerPhone: null, address: null, latitude: null, longitude: null }),
    // As on the incoming list: no identity for the ED before it takes over the patient.
    patient: identityWithheld ? null : (patient ?? null),
    identityWithheld,
    vehicle: vehicle ? { id: vehicle.id, callSign: vehicle.callSign, level: vehicle.level } : null,
    destination: destination ?? null,
    careRecords: records,
    earlyWarning: warning
      ? {
          scale: warning.scale,
          score: warning.result.score,
          risk: warning.result.risk,
          complete: warning.result.complete,
          recordedAt: warning.recordedAt,
        }
      : null,
    canAct: staff,
  };
}

/* ------------------------------------------------------------------ patient --------------- */

const LinkInput = z.union([
  z.object({
    nationalId: z
      .string()
      .trim()
      .regex(/^\d{10}$/, 'A national ID has 10 digits'),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  z.object({
    unidentified: z.object({
      sex: z.enum(sexEnum.enumValues),
      estimatedAge: z.number().int().min(0).max(120),
      note: z.string().trim().min(3).max(300),
    }),
  }),
]);

/**
 * Link the person: by national ID AND date of birth (both must match – no look-up by either alone),
 * or as an unidentified patient with a temporary number. Once linked the crew has access to the
 * patient's record while the call is open (see access/policy.ts).
 */
emsRouter.post('/incidents/:id/patient', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(LinkInput, req.body);
  const meta = requestMeta(req);
  const row = await incidentForStaff(ctx, id);
  if (!OPEN_STATUSES.includes(row.status as EmsStatus) || row.status === 'HANDED_OVER') {
    throw conflict('The patient can only be linked while the call is open');
  }
  if (row.patientId) throw conflict('A patient is already linked to this call');
  const service = await serviceUnit(row.serviceUnitId);
  const updated = await db.transaction(async (tx) => {
    let patientId: string;
    if ('nationalId' in input) {
      const [p] = await tx
        .select()
        .from(patients)
        .where(
          and(
            eq(patients.nationalId, input.nationalId),
            eq(patients.dateOfBirth, input.dateOfBirth),
          ),
        );
      await audit(
        {
          action: AuditAction.PATIENT_SEARCHED,
          actor: ctx,
          meta,
          outcome: p ? 'SUCCESS' : 'FAILURE',
          resourceType: 'ems_incident',
          resourceId: row.id,
          metadata: { purpose: 'ambulance_call', matched: Boolean(p) },
        },
        tx,
      );
      if (!p) throw notFound('No patient with this national ID and date of birth');
      assertNotMerged(p);
      patientId = p.id;
    } else {
      const u = input.unidentified;
      const thisYear = Number(kosovoDate(new Date()).slice(0, 4));
      const number = await newTemporaryNumber(tx);
      const [p] = await tx
        .insert(patients)
        .values({
          nationalId: number,
          firstName: UNKNOWN_FIRST_NAME,
          lastName: shortCode(number),
          dateOfBirth: `${thisYear - u.estimatedAge}-01-01`,
          sex: u.sex,
          primaryFacilityId: service.facilityId,
          temporaryIdentity: 'UNIDENTIFIED',
          identityNote: u.note,
        })
        .returning();
      await audit(
        {
          action: AuditAction.TEMPORARY_PATIENT_REGISTERED,
          actor: ctx,
          resourceType: 'patient',
          resourceId: p!.id,
          patientId: p!.id,
          meta,
          metadata: { kind: 'UNIDENTIFIED', temporaryNumber: number, emsIncidentId: row.id },
        },
        tx,
      );
      patientId = p!.id;
    }
    const [u] = await tx
      .update(emsIncidents)
      .set({ patientId })
      .where(eq(emsIncidents.id, row.id))
      .returning();
    await auditUpdate(ctx, u!, meta, { change: 'patient_linked' }, tx);
    return u!;
  });
  res.json(await present(updated, true));
});

/* ------------------------------------------------------------------ dispatch & status ----- */

const DispatchInput = z.object({ ambulanceUnitId: z.string().uuid() });

/** Assign an available vehicle of the service (row lock: one active call per vehicle). */
emsRouter.post('/incidents/:id/dispatch', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { ambulanceUnitId } = parse(DispatchInput, req.body);
  const meta = requestMeta(req);
  await incidentForStaff(ctx, id);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(emsIncidents).where(eq(emsIncidents.id, id)).for('update');
    if (row!.status !== 'RECEIVED') throw conflict('This call has already been dispatched');
    const [vehicle] = await tx
      .select()
      .from(ambulanceUnits)
      .where(eq(ambulanceUnits.id, ambulanceUnitId))
      .for('update');
    if (!vehicle || vehicle.stationUnitId !== row!.serviceUnitId || !vehicle.isActive) {
      throw notFound('Vehicle not found');
    }
    if (vehicle.status !== 'AVAILABLE') throw conflict('This vehicle is not available');
    const now = new Date();
    await tx
      .update(ambulanceUnits)
      .set({ status: 'DISPATCHED' })
      .where(eq(ambulanceUnits.id, vehicle.id));
    const [u] = await tx
      .update(emsIncidents)
      .set({ status: 'DISPATCHED', ambulanceUnitId: vehicle.id, dispatchedAt: now })
      .where(eq(emsIncidents.id, id))
      .returning();
    await auditUpdate(ctx, u!, meta, { status: 'DISPATCHED', callSign: vehicle.callSign }, tx);
    return u!;
  });
  res.json(await present(updated, true));
});

const StatusInput = z.object({
  status: z.enum(['ON_SCENE', 'TRANSPORTING', 'AT_HOSPITAL']),
  /** Required when leaving for hospital: where to and the expected time in minutes. */
  destinationFacilityId: z.string().uuid().optional(),
  etaMinutes: z.number().int().min(1).max(240).optional(),
});

const NEXT: Record<string, EmsStatus> = {
  ON_SCENE: 'DISPATCHED',
  TRANSPORTING: 'ON_SCENE',
};
const VEHICLE_FOR: Record<string, string> = {
  ON_SCENE: 'ON_SCENE',
  TRANSPORTING: 'TRANSPORTING',
  AT_HOSPITAL: 'AT_HOSPITAL',
};

/** Crew progress: on scene → transporting (with destination, pre-alerting the ED) → at hospital. */
emsRouter.post('/incidents/:id/status', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(StatusInput, req.body);
  const meta = requestMeta(req);
  await incidentForStaff(ctx, id);
  if (input.status === 'TRANSPORTING') {
    if (!input.destinationFacilityId || !input.etaMinutes) {
      throw badRequest('Choose the destination hospital and the expected arrival time');
    }
    if (!(await edUnitsOf(input.destinationFacilityId)).length) {
      throw badRequest('The destination has no emergency department');
    }
  }
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(emsIncidents).where(eq(emsIncidents.id, id)).for('update');
    const r = row!;
    if (input.status === 'AT_HOSPITAL') {
      if (r.status !== 'TRANSPORTING' || r.atHospitalAt) {
        throw conflict('The ambulance is not transporting a patient');
      }
    } else if (r.status !== NEXT[input.status]) {
      throw conflict('This step does not follow the current status of the call');
    }
    const now = new Date();
    const set: Partial<Incident> =
      input.status === 'ON_SCENE'
        ? { status: 'ON_SCENE', onSceneAt: now }
        : input.status === 'TRANSPORTING'
          ? {
              status: 'TRANSPORTING',
              leftSceneAt: now,
              expectedAt: new Date(now.getTime() + input.etaMinutes! * 60_000),
              destinationFacilityId: input.destinationFacilityId!,
            }
          : { atHospitalAt: now };
    const [u] = await tx.update(emsIncidents).set(set).where(eq(emsIncidents.id, id)).returning();
    if (r.ambulanceUnitId) {
      await tx
        .update(ambulanceUnits)
        .set({ status: VEHICLE_FOR[input.status]! })
        .where(eq(ambulanceUnits.id, r.ambulanceUnitId));
    }
    await auditUpdate(
      ctx,
      u!,
      meta,
      { status: input.status, destinationFacilityId: input.destinationFacilityId ?? null },
      tx,
    );
    if (input.status === 'TRANSPORTING') {
      await preAlert(u!, input.etaMinutes!, tx);
    }
    return u!;
  });
  res.json(await present(result, true));
});

/**
 * Pre-alert to the destination emergency department: priority and arrival time only. Titles can go
 * out by SMS or e-mail, so the complaint stays in the ED view behind sign-in.
 */
async function preAlert(
  row: Incident,
  etaMinutes: number,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
) {
  if (!row.destinationFacilityId) return;
  const recipients = await edClinicianIds(row.destinationFacilityId, tx);
  await notifyUsers(
    recipients,
    {
      type: 'ems_prealert',
      title: 'Ambulance {priority} arriving in about {minutes} min',
      vars: { priority: row.priority, minutes: etaMinutes },
      link: '/ed',
    },
    tx,
  );
}

const DestinationInput = z.object({
  destinationFacilityId: z.string().uuid(),
  etaMinutes: z.number().int().min(1).max(240),
});

/** Change the destination while transporting (the new ED is pre-alerted). */
emsRouter.post('/incidents/:id/destination', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(DestinationInput, req.body);
  const row = await incidentForStaff(ctx, id);
  if (row.status !== 'TRANSPORTING' || row.atHospitalAt) {
    throw conflict('The destination can only change while transporting');
  }
  if (!(await edUnitsOf(input.destinationFacilityId)).length) {
    throw badRequest('The destination has no emergency department');
  }
  const meta = requestMeta(req);
  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(emsIncidents)
      .set({ destinationFacilityId: input.destinationFacilityId })
      .where(eq(emsIncidents.id, id))
      .returning();
    await auditUpdate(ctx, u!, meta, { destinationFacilityId: input.destinationFacilityId }, tx);
    await preAlert(u!, input.etaMinutes, tx);
    return u!;
  });
  res.json(await present(updated, true));
});

const CloseInput = z.object({ outcome: z.enum(OUTCOMES).exclude(['CANCELLED']) });

/**
 * Close a call: on scene without transport (treated, refused, deceased, no patient), or after the
 * handover (outcome TRANSPORTED). The vehicle becomes available again.
 */
emsRouter.post('/incidents/:id/close', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { outcome } = parse(CloseInput, req.body);
  const meta = requestMeta(req);
  await incidentForStaff(ctx, id);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(emsIncidents).where(eq(emsIncidents.id, id)).for('update');
    const r = row!;
    const ok =
      (r.status === 'ON_SCENE' && ON_SCENE_OUTCOMES.includes(outcome)) ||
      (r.status === 'HANDED_OVER' && outcome === 'TRANSPORTED');
    if (!ok) throw conflict('This outcome does not fit the current status of the call');
    const now = new Date();
    const [u] = await tx
      .update(emsIncidents)
      .set({ status: 'CLOSED', outcome, closedAt: now })
      .where(eq(emsIncidents.id, id))
      .returning();
    if (r.ambulanceUnitId) {
      await tx
        .update(ambulanceUnits)
        .set({ status: 'AVAILABLE' })
        .where(eq(ambulanceUnits.id, r.ambulanceUnitId));
    }
    await auditUpdate(ctx, u!, meta, { status: 'CLOSED', outcome }, tx);
    return u!;
  });
  res.json(await present(updated, true));
});

const CancelInput = z.object({ reason: z.string().trim().min(3).max(300) });

/** Cancel a call before the crew reaches the scene (duplicate call, hoax, no longer needed). */
emsRouter.post('/incidents/:id/cancel', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(CancelInput, req.body);
  const meta = requestMeta(req);
  await incidentForStaff(ctx, id);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(emsIncidents).where(eq(emsIncidents.id, id)).for('update');
    const r = row!;
    if (r.status !== 'RECEIVED' && r.status !== 'DISPATCHED') {
      throw conflict('Only a call not yet reached on scene can be cancelled');
    }
    const [u] = await tx
      .update(emsIncidents)
      .set({ status: 'CANCELLED', outcome: 'CANCELLED', closedAt: new Date() })
      .where(eq(emsIncidents.id, id))
      .returning();
    if (r.ambulanceUnitId) {
      await tx
        .update(ambulanceUnits)
        .set({ status: 'AVAILABLE' })
        .where(eq(ambulanceUnits.id, r.ambulanceUnitId));
    }
    await auditUpdate(ctx, u!, meta, { status: 'CANCELLED', reason }, tx);
    return u!;
  });
  res.json(await present(updated, true));
});

/* ------------------------------------------------------------------ care record ----------- */

const num = (key: keyof typeof OBSERVATION_RANGES, int = true) => {
  const [min, max] = OBSERVATION_RANGES[key];
  const base = z.number().min(min).max(max);
  return (int ? base.int() : base).optional();
};

const Observation = z
  .object({
    systolic: num('systolic'),
    diastolic: num('diastolic'),
    heartRate: num('heartRate'),
    respiratoryRate: num('respiratoryRate'),
    spo2: num('spo2'),
    gcs: num('gcs'),
    glucose: num('glucose', false),
    temperature: num('temperature', false),
    onOxygen: z.boolean().optional(),
  })
  .strict()
  .refine((o) => Object.entries(o).some(([k, v]) => k !== 'onOxygen' && v !== undefined), {
    message: 'Record at least one observation',
  });

const CareInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('OBSERVATION'),
    recordedAt: z.coerce.date().optional(),
    data: Observation,
  }),
  z.object({
    kind: z.literal('INTERVENTION'),
    recordedAt: z.coerce.date().optional(),
    text: z.string().trim().min(2).max(500),
  }),
  z.object({
    kind: z.literal('MEDICATION'),
    recordedAt: z.coerce.date().optional(),
    medication: z.string().trim().min(2).max(200),
    dose: z.string().trim().min(1).max(100),
    route: z.string().trim().max(50).optional(),
  }),
  z.object({
    kind: z.literal('NOTE'),
    recordedAt: z.coerce.date().optional(),
    text: z.string().trim().min(2).max(500),
  }),
]);

/** Pre-hospital care entries (append-only). */
emsRouter.post('/incidents/:id/care', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(CareInput, req.body);
  const meta = requestMeta(req);
  const row = await incidentForStaff(ctx, id);
  if (!['DISPATCHED', 'ON_SCENE', 'TRANSPORTING', 'HANDED_OVER'].includes(row.status)) {
    throw conflict('Care can be recorded once a vehicle is dispatched and until the call closes');
  }
  if (row.patientId) {
    // The crew has unit access through the open call; this also applies the licence check.
    await assertClinicalWriteAccess(ctx, row.patientId, meta, ['DOCTOR', 'NURSE']);
  }
  const recordedAt = input.recordedAt ?? new Date();
  if (recordedAt.getTime() > Date.now() + 5 * 60_000 || recordedAt < row.receivedAt) {
    throw badRequest('The time must be between the call and now');
  }
  const data: Record<string, unknown> =
    input.kind === 'OBSERVATION'
      ? input.data
      : input.kind === 'MEDICATION'
        ? { medication: input.medication, dose: input.dose, route: input.route ?? null }
        : {};
  const text =
    input.kind === 'INTERVENTION' || input.kind === 'NOTE'
      ? input.text
      : input.kind === 'MEDICATION'
        ? `${input.medication} ${input.dose}${input.route ? ` (${input.route})` : ''}`
        : null;
  const created = await db.transaction(async (tx) => {
    const [rec] = await tx
      .insert(emsCareRecords)
      .values({
        incidentId: row.id,
        patientId: row.patientId,
        kind: input.kind,
        recordedAt,
        data,
        text,
        recordedById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.EMS_CARE_RECORDED,
        actor: ctx,
        resourceType: 'ems_care_record',
        resourceId: rec!.id,
        patientId: row.patientId,
        meta,
        metadata: { reference: row.reference, kind: input.kind },
      },
      tx,
    );
    return rec!;
  });
  const [patient] = row.patientId
    ? await db
        .select({ dateOfBirth: patients.dateOfBirth })
        .from(patients)
        .where(eq(patients.id, row.patientId))
    : [];
  const warning = earlyWarningFor(await observationsOf(row.id), patient?.dateOfBirth ?? null);
  res.status(201).json({
    record: created,
    earlyWarning: warning
      ? { scale: warning.scale, score: warning.result.score, risk: warning.result.risk }
      : null,
  });
});

/* ------------------------------------------------------------------ emergency department --- */

/** Ambulances on their way to (or arrived at, not yet handed over) the caller's facility. */
emsRouter.get('/incoming', requireRole('DOCTOR', 'NURSE', 'RECEPTION'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const units = await edUnitsOf(ctx.facilityId);
  if (!units.length) throw notFound('This facility has no emergency department');
  const isClinician = await isEdClinicianAt(ctx, ctx.facilityId);
  if (!isClinician && ctx.role !== 'RECEPTION') {
    throw forbidden('Only emergency department staff can see incoming ambulances');
  }
  const rows = await db
    .select({ incident: emsIncidents, vehicle: ambulanceUnits, patient: patientCols })
    .from(emsIncidents)
    .leftJoin(ambulanceUnits, eq(ambulanceUnits.id, emsIncidents.ambulanceUnitId))
    .leftJoin(patients, eq(patients.id, emsIncidents.patientId))
    .where(
      and(
        eq(emsIncidents.destinationFacilityId, ctx.facilityId),
        eq(emsIncidents.status, 'TRANSPORTING'),
      ),
    )
    .orderBy(asc(emsIncidents.priority), asc(emsIncidents.leftSceneAt));
  const items = [];
  for (const { incident, vehicle, patient } of rows) {
    const warning = earlyWarningFor(
      await observationsOf(incident.id),
      patient?.dateOfBirth ?? null,
    );
    items.push({
      id: incident.id,
      reference: incident.reference,
      priority: incident.priority,
      complaint: incident.complaint,
      callSign: vehicle?.callSign ?? null,
      level: vehicle?.level ?? null,
      leftSceneAt: incident.leftSceneAt,
      expectedAt: incident.expectedAt,
      atHospitalAt: incident.atHospitalAt,
      // No names before the handover: sex and age band only.
      sex: patient?.sex ?? null,
      ageBand: ageBandOf(patient?.dateOfBirth ?? null),
      earlyWarning: warning
        ? { scale: warning.scale, score: warning.result.score, risk: warning.result.risk }
        : null,
    });
  }
  res.json({ items, canTakeHandover: isClinician });
});

const HandoverInput = z.object({
  unitId: z.string().uuid().optional(),
  /** Needed only when the crew did not link a patient: the unidentified person's sex and age. */
  sex: z.enum(sexEnum.enumValues).optional(),
  estimatedAge: z.number().int().min(0).max(120).optional(),
});

/**
 * The emergency department takes over: opens the attendance (arrival by ambulance) for the
 * linked patient, or for a new unidentified patient, and links it to the call.
 */
emsRouter.post('/incidents/:id/handover', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(HandoverInput, req.body ?? {});
  const meta = requestMeta(req);
  const row = await loadIncident(id);
  if (!row.destinationFacilityId || !(await isEdClinicianAt(ctx, row.destinationFacilityId))) {
    throw notFound('Ambulance call not found');
  }
  const units = await edUnitsOf(row.destinationFacilityId);
  const unit = input.unitId ? units.find((u) => u.id === input.unitId) : units[0];
  if (!unit) throw notFound('Emergency department not found');
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select()
      .from(emsIncidents)
      .where(eq(emsIncidents.id, id))
      .for('update');
    const r = locked!;
    if (r.status !== 'TRANSPORTING') throw conflict('This ambulance is not waiting for a handover');
    let patientId = r.patientId;
    if (!patientId) {
      if (!input.sex) {
        throw badRequest('No patient is linked: give the sex and estimated age to register them');
      }
      const thisYear = Number(kosovoDate(new Date()).slice(0, 4));
      const number = await newTemporaryNumber(tx);
      const [p] = await tx
        .insert(patients)
        .values({
          nationalId: number,
          firstName: UNKNOWN_FIRST_NAME,
          lastName: shortCode(number),
          dateOfBirth: `${thisYear - (input.estimatedAge ?? 40)}-01-01`,
          sex: input.sex,
          primaryFacilityId: row.destinationFacilityId!,
          temporaryIdentity: 'UNIDENTIFIED',
          identityNote: r.patientDescription ?? r.complaint,
        })
        .returning();
      patientId = p!.id;
      await audit(
        {
          action: AuditAction.TEMPORARY_PATIENT_REGISTERED,
          actor: ctx,
          resourceType: 'patient',
          resourceId: patientId,
          patientId,
          meta,
          metadata: { kind: 'UNIDENTIFIED', temporaryNumber: number, emsIncidentId: r.id },
        },
        tx,
      );
    }
    const [open] = await tx
      .select({ id: edVisits.id })
      .from(edVisits)
      .where(and(eq(edVisits.patientId, patientId), inArray(edVisits.status, ED_OPEN_STATUSES)));
    if (open) throw conflict('This patient is already in the emergency department');
    const now = new Date();
    const [visit] = await tx
      .insert(edVisits)
      .values({
        patientId,
        facilityId: row.destinationFacilityId!,
        unitId: unit.id,
        arrivalMode: 'AMBULANCE',
        chiefComplaint: r.complaint,
        arrivedAt: r.atHospitalAt ?? now,
        registeredById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.ED_ARRIVAL_REGISTERED,
        actor: ctx,
        resourceType: 'ed_visit',
        resourceId: visit!.id,
        patientId,
        meta,
        metadata: { arrivalMode: 'AMBULANCE', emsIncidentId: r.id },
      },
      tx,
    );
    const [u] = await tx
      .update(emsIncidents)
      .set({
        status: 'HANDED_OVER',
        patientId,
        edVisitId: visit!.id,
        handedOverAt: now,
        atHospitalAt: r.atHospitalAt ?? now,
      })
      .where(eq(emsIncidents.id, id))
      .returning();
    // Care records stay as recorded (append-only); the ED reads them through the call.
    if (r.ambulanceUnitId) {
      await tx
        .update(ambulanceUnits)
        .set({ status: 'AT_HOSPITAL' })
        .where(eq(ambulanceUnits.id, r.ambulanceUnitId));
    }
    await audit(
      {
        action: AuditAction.EMS_HANDOVER,
        actor: ctx,
        resourceType: 'ems_incident',
        resourceId: r.id,
        patientId,
        meta,
        metadata: { reference: r.reference, edVisitId: visit!.id },
      },
      tx,
    );
    // Tell the crew's service the handover is done.
    const crew = await tx.select({ id: users.id }).from(users).where(eq(users.id, r.createdById));
    await notifyUsers(
      crew.map((c) => c.id),
      {
        type: 'ems',
        title: 'Handover accepted for call {reference}',
        vars: { reference: r.reference },
        link: '/ems',
      },
      tx,
    );
    return { incident: u!, edVisitId: visit!.id };
  });
  res.json({ ...(await present(result.incident, false)), edVisitId: result.edVisitId });
});

/** Ambulance calls of a patient (for the chart and the ED): care team / unit access. */
emsRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(z.object({ patientId: z.string().uuid() }), req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'ems_incidents');
  const rows = await db
    .select()
    .from(emsIncidents)
    .where(and(eq(emsIncidents.patientId, patientId), ne(emsIncidents.status, 'CANCELLED')))
    .orderBy(desc(emsIncidents.receivedAt))
    .limit(50);
  // The chart needs the clinical story, not who called or the exact address of the scene.
  res.json({
    items: rows.map((r) => ({
      ...summary(r),
      callerName: null,
      callerPhone: null,
      address: null,
      latitude: null,
      longitude: null,
    })),
  });
});

/* ------------------------------------------------------------------ statistics ------------ */

const StatsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const suppressed = (n: number) => (n > 0 && n < SMALL_CELL_THRESHOLD ? null : n);

/**
 * Calls by priority, municipality, month and outcome; response times (median, 90th percentile)
 * by priority; share of P1 calls reached within the target. Directors see their facility's
 * services, the Ministry all of them. Counts of 1–4 are hidden, and times are given only for
 * groups of at least SMALL_CELL_THRESHOLD calls.
 */
emsRouter.get('/stats', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(StatsQuery, req.query);
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - 90 * 86_400_000);
  const filters: SQL[] = [gte(emsIncidents.receivedAt, from), lte(emsIncidents.receivedAt, to)];
  if (ctx.role === 'DIRECTOR') {
    if (!ctx.facilityId) throw forbidden();
    const services = await db
      .select({ id: careUnits.id })
      .from(careUnits)
      .where(
        and(eq(careUnits.facilityId, ctx.facilityId), eq(careUnits.type, 'AMBULANCE_SERVICE')),
      );
    if (!services.length) {
      res.json(emptyStats(from, to));
      return;
    }
    filters.push(
      inArray(
        emsIncidents.serviceUnitId,
        services.map((s) => s.id),
      ),
    );
  }
  const where = and(...filters);
  const response = sql`EXTRACT(EPOCH FROM (${emsIncidents.onSceneAt} - ${emsIncidents.dispatchedAt})) / 60`;
  const [byPriority, byMunicipality, byMonth, byOutcome] = await Promise.all([
    db
      .select({
        priority: emsIncidents.priority,
        calls: sql<number>`count(*)::int`,
        reached: sql<number>`count(${emsIncidents.onSceneAt})::int`,
        median: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${response})`,
        p90: sql<number | null>`percentile_cont(0.9) WITHIN GROUP (ORDER BY ${response})`,
        callToDispatch: sql<
          number | null
        >`percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${emsIncidents.dispatchedAt} - ${emsIncidents.receivedAt})) / 60)`,
        withinTarget: sql<number>`count(*) FILTER (WHERE ${response} <= ${P1_TARGET_MINUTES})::int`,
      })
      .from(emsIncidents)
      .where(where)
      .groupBy(emsIncidents.priority)
      .orderBy(asc(emsIncidents.priority)),
    db
      .select({
        municipality: sql<string>`COALESCE(${emsIncidents.municipality}, '')`,
        calls: sql<number>`count(*)::int`,
      })
      .from(emsIncidents)
      .where(where)
      .groupBy(sql`COALESCE(${emsIncidents.municipality}, '')`)
      .orderBy(sql`count(*) DESC`),
    db
      .select({
        month: sql<string>`to_char(date_trunc('month', ${emsIncidents.receivedAt} AT TIME ZONE 'Europe/Belgrade'), 'YYYY-MM')`,
        calls: sql<number>`count(*)::int`,
      })
      .from(emsIncidents)
      .where(where)
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    db
      .select({ outcome: emsIncidents.outcome, calls: sql<number>`count(*)::int` })
      .from(emsIncidents)
      .where(and(where, isNotNull(emsIncidents.outcome)))
      .groupBy(emsIncidents.outcome),
  ]);
  const total = byPriority.reduce((a, r) => a + r.calls, 0);
  const round = (v: number | null) => (v === null ? null : Math.round(Number(v) * 10) / 10);
  const p1 = byPriority.find((r) => r.priority === 'P1');
  res.json({
    from,
    to,
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    p1TargetMinutes: P1_TARGET_MINUTES,
    total: suppressed(total),
    byPriority: PRIORITIES.map((p) => {
      const r = byPriority.find((x) => x.priority === p);
      const enough = (r?.reached ?? 0) >= SMALL_CELL_THRESHOLD;
      return {
        priority: p,
        calls: suppressed(r?.calls ?? 0),
        medianResponseMinutes: enough ? round(r!.median) : null,
        p90ResponseMinutes: enough ? round(r!.p90) : null,
        medianCallToDispatchMinutes:
          (r?.calls ?? 0) >= SMALL_CELL_THRESHOLD ? round(r!.callToDispatch) : null,
      };
    }),
    p1WithinTargetPercent:
      p1 && p1.reached >= SMALL_CELL_THRESHOLD
        ? Math.round((p1.withinTarget / p1.reached) * 1000) / 10
        : null,
    byMunicipality: byMunicipality.map((r) => ({
      municipality: r.municipality || null,
      calls: suppressed(r.calls),
    })),
    byMonth: byMonth.map((r) => ({ month: r.month, calls: suppressed(r.calls) })),
    byOutcome: OUTCOMES.map((o) => ({
      outcome: o,
      calls: suppressed(byOutcome.find((r) => r.outcome === o)?.calls ?? 0),
    })),
  });
});

function emptyStats(from: Date, to: Date) {
  return {
    from,
    to,
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    p1TargetMinutes: P1_TARGET_MINUTES,
    total: 0,
    byPriority: PRIORITIES.map((p) => ({
      priority: p,
      calls: 0,
      medianResponseMinutes: null,
      p90ResponseMinutes: null,
      medianCallToDispatchMinutes: null,
    })),
    p1WithinTargetPercent: null,
    byMunicipality: [],
    byMonth: [],
    byOutcome: OUTCOMES.map((o) => ({ outcome: o, calls: 0 })),
  };
}
