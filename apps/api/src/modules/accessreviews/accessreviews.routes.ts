import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Access reviews: Periodic recertification of staff accounts by directors and the Ministry. (routes are added by the module). */
export const accessReviewsRouter = Router();
accessReviewsRouter.use(authenticate);
