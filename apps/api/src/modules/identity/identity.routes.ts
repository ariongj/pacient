import { Router } from 'express';
import { aliasedTable, and, desc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  admissions,
  bedMovements,
  births,
  deliveryTypeEnum,
  facilities,
  guardianships,
  patients,
  sexEnum,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertNotMerged,
  getPatientOrThrow,
  resolveClinicalReadAccess,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import {
  careTeamDoctors,
  confirmIdentity,
  eighteenthBirthday,
  ensureCareAssignment,
  kosovoDate,
  NEWBORN_PLACEHOLDER_FIRST_NAME,
  newTemporaryNumber,
  shortCode,
  UNKNOWN_FIRST_NAME,
} from './identity.service.js';

export const identityRouter = Router({ mergeParams: true });
identityRouter.use(authenticate);

const PatientParam = z.object({ patientId: z.string().uuid() });

/* ---------------------------------------------------------- unidentified patients */

const TemporaryInput = z
  .object({
    sex: z.enum(sexEnum.enumValues),
    estimatedAge: z.coerce.number().int().min(0).max(120).optional(),
    estimatedBirthYear: z.coerce.number().int().min(1900).max(2100).optional(),
    identityNote: z.string().trim().min(3).max(300),
  })
  .refine((v) => !(v.estimatedAge !== undefined && v.estimatedBirthYear !== undefined), {
    message: 'Give either an estimated age or an estimated year of birth',
  });

/**
 * An unconscious or confused patient without documents. The date of birth is 1 January of the
 * estimated year; the interface always shows it as estimated for unidentified records.
 */
identityRouter.post('/temporary', requireRole('RECEPTION', 'NURSE', 'DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden('Only staff of a facility can register patients');
  const input = parse(TemporaryInput, req.body);
  const thisYear = Number(kosovoDate(new Date()).slice(0, 4));
  const year =
    input.estimatedBirthYear ??
    (input.estimatedAge !== undefined ? thisYear - input.estimatedAge : thisYear - 40);
  if (year > thisYear) throw badRequest('The estimated year of birth cannot be in the future');

  const patient = await db.transaction(async (tx) => {
    const number = await newTemporaryNumber(tx);
    const [created] = await tx
      .insert(patients)
      .values({
        nationalId: number,
        firstName: UNKNOWN_FIRST_NAME,
        lastName: shortCode(number),
        dateOfBirth: `${year}-01-01`,
        sex: input.sex,
        primaryFacilityId: ctx.facilityId!,
        temporaryIdentity: 'UNIDENTIFIED',
        identityNote: input.identityNote,
      })
      .returning();
    if (ctx.role === 'DOCTOR') await ensureCareAssignment(tx, created!.id, ctx.userId, ctx.userId);
    await audit(
      {
        action: AuditAction.TEMPORARY_PATIENT_REGISTERED,
        actor: ctx,
        resourceType: 'patient',
        resourceId: created!.id,
        patientId: created!.id,
        meta: requestMeta(req),
        metadata: { kind: 'UNIDENTIFIED', temporaryNumber: number },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json({
    id: patient.id,
    nationalId: patient.nationalId,
    firstName: patient.firstName,
    lastName: patient.lastName,
    dateOfBirth: patient.dateOfBirth,
    sex: patient.sex,
    temporaryIdentity: patient.temporaryIdentity,
  });
});

const mother = aliasedTable(patients, 'mother');

/** Temporary records at my facility still waiting for a confirmed identity (demographics only). */
identityRouter.get(
  '/temporary',
  requireRole('RECEPTION', 'DIRECTOR', 'DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const rows = await db
      .select({
        id: patients.id,
        nationalId: patients.nationalId,
        firstName: patients.firstName,
        lastName: patients.lastName,
        dateOfBirth: patients.dateOfBirth,
        sex: patients.sex,
        temporaryIdentity: patients.temporaryIdentity,
        identityNote: patients.identityNote,
        createdAt: patients.createdAt,
        bornAt: births.bornAt,
        motherId: mother.id,
        motherName: sql<string | null>`${mother.firstName} || ' ' || ${mother.lastName}`,
      })
      .from(patients)
      .leftJoin(births, eq(births.newbornPatientId, patients.id))
      .leftJoin(mother, eq(mother.id, births.motherPatientId))
      .where(
        and(
          eq(patients.primaryFacilityId, ctx.facilityId!),
          isNotNull(patients.temporaryIdentity),
          isNull(patients.mergedIntoId),
        ),
      )
      .orderBy(desc(patients.createdAt))
      .limit(200);
    res.json({ items: rows });
  },
);

const ConfirmInput = z.object({
  nationalId: z
    .string()
    .trim()
    .regex(/^[0-9]{10}$/, 'National ID must be exactly 10 digits'),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  dateOfBirth: z.string().date(),
  sex: z.enum(sexEnum.enumValues),
});

identityRouter.post(
  '/:patientId/confirm',
  requireRole('RECEPTION', 'DIRECTOR', 'DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const input = parse(ConfirmInput, req.body);
    const patient = await getPatientOrThrow(patientId);
    if (patient.primaryFacilityId !== ctx.facilityId) throw notFound('Patient not found');
    res.json(
      await confirmIdentity(
        { patientId, ...input },
        { ctx, via: 'STAFF', meta: requestMeta(req) },
      ),
    );
  },
);

/* ---------------------------------------------------------------------- births */

const BirthInput = z.object({
  motherPatientId: z.string().uuid(),
  bornAt: z
    .string()
    .datetime({ offset: true })
    .refine((v) => new Date(v).getTime() <= Date.now() + 5 * 60_000, 'Time of birth is in the future')
    .refine(
      (v) => new Date(v).getTime() >= Date.now() - 366 * 86_400_000,
      'Births older than a year are registered by the civil registry',
    ),
  sex: z.enum(sexEnum.enumValues),
  deliveryType: z.enum(deliveryTypeEnum.enumValues),
  gestationalWeeks: z.coerce.number().int().min(20, 'Gestation must be 20–45 weeks').max(45),
  gestationalDays: z.coerce.number().int().min(0).max(6).default(0),
  birthWeightGrams: z.coerce
    .number()
    .int()
    .min(200, 'Birth weight must be between 200 and 7000 g')
    .max(7000, 'Birth weight must be between 200 and 7000 g'),
  lengthCm: z.coerce.number().min(20).max(70).optional(),
  headCircumferenceCm: z.coerce.number().min(15).max(50).optional(),
  apgar1: z.coerce.number().int().min(0, 'Apgar scores are 0–10').max(10, 'Apgar scores are 0–10'),
  apgar5: z.coerce.number().int().min(0, 'Apgar scores are 0–10').max(10, 'Apgar scores are 0–10'),
  apgar10: z.coerce.number().int().min(0).max(10).optional(),
  birthOrder: z.coerce.number().int().min(1).max(8).default(1),
  firstName: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().max(2000).optional(),
  motherAdmissionId: z.string().uuid().optional(),
});

identityRouter.post('/births', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(BirthInput, req.body);
  if (!ctx.facilityId) throw forbidden('Only staff of a facility can register births');
  await assertClinicalWriteAccess(ctx, input.motherPatientId, requestMeta(req), WRITERS.careTeam);
  const m = await getPatientOrThrow(input.motherPatientId);
  assertNotMerged(m);
  if (m.sex === 'MALE') throw badRequest('Choose the mother’s record');

  const bornAt = new Date(input.bornAt);
  const dob = kosovoDate(bornAt);
  const [facility] = await db
    .select({ name: facilities.name })
    .from(facilities)
    .where(eq(facilities.id, ctx.facilityId));

  const result = await db.transaction(async (tx) => {
    let motherAdmission: typeof admissions.$inferSelect | undefined;
    if (input.motherAdmissionId) {
      [motherAdmission] = await tx
        .select()
        .from(admissions)
        .where(
          and(
            eq(admissions.id, input.motherAdmissionId),
            eq(admissions.patientId, m.id),
            eq(admissions.status, 'ADMITTED'),
          ),
        );
      if (!motherAdmission) throw badRequest('The mother’s hospital stay was not found or has ended');
    } else {
      // Default: the mother's current stay at this facility, if she is admitted.
      [motherAdmission] = await tx
        .select()
        .from(admissions)
        .where(
          and(
            eq(admissions.patientId, m.id),
            eq(admissions.status, 'ADMITTED'),
            eq(admissions.facilityId, ctx.facilityId!),
          ),
        );
    }

    const number = await newTemporaryNumber(tx, bornAt);
    const [newborn] = await tx
      .insert(patients)
      .values({
        nationalId: number,
        firstName: input.firstName ?? NEWBORN_PLACEHOLDER_FIRST_NAME,
        lastName: m.lastName,
        dateOfBirth: dob,
        sex: input.sex,
        primaryFacilityId: ctx.facilityId!,
        municipality: m.municipality,
        address: m.address,
        phone: m.phone,
        temporaryIdentity: 'NEWBORN',
        identityNote: `${m.firstName} ${m.lastName}`,
      })
      .returning();

    const [birth] = await tx
      .insert(births)
      .values({
        motherPatientId: m.id,
        newbornPatientId: newborn!.id,
        facilityId: ctx.facilityId!,
        motherAdmissionId: motherAdmission?.id ?? null,
        bornAt,
        deliveryType: input.deliveryType,
        gestationalWeeks: input.gestationalWeeks,
        gestationalDays: input.gestationalDays,
        birthWeightGrams: input.birthWeightGrams,
        lengthCm: input.lengthCm !== undefined ? String(input.lengthCm) : null,
        headCircumferenceCm:
          input.headCircumferenceCm !== undefined ? String(input.headCircumferenceCm) : null,
        apgar1: input.apgar1,
        apgar5: input.apgar5,
        apgar10: input.apgar10 ?? null,
        birthOrder: input.birthOrder,
        attendantId: ctx.userId,
        notes: input.notes ?? null,
      })
      .returning();

    // The baby joins the care of the attending doctor and the mother's doctors.
    const team = new Set(await careTeamDoctors(m.id, tx));
    if (ctx.role === 'DOCTOR') team.add(ctx.userId);
    if (motherAdmission) team.add(motherAdmission.attendingDoctorId);
    for (const doctorId of team) await ensureCareAssignment(tx, newborn!.id, doctorId, ctx.userId);

    // The mother can follow her baby's record in the portal.
    let guardianship = false;
    if (m.userId) {
      await tx
        .insert(guardianships)
        .values({
          patientId: newborn!.id,
          guardianUserId: m.userId,
          relationship: 'PARENT',
          scope: 'FULL',
          evidence: `Lindje e regjistruar në ${facility?.name ?? 'institucion'} më ${dob}`,
          verifiedById: ctx.userId,
          validFrom: bornAt,
          validUntil: eighteenthBirthday(dob),
        })
        .onConflictDoNothing();
      guardianship = true;
    }

    await tx.insert(vitalSigns).values({
      patientId: newborn!.id,
      recordedById: ctx.userId,
      weightKg: (input.birthWeightGrams / 1000).toFixed(1),
      heightCm: input.lengthCm !== undefined ? String(input.lengthCm) : null,
      recordedAt: bornAt,
    });

    // Rooming-in: the baby stays in the mother's unit and appears on the bed board.
    let newbornAdmissionId: string | null = null;
    if (motherAdmission) {
      const [adm] = await tx
        .insert(admissions)
        .values({
          patientId: newborn!.id,
          facilityId: motherAdmission.facilityId,
          unitId: motherAdmission.unitId,
          bedId: null,
          admittingDoctorId:
            ctx.role === 'DOCTOR' ? ctx.userId : motherAdmission.attendingDoctorId,
          attendingDoctorId: motherAdmission.attendingDoctorId,
          source: 'BIRTH',
          reason: 'Newborn rooming-in with mother',
          admittedAt: bornAt,
        })
        .returning({ id: admissions.id });
      newbornAdmissionId = adm!.id;
      await tx.insert(bedMovements).values({
        admissionId: adm!.id,
        toUnitId: motherAdmission.unitId,
        movedById: ctx.userId,
        reason: 'Newborn rooming-in with mother',
        movedAt: bornAt,
      });
    }

    for (const pid of [newborn!.id, m.id]) {
      await audit(
        {
          action: AuditAction.BIRTH_REGISTERED,
          actor: ctx,
          resourceType: 'birth',
          resourceId: birth!.id,
          patientId: pid,
          meta: requestMeta(req),
          metadata: { temporaryNumber: number, birthOrder: input.birthOrder },
        },
        tx,
      );
    }
    if (m.userId) {
      await notifyPatient(
        m.id,
        {
          type: 'birth',
          title: 'Your baby’s health record has been created',
          link: '/portal',
          important: true,
        },
        tx,
        { guardians: 'none' },
      );
    }
    return { birth: birth!, newborn: newborn!, guardianship, newbornAdmissionId };
  });

  res.status(201).json({
    birthId: result.birth.id,
    newborn: {
      id: result.newborn.id,
      nationalId: result.newborn.nationalId,
      firstName: result.newborn.firstName,
      lastName: result.newborn.lastName,
      dateOfBirth: result.newborn.dateOfBirth,
      sex: result.newborn.sex,
      temporaryIdentity: result.newborn.temporaryIdentity,
    },
    guardianshipCreated: result.guardianship,
    newbornAdmissionId: result.newbornAdmissionId,
  });
});

const newborn = aliasedTable(patients, 'newborn');
const attendant = aliasedTable(users, 'attendant');

const clinicalBirthColumns = {
  deliveryType: births.deliveryType,
  gestationalWeeks: births.gestationalWeeks,
  gestationalDays: births.gestationalDays,
  birthWeightGrams: births.birthWeightGrams,
  lengthCm: births.lengthCm,
  headCircumferenceCm: births.headCircumferenceCm,
  apgar1: births.apgar1,
  apgar5: births.apgar5,
  apgar10: births.apgar10,
  notes: births.notes,
  attendantName: attendant.fullName,
};

const BirthsQuery = z.object({
  from: z.string().date().optional(),
  to: z.string().date().optional(),
});

/**
 * Births at my facility. Clinicians see the clinical details; reception sees only what the
 * front desk and civil registration need.
 */
identityRouter.get('/births', requireRole('DOCTOR', 'NURSE', 'RECEPTION'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(BirthsQuery, req.query);
  const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(Date.now() - 30 * 86_400_000);
  const to = q.to ? new Date(`${q.to}T23:59:59Z`) : new Date(Date.now() + 86_400_000);
  const clinical = ctx.role === 'DOCTOR' || ctx.role === 'NURSE';
  const rows = await db
    .select({
      id: births.id,
      bornAt: births.bornAt,
      birthOrder: births.birthOrder,
      civilRegisteredAt: births.civilRegisteredAt,
      newbornId: newborn.id,
      newbornFirstName: newborn.firstName,
      newbornLastName: newborn.lastName,
      newbornNationalId: newborn.nationalId,
      newbornSex: newborn.sex,
      temporaryIdentity: newborn.temporaryIdentity,
      motherId: mother.id,
      motherName: sql<string>`${mother.firstName} || ' ' || ${mother.lastName}`,
      motherNationalId: mother.nationalId,
      ...clinicalBirthColumns,
    })
    .from(births)
    .innerJoin(newborn, eq(newborn.id, births.newbornPatientId))
    .innerJoin(mother, eq(mother.id, births.motherPatientId))
    .innerJoin(attendant, eq(attendant.id, births.attendantId))
    .where(
      and(eq(births.facilityId, ctx.facilityId!), gte(births.bornAt, from), lte(births.bornAt, to)),
    )
    .orderBy(desc(births.bornAt))
    .limit(300);
  const items = rows.map((r) => {
    if (clinical) return r;
    const {
      deliveryType: _d,
      gestationalWeeks: _gw,
      gestationalDays: _gd,
      birthWeightGrams: _w,
      lengthCm: _l,
      headCircumferenceCm: _h,
      apgar1: _a1,
      apgar5: _a5,
      apgar10: _a10,
      notes: _n,
      attendantName: _at,
      ...rest
    } = r;
    return rest;
  });
  res.json({ items, clinical });
});

/** Birth record of a newborn (with the mother) and births of a mother, for the chart. */
identityRouter.get('/patients/:patientId/birth', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveClinicalReadAccess(ctx, patientId, requestMeta(req));
  const base = {
    id: births.id,
    bornAt: births.bornAt,
    birthOrder: births.birthOrder,
    civilRegisteredAt: births.civilRegisteredAt,
    facilityName: facilities.name,
    ...clinicalBirthColumns,
  };
  const [asNewborn] = await db
    .select({
      ...base,
      motherId: mother.id,
      motherName: sql<string>`${mother.firstName} || ' ' || ${mother.lastName}`,
    })
    .from(births)
    .innerJoin(mother, eq(mother.id, births.motherPatientId))
    .innerJoin(attendant, eq(attendant.id, births.attendantId))
    .innerJoin(facilities, eq(facilities.id, births.facilityId))
    .where(eq(births.newbornPatientId, patientId));
  const asMother = await db
    .select({
      ...base,
      newbornId: newborn.id,
      newbornName: sql<string>`${newborn.firstName} || ' ' || ${newborn.lastName}`,
      newbornSex: newborn.sex,
      newbornNationalId: newborn.nationalId,
      temporaryIdentity: newborn.temporaryIdentity,
    })
    .from(births)
    .innerJoin(newborn, eq(newborn.id, births.newbornPatientId))
    .innerJoin(attendant, eq(attendant.id, births.attendantId))
    .innerJoin(facilities, eq(facilities.id, births.facilityId))
    .where(eq(births.motherPatientId, patientId))
    .orderBy(desc(births.bornAt));
  res.json({ asNewborn: asNewborn ?? null, asMother });
});
