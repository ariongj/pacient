import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  careAssignments,
  patients,
  promAssignments,
  promResponses,
  users,
} from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient, notifyUsers } from '../notifications/notifications.service.js';
import {
  AnswerError,
  changeOf,
  INSTRUMENTS,
  nextDueAfter,
  scoreAnswers,
  validateAnswers,
  type Frequency,
  type InstrumentCode,
} from './instruments.js';

export type PromAssignment = typeof promAssignments.$inferSelect;

/** Serialises changes to one patient's assignments of one instrument (one active at a time). */
export async function lockInstrument(tx: Executor, patientId: string, instrument: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`prom:${patientId}:${instrument}`}))`,
  );
}

export async function activeAssignment(
  patientId: string,
  instrument: string,
  executor: Executor = db,
) {
  const [row] = await executor
    .select()
    .from(promAssignments)
    .where(
      and(
        eq(promAssignments.patientId, patientId),
        eq(promAssignments.instrument, instrument),
        eq(promAssignments.status, 'ACTIVE'),
      ),
    );
  return row ?? null;
}

/** Guardians (acting for a child) never see or complete sensitive questionnaires. */
export function assertGuardianMayUse(ctx: AuthContext, instrument: InstrumentCode) {
  if (!ctx.proxy) return;
  if (ctx.proxy.scope !== 'FULL') {
    throw forbidden('Your guardian access covers appointments only');
  }
  if (INSTRUMENTS[instrument].sensitive) {
    throw forbidden('This questionnaire is answered by the young person themselves');
  }
}

/** Last score of the patient on an instrument (before `before`, if given). */
export async function previousScore(
  patientId: string,
  instrument: string,
  executor: Executor = db,
): Promise<number | null> {
  const [row] = await executor
    .select({ score: promResponses.score })
    .from(promResponses)
    .where(and(eq(promResponses.patientId, patientId), eq(promResponses.instrument, instrument)))
    .orderBy(desc(promResponses.submittedAt))
    .limit(1);
  return row?.score === null || row?.score === undefined ? null : Number(row.score);
}

export interface SubmitInput {
  instrument: InstrumentCode;
  assignmentId?: string | null;
  answers: Record<string, unknown>;
}

/**
 * Stores a completed questionnaire for an active assignment (on time, overdue or early), scores
 * it and moves the next due date on. A safety flag (PHQ-9 item 9 above zero, or a severe PHQ-9
 * score) notifies the care team and the clinician who asked for the questionnaire at once.
 */
export async function submitResponse(
  ctx: AuthContext,
  patientId: string,
  input: SubmitInput,
  meta: RequestMeta,
  now = new Date(),
) {
  assertGuardianMayUse(ctx, input.instrument);
  let answers: Record<string, number>;
  try {
    answers = validateAnswers(input.instrument, input.answers);
  } catch (e) {
    if (e instanceof AnswerError) throw badRequest(e.message, { items: e.items });
    throw e;
  }
  return db.transaction(async (tx) => {
    await lockInstrument(tx, patientId, input.instrument);
    const assignment = input.assignmentId
      ? (
          await tx
            .select()
            .from(promAssignments)
            .where(
              and(
                eq(promAssignments.id, input.assignmentId),
                eq(promAssignments.patientId, patientId),
              ),
            )
        )[0]
      : await activeAssignment(patientId, input.instrument, tx);
    if (!assignment) {
      throw notFound('Your care team has not asked you to fill in this questionnaire');
    }
    if (assignment.instrument !== input.instrument) {
      throw badRequest('The answers are for a different questionnaire');
    }
    if (assignment.status !== 'ACTIVE') throw conflict('This questionnaire is no longer requested');
    const [patient] = await tx
      .select({ sex: patients.sex, deceasedAt: patients.deceasedAt })
      .from(patients)
      .where(eq(patients.id, patientId));
    if (patient?.deceasedAt) throw conflict('The patient is recorded as deceased');
    const scored = scoreAnswers(input.instrument, answers, patient?.sex);
    const previous = await previousScore(patientId, input.instrument, tx);
    const [row] = await tx
      .insert(promResponses)
      .values({
        patientId,
        assignmentId: assignment.id,
        instrument: input.instrument,
        answers,
        score: String(scored.score),
        severity: scored.severity,
        safetyFlag: scored.safetyFlag,
        submittedByUserId: ctx.userId,
        submittedAt: now,
      })
      .returning();
    // A one-off questionnaire is done once answered; a repeating one is next due one period on.
    const once = assignment.frequency === 'ONCE';
    await tx
      .update(promAssignments)
      .set({
        nextDueAt: once ? null : nextDueAfter(assignment.frequency as Frequency, now),
        ...(once ? { status: 'ENDED', endedAt: now, endReason: 'Completed' } : {}),
        updatedAt: now,
      })
      .where(eq(promAssignments.id, assignment.id));
    await audit(
      {
        action: AuditAction.PROM_SUBMITTED,
        actor: ctx,
        resourceType: 'prom_response',
        resourceId: row!.id,
        patientId,
        meta,
        metadata: { instrument: input.instrument, safetyFlag: scored.safetyFlag },
      },
      tx,
    );
    if (scored.safetyFlag) {
      const team = await tx
        .select({ id: careAssignments.doctorId })
        .from(careAssignments)
        .innerJoin(users, eq(users.id, careAssignments.doctorId))
        .where(
          and(
            eq(careAssignments.patientId, patientId),
            isNull(careAssignments.endedAt),
            eq(users.isActive, true),
            inArray(users.role, ['DOCTOR', 'NURSE']),
          ),
        );
      await notifyUsers(
        [...team.map((m) => m.id), assignment.assignedById],
        {
          type: 'prom_safety',
          // No name, questionnaire or score in the title (lock screens, e-mail subjects).
          title: 'A questionnaire answer needs your attention today',
          link: `/proms?response=${row!.id}`,
          important: true,
        },
        tx,
      );
    }
    return {
      response: row!,
      scored,
      change: changeOf(input.instrument, previous, scored.score),
    };
  });
}

/* ------------------------------------------------------------------------------ reads -- */

export async function assignmentsOf(patientId: string, executor: Executor = db) {
  return executor
    .select({
      id: promAssignments.id,
      instrument: promAssignments.instrument,
      frequency: promAssignments.frequency,
      nextDueAt: promAssignments.nextDueAt,
      status: promAssignments.status,
      endedAt: promAssignments.endedAt,
      endReason: promAssignments.endReason,
      createdAt: promAssignments.createdAt,
      facilityId: promAssignments.facilityId,
      assignedById: promAssignments.assignedById,
      assignedBy: users.fullName,
    })
    .from(promAssignments)
    .innerJoin(users, eq(users.id, promAssignments.assignedById))
    .where(eq(promAssignments.patientId, patientId))
    .orderBy(desc(promAssignments.createdAt));
}

export async function responsesOf(patientId: string, executor: Executor = db) {
  const rows = await executor
    .select({
      id: promResponses.id,
      assignmentId: promResponses.assignmentId,
      instrument: promResponses.instrument,
      answers: promResponses.answers,
      score: promResponses.score,
      severity: promResponses.severity,
      safetyFlag: promResponses.safetyFlag,
      submittedAt: promResponses.submittedAt,
      submittedByUserId: promResponses.submittedByUserId,
      reviewedAt: promResponses.reviewedAt,
      reviewNote: promResponses.reviewNote,
      reviewedBy: users.fullName,
    })
    .from(promResponses)
    .leftJoin(users, eq(users.id, promResponses.reviewedById))
    .where(eq(promResponses.patientId, patientId))
    .orderBy(asc(promResponses.submittedAt))
    .limit(2000);
  // Each answer with the change since the previous one of the same questionnaire.
  const last = new Map<string, number>();
  const out = rows.map((r) => {
    const score = r.score === null ? null : Number(r.score);
    const prev = last.get(r.instrument) ?? null;
    if (score !== null) last.set(r.instrument, score);
    return {
      ...r,
      score,
      change: score === null ? null : changeOf(r.instrument as InstrumentCode, prev, score),
    };
  });
  return out.reverse();
}

/* ---------------------------------------------------------------------------- reminders -- */

const REMINDER_TYPE = 'prom_due';

/**
 * Reminds patients of questionnaires that are due: once per due date (the reminder's link carries
 * the due date, so a later run finds it). Occasions missed for a whole period are skipped: the due
 * date moves on so the next period gets its own reminder. Reminders go to the patient only (never
 * to guardians). Safe on several instances (per-assignment advisory lock).
 */
export async function runPromRemindersOnce(now = new Date()): Promise<number> {
  const due = await db
    .select({ id: promAssignments.id })
    .from(promAssignments)
    .innerJoin(patients, eq(patients.id, promAssignments.patientId))
    .where(
      and(
        eq(promAssignments.status, 'ACTIVE'),
        lte(promAssignments.nextDueAt, now),
        isNull(patients.mergedIntoId),
        isNull(patients.deceasedAt),
      ),
    )
    .limit(5000);
  let sent = 0;
  for (const { id } of due) {
    const delivered = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`prom_due:${id}`}))`);
      const [a] = await tx.select().from(promAssignments).where(eq(promAssignments.id, id));
      if (!a || a.status !== 'ACTIVE' || !a.nextDueAt || a.nextDueAt > now) return false;
      let dueAt = a.nextDueAt;
      if (a.frequency !== 'ONCE') {
        // Skip whole periods that passed without an answer.
        let next = nextDueAfter(a.frequency as Frequency, dueAt)!;
        while (next <= now) {
          dueAt = next;
          next = nextDueAfter(a.frequency as Frequency, dueAt)!;
        }
        if (dueAt.getTime() !== a.nextDueAt.getTime()) {
          await tx
            .update(promAssignments)
            .set({ nextDueAt: dueAt, updatedAt: now })
            .where(eq(promAssignments.id, id));
        }
      }
      const link = `/portal/questionnaires?assignment=${id}&due=${dueAt.toISOString().slice(0, 10)}`;
      const [p] = await tx
        .select({ userId: patients.userId })
        .from(patients)
        .where(eq(patients.id, a.patientId));
      if (!p?.userId) return false;
      const already = await tx.execute(sql`
        SELECT 1 FROM notifications
        WHERE user_id = ${p.userId} AND type = ${REMINDER_TYPE} AND link = ${link} LIMIT 1`);
      if (already.rows.length) return false;
      await notifyPatient(
        a.patientId,
        {
          type: REMINDER_TYPE,
          title: 'A questionnaire from your care team is ready for you',
          link,
        },
        tx,
        { guardians: 'none' },
      );
      return true;
    });
    if (delivered) sent++;
  }
  return sent;
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

function runSafely() {
  runPromRemindersOnce().then(
    (n) => n && logger.info({ reminders: n }, 'Questionnaire reminders sent'),
    (err: unknown) => logger.error({ err }, 'Questionnaire reminder worker failed'),
  );
}

/** Hourly (first run seven minutes after start). Not started in tests. */
export function startPromsWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 7 * 60_000);
  first.unref();
  timer = setInterval(runSafely, 60 * 60_000);
  timer.unref();
}

export function stopPromsWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}
