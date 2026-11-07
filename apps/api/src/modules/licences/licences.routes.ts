import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Professional licences: Licensing of health professionals and licence checks. (routes are added by the module). */
export const licencesRouter = Router();
licencesRouter.use(authenticate);
