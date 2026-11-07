import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Antenatal care: Pregnancy records, antenatal visits and risk assessment. (routes are added by the module). */
export const maternityRouter = Router();
maternityRouter.use(authenticate);
