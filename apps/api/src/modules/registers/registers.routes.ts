import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Disease registers: Chronic disease registers, recalls and quality indicators. (routes are added by the module). */
export const registersRouter = Router();
registersRouter.use(authenticate);
