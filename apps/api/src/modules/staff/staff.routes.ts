import { Router } from 'express';
import { and, asc, count, eq, ilike, inArray, ne, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { facilities, STAFF_ROLES, users, type Role } from '../../db/schema.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { createInvitedUser } from '../auth/invitations.js';
import { revokeAllSessions } from '../auth/auth.service.js';
import { autoLinkOnInvite, licencesOfUsers } from '../licences/licences.service.js';

/**
 * Staff management follows the chain of command:
 *  - MINISTRY appoints Ministry officials and facility Directors.
 *  - DIRECTOR onboards the facility team (doctors, nurses, pharmacists, reception, co-directors)
 *    for their own facility only.
 */
const FACILITY_TEAM: Role[] = ['DIRECTOR', 'DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION'];
const INVITABLE_BY: Record<Role, Role[]> = {
  MINISTRY: ['MINISTRY', 'DIRECTOR'],
  DIRECTOR: FACILITY_TEAM,
  DOCTOR: [],
  NURSE: [],
  PHARMACIST: [],
  RECEPTION: [],
  PATIENT: [],
};
/** Regulated professions must be registered with their professional licence number. */
const LICENSED: Role[] = ['DOCTOR', 'NURSE', 'PHARMACIST'];

const StaffRole = z.enum(STAFF_ROLES);

const InviteSchema = z.object({
  email: z.string().trim().email().max(254),
  fullName: z.string().trim().min(2).max(200),
  role: StaffRole,
  facilityId: z.string().uuid().optional().nullable(),
  specialty: z.string().trim().max(120).optional().nullable(),
  licenseNumber: z.string().trim().max(60).optional().nullable(),
});

const ListQuery = PaginationSchema.extend({
  role: StaffRole.optional(),
  facilityId: z.string().uuid().optional(),
  search: z.string().trim().max(100).optional(),
});

const StatusSchema = z.object({ isActive: z.boolean() });
const IdParam = z.object({ id: z.string().uuid() });

const staffColumns = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  role: users.role,
  specialty: users.specialty,
  licenseNumber: users.licenseNumber,
  isActive: users.isActive,
  activated: users.passwordChangedAt,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  facilityId: users.facilityId,
  facilityName: facilities.name,
};

/** Which staff records the caller may manage. */
function canManage(ctx: AuthContext, target: { role: Role; facilityId: string | null }) {
  if (ctx.role === 'MINISTRY') return target.role === 'MINISTRY' || target.role === 'DIRECTOR';
  if (ctx.role === 'DIRECTOR') {
    return target.facilityId === ctx.facilityId && FACILITY_TEAM.includes(target.role);
  }
  return false;
}

export const staffRouter = Router();
staffRouter.use(authenticate, requireRole('MINISTRY', 'DIRECTOR'));

staffRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [inArray(users.role, [...STAFF_ROLES])];
  if (ctx.role === 'DIRECTOR') filters.push(eq(users.facilityId, ctx.facilityId!));
  else if (q.facilityId) filters.push(eq(users.facilityId, q.facilityId));
  if (q.role) filters.push(eq(users.role, q.role));
  if (q.search) {
    filters.push(or(ilike(users.fullName, `%${q.search}%`), ilike(users.email, `%${q.search}%`))!);
  }
  const where = and(...filters);
  const [rows, [total]] = await Promise.all([
    db
      .select(staffColumns)
      .from(users)
      .leftJoin(facilities, eq(facilities.id, users.facilityId))
      .where(where)
      .orderBy(asc(users.role), asc(users.fullName))
      .limit(toOffset(q).limit)
      .offset(toOffset(q).offset),
    db.select({ total: count() }).from(users).where(where),
  ]);
  // Licence state of clinical staff (doctors, nurses, pharmacists) from the national register.
  const licences = await licencesOfUsers(rows.map((r) => r.id));
  res.json(
    paginated(
      rows.map(({ activated, ...r }) => {
        const l = licences.get(r.id);
        return {
          ...r,
          activated: Boolean(activated),
          licence: LICENSED.includes(r.role)
            ? l
              ? {
                  id: l.id,
                  licenceNumber: l.licenceNumber,
                  state: l.expiringSoon ? 'EXPIRING' : l.effectiveStatus,
                  validUntil: l.validUntil,
                }
              : { id: null, licenceNumber: null, state: 'MISSING', validUntil: null }
            : null,
        };
      }),
      total?.total ?? 0,
      q,
    ),
  );
});

staffRouter.post('/invitations', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(InviteSchema, req.body);

  if (!INVITABLE_BY[ctx.role].includes(input.role)) {
    throw forbidden(`A ${ctx.role.toLowerCase()} cannot appoint a ${input.role.toLowerCase()}`);
  }

  let facilityId: string | null = null;
  if (FACILITY_TEAM.includes(input.role)) {
    // Directors can only staff their own facility, regardless of what the request says.
    facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId : (input.facilityId ?? null);
    if (!facilityId) throw badRequest('facilityId is required for facility staff');
    const [facility] = await db
      .select({ id: facilities.id, isActive: facilities.isActive })
      .from(facilities)
      .where(eq(facilities.id, facilityId));
    if (!facility?.isActive) throw badRequest('Facility does not exist or is inactive');
  }
  if (LICENSED.includes(input.role) && !input.licenseNumber) {
    throw badRequest(
      'A professional licence number is required for doctors, nurses and pharmacists',
    );
  }

  const result = await db.transaction(async (tx) => {
    const invited = await createInvitedUser(
      tx,
      {
        email: input.email,
        fullName: input.fullName,
        role: input.role,
        facilityId,
        specialty: input.specialty,
        licenseNumber: input.licenseNumber,
      },
      ctx.userId,
    );
    // Link the register entry with the same number when profession and name match.
    const licenceLinked = await autoLinkOnInvite(tx, {
      id: invited.user.id,
      role: input.role,
      fullName: input.fullName,
      licenseNumber: input.licenseNumber,
    });
    await audit(
      {
        action: AuditAction.USER_INVITED,
        actor: ctx,
        resourceType: 'user',
        resourceId: invited.user.id,
        meta: requestMeta(req),
        metadata: { role: input.role, facilityId, licenceLinked },
      },
      tx,
    );
    return { ...invited, licenceLinked };
  });

  res.status(201).json({
    user: {
      id: result.user.id,
      email: result.user.email,
      fullName: result.user.fullName,
      role: result.user.role,
      facilityId: result.user.facilityId,
    },
    licenceLinked: result.licenceLinked,
    activationUrl: result.activationUrl,
  });
});

staffRouter.patch('/:id/status', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { isActive } = parse(StatusSchema, req.body);
  if (id === ctx.userId) throw badRequest('You cannot change the status of your own account');

  const [target] = await db
    .select({ id: users.id, role: users.role, facilityId: users.facilityId })
    .from(users)
    .where(and(eq(users.id, id), ne(users.role, 'PATIENT')));
  if (!target) throw notFound('Staff member not found');
  if (!canManage(ctx, target)) throw forbidden();

  await db.transaction(async (tx) => {
    await tx.update(users).set({ isActive }).where(eq(users.id, id));
    await audit(
      {
        action: isActive ? AuditAction.USER_REACTIVATED : AuditAction.USER_DEACTIVATED,
        actor: ctx,
        resourceType: 'user',
        resourceId: id,
        meta: requestMeta(req),
      },
      tx,
    );
  });
  if (!isActive) await revokeAllSessions(id);
  res.status(204).end();
});
