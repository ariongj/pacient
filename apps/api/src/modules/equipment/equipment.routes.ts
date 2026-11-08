import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Medical equipment: Equipment register, maintenance schedule and faults. (routes are added by the module). */
export const equipmentRouter = Router();
equipmentRouter.use(authenticate);
