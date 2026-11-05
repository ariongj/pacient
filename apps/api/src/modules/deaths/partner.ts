import { Router } from 'express';
import { requireScope } from '../partner/partner.auth.js';

/** Civil registry feed of signed death certificates (scope deaths.read). */
export const deathsPartnerRouter = Router();
deathsPartnerRouter.use(requireScope('deaths.read'));
