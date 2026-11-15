import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth.js';

/** A facility's own subscription, history and invoices (/subscription): its directors. */
export const subscriptionRouter = Router();
subscriptionRouter.use(authenticate, requireRole('DIRECTOR'));
