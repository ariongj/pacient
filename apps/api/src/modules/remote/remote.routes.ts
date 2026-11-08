import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Remote monitoring: Home readings from patients, personal alert limits and review. (routes are added by the module). */
export const remoteMonitoringRouter = Router();
remoteMonitoringRouter.use(authenticate);
