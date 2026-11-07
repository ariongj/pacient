import { Router } from 'express';
import { requireScope } from '../partner/partner.auth.js';

/** Community pharmacy systems: look up and dispense national e-prescriptions (scope prescriptions.dispense). */
export const erxPartnerRouter = Router();
erxPartnerRouter.use(requireScope('prescriptions.dispense'));
