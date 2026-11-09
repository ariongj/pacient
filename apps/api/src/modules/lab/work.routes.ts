import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Laboratory work: Specimen tracking, manual result entry and validation by laboratory staff. (routes are added by the module). */
export const labWorkRouter = Router();
labWorkRouter.use(authenticate);
