import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** IT support: Account and access support requests (no clinical access). (routes are added by the module). */
export const supportRouter = Router();
supportRouter.use(authenticate);
