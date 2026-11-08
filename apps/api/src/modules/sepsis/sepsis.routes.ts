import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Sepsis: Sepsis screening and the Sepsis Six bundle. (routes are added by the module). */
export const sepsisRouter = Router();
sepsisRouter.use(authenticate);
