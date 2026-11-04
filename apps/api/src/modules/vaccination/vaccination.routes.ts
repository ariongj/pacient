import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { facilities, immunizations, vaccineSchedule } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { paginated, PaginationSchema } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertDemographicsAccess,
  getPatientOrThrow,
  resolveClinicalReadAccess,
  WRITERS,
  resolveAndAuditRead,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { viewFor } from '../clinical/clinical.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  activeSchedule,
  addDays,
  ADULT_AGE_DAYS,
  computeStatus,
  lastAgeDays,
  matchDoses,
  recordedDoses,
} from './vaccination.service.js';

/**
 * National childhood vaccination calendar: the schedule (Ministry), each child's status (care
 * team, the patient, guardians; reception sees only which doses are due), recording a scheduled
 * dose, facility due lists and national coverage with small-cell suppression.
 */
export const vaccinationRouter = Router();
vaccinationRouter.use(authenticate);

const PatientParam = z.object({ patientId: z.string().uuid() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/* ------------------------------------------------------------------------------ schedule -- */

vaccinationRouter.get('/schedule', async (_req, res) => {
  const rows = await db
    .select()
    .from(vaccineSchedule)
    .orderBy(vaccineSchedule.sortOrder, vaccineSchedule.recommendedAgeDays);
  res.json({ items: rows });
});

const ScheduleInput = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9_]{2,40}$/, 'Use capital letters, digits and _'),
    vaccine: z.string().trim().min(2).max(200),
    doseNumber: z.number().int().min(1).max(10),
    recommendedAgeDays: z.number().int().min(0).max(ADULT_AGE_DAYS),
    overdueAgeDays: z.number().int().min(0).max(ADULT_AGE_DAYS),
    description: z.string().trim().max(500).optional().nullable(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.overdueAgeDays >= v.recommendedAgeDays, {
    message: 'The overdue age must not be before the recommended age',
    path: ['overdueAgeDays'],
  });

vaccinationRouter.post('/schedule', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(ScheduleInput, req.body);
  const [existing] = await db
    .select({ id: vaccineSchedule.id })
    .from(vaccineSchedule)
    .where(eq(vaccineSchedule.code, input.code));
  if (existing) throw conflict('A dose with this code already exists');
  const row = await db.transaction(async (tx) => {
    const [created] = await tx.insert(vaccineSchedule).values(input).returning();
    await audit(
      {
        action: AuditAction.VACCINE_SCHEDULE_CHANGED,
        actor: ctx,
        resourceType: 'vaccine_schedule',
        resourceId: created!.id,
        meta: requestMeta(req),
        metadata: { op: 'create', ...input },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

vaccinationRouter.patch('/schedule/:id', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const input = parse(
    z
      .object({
        vaccine: z.string().trim().min(2).max(200).optional(),
        recommendedAgeDays: z.number().int().min(0).max(ADULT_AGE_DAYS).optional(),
        overdueAgeDays: z.number().int().min(0).max(ADULT_AGE_DAYS).optional(),
        description: z.string().trim().max(500).optional().nullable(),
        sortOrder: z.number().int().min(0).max(1000).optional(),
        isActive: z.boolean().optional(),
      })
      .refine((v) => Object.keys(v).length > 0, 'Nothing to change'),
    req.body,
  );
  const [current] = await db.select().from(vaccineSchedule).where(eq(vaccineSchedule.id, id));
  if (!current) throw notFound('Schedule dose not found');
  const recommended = input.recommendedAgeDays ?? current.recommendedAgeDays;
  const overdue = input.overdueAgeDays ?? current.overdueAgeDays;
  if (overdue < recommended)
    throw badRequest('The overdue age must not be before the recommended age');
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(vaccineSchedule)
      .set(input)
      .where(eq(vaccineSchedule.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.VACCINE_SCHEDULE_CHANGED,
        actor: ctx,
        resourceType: 'vaccine_schedule',
        resourceId: id,
        meta: requestMeta(req),
        metadata: { op: 'update', code: current.code, ...input },
      },
      tx,
    );
    return updated!;
  });
  res.json(row);
});

/* --------------------------------------------------------------------------- child status -- */

vaccinationRouter.get('/patients/:patientId/status', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const now = new Date();

  // Reception books vaccination appointments: it sees which doses are due, nothing clinical.
  if (ctx.role === 'RECEPTION') {
    const patient = await assertDemographicsAccess(ctx, patientId);
    const schedule = await activeSchedule();
    const recorded = await recordedDoses(patientId);
    const status = computeStatus(patient.dateOfBirth, schedule, recorded, now);
    res.json({
      patient: patientSummary(patient),
      ageDays: status.ageDays,
      nextDueDate: status.nextDueDate,
      clinical: false,
      doses: status.doses.map((d) => ({
        scheduleItemId: d.item.id,
        code: d.item.code,
        vaccine: d.item.vaccine,
        doseNumber: d.item.doseNumber,
        state: d.state,
        dueDate: d.dueDate,
        overdueDate: d.overdueDate,
      })),
    });
    return;
  }

  const basis = await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'vaccinations');
  const view = viewFor(basis);
  const patient = await getPatientOrThrow(patientId);
  const schedule = await activeSchedule();
  const recorded = await recordedDoses(patientId, db, { hideConfidential: view.hideConfidential });
  const status = computeStatus(patient.dateOfBirth, schedule, recorded, now);
  const matched = new Set([...matchDoses(schedule, recorded).values()].map((r) => r.id));
  res.json({
    patient: patientSummary(patient),
    ageDays: status.ageDays,
    nextDueDate: status.nextDueDate,
    clinical: true,
    doses: status.doses.map((d) => ({
      scheduleItemId: d.item.id,
      code: d.item.code,
      vaccine: d.item.vaccine,
      doseNumber: d.item.doseNumber,
      description: d.item.description,
      recommendedAgeDays: d.item.recommendedAgeDays,
      state: d.state,
      dueDate: d.dueDate,
      overdueDate: d.overdueDate,
      given: d.given
        ? {
            immunizationId: d.given.id,
            administeredAt: d.given.administeredAt,
            administeredBy: d.given.administeredBy,
            lotNumber: view.patientView ? null : d.given.lotNumber,
            site: d.given.site,
            linked: d.given.scheduleItemId === d.item.id,
          }
        : null,
    })),
    // Immunizations that do not count for any schedule dose (travel, seasonal flu, catch-up…).
    other: recorded
      .filter((r) => !matched.has(r.id))
      .map((r) => ({
        immunizationId: r.id,
        vaccine: r.vaccine,
        doseNumber: r.doseNumber,
        administeredAt: r.administeredAt,
      })),
  });
});

function patientSummary(p: {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: string;
  temporaryIdentity?: string | null;
}) {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    dateOfBirth: p.dateOfBirth,
    sex: p.sex,
    temporaryIdentity: p.temporaryIdentity ?? null,
  };
}

/* ------------------------------------------------------------------------- record a dose -- */

const DoseInput = z.object({
  scheduleItemId: z.string().uuid(),
  administeredAt: z
    .string()
    .datetime({ offset: true })
    .optional()
    .refine(
      (d) => !d || new Date(d) <= new Date(Date.now() + 5 * 60_000),
      'Cannot be in the future',
    ),
  lotNumber: z.string().trim().max(60).optional().nullable(),
  site: z.string().trim().max(60).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

vaccinationRouter.post('/patients/:patientId/doses', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(DoseInput, req.body);
  await assertClinicalWriteAccess(ctx, patientId, requestMeta(req), WRITERS.careTeam);
  const [item] = await db
    .select()
    .from(vaccineSchedule)
    .where(eq(vaccineSchedule.id, input.scheduleItemId));
  if (!item) throw notFound('Schedule dose not found');
  const patient = await getPatientOrThrow(patientId);
  const administeredAt = input.administeredAt ? new Date(input.administeredAt) : new Date();
  if (administeredAt.toISOString().slice(0, 10) < patient.dateOfBirth) {
    throw badRequest('A vaccination cannot be before the date of birth');
  }

  const row = await db.transaction(async (tx) => {
    // Serialise recordings for this patient so the same dose cannot be recorded twice at once.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vaccination:${patientId}`}))`);
    const recorded = await recordedDoses(patientId, tx);
    if (matchDoses([item], recorded).has(item.id)) {
      throw conflict('This dose is already recorded');
    }
    const [created] = await tx
      .insert(immunizations)
      .values({
        patientId,
        vaccine: item.vaccine,
        doseNumber: item.doseNumber,
        scheduleItemId: item.id,
        lotNumber: input.lotNumber ?? null,
        site: input.site ?? null,
        notes: input.notes ?? null,
        administeredAt,
        administeredById: ctx.userId,
        facilityId: ctx.facilityId!,
      })
      .returning();
    // Same audit trail as any other vaccination recorded in the chart.
    await audit(
      {
        action: AuditAction.CLINICAL_ENTRY_CREATED,
        actor: ctx,
        resourceType: 'immunization',
        resourceId: created!.id,
        patientId,
        meta: requestMeta(req),
        metadata: { scheduleCode: item.code },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

/** Counts an already recorded vaccination (e.g. entered by hand) for a schedule dose. */
vaccinationRouter.post('/patients/:patientId/link', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(
    z.object({ immunizationId: z.string().uuid(), scheduleItemId: z.string().uuid() }),
    req.body,
  );
  await assertClinicalWriteAccess(ctx, patientId, requestMeta(req), WRITERS.careTeam);
  const [item] = await db
    .select()
    .from(vaccineSchedule)
    .where(eq(vaccineSchedule.id, input.scheduleItemId));
  if (!item) throw notFound('Schedule dose not found');
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`vaccination:${patientId}`}))`);
    const [imm] = await tx
      .select()
      .from(immunizations)
      .where(
        and(eq(immunizations.id, input.immunizationId), eq(immunizations.patientId, patientId)),
      );
    if (!imm) throw notFound('Vaccination not found');
    if (imm.scheduleItemId && imm.scheduleItemId !== item.id) {
      throw conflict('This vaccination already counts for another dose');
    }
    const others = (await recordedDoses(patientId, tx)).filter((r) => r.id !== imm.id);
    if (matchDoses([item], others).has(item.id)) {
      throw conflict('This dose is already recorded');
    }
    const [updated] = await tx
      .update(immunizations)
      .set({ scheduleItemId: item.id })
      .where(eq(immunizations.id, imm.id))
      .returning();
    await audit(
      {
        action: AuditAction.CLINICAL_ENTRY_UPDATED,
        actor: ctx,
        resourceType: 'immunization',
        resourceId: imm.id,
        patientId,
        meta: requestMeta(req),
        metadata: { linkedScheduleCode: item.code },
      },
      tx,
    );
    return updated!;
  });
  res.json(row);
});

/* ------------------------------------------------------------------------------ due lists -- */

const DueQuery = PaginationSchema.extend({
  status: z.enum(['DUE', 'OVERDUE', 'UPCOMING']).optional(),
  /** For UPCOMING: doses becoming due within this many days (default 14). */
  withinDays: z.coerce.number().int().min(1).max(90).default(14),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().trim().max(100).optional(),
});

type DueRow = {
  patient_id: string;
  first_name: string;
  last_name: string;
  national_id: string;
  date_of_birth: string;
  sex: string;
  temporary_identity: string | null;
  age_days: number;
  has_guardian: boolean;
  has_contact: boolean;
  schedule_item_id: string;
  code: string;
  vaccine: string;
  dose_number: number;
  recommended_age_days: number;
  overdue_age_days: number;
};

vaccinationRouter.get('/due', requireRole('NURSE', 'DOCTOR', 'RECEPTION'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const q = parse(DueQuery, req.query);
  const today = new Date().toISOString().slice(0, 10);
  // Open doses of children registered here: due now, overdue, or becoming due soon.
  const horizon = q.status === 'UPCOMING' || !q.status ? q.withinDays : 0;
  const result = await db.execute<DueRow>(sql`
    WITH kids AS (
      SELECT p.id, p.first_name, p.last_name, p.national_id, p.date_of_birth, p.sex,
             p.temporary_identity, p.phone, p.email, p.user_id,
             (${today}::date - p.date_of_birth) AS age_days
      FROM patients p
      WHERE p.primary_facility_id = ${ctx.facilityId}
        AND p.merged_into_id IS NULL
        AND p.date_of_birth > (${today}::date - interval '18 years')
        ${q.q ? sql`AND (p.first_name || ' ' || p.last_name ILIKE ${`%${q.q}%`} OR p.national_id ILIKE ${`${q.q}%`})` : sql``}
    )
    SELECT k.id AS patient_id, k.first_name, k.last_name, k.national_id,
           k.date_of_birth::text AS date_of_birth, k.sex, k.temporary_identity, k.age_days,
           EXISTS (SELECT 1 FROM guardianships g WHERE g.patient_id = k.id AND g.revoked_at IS NULL
                   AND g.valid_from <= now() AND g.valid_until > now()) AS has_guardian,
           (k.phone IS NOT NULL OR k.email IS NOT NULL OR k.user_id IS NOT NULL) AS has_contact,
           vs.id AS schedule_item_id, vs.code, vs.vaccine, vs.dose_number,
           vs.recommended_age_days, vs.overdue_age_days
    FROM kids k
    CROSS JOIN vaccine_schedule vs
    WHERE vs.is_active
      AND k.age_days >= vs.recommended_age_days - ${horizon}
      AND NOT EXISTS (
        SELECT 1 FROM immunizations i
        WHERE i.patient_id = k.id
          AND (i.schedule_item_id = vs.id
               OR (i.schedule_item_id IS NULL AND lower(trim(i.vaccine)) = lower(trim(vs.vaccine))
                   AND coalesce(i.dose_number, 1) = vs.dose_number)))
    ORDER BY k.last_name, k.first_name, vs.sort_order`);

  type ChildDose = {
    scheduleItemId: string;
    code: string;
    vaccine: string;
    doseNumber: number;
    state: 'DUE' | 'OVERDUE' | 'UPCOMING';
    dueDate: string;
  };
  const children = new Map<
    string,
    {
      patient: Record<string, unknown>;
      ageDays: number;
      hasGuardian: boolean;
      hasContact: boolean;
      doses: ChildDose[];
    }
  >();
  for (const r of result.rows) {
    const age = Number(r.age_days);
    if (age > lastAgeDays(r.code)) continue; // past the catch-up age
    const state: ChildDose['state'] =
      age < r.recommended_age_days ? 'UPCOMING' : age > r.overdue_age_days ? 'OVERDUE' : 'DUE';
    if (q.status && state !== q.status) continue;
    const dueDate = addDays(r.date_of_birth, r.recommended_age_days);
    if (q.from && dueDate < q.from) continue;
    if (q.to && dueDate > q.to) continue;
    let child = children.get(r.patient_id);
    if (!child) {
      child = {
        patient: {
          id: r.patient_id,
          firstName: r.first_name,
          lastName: r.last_name,
          nationalId: r.national_id,
          dateOfBirth: r.date_of_birth,
          sex: r.sex,
          temporaryIdentity: r.temporary_identity,
        },
        ageDays: age,
        hasGuardian: r.has_guardian,
        hasContact: r.has_contact,
        doses: [],
      };
      children.set(r.patient_id, child);
    }
    child.doses.push({
      scheduleItemId: r.schedule_item_id,
      code: r.code,
      vaccine: r.vaccine,
      doseNumber: r.dose_number,
      state,
      dueDate,
    });
  }
  const rank = (c: { doses: ChildDose[] }) =>
    c.doses.some((d) => d.state === 'OVERDUE') ? 0 : c.doses.some((d) => d.state === 'DUE') ? 1 : 2;
  const all = [...children.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.doses
        .map((d) => d.dueDate)
        .sort()[0]!
        .localeCompare(b.doses.map((d) => d.dueDate).sort()[0]!),
  );
  const counts = {
    children: all.length,
    overdue: all.filter((c) => c.doses.some((d) => d.state === 'OVERDUE')).length,
    due: all.filter((c) => c.doses.some((d) => d.state === 'DUE')).length,
    upcoming: all.filter((c) => c.doses.every((d) => d.state === 'UPCOMING')).length,
  };
  const start = (q.page - 1) * q.pageSize;
  res.json({ ...paginated(all.slice(start, start + q.pageSize), all.length, q), counts });
});

/* ------------------------------------------------------------------------------- coverage -- */

/**
 * Birth cohorts and the doses that define "fully vaccinated" for each. A child counts in a
 * cohort when their age (today) is within the range.
 */
export const COHORTS = {
  '12-23m': {
    label: 'Children aged 12–23 months',
    minDays: 365,
    maxDays: 729,
    doses: ['HEXA_3', 'PCV_3', 'MMR_1'],
  },
  '24-35m': {
    label: 'Children aged 24–35 months',
    minDays: 730,
    maxDays: 1094,
    doses: ['HEXA_3', 'MMR_1', 'DTAP_IPV_B1'],
  },
  '6-7y': {
    label: 'Children aged 6–7 years',
    minDays: 2190,
    maxDays: 2919,
    doses: ['MMR_2', 'DTAP_IPV_B2'],
  },
} as const;
type CohortKey = keyof typeof COHORTS;

const suppress = (n: number) => (n < SMALL_CELL_THRESHOLD ? null : n);

vaccinationRouter.get('/coverage', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(
    z.object({
      cohort: z.enum(Object.keys(COHORTS) as [CohortKey, ...CohortKey[]]).default('12-23m'),
      facilityId: z.string().uuid().optional(),
    }),
    req.query,
  );
  const cohort = COHORTS[q.cohort];
  const facilityFilter = ctx.role === 'DIRECTOR' ? ctx.facilityId! : (q.facilityId ?? null);
  const today = new Date().toISOString().slice(0, 10);
  const schedule = (await activeSchedule()).filter((s) =>
    (cohort.doses as readonly string[]).includes(s.code),
  );
  const doseCols = schedule.map(
    (s) => sql`count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM immunizations i WHERE i.patient_id = k.id
          AND (i.schedule_item_id = ${s.id}
               OR (i.schedule_item_id IS NULL AND lower(trim(i.vaccine)) = lower(trim(${s.vaccine}))
                   AND coalesce(i.dose_number, 1) = ${s.doseNumber}))))::int AS ${sql.identifier(`d_${s.code}`)}`,
  );
  const result = await db.execute<Record<string, string | number>>(sql`
    WITH k AS (
      SELECT p.id, p.primary_facility_id
      FROM patients p
      WHERE p.merged_into_id IS NULL
        AND (${today}::date - p.date_of_birth) BETWEEN ${cohort.minDays} AND ${cohort.maxDays}
        ${facilityFilter ? sql`AND p.primary_facility_id = ${facilityFilter}` : sql``}
    )
    SELECT f.id AS facility_id, f.name AS facility_name, f.region, count(k.id)::int AS children
           ${doseCols.length ? sql`, ${sql.join(doseCols, sql`, `)}` : sql``}
    FROM facilities f
    JOIN k ON k.primary_facility_id = f.id
    GROUP BY f.id, f.name, f.region
    ORDER BY f.name`);

  const shape = (children: number, counts: Record<string, number>) => {
    const visible = suppress(children);
    return {
      children: visible,
      suppressed: visible === null,
      doses: schedule.map((s) => {
        const n = counts[s.code] ?? 0;
        return {
          code: s.code,
          vaccine: s.vaccine,
          doseNumber: s.doseNumber,
          // Small counts are suppressed, and so is the percentage that would reveal them.
          vaccinated: visible === null ? null : suppress(n),
          percent:
            visible === null || (n > 0 && n < SMALL_CELL_THRESHOLD)
              ? null
              : Math.round((n / children) * 1000) / 10,
          lowCount: visible !== null && n > 0 && n < SMALL_CELL_THRESHOLD,
        };
      }),
    };
  };
  const rows = result.rows.map((r) => {
    const children = Number(r.children);
    const counts = Object.fromEntries(schedule.map((s) => [s.code, Number(r[`d_${s.code}`] ?? 0)]));
    return {
      facilityId: String(r.facility_id),
      facilityName: String(r.facility_name),
      region: r.region ? String(r.region) : null,
      ...shape(children, counts),
    };
  });
  const totalChildren = result.rows.reduce((a, r) => a + Number(r.children), 0);
  const totalCounts = Object.fromEntries(
    schedule.map((s) => [
      s.code,
      result.rows.reduce((a, r) => a + Number(r[`d_${s.code}`] ?? 0), 0),
    ]),
  );
  res.json({
    cohort: q.cohort,
    cohortLabel: cohort.label,
    asOf: today,
    threshold: SMALL_CELL_THRESHOLD,
    scope: facilityFilter ? 'FACILITY' : 'NATIONAL',
    total: shape(totalChildren, totalCounts),
    rows,
    cohorts: Object.entries(COHORTS).map(([key, c]) => ({ key, label: c.label })),
  });
});

/** Facility names for the Ministry's filter. */
vaccinationRouter.get('/coverage/facilities', requireRole('MINISTRY'), async (_req, res) => {
  const rows = await db
    .select({ id: facilities.id, name: facilities.name })
    .from(facilities)
    .orderBy(facilities.name);
  res.json({ items: rows });
});
