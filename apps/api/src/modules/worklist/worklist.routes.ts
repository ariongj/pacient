import { Router } from 'express';
import { and, asc, desc, eq, exists, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  careAssignments,
  correctionRequests,
  encounters,
  labResults,
  patients,
  prescriptions,
} from '../../db/schema.js';
import { requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';

const patientName = sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`;

/**
 * A doctor's outstanding work. Follow-up is only "done" when it is explicitly closed – a result
 * that was merely viewed, or a request that was merely opened, stays here.
 */
export const worklistRouter = Router();
worklistRouter.use(authenticate, requireRole('DOCTOR'));

worklistRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);

  const [results, corrections, drafts] = await Promise.all([
    db
      .select({
        id: labResults.id,
        patientId: labResults.patientId,
        patientName,
        testName: labResults.testName,
        value: labResults.value,
        unit: labResults.unit,
        flag: labResults.flag,
        status: labResults.status,
        collectedAt: labResults.collectedAt,
      })
      .from(labResults)
      .innerJoin(patients, eq(patients.id, labResults.patientId))
      .where(
        and(
          eq(labResults.orderedById, ctx.userId),
          isNull(labResults.acknowledgedAt),
          isNull(labResults.supersededById),
        ),
      )
      .orderBy(
        sql`CASE ${labResults.flag} WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'LOW' THEN 1 ELSE 2 END`,
        asc(labResults.collectedAt),
      )
      .limit(100),
    db
      .select({
        id: correctionRequests.id,
        patientId: correctionRequests.patientId,
        patientName,
        section: correctionRequests.section,
        description: correctionRequests.description,
        createdAt: correctionRequests.createdAt,
      })
      .from(correctionRequests)
      .innerJoin(patients, eq(patients.id, correctionRequests.patientId))
      .where(
        and(
          eq(correctionRequests.status, 'OPEN'),
          exists(
            db
              .select({ one: sql`1` })
              .from(careAssignments)
              .where(
                and(
                  eq(careAssignments.patientId, correctionRequests.patientId),
                  eq(careAssignments.doctorId, ctx.userId),
                  isNull(careAssignments.endedAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(correctionRequests.createdAt))
      .limit(100),
    db
      .select({
        id: encounters.id,
        patientId: encounters.patientId,
        patientName,
        type: encounters.type,
        reason: encounters.reason,
        startedAt: encounters.startedAt,
        version: encounters.version,
      })
      .from(encounters)
      .innerJoin(patients, eq(patients.id, encounters.patientId))
      .where(and(eq(encounters.doctorId, ctx.userId), eq(encounters.noteStatus, 'DRAFT')))
      .orderBy(desc(encounters.startedAt))
      .limit(100),
  ]);

  // Prescriptions the pharmacy sent back: the prescriber must act (amend and resubmit, or cancel).
  const returnedPrescriptions = await db
    .select({
      id: prescriptions.id,
      patientId: prescriptions.patientId,
      patientName,
      medication: prescriptions.medication,
      dosage: prescriptions.dosage,
      frequency: prescriptions.frequency,
      pharmacistNote: prescriptions.pharmacistNote,
      returnedAt: prescriptions.verifiedAt,
    })
    .from(prescriptions)
    .innerJoin(patients, eq(patients.id, prescriptions.patientId))
    .where(
      and(
        eq(prescriptions.doctorId, ctx.userId),
        eq(prescriptions.pharmacyStatus, 'RETURNED'),
        eq(prescriptions.status, 'ACTIVE'),
      ),
    )
    .orderBy(desc(prescriptions.verifiedAt))
    .limit(100);

  res.json({
    unacknowledgedResults: results,
    openCorrectionRequests: corrections,
    draftNotes: drafts,
    returnedPrescriptions,
  });
});
