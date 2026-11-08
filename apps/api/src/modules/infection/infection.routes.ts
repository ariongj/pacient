import { Router } from 'express';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  admissions,
  antimicrobialApprovals,
  beds,
  careUnits,
  facilities,
  haiEvents,
  isolationOrders,
  patients,
  prescriptions,
  users,
} from '../../db/schema.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import {
  parse,
  requestMeta,
  requireAuth,
  type AuthContext,
  type RequestMeta,
} from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertNotMerged,
  auditRecordView,
  getPatientOrThrow,
  resolveAndAuditRead,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { assertLicensed } from '../licences/licences.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  HAI_CRITERIA,
  HAI_STATUSES,
  HAI_TYPES,
  PRECAUTION_GUIDANCE,
  PRECAUTIONS,
  RESTRICTED_AGENTS,
  REVIEW_AFTER_HOURS,
  REVIEW_OUTCOMES,
} from './definitions.js';
import {
  haiRates,
  infectionControlStaff,
  isInfectionControl,
  isStewardshipTeam,
  per1000,
  possibleHai,
} from './infection.service.js';

/**
 * Infection prevention and antimicrobial stewardship: isolation precautions (chart, ward list and
 * bed board), healthcare-associated infection surveillance with rates per 1,000 patient-days, and
 * approval and 72-hour review of restricted antibiotics. Infection control staff are the members
 * of an INFECTION_CONTROL unit of the facility; hospital pharmacists share the stewardship queue.
 */
export const infectionRouter = Router();
infectionRouter.use(authenticate);

const PatientParam = z.object({ patientId: z.string().uuid() });
const IdParam = z.object({ id: z.string().uuid() });

async function currentAdmission(patientId: string, facilityId: string | null) {
  if (!facilityId) return null;
  const [a] = await db
    .select({ id: admissions.id, unitId: admissions.unitId })
    .from(admissions)
    .where(
      and(
        eq(admissions.patientId, patientId),
        eq(admissions.facilityId, facilityId),
        eq(admissions.status, 'ADMITTED'),
      ),
    )
    .limit(1);
  return a ?? null;
}

/**
 * Infection control staff may act for any patient admitted at their facility (that is their job);
 * everyone else needs the usual care-team access. Reads are audited for the patient.
 */
async function infectionAccess(
  ctx: AuthContext,
  patientId: string,
  meta: RequestMeta,
  mode: 'read' | 'write',
) {
  if (
    (ctx.role === 'DOCTOR' || ctx.role === 'NURSE') &&
    (await isInfectionControl(ctx.userId, ctx.facilityId)) &&
    (await currentAdmission(patientId, ctx.facilityId))
  ) {
    assertNotMerged(await getPatientOrThrow(patientId));
    if (mode === 'write') await assertLicensed(ctx, meta);
    else await auditRecordView(ctx, patientId, 'UNIT', 'infection', meta);
    return;
  }
  if (mode === 'write') await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.careTeam);
  else await resolveAndAuditRead(ctx, patientId, meta, 'infection');
}

async function assertInfectionControl(ctx: AuthContext) {
  if (!(await isInfectionControl(ctx.userId, ctx.facilityId))) {
    throw forbidden('Only the infection control team of this facility can do this');
  }
}

/* ------------------------------------------------------------------------- reference -- */

infectionRouter.get('/definitions', async (req, res) => {
  const ctx = requireAuth(req);
  res.json({
    precautions: PRECAUTIONS.map((code) => ({ code, guidance: PRECAUTION_GUIDANCE[code] })),
    haiTypes: HAI_TYPES.map((code) => ({ code, ...HAI_CRITERIA[code] })),
    restrictedAgents: RESTRICTED_AGENTS.map((a) => ({
      code: a.code,
      name: a.name,
      atc: a.atc,
      intravenousOnly: Boolean(a.intravenousOnly),
    })),
    reviewAfterHours: REVIEW_AFTER_HOURS,
    reviewOutcomes: REVIEW_OUTCOMES,
    me: {
      infectionControl: await isInfectionControl(ctx.userId, ctx.facilityId),
      stewardship: await isStewardshipTeam(ctx),
    },
    disclaimer:
      'Surveillance criteria and the restricted antibiotic list are illustrative until confirmed by the infection control committee.',
  });
});

/* --------------------------------------------------------------------- patient chart -- */

infectionRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  await infectionAccess(ctx, patientId, requestMeta(req), 'read');
  const orderedBy = users;
  const [isolations, hai, approvals] = await Promise.all([
    db
      .select({
        id: isolationOrders.id,
        precaution: isolationOrders.precaution,
        reason: isolationOrders.reason,
        startedAt: isolationOrders.startedAt,
        endedAt: isolationOrders.endedAt,
        endReason: isolationOrders.endReason,
        orderedBy: orderedBy.fullName,
      })
      .from(isolationOrders)
      .innerJoin(orderedBy, eq(orderedBy.id, isolationOrders.orderedById))
      .where(eq(isolationOrders.patientId, patientId))
      .orderBy(desc(isolationOrders.startedAt)),
    db
      .select({
        id: haiEvents.id,
        type: haiEvents.type,
        organism: haiEvents.organism,
        onsetAt: haiEvents.onsetAt,
        deviceRelated: haiEvents.deviceRelated,
        status: haiEvents.status,
        notes: haiEvents.notes,
        unitName: careUnits.name,
        reviewedAt: haiEvents.reviewedAt,
      })
      .from(haiEvents)
      .leftJoin(careUnits, eq(careUnits.id, haiEvents.unitId))
      .where(eq(haiEvents.patientId, patientId))
      .orderBy(desc(haiEvents.onsetAt)),
    approvalRows(eq(antimicrobialApprovals.patientId, patientId)),
  ]);
  const now = Date.now();
  res.json({
    activeIsolations: isolations
      .filter((i) => !i.endedAt)
      .map((i) => ({
        ...i,
        guidance: PRECAUTION_GUIDANCE[i.precaution as keyof typeof PRECAUTION_GUIDANCE],
      })),
    isolationHistory: isolations.filter((i) => i.endedAt),
    hai,
    antimicrobials: approvals.map((a) => presentApproval(a, ctx, now)),
    infectionControl: await isInfectionControl(ctx.userId, ctx.facilityId),
  });
});

/* ------------------------------------------------------------------------- isolation -- */

const StartIsolation = z.object({
  precaution: z.enum(PRECAUTIONS),
  reason: z.string().trim().min(2).max(200),
});
const EndInput = z.object({ reason: z.string().trim().min(3).max(300) });

infectionRouter.post(
  '/patients/:patientId/isolations',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const meta = requestMeta(req);
    const input = parse(StartIsolation, req.body);
    await infectionAccess(ctx, patientId, meta, 'write');
    if (!ctx.facilityId) throw forbidden();
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`isolation:${patientId}`}))`);
      const [existing] = await tx
        .select({ id: isolationOrders.id })
        .from(isolationOrders)
        .where(
          and(
            eq(isolationOrders.patientId, patientId),
            eq(isolationOrders.precaution, input.precaution),
            isNull(isolationOrders.endedAt),
          ),
        );
      if (existing) throw conflict('These precautions are already in place for this patient');
      const [created] = await tx
        .insert(isolationOrders)
        .values({ patientId, facilityId: ctx.facilityId!, orderedById: ctx.userId, ...input })
        .returning();
      await audit(
        {
          action: AuditAction.ISOLATION_CHANGED,
          actor: ctx,
          resourceType: 'isolation_order',
          resourceId: created!.id,
          patientId,
          meta,
          metadata: { change: 'started', precaution: input.precaution },
        },
        tx,
      );
      return created!;
    });
    res.status(201).json(row);
  },
);

infectionRouter.post('/isolations/:id/end', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const { reason } = parse(EndInput, req.body);
  const [order] = await db.select().from(isolationOrders).where(eq(isolationOrders.id, id));
  if (!order) throw notFound('Isolation order not found');
  await infectionAccess(ctx, order.patientId, meta, 'write');
  if (order.endedAt) throw conflict('These precautions have already ended');
  const [ended] = await db
    .update(isolationOrders)
    .set({ endedAt: new Date(), endedById: ctx.userId, endReason: reason })
    .where(and(eq(isolationOrders.id, id), isNull(isolationOrders.endedAt)))
    .returning();
  if (!ended) throw conflict('These precautions have already ended');
  await audit({
    action: AuditAction.ISOLATION_CHANGED,
    actor: ctx,
    resourceType: 'isolation_order',
    resourceId: id,
    patientId: order.patientId,
    meta,
    metadata: { change: 'ended', precaution: order.precaution },
  });
  res.json(ended);
});

/**
 * Isolated patients at my facility by ward. Infection control staff see everyone; other doctors and
 * nurses see patients on their wards or in their care; directors see counts only.
 */
infectionRouter.get('/isolations', requireRole('DOCTOR', 'NURSE', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const rows = await db
    .select({
      id: isolationOrders.id,
      patientId: isolationOrders.patientId,
      firstName: patients.firstName,
      lastName: patients.lastName,
      temporaryIdentity: patients.temporaryIdentity,
      precaution: isolationOrders.precaution,
      reason: isolationOrders.reason,
      startedAt: isolationOrders.startedAt,
      unitId: admissions.unitId,
      unitName: careUnits.name,
      bed: beds.label,
    })
    .from(isolationOrders)
    .innerJoin(patients, eq(patients.id, isolationOrders.patientId))
    .leftJoin(
      admissions,
      and(
        eq(admissions.patientId, isolationOrders.patientId),
        eq(admissions.facilityId, ctx.facilityId),
        eq(admissions.status, 'ADMITTED'),
      ),
    )
    .leftJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .leftJoin(beds, eq(beds.id, admissions.bedId))
    .where(and(eq(isolationOrders.facilityId, ctx.facilityId), isNull(isolationOrders.endedAt)))
    .orderBy(careUnits.name, beds.label);
  if (ctx.role === 'DIRECTOR') {
    const counts = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const key = r.unitName ?? '—';
      const c = counts.get(key) ?? {};
      c[r.precaution] = (c[r.precaution] ?? 0) + 1;
      counts.set(key, c);
    }
    res.json({
      scope: 'counts',
      units: [...counts].map(([unit, byPrecaution]) => ({ unit, byPrecaution })),
    });
    return;
  }
  let visible = rows;
  if (!(await isInfectionControl(ctx.userId, ctx.facilityId))) {
    const allowed = await db.execute<{ patient_id: string }>(sql`
        SELECT DISTINCT a.patient_id FROM admissions a
        WHERE a.facility_id = ${ctx.facilityId} AND a.status = 'ADMITTED'
          AND (EXISTS (SELECT 1 FROM unit_staff us WHERE us.unit_id = a.unit_id AND us.user_id = ${ctx.userId})
               OR a.attending_doctor_id = ${ctx.userId})
        UNION
        SELECT ca.patient_id FROM care_assignments ca
        WHERE ca.doctor_id = ${ctx.userId} AND ca.ended_at IS NULL`);
    const ids = new Set(allowed.rows.map((r) => r.patient_id));
    visible = rows.filter((r) => ids.has(r.patientId));
  }
  res.json({
    scope: 'patients',
    items: visible.map((r) => ({
      ...r,
      guidance: PRECAUTION_GUIDANCE[r.precaution as keyof typeof PRECAUTION_GUIDANCE],
    })),
  });
});

/* ------------------------------------------------------------------------------- HAI -- */

const HaiInput = z.object({
  type: z.enum(HAI_TYPES),
  organism: z.string().trim().max(120).optional().nullable(),
  onsetAt: z.coerce
    .date()
    .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'The onset cannot be in the future'),
  deviceRelated: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional().nullable(),
});
const ReviewHai = z.object({
  status: z.enum(['CONFIRMED', 'RULED_OUT']),
  notes: z.string().trim().max(2000).optional().nullable(),
});

infectionRouter.post(
  '/patients/:patientId/hai',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const meta = requestMeta(req);
    const input = parse(HaiInput, req.body);
    await infectionAccess(ctx, patientId, meta, 'write');
    if (!ctx.facilityId) throw forbidden();
    // The stay during which the infection started (if any) gives the ward for the rates.
    const [stay] = await db
      .select({ id: admissions.id, unitId: admissions.unitId })
      .from(admissions)
      .where(
        and(
          eq(admissions.patientId, patientId),
          eq(admissions.facilityId, ctx.facilityId),
          sql`${admissions.admittedAt} <= ${input.onsetAt}`,
          sql`coalesce(${admissions.dischargedAt}, now()) >= ${input.onsetAt}`,
        ),
      )
      .orderBy(desc(admissions.admittedAt))
      .limit(1);
    const ic = await isInfectionControl(ctx.userId, ctx.facilityId);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(haiEvents)
        .values({
          patientId,
          facilityId: ctx.facilityId!,
          admissionId: stay?.id ?? null,
          unitId: stay?.unitId ?? null,
          type: input.type,
          organism: input.organism ?? null,
          onsetAt: input.onsetAt,
          deviceRelated: input.deviceRelated,
          notes: input.notes ?? null,
          reportedById: ctx.userId,
        })
        .returning();
      await audit(
        {
          action: AuditAction.HAI_RECORDED,
          actor: ctx,
          resourceType: 'hai_event',
          resourceId: created!.id,
          patientId,
          meta,
          metadata: { type: input.type, status: 'SUSPECTED' },
        },
        tx,
      );
      if (!ic) {
        const staff = await infectionControlStaff(ctx.facilityId!, tx);
        await notifyUsers(
          staff,
          {
            type: 'infection',
            title: 'A possible healthcare-associated infection was reported',
            link: `/infection?tab=surveillance&hai=${created!.id}`,
          },
          tx,
        );
      }
      return created!;
    });
    res.status(201).json({ ...row, admissionFound: Boolean(stay) });
  },
);

infectionRouter.post('/hai/:id/review', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const input = parse(ReviewHai, req.body);
  await assertInfectionControl(ctx);
  const [event] = await db.select().from(haiEvents).where(eq(haiEvents.id, id));
  if (!event || event.facilityId !== ctx.facilityId) throw notFound('Infection not found');
  await assertLicensed(ctx, meta);
  const [updated] = await db
    .update(haiEvents)
    .set({
      status: input.status,
      notes: input.notes ?? event.notes,
      reviewedById: ctx.userId,
      reviewedAt: new Date(),
    })
    .where(eq(haiEvents.id, id))
    .returning();
  await audit({
    action: AuditAction.HAI_RECORDED,
    actor: ctx,
    resourceType: 'hai_event',
    resourceId: id,
    patientId: event.patientId,
    meta,
    metadata: { type: event.type, status: input.status, previous: event.status },
  });
  res.json(updated);
});

/** The infection control team's list of reported infections at the facility. */
infectionRouter.get('/hai', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  await assertInfectionControl(ctx);
  const q = parse(z.object({ status: z.enum(HAI_STATUSES).optional() }), req.query);
  const reporter = users;
  const rows = await db
    .select({
      id: haiEvents.id,
      patientId: haiEvents.patientId,
      firstName: patients.firstName,
      lastName: patients.lastName,
      type: haiEvents.type,
      organism: haiEvents.organism,
      onsetAt: haiEvents.onsetAt,
      deviceRelated: haiEvents.deviceRelated,
      status: haiEvents.status,
      unitName: careUnits.name,
      reportedBy: reporter.fullName,
      createdAt: haiEvents.createdAt,
    })
    .from(haiEvents)
    .innerJoin(patients, eq(patients.id, haiEvents.patientId))
    .innerJoin(reporter, eq(reporter.id, haiEvents.reportedById))
    .leftJoin(careUnits, eq(careUnits.id, haiEvents.unitId))
    .where(
      and(
        eq(haiEvents.facilityId, ctx.facilityId!),
        q.status ? eq(haiEvents.status, q.status) : undefined,
      ),
    )
    .orderBy(desc(haiEvents.onsetAt))
    .limit(300);
  res.json({ items: rows });
});

/** Positive cultures > 48 h after admission without a recorded HAI (infection control only). */
infectionRouter.get('/suggestions', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  await assertInfectionControl(ctx);
  res.json({ items: await possibleHai(ctx.facilityId!) });
});

const MonthsQuery = z.object({ months: z.coerce.number().int().min(1).max(36).default(12) });

const monthsAgo = (n: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (n - 1), 1));
};

const suppress = (n: number) => (n > 0 && n < SMALL_CELL_THRESHOLD ? null : n);

/**
 * HAI rates per 1,000 patient-days: by ward and month for my facility (director and infection
 * control), by facility for the Ministry (small counts hidden).
 */
infectionRouter.get(
  '/surveillance',
  requireRole('DOCTOR', 'NURSE', 'DIRECTOR', 'MINISTRY'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { months } = parse(MonthsQuery, req.query);
    const from = monthsAgo(months);
    if (ctx.role === 'MINISTRY') {
      const rows = await haiRates({ facilityId: null, from, groupBy: 'facility' });
      const byFacility = new Map<
        string,
        { label: string; patientDays: number; confirmed: number; deviceRelated: number }
      >();
      const byMonth = new Map<string, { patientDays: number; confirmed: number }>();
      for (const r of rows) {
        const f = byFacility.get(r.key) ?? {
          label: r.label,
          patientDays: 0,
          confirmed: 0,
          deviceRelated: 0,
        };
        f.patientDays += r.patientDays;
        f.confirmed += r.confirmed;
        f.deviceRelated += r.deviceRelated;
        byFacility.set(r.key, f);
        const m = byMonth.get(r.month) ?? { patientDays: 0, confirmed: 0 };
        m.patientDays += r.patientDays;
        m.confirmed += r.confirmed;
        byMonth.set(r.month, m);
      }
      res.json({
        scope: 'national',
        months,
        threshold: SMALL_CELL_THRESHOLD,
        facilities: [...byFacility.values()]
          .map((f) => {
            const confirmed = suppress(f.confirmed);
            return {
              facility: f.label,
              patientDays: f.patientDays,
              confirmed,
              deviceRelated: confirmed === null ? null : suppress(f.deviceRelated),
              rate: confirmed === null ? null : per1000(f.confirmed, f.patientDays),
              suppressed: confirmed === null,
            };
          })
          .sort((a, b) => a.facility.localeCompare(b.facility)),
        trend: [...byMonth]
          .map(([month, m]) => ({
            month,
            patientDays: m.patientDays,
            confirmed: suppress(m.confirmed),
            rate: suppress(m.confirmed) === null ? null : per1000(m.confirmed, m.patientDays),
          }))
          .sort((a, b) => a.month.localeCompare(b.month)),
      });
      return;
    }
    if (!ctx.facilityId) throw forbidden();
    if (ctx.role !== 'DIRECTOR') await assertInfectionControl(ctx);
    const rows = await haiRates({ facilityId: ctx.facilityId, from, groupBy: 'unit' });
    const [byType] = await Promise.all([
      db
        .select({
          type: haiEvents.type,
          status: haiEvents.status,
          n: sql<number>`count(*)::int`,
        })
        .from(haiEvents)
        .where(and(eq(haiEvents.facilityId, ctx.facilityId), sql`${haiEvents.onsetAt} >= ${from}`))
        .groupBy(haiEvents.type, haiEvents.status),
    ]);
    const months2 = new Map<
      string,
      { patientDays: number; confirmed: number; suspected: number }
    >();
    const units = new Map<
      string,
      { label: string; patientDays: number; confirmed: number; deviceRelated: number }
    >();
    for (const r of rows) {
      const m = months2.get(r.month) ?? { patientDays: 0, confirmed: 0, suspected: 0 };
      m.patientDays += r.patientDays;
      m.confirmed += r.confirmed;
      m.suspected += r.suspected;
      months2.set(r.month, m);
      const u = units.get(r.key) ?? {
        label: r.label,
        patientDays: 0,
        confirmed: 0,
        deviceRelated: 0,
      };
      u.patientDays += r.patientDays;
      u.confirmed += r.confirmed;
      u.deviceRelated += r.deviceRelated;
      units.set(r.key, u);
    }
    res.json({
      scope: 'facility',
      months,
      trend: [...months2]
        .map(([month, m]) => ({ month, ...m, rate: per1000(m.confirmed, m.patientDays) }))
        .sort((a, b) => a.month.localeCompare(b.month)),
      units: [...units.values()]
        .map((u) => ({ unit: u.label, ...u, rate: per1000(u.confirmed, u.patientDays) }))
        .sort((a, b) => a.unit.localeCompare(b.unit)),
      byType: HAI_TYPES.map((type) => ({
        type,
        confirmed: byType.find((b) => b.type === type && b.status === 'CONFIRMED')?.n ?? 0,
        suspected: byType.find((b) => b.type === type && b.status === 'SUSPECTED')?.n ?? 0,
        ruledOut: byType.find((b) => b.type === type && b.status === 'RULED_OUT')?.n ?? 0,
      })),
    });
  },
);

/* ------------------------------------------------------------------------ stewardship -- */

const requester = users;

async function approvalRows(where: ReturnType<typeof eq> | ReturnType<typeof and>) {
  const rows = await db
    .select({
      id: antimicrobialApprovals.id,
      prescriptionId: antimicrobialApprovals.prescriptionId,
      patientId: antimicrobialApprovals.patientId,
      facilityId: antimicrobialApprovals.facilityId,
      firstName: patients.firstName,
      lastName: patients.lastName,
      medication: prescriptions.medication,
      dosage: prescriptions.dosage,
      frequency: prescriptions.frequency,
      route: prescriptions.route,
      prescriptionStatus: prescriptions.status,
      indication: antimicrobialApprovals.indication,
      justification: antimicrobialApprovals.justification,
      status: antimicrobialApprovals.status,
      requestedById: antimicrobialApprovals.requestedById,
      decidedById: antimicrobialApprovals.decidedById,
      decidedAt: antimicrobialApprovals.decidedAt,
      decisionNote: antimicrobialApprovals.decisionNote,
      reviewDueAt: antimicrobialApprovals.reviewDueAt,
      reviewedAt: antimicrobialApprovals.reviewedAt,
      reviewOutcome: antimicrobialApprovals.reviewOutcome,
      createdAt: antimicrobialApprovals.createdAt,
    })
    .from(antimicrobialApprovals)
    .innerJoin(patients, eq(patients.id, antimicrobialApprovals.patientId))
    .innerJoin(prescriptions, eq(prescriptions.id, antimicrobialApprovals.prescriptionId))
    .where(where)
    .orderBy(desc(antimicrobialApprovals.createdAt))
    .limit(300);
  const people = [
    ...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter(Boolean)),
  ] as string[];
  const names = people.length
    ? await db
        .select({ id: requester.id, name: requester.fullName })
        .from(requester)
        .where(inArray(requester.id, people))
    : [];
  const nameOf = (id: string | null) => names.find((n) => n.id === id)?.name ?? null;
  return rows.map((r) => ({
    ...r,
    requestedBy: nameOf(r.requestedById),
    decidedBy: nameOf(r.decidedById),
  }));
}

type ApprovalRow = Awaited<ReturnType<typeof approvalRows>>[number];

function presentApproval(a: ApprovalRow, ctx: AuthContext, now: number) {
  const reviewNeeded =
    a.status !== 'DECLINED' && !a.reviewedAt && a.prescriptionStatus === 'ACTIVE';
  return {
    ...a,
    reviewOverdue: Boolean(reviewNeeded && a.reviewDueAt && a.reviewDueAt.getTime() < now),
    reviewNeeded,
    mine: a.requestedById === ctx.userId,
  };
}

/**
 * The stewardship queue: requests to decide and overdue reviews at my facility (infection control
 * and pharmacists); doctors see the requests they made.
 */
infectionRouter.get(
  '/stewardship',
  requireRole('DOCTOR', 'NURSE', 'PHARMACIST'),
  async (req, res) => {
    const ctx = requireAuth(req);
    if (!ctx.facilityId) throw forbidden();
    const team = await isStewardshipTeam(ctx);
    if (!team && ctx.role !== 'DOCTOR') throw forbidden();
    const rows = await approvalRows(
      team
        ? eq(antimicrobialApprovals.facilityId, ctx.facilityId)
        : and(
            eq(antimicrobialApprovals.facilityId, ctx.facilityId),
            eq(antimicrobialApprovals.requestedById, ctx.userId),
          ),
    );
    const now = Date.now();
    const items = rows.map((r) => presentApproval(r, ctx, now));
    res.json({
      scope: team ? 'team' : 'mine',
      awaitingDecision: items.filter((i) => i.status === 'REQUESTED'),
      reviewsOverdue: items.filter((i) => i.reviewOverdue),
      recent: items.filter((i) => i.status !== 'REQUESTED' && !i.reviewOverdue).slice(0, 50),
    });
  },
);

const DecisionInput = z
  .object({
    decision: z.enum(['APPROVED', 'DECLINED']),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .refine((d) => d.decision === 'APPROVED' || Boolean(d.note && d.note.length >= 10), {
    message: 'Explain why the request is declined (at least 10 characters)',
    path: ['note'],
  });

infectionRouter.post(
  '/antimicrobials/:id/decision',
  requireRole('DOCTOR', 'NURSE', 'PHARMACIST'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const meta = requestMeta(req);
    const input = parse(DecisionInput, req.body);
    if (!(await isStewardshipTeam(ctx))) {
      throw forbidden('Only the antimicrobial stewardship team can decide this request');
    }
    const [a] = await db
      .select()
      .from(antimicrobialApprovals)
      .where(eq(antimicrobialApprovals.id, id));
    if (!a || a.facilityId !== ctx.facilityId) throw notFound('Request not found');
    if (a.requestedById === ctx.userId) throw forbidden('You cannot decide your own request');
    if (ctx.role !== 'PHARMACIST') await assertLicensed(ctx, meta);
    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(antimicrobialApprovals)
        .set({
          status: input.decision,
          decidedById: ctx.userId,
          decidedAt: now,
          decisionNote: input.note ?? null,
        })
        .where(
          and(eq(antimicrobialApprovals.id, id), eq(antimicrobialApprovals.status, 'REQUESTED')),
        )
        .returning();
      if (!row) throw conflict('This request has already been decided');
      await audit(
        {
          action: AuditAction.ANTIMICROBIAL_DECIDED,
          actor: ctx,
          resourceType: 'antimicrobial_approval',
          resourceId: id,
          patientId: a.patientId,
          meta,
          metadata: { decision: input.decision },
        },
        tx,
      );
      await notifyUsers(
        [a.requestedById],
        {
          type: 'stewardship',
          title:
            input.decision === 'APPROVED'
              ? 'Your restricted antibiotic request was approved'
              : 'Your restricted antibiotic request was declined – review the treatment',
          link: `/doctor/patients/${a.patientId}?tab=infection`,
        },
        tx,
      );
      return row;
    });
    res.json(updated);
  },
);

const ReviewInput = z.object({
  outcome: z.enum(REVIEW_OUTCOMES),
  note: z.string().trim().max(500).optional().nullable(),
});

/** The 72-hour review: the prescriber, the patient's treating doctors or the stewardship team. */
infectionRouter.post(
  '/antimicrobials/:id/review',
  requireRole('DOCTOR', 'NURSE', 'PHARMACIST'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const meta = requestMeta(req);
    const input = parse(ReviewInput, req.body);
    const [a] = await db
      .select()
      .from(antimicrobialApprovals)
      .where(eq(antimicrobialApprovals.id, id));
    if (!a || a.facilityId !== ctx.facilityId) throw notFound('Request not found');
    const team = await isStewardshipTeam(ctx);
    if (!team) {
      if (ctx.role !== 'DOCTOR') throw forbidden();
      await assertClinicalWriteAccess(ctx, a.patientId, meta, WRITERS.doctorOnly);
    } else if (ctx.role !== 'PHARMACIST') {
      await assertLicensed(ctx, meta);
    }
    if (a.status === 'DECLINED') throw conflict('A declined request needs no review');
    const [row] = await db
      .update(antimicrobialApprovals)
      .set({ reviewedAt: new Date(), reviewOutcome: input.outcome })
      .where(and(eq(antimicrobialApprovals.id, id), isNull(antimicrobialApprovals.reviewedAt)))
      .returning();
    if (!row) throw conflict('This antibiotic has already been reviewed');
    await audit({
      action: AuditAction.ANTIMICROBIAL_DECIDED,
      actor: ctx,
      resourceType: 'antimicrobial_approval',
      resourceId: id,
      patientId: a.patientId,
      meta,
      metadata: { review: input.outcome, note: input.note ?? null },
    });
    res.json(row);
  },
);

/**
 * Stewardship indicators: restricted-antibiotic starts per 1,000 patient-days, approval rate and
 * 72-hour review compliance (facility for directors and the team; national by facility for the
 * Ministry with small counts hidden).
 */
infectionRouter.get(
  '/stewardship/stats',
  requireRole('DOCTOR', 'NURSE', 'PHARMACIST', 'DIRECTOR', 'MINISTRY'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { months } = parse(MonthsQuery, req.query);
    const from = monthsAgo(months);
    if (ctx.role !== 'MINISTRY' && ctx.role !== 'DIRECTOR' && !(await isStewardshipTeam(ctx))) {
      throw forbidden();
    }
    const facilityId = ctx.role === 'MINISTRY' ? null : ctx.facilityId;
    const rows = await db.execute<{
      facility_id: string;
      starts: number;
      approved: number;
      declined: number;
      due: number;
      on_time: number;
    }>(sql`
      SELECT aa.facility_id::text, count(*)::int AS starts,
        count(*) FILTER (WHERE aa.status = 'APPROVED')::int AS approved,
        count(*) FILTER (WHERE aa.status = 'DECLINED')::int AS declined,
        count(*) FILTER (WHERE aa.status <> 'DECLINED' AND aa.review_due_at < now())::int AS due,
        count(*) FILTER (WHERE aa.status <> 'DECLINED' AND aa.review_due_at < now()
                         AND aa.reviewed_at IS NOT NULL AND aa.reviewed_at <= aa.review_due_at + interval '24 hours')::int AS on_time
      FROM antimicrobial_approvals aa
      WHERE aa.created_at >= ${from} ${facilityId ? sql`AND aa.facility_id = ${facilityId}` : sql``}
      GROUP BY 1`);
    const days = await haiRates({ facilityId, from, groupBy: 'facility' });
    const pdBy = new Map<string, number>();
    for (const d of days) pdBy.set(d.key, (pdBy.get(d.key) ?? 0) + d.patientDays);
    const names = new Map(
      (await db.select({ id: facilities.id, name: facilities.name }).from(facilities)).map((f) => [
        f.id,
        f.name,
      ]),
    );
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
    const present = (r: (typeof rows.rows)[number], hide: boolean) => {
      const starts = hide ? suppress(r.starts) : r.starts;
      const visible = starts !== null;
      return {
        facility: names.get(r.facility_id) ?? '—',
        starts,
        patientDays: pdBy.get(r.facility_id) ?? 0,
        startsPer1000: visible ? per1000(r.starts, pdBy.get(r.facility_id) ?? 0) : null,
        approvalRate: visible ? pct(r.approved, r.approved + r.declined) : null,
        reviewCompliance: visible ? pct(r.on_time, r.due) : null,
        suppressed: !visible,
      };
    };
    res.json({
      scope: facilityId ? 'facility' : 'national',
      months,
      threshold: SMALL_CELL_THRESHOLD,
      facilities: rows.rows.map((r) => present(r, !facilityId)),
    });
  },
);
