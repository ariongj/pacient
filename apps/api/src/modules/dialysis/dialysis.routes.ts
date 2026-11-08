import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Dialysis: Haemodialysis schedules, sessions and adequacy. (routes are added by the module). */
export const dialysisRouter = Router();
dialysisRouter.use(authenticate);
