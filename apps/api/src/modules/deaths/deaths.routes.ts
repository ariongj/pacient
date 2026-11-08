import { Router } from 'express';
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  admissions,
  appointments,
  deathRecordAmendments,
  deathRecords,
  facilities,
  patients,
  refreshTokens,
  registerEnrolments,
  users,
  waitingListEntries,
  waitingListEvents,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  getPatientOrThrow,
  resolveAndAuditRead,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyCareTeam, notifyUsers } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  AMENDABLE_FIELDS,
  amendmentsFor,
  buildMortalityStats,
  wholeMonths,
  checkDeath,
  DeathFields,
  deathsForStats,
  effectiveValues,
  nextCertificateNumber,
  normaliseCauses,
  type DeathValues,
} from './deaths.service.js';

/**
 * Death registration following the WHO international form of the medical certificate of cause of
 * death. A doctor of the patient's care team drafts and signs the certificate; signing assigns the
 * certificate number, records the death on the patient and stops everything that assumes a living
 * patient (future appointments, waiting lists, register recalls, reminders, portal sign-in). Signed
 * certificates are immutable (database trigger); corrections are amendments. Directors see the
 * facility's list without causes; mortality statistics are aggregated with small-cell suppression.
 */
export const deathsRouter = Router();
deathsRouter.use(authenticate);

const IdParam = z.object({ id: z.string().uuid() });
const PatientParam = z.object({ patientId: z.string().uuid() });
const SIGNING_ROLES = ['DOCTOR'] as const;

type DeathRow = typeof deathRecords.$inferSelect;

function valuesFromInput(input: z.infer<typeof DeathFields>): DeathValues {
  return {
    diedAt: input.diedAt,
    placeOfDeath: input.placeOfDeath,
    placeDetail: input.placeDetail ?? null,
    causes: normaliseCauses(input.causes),
    underlyingCauseIcd10: input.underlyingCauseIcd10,
    mannerOfDeath: input.mannerOfDeath,
    autopsy: input.autopsy,
    pregnancyStatus: input.pregnancyStatus ?? null,
    perinatal: (input.perinatal as Record<string, unknown> | null | undefined) ?? null,
    reportedToForensics: input.reportedToForensics,
  };
}

async function loadRecord(id: string) {
  const [row] = await db.select().from(deathRecords).where(eq(deathRecords.id, id));
  if (!row) throw notFound('Death certificate not found');
  return row;
}

async function assertAdmissionOfPatient(admissionId: string | null | undefined, patientId: string) {
  if (!admissionId) return;
  const [a] = await db
    .select({ patientId: admissions.patientId })
    .from(admissions)
    .where(eq(admissions.id, admissionId));
  if (!a || a.patientId !== patientId) throw badRequest('The hospital stay is not this patient’s');
}

async function openAdmissionOf(patientId: string) {
  const [a] = await db
    .select({ id: admissions.id })
    .from(admissions)
    .where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'ADMITTED')));
  return a ?? null;
}

/** Chart view: effective values, the signed original, amendments and the current checks. */
async function presentRecord(row: DeathRow, ctx: AuthContext) {
  const patient = await getPatientOrThrow(row.patientId);
  const amendments = (await amendmentsFor([row.id])).get(row.id) ?? [];
  const values = effectiveValues(row, amendments);
  const people = await db
    .select({ id: users.id, name: users.fullName })
    .from(users)
    .where(
      inArray(users.id, [row.certifiedById, ...amendments.map((a) => a.amendedById)] as string[]),
    );
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? null;
  const [facility] = await db
    .select({ name: facilities.name, code: facilities.code })
    .from(facilities)
    .where(eq(facilities.id, row.facilityId));
  const sameFacility = row.facilityId === ctx.facilityId;
  return {
    id: row.id,
    patientId: row.patientId,
    status: row.status,
    certificateNumber: row.certificateNumber,
    signedAt: row.signedAt,
    certifiedBy: { id: row.certifiedById, name: nameOf(row.certifiedById) },
    facility: { id: row.facilityId, name: facility?.name ?? null, code: facility?.code ?? null },
    admissionId: row.admissionId,
    ...values,
    original:
      amendments.length > 0
        ? {
            diedAt: row.diedAt,
            placeOfDeath: row.placeOfDeath,
            placeDetail: row.placeDetail,
            causes: row.causes,
            underlyingCauseIcd10: row.underlyingCauseIcd10,
            mannerOfDeath: row.mannerOfDeath,
            autopsy: row.autopsy,
            pregnancyStatus: row.pregnancyStatus,
            perinatal: row.perinatal,
            reportedToForensics: row.reportedToForensics,
          }
        : null,
    amendments: amendments.map((a) => ({
      id: a.id,
      changes: a.changes,
      reason: a.reason,
      amendedBy: nameOf(a.amendedById),
      createdAt: a.createdAt,
    })),
    civilRegistryAcknowledgedAt: row.civilRegistryAcknowledgedAt,
    civilRegistryReference: row.civilRegistryReference,
    withdrawnAt: row.withdrawnAt,
    withdrawReason: row.withdrawReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    checks: checkDeath(values, patient),
    canEdit: row.status === 'DRAFT' && ctx.role === 'DOCTOR' && sameFacility,
    canAmend: row.status === 'SIGNED' && ctx.role === 'DOCTOR' && sameFacility,
  };
}

/* ------------------------------------------------------------------ list & statistics ---- */

const ListQuery = PaginationSchema.extend({
  status: z.enum(['DRAFT', 'SIGNED', 'WITHDRAWN']).optional(),
});

/** The facility's certificates (no causes): doctors and the director. */
deathsRouter.get('/', requireRole('DOCTOR', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ListQuery, req.query);
  if (!ctx.facilityId) throw forbidden();
  const where = and(
    eq(deathRecords.facilityId, ctx.facilityId),
    q.status ? eq(deathRecords.status, q.status) : undefined,
  );
  const certifier = sql<string>`(SELECT full_name FROM users u WHERE u.id = ${deathRecords.certifiedById})`;
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: deathRecords.id,
        status: deathRecords.status,
        certificateNumber: deathRecords.certificateNumber,
        diedAt: deathRecords.diedAt,
        placeOfDeath: deathRecords.placeOfDeath,
        signedAt: deathRecords.signedAt,
        createdAt: deathRecords.createdAt,
        civilRegistryAcknowledgedAt: deathRecords.civilRegistryAcknowledgedAt,
        certifiedBy: certifier,
        amendments: sql<number>`(SELECT count(*)::int FROM death_record_amendments x WHERE x.death_record_id = ${deathRecords.id})`,
        patient: {
          id: patients.id,
          firstName: patients.firstName,
          lastName: patients.lastName,
          nationalId: patients.nationalId,
          temporaryIdentity: patients.temporaryIdentity,
          dateOfBirth: patients.dateOfBirth,
          sex: patients.sex,
        },
      })
      .from(deathRecords)
      .innerJoin(patients, eq(patients.id, deathRecords.patientId))
      .where(where)
      .orderBy(desc(deathRecords.diedAt))
      .limit(toOffset(q).limit)
      .offset(toOffset(q).offset),
    db.select({ n: count() }).from(deathRecords).where(where),
  ]);
  res.json(paginated(rows, total?.n ?? 0, q));
});

const StatsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  facilityId: z.string().uuid().optional(),
});

/** Mortality statistics: the director for the facility, the Ministry nationally (no names). */
deathsRouter.get('/stats', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(StatsQuery, req.query);
  const now = new Date();
  // Whole months only: overlapping periods that differ by a day could otherwise be subtracted
  // from each other to reveal a single death.
  const { from, to } = wholeMonths(
    q.from ?? new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() + 1, 1)),
    q.to ?? new Date(now.getTime() + 86_400_000),
  );
  if (from >= to) throw badRequest('The start must be before the end');
  if (to.getTime() - from.getTime() > 5 * 366 * 86_400_000) {
    throw badRequest('Choose a period of at most five years');
  }
  const facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId! : q.facilityId;
  const deaths = await deathsForStats({ from, to, facilityId });
  const [discharges] = await db
    .select({
      n: count(),
      deceased: sql<number>`count(*) FILTER (WHERE ${admissions.disposition} = 'DECEASED')::int`,
    })
    .from(admissions)
    .where(
      and(
        eq(admissions.status, 'DISCHARGED'),
        gte(admissions.dischargedAt, from),
        lt(admissions.dischargedAt, to),
        facilityId ? eq(admissions.facilityId, facilityId) : undefined,
      ),
    );
  res.json({
    scope: facilityId ? 'FACILITY' : 'NATIONAL',
    ...buildMortalityStats(deaths, {
      from,
      to,
      discharges: discharges?.n ?? 0,
      deceasedDischarges: Number(discharges?.deceased ?? 0),
      threshold: SMALL_CELL_THRESHOLD,
    }),
  });
});

/* ------------------------------------------------------------------ chart ---------------- */

/** The patient's death certificate (care team only) or null with whether the caller may start one. */
deathsRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'death_certificate');
  const patient = await getPatientOrThrow(patientId);
  const rows = await db
    .select()
    .from(deathRecords)
    .where(eq(deathRecords.patientId, patientId))
    .orderBy(desc(deathRecords.createdAt));
  // At most one certificate that is not withdrawn (partial unique index).
  const row = rows.find((r) => r.status !== 'WITHDRAWN');
  const openAdmission = await openAdmissionOf(patientId);
  res.json({
    deceasedAt: patient.deceasedAt,
    openAdmission: Boolean(openAdmission),
    canCertify: ctx.role === 'DOCTOR' && !row,
    record: row ? await presentRecord(row, ctx) : null,
    withdrawn: rows
      .filter((r) => r.status === 'WITHDRAWN')
      .map((r) => ({
        id: r.id,
        certificateNumber: r.certificateNumber,
        signedAt: r.signedAt,
        withdrawnAt: r.withdrawnAt,
        withdrawReason: r.withdrawReason,
      })),
  });
});

/** Start a draft certificate. */
deathsRouter.post('/patients/:patientId', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const meta = requestMeta(req);
  await assertClinicalWriteAccess(ctx, patientId, meta, [...SIGNING_ROLES]);
  const input = parse(DeathFields, req.body);
  if (!ctx.facilityId) throw forbidden();
  await assertAdmissionOfPatient(input.admissionId, patientId);
  const v = valuesFromInput(input);
  const created = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: deathRecords.id })
      .from(deathRecords)
      .where(and(eq(deathRecords.patientId, patientId), ne(deathRecords.status, 'WITHDRAWN')));
    if (existing) throw conflict('This patient already has a death certificate');
    const [row] = await tx
      .insert(deathRecords)
      .values({
        patientId,
        facilityId: ctx.facilityId!,
        certifiedById: ctx.userId,
        admissionId: input.admissionId ?? null,
        ...v,
      })
      .returning();
    await audit(
      {
        action: AuditAction.DEATH_CERTIFICATE_DRAFTED,
        actor: ctx,
        resourceType: 'death_record',
        resourceId: row!.id,
        patientId,
        meta,
      },
      tx,
    );
    return row!;
  });
  res.status(201).json(await presentRecord(created, ctx));
});

/** Edit a draft (same facility, care team). */
deathsRouter.patch('/:id', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const row = await loadRecord(id);
  await assertClinicalWriteAccess(ctx, row.patientId, meta, [...SIGNING_ROLES]);
  if (row.facilityId !== ctx.facilityId) {
    throw forbidden('Only doctors of the certifying facility can change this certificate');
  }
  if (row.status !== 'DRAFT') {
    throw conflict('A signed death certificate cannot be edited – record an amendment');
  }
  const input = parse(DeathFields, req.body);
  await assertAdmissionOfPatient(input.admissionId, row.patientId);
  const [updated] = await db
    .update(deathRecords)
    .set({ ...valuesFromInput(input), admissionId: input.admissionId ?? null })
    .where(and(eq(deathRecords.id, id), eq(deathRecords.status, 'DRAFT')))
    .returning();
  if (!updated) throw conflict('The certificate was signed in the meantime');
  res.json(await presentRecord(updated, ctx));
});

/** Discard a draft. */
deathsRouter.delete('/:id', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const row = await loadRecord(id);
  await assertClinicalWriteAccess(ctx, row.patientId, meta, [...SIGNING_ROLES]);
  if (row.facilityId !== ctx.facilityId) {
    throw forbidden('Only doctors of the certifying facility can change this certificate');
  }
  if (row.status !== 'DRAFT') throw conflict('A signed death certificate cannot be deleted');
  await db.transaction(async (tx) => {
    await tx
      .delete(deathRecords)
      .where(and(eq(deathRecords.id, id), eq(deathRecords.status, 'DRAFT')));
    await audit(
      {
        action: AuditAction.DEATH_CERTIFICATE_DRAFTED,
        actor: ctx,
        resourceType: 'death_record',
        resourceId: id,
        patientId: row.patientId,
        meta,
        metadata: { discarded: true },
      },
      tx,
    );
  });
  res.status(204).end();
});

/* ------------------------------------------------------------------ signing -------------- */

const SignInput = z.object({
  /** Codes of the warnings the doctor has read and accepts. */
  acknowledgedWarnings: z.array(z.string().max(60)).max(20).default([]),
});

/**
 * Sign the certificate. Blocked while the patient still has an open hospital stay: the ward first
 * discharges the patient with the outcome "deceased", so bed boards, medication charts and early
 * warning never show a deceased inpatient.
 */
deathsRouter.post('/:id/sign', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const { acknowledgedWarnings } = parse(SignInput, req.body ?? {});
  const row = await loadRecord(id);
  await assertClinicalWriteAccess(ctx, row.patientId, meta, [...SIGNING_ROLES]);
  if (row.facilityId !== ctx.facilityId) {
    throw forbidden('Only doctors of the certifying facility can sign this certificate');
  }
  if (row.status !== 'DRAFT') throw conflict('The death certificate is already signed');
  const patient = await getPatientOrThrow(row.patientId);
  const values = effectiveValues(row, []);
  const { problems, warnings } = checkDeath(values, patient);
  if (problems.length) {
    throw badRequest(
      'The certificate is incomplete',
      problems.map((p) => ({ path: p.field ?? '', message: p.message, code: p.code })),
    );
  }
  const unacknowledged = warnings.filter((w) => !acknowledgedWarnings.includes(w.code));
  if (unacknowledged.length) {
    throw new HttpError(
      409,
      'WARNINGS_NOT_ACKNOWLEDGED',
      'Read and confirm the warnings before signing',
      unacknowledged.map((w) => ({ code: w.code, message: w.message })),
    );
  }
  if (await openAdmissionOf(row.patientId)) {
    throw conflict(
      'The patient is still admitted. Discharge the patient on the ward with the outcome “Deceased”, then sign.',
    );
  }

  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: deathRecords.status })
      .from(deathRecords)
      .where(eq(deathRecords.id, id))
      .for('update');
    if (locked?.status !== 'DRAFT') throw conflict('The death certificate is already signed');
    const certificateNumber = await nextCertificateNumber(tx, now);
    const [signed] = await tx
      .update(deathRecords)
      .set({ status: 'SIGNED', signedAt: now, certificateNumber, certifiedById: ctx.userId })
      .where(eq(deathRecords.id, id))
      .returning();
    await tx
      .update(patients)
      .set({ deceasedAt: values.diedAt })
      .where(eq(patients.id, row.patientId));

    // Future appointments are cancelled; their doctors are told how many.
    const cancelled = await tx
      .update(appointments)
      .set({ status: 'CANCELLED' })
      .where(
        and(
          eq(appointments.patientId, row.patientId),
          inArray(appointments.status, ['REQUESTED', 'CONFIRMED', 'CHECKED_IN']),
          gte(appointments.scheduledAt, now),
        ),
      )
      .returning({ id: appointments.id, doctorId: appointments.doctorId });

    // Open waiting-list entries are removed with the reason "deceased".
    const removed = await tx
      .update(waitingListEntries)
      .set({ status: 'REMOVED', removedReason: 'DECEASED', suspendedSince: null })
      .where(
        and(
          eq(waitingListEntries.patientId, row.patientId),
          inArray(waitingListEntries.status, ['WAITING', 'SCHEDULED', 'SUSPENDED']),
        ),
      )
      .returning({ id: waitingListEntries.id, status: waitingListEntries.status });
    if (removed.length) {
      await tx.insert(waitingListEvents).values(
        removed.map((e) => ({
          entryId: e.id,
          patientId: row.patientId,
          actorId: ctx.userId,
          event: 'REMOVED',
          details: { removedReason: 'DECEASED', deathRecordId: id },
          reason: 'Patient deceased',
        })),
      );
    }

    // Chronic disease registers: no more recalls.
    const left = await tx
      .update(registerEnrolments)
      .set({ status: 'LEFT', leftAt: now, leftReason: 'Deceased' })
      .where(
        and(
          eq(registerEnrolments.patientId, row.patientId),
          eq(registerEnrolments.status, 'ACTIVE'),
        ),
      )
      .returning({ id: registerEnrolments.id });

    // The patient's own portal account is disabled (nothing is deleted).
    let portalDisabled = false;
    if (patient.userId) {
      const disabled = await tx
        .update(users)
        .set({ isActive: false })
        .where(and(eq(users.id, patient.userId), eq(users.isActive, true)))
        .returning({ id: users.id });
      portalDisabled = disabled.length > 0;
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now })
        .where(and(eq(refreshTokens.userId, patient.userId), isNull(refreshTokens.revokedAt)));
    }

    await audit(
      {
        action: AuditAction.DEATH_CERTIFICATE_SIGNED,
        actor: ctx,
        resourceType: 'death_record',
        resourceId: id,
        patientId: row.patientId,
        meta,
        metadata: {
          certificateNumber,
          acknowledgedWarnings: warnings.map((w) => w.code),
          appointmentsCancelled: cancelled.length,
          waitingListRemoved: removed.length,
          registersLeft: left.length,
          portalDisabled,
        },
      },
      tx,
    );

    // No cause of death in notifications.
    await notifyCareTeam(
      row.patientId,
      {
        type: 'death',
        title: 'A death certificate was signed for a patient in your care',
        link: `/doctor/patients/${row.patientId}?tab=death`,
      },
      tx,
      ctx.userId,
    );
    const perDoctor = new Map<string, number>();
    for (const a of cancelled) perDoctor.set(a.doctorId, (perDoctor.get(a.doctorId) ?? 0) + 1);
    for (const [doctorId, n] of perDoctor) {
      if (doctorId === ctx.userId) continue;
      await notifyUsers(
        [doctorId],
        {
          type: 'appointment',
          title: 'Appointments cancelled because the patient has died: {count}',
          vars: { count: n },
          link: '/doctor/schedule',
        },
        tx,
      );
    }
    return {
      signed: signed!,
      effects: {
        appointmentsCancelled: cancelled.length,
        waitingListRemoved: removed.length,
        registersLeft: left.length,
        portalDisabled,
      },
    };
  });
  res.json({ ...(await presentRecord(result.signed, ctx)), effects: result.effects });
});

/* ------------------------------------------------------------------ amendments ----------- */

const AmendInput = z.object({
  changes: DeathFields.partial().strict(),
  reason: z.string().trim().min(10, 'Give the reason for the amendment').max(500),
});

const serialise = (v: unknown) => (v instanceof Date ? v.toISOString() : (v ?? null));

/** Correct a signed certificate; the signed original stays unchanged. */
deathsRouter.post('/:id/amendments', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const row = await loadRecord(id);
  await assertClinicalWriteAccess(ctx, row.patientId, meta, [...SIGNING_ROLES]);
  if (row.facilityId !== ctx.facilityId) {
    throw forbidden('Only doctors of the certifying facility can amend this certificate');
  }
  if (row.status !== 'SIGNED') throw conflict('Only a signed certificate can be amended');
  const { changes, reason } = parse(AmendInput, req.body);
  if ('admissionId' in changes) throw badRequest('The hospital stay cannot be amended');
  const before = effectiveValues(row, (await amendmentsFor([id])).get(id) ?? []);
  const after: DeathValues = { ...before };
  const diff: Record<string, [unknown, unknown]> = {};
  for (const field of AMENDABLE_FIELDS) {
    if (!(field in changes)) continue;
    let next: unknown = (changes as Record<string, unknown>)[field];
    if (field === 'causes') next = normaliseCauses(changes.causes!);
    if (next === undefined) next = null;
    const prev = (before as unknown as Record<string, unknown>)[field];
    if (JSON.stringify(serialise(prev)) === JSON.stringify(serialise(next))) continue;
    diff[field] = [serialise(prev), serialise(next)];
    (after as unknown as Record<string, unknown>)[field] = next;
  }
  if (!Object.keys(diff).length) throw badRequest('Nothing changed');
  const patient = await getPatientOrThrow(row.patientId);
  const { problems } = checkDeath(after, patient);
  if (problems.length) {
    throw badRequest(
      'The amended certificate is incomplete',
      problems.map((p) => ({ path: p.field ?? '', message: p.message, code: p.code })),
    );
  }
  await db.transaction(async (tx) => {
    await tx.insert(deathRecordAmendments).values({
      deathRecordId: id,
      patientId: row.patientId,
      changes: diff,
      reason,
      amendedById: ctx.userId,
    });
    if (diff.diedAt) {
      await tx
        .update(patients)
        .set({ deceasedAt: after.diedAt })
        .where(eq(patients.id, row.patientId));
    }
    await audit(
      {
        action: AuditAction.DEATH_CERTIFICATE_AMENDED,
        actor: ctx,
        resourceType: 'death_record',
        resourceId: id,
        patientId: row.patientId,
        meta,
        metadata: { fields: Object.keys(diff) },
      },
      tx,
    );
  });
  res.status(201).json(await presentRecord(await loadRecord(id), ctx));
});

/* ------------------------------------------------------------------ withdrawal (Ministry) - */

const NumberParam = z.object({
  number: z
    .string()
    .trim()
    .regex(/^VD-\d{4}-\d{6}$/),
});

/** The Ministry finds a signed certificate by its number (identity and dates only, no causes). */
deathsRouter.get('/by-number/:number', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { number } = parse(NumberParam, req.params);
  const [row] = await db
    .select({
      id: deathRecords.id,
      patientId: deathRecords.patientId,
      status: deathRecords.status,
      certificateNumber: deathRecords.certificateNumber,
      diedAt: deathRecords.diedAt,
      signedAt: deathRecords.signedAt,
      withdrawnAt: deathRecords.withdrawnAt,
      withdrawReason: deathRecords.withdrawReason,
      civilRegistryReference: deathRecords.civilRegistryReference,
      facilityName: facilities.name,
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
    })
    .from(deathRecords)
    .innerJoin(patients, eq(patients.id, deathRecords.patientId))
    .innerJoin(facilities, eq(facilities.id, deathRecords.facilityId))
    .where(eq(deathRecords.certificateNumber, number));
  if (!row) throw notFound('Death certificate not found');
  await audit({
    action: AuditAction.PATIENT_RECORD_VIEWED,
    actor: ctx,
    resourceType: 'death_record',
    resourceId: row.id,
    patientId: row.patientId,
    meta: requestMeta(req),
    metadata: { section: 'death_certificate_lookup' },
  });
  res.json(row);
});

const WithdrawInput = z.object({
  reason: z.string().trim().min(20, 'Explain why the certificate is withdrawn').max(500),
  /** Re-enable the person's portal account (disabled when the certificate was signed). */
  restorePortal: z.boolean().default(true),
});

/**
 * Withdraw a signed certificate that was issued in error (e.g. for the wrong person). The record
 * stays as evidence; the person is no longer deceased, register membership and waiting-list
 * entries ended because of the death are restored, and the civil registry sees the withdrawal in
 * its feed. Cancelled appointments are not restored (their slots may have been given away); the
 * care team is told to rebook.
 */
deathsRouter.post('/:id/withdraw', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const { reason, restorePortal } = parse(WithdrawInput, req.body);
  const now = new Date();
  const result = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(deathRecords).where(eq(deathRecords.id, id)).for('update');
    if (!row) throw notFound('Death certificate not found');
    if (row.status !== 'SIGNED') throw conflict('Only a signed death certificate can be withdrawn');
    const [withdrawn] = await tx
      .update(deathRecords)
      .set({
        status: 'WITHDRAWN',
        withdrawnAt: now,
        withdrawnById: ctx.userId,
        withdrawReason: reason,
      })
      .where(eq(deathRecords.id, id))
      .returning();
    await tx.update(patients).set({ deceasedAt: null }).where(eq(patients.id, row.patientId));

    // Register membership ended because of the death (one active row per register).
    const rejoined = await tx.execute<{ id: string }>(sql`
      UPDATE register_enrolments e SET status = 'ACTIVE', left_at = NULL, left_reason = NULL
      WHERE e.patient_id = ${row.patientId} AND e.status = 'LEFT' AND e.left_reason = 'Deceased'
        AND NOT EXISTS (SELECT 1 FROM register_enrolments o WHERE o.patient_id = e.patient_id
                        AND o.register = e.register AND o.status = 'ACTIVE')
      RETURNING e.id`);

    // Waiting-list entries removed because of the death go back on the list.
    const removed = await tx
      .select()
      .from(waitingListEntries)
      .where(
        and(
          eq(waitingListEntries.patientId, row.patientId),
          eq(waitingListEntries.status, 'REMOVED'),
          eq(waitingListEntries.removedReason, 'DECEASED'),
        ),
      );
    for (const e of removed) {
      const status = e.scheduledFor && e.scheduledFor > now ? 'SCHEDULED' : 'WAITING';
      await tx
        .update(waitingListEntries)
        .set({ status, removedReason: null })
        .where(eq(waitingListEntries.id, e.id));
    }
    if (removed.length) {
      await tx.insert(waitingListEvents).values(
        removed.map((e) => ({
          entryId: e.id,
          patientId: row.patientId,
          actorId: ctx.userId,
          event: 'REINSTATED',
          details: { deathRecordId: id },
          reason: 'Death certificate withdrawn',
        })),
      );
    }

    let portalRestored = false;
    const [patient] = await tx
      .select({ userId: patients.userId })
      .from(patients)
      .where(eq(patients.id, row.patientId));
    if (restorePortal && patient?.userId) {
      const restored = await tx
        .update(users)
        .set({ isActive: true })
        .where(and(eq(users.id, patient.userId), eq(users.isActive, false)))
        .returning({ id: users.id });
      portalRestored = restored.length > 0;
    }

    await audit(
      {
        action: AuditAction.DEATH_CERTIFICATE_WITHDRAWN,
        actor: ctx,
        resourceType: 'death_record',
        resourceId: id,
        patientId: row.patientId,
        meta,
        metadata: {
          certificateNumber: row.certificateNumber,
          registersRestored: rejoined.rows.length,
          waitingListRestored: removed.length,
          portalRestored,
        },
      },
      tx,
    );
    await notifyCareTeam(
      row.patientId,
      {
        type: 'death',
        title:
          'A death certificate was withdrawn for a patient in your care – check and rebook appointments',
        link: `/doctor/patients/${row.patientId}?tab=death`,
      },
      tx,
      ctx.userId,
    );
    const directors = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.facilityId, row.facilityId),
          eq(users.role, 'DIRECTOR'),
          eq(users.isActive, true),
        ),
      );
    await notifyUsers(
      [row.certifiedById, ...directors.map((d) => d.id)],
      {
        type: 'death',
        title: 'The Ministry withdrew death certificate {number}',
        vars: { number: row.certificateNumber ?? '' },
        link: '/deaths',
      },
      tx,
    );
    return {
      withdrawn: withdrawn!,
      effects: {
        registersRestored: rejoined.rows.length,
        waitingListRestored: removed.length,
        portalRestored,
      },
    };
  });
  res.json({
    id: result.withdrawn.id,
    status: result.withdrawn.status,
    certificateNumber: result.withdrawn.certificateNumber,
    withdrawnAt: result.withdrawn.withdrawnAt,
    effects: result.effects,
  });
});
