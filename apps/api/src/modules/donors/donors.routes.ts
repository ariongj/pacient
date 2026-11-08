import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Blood donors: Blood donor register, eligibility, deferrals and donations. (routes are added by the module). */
export const bloodDonorsRouter = Router();
bloodDonorsRouter.use(authenticate);
