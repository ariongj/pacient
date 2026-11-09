import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Patient-reported outcomes: Questionnaires (PHQ-9, GAD-7, EQ-5D and others) assigned to patients, scores and review. (routes are added by the module). */
export const promsRouter = Router();
promsRouter.use(authenticate);
