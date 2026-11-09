import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';

/** Terminology: Code systems, versions, concepts and versioned mappings. (routes are added by the module). */
export const terminologyRouter = Router();
terminologyRouter.use(authenticate);
