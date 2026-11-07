import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { advanceDirectives, organDonationDecisions, patientDocuments } from '../../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertDemographicsAccess,
  assertNotMerged,
  auditRecordView,
  resolveAndAuditRead,
  resolveClinicalReadAccess,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { edUnitFor, isEdClinician } from '../ed/ed.service.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import {
  activeFlags,
  activeOfKind,
  ageOn,
  ADULT_AGE,
  CHECK_PURPOSES,
  DirectiveInput,
  donationHistory,
  donationIneligibility,
  DonationInput,
  listDirectives,
  PATIENT_REVOCABLE_KINDS,
  patientBasics,
  patientsInEd,
  registryStats,
  SINGLE_ACTIVE_KINDS,
  type DirectiveInputT,
  type DirectiveKind,
} from './directives.service.js';

/** Organ donation registry and advance directives. See directives.service.ts for the rules. */
export const directivesRouter = Router();
directivesRouter.use(authenticate);

const PatientParam = z.object({ patientId: z.string().uuid() });
const IdParam = z.object({ id: z.string().uuid() });
const ReasonBody = z.object({ reason: z.string().trim().min(5).max(500) });

/** Who may record each kind of directive (clinicians). */
const RECORDERS: Record<DirectiveKind, readonly string[]> = {
  DNACPR: ['DOCTOR'],
  TREATMENT_ESCALATION: ['DOCTOR'],
  ADVANCE_REFUSAL: ['DOCTOR'],
  HEALTHCARE_PROXY: ['DOCTOR', 'NURSE'],
};

async function requirePatient(patientId: string) {
  const p = await patientBasics(patientId);
  if (!p) throw notFound('Patient not found');
  assertNotMerged(p);
  return p;
}

/** The signed-in patient's own record (not when acting for someone else). */
function ownPatientId(ctx: AuthContext): string {
  if (ctx.role !== 'PATIENT' || !ctx.patientId) throw forbidden();
  if (ctx.proxy) {
    throw forbidden(
      'Organ donation and advance directives are personal decisions: only the person can record them',
    );
  }
  return ctx.patientId;
}

const ineligibleMessage = {
  MINOR: 'Organ donation decisions can be registered from the age of 18',
  DECEASED: 'This person has died; the register can no longer be changed',
};

async function notifyDirectiveChange(
  patientId: string,
  dateOfBirth: string,
  title: string,
  executor: Parameters<typeof notifyPatient>[2],
) {
  await notifyPatient(
    patientId,
    { type: 'directive', title, link: '/portal/wishes' },
    executor,
    // Adults' decisions are their own: guardians are told only about children.
    { guardians: ageOn(dateOfBirth) < ADULT_AGE ? 'full' : 'none' },
  );
}

/* ================================================================ portal (the person) ===== */

directivesRouter.get('/mine', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.patientId) throw forbidden();
  const p = await requirePatient(ctx.patientId);
  if (ctx.proxy) {
    // A guardian acting for a child: no donation registration for minors; directives that
    // concern the child are shown with full guardian access only.
    if (ctx.proxy.scope !== 'FULL')
      throw forbidden('Your guardian access covers appointments only');
    res.json({
      acting: true,
      donation: { eligible: false, reason: 'GUARDIAN', current: null, history: [] },
      directives: await listDirectives(p.id),
    });
    return;
  }
  const history = await donationHistory(p.id);
  const ineligible = donationIneligibility(p);
  res.json({
    acting: false,
    donation: {
      eligible: !ineligible,
      reason: ineligible,
      current: history[0] ?? null,
      history,
    },
    directives: await listDirectives(p.id),
  });
});

directivesRouter.post('/mine/organ-donation', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const patientId = ownPatientId(ctx);
  const input = parse(DonationInput, req.body);
  const p = await requirePatient(patientId);
  const ineligible = donationIneligibility(p);
  if (ineligible) throw conflict(ineligibleMessage[ineligible]);
  const meta = requestMeta(req);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(organDonationDecisions)
      .values({
        patientId,
        decision: input.decision,
        organs: input.decision === 'DONOR_SOME' ? input.organs! : null,
        familyInformed: input.familyInformed ?? null,
        faithOrBeliefNote: input.faithOrBeliefNote || null,
        recordedVia: 'PORTAL',
        recordedByUserId: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.ORGAN_DONATION_RECORDED,
        actor: ctx,
        resourceType: 'organ_donation_decision',
        resourceId: created!.id,
        patientId,
        meta,
        metadata: { via: 'PORTAL' },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

directivesRouter.post('/mine/healthcare-proxy', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const patientId = ownPatientId(ctx);
  const input = parse(
    z.object({
      proxyName: z.string().trim().min(2).max(200),
      proxyPhone: z.string().trim().max(40).optional().nullable(),
      relationship: z.string().trim().max(100).optional().nullable(),
      note: z.string().trim().max(1000).optional().nullable(),
    }),
    req.body,
  );
  const p = await requirePatient(patientId);
  if (p.deceasedAt) throw conflict(ineligibleMessage.DECEASED);
  if (ageOn(p.dateOfBirth) < ADULT_AGE) {
    throw conflict('A healthcare proxy can be named from the age of 18');
  }
  const meta = requestMeta(req);
  const row = await db.transaction(async (tx) => {
    if (await activeOfKind(patientId, 'HEALTHCARE_PROXY', tx)) {
      throw conflict(
        'You already named a healthcare proxy. Withdraw it first to name someone else.',
      );
    }
    const summary = [input.relationship, input.note].filter(Boolean).join(' – ');
    const [created] = await tx
      .insert(advanceDirectives)
      .values({
        patientId,
        kind: 'HEALTHCARE_PROXY',
        summary: summary || 'Named by the patient in the portal',
        proxyName: input.proxyName,
        proxyPhone: input.proxyPhone || null,
        discussedWith: null,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.DIRECTIVE_RECORDED,
        actor: ctx,
        resourceType: 'advance_directive',
        resourceId: created!.id,
        patientId,
        meta,
        metadata: { kind: 'HEALTHCARE_PROXY', via: 'PORTAL' },
      },
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

directivesRouter.post('/mine/directives/:id/revoke', requireRole('PATIENT'), async (req, res) => {
  const ctx = requireAuth(req);
  const patientId = ownPatientId(ctx);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(ReasonBody, req.body);
  const meta = requestMeta(req);
  const row = await db.transaction(async (tx) => {
    const [d] = await tx
      .select()
      .from(advanceDirectives)
      .where(and(eq(advanceDirectives.id, id), eq(advanceDirectives.patientId, patientId)))
      .for('update');
    if (!d) throw notFound('Directive not found');
    if (d.status !== 'ACTIVE') throw conflict('This directive is no longer active');
    if (!PATIENT_REVOCABLE_KINDS.includes(d.kind as DirectiveKind)) {
      throw forbidden(
        'This is a clinical decision. Talk to your doctor, who will review it with you.',
      );
    }
    const [updated] = await tx
      .update(advanceDirectives)
      .set({
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedById: ctx.userId,
        revokeReason: reason,
      })
      .where(eq(advanceDirectives.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.DIRECTIVE_REVOKED,
        actor: ctx,
        resourceType: 'advance_directive',
        resourceId: id,
        patientId,
        meta,
        metadata: { kind: d.kind, via: 'PORTAL' },
      },
      tx,
    );
    return updated!;
  });
  res.json(row);
});

/* ================================================================ clinicians ============= */

/** Directives of a patient (active and revoked) for the care team. */
directivesRouter.get('/patients/:patientId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  if (ctx.role === 'PATIENT') throw forbidden('Use your portal');
  await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'directives');
  const p = await requirePatient(patientId);
  res.json({
    items: await listDirectives(patientId),
    donationRegistrable: !donationIneligibility(p),
    canRecord: RECORDERS_BY_ROLE(ctx.role),
  });
});

const RECORDERS_BY_ROLE = (role: string) =>
  (Object.keys(RECORDERS) as DirectiveKind[]).filter((k) => RECORDERS[k].includes(role));

/** Lightweight banner data: active DNACPR / treatment escalation decisions. */
directivesRouter.get('/patients/:patientId/flags', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  if (ctx.role === 'PATIENT') throw forbidden('Use your portal');
  const meta = requestMeta(req);
  const basis = await resolveClinicalReadAccess(ctx, patientId, meta);
  await auditRecordView(ctx, patientId, basis, 'directives', meta);
  const flags = await activeFlags([patientId]);
  res.json({ items: flags.get(patientId) ?? [] });
});

directivesRouter.post('/patients/:patientId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input: DirectiveInputT = parse(DirectiveInput, req.body);
  const meta = requestMeta(req);
  const allowed = RECORDERS[input.kind];
  await assertClinicalWriteAccess(
    ctx,
    patientId,
    meta,
    allowed.includes('NURSE') ? WRITERS.careTeam : WRITERS.doctorOnly,
  );
  const p = await requirePatient(patientId);
  if (p.deceasedAt) throw conflict('This person has died; no new directives can be recorded');
  const today = new Date().toISOString().slice(0, 10);
  if (input.reviewDate && input.reviewDate < today) {
    throw badRequest('The review date cannot be in the past');
  }
  const row = await db.transaction(async (tx) => {
    if (
      SINGLE_ACTIVE_KINDS.includes(input.kind) &&
      (await activeOfKind(patientId, input.kind, tx))
    ) {
      throw conflict(
        'An active decision of this kind already exists. Revoke it first (with a reason), then record the new one.',
      );
    }
    if (input.documentId) {
      const [doc] = await tx
        .select({ id: patientDocuments.id, status: patientDocuments.status })
        .from(patientDocuments)
        .where(
          and(eq(patientDocuments.id, input.documentId), eq(patientDocuments.patientId, patientId)),
        );
      if (!doc || doc.status !== 'CURRENT') {
        throw badRequest('The linked document must be a current document of this patient');
      }
    }
    const [created] = await tx
      .insert(advanceDirectives)
      .values({
        patientId,
        kind: input.kind,
        summary: input.summary,
        discussedWith: input.discussedWith,
        proxyName: input.kind === 'HEALTHCARE_PROXY' ? input.proxyName : null,
        proxyPhone: input.kind === 'HEALTHCARE_PROXY' ? input.proxyPhone : null,
        documentId: input.documentId ?? null,
        reviewDate: input.reviewDate ?? null,
        facilityId: ctx.facilityId,
        createdById: ctx.userId,
      })
      .returning();
    await audit(
      {
        action: AuditAction.DIRECTIVE_RECORDED,
        actor: ctx,
        resourceType: 'advance_directive',
        resourceId: created!.id,
        patientId,
        meta,
        metadata: { kind: input.kind },
      },
      tx,
    );
    await notifyDirectiveChange(
      patientId,
      p.dateOfBirth,
      'A decision about your care was recorded – your doctor will explain it',
      tx,
    );
    return created!;
  });
  res.status(201).json(row);
});

directivesRouter.post('/:id/revoke', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(ReasonBody, req.body);
  const meta = requestMeta(req);
  const [d] = await db.select().from(advanceDirectives).where(eq(advanceDirectives.id, id));
  if (!d) throw notFound('Directive not found');
  const kind = d.kind as DirectiveKind;
  // Doctors revoke any directive; nurses only a healthcare proxy (as they may record one).
  await assertClinicalWriteAccess(
    ctx,
    d.patientId,
    meta,
    kind === 'HEALTHCARE_PROXY' ? WRITERS.careTeam : WRITERS.doctorOnly,
  );
  const p = await requirePatient(d.patientId);
  const row = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: advanceDirectives.status })
      .from(advanceDirectives)
      .where(eq(advanceDirectives.id, id))
      .for('update');
    if (locked?.status !== 'ACTIVE') throw conflict('This directive is no longer active');
    const [updated] = await tx
      .update(advanceDirectives)
      .set({
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedById: ctx.userId,
        revokeReason: reason,
      })
      .where(eq(advanceDirectives.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.DIRECTIVE_REVOKED,
        actor: ctx,
        resourceType: 'advance_directive',
        resourceId: id,
        patientId: d.patientId,
        meta,
        metadata: { kind },
      },
      tx,
    );
    await notifyDirectiveChange(
      d.patientId,
      p.dateOfBirth,
      'A decision about your care was changed – your doctor will explain it',
      tx,
    );
    return updated!;
  });
  res.json(row);
});

/**
 * Consulting the organ donation register for one patient: doctors with clinical access, for a
 * stated purpose. Every consultation is audited (and visible in the patient's access log).
 */
directivesRouter.post(
  '/patients/:patientId/organ-donation/check',
  requireRole('DOCTOR'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const input = parse(
      z.object({
        purpose: z.enum(CHECK_PURPOSES),
        note: z.string().trim().max(300).optional().nullable(),
      }),
      req.body,
    );
    const meta = requestMeta(req);
    const basis = await resolveClinicalReadAccess(ctx, patientId, meta);
    await audit({
      action: AuditAction.PATIENT_RECORD_VIEWED,
      actor: ctx,
      resourceType: 'organ_donation',
      resourceId: patientId,
      patientId,
      meta,
      metadata: {
        section: 'organ_donation',
        basis,
        purpose: input.purpose,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    const history = await donationHistory(patientId);
    const current = history[0] ?? null;
    res.json({
      registered: !!current,
      current: current && {
        decision: current.decision,
        organs: current.organs,
        familyInformed: current.familyInformed,
        faithOrBeliefNote: current.faithOrBeliefNote,
        recordedVia: current.recordedVia,
        createdAt: current.createdAt,
      },
      changes: history.length,
      checkedAt: new Date(),
    });
  },
);

/**
 * Recording a decision in person (the person is present and states it): doctors, nurses and
 * reception who may see the patient's details. The previous decision is not shown here.
 */
directivesRouter.post(
  '/patients/:patientId/organ-donation',
  requireRole('DOCTOR', 'NURSE', 'RECEPTION'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(PatientParam, req.params);
    const body = parse(
      z
        .object({ personPresent: z.literal(true, { message: 'The person must be present' }) })
        .passthrough(),
      req.body,
    );
    const input = parse(DonationInput, body);
    await assertDemographicsAccess(ctx, patientId);
    const p = await requirePatient(patientId);
    const ineligible = donationIneligibility(p);
    if (ineligible) throw conflict(ineligibleMessage[ineligible]);
    const meta = requestMeta(req);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(organDonationDecisions)
        .values({
          patientId,
          decision: input.decision,
          organs: input.decision === 'DONOR_SOME' ? input.organs! : null,
          familyInformed: input.familyInformed ?? null,
          faithOrBeliefNote: input.faithOrBeliefNote || null,
          recordedVia: 'IN_PERSON',
          recordedByUserId: ctx.userId,
        })
        .returning({ id: organDonationDecisions.id, createdAt: organDonationDecisions.createdAt });
      await audit(
        {
          action: AuditAction.ORGAN_DONATION_RECORDED,
          actor: ctx,
          resourceType: 'organ_donation_decision',
          resourceId: created!.id,
          patientId,
          meta,
          metadata: { via: 'IN_PERSON' },
        },
        tx,
      );
      await notifyPatient(
        patientId,
        {
          type: 'directive',
          title: 'Your organ donation decision was recorded',
          link: '/portal/wishes',
        },
        tx,
        { guardians: 'none' },
      );
      return created!;
    });
    res.status(201).json(row);
  },
);

/* ================================================================ emergency department === */

/** Active DNACPR / ceiling-of-care flags for the patients now in the caller's emergency department. */
directivesRouter.get('/ed-flags', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  let unit;
  try {
    unit = await edUnitFor(ctx);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      res.json({ items: [] });
      return;
    }
    throw err;
  }
  if (!(await isEdClinician(ctx, unit))) {
    throw forbidden('Only doctors and nurses assigned to the emergency department can see this');
  }
  const ids = await patientsInEd(unit.id);
  const flags = await activeFlags(ids);
  const meta = requestMeta(req);
  for (const patientId of flags.keys()) {
    await auditRecordView(ctx, patientId, 'UNIT', 'directives', meta);
  }
  res.json({ items: [...flags.entries()].map(([patientId, items]) => ({ patientId, items })) });
});

/* ================================================================ Ministry ================ */

directivesRouter.get('/registry/stats', requireRole('MINISTRY'), async (_req, res) => {
  res.json(await registryStats());
});
