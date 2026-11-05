import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Death registration: Medical certificates of cause of death, mortality statistics. (routes are added by the module). */
export const deathsRouter = Router();
deathsRouter.use(authenticate);
