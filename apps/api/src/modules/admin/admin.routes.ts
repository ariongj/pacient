import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { adminPlatformRouter } from '../platform/admin.routes.js';
import { operationsAdminRouter } from '../platform/operations.routes.js';
import { adminRequestsRouter } from '../requests/requests.routes.js';
import { adminBillingRouter } from '../subscriptions/admin.routes.js';
import { agreementsAdminRouter } from '../subscriptions/agreements.routes.js';
import { billingCorrectionsAdminRouter } from '../subscriptions/corrections.routes.js';
import { billingDocumentsAdminRouter } from '../subscriptions/documents.routes.js';
import { billingExportsRouter } from '../subscriptions/exports.routes.js';
import { billingProfileAdminRouter } from '../subscriptions/profile.routes.js';
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
// Going live (round 2): billing details, documents, corrections and exports; agreements;
// requests to the operator; operations (test e-mail, e-mail failures, alerts).
adminRouter.use(billingProfileAdminRouter);
adminRouter.use(billingDocumentsAdminRouter);
adminRouter.use(billingCorrectionsAdminRouter);
adminRouter.use('/exports', billingExportsRouter);
adminRouter.use(agreementsAdminRouter);
adminRouter.use('/requests', adminRequestsRouter);
adminRouter.use('/platform', operationsAdminRouter);
