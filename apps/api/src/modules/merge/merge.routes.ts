import { Router } from 'express';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { guardianships, patientMerges, patients, users } from '../../db/schema.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyCareTeamRole } from '../notifications/notifications.service.js';
import {
  CHOOSABLE_FIELDS,
  countsFor,
  demographics,
  findCandidates,
  mergePatients,
  SECTION_LABELS,
  unmergePatients,
  type MergeSnapshot,
} from './merge.service.js';

/**
 * Duplicate patient records: the facility director reviews likely duplicates, compares them
 * (demographics and record counts only – never clinical content) and merges them into one record.
 * A merge keeps full lineage and can be undone exactly.
 */
export const mergeRouter = Router();
mergeRouter.use(authenticate, requireRole('DIRECTOR'));

const Choice = z.enum(['survivor', 'merged']);
const MergeBody = z.object({
  survivorId: z.string().uuid(),
  mergedId: z.string().uuid(),
  reason: z.string().trim().min(10).max(500),
  fieldChoices: z
    .object(
      Object.fromEntries(Object.keys(CHOOSABLE_FIELDS).map((k) => [k, Choice.optional()])) as {
        [K in keyof typeof CHOOSABLE_FIELDS]: z.ZodOptional<typeof Choice>;
      },
    )
    .optional(),
});
const UnmergeBody = z.object({ reason: z.string().trim().min(10).max(500) });

mergeRouter.get('/candidates', async (req, res) => {
  const ctx = requireAuth(req);
  res.json({ items: await findCandidates(ctx.facilityId!) });
});

async function describe(patientId: string, facilityId: string) {
  const [p] = await db.select().from(patients).where(eq(patients.id, patientId));
  if (!p) throw notFound('Patient not found');
  if (p.primaryFacilityId !== facilityId) {
    throw forbidden('Only records registered at your facility can be compared');
  }
  const guardians = await db
    .select({
      id: guardianships.id,
      guardianName: users.fullName,
      revokedAt: guardianships.revokedAt,
    })
    .from(guardianships)
    .innerJoin(users, eq(users.id, guardianships.guardianUserId))
    .where(eq(guardianships.patientId, patientId));
  const counts = await countsFor(patientId);
  return {
    ...demographics(p),
    guardians: guardians.filter((g) => !g.revokedAt).map((g) => g.guardianName),
    counts,
    totalRecords: Object.values(counts).reduce((a, b) => a + b, 0),
  };
}

mergeRouter.get('/compare', async (req, res) => {
  const ctx = requireAuth(req);
  const { a, b } = parse(z.object({ a: z.string().uuid(), b: z.string().uuid() }), req.query);
  if (a === b) throw badRequest('Choose two different records');
  const [left, right] = await Promise.all([
    describe(a, ctx.facilityId!),
    describe(b, ctx.facilityId!),
  ]);
  res.json({ a: left, b: right, sections: SECTION_LABELS });
});

mergeRouter.post('/', async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(MergeBody, req.body);
  const result = await db.transaction(async (tx) => {
    const merged = await mergePatients(tx, input, {
      userId: ctx.userId,
      facilityId: ctx.facilityId!,
    });
    const moved = Object.fromEntries(
      Object.entries(merged.movedRows).map(([k, ids]) => [k, ids.length]),
    );
    for (const patientId of [merged.survivor.id, merged.merged.id]) {
      await audit(
        {
          action: AuditAction.PATIENT_MERGED,
          actor: ctx,
          resourceType: 'patient_merge',
          resourceId: merged.record.id,
          patientId,
          meta: requestMeta(req),
          metadata: {
            survivorId: merged.survivor.id,
            mergedId: merged.merged.id,
            moved,
            fieldChoices: input.fieldChoices ?? {},
          },
        },
        tx,
      );
    }
    await notifyCareTeamRole(
      merged.survivor.id,
      'DOCTOR',
      {
        type: 'PATIENT_MERGED',
        title: 'Two patient records were merged',
        body: 'A duplicate record of one of your patients was merged into their main record.',
        link: `/doctor/patients/${merged.survivor.id}`,
      },
      tx,
    );
    return {
      id: merged.record.id,
      survivorId: merged.survivor.id,
      mergedId: merged.merged.id,
      moved,
    };
  });
  res.status(201).json(result);
});

mergeRouter.post('/:id/unmerge', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const { reason } = parse(UnmergeBody, req.body);
  const result = await db.transaction(async (tx) => {
    const r = await unmergePatients(tx, id, reason, {
      userId: ctx.userId,
      facilityId: ctx.facilityId!,
    });
    for (const patientId of [r.survivor.id, r.merged.id]) {
      await audit(
        {
          action: AuditAction.PATIENT_UNMERGED,
          actor: ctx,
          resourceType: 'patient_merge',
          resourceId: id,
          patientId,
          meta: requestMeta(req),
          metadata: { survivorId: r.survivor.id, mergedId: r.merged.id, restored: r.restored },
        },
        tx,
      );
    }
    await notifyCareTeamRole(
      r.survivor.id,
      'DOCTOR',
      {
        type: 'PATIENT_UNMERGED',
        title: 'A patient record merge was undone',
        body: 'Records that had been merged were separated again. Check the patient record.',
        link: `/doctor/patients/${r.survivor.id}`,
      },
      tx,
    );
    return { id, restored: r.restored };
  });
  res.json(result);
});

mergeRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const rows = await db
    .select()
    .from(patientMerges)
    .where(eq(patientMerges.facilityId, ctx.facilityId!))
    .orderBy(desc(patientMerges.mergedAt))
    .limit(200);
  const userIds = [
    ...new Set(rows.flatMap((r) => [r.mergedById, r.unmergedById]).filter(Boolean)),
  ] as string[];
  const names = userIds.length
    ? await db
        .select({ id: users.id, fullName: users.fullName })
        .from(users)
        .where(inArray(users.id, userIds))
    : [];
  const nameOf = (id: string | null) => names.find((n) => n.id === id)?.fullName ?? null;
  res.json({
    items: rows.map((r) => {
      const snap = r.snapshot as unknown as MergeSnapshot;
      const brief = (p: MergeSnapshot['survivor']) => ({
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        dateOfBirth: p.dateOfBirth,
        nationalId: p.nationalId,
      });
      return {
        id: r.id,
        survivor: brief(snap.survivor),
        merged: brief(snap.merged),
        reason: r.reason,
        movedCount: Object.entries(r.movedRows)
          .filter(([k]) => !k.includes(':'))
          .reduce((a, [, ids]) => a + ids.length, 0),
        changedFields: snap.changedFields,
        accountMoved: Boolean(snap.movedUserId),
        mergedAt: r.mergedAt,
        mergedBy: nameOf(r.mergedById),
        unmergedAt: r.unmergedAt,
        unmergedBy: nameOf(r.unmergedById),
        unmergeReason: r.unmergeReason,
      };
    }),
  });
});
