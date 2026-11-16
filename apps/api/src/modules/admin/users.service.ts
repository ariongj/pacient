import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  isNotNull,
  isNull,
  like,
  ne,
  notLike,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  auditLogs,
  careAssignments,
  facilities,
  mfaRecoveryCodes,
  refreshTokens,
  users,
  webauthnCredentials,
  type Role,
} from '../../db/schema.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';

/** Roles that belong to a facility (the database enforces the same rule). */
export const FACILITY_ROLES: Role[] = [
  'DIRECTOR',
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
  'LAB_TECHNICIAN',
  'IT_SUPPORT',
];
/** Roles without a facility that the administrator can invite. */
export const NATIONAL_ROLES: Role[] = ['MINISTRY', 'ADMIN'];
/** Everything the administrator can invite – never patients (facilities register patients). */
export const INVITABLE_ROLES = [
  'DIRECTOR',
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
  'LAB_TECHNICIAN',
  'IT_SUPPORT',
  'MINISTRY',
  'ADMIN',
] as const satisfies readonly Role[];
/** Regulated professions are registered with their professional licence number. */
export const LICENSED_ROLES: Role[] = ['DOCTOR', 'NURSE', 'PHARMACIST'];

export const ACCOUNT_STATUSES = ['active', 'disabled', 'locked', 'pending', 'no_mfa'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** LIKE pattern for a search text, with the wildcards of the text itself taken literally. */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The account as the administrator sees it: who, which role and facility, and the state of the
 * sign-in – never the password hash, second-factor secrets, a national ID, a link to a health
 * record or anything clinical.
 */
export const accountColumns = {
  id: users.id,
  email: users.email,
  fullName: users.fullName,
  role: users.role,
  facilityId: users.facilityId,
  facilityName: facilities.name,
  isActive: users.isActive,
  activated: sql<boolean>`${users.passwordHash} IS NOT NULL`,
  lockedUntil: users.lockedUntil,
  mfaEnabledAt: users.mfaEnabledAt,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
  specialty: users.specialty,
  licenseNumber: users.licenseNumber,
  failedLoginAttempts: users.failedLoginAttempts,
  passwordChangedAt: users.passwordChangedAt,
};

type AccountRow = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  facilityId: string | null;
  facilityName: string | null;
  isActive: boolean;
  activated: boolean;
  lockedUntil: Date | null;
  mfaEnabledAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  specialty: string | null;
  licenseNumber: string | null;
  failedLoginAttempts: number;
  passwordChangedAt: Date | null;
};

/** Short form for lists. */
export function accountSummary(r: AccountRow, now = new Date()) {
  return {
    id: r.id,
    email: r.email,
    fullName: r.fullName,
    role: r.role,
    facilityId: r.facilityId,
    facilityName: r.facilityName,
    isActive: r.isActive,
    activated: r.activated,
    locked: Boolean(r.lockedUntil && r.lockedUntil > now),
    lockedUntil: r.lockedUntil,
    mfaEnabled: r.mfaEnabledAt !== null,
    lastLoginAt: r.lastLoginAt,
    createdAt: r.createdAt,
  };
}

/** Full form for the account page. */
export function accountDetail(r: AccountRow, now = new Date()) {
  return {
    ...accountSummary(r, now),
    specialty: r.specialty,
    licenseNumber: r.licenseNumber,
    failedLoginAttempts: r.failedLoginAttempts,
    passwordChangedAt: r.passwordChangedAt,
  };
}

/** Filters shared by the list and its counts (everything except the status). */
export function baseFilters(q: {
  q?: string;
  role?: Role;
  facilityId?: string;
}): (SQL | undefined)[] {
  return [
    q.q
      ? or(ilike(users.fullName, likePattern(q.q)), ilike(users.email, likePattern(q.q)))
      : undefined,
    q.role ? eq(users.role, q.role) : undefined,
    q.facilityId ? eq(users.facilityId, q.facilityId) : undefined,
  ];
}

export function statusFilter(status: AccountStatus | undefined, now = new Date()) {
  switch (status) {
    case 'active':
      return and(eq(users.isActive, true), isNotNull(users.passwordHash));
    case 'disabled':
      return eq(users.isActive, false);
    case 'locked':
      return gt(users.lockedUntil, now);
    case 'pending':
      return isNull(users.passwordHash);
    case 'no_mfa':
      return and(
        ne(users.role, 'PATIENT'),
        isNotNull(users.passwordHash),
        isNull(users.mfaEnabledAt),
      );
    default:
      return undefined;
  }
}

/** How many accounts are in each state, for the filter chips. */
export async function statusCounts(filters: (SQL | undefined)[]) {
  const n = (cond: SQL) => sql<number>`(count(*) FILTER (WHERE ${cond}))::int`;
  const [row] = await db
    .select({
      active: n(sql`${users.isActive} AND ${users.passwordHash} IS NOT NULL`),
      disabled: n(sql`NOT ${users.isActive}`),
      locked: n(sql`${users.lockedUntil} > now()`),
      pending: n(sql`${users.passwordHash} IS NULL`),
      noMfa: n(
        sql`${users.role} <> 'PATIENT' AND ${users.passwordHash} IS NOT NULL AND ${users.mfaEnabledAt} IS NULL`,
      ),
    })
    .from(users)
    .where(and(...filters));
  return row ?? { active: 0, disabled: 0, locked: 0, pending: 0, noMfa: 0 };
}

export async function loadAccount(id: string, executor: Executor = db) {
  const [row] = await executor
    .select(accountColumns)
    .from(users)
    .leftJoin(facilities, eq(facilities.id, users.facilityId))
    .where(eq(users.id, id));
  if (!row) throw notFound('Account not found');
  return row as AccountRow;
}

/** An active facility, or a 400 explaining why the account cannot belong to it. */
export async function assertActiveFacility(facilityId: string, executor: Executor = db) {
  const [facility] = await executor
    .select({ id: facilities.id, isActive: facilities.isActive })
    .from(facilities)
    .where(eq(facilities.id, facilityId));
  if (!facility?.isActive) throw badRequest('The facility does not exist or is no longer active');
}

/**
 * Never leave the service without an active platform administrator who can sign in (an
 * invitation that was never accepted does not count).
 */
export async function assertAnotherActiveAdmin(exceptUserId: string, executor: Executor = db) {
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        eq(users.role, 'ADMIN'),
        eq(users.isActive, true),
        isNotNull(users.passwordHash),
        ne(users.id, exceptUserId),
      ),
    );
  if (!row || row.n < 1) {
    throw conflict(
      'This is the last active platform administrator. Invite another administrator first.',
    );
  }
}

/** Patients whose care team includes this person (an active care-team membership). */
export async function activeCareTeams(userId: string, executor: Executor = db) {
  const [row] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(careAssignments)
    .where(and(eq(careAssignments.doctorId, userId), isNull(careAssignments.endedAt)));
  return row?.n ?? 0;
}

/** Signs the account out everywhere; returns how many sessions (devices) were open. */
export async function revokeSessions(executor: Executor, userId: string) {
  const rows = await executor
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
    .returning({ familyId: refreshTokens.familyId });
  return new Set(rows.map((r) => r.familyId)).size;
}

/** Whether any second factor is set up (authenticator app, recovery codes or passkeys). */
export async function hasSecondFactor(userId: string, executor: Executor = db) {
  const [u] = await executor
    .select({ mfaEnabledAt: users.mfaEnabledAt, secret: users.mfaSecretEncrypted })
    .from(users)
    .where(eq(users.id, userId));
  if (u?.mfaEnabledAt || u?.secret) return true;
  const [codes] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(mfaRecoveryCodes)
    .where(eq(mfaRecoveryCodes.userId, userId));
  const [keys] = await executor
    .select({ n: sql<number>`count(*)::int` })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId));
  return (codes?.n ?? 0) > 0 || (keys?.n ?? 0) > 0;
}

/**
 * What happened to the account administratively (invitations, status and role changes, resets,
 * IT support actions), newest first. Only the reason and the names of changed fields are shown,
 * never raw details.
 */
export async function adminHistory(userId: string, limit = 20) {
  const rows = await db
    .select({
      id: auditLogs.id,
      occurredAt: auditLogs.occurredAt,
      action: auditLogs.action,
      outcome: auditLogs.outcome,
      actorRole: auditLogs.actorRole,
      actorName: users.fullName,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(
      and(
        eq(auditLogs.resourceType, 'user'),
        eq(auditLogs.resourceId, userId),
        // Sign-in and security events (auth.*) are in the sign-in history instead.
        notLike(auditLogs.action, 'auth.%'),
        // Changes by someone else (administrator, director, IT support) or by the system, not the
        // person's own preferences; an administrator's own action on their account (a rename) stays.
        or(
          isNull(auditLogs.actorUserId),
          ne(auditLogs.actorUserId, userId),
          like(auditLogs.action, 'admin.%'),
        ),
      ),
    )
    .orderBy(desc(auditLogs.occurredAt))
    .limit(limit);
  return rows.map((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      occurredAt: r.occurredAt,
      action: r.action,
      outcome: r.outcome,
      actorName: r.actorName,
      actorRole: r.actorRole,
      reason: typeof m.reason === 'string' ? m.reason : null,
      changes: Array.isArray(m.changes) ? (m.changes as unknown[]).map(String) : [],
    };
  });
}

/** Facilities for the invitation and role dialogs (active ones, by name). */
export async function activeFacilityOptions() {
  return db
    .select({ id: facilities.id, name: facilities.name })
    .from(facilities)
    .where(eq(facilities.isActive, true))
    .orderBy(asc(facilities.name));
}
