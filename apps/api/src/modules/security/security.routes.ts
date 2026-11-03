import { Router } from 'express';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { PaginationSchema } from '../../lib/pagination.js';
import { authenticate } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rate-limit.js';
import { REFRESH_COOKIE, sendSession } from '../auth/auth.routes.js';
import * as passkeys from './passkeys.js';
import { listSessions, revokeOtherSessions, revokeSession, signInHistory } from './sessions.js';

/**
 * Account security: passkeys (registration, sign-in, second step), active sessions and the
 * user's own sign-in history. Mounted at /api/v1/auth/security, so the refresh-token cookie
 * (path /api/v1/auth) is sent with these requests – it identifies the current session.
 */
export const securityRouter = Router();

/** A WebAuthn response as produced by @simplewebauthn/browser (verified cryptographically later). */
const WebAuthnResponse = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z.object({ clientDataJSON: z.string().min(1).max(8192) }).passthrough(),
  })
  .passthrough();

const ReauthSchema = z.object({ password: z.string().min(1).max(128).optional() });
const DeviceName = z.string().trim().min(1).max(100);
const cookieOf = (req: { cookies?: Record<string, string> }) => req.cookies?.[REFRESH_COOKIE];

/* ------------------------------------------------------------------ public: passkey sign-in -- */

securityRouter.post('/passkeys/login/options', authLimiter, async (_req, res) => {
  res.json(await passkeys.loginOptions());
});

securityRouter.post('/passkeys/login', authLimiter, async (req, res) => {
  const { response } = parse(z.object({ response: WebAuthnResponse }), req.body);
  const session = await passkeys.passkeyLogin(
    response as unknown as AuthenticationResponseJSON,
    requestMeta(req),
  );
  sendSession(res, session);
});

/** Second step after the password, using a passkey instead of an authenticator code. */
securityRouter.post('/passkeys/mfa/options', authLimiter, async (req, res) => {
  const { mfaToken } = parse(z.object({ mfaToken: z.string().min(20).max(2000) }), req.body);
  res.json(await passkeys.mfaOptions(mfaToken));
});

securityRouter.post('/passkeys/mfa', authLimiter, async (req, res) => {
  const { mfaToken, response } = parse(
    z.object({ mfaToken: z.string().min(20).max(2000), response: WebAuthnResponse }),
    req.body,
  );
  const session = await passkeys.completeMfaWithPasskey(
    mfaToken,
    response as unknown as AuthenticationResponseJSON,
    requestMeta(req),
  );
  sendSession(res, session);
});

/* ------------------------------------------------------------------ signed in --------------- */

securityRouter.get('/passkeys', authenticate, async (req, res) => {
  res.json({ items: await passkeys.listPasskeys(requireAuth(req).userId) });
});

securityRouter.post('/passkeys/options', authenticate, authLimiter, async (req, res) => {
  const { password } = parse(ReauthSchema, req.body ?? {});
  res.json(
    await passkeys.registrationOptions(requireAuth(req), { password, refreshToken: cookieOf(req) }),
  );
});

securityRouter.post('/passkeys', authenticate, authLimiter, async (req, res) => {
  const { response, deviceName } = parse(
    z.object({ response: WebAuthnResponse, deviceName: DeviceName }),
    req.body,
  );
  const created = await passkeys.registerPasskey(
    requireAuth(req),
    { response: response as unknown as RegistrationResponseJSON, deviceName },
    requestMeta(req),
  );
  res.status(201).json(created);
});

securityRouter.patch('/passkeys/:id', authenticate, async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const { deviceName } = parse(z.object({ deviceName: DeviceName }), req.body);
  res.json(await passkeys.renamePasskey(requireAuth(req), id, deviceName));
});

securityRouter.delete('/passkeys/:id', authenticate, authLimiter, async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const { password } = parse(ReauthSchema, req.body ?? {});
  await passkeys.removePasskey(
    requireAuth(req),
    id,
    { password, refreshToken: cookieOf(req) },
    requestMeta(req),
  );
  res.status(204).end();
});

securityRouter.get('/sessions', authenticate, async (req, res) => {
  res.json({ items: await listSessions(requireAuth(req).userId, cookieOf(req)) });
});

securityRouter.post('/sessions/revoke-others', authenticate, async (req, res) => {
  res.json(await revokeOtherSessions(requireAuth(req), cookieOf(req), requestMeta(req)));
});

securityRouter.post('/sessions/:id/revoke', authenticate, async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  await revokeSession(requireAuth(req), id, requestMeta(req));
  res.status(204).end();
});

securityRouter.get('/history', authenticate, async (req, res) => {
  res.json(await signInHistory(requireAuth(req).userId, parse(PaginationSchema, req.query)));
});
