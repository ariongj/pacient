import { Router } from 'express';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  involuntaryAdmissions,
  medicationAdministrations,
  prescriptions,
  restrictiveInterventions,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { auditRecordView } from '../access/policy.js';
import { audit, AuditAction, auditSafe } from '../audit/audit.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  DEBRIEF_HOURS,
  END_REASONS,
  GROUNDS,
  legalSteps,
  MAX_AUTHORISATION_DAYS,
  OBSERVATION_INTERVAL_MINUTES,
  RESTRICTIVE_KINDS,
  debriefState,
  observationState,
} from './definitions.js';
import {
  assertMentalHealthAccess,
  CARE_TEAM_WRITERS,
  currentAdmission,
  DOCTOR_WRITERS,
  namesOf,
  type InvoluntaryRow,
} from './mentalhealth.service.js';

/**
 * Mental health safeguards. Involuntary admissions and restrictive interventions are visible only
 * to the patient's care team and the staff of the ward where the patient is admitted (the existing
 * clinical access rules), and every read is recorded in the patient's access log. Directors, who
 * are legally responsible for the facility, see the list of active involuntary admissions with
 * names and the state of each legal step – never the clinical assessment. The Ministry sees
 * aggregates only.
 */
export const mentalHealthRouter = Router();
mentalHealthRouter.use(authenticate);

type RestrictiveRow = typeof restrictiveInterventions.$inferSelect;
type Observation = {
  at: string;
  byId: string;
  note: string | null;
  vitalsChecked: boolean;
  administrationId?: string | null;
};

const IdParam = z.object({ id: z.string().uuid() });
const PatientParam = z.object({ patientId: z.string().uuid() });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Not in the future (5 minutes' tolerance for device clocks). */
const pastTime = z.coerce
  .date()
  .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'The time cannot be in the future');
const note = (max = 2000) => z.string().trim().min(3).max(max);

/* ------------------------------------------------------------------ presentation ---------- */

function presentInvoluntary(ia: InvoluntaryRow, names: Map<string, string>, now = new Date()) {
  const steps = legalSteps(ia, now);
  return {
    id: ia.id,
    patientId: ia.patientId,
    admissionId: ia.admissionId,
    status: ia.status,
    grounds: ia.grounds,
    assessment: ia.assessment,
    startedAt: ia.startedAt,
    decidedBy: names.get(ia.decidedById) ?? null,
    decidedById: ia.decidedById,
    secondOpinion: ia.secondOpinionAt
      ? {
          at: ia.secondOpinionAt,
          by: ia.secondOpinionById ? (names.get(ia.secondOpinionById) ?? null) : null,
          confirms: ia.secondOpinionConfirms,
        }
      : null,
    court: {
      notifiedAt: ia.courtNotifiedAt,
      reference: ia.courtReference,
      decisionAt: ia.courtDecisionAt,
      decision: ia.courtDecision,
      authorisedUntil: ia.authorisedUntil,
    },
    rightsExplainedAt: ia.rightsExplainedAt,
    representative: {
      name: ia.representativeName,
      notifiedAt: ia.representativeNotifiedAt,
    },
    endedAt: ia.endedAt,
    endReason: ia.endReason,
    steps,
    overdueSteps: steps.filter((s) => s.status === 'OVERDUE').map((s) => s.step),
  };
}

function presentRestrictive(r: RestrictiveRow, names: Map<string, string>, now = new Date()) {
  const observations = (r.observations as Observation[]).map((o) => ({
    at: o.at,
    by: names.get(o.byId) ?? null,
    note: o.note,
    vitalsChecked: o.vitalsChecked,
    administrationId: o.administrationId ?? null,
  }));
  return {
    id: r.id,
    patientId: r.patientId,
    admissionId: r.admissionId,
    kind: r.kind,
    reason: r.reason,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    orderedBy: names.get(r.orderedById) ?? null,
    observations,
    injuries: r.injuries,
    debriefAt: r.debriefAt,
    debriefNote: r.debriefNote,
    durationMinutes: r.endedAt
      ? Math.round((r.endedAt.getTime() - r.startedAt.getTime()) / 60_000)
      : null,
    ...observationState({ ...r, observations: r.observations as Observation[] }, now),
    ...debriefState({ ...r, observations: r.observations as Observation[] }, now),
  };
}

const peopleOf = (ia: InvoluntaryRow[], ri: RestrictiveRow[]) => [
  ...ia.flatMap((x) => [x.decidedById, x.secondOpinionById]),
  ...ri.flatMap((r) => [r.orderedById, ...(r.observations as Observation[]).map((o) => o.byId)]),
];

async function loadInvoluntary(id: string) {
  const [row] = await db
    .select()
    .from(involuntaryAdmissions)
    .where(eq(involuntaryAdmissions.id, id));
  if (!row) throw notFound('Involuntary admission not found');
  return row;
}

async function loadRestrictive(id: string) {
  const [row] = await db
    .select()
    .from(restrictiveInterventions)
    .where(eq(restrictiveInterventions.id, id));
  if (!row) throw notFound('Restrictive intervention not found');
  return row;
}

/* ------------------------------------------------------------------ board ----------------- */

/**
 * Active involuntary admissions and restrictive interventions (running, or ended without a
 * debrief in the last week) for the patients the caller is responsible for: staff of the ward
 * where the patient is admitted, the attending doctor and the care team.
 */
mentalHealthRouter.get('/board', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const meta = requestMeta(req);
  const responsible = (patientCol: string, admissionCol: string) => sql`(
    EXISTS (SELECT 1 FROM admissions a JOIN unit_staff us ON us.unit_id = a.unit_id
            WHERE a.id = ${sql.raw(admissionCol)} AND a.status = 'ADMITTED' AND us.user_id = ${ctx.userId})
    OR EXISTS (SELECT 1 FROM admissions a WHERE a.id = ${sql.raw(admissionCol)}
               AND a.attending_doctor_id = ${ctx.userId})
    OR EXISTS (SELECT 1 FROM care_assignments ca WHERE ca.patient_id = ${sql.raw(patientCol)}
               AND ca.doctor_id = ${ctx.userId} AND ca.ended_at IS NULL))`;
  const iaRows = await db.execute<{ id: string }>(sql`
    SELECT ia.id FROM involuntary_admissions ia
    WHERE ia.facility_id = ${ctx.facilityId} AND ia.status = 'ACTIVE'
      AND ${responsible('ia.patient_id', 'ia.admission_id')}
    LIMIT 200`);
  const riRows = await db.execute<{ id: string }>(sql`
    SELECT ri.id FROM restrictive_interventions ri
    WHERE ri.facility_id = ${ctx.facilityId}
      AND (ri.ended_at IS NULL
           OR (ri.debrief_at IS NULL AND ri.ended_at > now() - interval '7 days'))
      AND ${responsible('ri.patient_id', 'ri.admission_id')}
    LIMIT 200`);
  const ia = iaRows.rows.length
    ? await db
        .select()
        .from(involuntaryAdmissions)
        .where(
          inArray(
            involuntaryAdmissions.id,
            iaRows.rows.map((r) => r.id),
          ),
        )
    : [];
  const ri = riRows.rows.length
    ? await db
        .select()
        .from(restrictiveInterventions)
        .where(
          inArray(
            restrictiveInterventions.id,
            riRows.rows.map((r) => r.id),
          ),
        )
    : [];
  const patientIds = [...new Set([...ia, ...ri].map((x) => x.patientId))];
  const people = patientIds.length
    ? await db.execute<{
        id: string;
        first_name: string;
        last_name: string;
        date_of_birth: string;
        temporary_identity: string | null;
        unit_name: string | null;
        bed_label: string | null;
      }>(sql`
        SELECT p.id, p.first_name, p.last_name, p.date_of_birth::text AS date_of_birth,
               p.temporary_identity, cu.name AS unit_name, b.label AS bed_label
        FROM patients p
        LEFT JOIN admissions a ON a.patient_id = p.id AND a.status = 'ADMITTED'
        LEFT JOIN care_units cu ON cu.id = a.unit_id
        LEFT JOIN beds b ON b.id = a.bed_id
        WHERE p.id IN (${sql.join(
          patientIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`)
    : { rows: [] };
  const byPatient = new Map(people.rows.map((p) => [p.id, p]));
  // Every patient shown on the board appears in their access log (at most every 10 minutes).
  for (const id of patientIds) await auditRecordView(ctx, id, 'UNIT', 'mental_health_board', meta);
  const names = await namesOf(peopleOf(ia, ri));
  const who = (patientId: string) => {
    const p = byPatient.get(patientId);
    return p
      ? {
          firstName: p.first_name,
          lastName: p.last_name,
          dateOfBirth: p.date_of_birth,
          temporaryIdentity: p.temporary_identity,
          unitName: p.unit_name,
          bedLabel: p.bed_label,
        }
      : null;
  };
  const involuntary = ia
    .map((x) => ({ ...presentInvoluntary(x, names), patient: who(x.patientId) }))
    .sort((a, b) => b.overdueSteps.length - a.overdueSteps.length);
  const restrictive = ri
    .map((x) => ({ ...presentRestrictive(x, names), patient: who(x.patientId) }))
    .sort((a, b) => Number(b.observationOverdue) - Number(a.observationOverdue));
  res.json({
    involuntary,
    restrictive,
    counts: {
      involuntary: involuntary.length,
      overdueLegalSteps: involuntary.reduce((n, x) => n + x.overdueSteps.length, 0),
      restrictiveActive: restrictive.filter((r) => !r.endedAt).length,
      observationOverdue: restrictive.filter((r) => r.observationOverdue).length,
      debriefOverdue: restrictive.filter((r) => r.debriefOverdue).length,
    },
    observationIntervalMinutes: OBSERVATION_INTERVAL_MINUTES,
    debriefHours: DEBRIEF_HOURS,
  });
});

/* ------------------------------------------------------------------ patient --------------- */

/** The patient's involuntary admissions and restrictive interventions (care team, ward staff). */
mentalHealthRouter.get('/patients/:patientId', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const meta = requestMeta(req);
  const basis = await assertMentalHealthAccess(ctx, patientId, meta);
  await auditRecordView(ctx, patientId, basis, 'mental_health', meta);
  const ia = await db
    .select()
    .from(involuntaryAdmissions)
    .where(eq(involuntaryAdmissions.patientId, patientId))
    .orderBy(desc(involuntaryAdmissions.startedAt))
    .limit(50);
  const ri = await db
    .select()
    .from(restrictiveInterventions)
    .where(eq(restrictiveInterventions.patientId, patientId))
    .orderBy(desc(restrictiveInterventions.startedAt))
    .limit(100);
  const names = await namesOf(peopleOf(ia, ri));
  const admission = await currentAdmission(patientId);
  const active = ia.find((x) => x.status === 'ACTIVE');
  // Medicines given in the last 24 hours, so rapid tranquillisation can refer to one.
  const recentAdministrations = admission
    ? await db
        .select({
          id: medicationAdministrations.id,
          medication: prescriptions.medication,
          doseGiven: medicationAdministrations.doseGiven,
          route: prescriptions.route,
          administeredAt: medicationAdministrations.administeredAt,
        })
        .from(medicationAdministrations)
        .innerJoin(prescriptions, eq(prescriptions.id, medicationAdministrations.prescriptionId))
        .where(
          and(
            eq(medicationAdministrations.patientId, patientId),
            eq(medicationAdministrations.status, 'GIVEN'),
            sql`${medicationAdministrations.administeredAt} > now() - interval '24 hours'`,
          ),
        )
        .orderBy(desc(medicationAdministrations.administeredAt))
        .limit(20)
    : [];
  res.json({
    involuntary: ia.map((x) => presentInvoluntary(x, names)),
    restrictive: ri.map((x) => presentRestrictive(x, names)),
    admission: admission && {
      id: admission.id,
      unitName: admission.unitName,
      unitType: admission.unitType,
      bedLabel: admission.bedLabel,
      admittedAt: admission.admittedAt,
    },
    canStartInvoluntary:
      ctx.role === 'DOCTOR' &&
      !active &&
      admission?.unitType === 'PSYCHIATRIC' &&
      admission.facilityId === ctx.facilityId,
    canStartRestrictive: Boolean(admission) && admission?.facilityId === ctx.facilityId,
    recentAdministrations,
    grounds: GROUNDS,
    kinds: RESTRICTIVE_KINDS,
    endReasons: END_REASONS,
    maxAuthorisationDays: MAX_AUTHORISATION_DAYS,
    observationIntervalMinutes: OBSERVATION_INTERVAL_MINUTES,
  });
});

/* ------------------------------------------------------------------ involuntary ----------- */

const StartInput = z.object({
  grounds: z
    .array(z.enum(GROUNDS))
    .min(1, 'Choose at least one legal ground')
    .refine((g) => new Set(g).size === g.length, 'Each ground only once'),
  assessment: note(5000).refine(
    (s) => s.length >= 20,
    'Describe the assessment (20 characters or more)',
  ),
  startedAt: pastTime.optional(),
});

/** A doctor records an involuntary admission for a patient admitted to a psychiatric ward. */
mentalHealthRouter.post(
  '/patients/:patientId/involuntary',
  requireRole('DOCTOR'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const meta = requestMeta(req);
    await assertMentalHealthAccess(ctx, patientId, meta, DOCTOR_WRITERS);
    const input = parse(StartInput, req.body);
    const admission = await currentAdmission(patientId);
    if (!admission) {
      throw conflict('The patient must be admitted to a psychiatric ward first');
    }
    if (admission.unitType !== 'PSYCHIATRIC') {
      throw conflict('An involuntary admission is recorded on a psychiatric ward');
    }
    if (admission.facilityId !== ctx.facilityId) throw forbidden();
    const startedAt = input.startedAt ?? new Date();
    if (startedAt < admission.admittedAt) {
      throw badRequest('The involuntary admission cannot start before the hospital stay');
    }
    const row = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: involuntaryAdmissions.id })
        .from(involuntaryAdmissions)
        .where(
          and(
            eq(involuntaryAdmissions.patientId, patientId),
            eq(involuntaryAdmissions.status, 'ACTIVE'),
          ),
        );
      if (existing) throw conflict('The patient already has an active involuntary admission');
      const [created] = await tx
        .insert(involuntaryAdmissions)
        .values({
          patientId,
          admissionId: admission.id,
          facilityId: admission.facilityId,
          grounds: input.grounds,
          assessment: input.assessment,
          startedAt,
          decidedById: ctx.userId,
        })
        .returning();
      await audit(
        {
          action: AuditAction.INVOLUNTARY_ADMISSION_CHANGED,
          actor: ctx,
          resourceType: 'involuntary_admission',
          resourceId: created!.id,
          patientId,
          meta,
          metadata: { kind: 'started', grounds: input.grounds },
        },
        tx,
      );
      return created!;
    });
    res.status(201).json(presentInvoluntary(row, await namesOf(peopleOf([row], []))));
  },
);

/**
 * One step of the legal process. Each step is recorded once, by a conditional update on the
 * active admission (so two people cannot record it twice).
 */
async function recordStep(
  req: Parameters<Parameters<typeof mentalHealthRouter.post>[1]>[0],
  roles: typeof CARE_TEAM_WRITERS,
  build: (
    ia: InvoluntaryRow,
    ctx: AuthContext,
  ) => {
    set: Partial<typeof involuntaryAdmissions.$inferInsert>;
    unset: (typeof involuntaryAdmissions)[keyof typeof involuntaryAdmissions] | null;
    kind: string;
    metadata?: Record<string, unknown>;
  },
) {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const ia = await loadInvoluntary(id);
  await assertMentalHealthAccess(ctx, ia.patientId, meta, roles);
  if (ia.status !== 'ACTIVE') throw conflict('The involuntary admission has ended');
  const { set, unset, kind, metadata } = build(ia, ctx);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(involuntaryAdmissions)
      .set(set)
      .where(
        and(
          eq(involuntaryAdmissions.id, id),
          eq(involuntaryAdmissions.status, 'ACTIVE'),
          unset ? isNull(unset as never) : undefined,
        ),
      )
      .returning();
    if (!updated) throw conflict('This step has already been recorded');
    await audit(
      {
        action: AuditAction.INVOLUNTARY_ADMISSION_CHANGED,
        actor: ctx,
        resourceType: 'involuntary_admission',
        resourceId: id,
        patientId: ia.patientId,
        meta,
        // Who explained rights or informed the representative is kept here.
        metadata: { kind, ...metadata },
      },
      tx,
    );
    return updated;
  });
  return presentInvoluntary(row, await namesOf(peopleOf([row], [])));
}

const notBefore = (at: Date, earliest: Date, message: string) => {
  if (at.getTime() < earliest.getTime()) throw badRequest(message);
};

const SecondOpinionInput = z.object({
  confirms: z.boolean(),
  /** When not confirmed: the patient agrees to stay as a voluntary patient. */
  staysVoluntarily: z.boolean().default(false),
  at: pastTime.optional(),
});

/** The independent second examination, by a different doctor. */
mentalHealthRouter.post(
  '/involuntary/:id/second-opinion',
  requireRole('DOCTOR'),
  async (req, res) => {
    const input = parse(SecondOpinionInput, req.body);
    res.json(
      await recordStep(req, DOCTOR_WRITERS, (ia, ctx) => {
        if (ctx.userId === ia.decidedById) {
          throw conflict('The second examination must be made by a different doctor');
        }
        const at = input.at ?? new Date();
        notBefore(at, ia.startedAt, 'The examination cannot be before the involuntary admission');
        const ends = !input.confirms;
        return {
          set: {
            secondOpinionById: ctx.userId,
            secondOpinionAt: at,
            secondOpinionConfirms: input.confirms,
            ...(ends
              ? input.staysVoluntarily
                ? { status: 'ENDED', endedAt: at, endReason: 'BECAME_VOLUNTARY' }
                : { status: 'RELEASED', endedAt: at, endReason: 'NOT_CONFIRMED' }
              : {}),
          },
          unset: involuntaryAdmissions.secondOpinionAt,
          kind: 'second_opinion',
          metadata: { confirms: input.confirms, staysVoluntarily: input.staysVoluntarily },
        };
      }),
    );
  },
);

const AtInput = z.object({ at: pastTime.optional() });

/** The patient was told, in a way they understand, about their rights and how to appeal. */
mentalHealthRouter.post(
  '/involuntary/:id/rights',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const input = parse(AtInput, req.body ?? {});
    res.json(
      await recordStep(req, CARE_TEAM_WRITERS, (ia) => {
        const at = input.at ?? new Date();
        notBefore(at, ia.startedAt, 'The time cannot be before the involuntary admission');
        return {
          set: { rightsExplainedAt: at },
          unset: involuntaryAdmissions.rightsExplainedAt,
          kind: 'rights_explained',
        };
      }),
    );
  },
);

const RepresentativeInput = z.object({
  name: z.string().trim().min(2).max(200),
  at: pastTime.optional(),
});

/** The legal representative or family was informed. */
mentalHealthRouter.post(
  '/involuntary/:id/representative',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const input = parse(RepresentativeInput, req.body);
    res.json(
      await recordStep(req, CARE_TEAM_WRITERS, (ia) => {
        const at = input.at ?? new Date();
        notBefore(at, ia.startedAt, 'The time cannot be before the involuntary admission');
        return {
          set: { representativeName: input.name, representativeNotifiedAt: at },
          unset: involuntaryAdmissions.representativeNotifiedAt,
          kind: 'representative_notified',
        };
      }),
    );
  },
);

const CourtNotificationInput = z.object({
  reference: z.string().trim().min(2).max(60),
  at: pastTime.optional(),
});

mentalHealthRouter.post(
  '/involuntary/:id/court-notification',
  requireRole('DOCTOR'),
  async (req, res) => {
    const input = parse(CourtNotificationInput, req.body);
    res.json(
      await recordStep(req, DOCTOR_WRITERS, (ia) => {
        const at = input.at ?? new Date();
        notBefore(at, ia.startedAt, 'The time cannot be before the involuntary admission');
        return {
          set: { courtNotifiedAt: at, courtReference: input.reference },
          unset: involuntaryAdmissions.courtNotifiedAt,
          kind: 'court_notified',
        };
      }),
    );
  },
);

const CourtDecisionInput = z.object({
  decision: z.enum(['CONFIRMED', 'REJECTED']),
  at: pastTime.optional(),
  authorisedUntil: z.coerce.date().optional(),
});

/** The court confirmed (until a date) or rejected the involuntary admission. */
mentalHealthRouter.post(
  '/involuntary/:id/court-decision',
  requireRole('DOCTOR'),
  async (req, res) => {
    const input = parse(CourtDecisionInput, req.body);
    res.json(
      await recordStep(req, DOCTOR_WRITERS, (ia) => {
        if (!ia.courtNotifiedAt) throw conflict('Record the notification of the court first');
        const at = input.at ?? new Date();
        notBefore(at, ia.courtNotifiedAt, 'The decision cannot be before the court was notified');
        if (input.decision === 'CONFIRMED') {
          const until = input.authorisedUntil;
          if (!until) throw badRequest('Give the date until which the court authorised it');
          if (until.getTime() <= Date.now())
            throw badRequest('The authorisation must end in the future');
          if (until.getTime() > at.getTime() + MAX_AUTHORISATION_DAYS * DAY) {
            throw badRequest('The authorisation is longer than the law allows');
          }
          return {
            set: { courtDecisionAt: at, courtDecision: 'CONFIRMED', authorisedUntil: until },
            unset: involuntaryAdmissions.courtDecisionAt,
            kind: 'court_decision',
            metadata: { decision: 'CONFIRMED' },
          };
        }
        return {
          set: {
            courtDecisionAt: at,
            courtDecision: 'REJECTED',
            status: 'RELEASED',
            endedAt: at,
            endReason: 'COURT_REJECTED',
          },
          unset: involuntaryAdmissions.courtDecisionAt,
          kind: 'court_decision',
          metadata: { decision: 'REJECTED' },
        };
      }),
    );
  },
);

const RenewInput = z.object({
  authorisedUntil: z.coerce.date(),
  reference: z.string().trim().min(2).max(60).optional(),
  at: pastTime.optional(),
});

/** A new court decision extends the authorisation (a new review period). */
mentalHealthRouter.post(
  '/involuntary/:id/authorisation',
  requireRole('DOCTOR'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { id } = parse(IdParam, req.params);
    const meta = requestMeta(req);
    const input = parse(RenewInput, req.body);
    const ia = await loadInvoluntary(id);
    await assertMentalHealthAccess(ctx, ia.patientId, meta, DOCTOR_WRITERS);
    if (ia.status !== 'ACTIVE') throw conflict('The involuntary admission has ended');
    if (ia.courtDecision !== 'CONFIRMED' || !ia.authorisedUntil) {
      throw conflict('Only a confirmed authorisation can be extended');
    }
    const at = input.at ?? new Date();
    if (input.authorisedUntil <= ia.authorisedUntil) {
      throw badRequest('The new authorisation must end later than the current one');
    }
    if (input.authorisedUntil.getTime() > at.getTime() + MAX_AUTHORISATION_DAYS * DAY) {
      throw badRequest('The authorisation is longer than the law allows');
    }
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(involuntaryAdmissions)
        .set({
          authorisedUntil: input.authorisedUntil,
          courtDecisionAt: at,
          ...(input.reference ? { courtReference: input.reference } : {}),
        })
        .where(and(eq(involuntaryAdmissions.id, id), eq(involuntaryAdmissions.status, 'ACTIVE')))
        .returning();
      if (!updated) throw conflict('The involuntary admission has ended');
      await audit(
        {
          action: AuditAction.INVOLUNTARY_ADMISSION_CHANGED,
          actor: ctx,
          resourceType: 'involuntary_admission',
          resourceId: id,
          patientId: ia.patientId,
          meta,
          metadata: {
            kind: 'authorisation_extended',
            from: ia.authorisedUntil!.toISOString(),
            to: input.authorisedUntil.toISOString(),
          },
        },
        tx,
      );
      return updated;
    });
    res.json(presentInvoluntary(row, await namesOf(peopleOf([row], []))));
  },
);

const EndInput = z.object({
  reason: z.enum(END_REASONS),
  note: note(280).optional(),
  at: pastTime.optional(),
});

/** Ends the involuntary admission: discharge, or the patient stays voluntarily. */
mentalHealthRouter.post('/involuntary/:id/end', requireRole('DOCTOR'), async (req, res) => {
  const input = parse(EndInput, req.body);
  if (input.reason === 'OTHER' && !input.note) throw badRequest('Give the reason');
  res.json(
    await recordStep(req, DOCTOR_WRITERS, (ia) => {
      const at = input.at ?? new Date();
      notBefore(at, ia.startedAt, 'The end cannot be before the start');
      return {
        set: {
          status: 'ENDED',
          endedAt: at,
          endReason: input.note ? `${input.reason}: ${input.note}` : input.reason,
        },
        unset: involuntaryAdmissions.endedAt,
        kind: 'ended',
        metadata: { reason: input.reason },
      };
    }),
  );
});

/* ------------------------------------------------------------------ restrictive ----------- */

const RestrictiveInput = z.object({
  kind: z.enum(RESTRICTIVE_KINDS),
  reason: note(2000).refine((s) => s.length >= 10, 'Describe why it was necessary'),
  startedAt: pastTime.optional(),
  /** Rapid tranquillisation: the recorded medication administration (this patient's). */
  medicationAdministrationId: z.string().uuid().optional().nullable(),
});

/** Records the start of restraint, seclusion or rapid tranquillisation (doctor or nurse). */
mentalHealthRouter.post(
  '/patients/:patientId/restrictive',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const meta = requestMeta(req);
    await assertMentalHealthAccess(ctx, patientId, meta, CARE_TEAM_WRITERS);
    const input = parse(RestrictiveInput, req.body);
    const admission = await currentAdmission(patientId);
    if (!admission) throw conflict('Restrictive interventions are recorded for admitted patients');
    if (admission.facilityId !== ctx.facilityId) throw forbidden();
    if (input.medicationAdministrationId) {
      if (input.kind !== 'RAPID_TRANQUILLISATION') {
        throw badRequest('A medication is linked only to rapid tranquillisation');
      }
      const [ma] = await db
        .select({ patientId: medicationAdministrations.patientId })
        .from(medicationAdministrations)
        .where(eq(medicationAdministrations.id, input.medicationAdministrationId));
      if (!ma || ma.patientId !== patientId) {
        throw badRequest('The medication administration is not this patient’s');
      }
    }
    const startedAt = input.startedAt ?? new Date();
    const first: Observation[] = input.medicationAdministrationId
      ? [
          {
            at: startedAt.toISOString(),
            byId: ctx.userId,
            note: null,
            vitalsChecked: false,
            administrationId: input.medicationAdministrationId,
          },
        ]
      : [];
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(restrictiveInterventions)
        .values({
          patientId,
          admissionId: admission.id,
          facilityId: admission.facilityId,
          kind: input.kind,
          reason: input.reason,
          startedAt,
          orderedById: ctx.userId,
          observations: first,
        })
        .returning();
      await audit(
        {
          action: AuditAction.RESTRICTIVE_INTERVENTION_RECORDED,
          actor: ctx,
          resourceType: 'restrictive_intervention',
          resourceId: created!.id,
          patientId,
          meta,
          metadata: { kind: 'started', type: input.kind },
        },
        tx,
      );
      return created!;
    });
    res.status(201).json(presentRestrictive(row, await namesOf(peopleOf([], [row]))));
  },
);

async function restrictiveAccess(
  req: Parameters<Parameters<typeof mentalHealthRouter.post>[1]>[0],
) {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const meta = requestMeta(req);
  const r = await loadRestrictive(id);
  await assertMentalHealthAccess(ctx, r.patientId, meta, CARE_TEAM_WRITERS);
  return { ctx, id, meta, r };
}

const ObservationInput = z.object({
  note: z.string().trim().min(2).max(500),
  vitalsChecked: z.boolean().default(false),
  at: pastTime.optional(),
});

/** Adds an observation (time, who, note, whether vital signs were checked). */
mentalHealthRouter.post(
  '/restrictive/:id/observations',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const { ctx, id, meta, r } = await restrictiveAccess(req);
    const input = parse(ObservationInput, req.body);
    const at = input.at ?? new Date();
    if (at < r.startedAt) throw badRequest('The observation cannot be before the start');
    if (r.endedAt && at > new Date(r.endedAt.getTime() + HOUR)) {
      throw badRequest('The intervention has ended');
    }
    const entry: Observation = {
      at: at.toISOString(),
      byId: ctx.userId,
      note: input.note,
      vitalsChecked: input.vitalsChecked,
    };
    const [row] = await db
      .update(restrictiveInterventions)
      .set({
        observations: sql`${restrictiveInterventions.observations} || ${JSON.stringify([entry])}::jsonb`,
      })
      .where(eq(restrictiveInterventions.id, id))
      .returning();
    await audit({
      action: AuditAction.RESTRICTIVE_INTERVENTION_RECORDED,
      actor: ctx,
      resourceType: 'restrictive_intervention',
      resourceId: id,
      patientId: r.patientId,
      meta,
      metadata: { kind: 'observation', vitalsChecked: input.vitalsChecked },
    });
    res.json(presentRestrictive(row!, await namesOf(peopleOf([], [row!]))));
  },
);

const EndRestrictiveInput = z.object({
  at: pastTime.optional(),
  injuries: z.string().trim().max(300).optional().nullable(),
});

mentalHealthRouter.post(
  '/restrictive/:id/end',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const { ctx, id, meta, r } = await restrictiveAccess(req);
    const input = parse(EndRestrictiveInput, req.body ?? {});
    const at = input.at ?? new Date();
    if (at < r.startedAt) throw badRequest('The end cannot be before the start');
    const [row] = await db
      .update(restrictiveInterventions)
      .set({ endedAt: at, injuries: input.injuries || null })
      .where(and(eq(restrictiveInterventions.id, id), isNull(restrictiveInterventions.endedAt)))
      .returning();
    if (!row) throw conflict('The intervention has already ended');
    await audit({
      action: AuditAction.RESTRICTIVE_INTERVENTION_RECORDED,
      actor: ctx,
      resourceType: 'restrictive_intervention',
      resourceId: id,
      patientId: r.patientId,
      meta,
      metadata: {
        kind: 'ended',
        minutes: Math.round((at.getTime() - r.startedAt.getTime()) / 60_000),
        injuries: Boolean(input.injuries),
      },
    });
    res.json(presentRestrictive(row, await namesOf(peopleOf([], [row]))));
  },
);

const DebriefInput = z.object({
  note: note(3000).refine((s) => s.length >= 10, 'Summarise the debrief'),
  at: pastTime.optional(),
});

/** The debrief with the patient (and the staff involved) after it ended. */
mentalHealthRouter.post(
  '/restrictive/:id/debrief',
  requireRole('DOCTOR', 'NURSE'),
  async (req, res) => {
    const { ctx, id, meta, r } = await restrictiveAccess(req);
    const input = parse(DebriefInput, req.body);
    if (!r.endedAt) throw conflict('End the intervention before the debrief');
    const at = input.at ?? new Date();
    if (at < r.endedAt) throw badRequest('The debrief cannot be before the end');
    const [row] = await db
      .update(restrictiveInterventions)
      .set({ debriefAt: at, debriefNote: input.note })
      .where(and(eq(restrictiveInterventions.id, id), isNull(restrictiveInterventions.debriefAt)))
      .returning();
    if (!row) throw conflict('The debrief has already been recorded');
    await audit({
      action: AuditAction.RESTRICTIVE_INTERVENTION_RECORDED,
      actor: ctx,
      resourceType: 'restrictive_intervention',
      resourceId: id,
      patientId: r.patientId,
      meta,
      metadata: { kind: 'debrief' },
    });
    res.json(presentRestrictive(row, await namesOf(peopleOf([], [row]))));
  },
);

/* ------------------------------------------------------------------ director -------------- */

const oversightViews = new Map<string, number>();

/**
 * Legal oversight for the facility director: every active involuntary admission with the
 * patient's name, ward and the state of each legal step (the director is legally responsible for
 * the deadlines), plus counts of restrictive interventions. No assessment, grounds or notes. Each
 * patient listed is recorded in their access log.
 */
mentalHealthRouter.get('/oversight', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const meta = requestMeta(req);
  const rows = await db.execute<{
    id: string;
    patient_id: string;
    first_name: string;
    last_name: string;
    unit_name: string;
  }>(sql`
    SELECT ia.id, ia.patient_id, p.first_name, p.last_name, cu.name AS unit_name
    FROM involuntary_admissions ia
    JOIN patients p ON p.id = ia.patient_id
    JOIN admissions a ON a.id = ia.admission_id
    JOIN care_units cu ON cu.id = a.unit_id
    WHERE ia.facility_id = ${ctx.facilityId} AND ia.status = 'ACTIVE'
    ORDER BY ia.started_at`);
  const ia = rows.rows.length
    ? await db
        .select()
        .from(involuntaryAdmissions)
        .where(
          inArray(
            involuntaryAdmissions.id,
            rows.rows.map((r) => r.id),
          ),
        )
    : [];
  const byId = new Map(ia.map((x) => [x.id, x]));
  const names = await namesOf(ia.map((x) => x.decidedById));
  const now = Date.now();
  for (const r of rows.rows) {
    const key = `${ctx.userId}:${r.patient_id}`;
    if ((oversightViews.get(key) ?? 0) > now - 10 * 60_000) continue;
    oversightViews.set(key, now);
    if (oversightViews.size > 20_000) oversightViews.clear();
    await auditSafe({
      action: AuditAction.PATIENT_RECORD_VIEWED,
      actor: ctx,
      resourceType: 'patient',
      resourceId: r.patient_id,
      patientId: r.patient_id,
      meta,
      metadata: { section: 'mental_health_legal_oversight', basis: 'DIRECTOR_OVERSIGHT' },
    });
  }
  const items = rows.rows.map((r) => {
    const x = byId.get(r.id)!;
    const steps = legalSteps(x);
    return {
      id: x.id,
      patient: { firstName: r.first_name, lastName: r.last_name },
      unitName: r.unit_name,
      startedAt: x.startedAt,
      decidedBy: names.get(x.decidedById) ?? null,
      courtDecision: x.courtDecision,
      authorisedUntil: x.authorisedUntil,
      steps,
      overdueSteps: steps.filter((s) => s.status === 'OVERDUE').map((s) => s.step),
    };
  });
  const since = new Date(now - 30 * DAY);
  const counts = await db.execute<{ kind: string; n: number; no_debrief: number; active: number }>(
    sql`
    SELECT kind, count(*)::int AS n,
      count(*) FILTER (WHERE ended_at IS NOT NULL AND debrief_at IS NULL
        AND ended_at < now() - ${`${DEBRIEF_HOURS} hours`}::interval)::int AS no_debrief,
      count(*) FILTER (WHERE ended_at IS NULL)::int AS active
    FROM restrictive_interventions
    WHERE facility_id = ${ctx.facilityId} AND (started_at >= ${since} OR ended_at IS NULL)
    GROUP BY kind`,
  );
  res.json({
    involuntary: items,
    overdueLegalSteps: items.reduce((n, i) => n + i.overdueSteps.length, 0),
    restrictiveLast30Days: Object.fromEntries(
      RESTRICTIVE_KINDS.map((k) => [k, counts.rows.find((c) => c.kind === k)?.n ?? 0]),
    ),
    restrictiveActive: counts.rows.reduce((n, c) => n + c.active, 0),
    debriefOverdue: counts.rows.reduce((n, c) => n + c.no_debrief, 0),
  });
});

/* ------------------------------------------------------------------ ministry -------------- */

const suppress = (n: number) => (n > 0 && n < SMALL_CELL_THRESHOLD ? null : n);

/**
 * National aggregates for the last 12 months, by facility: involuntary admissions, the share with
 * the court notified on time, restrictive interventions per 1,000 inpatient bed-days by type and
 * their median duration. Counts of 1–4 are hidden; rates, shares and medians are given only when
 * the underlying count reaches the threshold. No names.
 */
mentalHealthRouter.get('/stats', requireRole('MINISTRY'), async (_req, res) => {
  const since = new Date();
  since.setMonth(since.getMonth() - 12);
  const facilitiesRows = await db.execute<{
    facility_id: string;
    facility_name: string;
    involuntary: number;
    court_due: number;
    court_on_time: number;
    restraint: number;
    seclusion: number;
    rapid: number;
    restrictive: number;
    median_minutes: number | null;
    ended_count: number;
    bed_days: number;
  }>(sql`
    WITH ia AS (
      SELECT facility_id, count(*)::int AS involuntary,
        count(*) FILTER (WHERE court_notified_at IS NOT NULL
          OR coalesce(ended_at, now()) > started_at + interval '48 hours')::int AS court_due,
        count(*) FILTER (WHERE court_notified_at IS NOT NULL
          AND court_notified_at <= started_at + interval '48 hours')::int AS court_on_time
      FROM involuntary_admissions WHERE started_at >= ${since} GROUP BY facility_id
    ), ri AS (
      SELECT facility_id,
        count(*) FILTER (WHERE kind IN ('PHYSICAL_RESTRAINT', 'MECHANICAL_RESTRAINT'))::int AS restraint,
        count(*) FILTER (WHERE kind = 'SECLUSION')::int AS seclusion,
        count(*) FILTER (WHERE kind = 'RAPID_TRANQUILLISATION')::int AS rapid,
        count(*)::int AS restrictive,
        count(*) FILTER (WHERE ended_at IS NOT NULL AND kind <> 'RAPID_TRANQUILLISATION')::int AS ended_count,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ended_at - started_at) / 60)
          FILTER (WHERE ended_at IS NOT NULL AND kind <> 'RAPID_TRANQUILLISATION') AS median_minutes
      FROM restrictive_interventions WHERE started_at >= ${since} GROUP BY facility_id
    ), bd AS (
      SELECT facility_id,
        sum(extract(epoch FROM least(coalesce(discharged_at, now()), now())
                              - greatest(admitted_at, ${since}::timestamptz)) / 86400)::int AS bed_days
      FROM admissions
      WHERE status <> 'CANCELLED' AND coalesce(discharged_at, now()) > ${since}
      GROUP BY facility_id
    )
    SELECT f.id AS facility_id, f.name AS facility_name,
      coalesce(ia.involuntary, 0) AS involuntary, coalesce(ia.court_due, 0) AS court_due,
      coalesce(ia.court_on_time, 0) AS court_on_time,
      coalesce(ri.restraint, 0) AS restraint, coalesce(ri.seclusion, 0) AS seclusion,
      coalesce(ri.rapid, 0) AS rapid, coalesce(ri.restrictive, 0) AS restrictive,
      ri.median_minutes, coalesce(ri.ended_count, 0) AS ended_count,
      coalesce(bd.bed_days, 0) AS bed_days
    FROM facilities f
    LEFT JOIN ia ON ia.facility_id = f.id
    LEFT JOIN ri ON ri.facility_id = f.id
    LEFT JOIN bd ON bd.facility_id = f.id
    WHERE ia.facility_id IS NOT NULL OR ri.facility_id IS NOT NULL
    ORDER BY f.name`);
  const months = await db.execute<{ month: string; involuntary: number; restrictive: number }>(sql`
    SELECT m.month,
      (SELECT count(*)::int FROM involuntary_admissions
        WHERE to_char(started_at AT TIME ZONE 'Europe/Belgrade', 'YYYY-MM') = m.month) AS involuntary,
      (SELECT count(*)::int FROM restrictive_interventions
        WHERE to_char(started_at AT TIME ZONE 'Europe/Belgrade', 'YYYY-MM') = m.month) AS restrictive
    FROM (SELECT to_char(generate_series(date_trunc('month', ${since}::timestamptz),
                 date_trunc('month', now()), interval '1 month') AT TIME ZONE 'Europe/Belgrade',
                 'YYYY-MM') AS month) m
    ORDER BY m.month`);
  const rate = (n: number, bedDays: number) =>
    n >= SMALL_CELL_THRESHOLD && bedDays > 0 ? Math.round((n * 10_000) / bedDays) / 10 : null;
  res.json({
    facilities: facilitiesRows.rows.map((r) => ({
      facilityId: r.facility_id,
      facilityName: r.facility_name,
      involuntary: suppress(r.involuntary),
      courtOnTimePct:
        r.court_due >= SMALL_CELL_THRESHOLD
          ? Math.round((100 * r.court_on_time) / r.court_due)
          : null,
      restrictive: {
        restraint: suppress(r.restraint),
        seclusion: suppress(r.seclusion),
        rapidTranquillisation: suppress(r.rapid),
        total: suppress(r.restrictive),
      },
      per1000BedDays: {
        restraint: rate(r.restraint, r.bed_days),
        seclusion: rate(r.seclusion, r.bed_days),
        rapidTranquillisation: rate(r.rapid, r.bed_days),
      },
      medianDurationMinutes:
        r.ended_count >= SMALL_CELL_THRESHOLD && r.median_minutes != null
          ? Math.round(Number(r.median_minutes))
          : null,
    })),
    months: months.rows.map((m) => ({
      month: m.month,
      involuntary: suppress(m.involuntary),
      restrictive: suppress(m.restrictive),
    })),
    smallCellThreshold: SMALL_CELL_THRESHOLD,
  });
});
