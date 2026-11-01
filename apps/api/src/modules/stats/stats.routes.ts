import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../lib/errors.js';
import { parse, requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { facilityStats, nationalStats } from './stats.service.js';

const FacilityQuery = z.object({ facilityId: z.string().uuid().optional() });

export const statsRouter = Router();
statsRouter.use(authenticate);

/** Directors see their own facility; the Ministry can drill into any facility. */
statsRouter.get('/facility', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(FacilityQuery, req.query);
  const facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId : q.facilityId;
  if (!facilityId) throw badRequest('facilityId is required');
  res.json(await facilityStats(facilityId));
});

statsRouter.get('/national', requireRole('MINISTRY'), async (_req, res) => {
  res.json(await nationalStats());
});
