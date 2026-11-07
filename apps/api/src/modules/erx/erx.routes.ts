import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** E-prescriptions: National e-prescriptions dispensed by community pharmacies. (routes are added by the module). */
export const ePrescriptionsRouter = Router();
ePrescriptionsRouter.use(authenticate);
