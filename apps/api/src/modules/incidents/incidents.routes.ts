import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Safety incidents: Patient safety incident and near-miss reporting and review. (routes are added by the module). */
export const incidentsRouter = Router();
incidentsRouter.use(authenticate);
