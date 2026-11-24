import { Router, type Request } from 'express';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isProd } from '../../config/env.js';
import { db } from '../../db/client.js';
import { facilities, patients, users, type Role } from '../../db/schema.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { ensureRecentAuth, requireRecentAuth } from '../../middleware/recent-auth.js';
import { audit, AuditAction, type AuditActionValue } from '../audit/audit.service.js';
import { createInvitedUser, renewInvitation } from '../auth/invitations.js';
import { sendPasswordResetLink } from '../auth/mfa.service.js';
import {
  autoLinkOnInvite,
  clearLicenceCache,
  hasLicenceFor,
  unlinkLicenceNotFor,
} from '../licences/licences.service.js';
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
  pendingHandover,
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
 * Patient accounts are not browsable: the list shows one only for its exact e-mail address, and a
 * patient's two-step sign-in and invitation stay with their facility: reception or a director
 * verifies the patient's identity in person and resets the two-step sign-in or sends the
 * invitation again on the patient's page (modules/patients).
 *
 * Guardrails: never on your own account (use your own security page), never the last active
 * administrator, licensed professions need their licence number, a role or facility change waits
 * until the person's patients, result cover, pending results, draft notes and returned
 * prescriptions are handed over, new facility staff need a free seat. Every change is audited in
 * the same transaction.
 *
 * What would hand someone the operator's powers, or lock its people out, asks for the password
 * again (or a sign-in in the last 10 minutes; see middleware/recent-auth.ts): inviting an
 * administrator, any change to an administrator's account or making someone one, resetting
 * two-step sign-in, disabling an account and signing it out everywhere.
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
  const account = await loadAccount(id);
  const patientAccount = account.role === 'PATIENT';
  const [sessions, signIns, history, careTeams] = await Promise.all([
    listSessions(id, undefined),
    signInHistory(id, { page: 1, pageSize: 20 }),
    adminHistory(id, { patientAccount }),
    patientAccount ? 0 : activeCareTeams(id),
  ]);
  return {
    user: { ...accountDetail(account), activeCareTeams: careTeams },
    sessions: sessions.map(({ current: _current, ...s }) => s),
    signIns: signIns.items,
    adminHistory: history,
  };
}

/**
 * The activation link in a response (outside production, for testing without e-mail). Never for a
 * patient account, in any environment: whoever holds the link chooses the password, and the
 * administrator must never be able to open a patient's record.
 */
const visibleActivationUrl = (role: Role, url: string | null | undefined) =>
  isProd || role === 'PATIENT' ? null : (url ?? null);

/** A patient's identity is verified by their facility; the operator cannot do that remotely. */
function notForPatients(target: { role: Role }, message: string) {
  if (target.role === 'PATIENT') throw badRequest(message);
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
  // Whoever holds a stolen session must not be able to add an administrator of their own.
  if (input.role === 'ADMIN') await ensureRecentAuth(req);
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
    activationUrl: visibleActivationUrl(input.role, result.activationUrl),
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
  // Making someone an administrator, demoting one, or changing an administrator's account.
  if (role === 'ADMIN' || target.role === 'ADMIN') await ensureRecentAuth(req);
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

  const licence = await db.transaction(async (tx) => {
    let licenceUnlinked: { id: string; profession: string } | null = null;
    if (roleChanged || facilityChanged) {
      // Under the administrators' lock, so two concurrent changes cannot both pass the check.
      if (target.role === 'ADMIN' && role !== 'ADMIN') await assertAnotherActiveAdmin(id, tx);
      const teams = await activeCareTeams(id, tx);
      if (teams > 0) {
        // The account page shows how many patients; the message stays translatable.
        throw conflict(
          'Hand over this person’s patients to colleagues first: they are still in the care team of patients.',
        );
      }
      // Result cover, results awaiting review, draft notes and returned prescriptions also reach
      // the old facility's patients (all on the person's worklist).
      const pending = await pendingHandover(id, tx);
      if (pending.coverArrangements > 0) {
        throw conflict(
          'Hand over first: this person has result cover arranged (covering a colleague, or covered while away). Cancel the cover before changing their role or facility.',
        );
      }
      if (pending.pendingResults > 0) {
        throw conflict(
          'Hand over first: results this person ordered are still waiting to be reviewed. They must be reviewed before the role or facility changes.',
        );
      }
      if (pending.draftNotes > 0) {
        throw conflict(
          'Hand over first: this person has notes still in draft. They must be signed before the role or facility changes.',
        );
      }
      if (pending.returnedPrescriptions > 0) {
        throw conflict(
          'Hand over first: the pharmacy returned prescriptions this person wrote. They must be resubmitted or cancelled before the role or facility changes.',
        );
      }
      if (facilityId && facilityChanged) {
        await assertActiveFacility(facilityId, tx);
        if (target.isActive) await assertSeatAvailable(facilityId, tx);
      }
      // A licence of the old profession must not count for the new role.
      if (roleChanged) licenceUnlinked = await unlinkLicenceNotFor(tx, id, role);
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
      ...(licenceUnlinked ? { licenceUnlinked: licenceUnlinked.id } : {}),
    });
    if (licenceUnlinked) {
      // The licence's own history (the Ministry's register) shows the unlink as well.
      await audit(
        {
          action: AuditAction.LICENCE_CHANGED,
          actor: ctx,
          resourceType: 'professional_licence',
          resourceId: licenceUnlinked.id,
          meta: requestMeta(req),
          metadata: {
            change: 'unlinked',
            userId: id,
            reason: input.reason ?? null,
            source: 'role_change',
            fromRole: target.role,
            toRole: role,
          },
        },
        tx,
      );
    }
    return {
      unlinked: Boolean(licenceUnlinked),
      // Whether a licence of the right profession is linked (licensed roles only): without one,
      // clinical entries are refused where licences are enforced.
      linked: LICENSED_ROLES.includes(role) ? await hasLicenceFor(id, role, tx) : null,
    };
  });
  clearLicenceCache(id);
  res.json({
    ...(await presentAccount(id)),
    licenceLinked: licence.linked,
    licenceUnlinked: licence.unlinked,
  });
});

adminUsersRouter.post('/:id/disable', requireRecentAuth(), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(ReasonBody, req.body ?? {});
  notOnYourself(ctx, id, 'You cannot disable your own account');
  const target = await loadAccount(id);
  if (!target.isActive) throw conflict('The account is already disabled');
  await db.transaction(async (tx) => {
    // Under the administrators' lock, so two concurrent changes cannot both pass the check.
    if (target.role === 'ADMIN') await assertAnotherActiveAdmin(id, tx);
    // Only if still active now (another administrator may have just disabled it).
    const [disabled] = await tx
      .update(users)
      .set({ isActive: false })
      .where(and(eq(users.id, id), eq(users.isActive, true)))
      .returning({ id: users.id });
    if (!disabled) throw conflict('The account is already disabled');
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
    if (target.role === 'PATIENT') {
      // Registering a death closes the patient's portal account; only withdrawing that
      // registration (the Ministry) opens it again. The message says nothing clinical.
      const [deceased] = await tx
        .select({ id: patients.id })
        .from(patients)
        .where(and(eq(patients.userId, id), isNotNull(patients.deceasedAt)))
        .limit(1);
      if (deceased) {
        throw conflict(
          'This account was closed when a death was registered. It comes back only if the death registration is withdrawn.',
        );
      }
    }
    if (target.facilityId && FACILITY_ROLES.includes(target.role)) {
      await assertSeatAvailable(target.facilityId, tx, { reactivation: { role: target.role } });
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
  const [account] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, id));
  // The usual reset e-mail goes to the account's own address; the administrator never sees the
  // link. Link, e-mail and audit entry (with the administrator as the one who asked) are one
  // transaction: no reset goes out unaudited.
  await db.transaction(async (tx) => {
    await sendPasswordResetLink(tx, { ...target, locale: account?.locale ?? null }, ctx.userId);
    await auditAccount(tx, ctx, req, AuditAction.ADMIN_PASSWORD_RESET_SENT, id);
  });
  res.json(await presentAccount(id));
});

adminUsersRouter.post('/:id/mfa-reset', requireRecentAuth(), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(ReasonBody, req.body ?? {});
  notOnYourself(ctx, id, 'Use your own security page for your own two-step sign-in');
  notForPatients(
    await loadAccount(id),
    'A patient’s two-step sign-in is reset by reception or a director of their facility, who verify the patient’s identity in person.',
  );
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

adminUsersRouter.post('/:id/revoke-sessions', requireRecentAuth(), async (req, res) => {
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
  notForPatients(
    target,
    'A patient’s portal invitation is sent again by reception or a director of their facility, who verify the patient’s identity in person.',
  );
  if (target.activated) throw conflict('This account is already activated');
  if (!target.isActive) throw conflict('Enable the account first');
  const [account] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, id));
  const activationUrl = await db.transaction(async (tx) => {
    // Earlier links stop working: only the newest one activates the account.
    const url = await renewInvitation(
      tx,
      { ...target, locale: account?.locale ?? null },
      ctx.userId,
    );
    await auditAccount(tx, ctx, req, AuditAction.ADMIN_INVITATION_RESENT, id);
    return url;
  });
  res.json({
    ...(await presentAccount(id)),
    emailQueued: true,
    activationUrl: visibleActivationUrl(target.role, activationUrl),
    expiresInHours: 72,
  });
});
