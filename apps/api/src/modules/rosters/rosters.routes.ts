import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Rosters and on-call: Staff shifts, on-call rota and who is on call now. (routes are added by the module). */
export const rostersRouter = Router();
rostersRouter.use(authenticate);
