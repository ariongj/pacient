import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Cancer screening: Cervical, breast and colorectal screening programmes. (routes are added by the module). */
export const screeningRouter = Router();
screeningRouter.use(authenticate);
