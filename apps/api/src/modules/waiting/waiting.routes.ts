import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Waiting lists: Elective waiting lists, maximum waiting times, transparency. (routes are added by the module). */
export const waitingListRouter = Router();
waitingListRouter.use(authenticate);
