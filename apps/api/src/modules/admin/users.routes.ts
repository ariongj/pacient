import { Router } from 'express';

/**
 * Account management by the platform administrator (mounted at /admin/users, ADMIN only).
 * Contract (see docs/ADMIN.md once written):
 *   GET    /                    list: q, role, facilityId, status (active|disabled|locked|pending|no_mfa), page
 *   GET    /:id                 account, sign-in history, sessions, recent administrative actions
 *   POST   /                    invite (any role; facility roles need a facility; seats checked)
 *   PATCH  /:id                 name, role, facility, specialty, licence number (+ reason)
 *   POST   /:id/disable|enable  (+ reason)
 *   POST   /:id/unlock | /:id/password-reset | /:id/mfa-reset (+ reason) | /:id/revoke-sessions
 *   POST   /:id/resend-invitation
 */
export const adminUsersRouter = Router();
