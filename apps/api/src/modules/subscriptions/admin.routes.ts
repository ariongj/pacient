import { Router } from 'express';

/**
 * Plans, subscriptions, history and invoices for the platform administrator (mounted on /admin,
 * ADMIN only): /plans, /organizations, /subscriptions/:id/…, /invoices.
 */
export const adminBillingRouter = Router();
