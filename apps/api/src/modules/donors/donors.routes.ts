import { Router } from 'express';
import { and, asc, count, desc, eq, gte, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  bloodDonations,
  donationTestResults,
  bloodDonors,
  bloodGroupTests,
  bloodUnits,
  facilities,
  notifications,
  patients,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { assertNotMerged, auditRecordView, getPatientOrThrow } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  ABO_GROUPS,
  bloodBankStaff,
  isBloodBankStaff,
  publishBloodBank,
  RHD,
  type Abo,
  type RhD,
} from '../bloodbank/bloodbank.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  DAY_MS,
  deferralFrom,
  donorFacts,
  evaluateEligibility,
  EXPIRED_UNTESTED,
  groupLabel,
  isoDate,
  LIMITS,
  MARKER_LABEL,
  MARKERS,
  nextDonationUnitNumber,
  nextEligibleDate,
  QUESTIONS,
  registrationProblem,
  releasedUnits,
  SCREENING_DISCARD,
  WHOLE_BLOOD_SHELF_DAYS,
  type Problem,
} from './donors.service.js';

/**
 * Blood donors: register, donation visits with eligibility checks, mandatory testing that releases
 * (or discards) the unit, deferrals, appeals, the donor's portal card and statistics. Donor test
 * results and deferral reasons are visible only to blood bank staff.
 */
export const bloodDonorsRouter = Router();
bloodDonorsRouter.use(authenticate);

const IdParam = z.object({ id: z.string().uuid() });
const Abo = z.enum(ABO_GROUPS as [Abo, ...Abo[]]);
const Rh = z.enum(RHD as [RhD, ...RhD[]]);
/** One appeal per donor in this many days. */
const APPEAL_INTERVAL_DAYS = 28;

async function assertStaff(ctx: AuthContext) {
  if (!(await isBloodBankStaff(ctx.userId, ctx.facilityId))) {
    throw forbidden('Only blood bank staff can do this');
  }
}

async function loadDonor(id: string) {
  const loaded = await donorFacts(id);
  if (!loaded) throw notFound('Donor not found');
  return loaded;
}

const Answers = z.record(z.string(), z.boolean());
const Measurements = z.object({
  haemoglobin: z.number().min(30).max(250).optional().nullable(),
  systolic: z.number().int().min(40).max(300).optional().nullable(),
  diastolic: z.number().int().min(20).max(200).optional().nullable(),
  pulse: z.number().int().min(20).max(250).optional().nullable(),
  weightKg: z.number().min(20).max(300).optional().nullable(),
});

const problemOut = (p: Problem) => ({
  code: p.code,
  message: p.message,
  vars: p.vars ?? null,
  defer: p.defer,
});

/* ------------------------------------------------------------------ me & definitions ----- */

bloodDonorsRouter.get('/me', async (req, res) => {
  const ctx = requireAuth(req);
  const isStaff = await isBloodBankStaff(ctx.userId, ctx.facilityId);
  res.json({
    isStaff,
    canSeeStats: ctx.role === 'DIRECTOR' || ctx.role === 'MINISTRY' || isStaff,
  });
});

bloodDonorsRouter.get('/definitions', (_req, res) => {
  res.json({
    questions: QUESTIONS.map((q) => ({
      code: q.code,
      text: q.text,
      triggerOn: q.triggerOn,
      womenOnly: Boolean(q.womenOnly),
      permanent: q.defer === 'PERMANENT',
    })),
    limits: LIMITS,
    markers: MARKERS.map((m) => ({ code: m, label: MARKER_LABEL[m] })),
    appealIntervalDays: APPEAL_INTERVAL_DAYS,
  });
});

/* ------------------------------------------------------------------ register -------------- */

/** Find a person by national ID to register them as a donor (blood bank staff). */
bloodDonorsRouter.get('/lookup', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const { nationalId } = parse(
    z.object({ nationalId: z.string().trim().min(3).max(20) }),
    req.query,
  );
  const [p] = await db
    .select({
      id: patients.id,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      nationalId: patients.nationalId,
      mergedIntoId: patients.mergedIntoId,
      deceasedAt: patients.deceasedAt,
    })
    .from(patients)
    .where(eq(patients.nationalId, nationalId));
  if (!p || p.mergedIntoId || p.deceasedAt) throw notFound('No person with this national ID');
  const [donor] = await db
    .select({ id: bloodDonors.id })
    .from(bloodDonors)
    .where(eq(bloodDonors.patientId, p.id));
  const problem = donor ? null : registrationProblem(p, 0);
  res.json({
    person: {
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      dateOfBirth: p.dateOfBirth,
      sex: p.sex,
      nationalId: p.nationalId,
    },
    donorId: donor?.id ?? null,
    registrationProblem: problem ? problemOut(problem) : null,
  });
});

const RegisterInput = z.object({
  patientId: z.string().uuid(),
  contactConsent: z.boolean().default(false),
});

bloodDonorsRouter.post('/donors', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const input = parse(RegisterInput, req.body);
  const patient = await getPatientOrThrow(input.patientId);
  assertNotMerged(patient);
  if (patient.deceasedAt) throw conflict('This person is recorded as deceased');
  const problem = registrationProblem(patient, 0);
  if (problem) throw badRequest(problem.message);
  const created = await db.transaction(async (tx) => {
    const [exists] = await tx
      .select({ id: bloodDonors.id })
      .from(bloodDonors)
      .where(eq(bloodDonors.patientId, input.patientId));
    if (exists) throw conflict('This person is already registered as a donor');
    const [row] = await tx
      .insert(bloodDonors)
      .values({
        patientId: input.patientId,
        contactConsent: input.contactConsent,
        registeredAtFacilityId: ctx.facilityId!,
      })
      .returning();
    await audit(
      {
        action: AuditAction.DONOR_CHANGED,
        actor: ctx,
        resourceType: 'blood_donor',
        resourceId: row!.id,
        patientId: input.patientId,
        meta: requestMeta(req),
        metadata: { change: 'registered', contactConsent: input.contactConsent },
      },
      tx,
    );
    return row!;
  });
  res.status(201).json(created);
});

/* ------------------------------------------------------------------ donor list & detail --- */

const donorColumns = {
  id: bloodDonors.id,
  patientId: bloodDonors.patientId,
  abo: bloodDonors.abo,
  rhD: bloodDonors.rhD,
  status: bloodDonors.status,
  deferredUntil: bloodDonors.deferredUntil,
  lastDonationAt: bloodDonors.lastDonationAt,
  donationCount: bloodDonors.donationCount,
  contactConsent: bloodDonors.contactConsent,
  firstName: patients.firstName,
  lastName: patients.lastName,
  nationalId: patients.nationalId,
  dateOfBirth: patients.dateOfBirth,
  sex: patients.sex,
};

/** Search donors: by exact national ID anywhere, by name among donors registered here. */
bloodDonorsRouter.get('/donors', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const { q } = parse(z.object({ q: z.string().trim().max(100).default('') }), req.query);
  const term = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select(donorColumns)
    .from(bloodDonors)
    .innerJoin(patients, eq(patients.id, bloodDonors.patientId))
    .where(
      q
        ? or(
            eq(patients.nationalId, q),
            and(
              eq(bloodDonors.registeredAtFacilityId, ctx.facilityId!),
              or(ilike(patients.lastName, term), ilike(patients.firstName, term)),
            ),
          )
        : eq(bloodDonors.registeredAtFacilityId, ctx.facilityId!),
    )
    .orderBy(sql`${bloodDonors.lastDonationAt} DESC NULLS LAST`, asc(patients.lastName))
    .limit(50);
  res.json({ items: rows });
});

bloodDonorsRouter.get('/donors/:id', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const { donor, facts } = await loadDonor(id);
  const [person] = await db
    .select({
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      phone: patients.phone,
    })
    .from(patients)
    .where(eq(patients.id, donor.patientId));
  await auditRecordView(ctx, donor.patientId, 'UNIT', 'blood_donor', requestMeta(req));
  const donations = await db
    .select({
      id: bloodDonations.id,
      attendedAt: bloodDonations.attendedAt,
      outcome: bloodDonations.outcome,
      volumeMl: bloodDonations.volumeMl,
      haemoglobin: bloodDonations.haemoglobin,
      deferralReason: bloodDonations.deferralReason,
      adverseReaction: bloodDonations.adverseReaction,
      bloodUnitId: bloodDonations.bloodUnitId,
      unitNumber: bloodUnits.unitNumber,
      unitStatus: bloodUnits.status,
      unitDiscardReason: bloodUnits.discardReason,
      facilityName: facilities.name,
    })
    .from(bloodDonations)
    .innerJoin(facilities, eq(facilities.id, bloodDonations.facilityId))
    .leftJoin(bloodUnits, eq(bloodUnits.id, bloodDonations.bloodUnitId))
    .where(eq(bloodDonations.donorId, id))
    .orderBy(desc(bloodDonations.attendedAt));
  res.json({
    donor,
    person,
    nextEligibleDate: nextEligibleDate(facts),
    donations: donations.map((d) => ({
      ...d,
      testing:
        d.outcome !== 'COMPLETED'
          ? null
          : !d.bloodUnitId
            ? 'AWAITING'
            : d.unitDiscardReason === SCREENING_DISCARD
              ? 'NOT_PASSED'
              : d.unitDiscardReason === EXPIRED_UNTESTED
                ? 'EXPIRED'
                : 'RELEASED',
    })),
  });
});

const DonorPatch = z
  .object({
    contactConsent: z.boolean().optional(),
    /** Manual deferral (days) or lifting a deferral. */
    defer: z
      .object({
        days: z.number().int().min(1).max(3650).optional(),
        permanent: z.boolean().optional(),
        reason: z.string().trim().min(5).max(300),
      })
      .optional(),
    lift: z.object({ reason: z.string().trim().min(10).max(300) }).optional(),
  })
  .refine((v) => !(v.defer && v.lift), 'Defer or lift, not both');

bloodDonorsRouter.patch('/donors/:id', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const input = parse(DonorPatch, req.body);
  const { donor } = await loadDonor(id);
  const set: Partial<typeof bloodDonors.$inferInsert> = {};
  if (input.contactConsent !== undefined) set.contactConsent = input.contactConsent;
  if (input.defer) {
    if (!input.defer.permanent && !input.defer.days) {
      throw badRequest('Give the number of days or make the deferral permanent');
    }
    set.status = input.defer.permanent ? 'PERMANENTLY_DEFERRED' : 'DEFERRED';
    set.deferredUntil = input.defer.permanent
      ? null
      : isoDate(new Date(Date.now() + input.defer.days! * DAY_MS));
    set.deferralReason = input.defer.reason;
  }
  if (input.lift) {
    // Only a blood bank doctor may lift a permanent deferral.
    if (donor.status === 'PERMANENTLY_DEFERRED' && ctx.role !== 'DOCTOR') {
      throw forbidden('Only a blood bank doctor can lift a permanent deferral');
    }
    set.status = 'ACTIVE';
    set.deferredUntil = null;
    set.deferralReason = null;
  }
  if (!Object.keys(set).length) throw badRequest('Nothing to change');
  const [row] = await db.transaction(async (tx) => {
    const updated = await tx.update(bloodDonors).set(set).where(eq(bloodDonors.id, id)).returning();
    await audit(
      {
        action: AuditAction.DONOR_CHANGED,
        actor: ctx,
        resourceType: 'blood_donor',
        resourceId: id,
        patientId: donor.patientId,
        meta: requestMeta(req),
        metadata: {
          change: input.lift ? 'deferral_lifted' : input.defer ? 'deferred' : 'consent',
          contactConsent: input.contactConsent,
          reason: input.lift?.reason ?? input.defer?.reason,
        },
      },
      tx,
    );
    return updated;
  });
  res.json(row);
});

/* ------------------------------------------------------------------ eligibility & visits -- */

const EligibilityInput = z.object({
  answers: Answers.default({}),
  measurements: Measurements.default({}),
});

/** Live eligibility for the visit form (nothing is stored). */
bloodDonorsRouter.post('/donors/:id/eligibility', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const input = parse(EligibilityInput, req.body ?? {});
  const { facts } = await loadDonor(id);
  const problems = evaluateEligibility(facts, input.answers, input.measurements);
  res.json({
    eligible: problems.length === 0,
    problems: problems.map(problemOut),
    deferral: deferralFrom(problems),
    nextEligibleDate: nextEligibleDate(facts),
  });
});

const VisitInput = z
  .object({
    answers: Answers,
    medications: z.string().trim().max(300).optional().nullable(),
    measurements: Measurements,
    outcome: z.enum(['COMPLETED', 'DEFERRED', 'ABORTED']),
    volumeMl: z.number().int().min(0).max(600).optional().nullable(),
    /** For a deferral that no rule covers (days and reason), e.g. the donor feels faint. */
    manualDeferral: z
      .object({
        days: z.number().int().min(1).max(3650),
        reason: z.string().trim().min(5).max(300),
      })
      .optional()
      .nullable(),
    adverseReaction: z.string().trim().max(300).optional().nullable(),
  })
  .refine((v) => v.outcome !== 'COMPLETED' || v.volumeMl != null, {
    message: 'Enter the volume collected',
    path: ['volumeMl'],
  });

bloodDonorsRouter.post('/donors/:id/donations', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const input = parse(VisitInput, req.body);
  const meta = requestMeta(req);
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    // One visit at a time per donor (interval and yearly limits depend on the previous ones).
    await tx.execute(sql`SELECT 1 FROM blood_donors WHERE id = ${id} FOR UPDATE`);
    const loaded = await donorFacts(id, tx);
    if (!loaded) throw notFound('Donor not found');
    const { donor, facts } = loaded;
    const problems = evaluateEligibility(facts, input.answers, input.measurements, now);
    if (input.outcome === 'COMPLETED') {
      const m = input.measurements;
      if ([m.haemoglobin, m.systolic, m.diastolic, m.pulse, m.weightKg].some((x) => x == null)) {
        throw badRequest('Enter haemoglobin, blood pressure, pulse and weight before collecting');
      }
      if (problems.length) {
        throw new HttpError(
          409,
          'NOT_ELIGIBLE',
          'The donor is not eligible today',
          problems.map(problemOut),
        );
      }
      const [min, max] = LIMITS.volume;
      if (input.volumeMl! < min || input.volumeMl! > max) {
        throw badRequest(`A whole-blood donation is ${min}–${max} ml`);
      }
    }
    if (input.outcome === 'DEFERRED' && !problems.length && !input.manualDeferral) {
      throw badRequest('Give the reason and length of the deferral');
    }
    const ruleDeferral = deferralFrom(problems, now);
    const manualUntil = input.manualDeferral
      ? isoDate(new Date(now.getTime() + input.manualDeferral.days * DAY_MS))
      : null;
    const deferralText =
      input.outcome === 'DEFERRED'
        ? [
            ...problems.map((p) => p.code),
            ...(input.manualDeferral ? [input.manualDeferral.reason] : []),
          ].join('; ')
        : null;
    const [donation] = await tx
      .insert(bloodDonations)
      .values({
        donorId: id,
        patientId: donor.patientId,
        facilityId: ctx.facilityId!,
        attendedAt: now,
        questionnaire: {
          answers: input.answers,
          medications: input.medications ?? null,
          problems: problems.map((p) => p.code),
        },
        haemoglobin: input.measurements.haemoglobin?.toString() ?? null,
        systolic: input.measurements.systolic ?? null,
        diastolic: input.measurements.diastolic ?? null,
        pulse: input.measurements.pulse ?? null,
        weightKg: input.measurements.weightKg?.toString() ?? null,
        outcome: input.outcome,
        deferralReason: deferralText?.slice(0, 300) ?? null,
        volumeMl: input.outcome === 'DEFERRED' ? null : (input.volumeMl ?? null),
        adverseReaction: input.adverseReaction || null,
        recordedById: ctx.userId,
      })
      .returning();

    const set: Partial<typeof bloodDonors.$inferInsert> = {};
    if (input.outcome === 'COMPLETED') {
      set.donationCount = donor.donationCount + 1;
      set.lastDonationAt = now;
      if (!donor.firstDonationAt) set.firstDonationAt = now;
    } else if (input.outcome === 'ABORTED') {
      // Blood was lost: the interval runs from today (the count is unchanged).
      set.lastDonationAt = now;
    } else {
      // Rule deferrals win; a permanent one is never shortened by a manual one.
      if (ruleDeferral?.status === 'PERMANENTLY_DEFERRED') {
        set.status = 'PERMANENTLY_DEFERRED';
        set.deferredUntil = null;
        set.deferralReason = deferralText?.slice(0, 300) ?? null;
      } else if (donor.status !== 'PERMANENTLY_DEFERRED') {
        const until = [ruleDeferral?.until, manualUntil].filter(Boolean).sort().pop() ?? null;
        // A new deferral only ever extends an existing one.
        if (until && (!donor.deferredUntil || until > donor.deferredUntil)) {
          set.status = 'DEFERRED';
          set.deferredUntil = until;
          set.deferralReason = deferralText?.slice(0, 300) ?? null;
        }
      }
    }
    if (Object.keys(set).length) {
      await tx.update(bloodDonors).set(set).where(eq(bloodDonors.id, id));
    }
    await audit(
      {
        action: AuditAction.DONATION_RECORDED,
        actor: ctx,
        resourceType: 'blood_donation',
        resourceId: donation!.id,
        patientId: donor.patientId,
        meta,
        metadata: { stage: 'VISIT', outcome: input.outcome },
      },
      tx,
    );
    const [person] = await tx
      .select({ userId: patients.userId })
      .from(patients)
      .where(eq(patients.id, donor.patientId));
    if (person?.userId && input.outcome === 'COMPLETED') {
      await notifyUsers(
        [person.userId],
        {
          type: 'blood_donation',
          title: 'Thank you for donating blood today',
          body: 'Your donation can help save up to three lives.',
          link: '/portal/blood-donation',
        },
        tx,
      );
    }
    return { donation: donation!, problems };
  });
  res.status(201).json({ ...result.donation, problems: result.problems.map(problemOut) });
});

/** A reaction noticed after the donation (fainting, haematoma …) – added once. */
bloodDonorsRouter.post('/donations/:id/adverse-reaction', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const { description } = parse(
    z.object({ description: z.string().trim().min(3).max(300) }),
    req.body,
  );
  const [d] = await db
    .select()
    .from(bloodDonations)
    .where(and(eq(bloodDonations.id, id), eq(bloodDonations.facilityId, ctx.facilityId!)));
  if (!d) throw notFound('Donation not found');
  if (d.adverseReaction) throw conflict('A reaction is already recorded for this donation');
  const [row] = await db
    .update(bloodDonations)
    .set({ adverseReaction: description })
    .where(eq(bloodDonations.id, id))
    .returning();
  await audit({
    action: AuditAction.DONATION_RECORDED,
    actor: ctx,
    resourceType: 'blood_donation',
    resourceId: id,
    patientId: d.patientId,
    meta: requestMeta(req),
    metadata: { stage: 'ADVERSE_REACTION' },
  });
  res.json(row);
});

/* ------------------------------------------------------------------ testing & release ----- */

const Marker = z.enum(['NEGATIVE', 'REACTIVE']);
const TestInput = z.object({
  abo: Abo,
  rhD: Rh,
  hiv: Marker,
  hbv: Marker,
  hcv: Marker,
  syphilis: Marker,
  /** The screening laboratory's own sample or report number. */
  labReference: z.string().trim().max(60).optional(),
});

/**
 * Mandatory tests of a completed donation. All markers negative → the whole-blood unit is created
 * and released to stock. Any reactive marker → the unit is created as discarded (traceability), the
 * donor is permanently deferred and the blood bank doctors are asked to counsel them.
 */
bloodDonorsRouter.post('/donations/:id/tests', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const input = parse(TestInput, req.body);
  const meta = requestMeta(req);
  const now = new Date();
  const reactive = MARKERS.filter((m) => input[m] === 'REACTIVE');
  const out = await db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(bloodDonations)
      .where(and(eq(bloodDonations.id, id), eq(bloodDonations.facilityId, ctx.facilityId!)))
      .for('update');
    if (!d) throw notFound('Donation not found');
    if (d.outcome !== 'COMPLETED') throw conflict('Only completed donations are tested');
    if (d.bloodUnitId) throw conflict('The tests of this donation are already recorded');
    const [donor] = await tx.select().from(bloodDonors).where(eq(bloodDonors.id, d.donorId));
    if (!donor) throw notFound('Donor not found');
    if (donor.abo && (donor.abo !== input.abo || donor.rhD !== input.rhD)) {
      throw conflict(
        "The blood group differs from the donor's previous group – retest the sample before release",
      );
    }
    const expiresAt = new Date(d.attendedAt.getTime() + WHOLE_BLOOD_SHELF_DAYS * DAY_MS);
    const passed = reactive.length === 0;
    const expired = expiresAt <= now;
    const unitNumber = await nextDonationUnitNumber(tx, d.attendedAt);
    const [unit] = await tx
      .insert(bloodUnits)
      .values({
        facilityId: d.facilityId,
        unitNumber,
        product: 'WHOLE_BLOOD',
        abo: input.abo,
        rhD: input.rhD,
        volumeMl: d.volumeMl ?? 450,
        collectedAt: d.attendedAt,
        expiresAt,
        status: passed && !expired ? 'AVAILABLE' : 'DISCARDED',
        discardReason: !passed ? SCREENING_DISCARD : expired ? EXPIRED_UNTESTED : null,
        receivedById: ctx.userId,
      })
      .returning();
    await tx.update(bloodDonations).set({ bloodUnitId: unit!.id }).where(eq(bloodDonations.id, id));
    await tx.insert(bloodGroupTests).values({
      patientId: d.patientId,
      facilityId: d.facilityId,
      abo: input.abo,
      rhD: input.rhD,
      testedById: ctx.userId,
      testedAt: now,
    });
    // The individual results, for blood bank staff only (append-only).
    await tx.insert(donationTestResults).values({
      donationId: id,
      hiv: input.hiv,
      hbv: input.hbv,
      hcv: input.hcv,
      syphilis: input.syphilis,
      aboGroup: input.abo,
      rhD: input.rhD,
      labReference: input.labReference ?? null,
      testedById: ctx.userId,
      testedAt: now,
    });
    const donorSet: Partial<typeof bloodDonors.$inferInsert> = { abo: input.abo, rhD: input.rhD };
    if (!passed) {
      donorSet.status = 'PERMANENTLY_DEFERRED';
      donorSet.deferredUntil = null;
      // Visible to blood bank staff only (never in the portal or notifications).
      donorSet.deferralReason = `Reactive donation screening: ${reactive
        .map((m) => MARKER_LABEL[m])
        .join(', ')} – confirmatory testing and counselling`;
    }
    await tx.update(bloodDonors).set(donorSet).where(eq(bloodDonors.id, donor.id));
    // Which markers were reactive is not written to the audit trail (sensitive).
    await audit(
      {
        action: AuditAction.DONATION_RECORDED,
        actor: ctx,
        resourceType: 'blood_donation',
        resourceId: id,
        patientId: d.patientId,
        meta,
        metadata: { stage: 'TESTED', released: passed && !expired, unitNumber },
      },
      tx,
    );
    if (!passed) {
      const doctors = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(inArray(users.id, await bloodBankStaff(d.facilityId, tx)), eq(users.role, 'DOCTOR')),
        );
      await notifyUsers(
        doctors.map((u) => u.id),
        {
          type: 'blood_donor',
          title: 'A blood donor needs counselling after donation screening',
          link: `/blood-donors?donor=${donor.id}`,
        },
        tx,
      );
    }
    return { unit: unit!, passed, expired };
  });
  await publishBloodBank(ctx.facilityId!);
  res.json({
    released: out.passed && !out.expired,
    unit: { id: out.unit.id, unitNumber: out.unit.unitNumber, status: out.unit.status },
  });
});

/** The recorded screening results of a donation (blood bank staff of the facility only). */
bloodDonorsRouter.get('/donations/:id/tests', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const { id } = parse(IdParam, req.params);
  const [d] = await db
    .select({ id: bloodDonations.id, patientId: bloodDonations.patientId })
    .from(bloodDonations)
    .where(and(eq(bloodDonations.id, id), eq(bloodDonations.facilityId, ctx.facilityId!)));
  if (!d) throw notFound('Donation not found');
  const [r] = await db
    .select({
      hiv: donationTestResults.hiv,
      hbv: donationTestResults.hbv,
      hcv: donationTestResults.hcv,
      syphilis: donationTestResults.syphilis,
      abo: donationTestResults.aboGroup,
      rhD: donationTestResults.rhD,
      labReference: donationTestResults.labReference,
      testedAt: donationTestResults.testedAt,
      testedBy: users.fullName,
    })
    .from(donationTestResults)
    .innerJoin(users, eq(users.id, donationTestResults.testedById))
    .where(eq(donationTestResults.donationId, id));
  if (!r) throw notFound('No test results are recorded for this donation');
  await auditRecordView(ctx, d.patientId, 'UNIT', 'donation-tests', requestMeta(req));
  res.json(r);
});

/* ------------------------------------------------------------------ worklists ------------- */

const listColumns = {
  id: bloodDonations.id,
  donorId: bloodDonations.donorId,
  attendedAt: bloodDonations.attendedAt,
  outcome: bloodDonations.outcome,
  volumeMl: bloodDonations.volumeMl,
  bloodUnitId: bloodDonations.bloodUnitId,
  adverseReaction: bloodDonations.adverseReaction,
  firstName: patients.firstName,
  lastName: patients.lastName,
  nationalId: patients.nationalId,
  abo: bloodDonors.abo,
  rhD: bloodDonors.rhD,
};

/** Today's visits at my blood bank. */
bloodDonorsRouter.get('/today', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const rows = await db
    .select(listColumns)
    .from(bloodDonations)
    .innerJoin(bloodDonors, eq(bloodDonors.id, bloodDonations.donorId))
    .innerJoin(patients, eq(patients.id, bloodDonations.patientId))
    .where(
      and(eq(bloodDonations.facilityId, ctx.facilityId!), gte(bloodDonations.attendedAt, start)),
    )
    .orderBy(desc(bloodDonations.attendedAt));
  res.json({ items: rows });
});

/** Completed donations whose mandatory tests are not recorded yet (no unit in stock). */
bloodDonorsRouter.get('/testing-queue', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const rows = await db
    .select(listColumns)
    .from(bloodDonations)
    .innerJoin(bloodDonors, eq(bloodDonors.id, bloodDonations.donorId))
    .innerJoin(patients, eq(patients.id, bloodDonations.patientId))
    .where(
      and(
        eq(bloodDonations.facilityId, ctx.facilityId!),
        eq(bloodDonations.outcome, 'COMPLETED'),
        isNull(bloodDonations.bloodUnitId),
      ),
    )
    .orderBy(asc(bloodDonations.attendedAt));
  res.json({ items: rows });
});

/** Deferred donors registered at or deferred by my blood bank. */
bloodDonorsRouter.get('/deferrals', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const today = isoDate(new Date());
  const rows = await db
    .select({ ...donorColumns, deferralReason: bloodDonors.deferralReason })
    .from(bloodDonors)
    .innerJoin(patients, eq(patients.id, bloodDonors.patientId))
    .where(
      and(
        eq(bloodDonors.registeredAtFacilityId, ctx.facilityId!),
        or(
          eq(bloodDonors.status, 'PERMANENTLY_DEFERRED'),
          and(eq(bloodDonors.status, 'DEFERRED'), sql`${bloodDonors.deferredUntil} > ${today}`),
        ),
      ),
    )
    .orderBy(asc(bloodDonors.deferredUntil))
    .limit(200);
  res.json({ items: rows });
});

/* ------------------------------------------------------------------ appeals --------------- */

const AppealInput = z.object({ abo: Abo, rhD: Rh.optional().nullable() });

/**
 * Ask eligible donors of a needed group to come and donate: only donors who consented to be
 * contacted, are eligible today and were not appealed to in the last 4 weeks.
 */
bloodDonorsRouter.post('/appeals', async (req, res) => {
  const ctx = requireAuth(req);
  await assertStaff(ctx);
  const input = parse(AppealInput, req.body);
  const now = new Date();
  const candidates = await db
    .select({ id: bloodDonors.id, userId: patients.userId })
    .from(bloodDonors)
    .innerJoin(patients, eq(patients.id, bloodDonors.patientId))
    .where(
      and(
        eq(bloodDonors.contactConsent, true),
        eq(bloodDonors.abo, input.abo),
        input.rhD ? eq(bloodDonors.rhD, input.rhD) : undefined,
        inArray(bloodDonors.status, ['ACTIVE', 'DEFERRED']),
        isNull(patients.deceasedAt),
        isNull(patients.mergedIntoId),
      ),
    );
  let sent = 0;
  let recentlyAsked = 0;
  let notEligible = 0;
  let noPortal = 0;
  const recipients: string[] = [];
  const since = new Date(now.getTime() - APPEAL_INTERVAL_DAYS * DAY_MS);
  for (const c of candidates) {
    if (!c.userId) {
      noPortal++;
      continue;
    }
    const loaded = await donorFacts(c.id);
    if (!loaded || nextEligibleDate(loaded.facts, now) > isoDate(now)) {
      notEligible++;
      continue;
    }
    const [recent] = await db
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, c.userId),
          eq(notifications.type, 'blood_appeal'),
          gte(notifications.createdAt, since),
        ),
      );
    if (Number(recent?.n ?? 0) > 0) {
      recentlyAsked++;
      continue;
    }
    recipients.push(c.userId);
    sent++;
  }
  await notifyUsers(recipients, {
    type: 'blood_appeal',
    title: 'Blood group {group} is needed – can you donate?',
    vars: { group: input.rhD ? groupLabel(input.abo, input.rhD) : input.abo },
    body: 'Please come to the blood bank in the next days if you feel well.',
    link: '/portal/blood-donation',
  });
  await audit({
    action: AuditAction.DONOR_CHANGED,
    actor: ctx,
    resourceType: 'blood_donor_appeal',
    meta: requestMeta(req),
    metadata: {
      abo: input.abo,
      rhD: input.rhD ?? null,
      sent,
      recentlyAsked,
      notEligible,
      noPortal,
    },
  });
  res.json({ sent, recentlyAsked, notEligible, noPortal });
});

/* ------------------------------------------------------------------ portal --------------- */

/** The donor card in the portal: no test results and no sensitive deferral reasons. */
bloodDonorsRouter.get('/mine', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.patientId) throw forbidden();
  if (ctx.proxy) throw forbidden('Blood donation is personal: only the donor can see it');
  const [donor] = await db
    .select()
    .from(bloodDonors)
    .where(eq(bloodDonors.patientId, ctx.patientId));
  if (!donor) {
    res.json({ registered: false });
    return;
  }
  const loaded = await donorFacts(donor.id);
  const donations = await db
    .select({
      attendedAt: bloodDonations.attendedAt,
      outcome: bloodDonations.outcome,
      facilityName: facilities.name,
    })
    .from(bloodDonations)
    .innerJoin(facilities, eq(facilities.id, bloodDonations.facilityId))
    .where(eq(bloodDonations.donorId, donor.id))
    .orderBy(desc(bloodDonations.attendedAt))
    .limit(30);
  const today = isoDate(new Date());
  const state =
    donor.status === 'PERMANENTLY_DEFERRED'
      ? 'CONTACT_BLOOD_BANK'
      : donor.status === 'DEFERRED' && donor.deferredUntil && donor.deferredUntil > today
        ? 'TEMPORARILY_DEFERRED'
        : 'ACTIVE';
  res.json({
    registered: true,
    group: donor.abo ? { abo: donor.abo, rhD: donor.rhD } : null,
    donationCount: donor.donationCount,
    firstDonationAt: donor.firstDonationAt,
    lastDonationAt: donor.lastDonationAt,
    state,
    deferredUntil: state === 'TEMPORARILY_DEFERRED' ? donor.deferredUntil : null,
    nextEligibleDate: state === 'CONTACT_BLOOD_BANK' ? null : nextEligibleDate(loaded!.facts),
    contactConsent: donor.contactConsent,
    donations: donations.map((d) => ({
      attendedAt: d.attendedAt,
      // A deferral or interrupted collection is shown as "not collected", without the reason.
      outcome: d.outcome === 'COMPLETED' ? 'COMPLETED' : 'NOT_COLLECTED',
      facilityName: d.facilityName,
    })),
  });
});

bloodDonorsRouter.patch('/mine', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.patientId || ctx.proxy) throw forbidden();
  const { contactConsent } = parse(z.object({ contactConsent: z.boolean() }), req.body);
  const [donor] = await db
    .update(bloodDonors)
    .set({ contactConsent })
    .where(eq(bloodDonors.patientId, ctx.patientId))
    .returning({ id: bloodDonors.id });
  if (!donor) throw notFound('You are not registered as a blood donor');
  await audit({
    action: AuditAction.DONOR_CHANGED,
    actor: ctx,
    resourceType: 'blood_donor',
    resourceId: donor.id,
    patientId: ctx.patientId,
    meta: requestMeta(req),
    metadata: { change: 'consent', contactConsent },
  });
  res.json({ contactConsent });
});

/* ------------------------------------------------------------------ statistics ------------ */

const suppress = (n: number) => (n > 0 && n < SMALL_CELL_THRESHOLD ? null : n);

/**
 * Director (own facility) and Ministry (national): donations per month, deferral reasons,
 * repeat donors and the units released to stock. Small counts are hidden where they could
 * identify a donor (deferral reasons).
 */
bloodDonorsRouter.get('/stats', async (req, res) => {
  const ctx = requireAuth(req);
  const staff = await isBloodBankStaff(ctx.userId, ctx.facilityId);
  if (ctx.role !== 'DIRECTOR' && ctx.role !== 'MINISTRY' && !staff) throw forbidden();
  const facilityId = ctx.role === 'MINISTRY' ? null : ctx.facilityId;
  if (ctx.role !== 'MINISTRY' && !facilityId) throw forbidden();
  // Twelve whole calendar months, this one included (so no month appears twice in the chart).
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCMonth(since.getUTCMonth() - 11);
  const where = and(
    gte(bloodDonations.attendedAt, since),
    facilityId ? eq(bloodDonations.facilityId, facilityId) : undefined,
  );
  const monthly = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${bloodDonations.attendedAt}), 'YYYY-MM')`,
      outcome: bloodDonations.outcome,
      n: count(),
    })
    .from(bloodDonations)
    .where(where)
    .groupBy(sql`1`, bloodDonations.outcome)
    .orderBy(sql`1`);
  const reasons = await db.execute<{ code: string; n: number }>(sql`
    SELECT code, count(*)::int AS n
    FROM ${bloodDonations}, jsonb_array_elements_text(${bloodDonations.questionnaire} -> 'problems') AS code
    WHERE ${bloodDonations.outcome} = 'DEFERRED' AND ${bloodDonations.attendedAt} >= ${since}
      ${facilityId ? sql`AND ${bloodDonations.facilityId} = ${facilityId}` : sql``}
    GROUP BY code ORDER BY n DESC`);
  const [retention] = await db
    .execute<{ donors: number; repeat: number }>(
      sql`
    SELECT count(*)::int AS donors,
           count(*) FILTER (WHERE earlier)::int AS repeat
    FROM (
      SELECT d.donor_id,
             bool_or(EXISTS (SELECT 1 FROM blood_donations e
                             WHERE e.donor_id = d.donor_id AND e.outcome = 'COMPLETED'
                               AND e.attended_at < ${since})) AS earlier
      FROM blood_donations d
      WHERE d.outcome = 'COMPLETED' AND d.attended_at >= ${since}
        ${facilityId ? sql`AND d.facility_id = ${facilityId}` : sql``}
      GROUP BY d.donor_id
    ) x`,
    )
    .then((r) => r.rows);
  const units = await releasedUnits(since, facilityId);
  const months = new Map<
    string,
    { month: string; completed: number; deferred: number; aborted: number }
  >();
  for (const r of monthly) {
    const m = months.get(r.month) ?? { month: r.month, completed: 0, deferred: 0, aborted: 0 };
    if (r.outcome === 'COMPLETED') m.completed = Number(r.n);
    else if (r.outcome === 'DEFERRED') m.deferred = Number(r.n);
    else m.aborted = Number(r.n);
    months.set(r.month, m);
  }
  const donors = Number(retention?.donors ?? 0);
  const repeat = Number(retention?.repeat ?? 0);
  res.json({
    scope: facilityId ? 'FACILITY' : 'NATIONAL',
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    months: [...months.values()],
    deferralReasons: reasons.rows.map((r) => ({ code: r.code, count: suppress(Number(r.n)) })),
    donors,
    repeatDonors: repeat,
    repeatPercent:
      donors >= SMALL_CELL_THRESHOLD ? Math.round((repeat / donors) * 1000) / 10 : null,
    unitsReleased: units
      .map((u) => ({ group: groupLabel(u.abo, u.rhD), count: Number(u.n) }))
      .sort((a, b) => a.group.localeCompare(b.group)),
  });
});
