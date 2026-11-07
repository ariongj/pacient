import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { and, eq, inArray, isNotNull, like, lte, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { notifications, professionalLicences, users, type Role } from '../../db/schema.js';
import { env, isTest } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { AuditAction, auditSafe } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/**
 * National register of professional licences (doctors, dentists, nurses, midwives, pharmacists).
 *
 * Enforcement: clinical WRITE actions of doctors, nurses and pharmacists (assertClinicalWriteAccess)
 * require a linked licence that is ACTIVE and not past its validUntil date. Reading a record is never
 * blocked by a licence problem – a clinician must still be able to see a patient in an emergency,
 * and every read is audited anyway. LICENCE_ENFORCEMENT: on (refuse with 403 LICENCE_INVALID),
 * warn (allow, add an X-Licence-Warning header and log) or off.
 */

export const PROFESSIONS = ['PHYSICIAN', 'DENTIST', 'NURSE', 'MIDWIFE', 'PHARMACIST'] as const;
export type Profession = (typeof PROFESSIONS)[number];
export const LICENCE_STATUSES = ['ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export type LicenceStatus = (typeof LICENCE_STATUSES)[number];
/** What a licence means today: VALID, EXPIRED (past validUntil), SUSPENDED or REVOKED. */
export type EffectiveStatus = 'VALID' | 'EXPIRED' | 'SUSPENDED' | 'REVOKED';

/** Roles whose clinical work needs a licence, and the professions that license each role. */
export const LICENSED_ROLES: Partial<Record<Role, Profession[]>> = {
  DOCTOR: ['PHYSICIAN', 'DENTIST'],
  NURSE: ['NURSE', 'MIDWIFE'],
  PHARMACIST: ['PHARMACIST'],
};
export const professionMatchesRole = (profession: string, role: Role) =>
  (LICENSED_ROLES[role] ?? []).includes(profession as Profession);

/** Days before expiry when the holder and their director are reminded. */
export const EXPIRY_WARNING_DAYS = 60;
export const REMINDER_DAYS = [60, 30, 7] as const;

export const todayIso = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

export const daysBetween = (fromIso: string, toIso: string) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

export function effectiveStatus(
  l: { status: string; validUntil: string },
  today = todayIso(),
): EffectiveStatus {
  if (l.status === 'REVOKED') return 'REVOKED';
  if (l.status === 'SUSPENDED') return 'SUSPENDED';
  return l.validUntil < today ? 'EXPIRED' : 'VALID';
}

/** Public/derived view of a licence row. */
export function describeLicence(
  l: typeof professionalLicences.$inferSelect,
  today = todayIso(),
): typeof l & { effectiveStatus: EffectiveStatus; daysToExpiry: number; expiringSoon: boolean } {
  const state = effectiveStatus(l, today);
  const daysToExpiry = daysBetween(today, l.validUntil);
  return {
    ...l,
    effectiveStatus: state,
    daysToExpiry,
    expiringSoon: state === 'VALID' && daysToExpiry <= EXPIRY_WARNING_DAYS,
  };
}

/** Loose name match for directors linking their own staff: same words, ignoring case and accents. */
export function namesMatch(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set(
      s
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .replace(/\b(dr|mr|mrs|ms|prof)\b\.?/g, ' ')
        .split(/[^a-z]+/)
        .filter((w) => w.length > 1),
    );
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return false;
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  return [...small].every((w) => large.has(w));
}

/* -------------------------------------------------------------------------- enforcement -- */

export type EnforcementMode = 'on' | 'warn' | 'off';
let modeOverride: EnforcementMode | undefined;
/** Tests switch the mode at runtime (env is read once at start). */
export function setLicenceEnforcementForTests(mode: EnforcementMode | undefined) {
  modeOverride = mode;
}
export const enforcementMode = (): EnforcementMode => modeOverride ?? env.LICENCE_ENFORCEMENT;

const CACHE_MS = 60_000;
const cache = new Map<string, { state: EffectiveStatus | 'MISSING'; at: number }>();
/** Called whenever a licence changes so enforcement never acts on stale data. */
export function clearLicenceCache(userId?: string | null) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

export async function licenceStateOfUser(userId: string): Promise<EffectiveStatus | 'MISSING'> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.state;
  const [l] = await db
    .select({ status: professionalLicences.status, validUntil: professionalLicences.validUntil })
    .from(professionalLicences)
    .where(eq(professionalLicences.userId, userId));
  const state = l ? effectiveStatus(l) : 'MISSING';
  cache.set(userId, { state, at: Date.now() });
  return state;
}

const MESSAGES: Record<Exclude<EffectiveStatus, 'VALID'> | 'MISSING', string> = {
  MISSING:
    'Your account is not linked to a professional licence. Ask your director or the Ministry to link your licence before making clinical entries.',
  EXPIRED:
    'Your professional licence has expired. Clinical entries are blocked until the licence is renewed.',
  SUSPENDED:
    'Your professional licence is suspended. Clinical entries are blocked while the suspension lasts.',
  REVOKED: 'Your professional licence has been revoked. Clinical entries are not allowed.',
};

/** Response holder for the warning header (warn mode); see licenceWarnings(). */
const responseStore = new AsyncLocalStorage<Response>();
/** Middleware: lets the licence check add an X-Licence-Warning header in warn mode. */
export function licenceWarnings(_req: Request, res: Response, next: NextFunction) {
  responseStore.run(res, next);
}

const recentlyAudited = new Map<string, number>();
const AUDIT_EVERY_MS = 60 * 60_000;

/**
 * Throws 403 LICENCE_INVALID (mode on) when a doctor, nurse or pharmacist without a valid licence
 * makes a clinical entry. Returns the state that was found ('VALID' for unlicensed roles).
 */
export async function assertLicensed(
  ctx: Pick<AuthContext, 'userId' | 'role' | 'facilityId'>,
  meta?: RequestMeta,
): Promise<EffectiveStatus | 'MISSING'> {
  const mode = enforcementMode();
  if (mode === 'off' || !LICENSED_ROLES[ctx.role]) return 'VALID';
  const state = await licenceStateOfUser(ctx.userId);
  if (state === 'VALID') return state;
  if (mode === 'warn') {
    const res = responseStore.getStore();
    if (res && !res.headersSent) res.setHeader('X-Licence-Warning', state);
    logger.warn(
      { userId: ctx.userId, state },
      'Clinical entry without a valid licence (warn mode)',
    );
    return state;
  }
  // At most one audit entry per user and hour, so repeated attempts do not flood the log.
  const last = recentlyAudited.get(ctx.userId) ?? 0;
  if (Date.now() - last > AUDIT_EVERY_MS) {
    recentlyAudited.set(ctx.userId, Date.now());
    if (recentlyAudited.size > 10_000) recentlyAudited.clear();
    await auditSafe({
      action: AuditAction.LICENCE_CHECK_FAILED,
      actor: ctx,
      resourceType: 'professional_licence',
      outcome: 'DENIED',
      meta,
      metadata: { state },
    });
  }
  throw new HttpError(403, 'LICENCE_INVALID', MESSAGES[state], { state });
}

/** Tests only: forget which users were audited recently. */
export function resetLicenceAuditMemory() {
  recentlyAudited.clear();
}

/* -------------------------------------------------------------------------------- CSV -- */

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export const CSV_COLUMNS = [
  'licenceNumber',
  'holderName',
  'profession',
  'specialty',
  'issuedBy',
  'issuedOn',
  'validUntil',
  'cpdCredits',
] as const;

export interface ImportRow {
  licenceNumber: string;
  holderName: string;
  profession: Profession;
  specialty: string | null;
  issuedBy: string;
  issuedOn: string;
  validUntil: string;
  cpdCredits: number;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => ISO_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Validates CSV text: returns the rows that can be imported and per-line errors (1-based lines). */
export function validateCsv(text: string): {
  rows: (ImportRow & { line: number })[];
  errors: { line: number; message: string }[];
} {
  const table = parseCsv(text.replace(/^\uFEFF/, ''));
  const errors: { line: number; message: string }[] = [];
  const rows: (ImportRow & { line: number })[] = [];
  if (!table.length) return { rows, errors: [{ line: 1, message: 'The file is empty' }] };
  const header = table[0]!.map((h) => h.trim());
  const index = Object.fromEntries(CSV_COLUMNS.map((c) => [c, header.indexOf(c)]));
  const missing = CSV_COLUMNS.filter((c) => c !== 'specialty' && c !== 'cpdCredits').filter(
    (c) => index[c]! < 0,
  );
  if (missing.length) {
    return { rows, errors: [{ line: 1, message: `Missing columns: ${missing.join(', ')}` }] };
  }
  const seen = new Set<string>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (c: (typeof CSV_COLUMNS)[number]) =>
      index[c]! >= 0 ? (cells[index[c]!] ?? '').trim() : '';
    const problems: string[] = [];
    const licenceNumber = get('licenceNumber');
    const holderName = get('holderName');
    const profession = get('profession').toUpperCase();
    const issuedOn = get('issuedOn');
    const validUntil = get('validUntil');
    const cpd = get('cpdCredits');
    if (!/^[A-Za-z0-9/_.-]{3,40}$/.test(licenceNumber)) problems.push('invalid licence number');
    else if (seen.has(licenceNumber)) problems.push('licence number repeated in the file');
    if (holderName.length < 3 || holderName.length > 200) problems.push('invalid holder name');
    if (!(PROFESSIONS as readonly string[]).includes(profession)) {
      problems.push(`profession must be one of ${PROFESSIONS.join(', ')}`);
    }
    if (get('issuedBy').length < 3) problems.push('issuing body missing');
    if (!validDate(issuedOn)) problems.push('issuedOn must be YYYY-MM-DD');
    if (!validDate(validUntil)) problems.push('validUntil must be YYYY-MM-DD');
    else if (validDate(issuedOn) && validUntil < issuedOn) {
      problems.push('validUntil is before issuedOn');
    }
    if (cpd && !/^\d{1,4}$/.test(cpd)) problems.push('cpdCredits must be a whole number');
    if (problems.length) {
      errors.push({ line, message: problems.join('; ') });
      return;
    }
    seen.add(licenceNumber);
    rows.push({
      line,
      licenceNumber,
      holderName,
      profession: profession as Profession,
      specialty: get('specialty') || null,
      issuedBy: get('issuedBy'),
      issuedOn,
      validUntil,
      cpdCredits: cpd ? Number(cpd) : 0,
    });
  });
  return { rows, errors };
}

/* ------------------------------------------------------------------------------ linking -- */

/**
 * On invitation of a doctor, nurse or pharmacist: link the register entry with the same number
 * when it is unlinked, the profession fits the role and the holder's name matches the account.
 */
export async function autoLinkOnInvite(
  tx: Executor,
  account: { id: string; role: Role; fullName: string; licenseNumber?: string | null },
): Promise<boolean> {
  if (!account.licenseNumber || !LICENSED_ROLES[account.role]) return false;
  const [l] = await tx
    .select()
    .from(professionalLicences)
    .where(eq(professionalLicences.licenceNumber, account.licenseNumber.trim()));
  if (
    !l ||
    l.userId ||
    !professionMatchesRole(l.profession, account.role) ||
    !namesMatch(l.holderName, account.fullName)
  ) {
    return false;
  }
  await tx
    .update(professionalLicences)
    .set({ userId: account.id })
    .where(eq(professionalLicences.id, l.id));
  clearLicenceCache(account.id);
  return true;
}

/* ------------------------------------------------------------------------------- worker -- */

const REMINDER_TYPE = 'licence.expiry';
type Stage = '60' | '30' | '7' | 'expired';

function stageFor(daysToExpiry: number): Stage | null {
  if (daysToExpiry < 0) return 'expired';
  if (daysToExpiry <= 7) return '7';
  if (daysToExpiry <= 30) return '30';
  if (daysToExpiry <= 60) return '60';
  return null;
}

/**
 * Reminds licence holders (and the directors of their facility) 60, 30 and 7 days before their
 * licence expires and when it has expired – once per stage and licence period. The dedupe key is
 * part of the notification link, so no extra table is needed; renewing the licence (a new
 * validUntil) starts a new series.
 */
export async function runLicenceRemindersOnce(now = new Date()): Promise<number> {
  const today = todayIso(now);
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 60 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const recentlyExpired = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const due = await db
    .select({
      id: professionalLicences.id,
      userId: professionalLicences.userId,
      holderName: professionalLicences.holderName,
      validUntil: professionalLicences.validUntil,
      facilityId: users.facilityId,
    })
    .from(professionalLicences)
    .innerJoin(users, eq(users.id, professionalLicences.userId))
    .where(
      and(
        eq(professionalLicences.status, 'ACTIVE'),
        isNotNull(professionalLicences.userId),
        lte(professionalLicences.validUntil, horizon),
        sql`${professionalLicences.validUntil} >= ${recentlyExpired}`,
        eq(users.isActive, true),
      ),
    );
  let sent = 0;
  for (const l of due) {
    const stage = stageFor(daysBetween(today, l.validUntil));
    if (!stage) continue;
    const key = `lr=${l.id}:${stage}:${l.validUntil}`;
    const delivered = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
      const [already] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.type, REMINDER_TYPE), like(notifications.link, `%${key}%`)))
        .limit(1);
      if (already) return false;
      const date = new Date(`${l.validUntil}T12:00:00Z`);
      await notifyUsers(
        [l.userId],
        {
          type: REMINDER_TYPE,
          title:
            stage === 'expired'
              ? 'Your professional licence has expired'
              : 'Your professional licence expires on {date}',
          body: 'Renew it with your professional chamber. Clinical entries are blocked without a valid licence.',
          vars: { date },
          link: `/account?${key}`,
          important: true,
        },
        tx,
      );
      if (l.facilityId) {
        const directors = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(
              eq(users.facilityId, l.facilityId),
              eq(users.role, 'DIRECTOR'),
              eq(users.isActive, true),
            ),
          );
        await notifyUsers(
          directors.map((d) => d.id),
          {
            type: REMINDER_TYPE,
            title:
              stage === 'expired'
                ? 'A staff licence has expired: {name}'
                : 'A staff licence expires on {date}: {name}',
            vars: { date, name: l.holderName },
            link: `/licences?${key}`,
          },
          tx,
        );
      }
      return true;
    });
    if (delivered) sent++;
  }
  return sent;
}

/** Holder and directors are told when a licence is suspended, revoked or reinstated. */
export async function notifyStatusChange(
  licence: { userId: string | null; holderName: string },
  status: LicenceStatus,
  executor: Executor = db,
) {
  if (!licence.userId) return;
  const title =
    status === 'ACTIVE'
      ? 'Your professional licence is valid again'
      : status === 'SUSPENDED'
        ? 'Your professional licence has been suspended'
        : 'Your professional licence has been revoked';
  await notifyUsers(
    [licence.userId],
    { type: 'licence.status', title, link: '/account', important: true },
    executor,
  );
  const [holder] = await executor
    .select({ facilityId: users.facilityId })
    .from(users)
    .where(eq(users.id, licence.userId));
  if (!holder?.facilityId) return;
  const directors = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.facilityId, holder.facilityId),
        eq(users.role, 'DIRECTOR'),
        eq(users.isActive, true),
      ),
    );
  await notifyUsers(
    directors.map((d) => d.id),
    {
      type: 'licence.status',
      title:
        status === 'ACTIVE'
          ? 'A staff licence is valid again: {name}'
          : 'A staff licence was suspended or revoked: {name}',
      vars: { name: licence.holderName },
      link: '/licences',
    },
    executor,
  );
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

function runSafely() {
  runLicenceRemindersOnce().then(
    (n) => n && logger.info({ reminders: n }, 'Licence expiry reminders sent'),
    (err: unknown) => logger.error({ err }, 'Licence reminder worker failed'),
  );
}

/** Daily (first run ten minutes after start). Not started in tests. */
export function startLicencesWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 10 * 60_000);
  first.unref();
  timer = setInterval(runSafely, 24 * 60 * 60_000);
  timer.unref();
}

export function stopLicencesWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}

/** Licences of a set of users (for staff lists). */
export async function licencesOfUsers(userIds: string[]) {
  if (!userIds.length) return new Map<string, ReturnType<typeof describeLicence>>();
  const rows = await db
    .select()
    .from(professionalLicences)
    .where(inArray(professionalLicences.userId, userIds));
  const today = todayIso();
  return new Map(rows.map((r) => [r.userId!, describeLicence(r, today)]));
}
