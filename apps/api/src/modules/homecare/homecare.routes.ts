import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Home care: Community nursing: home care episodes, visits and care plans. (routes are added by the module). */
export const homeCareRouter = Router();
homeCareRouter.use(authenticate);
