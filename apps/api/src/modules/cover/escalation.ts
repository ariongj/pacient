import { and, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  careAssignments,
  labResults,
  patients,
  resultEscalations,
  users,
} from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { activeCoverDoctorsFor } from './cover.service.js';

/**
 * Critical results must never wait unseen. A critical result nobody has acknowledged is escalated:
 * after 30 minutes to the ordering doctor again, their cover and the rest of the patient's medical
 * care team; after 2 hours also to the facility director (without any patient detail).
 */
export const ESCALATION_LEVELS = [
  { level: 1, afterMinutes: 30, label: '30 min' },
  { level: 2, afterMinutes: 120, label: '2 hours' },
] as const;

export async function runEscalationOnce(now = new Date()): Promise<number> {
  let escalated = 0;
  for (const step of ESCALATION_LEVELS) {
    const cutoff = new Date(now.getTime() - step.afterMinutes * 60_000);
    const due = await db
      .select({
        id: labResults.id,
        patientId: labResults.patientId,
        orderedById: labResults.orderedById,
        orderingDoctor: users.fullName,
        doctorFacilityId: users.facilityId,
        patientFacilityId: patients.primaryFacilityId,
      })
      .from(labResults)
      .innerJoin(users, eq(users.id, labResults.orderedById))
      .innerJoin(patients, eq(patients.id, labResults.patientId))
      .where(
        and(
          eq(labResults.flag, 'CRITICAL'),
          isNull(labResults.acknowledgedAt),
          isNull(labResults.supersededById),
          lte(labResults.createdAt, cutoff),
          sql`NOT EXISTS (SELECT 1 FROM ${resultEscalations} e WHERE e.lab_result_id = ${labResults.id} AND e.level = ${step.level})`,
        ),
      )
      .limit(200);

    for (const r of due) {
      try {
        if (await escalate(r, step)) escalated++;
      } catch (err) {
        logger.error({ err, resultId: r.id, level: step.level }, 'Result escalation failed');
      }
    }
  }
  return escalated;
}

async function escalate(
  r: {
    id: string;
    patientId: string;
    orderedById: string;
    orderingDoctor: string;
    doctorFacilityId: string | null;
    patientFacilityId: string | null;
  },
  step: (typeof ESCALATION_LEVELS)[number],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const covers = await activeCoverDoctorsFor([r.orderedById], tx);
    const team = await tx
      .select({ id: users.id })
      .from(careAssignments)
      .innerJoin(users, eq(users.id, careAssignments.doctorId))
      .where(
        and(
          eq(careAssignments.patientId, r.patientId),
          isNull(careAssignments.endedAt),
          eq(users.role, 'DOCTOR'),
          eq(users.isActive, true),
          ne(users.id, r.orderedById),
        ),
      );
    const clinicians = [
      ...new Set([r.orderedById, ...covers.map((c) => c.coverDoctorId), ...team.map((t) => t.id)]),
    ];
    const facilityIds = [
      ...new Set([r.doctorFacilityId, r.patientFacilityId].filter((x): x is string => !!x)),
    ];
    const directors =
      step.level >= 2 && facilityIds.length
        ? (
            await tx
              .select({ id: users.id })
              .from(users)
              .where(
                and(
                  eq(users.role, 'DIRECTOR'),
                  eq(users.isActive, true),
                  inArray(users.facilityId, facilityIds),
                ),
              )
          ).map((d) => d.id)
        : [];

    // Exactly once per result and level, even with several API instances running.
    const inserted = await tx
      .insert(resultEscalations)
      .values({
        labResultId: r.id,
        level: step.level,
        notifiedUserIds: [...clinicians, ...directors],
      })
      .onConflictDoNothing()
      .returning({ id: resultEscalations.id });
    if (!inserted.length) return false;

    await notifyUsers(
      clinicians,
      {
        type: 'result',
        title: `Critical result still not reviewed (${step.label})`,
        link: `/doctor/patients/${r.patientId}?tab=results`,
        important: true,
      },
      tx,
    );
    if (directors.length) {
      await notifyUsers(
        directors,
        {
          type: 'escalation',
          title: `A critical result has waited ${step.label} for review – contact ${r.orderingDoctor}`,
          link: '/director',
          important: true,
        },
        tx,
      );
    }
    await audit(
      {
        action: AuditAction.RESULT_ESCALATED,
        actor: null,
        resourceType: 'lab_result',
        resourceId: r.id,
        patientId: r.patientId,
        metadata: { level: step.level, notified: clinicians.length + directors.length },
      },
      tx,
    );
    return true;
  });
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startEscalationWorker(intervalMs = 60_000) {
  if (timer || isTest) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runEscalationOnce()
      .catch((err: unknown) => logger.error({ err }, 'Escalation worker error'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
}

export function stopEscalationWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
