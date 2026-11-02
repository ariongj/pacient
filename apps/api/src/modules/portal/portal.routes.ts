import { Router } from 'express';
import { and, count, desc, eq, isNull, ne, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { auditLogs, facilities, patients, users } from '../../db/schema.js';
import { forbidden } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { ContactPatchSchema } from '../patients/patients.routes.js';
import { assertFullProxyScope } from '../access/policy.js';
import { activeDependants } from '../guardians/guardians.routes.js';

/**
 * Patient self-service. Clinical data is read through `/patients/:id/*` (the access policy grants
 * patients read access to their own record); these endpoints cover portal-only features.
 */
export const portalRouter = Router();
portalRouter.use(authenticate, requireRole('PATIENT'));

function ownPatientId(patientId: string | null): string {
  if (!patientId) throw forbidden('No patient record is linked to this account');
  return patientId;
}

/** Records this account may open on behalf of someone else (children, people under guardianship). */
portalRouter.get('/dependants', async (req, res) => {
  const ctx = requireAuth(req);
  res.json({ items: await activeDependants(ctx.userId) });
});

/** Transparency: every time someone else accessed or changed the patient's record. */
portalRouter.get('/access-log', async (req, res) => {
  const ctx = requireAuth(req);
  assertFullProxyScope(ctx);
  const patientId = ownPatientId(ctx.patientId);
  const page = parse(PaginationSchema, req.query);
  const where = and(
    eq(auditLogs.patientId, patientId),
    or(isNull(auditLogs.actorUserId), ne(auditLogs.actorUserId, ctx.userId)),
  );
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        occurredAt: auditLogs.occurredAt,
        action: auditLogs.action,
        actorName: users.fullName,
        actorRole: auditLogs.actorRole,
        actorSpecialty: users.specialty,
        facilityName: facilities.name,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .leftJoin(facilities, eq(facilities.id, auditLogs.actorFacilityId))
      .where(where)
      .orderBy(desc(auditLogs.occurredAt))
      .limit(toOffset(page).limit)
      .offset(toOffset(page).offset),
    db.select({ total: count() }).from(auditLogs).where(where),
  ]);
  // Only expose what the patient needs: the access basis/section, never internal metadata.
  const items = rows.map(({ metadata, ...r }) => ({
    ...r,
    section: (metadata?.section as string | undefined) ?? null,
    basis: (metadata?.basis as string | undefined) ?? null,
    emergencyReason:
      r.action === AuditAction.EMERGENCY_ACCESS_GRANTED ? (metadata?.reason as string) : null,
  }));
  res.json(paginated(items, total?.total ?? 0, page));
});

/** Patients keep their own contact details up to date. */
portalRouter.patch('/contact', async (req, res) => {
  const ctx = requireAuth(req);
  const patientId = ownPatientId(ctx.patientId);
  const patch = parse(ContactPatchSchema, req.body);
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(patients)
      .set(patch)
      .where(eq(patients.id, patientId))
      .returning();
    await audit(
      {
        action: AuditAction.PATIENT_DEMOGRAPHICS_UPDATED,
        actor: ctx,
        resourceType: 'patient',
        resourceId: patientId,
        patientId,
        meta: requestMeta(req),
        metadata: { fields: Object.keys(patch), source: 'portal' },
      },
      tx,
    );
    return row!;
  });
  const { userId: _userId, ...rest } = updated;
  res.json(rest);
});
