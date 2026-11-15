import { Router } from 'express';

/**
 * Overview, operator settings, terms and privacy notice, and the administrative audit trail for
 * the platform administrator (mounted on /admin, ADMIN only): /overview, /settings, /legal, /audit.
 */
export const adminPlatformRouter = Router();
