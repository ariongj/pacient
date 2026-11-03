import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { refreshTokens } from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { type Pagination, paginated, toOffset } from '../../lib/pagination.js';
import { hashToken } from '../../lib/tokens.js';
import { AuditAction, audit } from '../audit/audit.service.js';
import { deviceLabel, maskIp } from './devices.js';

/** The session family of the refresh-token cookie sent with this request (the "current" one). */
export async function currentFamily(userId: string, refreshToken: string | undefined) {
  if (!refreshToken) return null;
  const [row] = await db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(
      and(eq(refreshTokens.tokenHash, hashToken(refreshToken)), eq(refreshTokens.userId, userId)),
    );
  return row?.familyId ?? null;
}

/** Active sessions = refresh-token families with a token that is neither revoked nor expired. */
export async function listSessions(userId: string, refreshToken: string | undefined) {
  const current = await currentFamily(userId, refreshToken);
  const result = await db.execute<{
    family_id: string;
    started_at: string;
    last_used_at: string;
    user_agent: string | null;
    ip: string | null;
  }>(sql`
    SELECT family_id,
           min(created_at) AS started_at,
           max(created_at) AS last_used_at,
           (array_agg(user_agent ORDER BY created_at DESC))[1] AS user_agent,
           (array_agg(host(ip_address) ORDER BY created_at DESC))[1] AS ip
    FROM refresh_tokens
    WHERE user_id = ${userId}
    GROUP BY family_id
    HAVING bool_or(revoked_at IS NULL AND expires_at > now())
    ORDER BY max(created_at) DESC
    LIMIT 50`);
  return result.rows.map((r) => ({
    id: r.family_id,
    device: deviceLabel(r.user_agent),
    network: maskIp(r.ip),
    startedAt: r.started_at,
    lastUsedAt: r.last_used_at,
    current: r.family_id === current,
  }));
}

export async function revokeSession(ctx: AuthContext, familyId: string, meta: RequestMeta) {
  const rows = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.familyId, familyId),
        eq(refreshTokens.userId, ctx.userId),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .returning({ id: refreshTokens.id });
  if (!rows.length) throw notFound('Session not found');
  await audit({
    action: AuditAction.SESSION_REVOKED,
    actor: ctx,
    meta,
    resourceType: 'user',
    resourceId: ctx.userId,
    metadata: { scope: 'one' },
  });
}

/** Signs out every other device; the session making the request stays signed in. */
export async function revokeOtherSessions(
  ctx: AuthContext,
  refreshToken: string | undefined,
  meta: RequestMeta,
) {
  const current = await currentFamily(ctx.userId, refreshToken);
  const rows = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.userId, ctx.userId),
        isNull(refreshTokens.revokedAt),
        current ? sql`${refreshTokens.familyId} <> ${current}` : undefined,
      ),
    )
    .returning({ familyId: refreshTokens.familyId });
  const families = new Set(rows.map((r) => r.familyId)).size;
  await audit({
    action: AuditAction.SESSION_REVOKED,
    actor: ctx,
    meta,
    resourceType: 'user',
    resourceId: ctx.userId,
    metadata: { scope: 'others', sessions: families },
  });
  return { revoked: families };
}

const HISTORY_ACTIONS = [
  AuditAction.LOGIN_SUCCESS,
  AuditAction.LOGIN_FAILURE,
  AuditAction.LOGIN_LOCKED,
  AuditAction.LOGOUT,
  AuditAction.REFRESH_REUSE_DETECTED,
  AuditAction.PASSWORD_CHANGED,
  AuditAction.PASSWORD_RESET_COMPLETED,
  AuditAction.MFA_ENABLED,
  AuditAction.MFA_DISABLED,
  AuditAction.MFA_CHALLENGE_FAILED,
  AuditAction.MFA_RECOVERY_CODE_USED,
  AuditAction.PASSKEY_REGISTERED,
  AuditAction.PASSKEY_REMOVED,
  AuditAction.PASSKEY_LOGIN,
  AuditAction.SESSION_REVOKED,
  AuditAction.NEW_DEVICE_SIGN_IN,
];

/** The user's own security events of the last 90 days (never other people's). */
export async function signInHistory(userId: string, page: Pagination) {
  const where = sql`(actor_user_id = ${userId}::uuid OR (resource_type = 'user' AND resource_id = ${userId}::uuid))
    AND action IN ${sql.raw(`(${HISTORY_ACTIONS.map((a) => `'${a}'`).join(',')})`)}
    AND occurred_at > now() - interval '90 days'`;
  const { limit, offset } = toOffset(page);
  const [rows, total] = await Promise.all([
    db.execute<{
      id: string;
      occurred_at: string;
      action: string;
      outcome: string;
      ip: string | null;
      user_agent: string | null;
      metadata: Record<string, unknown> | null;
    }>(sql`
      SELECT id, occurred_at, action, outcome, host(ip_address) AS ip, user_agent, metadata
      FROM audit_logs WHERE ${where}
      ORDER BY occurred_at DESC LIMIT ${limit} OFFSET ${offset}`),
    db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_logs WHERE ${where}`),
  ]);
  const items = rows.rows.map((r) => ({
    id: r.id,
    occurredAt: r.occurred_at,
    action: r.action,
    outcome: r.outcome,
    device: r.user_agent ? deviceLabel(r.user_agent) : null,
    network: maskIp(r.ip),
    // Only non-sensitive details: which factor was used, or why a sign-in failed.
    factors: Array.isArray(r.metadata?.factors) ? (r.metadata!.factors as string[]) : null,
    reason: typeof r.metadata?.reason === 'string' ? r.metadata.reason : null,
  }));
  return paginated(items, total.rows[0]?.n ?? 0, page);
}
