import { Router } from 'express';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { users } from '../../db/schema.js';
import { parse, requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';

/**
 * Minimal staff directory for colleagues at the same facility (e.g. reception choosing a doctor to
 * book, a doctor assigning a task to a nurse). Names, roles and specialties only.
 */
const Query = z.object({ role: z.enum(['DOCTOR', 'NURSE', 'PHARMACIST']).optional() });

export const directoryRouter = Router();
directoryRouter.use(
  authenticate,
  requireRole('DIRECTOR', 'DOCTOR', 'NURSE', 'PHARMACIST', 'RECEPTION'),
);

directoryRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(Query, req.query);
  const rows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      role: users.role,
      specialty: users.specialty,
    })
    .from(users)
    .where(
      and(
        eq(users.facilityId, ctx.facilityId!),
        eq(users.isActive, true),
        q.role ? eq(users.role, q.role) : inArray(users.role, ['DOCTOR', 'NURSE', 'PHARMACIST']),
      ),
    )
    .orderBy(asc(users.role), asc(users.fullName));
  res.json({ items: rows });
});
