import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Complaints and feedback: Patient complaints with response deadlines, anonymous feedback. (routes are added by the module). */
export const complaintsRouter = Router();
complaintsRouter.use(authenticate);
