import { Router } from 'express';
import {
  and,
  asc,
  count,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  bloodTypeEnum,
  CARE_TEAM_ROLES,
  careAssignments,
  emergencyAccessGrants,
  facilities,
  patients,
  sexEnum,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertDemographicsAccess,
  getPatientOrThrow,
  hasActiveCareAssignment,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { createInvitedUser } from '../auth/invitations.js';
import { notifyFacilityRole } from '../notifications/notifications.service.js';

export const EMERGENCY_ACCESS_HOURS = 4;

const NationalId = z
  .string()
  .trim()
  .regex(/^[0-9]{10}$/, 'National ID must be exactly 10 digits');

const ContactFields = {
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().email().max(254).optional().nullable(),
  address: z.string().trim().max(300).optional().nullable(),
  municipality: z.string().trim().max(100).optional().nullable(),
  emergencyContactName: z.string().trim().max(200).optional().nullable(),
  emergencyContactPhone: z.string().trim().max(40).optional().nullable(),
};

export const ContactPatchSchema = z.object(ContactFields);

const RegisterSchema = z.object({
  nationalId: NationalId,
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  dateOfBirth: z
    .string()
    .date()
    .refine((d) => new Date(d) <= new Date(), 'Date of birth cannot be in the future'),
  sex: z.enum(sexEnum.enumValues),
  bloodType: z.enum(bloodTypeEnum.enumValues).optional(),
  ...ContactFields,
  createPortalAccount: z.boolean().default(false),
  /** Set after a registrar has reviewed possible duplicates and confirmed this is a new person. */
  confirmedNotDuplicate: z.boolean().default(false),
});

const DemographicsPatch = z
  .object({
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    bloodType: z.enum(bloodTypeEnum.enumValues),
    ...ContactFields,
  })
  .partial();

const ListQuery = PaginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  /** DOCTOR only: `mine` = patients in my care (default), `facility` = registered at my facility. */
  scope: z.enum(['mine', 'facility']).default('mine'),
});

const IdParam = z.object({ id: z.string().uuid() });
const CareTeamBody = z.object({ doctorId: z.string().uuid().optional() });
const CareTeamParams = z.object({ id: z.string().uuid(), doctorId: z.string().uuid() });
const EmergencyBody = z.object({ reason: z.string().trim().min(10).max(1000) });

const listColumns = {
  id: patients.id,
  nationalId: patients.nationalId,
  firstName: patients.firstName,
  lastName: patients.lastName,
  dateOfBirth: patients.dateOfBirth,
  sex: patients.sex,
  primaryFacilityId: patients.primaryFacilityId,
  hasPortalAccount: sql<boolean>`${patients.userId} IS NOT NULL`,
};

/** Correlated subquery: is the patient in the given doctor's active care? */
const inCareOf = (doctorId: string) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(careAssignments)
      .where(
        and(
          eq(careAssignments.patientId, patients.id),
          eq(careAssignments.doctorId, doctorId),
          isNull(careAssignments.endedAt),
        ),
      ),
  ) as SQL<boolean>;

export const patientsRouter = Router();
patientsRouter.use(authenticate);

/* ---------------------------------------------- list / search -------------------------------- */

patientsRouter.get(
  '/',
  requireRole('DOCTOR', 'NURSE', 'DIRECTOR', 'RECEPTION'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const q = parse(ListQuery, req.query);
    const filters: SQL[] = [];

    const searchFilter = q.search
      ? or(
          ilike(patients.firstName, `%${q.search}%`),
          ilike(patients.lastName, `%${q.search}%`),
          ilike(sql`${patients.firstName} || ' ' || ${patients.lastName}`, `%${q.search}%`),
          eq(patients.nationalId, q.search),
        )!
      : undefined;

    if ((ctx.role === 'DOCTOR' || ctx.role === 'NURSE') && q.scope === 'mine') {
      filters.push(inCareOf(ctx.userId));
      if (searchFilter) filters.push(searchFilter);
    } else {
      // Search never crosses the facility boundary: an identity match elsewhere must not disclose
      // that a person is a patient of another institution.
      filters.push(eq(patients.primaryFacilityId, ctx.facilityId!));
      if (searchFilter) filters.push(searchFilter);
    }

    const where = and(...filters);
    const inCare =
      ctx.role === 'DOCTOR' || ctx.role === 'NURSE' ? inCareOf(ctx.userId) : sql<boolean>`false`;

    const [rows, [total]] = await Promise.all([
      db
        .select({ ...listColumns, inMyCare: inCare })
        .from(patients)
        .where(where)
        .orderBy(asc(patients.lastName), asc(patients.firstName))
        .limit(toOffset(q).limit)
        .offset(toOffset(q).offset),
      db.select({ total: count() }).from(patients).where(where),
    ]);

    if (q.search) {
      await audit({
        action: AuditAction.PATIENT_SEARCHED,
        actor: ctx,
        meta: requestMeta(req),
        metadata: { scope: q.scope, resultCount: total?.total ?? 0 },
      });
    }
    res.json(paginated(rows, total?.total ?? 0, q));
  },
);

/* ---------------------------------------------- registration --------------------------------- */

patientsRouter.post('/', requireRole('DOCTOR', 'DIRECTOR', 'RECEPTION'), async (req, res) => {
  const ctx = requireAuth(req);
  const { createPortalAccount, confirmedNotDuplicate, ...input } = parse(RegisterSchema, req.body);
  if (createPortalAccount && !input.email) {
    throw badRequest('An email address is required to create a portal account');
  }

  const [existing] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(eq(patients.nationalId, input.nationalId));
  if (existing) throw conflict('A patient with this national ID is already registered');

  // Similar records are flagged for human review, never merged automatically.
  const possibleDuplicates = await db
    .select({
      id: patients.id,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dateOfBirth: patients.dateOfBirth,
    })
    .from(patients)
    .where(
      and(
        eq(patients.primaryFacilityId, ctx.facilityId!),
        eq(patients.dateOfBirth, input.dateOfBirth),
        sql`lower(${patients.lastName}) = ${input.lastName.toLowerCase()}`,
        sql`lower(${patients.firstName}) = ${input.firstName.toLowerCase()}`,
      ),
    )
    .limit(5);
  if (possibleDuplicates.length && !confirmedNotDuplicate) {
    throw new HttpError(
      409,
      'POSSIBLE_DUPLICATE',
      'A patient with the same name and date of birth exists. Review before registering.',
      possibleDuplicates,
    );
  }

  const result = await db.transaction(async (tx) => {
    let userId: string | null = null;
    let activationUrl: string | undefined;
    if (createPortalAccount) {
      const invited = await createInvitedUser(
        tx,
        {
          email: input.email!,
          fullName: `${input.firstName} ${input.lastName}`,
          role: 'PATIENT',
          facilityId: null,
        },
        ctx.userId,
      );
      userId = invited.user.id;
      activationUrl = invited.activationUrl;
    }

    const [patient] = await tx
      .insert(patients)
      .values({ ...input, userId, primaryFacilityId: ctx.facilityId! })
      .returning();

    if (ctx.role === 'DOCTOR') {
      await tx
        .insert(careAssignments)
        .values({ patientId: patient!.id, doctorId: ctx.userId, assignedById: ctx.userId });
    }
    await audit(
      {
        action: AuditAction.PATIENT_REGISTERED,
        actor: ctx,
        resourceType: 'patient',
        resourceId: patient!.id,
        patientId: patient!.id,
        meta: requestMeta(req),
        metadata: { portalAccount: createPortalAccount },
      },
      tx,
    );
    if (possibleDuplicates.length) {
      await audit(
        {
          action: AuditAction.POSSIBLE_DUPLICATE_OVERRIDDEN,
          actor: ctx,
          resourceType: 'patient',
          resourceId: patient!.id,
          patientId: patient!.id,
          meta: requestMeta(req),
          metadata: { candidates: possibleDuplicates.map((d) => d.id) },
        },
        tx,
      );
    }
    return { patient: patient!, activationUrl };
  });

  res.status(201).json(result);
});

/* ---------------------------------------------- demographics --------------------------------- */

patientsRouter.get('/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const patient = await assertDemographicsAccess(ctx, id);
  const inMyCare =
    ctx.role === 'DOCTOR' || ctx.role === 'NURSE'
      ? await hasActiveCareAssignment(ctx.userId, id)
      : false;
  const [facility] = await db
    .select({ name: facilities.name })
    .from(facilities)
    .where(eq(facilities.id, patient.primaryFacilityId));
  const { userId, ...rest } = patient;
  res.json({
    ...rest,
    primaryFacilityName: facility?.name ?? null,
    hasPortalAccount: Boolean(userId),
    inMyCare,
  });
});

patientsRouter.patch(
  '/:id',
  requireRole('DOCTOR', 'NURSE', 'DIRECTOR', 'RECEPTION'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const patch = parse(DemographicsPatch, req.body);
    await assertDemographicsAccess(ctx, id);
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(patients).set(patch).where(eq(patients.id, id)).returning();
      await audit(
        {
          action: AuditAction.PATIENT_DEMOGRAPHICS_UPDATED,
          actor: ctx,
          resourceType: 'patient',
          resourceId: id,
          patientId: id,
          meta: requestMeta(req),
          metadata: { fields: Object.keys(patch) },
        },
        tx,
      );
      return row!;
    });
    const { userId, ...rest } = updated;
    res.json({ ...rest, hasPortalAccount: Boolean(userId) });
  },
);

patientsRouter.post(
  '/:id/portal-invitation',
  requireRole('DOCTOR', 'NURSE', 'DIRECTOR', 'RECEPTION'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const patient = await assertDemographicsAccess(ctx, id);
    if (patient.userId) throw conflict('This patient already has a portal account');
    if (!patient.email) throw badRequest('Add an email address to the patient before inviting');

    const activationUrl = await db.transaction(async (tx) => {
      const invited = await createInvitedUser(
        tx,
        {
          email: patient.email!,
          fullName: `${patient.firstName} ${patient.lastName}`,
          role: 'PATIENT',
          facilityId: null,
        },
        ctx.userId,
      );
      await tx.update(patients).set({ userId: invited.user.id }).where(eq(patients.id, id));
      await audit(
        {
          action: AuditAction.USER_INVITED,
          actor: ctx,
          resourceType: 'user',
          resourceId: invited.user.id,
          patientId: id,
          meta: requestMeta(req),
          metadata: { role: 'PATIENT' },
        },
        tx,
      );
      return invited.activationUrl;
    });
    res.status(201).json({ activationUrl });
  },
);

/* ---------------------------------------------- care team ------------------------------------ */

patientsRouter.get('/:id/care-team', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  await assertDemographicsAccess(ctx, id);
  const rows = await db
    .select({
      doctorId: users.id,
      fullName: users.fullName,
      role: users.role,
      specialty: users.specialty,
      facilityId: users.facilityId,
      startedAt: careAssignments.startedAt,
    })
    .from(careAssignments)
    .innerJoin(users, eq(users.id, careAssignments.doctorId))
    .where(and(eq(careAssignments.patientId, id), isNull(careAssignments.endedAt)))
    .orderBy(asc(users.fullName));
  res.json({ items: rows });
});

/**
 * Add a doctor to the care team.
 *  - A DOCTOR may add themself for patients registered at their own facility.
 *  - A DIRECTOR may assign any active doctor of their facility to a patient of their facility.
 */
/**
 * Add a clinician (doctor or nurse) to the care team.
 *  - Doctors and nurses may add themselves for patients registered at their own facility.
 *  - A director may assign any active doctor or nurse of their facility.
 */
patientsRouter.post(
  '/:id/care-team',
  requireRole('DOCTOR', 'NURSE', 'DIRECTOR'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(CareTeamBody, req.body ?? {});
    const patient = await getPatientOrThrow(id);
    if (patient.primaryFacilityId !== ctx.facilityId) {
      throw forbidden('Patients from other facilities can only be shared through a referral');
    }

    const selfService = ctx.role === 'DOCTOR' || ctx.role === 'NURSE';
    const memberId = selfService ? ctx.userId : body.doctorId;
    if (!memberId) throw badRequest('doctorId (the clinician to assign) is required');
    if (selfService && body.doctorId && body.doctorId !== ctx.userId) {
      throw forbidden('Clinicians can only add themselves to a care team');
    }
    const [member] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(
        and(
          eq(users.id, memberId),
          inArray(users.role, [...CARE_TEAM_ROLES]),
          eq(users.facilityId, ctx.facilityId!),
          eq(users.isActive, true),
        ),
      );
    if (!member) throw badRequest('Doctor or nurse not found in your facility');
    if (await hasActiveCareAssignment(memberId, id)) {
      throw conflict('Already part of the care team');
    }

    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(careAssignments)
        .values({ patientId: id, doctorId: memberId, assignedById: ctx.userId })
        .returning();
      await audit(
        {
          action: AuditAction.CARE_ASSIGNED,
          actor: ctx,
          resourceType: 'care_assignment',
          resourceId: row!.id,
          patientId: id,
          meta: requestMeta(req),
          metadata: { memberId, memberRole: member.role },
        },
        tx,
      );
    });
    res.status(201).json({ patientId: id, doctorId: memberId, role: member.role });
  },
);

patientsRouter.delete(
  '/:id/care-team/:doctorId',
  requireRole('DOCTOR', 'NURSE', 'DIRECTOR'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id, doctorId } = parse(CareTeamParams, req.params);
    const patient = await getPatientOrThrow(id);
    if ((ctx.role === 'DOCTOR' || ctx.role === 'NURSE') && doctorId !== ctx.userId) {
      throw forbidden();
    }
    if (ctx.role === 'DIRECTOR' && patient.primaryFacilityId !== ctx.facilityId) throw forbidden();

    const ended = await db.transaction(async (tx) => {
      const rows = await tx
        .update(careAssignments)
        .set({ endedAt: new Date() })
        .where(
          and(
            eq(careAssignments.patientId, id),
            eq(careAssignments.doctorId, doctorId),
            isNull(careAssignments.endedAt),
          ),
        )
        .returning({ id: careAssignments.id });
      if (rows.length) {
        await audit(
          {
            action: AuditAction.CARE_ENDED,
            actor: ctx,
            resourceType: 'care_assignment',
            resourceId: rows[0]!.id,
            patientId: id,
            meta: requestMeta(req),
            metadata: { doctorId },
          },
          tx,
        );
      }
      return rows.length;
    });
    if (!ended) throw notFound('No active care assignment');
    res.status(204).end();
  },
);

/* ---------------------------------------------- break-glass ---------------------------------- */

/**
 * Emergency ("break-glass") access: a doctor can open any record in an emergency, but must state a
 * reason, access expires automatically, and the event is flagged in the audit trail for review by
 * the facility director and visible to the patient.
 */
patientsRouter.post('/:id/emergency-access', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(EmergencyBody, req.body);
  const patient = await getPatientOrThrow(id);
  // Break-glass is for urgent care inside the institution. It never crosses tenant boundaries.
  if (patient.primaryFacilityId !== ctx.facilityId) {
    throw forbidden('Emergency access is limited to patients of your facility');
  }
  const expiresAt = new Date(Date.now() + EMERGENCY_ACCESS_HOURS * 3_600_000);
  const grant = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(emergencyAccessGrants)
      .values({ patientId: id, doctorId: ctx.userId, reason, expiresAt })
      .returning();
    await audit(
      {
        action: AuditAction.EMERGENCY_ACCESS_GRANTED,
        actor: ctx,
        resourceType: 'emergency_access',
        resourceId: row!.id,
        patientId: id,
        meta: requestMeta(req),
        metadata: { reason, expiresAt: expiresAt.toISOString() },
      },
      tx,
    );
    // Directors are alerted so every break-glass event gets a retrospective review.
    await notifyFacilityRole(
      ctx.facilityId!,
      ['DIRECTOR'],
      {
        type: 'emergency_access',
        title: 'Emergency access used – review required',
        important: true,
        link: '/director/emergency-access',
      },
      tx,
    );
    return row!;
  });
  res.status(201).json({ id: grant.id, expiresAt: grant.expiresAt });
});
