import { Router } from 'express';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../../db/client.js';
import {
  admissions,
  beds,
  careUnits,
  earlyWarningScores,
  patients,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { assertClinicalWriteAccess, resolveClinicalReadAccess } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { observationIntervalMinutes, RISK_RANK, type News2Risk } from './news2.js';
import {
  acknowledgeScore,
  recentScoresByAdmission,
  setSpo2Scale,
  spo2ScaleFor,
} from './news.service.js';

/**
 * NEWS2 early warning. Scores are computed from vital signs (see news.service.ts); this router
 * serves the ward early-warning board, a patient's score history and acknowledgement.
 */
export const newsRouter = Router();
newsRouter.use(authenticate);

const attending = alias(users, 'attending');

/** Ward early-warning board for the doctors and nurses of the facility. */
newsRouter.get('/board', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  if (!ctx.facilityId) throw forbidden();
  const { unitId } = parse(z.object({ unitId: z.string().uuid().optional() }), req.query);
  const now = new Date();
  const stays = await db
    .select({
      admissionId: admissions.id,
      patientId: admissions.patientId,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      temporaryIdentity: patients.temporaryIdentity,
      unitId: careUnits.id,
      unitName: careUnits.name,
      bedLabel: beds.label,
      attendingDoctorId: admissions.attendingDoctorId,
      attendingDoctorName: attending.fullName,
      admittedAt: admissions.admittedAt,
    })
    .from(admissions)
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .innerJoin(attending, eq(attending.id, admissions.attendingDoctorId))
    .leftJoin(beds, eq(beds.id, admissions.bedId))
    .where(
      and(
        eq(admissions.status, 'ADMITTED'),
        eq(careUnits.facilityId, ctx.facilityId),
        unitId ? eq(careUnits.id, unitId) : undefined,
      ),
    )
    .orderBy(asc(careUnits.name), asc(beds.label));

  const scores = await recentScoresByAdmission(stays.map((s) => s.admissionId));
  const lastObs = stays.length
    ? await db
        .select({ patientId: vitalSigns.patientId, at: vitalSigns.recordedAt })
        .from(vitalSigns)
        .where(
          inArray(
            vitalSigns.patientId,
            stays.map((s) => s.patientId),
          ),
        )
        .orderBy(desc(vitalSigns.recordedAt))
    : [];
  const lastObsByPatient = new Map<string, Date>();
  for (const o of lastObs) if (!lastObsByPatient.has(o.patientId)) lastObsByPatient.set(o.patientId, o.at);

  const items = stays.map((s) => {
    const recent = scores.get(s.admissionId) ?? [];
    const latest = recent[0] ?? null;
    const lastObservationAt = lastObsByPatient.get(s.patientId) ?? null;
    const interval = latest
      ? observationIntervalMinutes(latest.score, latest.risk as News2Risk)
      : 4 * 60;
    const reference = lastObservationAt ?? s.admittedAt;
    const minutesSince = Math.floor((now.getTime() - reference.getTime()) / 60_000);
    return {
      ...s,
      latest: latest && {
        id: latest.id,
        score: latest.score,
        risk: latest.risk,
        complete: latest.complete,
        components: latest.components,
        computedAt: latest.computedAt,
        escalatedAt: latest.escalatedAt,
        acknowledgedAt: latest.acknowledgedAt,
      },
      trend: recent.map((r) => ({ score: r.score, risk: r.risk, computedAt: r.computedAt })),
      lastObservationAt,
      observationIntervalMinutes: interval,
      minutesSinceObservation: minutesSince,
      overdue: !lastObservationAt || minutesSince > interval,
    };
  });
  items.sort((a, b) => {
    const ra = a.latest ? RISK_RANK[a.latest.risk as News2Risk] : -1;
    const rb = b.latest ? RISK_RANK[b.latest.risk as News2Risk] : -1;
    if (ra !== rb) return rb - ra;
    const sa = a.latest?.score ?? -1;
    const sb = b.latest?.score ?? -1;
    if (sa !== sb) return sb - sa;
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    return a.lastName.localeCompare(b.lastName);
  });
  res.json({
    items,
    counts: {
      HIGH: items.filter((i) => i.latest?.risk === 'HIGH').length,
      MEDIUM: items.filter((i) => i.latest?.risk === 'MEDIUM').length,
      LOW_MEDIUM: items.filter((i) => i.latest?.risk === 'LOW_MEDIUM').length,
      overdue: items.filter((i) => i.overdue).length,
      total: items.length,
    },
  });
});

/** A patient's score history (newest first) with the observations behind each score. */
newsRouter.get('/patients/:patientId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(z.object({ patientId: z.string().uuid() }), req.params);
  await resolveClinicalReadAccess(ctx, patientId, requestMeta(req));
  const rows = await db
    .select({
      id: earlyWarningScores.id,
      vitalSignId: earlyWarningScores.vitalSignId,
      admissionId: earlyWarningScores.admissionId,
      score: earlyWarningScores.score,
      risk: earlyWarningScores.risk,
      complete: earlyWarningScores.complete,
      components: earlyWarningScores.components,
      computedAt: earlyWarningScores.computedAt,
      escalatedAt: earlyWarningScores.escalatedAt,
      acknowledgedAt: earlyWarningScores.acknowledgedAt,
      acknowledgedBy: users.fullName,
    })
    .from(earlyWarningScores)
    .leftJoin(users, eq(users.id, earlyWarningScores.acknowledgedById))
    .where(eq(earlyWarningScores.patientId, patientId))
    .orderBy(desc(earlyWarningScores.computedAt))
    .limit(200);
  res.json({ items: rows, spo2Scale: await spo2ScaleFor(patientId) });
});

/** Acknowledge a score (and earlier unacknowledged ones of the stay). */
newsRouter.post('/scores/:id/acknowledge', requireRole('DOCTOR', 'NURSE'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const { note } = parse(
    z.object({ note: z.string().trim().max(500).optional() }),
    req.body ?? {},
  );
  const [score] = await db.select().from(earlyWarningScores).where(eq(earlyWarningScores.id, id));
  if (!score) throw notFound('Score not found');
  await resolveClinicalReadAccess(ctx, score.patientId, requestMeta(req));
  const updated = await acknowledgeScore(score, ctx.userId);
  await audit({
    action: AuditAction.EARLY_WARNING_ACKNOWLEDGED,
    actor: ctx,
    resourceType: 'early_warning_score',
    resourceId: id,
    patientId: score.patientId,
    meta: requestMeta(req),
    metadata: { score: score.score, risk: score.risk, acknowledged: updated.length, note },
  });
  res.json({ acknowledged: updated.length });
});

/**
 * SpO2 scale 2 is for patients with documented hypercapnic respiratory failure only – a doctor's
 * decision, recorded and audited. The latest observations are re-scored immediately.
 */
newsRouter.put('/patients/:patientId/spo2-scale', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(z.object({ patientId: z.string().uuid() }), req.params);
  const { scale, reason } = parse(
    z.object({
      scale: z.union([z.literal(1), z.literal(2)]),
      reason: z.string().trim().min(5).max(300),
    }),
    req.body,
  );
  await assertClinicalWriteAccess(ctx, patientId, requestMeta(req));
  const updated = await setSpo2Scale(patientId, scale, ctx.userId);
  await audit({
    action: AuditAction.CLINICAL_ENTRY_UPDATED,
    actor: ctx,
    resourceType: 'early_warning_score',
    resourceId: updated?.id ?? patientId,
    patientId,
    meta: requestMeta(req),
    metadata: { spo2Scale: scale, reason },
  });
  res.json({ spo2Scale: scale, latest: updated });
});
