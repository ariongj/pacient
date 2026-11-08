import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Cancer registry: Cancer registration, tumour board (MDT) meetings and national incidence. (routes are added by the module). */
export const oncologyRouter = Router();
oncologyRouter.use(authenticate);
