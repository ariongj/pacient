import { Router } from 'express';

/**
 * Public verification of a medical certificate by its QR code (no sign-in): validity, kind, dates
 * and issuer only – never the diagnosis.
 */
export const certificateVerifyRouter = Router();
