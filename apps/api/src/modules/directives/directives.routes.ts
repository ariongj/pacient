import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Organ donation and directives: Organ donation registry, advance directives and resuscitation decisions. (routes are added by the module). */
export const directivesRouter = Router();
directivesRouter.use(authenticate);
