import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Medical certificates: Sick leave and fitness certificates with public verification. (routes are added by the module). */
export const certificatesRouter = Router();
certificatesRouter.use(authenticate);
