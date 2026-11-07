import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { facilities, professionalLicences, users } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  clearLicenceCache,
  daysBetween,
  describeLicence,
  effectiveStatus,
  EXPIRY_WARNING_DAYS,
  LICENCE_STATUSES,
  LICENSED_ROLES,
  namesMatch,
  notifyStatusChange,
  professionMatchesRole,
  PROFESSIONS,
  todayIso,
  validateCsv,
} from './licences.service.js';

/**
 * Professional licence register. The Ministry maintains it (create, update, suspend, revoke,
 * reinstate, link to accounts, CSV import); directors see their own clinical staff and may link a
 * licence when its number equals the number on the staff account and the names match; anyone can
 * check a licence publicly by its number (holder, profession, specialty, status, valid until).
 */
export const licencesRouter = Router();

/* ------------------------------------------------------------------- public (no sign-in) -- */

/** Strict: 20 checks per 10 minutes per address (kept on in tests so the headers can be checked). */
export const publicLicenceLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req: Request) => `licence-check:${req.ip}`,
  handler: (_req: Request, res: Response) => {
    res.status(429).json({
      error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests, please try again later' },
    });
  },
});

const NUMBER = /^[A-Za-z0-9/_.-]{3,40}$/;

licencesRouter.get('/public/:number', publicLicenceLimiter, async (req, res) => {
  const number = String(req.params.number);
  res.set('Cache-Control', 'no-store');
  const [l] = NUMBER.test(number)
    ? await db
        .select()
        .from(professionalLicences)
        .where(eq(professionalLicences.licenceNumber, number))
    : [];
  if (!l) throw notFound('No licence with this number is in the national register');
  const state = effectiveStatus(l);
  res.json({
    licenceNumber: l.licenceNumber,
    holderName: l.holderName,
    profession: l.profession,
    specialty: l.specialty,
    status: state,
    validUntil: l.validUntil,
  });
});

licencesRouter.use(authenticate);

/* ------------------------------------------------------------------------------ schemas -- */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const LicenceInput = z
  .object({
    licenceNumber: z.string().trim().regex(NUMBER, 'Invalid licence number'),
    holderName: z.string().trim().min(3).max(200),
    profession: z.enum(PROFESSIONS),
    specialty: z.string().trim().max(120).optional().nullable(),
    issuedBy: z.string().trim().min(3).max(200),
    issuedOn: isoDate,
    validUntil: isoDate,
    cpdCredits: z.coerce.number().int().min(0).max(9999).optional(),
  })
  .refine((v) => v.validUntil >= v.issuedOn, {
    message: 'The licence cannot expire before it was issued',
    path: ['validUntil'],
  });
const LicenceUpdate = z
  .object({
    holderName: z.string().trim().min(3).max(200).optional(),
    profession: z.enum(PROFESSIONS).optional(),
    specialty: z.string().trim().max(120).optional().nullable(),
    issuedBy: z.string().trim().min(3).max(200).optional(),
    issuedOn: isoDate.optional(),
    validUntil: isoDate.optional(),
    cpdCredits: z.coerce.number().int().min(0).max(9999).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');
const StatusInput = z.object({
  status: z.enum(LICENCE_STATUSES),
  reason: z.string().trim().min(5).max(500),
});
const LinkInput = z.object({ userId: z.string().uuid() });
const ReasonInput = z.object({ reason: z.string().trim().min(5).max(500) });
const ImportInput = z.object({
  csv: z.string().min(1).max(190_000),
  dryRun: z.boolean().default(true),
});
const LIST_STATES = ['VALID', 'EXPIRING', 'EXPIRED', 'SUSPENDED', 'REVOKED'] as const;
const ListQuery = PaginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  profession: z.enum(PROFESSIONS).optional(),
  state: z.enum(LIST_STATES).optional(),
  linked: z.enum(['yes', 'no']).optional(),
});
const IdParam = z.object({ id: z.string().uuid() });

const today = () => todayIso();
const plusDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function stateFilter(state: (typeof LIST_STATES)[number]): SQL {
  const t = today();
  switch (state) {
    case 'SUSPENDED':
    case 'REVOKED':
      return eq(professionalLicences.status, state);
    case 'EXPIRED':
      return and(
        eq(professionalLicences.status, 'ACTIVE'),
        sql`${professionalLicences.validUntil} < ${t}`,
      )!;
    case 'EXPIRING':
      return and(
        eq(professionalLicences.status, 'ACTIVE'),
        sql`${professionalLicences.validUntil} >= ${t}`,
        sql`${professionalLicences.validUntil} <= ${plusDays(t, EXPIRY_WARNING_DAYS)}`,
      )!;
    case 'VALID':
      return and(
        eq(professionalLicences.status, 'ACTIVE'),
        sql`${professionalLicences.validUntil} >= ${t}`,
      )!;
  }
}

const withAccount = {
  licence: professionalLicences,
  account: {
    id: users.id,
    fullName: users.fullName,
    email: users.email,
    role: users.role,
    facilityName: facilities.name,
  },
};

async function loadLicence(id: string) {
  const [row] = await db
    .select(withAccount)
    .from(professionalLicences)
    .leftJoin(users, eq(users.id, professionalLicences.userId))
    .leftJoin(facilities, eq(facilities.id, users.facilityId))
    .where(eq(professionalLicences.id, id));
  if (!row) throw notFound('Licence not found');
  return { ...describeLicence(row.licence), account: row.account?.id ? row.account : null };
}

const changed = (
  req: Request,
  ctx: AuthContext,
  licenceId: string,
  metadata: Record<string, unknown>,
  tx: Parameters<typeof audit>[1],
) =>
  audit(
    {
      action: AuditAction.LICENCE_CHANGED,
      actor: ctx,
      resourceType: 'professional_licence',
      resourceId: licenceId,
      meta: requestMeta(req),
      metadata,
    },
    tx,
  );

/* --------------------------------------------------------------------------- own licence -- */

/** The signed-in clinician's own licence (account page). */
licencesRouter.get('/me', async (req, res) => {
  const ctx = requireAuth(req);
  const [l] = await db
    .select()
    .from(professionalLicences)
    .where(eq(professionalLicences.userId, ctx.userId));
  res.json({
    required: Boolean(LICENSED_ROLES[ctx.role]),
    licence: l ? describeLicence(l) : null,
  });
});

/* ------------------------------------------------------------------ director: facility -- */

/**
 * Clinical staff of a facility with their licence state (directors: own facility; Ministry: any
 * facility with ?facilityId=).
 */
licencesRouter.get('/facility', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { facilityId: requested } = parse(
    z.object({ facilityId: z.string().uuid().optional() }),
    req.query,
  );
  const facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId! : requested;
  if (!facilityId) throw badRequest('facilityId is required');
  const staff = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      role: users.role,
      specialty: users.specialty,
      licenseNumber: users.licenseNumber,
      isActive: users.isActive,
      licence: professionalLicences,
    })
    .from(users)
    .leftJoin(professionalLicences, eq(professionalLicences.userId, users.id))
    .where(
      and(
        eq(users.facilityId, facilityId),
        inArray(users.role, Object.keys(LICENSED_ROLES) as ('DOCTOR' | 'NURSE' | 'PHARMACIST')[]),
      ),
    )
    .orderBy(asc(users.role), asc(users.fullName));
  const t = today();
  // Unlinked register entries whose number equals the one on the account (a director may link
  // them when the names match too).
  const numbers = staff
    .filter((s) => !s.licence && s.licenseNumber)
    .map((s) => s.licenseNumber!.trim());
  const candidates = numbers.length
    ? await db
        .select()
        .from(professionalLicences)
        .where(
          and(
            inArray(professionalLicences.licenceNumber, numbers),
            isNull(professionalLicences.userId),
          ),
        )
    : [];
  const byNumber = new Map(candidates.map((c) => [c.licenceNumber, c]));
  const items = staff.map((s) => {
    const licence = s.licence ? describeLicence(s.licence, t) : null;
    const candidate =
      !licence && s.licenseNumber ? byNumber.get(s.licenseNumber.trim()) : undefined;
    return {
      id: s.id,
      fullName: s.fullName,
      email: s.email,
      role: s.role,
      specialty: s.specialty,
      licenseNumber: s.licenseNumber,
      isActive: s.isActive,
      state: licence
        ? licence.expiringSoon
          ? 'EXPIRING'
          : licence.effectiveStatus
        : ('MISSING' as const),
      licence,
      linkCandidate:
        candidate &&
        professionMatchesRole(candidate.profession, s.role) &&
        namesMatch(candidate.holderName, s.fullName)
          ? {
              id: candidate.id,
              licenceNumber: candidate.licenceNumber,
              holderName: candidate.holderName,
            }
          : null,
    };
  });
  const summary: Record<string, number> = {
    VALID: 0,
    EXPIRING: 0,
    EXPIRED: 0,
    SUSPENDED: 0,
    REVOKED: 0,
    MISSING: 0,
  };
  for (const i of items) summary[i.state] = (summary[i.state] ?? 0) + 1;
  res.json({ items, summary, expiryWarningDays: EXPIRY_WARNING_DAYS });
});

/* ----------------------------------------------------------------------- linking -- */

licencesRouter.post('/:id/link', requireRole('MINISTRY', 'DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { userId } = parse(LinkInput, req.body);
  const result = await db.transaction(async (tx) => {
    const [l] = await tx
      .select()
      .from(professionalLicences)
      .where(eq(professionalLicences.id, id))
      .for('update');
    if (!l) throw notFound('Licence not found');
    const [account] = await tx
      .select({
        id: users.id,
        role: users.role,
        fullName: users.fullName,
        facilityId: users.facilityId,
        licenseNumber: users.licenseNumber,
      })
      .from(users)
      .where(eq(users.id, userId));
    if (!account) throw notFound('Staff account not found');
    if (ctx.role === 'DIRECTOR') {
      // Directors link only their own staff, and only the licence that the account names.
      if (account.facilityId !== ctx.facilityId) throw notFound('Staff account not found');
      if ((account.licenseNumber ?? '').trim() !== l.licenceNumber) {
        throw forbidden(
          'The licence number on the account differs from the register. Ask the Ministry to link it.',
        );
      }
      if (!namesMatch(l.holderName, account.fullName)) {
        throw forbidden(
          'The name in the register differs from the account. Ask the Ministry to link it.',
        );
      }
    }
    if (!LICENSED_ROLES[account.role]) {
      throw badRequest('Only doctors, nurses and pharmacists hold professional licences');
    }
    if (!professionMatchesRole(l.profession, account.role)) {
      throw badRequest(
        `A ${l.profession.toLowerCase()} licence cannot be linked to a ${account.role.toLowerCase()} account`,
      );
    }
    if (l.userId === account.id) return l;
    if (l.userId) throw conflict('This licence is already linked to another account');
    const [other] = await tx
      .select({ id: professionalLicences.id })
      .from(professionalLicences)
      .where(eq(professionalLicences.userId, account.id));
    if (other) throw conflict('This account is already linked to another licence');
    const [updated] = await tx
      .update(professionalLicences)
      .set({ userId: account.id })
      .where(eq(professionalLicences.id, id))
      .returning();
    await changed(req, ctx, id, { change: 'linked', userId: account.id }, tx);
    return updated!;
  });
  clearLicenceCache(userId);
  res.json(describeLicence(result));
});

licencesRouter.post('/:id/unlink', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(ReasonInput, req.body);
  const previous = await db.transaction(async (tx) => {
    const [l] = await tx
      .select()
      .from(professionalLicences)
      .where(eq(professionalLicences.id, id))
      .for('update');
    if (!l) throw notFound('Licence not found');
    if (!l.userId) throw conflict('This licence is not linked to an account');
    await tx
      .update(professionalLicences)
      .set({ userId: null })
      .where(eq(professionalLicences.id, id));
    await changed(req, ctx, id, { change: 'unlinked', userId: l.userId, reason }, tx);
    return l.userId;
  });
  clearLicenceCache(previous);
  res.json(await loadLicence(id));
});

/* --------------------------------------------------------------- Ministry: register -- */

licencesRouter.use(requireRole('MINISTRY'));

licencesRouter.get('/', async (req, res) => {
  const q = parse(ListQuery, req.query);
  const filters: SQL[] = [];
  if (q.q) {
    filters.push(
      or(
        ilike(professionalLicences.holderName, `%${q.q}%`),
        ilike(professionalLicences.licenceNumber, `%${q.q}%`),
        ilike(professionalLicences.specialty, `%${q.q}%`),
      )!,
    );
  }
  if (q.profession) filters.push(eq(professionalLicences.profession, q.profession));
  if (q.state) filters.push(stateFilter(q.state));
  if (q.linked === 'yes') filters.push(isNotNull(professionalLicences.userId));
  if (q.linked === 'no') filters.push(isNull(professionalLicences.userId));
  const where = filters.length ? and(...filters) : undefined;
  const { limit, offset } = toOffset(q);
  const [rows, [total]] = await Promise.all([
    db
      .select(withAccount)
      .from(professionalLicences)
      .leftJoin(users, eq(users.id, professionalLicences.userId))
      .leftJoin(facilities, eq(facilities.id, users.facilityId))
      .where(where)
      .orderBy(asc(professionalLicences.holderName))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(professionalLicences).where(where),
  ]);
  const t = today();
  res.json(
    paginated(
      rows.map((r) => ({
        ...describeLicence(r.licence, t),
        account: r.account?.id ? r.account : null,
      })),
      total?.total ?? 0,
      q,
    ),
  );
});

/** Counts by profession and state, plus licences expiring soon (no other details). */
licencesRouter.get('/stats', async (_req, res) => {
  const t = today();
  const soon = plusDays(t, EXPIRY_WARNING_DAYS);
  const rows = await db.execute<{ profession: string; state: string; n: number }>(sql`
    SELECT profession,
      CASE
        WHEN status <> 'ACTIVE' THEN status
        WHEN valid_until < ${t} THEN 'EXPIRED'
        WHEN valid_until <= ${soon} THEN 'EXPIRING'
        ELSE 'VALID'
      END AS state,
      count(*)::int AS n
    FROM professional_licences GROUP BY 1, 2`);
  const [linked] = await db
    .select({ n: count() })
    .from(professionalLicences)
    .where(isNotNull(professionalLicences.userId));
  const unlicensed = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM users u
    WHERE u.role IN ('DOCTOR', 'NURSE', 'PHARMACIST') AND u.is_active
      AND NOT EXISTS (SELECT 1 FROM professional_licences l WHERE l.user_id = u.id)`);
  const expiring = await db
    .select({
      id: professionalLicences.id,
      licenceNumber: professionalLicences.licenceNumber,
      holderName: professionalLicences.holderName,
      profession: professionalLicences.profession,
      validUntil: professionalLicences.validUntil,
    })
    .from(professionalLicences)
    .where(stateFilter('EXPIRING'))
    .orderBy(asc(professionalLicences.validUntil))
    .limit(50);
  res.json({
    byProfession: PROFESSIONS.map((p) => {
      const counts = { VALID: 0, EXPIRING: 0, EXPIRED: 0, SUSPENDED: 0, REVOKED: 0 } as Record<
        string,
        number
      >;
      for (const r of rows.rows.filter((r) => r.profession === p)) counts[r.state] = r.n;
      return { profession: p, ...counts };
    }),
    linked: linked?.n ?? 0,
    clinicalAccountsWithoutLicence: unlicensed.rows[0]?.n ?? 0,
    expiring: expiring.map((e) => ({ ...e, daysToExpiry: daysBetween(t, e.validUntil) })),
    expiryWarningDays: EXPIRY_WARNING_DAYS,
  });
});

/** Clinical accounts without a licence, for the Ministry's link dialog. */
licencesRouter.get('/accounts', async (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
  const rows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      email: users.email,
      role: users.role,
      licenseNumber: users.licenseNumber,
      facilityName: facilities.name,
      linkedLicenceId: professionalLicences.id,
    })
    .from(users)
    .leftJoin(facilities, eq(facilities.id, users.facilityId))
    .leftJoin(professionalLicences, eq(professionalLicences.userId, users.id))
    .where(
      and(
        inArray(users.role, ['DOCTOR', 'NURSE', 'PHARMACIST']),
        or(
          ilike(users.fullName, `%${q}%`),
          ilike(users.email, `%${q}%`),
          ilike(users.licenseNumber, `%${q}%`),
        ),
      ),
    )
    .orderBy(asc(users.fullName))
    .limit(20);
  res.json({ items: rows });
});

licencesRouter.post('/', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(LicenceInput, req.body);
  const created = await db.transaction(async (tx) => {
    const [exists] = await tx
      .select({ id: professionalLicences.id })
      .from(professionalLicences)
      .where(eq(professionalLicences.licenceNumber, input.licenceNumber));
    if (exists) throw conflict('A licence with this number is already in the register');
    const [row] = await tx
      .insert(professionalLicences)
      .values({
        ...input,
        specialty: input.specialty ?? null,
        cpdCredits: input.cpdCredits ?? 0,
        createdById: ctx.userId,
      })
      .returning();
    await changed(req, ctx, row!.id, { change: 'created' }, tx);
    return row!;
  });
  res.status(201).json(describeLicence(created));
});

licencesRouter.post('/import', async (req, res) => {
  const ctx = requireAuth(req);
  const { csv, dryRun } = parse(ImportInput, req.body);
  const { rows, errors } = validateCsv(csv);
  if (rows.length > 2000) throw badRequest('Import at most 2000 licences at a time');
  const existing = rows.length
    ? await db
        .select({
          licenceNumber: professionalLicences.licenceNumber,
          profession: professionalLicences.profession,
        })
        .from(professionalLicences)
        .where(
          inArray(
            professionalLicences.licenceNumber,
            rows.map((r) => r.licenceNumber),
          ),
        )
    : [];
  const known = new Map(existing.map((e) => [e.licenceNumber, e]));
  const ok = rows.filter((r) => {
    const e = known.get(r.licenceNumber);
    if (e && e.profession !== r.profession) {
      errors.push({
        line: r.line,
        message: 'the register has this number for another profession',
      });
      return false;
    }
    return true;
  });
  const summary = {
    dryRun,
    create: ok.filter((r) => !known.has(r.licenceNumber)).length,
    update: ok.filter((r) => known.has(r.licenceNumber)).length,
    errors: errors.sort((a, b) => a.line - b.line),
  };
  if (dryRun || !ok.length) {
    res.json(summary);
    return;
  }
  await db.transaction(async (tx) => {
    for (const { line: _line, ...r } of ok) {
      await tx
        .insert(professionalLicences)
        .values({ ...r, createdById: ctx.userId })
        .onConflictDoUpdate({
          target: professionalLicences.licenceNumber,
          set: {
            holderName: r.holderName,
            specialty: r.specialty,
            issuedBy: r.issuedBy,
            issuedOn: r.issuedOn,
            validUntil: r.validUntil,
            cpdCredits: r.cpdCredits,
          },
        });
    }
    await audit(
      {
        action: AuditAction.LICENCE_CHANGED,
        actor: ctx,
        resourceType: 'professional_licence',
        meta: requestMeta(req),
        metadata: { change: 'imported', created: summary.create, updated: summary.update },
      },
      tx,
    );
  });
  clearLicenceCache();
  res.json(summary);
});

licencesRouter.get('/:id', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  res.json(await loadLicence(id));
});

licencesRouter.patch('/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const input = parse(LicenceUpdate, req.body);
  const userId = await db.transaction(async (tx) => {
    const [l] = await tx
      .select()
      .from(professionalLicences)
      .where(eq(professionalLicences.id, id))
      .for('update');
    if (!l) throw notFound('Licence not found');
    const next = {
      ...l,
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
    };
    if (next.validUntil < next.issuedOn) {
      throw badRequest('The licence cannot expire before it was issued');
    }
    if (input.profession && l.userId) {
      const [account] = await tx
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, l.userId));
      if (account && !professionMatchesRole(input.profession, account.role)) {
        throw badRequest('The new profession does not fit the linked account. Unlink it first.');
      }
    }
    await tx.update(professionalLicences).set(input).where(eq(professionalLicences.id, id));
    await changed(
      req,
      ctx,
      id,
      {
        change: 'updated',
        fields: Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined),
      },
      tx,
    );
    return l.userId;
  });
  clearLicenceCache(userId);
  res.json(await loadLicence(id));
});

licencesRouter.post('/:id/status', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { status, reason } = parse(StatusInput, req.body);
  const licence = await db.transaction(async (tx) => {
    const [l] = await tx
      .select()
      .from(professionalLicences)
      .where(eq(professionalLicences.id, id))
      .for('update');
    if (!l) throw notFound('Licence not found');
    if (l.status === status) throw conflict('The licence already has this status');
    if (l.status === 'REVOKED' && status !== 'REVOKED') {
      // A revoked licence is reinstated only by issuing a new one, never by reopening it.
      throw conflict('A revoked licence cannot be reinstated; register a new licence instead');
    }
    await tx
      .update(professionalLicences)
      .set({ status, statusReason: reason })
      .where(eq(professionalLicences.id, id));
    await changed(req, ctx, id, { change: 'status', from: l.status, to: status, reason }, tx);
    await notifyStatusChange(l, status, tx);
    return l;
  });
  clearLicenceCache(licence.userId);
  res.json(await loadLicence(id));
});

/** Latest licence changes (audit) for the detail view. */
licencesRouter.get('/:id/history', async (req, res) => {
  const { id } = parse(IdParam, req.params);
  const rows = await db.execute<{
    occurred_at: string;
    actor: string | null;
    metadata: Record<string, unknown> | null;
  }>(sql`
    SELECT a.occurred_at, u.full_name AS actor, a.metadata
    FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
    WHERE a.resource_type = 'professional_licence' AND a.resource_id = ${id}
      AND a.action = ${AuditAction.LICENCE_CHANGED}
    ORDER BY a.occurred_at DESC LIMIT 50`);
  res.json({
    items: rows.rows.map((r) => ({ at: r.occurred_at, actor: r.actor, ...(r.metadata ?? {}) })),
  });
});
