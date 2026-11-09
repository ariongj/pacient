import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Record history: Version history of clinical records: who changed what and when. (routes are added by the module). */
export const historyRouter = Router();
historyRouter.use(authenticate);
