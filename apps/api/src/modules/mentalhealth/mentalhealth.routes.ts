import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Mental health safeguards: Involuntary admission safeguards and restrictive interventions. (routes are added by the module). */
export const mentalHealthRouter = Router();
mentalHealthRouter.use(authenticate);
