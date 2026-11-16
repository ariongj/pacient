import { Router, type Request } from 'express';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { db } from '../../db/client.js';
import { facilities, oneTimeTokens, users, type Role } from '../../db/schema.js';
import { toLocale } from '../../i18n/index.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { generateOpaqueToken, hashToken } from '../../lib/tokens.js';
import { audit, AuditAction, type AuditActionValue } from '../audit/audit.service.js';
import { createInvitedUser } from '../auth/invitations.js';
import { requestPasswordReset } from '../auth/mfa.service.js';
import { enqueueEmail } from '../email/outbox.js';
import { autoLinkOnInvite } from '../licences/licences.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { listSessions, signInHistory } from '../security/sessions.js';
import { assertSeatAvailable } from '../subscriptions/subscriptions.service.js';
import { resetSecondFactors } from '../support/support.service.js';
import {
  accountColumns,
  accountDetail,
  accountSummary,
  ACCOUNT_STATUSES,
  activeCareTeams,
  activeFacilityOptions,
  adminHistory,
  assertActiveFacility,
  assertAnotherActiveAdmin,
  baseFilters,
  FACILITY_ROLES,
  hasSecondFactor,
  INVITABLE_ROLES,
  LICENSED_ROLES,
  loadAccount,
  NATIONAL_ROLES,
  revokeSessions,
  statusCounts,
  statusFilter,
} from './users.service.js';

/**
 * Account management by the platform administrator (mounted at /admin/users; the /admin router
 * already requires an ADMIN). Every account of the service – staff, Ministry, administrators and
 * patients – can be found, but only account data is ever shown: nothing clinical, no national ID,
 * no link to a health record. Patients' details are kept by their facility; here their accounts
 * can only be disabled, enabled, unlocked, signed out or sent a password reset.
 *
 * Guardrails: never on your own account (use your own security page), never the last active
 * administrator, licensed professions need their licence number, a role or facility change waits
 * until the person's patients are handed over, new facility staff need a free seat. Every change is
 * audited in the same transaction.
 */
export const adminUsersRouter = Router();

const ALL_ROLES = [
  'MINISTRY',
  'DIRECTOR',
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
  'LAB_TECHNICIAN',
  'IT_SUPPORT',
  'ADMIN',
  'PATIENT',
] as const satisfies readonly Role[];

const IdParam = z.object({ id: z.string().uuid() });
const Reason = z.string().trim().min(5, 'Give a reason of at least 5 characters').max(500);

const ListQuery = PaginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  role: z.enum(ALL_ROLES).optional(),
  facilityId: z.string().uuid().optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
});

const InviteSchema = z.object({
  email: z.string().trim().email().max(254),
  fullName: z.string().trim().min(2).max(200),
  role: z.enum(INVITABLE_ROLES),
  facilityId: z.string().uuid().optional().nullable(),
  specialty: z.string().trim().max(120).optional().nullable(),
  licenseNumber: z.string().trim().max(60).optional().nullable(),
});

const UpdateSchema = z
  .object({
    fullName: z.string().trim().min(2).max(200).optional(),
    role: z.enum(INVITABLE_ROLES).optional(),
    facilityId: z.string().uuid().nullable().optional(),
    specialty: z.string().trim().max(120).nullable().optional(),
    licenseNumber: z.string().trim().max(60).nullable().optional(),
    reason: Reason.optional(),
  })
  .refine(
    (v) =>
      v.fullName !== undefined ||
      v.role !== undefined ||
      v.facilityId !== undefined ||
      v.specialty !== undefined ||
      v.licenseNumber !== undefined,
    'Nothing to change',
  );

const ReasonBody = z.object({ reason: Reason });
const OptionalReasonBody = z.object({ reason: Reason.optional() });

/** Audit an administrative action on an account (inside the caller's transaction). */
function auditAccount(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  ctx: AuthContext,
  req: Request,
  action: AuditActionValue,
  userId: string,
  metadata: Record<string, unknown> = {},
) {
  return audit(
    {
      action,
      actor: ctx,
      resourceType: 'user',
      resourceId: userId,
      meta: requestMeta(req),
      metadata,
    },
    tx,
  );
}

/** The account page, after any change. */
async function presentAccount(id: string) {
  const [account, sessions, signIns, history, careTeams] = await Promise.all([
    loadAccount(id),
    listSessions(id, undefined),
    signInHistory(id, { page: 1, pageSize: 20 }),
    adminHistory(id),
    activeCareTeams(id),
  ]);
  return {
    user: { ...accountDetail(account), activeCareTeams: careTeams },
    sessions: sessions.map(({ current: _current, ...s }) => s),
    signIns: signIns.items,
    adminHistory: history,
  };
}

function notOnYourself(ctx: AuthContext, id: string, message: string) {
  if (ctx.userId === id) throw forbidden(message);
}

/* ------------------------------------------------------------------ read ------------------ */

adminUsersRouter.get('/', async (req, res) => {
  const q = parse(ListQuery, req.query);
  const now = new Date();
  const base = baseFilters(q);
  const where = and(...base, statusFilter(q.status, now));
  const { limit, offset } = toOffset(q);
  const [rows, [total], counts] = await Promise.all([
    db
      .select(accountColumns)
      .from(users)
      .leftJoin(facilities, eq(facilities.id, users.facilityId))
      .where(where)
      .orderBy(asc(sql`lower(${users.fullName})`), asc(users.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(where),
    statusCounts(base),
  ]);
  res.json({
    ...paginated(
      rows.map((r) => accountSummary(r, now)),
      total?.n ?? 0,
      q,
    ),
    counts,
  });
});

/** Active facilities for the invitation and role dialogs. */
adminUsersRouter.get('/facilities', async (_req, res) => {
  res.json({ items: await activeFacilityOptions() });
});

adminUsersRouter.get('/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await presentAccount(id));
});

/* ------------------------------------------------------------------ invite ---------------- */

adminUsersRouter.post('/', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(InviteSchema, req.body);
  const facilityRole = FACILITY_ROLES.includes(input.role);
  if (facilityRole && !input.facilityId) {
    throw badRequest('Choose the facility this person works at');
  }
  if (!facilityRole && input.facilityId) {
    throw badRequest('Ministry officials and platform administrators do not belong to a facility');
  }
  if (LICENSED_ROLES.includes(input.role) && !input.licenseNumber) {
    throw badRequest(
      'A professional licence number is required for doctors, nurses and pharmacists',
    );
  }
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${input.email.toLowerCase()}`);
  if (existing) throw conflict('An account with this e-mail address already exists');

  const facilityId = facilityRole ? input.facilityId! : null;
  const result = await db.transaction(async (tx) => {
    if (facilityId) {
      await assertActiveFacility(facilityId, tx);
      await assertSeatAvailable(facilityId, tx);
    }
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
    const licenceLinked = await autoLinkOnInvite(tx, {
      id: invited.user.id,
      role: input.role,
      fullName: input.fullName,
      licenseNumber: input.licenseNumber,
    });
    await auditAccount(tx, ctx, req, AuditAction.ADMIN_USER_INVITED, invited.user.id, {
      role: input.role,
      facilityId,
      licenceLinked,
    });
    return { ...invited, licenceLinked };
  });

  res.status(201).json({
    user: accountSummary(await loadAccount(result.user.id)),
    licenceLinked: result.licenceLinked,
    // The activation e-mail is queued with the account; it is sent once e-mail delivery is set up.
    emailQueued: true,
    // Shown outside production only (in production the person receives it by e-mail).
    activationUrl: result.activationUrl ?? null,
    expiresInHours: 72,
  });
});

/* ------------------------------------------------------------------ change ---------------- */

adminUsersRouter.patch('/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(UpdateSchema, req.body);
  const target = await loadAccount(id);
  if (target.role === 'PATIENT') {
    throw badRequest(
      'A patient’s details are kept by their facility. Here a patient account can only be disabled, enabled, unlocked, signed out or sent a password reset.',
    );
  }

  const role = input.role ?? target.role;
  const facilityRole = FACILITY_ROLES.includes(role);
  if (NATIONAL_ROLES.includes(role) && input.facilityId) {
    throw badRequest('Ministry officials and platform administrators do not belong to a facility');
  }
  const facilityId = facilityRole
    ? input.facilityId !== undefined
      ? input.facilityId
      : target.facilityId
    : null;
  if (facilityRole && !facilityId) throw badRequest('Choose the facility this person works at');

  const roleChanged = role !== target.role;
  const facilityChanged = facilityId !== target.facilityId;
  const licenseNumber =
    input.licenseNumber !== undefined ? input.licenseNumber : target.licenseNumber;
  if (LICENSED_ROLES.includes(role) && !licenseNumber) {
    throw badRequest(
      'A professional licence number is required for doctors, nurses and pharmacists',
    );
  }

  if (roleChanged || facilityChanged) {
    notOnYourself(ctx, id, 'You cannot change your own role or facility');
    if (!input.reason) throw badRequest('Give a reason for the change of role or facility');
  }

  const changes = Object.entries({
    fullName: input.fullName !== undefined && input.fullName !== target.fullName,
    role: roleChanged,
    facilityId: facilityChanged,
    specialty: input.specialty !== undefined && input.specialty !== target.specialty,
    licenseNumber:
      input.licenseNumber !== undefined && input.licenseNumber !== target.licenseNumber,
  })
    .filter(([, changed]) => changed)
    .map(([field]) => field);
  if (!changes.length) throw badRequest('Nothing to change');

  await db.transaction(async (tx) => {
    if (roleChanged || facilityChanged) {
      if (target.role === 'ADMIN' && role !== 'ADMIN' && target.isActive) {
        await assertAnotherActiveAdmin(id, tx);
      }
      const teams = await activeCareTeams(id, tx);
      if (teams > 0) {
        // The account page shows how many patients; the message stays translatable.
        throw conflict(
          'Hand over this person’s patients to colleagues first: they are still in the care team of patients.',
        );
      }
      if (facilityId && facilityChanged) {
        await assertActiveFacility(facilityId, tx);
        if (target.isActive) await assertSeatAvailable(facilityId, tx);
      }
    }
    await tx
      .update(users)
      .set({
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.specialty !== undefined ? { specialty: input.specialty } : {}),
        ...(input.licenseNumber !== undefined ? { licenseNumber: input.licenseNumber } : {}),
        role,
        facilityId,
      })
      .where(eq(users.id, id));
    let licenceLinked = false;
    if (LICENSED_ROLES.includes(role) && (roleChanged || changes.includes('licenseNumber'))) {
      licenceLinked = await autoLinkOnInvite(tx, {
        id,
        role,
        fullName: input.fullName ?? target.fullName,
        licenseNumber,
      });
    }
    // New permissions take effect at the next sign-in, everywhere.
    const signedOut = roleChanged || facilityChanged ? await revokeSessions(tx, id) : 0;
    await auditAccount(tx, ctx, req, AuditAction.ADMIN_USER_UPDATED, id, {
      changes,
      reason: input.reason ?? null,
      ...(roleChanged ? { fromRole: target.role, toRole: role } : {}),
      ...(facilityChanged ? { fromFacilityId: target.facilityId, toFacilityId: facilityId } : {}),
      ...(signedOut ? { sessionsRevoked: signedOut } : {}),
      ...(licenceLinked ? { licenceLinked } : {}),
    });
  });
  res.json(await presentAccount(id));
});

adminUsersRouter.post('/:id/disable', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(ReasonBody, req.body ?? {});
  notOnYourself(ctx, id, 'You cannot disable your own account');
  const target = await loadAccount(id);
  if (!target.isActive) throw conflict('The account is already disabled');
  await db.transaction(async (tx) => {
    if (target.role === 'ADMIN') await assertAnotherActiveAdmin(id, tx);
    await tx.update(users).set({ isActive: false }).where(eq(users.id, id));
    const sessions = await revokeSessions(tx, id);
    await auditAccount(tx, ctx, req, AuditAction.ADMIN_USER_DISABLED, id, {
      reason,
      sessionsRevoked: sessions,
    });
  });
  res.json(await presentAccount(id));
});

adminUsersRouter.post('/:id/enable', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(OptionalReasonBody, req.body ?? {});
  const target = await loadAccount(id);
  if (target.isActive) throw conflict('The account is already enabled');
  await db.transaction(async (tx) => {
    if (target.facilityId && FACILITY_ROLES.includes(target.role)) {
      await assertSeatAvailable(target.facilityId, tx);
    }
    await tx.update(users).set({ isActive: true }).where(eq(users.id, id));
    await auditAccount(tx, ctx, req, AuditAction.ADMIN_USER_ENABLED, id, {
      reason: reason ?? null,
    });
  });
  res.json(await presentAccount(id));
});

adminUsersRouter.post('/:id/unlock', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const target = await loadAccount(id);
  const locked = Boolean(target.lockedUntil && target.lockedUntil > new Date());
  if (!locked && target.failedLoginAttempts === 0) throw conflict('The account is not locked');
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ lockedUntil: null, failedLoginAttempts: 0 })
      .where(eq(users.id, id));
    await auditAccount(tx, ctx, req, AuditAction.ADMIN_USER_UNLOCKED, id, {
      wasLocked: locked,
      failedAttempts: target.failedLoginAttempts,
    });
  });
  res.json(await presentAccount(id));
});

adminUsersRouter.post('/:id/password-reset', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const target = await loadAccount(id);
  if (!target.activated) {
    throw conflict('This account is not activated yet: renew the activation link instead');
  }
  if (!target.isActive) throw conflict('Enable the account first');
  // The usual reset e-mail goes to the account's own address; the administrator never sees the link.
  await requestPasswordReset(target.email, requestMeta(req));
  await db.transaction(async (tx) => {
    await auditAccount(tx, ctx, req, AuditAction.ADMIN_PASSWORD_RESET_SENT, id);
  });
  res.json(await presentAccount(id));
});

adminUsersRouter.post('/:id/mfa-reset', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(ReasonBody, req.body ?? {});
  notOnYourself(ctx, id, 'Use your own security page for your own two-step sign-in');
  await loadAccount(id);
  if (!(await hasSecondFactor(id))) {
    throw conflict('Two-step sign-in is not set up for this account');
  }
  await db.transaction(async (tx) => {
    await resetSecondFactors(tx, id);
    const sessions = await revokeSessions(tx, id);
    await notifyUsers(
      [id],
      {
        type: 'security',
        title: 'Your two-step sign-in was reset by the administrator',
        link: '/account/security',
        important: true,
      },
      tx,
    );
    await auditAccount(tx, ctx, req, AuditAction.ADMIN_MFA_RESET, id, {
      reason,
      sessionsRevoked: sessions,
    });
  });
  res.json(await presentAccount(id));
});

adminUsersRouter.post('/:id/revoke-sessions', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  notOnYourself(ctx, id, 'Use your own security page to sign out your other devices');
  await loadAccount(id);
  await db.transaction(async (tx) => {
    const sessions = await revokeSessions(tx, id);
    await auditAccount(tx, ctx, req, AuditAction.ADMIN_SESSIONS_REVOKED, id, { sessions });
  });
  res.json(await presentAccount(id));
});

adminUsersRouter.post('/:id/resend-invitation', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const target = await loadAccount(id);
  if (target.activated) throw conflict('This account is already activated');
  if (!target.isActive) throw conflict('Enable the account first');
  const [account] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, id));
  const token = generateOpaqueToken();
  const activationUrl = `${env.WEB_APP_URL}/activate?token=${encodeURIComponent(token)}`;
  await db.transaction(async (tx) => {
    // Earlier links stop working: only the newest one activates the account.
    await tx
      .update(oneTimeTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(oneTimeTokens.userId, id),
          eq(oneTimeTokens.purpose, 'ACCOUNT_ACTIVATION'),
          isNull(oneTimeTokens.usedAt),
        ),
      );
    await tx.insert(oneTimeTokens).values({
      userId: id,
      purpose: 'ACCOUNT_ACTIVATION',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 72 * 3_600_000),
      createdById: ctx.userId,
    });
    await enqueueEmail(tx, {
      to: target.email,
      userId: id,
      template: 'activation',
      locale: toLocale(account?.locale),
      name: target.fullName,
      url: activationUrl,
    });
    await auditAccount(tx, ctx, req, AuditAction.ADMIN_INVITATION_RESENT, id);
  });
  res.json({
    ...(await presentAccount(id)),
    emailQueued: true,
    activationUrl: isProd ? null : activationUrl,
    expiresInHours: 72,
  });
});
