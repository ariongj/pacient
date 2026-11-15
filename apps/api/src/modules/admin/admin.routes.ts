import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { adminPlatformRouter } from '../platform/admin.routes.js';
import { adminBillingRouter } from '../subscriptions/admin.routes.js';
import { adminUsersRouter } from './users.routes.js';

/**
 * The platform administrator's API (/admin): accounts, facilities' subscriptions and invoices,
 * operator settings, terms and privacy notice. ADMIN only; never clinical or record data.
 */
export const adminRouter = Router();
adminRouter.use(authenticate, requireRole('ADMIN'));
adminRouter.use('/users', adminUsersRouter);
// /plans, /organizations, /subscriptions, /invoices
adminRouter.use(adminBillingRouter);
// /overview, /settings, /legal, /audit
adminRouter.use(adminPlatformRouter);
