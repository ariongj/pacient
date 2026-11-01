import { Router } from 'express';
import { and, desc, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { emergencyAccessGrants, patients, reviewOutcomeEnum, users } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/**
 * Retrospective review of break-glass access (blueprint §3). Every emergency access must be
 * reviewed by a director of the facility; the Ministry sees aggregate review compliance only.
 */
const ListQuery = z.object({
  status: z.enum(['unreviewed', 'reviewed', 'all']).default('unreviewed'),
});
const ReviewSchema = z.object({
  outcome: z.enum(reviewOutcomeEnum.enumValues),
  notes: z.string().trim().min(5).max(2000),
});
const IdParam = z.object({ id: z.string().uuid() });

export const emergencyRouter = Router();
emergencyRouter.use(authenticate);

emergencyRouter.get('/', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [eq(users.facilityId, ctx.facilityId!)];
  if (q.status === 'unreviewed') filters.push(isNull(emergencyAccessGrants.reviewedAt));
  if (q.status === 'reviewed') filters.push(isNotNull(emergencyAccessGrants.reviewedAt));
  const rows = await db
    .select({
      id: emergencyAccessGrants.id,
      createdAt: emergencyAccessGrants.createdAt,
      expiresAt: emergencyAccessGrants.expiresAt,
      reason: emergencyAccessGrants.reason,
      doctorId: emergencyAccessGrants.doctorId,
      doctorName: users.fullName,
      doctorSpecialty: users.specialty,
      patientId: emergencyAccessGrants.patientId,
      patientName: sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`,
      reviewedAt: emergencyAccessGrants.reviewedAt,
      reviewOutcome: emergencyAccessGrants.reviewOutcome,
      reviewNotes: emergencyAccessGrants.reviewNotes,
      reviewedBy: sql<
        string | null
      >`(SELECT r.full_name FROM users r WHERE r.id = ${emergencyAccessGrants.reviewedById})`,
      // What the doctor actually did with the access, to support the review.
      recordViews: sql<number>`(SELECT count(*)::int FROM audit_logs a
        WHERE a.actor_user_id = ${emergencyAccessGrants.doctorId}
          AND a.patient_id = ${emergencyAccessGrants.patientId}
          AND a.action = 'patient.record.viewed'
          AND a.occurred_at BETWEEN ${emergencyAccessGrants.createdAt} AND ${emergencyAccessGrants.expiresAt})`,
      recordChanges: sql<number>`(SELECT count(*)::int FROM audit_logs a
        WHERE a.actor_user_id = ${emergencyAccessGrants.doctorId}
          AND a.patient_id = ${emergencyAccessGrants.patientId}
          AND a.action LIKE 'clinical.%'
          AND a.occurred_at BETWEEN ${emergencyAccessGrants.createdAt} AND ${emergencyAccessGrants.expiresAt})`,
    })
    .from(emergencyAccessGrants)
    .innerJoin(users, eq(users.id, emergencyAccessGrants.doctorId))
    .innerJoin(patients, eq(patients.id, emergencyAccessGrants.patientId))
    .where(and(...filters))
    .orderBy(desc(emergencyAccessGrants.createdAt))
    .limit(200);
  res.json({ items: rows });
});

emergencyRouter.post('/:id/review', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(ReviewSchema, req.body);
  const [grant] = await db
    .select({
      id: emergencyAccessGrants.id,
      doctorId: emergencyAccessGrants.doctorId,
      patientId: emergencyAccessGrants.patientId,
      reviewedAt: emergencyAccessGrants.reviewedAt,
    })
    .from(emergencyAccessGrants)
    .innerJoin(users, eq(users.id, emergencyAccessGrants.doctorId))
    .where(and(eq(emergencyAccessGrants.id, id), eq(users.facilityId, ctx.facilityId!)));
  if (!grant) throw notFound('Emergency access event not found');
  if (grant.reviewedAt) throw conflict('This event has already been reviewed');

  await db.transaction(async (tx) => {
    await tx
      .update(emergencyAccessGrants)
      .set({
        reviewedAt: new Date(),
        reviewedById: ctx.userId,
        reviewOutcome: input.outcome,
        reviewNotes: input.notes,
      })
      .where(eq(emergencyAccessGrants.id, id));
    await audit(
      {
        action: AuditAction.EMERGENCY_ACCESS_REVIEWED,
        actor: ctx,
        resourceType: 'emergency_access',
        resourceId: id,
        patientId: grant.patientId,
        meta: requestMeta(req),
        metadata: { outcome: input.outcome },
      },
      tx,
    );
    await notifyUsers(
      [grant.doctorId],
      { type: 'emergency_access', title: 'Your emergency access was reviewed', link: '/doctor' },
      tx,
    );
  });
  res.status(204).end();
});

/** Ministry oversight: review compliance per facility, without identifiable data. */
emergencyRouter.get('/summary', requireRole('MINISTRY'), async (_req, res) => {
  const result = await db.execute(sql`
    SELECT f.id AS "facilityId", f.name AS "facilityName", f.region,
      count(g.id)::int AS total,
      count(g.id) FILTER (WHERE g.reviewed_at IS NULL)::int AS unreviewed,
      count(g.id) FILTER (WHERE g.reviewed_at IS NULL AND g.created_at < now() - interval '7 days')::int AS "overdueReviews",
      count(g.id) FILTER (WHERE g.review_outcome = 'INAPPROPRIATE')::int AS inappropriate,
      count(g.id) FILTER (WHERE g.review_outcome = 'NEEDS_FOLLOW_UP')::int AS "needsFollowUp"
    FROM facilities f
    LEFT JOIN users u ON u.facility_id = f.id AND u.role = 'DOCTOR'
    LEFT JOIN emergency_access_grants g ON g.doctor_id = u.id AND g.created_at >= now() - interval '90 days'
    GROUP BY f.id ORDER BY total DESC, f.name`);
  res.json({ periodDays: 90, items: result.rows });
});
