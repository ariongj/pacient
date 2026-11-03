import { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import { isProd } from '../../config/env.js';
import { badRequest, unauthorized } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { PasswordSchema } from '../../lib/password.js';
import { authenticate } from '../../middleware/auth.js';
import { authLimiter, refreshLimiter } from '../../middleware/rate-limit.js';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { emailPreferenceEnum, smsPreferenceEnum, users } from '../../db/schema.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import * as auth from './auth.service.js';
import * as mfa from './mfa.service.js';

export const REFRESH_COOKIE = 'pacient_rt';

const cookieOptions = (expires?: Date): CookieOptions => ({
  httpOnly: true, // not readable by JavaScript -> immune to token theft via XSS
  secure: isProd,
  sameSite: 'strict', // never sent on cross-site requests -> CSRF protection
  path: '/api/v1/auth',
  ...(expires ? { expires } : {}),
});

export function sendSession(res: Response, session: auth.Session) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, cookieOptions(session.refreshTokenExpiresAt));
  res.json({ accessToken: session.accessToken, expiresIn: session.accessTokenExpiresIn });
}

const LoginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});

const ActivateSchema = z.object({
  token: z.string().min(20).max(200),
  password: PasswordSchema,
});

const CodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
const DisableSchema = CodeSchema.extend({ password: z.string().min(1).max(128) });
const ForgotSchema = z.object({ email: z.string().trim().email().max(254) });
const MfaVerifySchema = z
  .object({
    mfaToken: z.string().min(20).max(2000),
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/)
      .optional(),
    recoveryCode: z.string().trim().min(8).max(20).optional(),
  })
  .refine(
    (v) => Boolean(v.code) !== Boolean(v.recoveryCode),
    'Provide either a code or a recovery code',
  );

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: PasswordSchema,
});

export const authRouter = Router();

authRouter.post('/login', authLimiter, async (req, res) => {
  const { email, password } = parse(LoginSchema, req.body);
  const result = await auth.login(email, password, requestMeta(req));
  if (result.kind === 'mfa') {
    res.json({ mfaRequired: true, mfaToken: result.mfaToken, methods: result.methods });
    return;
  }
  sendSession(res, result.session);
});

/** Second step of sign-in for accounts with two-step verification. */
authRouter.post('/mfa/verify', authLimiter, async (req, res) => {
  const input = parse(MfaVerifySchema, req.body);
  sendSession(res, await mfa.completeMfaChallenge(input.mfaToken, input, requestMeta(req)));
});

authRouter.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = parse(ForgotSchema, req.body);
  await mfa.requestPasswordReset(email, requestMeta(req));
  res.status(202).json({
    message: 'If an account exists for this address, a reset link has been sent.',
  });
});

authRouter.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = parse(ActivateSchema, req.body);
  await mfa.resetPassword(token, password, requestMeta(req));
  res.status(204).end();
});

authRouter.post('/mfa/setup', authenticate, async (req, res) => {
  res.json(await mfa.beginEnrollment(requireAuth(req)));
});

authRouter.post('/mfa/enable', authenticate, authLimiter, async (req, res) => {
  const { code } = parse(CodeSchema, req.body);
  res.json(await mfa.confirmEnrollment(requireAuth(req), code, requestMeta(req)));
});

authRouter.post('/mfa/disable', authenticate, authLimiter, async (req, res) => {
  const { code, password } = parse(DisableSchema, req.body);
  await mfa.disableMfa(requireAuth(req), password, code, requestMeta(req));
  res.status(204).end();
});

authRouter.post('/mfa/recovery-codes', authenticate, authLimiter, async (req, res) => {
  const { code } = parse(CodeSchema, req.body);
  res.json(await mfa.regenerateRecoveryCodes(requireAuth(req), code, requestMeta(req)));
});

authRouter.post('/refresh', refreshLimiter, async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw unauthorized('No session');
  try {
    sendSession(res, await auth.refresh(token, requestMeta(req)));
  } catch (err) {
    res.clearCookie(REFRESH_COOKIE, cookieOptions());
    throw err;
  }
});

authRouter.post('/logout', async (req, res) => {
  await auth.logout(req.cookies?.[REFRESH_COOKIE], null, requestMeta(req));
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
  res.status(204).end();
});

authRouter.post('/activate', authLimiter, async (req, res) => {
  const { token, password } = parse(ActivateSchema, req.body);
  await auth.activateAccount(token, password, requestMeta(req));
  res.status(204).end();
});

authRouter.get('/me', authenticate, async (req, res) => {
  res.json(await auth.getProfile(requireAuth(req)));
});

/** Email notification preference: ALL, IMPORTANT only, or OFF (security emails are always sent). */
/**
 * Notification preferences. Email: ALL / IMPORTANT / OFF. SMS: IMPORTANT / OFF, and only with a
 * verified mobile number. Security emails (activation, password reset) are always sent.
 */
authRouter.patch('/me/preferences', authenticate, async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(
    z
      .object({
        emailNotifications: z.enum(emailPreferenceEnum.enumValues).optional(),
        smsNotifications: z.enum(smsPreferenceEnum.enumValues).optional(),
        locale: z.enum(['sq', 'en', 'sr']).optional(),
      })
      .refine((v) => v.emailNotifications || v.smsNotifications || v.locale, 'Nothing to change'),
    req.body,
  );
  if (input.smsNotifications === 'IMPORTANT') {
    const [u] = await db
      .select({ verified: users.phoneVerifiedAt })
      .from(users)
      .where(eq(users.id, ctx.userId));
    if (!u?.verified) throw badRequest('Verify a mobile number before turning on SMS');
  }
  await db.update(users).set(input).where(eq(users.id, ctx.userId));
  await audit({
    action: AuditAction.EMAIL_PREFERENCE_CHANGED,
    actor: ctx,
    resourceType: 'user',
    resourceId: ctx.userId,
    meta: requestMeta(req),
    metadata: input,
  });
  res.json(input);
});

authRouter.post('/change-password', authenticate, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = parse(ChangePasswordSchema, req.body);
  await auth.changePassword(requireAuth(req), currentPassword, newPassword, requestMeta(req));
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
  res.status(204).end();
});
