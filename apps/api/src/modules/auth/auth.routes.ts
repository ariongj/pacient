import { Router, type CookieOptions, type Response } from 'express';
import { z } from 'zod';
import { isProd } from '../../config/env.js';
import { unauthorized } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { PasswordSchema } from '../../lib/password.js';
import { authenticate } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rate-limit.js';
import * as auth from './auth.service.js';

export const REFRESH_COOKIE = 'pacient_rt';

const cookieOptions = (expires?: Date): CookieOptions => ({
  httpOnly: true, // not readable by JavaScript -> immune to token theft via XSS
  secure: isProd,
  sameSite: 'strict', // never sent on cross-site requests -> CSRF protection
  path: '/api/auth',
  ...(expires ? { expires } : {}),
});

function sendSession(res: Response, session: auth.Session) {
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

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: PasswordSchema,
});

export const authRouter = Router();

authRouter.post('/login', authLimiter, async (req, res) => {
  const { email, password } = parse(LoginSchema, req.body);
  sendSession(res, await auth.login(email, password, requestMeta(req)));
});

authRouter.post('/refresh', authLimiter, async (req, res) => {
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

authRouter.post('/change-password', authenticate, authLimiter, async (req, res) => {
  const { currentPassword, newPassword } = parse(ChangePasswordSchema, req.body);
  await auth.changePassword(requireAuth(req), currentPassword, newPassword, requestMeta(req));
  res.clearCookie(REFRESH_COOKIE, cookieOptions());
  res.status(204).end();
});
