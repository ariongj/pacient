import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Ambulance service: Emergency calls, dispatch, pre-hospital care and handover to the emergency department. (routes are added by the module). */
export const emsRouter = Router();
emsRouter.use(authenticate);
