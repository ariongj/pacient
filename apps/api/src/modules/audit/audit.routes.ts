import { Router } from 'express';
import { z } from 'zod';
import { parse, requireAuth } from '../../lib/http.js';
import { PaginationSchema } from '../../lib/pagination.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { listAuditLogs } from './audit.service.js';

const Query = PaginationSchema.extend({
  facilityId: z.string().uuid().optional(),
  actorUserId: z.string().uuid().optional(),
  patientId: z.string().uuid().optional(),
  action: z.string().max(80).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export const auditRouter = Router();
auditRouter.use(authenticate, requireRole('MINISTRY', 'DIRECTOR'));

/**
 * Oversight of the audit trail. Directors review activity by their own facility's staff (e.g.
 * emergency access); the Ministry can review everything.
 */
auditRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(Query, req.query);
  res.json(
    await listAuditLogs({
      ...q,
      facilityId: ctx.role === 'DIRECTOR' ? ctx.facilityId! : q.facilityId,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    }),
  );
});
