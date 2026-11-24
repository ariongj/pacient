import { Router } from 'express';
import { and, asc, desc, eq, exists, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  careAssignments,
  correctionRequests,
  encounters,
  imagingOrders,
  labOrders,
  labResults,
  patients,
  prescriptions,
  resultEscalations,
  users,
} from '../../db/schema.js';
import { doctorsCoveredBy } from '../cover/cover.service.js';
import { requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';

const patientName = sql<string>`${patients.firstName} || ' ' || ${patients.lastName}`;
const escalationLevel = sql<number>`coalesce((SELECT max(${resultEscalations.level}) FROM ${resultEscalations} WHERE ${resultEscalations.labResultId} = ${labResults.id}), 0)::int`;
const criticalFirst = sql`CASE ${labResults.flag} WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'LOW' THEN 1 ELSE 2 END`;

/*
 * Defence in depth for a doctor who moved to another facility: sections keyed only on the doctor
 * show what belongs to their current facility. (A role or facility change already waits until
 * results, draft notes and returned prescriptions are handed over.)
 *
 * A result belongs to the facility that ordered it. A result without an order (entered by hand)
 * stays listed, whatever visit it is linked to: the linked visit says which episode the result
 * belongs to, not where the doctor works, and hiding an unreviewed – possibly critical – result
 * would be the greater harm. Returned prescriptions are not filtered: the hospital pharmacy only
 * returns prescriptions of its own facility's prescribers, and a prescriber cannot be moved while
 * one is outstanding.
 */
const resultAt = (facilityId: string) =>
  or(isNull(labOrders.facilityId), eq(labOrders.facilityId, facilityId));

/**
 * A doctor's outstanding work. Follow-up is only "done" when it is explicitly closed – a result
 * that was merely viewed, or a request that was merely opened, stays here.
 */
export const worklistRouter = Router();
worklistRouter.use(authenticate, requireRole('DOCTOR'));

worklistRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const facilityId = ctx.facilityId!;

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
        escalationLevel,
      })
      .from(labResults)
      .innerJoin(patients, eq(patients.id, labResults.patientId))
      .leftJoin(labOrders, eq(labOrders.id, labResults.orderId))
      .where(
        and(
          eq(labResults.orderedById, ctx.userId),
          isNull(labResults.acknowledgedAt),
          isNull(labResults.supersededById),
          resultAt(facilityId),
        ),
      )
      .orderBy(criticalFirst, asc(labResults.collectedAt))
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
      .where(
        and(
          eq(encounters.doctorId, ctx.userId),
          eq(encounters.noteStatus, 'DRAFT'),
          eq(encounters.facilityId, facilityId),
        ),
      )
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

  // Results of colleagues I am covering for while they are away.
  const covered = await doctorsCoveredBy(ctx.userId);
  const coveredResults = covered.length
    ? await db
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
          escalationLevel,
          orderedById: labResults.orderedById,
          orderedBy: users.fullName,
        })
        .from(labResults)
        .innerJoin(patients, eq(patients.id, labResults.patientId))
        .innerJoin(users, eq(users.id, labResults.orderedById))
        .leftJoin(labOrders, eq(labOrders.id, labResults.orderId))
        .where(
          and(
            inArray(labResults.orderedById, covered),
            isNull(labResults.acknowledgedAt),
            isNull(labResults.supersededById),
            resultAt(facilityId),
          ),
        )
        .orderBy(criticalFirst, asc(labResults.collectedAt))
        .limit(100)
    : [];

  // Imaging reports waiting for my review (mine, or of colleagues I currently cover).
  const reviewers = [ctx.userId, ...covered];
  const imagingToReview = await db
    .select({
      id: imagingOrders.id,
      patientId: imagingOrders.patientId,
      patientName,
      modality: imagingOrders.modality,
      bodyPart: imagingOrders.bodyPart,
      impression: imagingOrders.impression,
      critical: imagingOrders.critical,
      reportedAt: imagingOrders.reportedAt,
      orderedById: imagingOrders.orderedById,
      orderedBy: users.fullName,
    })
    .from(imagingOrders)
    .innerJoin(patients, eq(patients.id, imagingOrders.patientId))
    .innerJoin(users, eq(users.id, imagingOrders.orderedById))
    .where(
      and(
        inArray(imagingOrders.orderedById, reviewers),
        eq(imagingOrders.status, 'REPORTED'),
        isNull(imagingOrders.acknowledgedAt),
        eq(imagingOrders.facilityId, facilityId),
      ),
    )
    .orderBy(desc(imagingOrders.critical), asc(imagingOrders.reportedAt))
    .limit(100);

  res.json({
    unacknowledgedResults: results,
    coveredResults,
    imagingToReview,
    openCorrectionRequests: corrections,
    draftNotes: drafts,
    returnedPrescriptions,
  });
});
