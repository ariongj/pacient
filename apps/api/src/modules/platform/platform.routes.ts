import { Router } from 'express';
import { activeNotice, getSettings } from './platform.service.js';

/**
 * Public operator details (name, support contact and hours) and the current notice to users
 * (/platform).
 */
export const platformRouter = Router();

const orNull = (v: string | null) => (v?.trim() ? v.trim() : null);

/**
 * Who runs the service and how to reach them, plus the notice to all users (e.g. planned
 * maintenance) while it is valid. Public: shown in the footer, on the legal pages and in the app.
 */
platformRouter.get('/info', async (_req, res) => {
  const s = await getSettings();
  res.set('Cache-Control', 'no-store');
  res.json({
    operatorName: orNull(s.operatorName),
    operatorAddress: orNull(s.operatorAddress),
    supportEmail: orNull(s.supportEmail),
    supportPhone: orNull(s.supportPhone),
    supportHours: orNull(s.supportHours),
    privacyEmail: orNull(s.privacyEmail),
    notice: activeNotice(s),
  });
});
