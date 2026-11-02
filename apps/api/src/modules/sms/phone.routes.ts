import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { and, count, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { phoneVerifications, users } from '../../db/schema.js';
import { badRequest, tooManyRequests } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { maskPhone, normalizePhone } from '../../lib/phone.js';
import { authenticate } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rate-limit.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { enqueueSms } from './outbox.js';
import { toLocale, tr } from '../../i18n/index.js';

/**
 * Mobile number registration for SMS notifications. A number is only used after its owner proves
 * possession with a 6-digit code (10-minute expiry, 5 attempts, 3 codes per hour).
 */
const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 3;

const hashCode = (userId: string, code: string) =>
  createHash('sha256').update(`${userId}:${code}`).digest('hex');

export const phoneRouter = Router();
phoneRouter.use(authenticate);

phoneRouter.post('/', authLimiter, async (req, res) => {
  const ctx = requireAuth(req);
  const { phone: raw } = parse(z.object({ phone: z.string().trim().min(6).max(30) }), req.body);
  const phone = normalizePhone(raw);
  if (!phone) throw badRequest('Enter a valid mobile number, e.g. +383 44 123 456');

  const [recent] = await db
    .select({ n: count() })
    .from(phoneVerifications)
    .where(
      and(
        eq(phoneVerifications.userId, ctx.userId),
        gt(phoneVerifications.createdAt, new Date(Date.now() - 3_600_000)),
      ),
    );
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR)
    throw tooManyRequests('Too many codes requested. Try again later.');

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const [me] = await db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, ctx.userId));
  await db.transaction(async (tx) => {
    await tx.insert(phoneVerifications).values({
      userId: ctx.userId,
      phone,
      codeHash: hashCode(ctx.userId, code),
      expiresAt: new Date(Date.now() + CODE_TTL_MINUTES * 60_000),
    });
    await enqueueSms(tx, {
      to: phone,
      userId: ctx.userId,
      template: 'phone_verification',
      body: tr(
        toLocale(me?.locale),
        'Pacient verification code: {code}. It expires in {minutes} minutes. Never share this code.',
        { code, minutes: CODE_TTL_MINUTES },
      ),
      urgent: true,
    });
  });
  res.status(202).json({ phone: maskPhone(phone), expiresInMinutes: CODE_TTL_MINUTES });
});

phoneRouter.post('/verify', authLimiter, async (req, res) => {
  const ctx = requireAuth(req);
  const { code } = parse(
    z.object({
      code: z
        .string()
        .trim()
        .regex(/^\d{6}$/, 'Enter the 6-digit code'),
    }),
    req.body,
  );
  const [pending] = await db
    .select()
    .from(phoneVerifications)
    .where(
      and(
        eq(phoneVerifications.userId, ctx.userId),
        isNull(phoneVerifications.verifiedAt),
        gt(phoneVerifications.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(phoneVerifications.createdAt))
    .limit(1);
  if (!pending || pending.attempts >= MAX_ATTEMPTS) {
    throw badRequest('The code has expired or too many attempts were made. Request a new code.');
  }
  const ok = timingSafeEqual(
    Buffer.from(hashCode(ctx.userId, code)),
    Buffer.from(pending.codeHash),
  );
  if (!ok) {
    await db
      .update(phoneVerifications)
      .set({ attempts: pending.attempts + 1 })
      .where(eq(phoneVerifications.id, pending.id));
    throw badRequest('The code is not correct');
  }
  await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(phoneVerifications)
      .set({ verifiedAt: now })
      .where(eq(phoneVerifications.id, pending.id));
    await tx
      .update(users)
      .set({ phone: pending.phone, phoneVerifiedAt: now, smsNotifications: 'IMPORTANT' })
      .where(eq(users.id, ctx.userId));
    await audit(
      {
        action: AuditAction.PHONE_VERIFIED,
        actor: ctx,
        resourceType: 'user',
        resourceId: ctx.userId,
        meta: requestMeta(req),
      },
      tx,
    );
  });
  res.json({ phone: maskPhone(pending.phone), smsNotifications: 'IMPORTANT' });
});

phoneRouter.delete('/', async (req, res) => {
  const ctx = requireAuth(req);
  await db
    .update(users)
    .set({ phone: null, phoneVerifiedAt: null, smsNotifications: 'OFF' })
    .where(eq(users.id, ctx.userId));
  await audit({
    action: AuditAction.PHONE_REMOVED,
    actor: ctx,
    resourceType: 'user',
    resourceId: ctx.userId,
    meta: requestMeta(req),
  });
  res.status(204).end();
});
