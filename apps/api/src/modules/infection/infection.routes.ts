import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Infection prevention: Isolation precautions, healthcare-associated infections, restricted antibiotics. (routes are added by the module). */
export const infectionRouter = Router();
infectionRouter.use(authenticate);
