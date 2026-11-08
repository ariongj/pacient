import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  admissions,
  beds,
  careUnits,
  involuntaryAdmissions,
  notifications,
  users,
} from '../../db/schema.js';
import { forbidden } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import {
  assertClinicalWriteAccess,
  hasActiveCareAssignment,
  resolveClinicalReadAccess,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction, auditSafe } from '../audit/audit.service.js';
import { notifyUsers } from '../notifications/notifications.service.js';
import { legalSteps, type LegalStep } from './definitions.js';

type Role = AuthContext['role'];

export type InvoluntaryRow = typeof involuntaryAdmissions.$inferSelect;

/** The patient's current hospital stay with its ward (null when not admitted). */
export async function currentAdmission(patientId: string, executor: Executor = db) {
  const [row] = await executor
    .select({
      id: admissions.id,
      facilityId: admissions.facilityId,
      unitId: admissions.unitId,
      unitName: careUnits.name,
      unitType: careUnits.type,
      bedLabel: beds.label,
      attendingDoctorId: admissions.attendingDoctorId,
      admittedAt: admissions.admittedAt,
    })
    .from(admissions)
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .leftJoin(beds, eq(beds.id, admissions.bedId))
    .where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'ADMITTED')));
  return row ?? null;
}

/**
 * Mental health safeguard records are narrower than the rest of the chart: the general clinical
 * rules (which also let radiology, theatre or infection-control staff and break-glass emergency
 * access open a record) must pass, and then the caller must be on the patient's care team, the
 * attending doctor of the current stay, or staff of the ward where the patient is admitted now.
 * Returns the access basis for the access log.
 */
export async function assertMentalHealthAccess(
  ctx: AuthContext,
  patientId: string,
  meta: RequestMeta | undefined,
  write?: Role[],
) {
  const basis = write
    ? await assertClinicalWriteAccess(ctx, patientId, meta, write)
    : await resolveClinicalReadAccess(ctx, patientId, meta);
  if (basis === 'CARE_TEAM') {
    if (await hasActiveCareAssignment(ctx.userId, patientId)) return basis;
    const result = await db.execute<{ ok: number }>(sql`
      SELECT 1 AS ok FROM admissions a
      WHERE a.patient_id = ${patientId} AND a.status = 'ADMITTED'
        AND a.facility_id = ${ctx.facilityId}
        AND (a.attending_doctor_id = ${ctx.userId}
             OR EXISTS (SELECT 1 FROM unit_staff us
                        WHERE us.unit_id = a.unit_id AND us.user_id = ${ctx.userId}))
      LIMIT 1`);
    if (result.rows.length) return basis;
  }
  await auditSafe({
    action: AuditAction.PATIENT_RECORD_ACCESS_DENIED,
    actor: ctx,
    outcome: 'DENIED',
    resourceType: 'patient',
    resourceId: patientId,
    patientId,
    meta,
    metadata: { section: 'mental_health' },
  });
  throw forbidden(
    'Mental health safeguards are visible only to the patient’s care team and the staff of the ward where the patient is admitted',
  );
}

export const CARE_TEAM_WRITERS = WRITERS.careTeam;
export const DOCTOR_WRITERS = WRITERS.doctorOnly;

export async function namesOf(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db
    .select({ id: users.id, name: users.fullName })
    .from(users)
    .where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function directorsOf(facilityId: string, executor: Executor = db) {
  const rows = await executor
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR'), eq(users.isActive, true)),
    );
  return rows.map((r) => r.id);
}

/* --------------------------------------------------------------------- worker -------------- */

export const DEADLINE_NOTIFICATION = 'mentalhealth.deadline';

const STEP_TITLES: Record<LegalStep, string> = {
  SECOND_OPINION: 'Involuntary admission: the second examination is overdue – {unit}',
  RIGHTS_EXPLAINED: 'Involuntary admission: rights not yet explained to the patient – {unit}',
  REPRESENTATIVE_NOTIFIED:
    'Involuntary admission: the representative or family has not been informed – {unit}',
  COURT_NOTIFIED: 'Involuntary admission: the court has not been notified in time – {unit}',
  COURT_DECISION: 'Involuntary admission: the court decision is overdue – {unit}',
  AUTHORISATION_REVIEW: 'Involuntary admission: the authorisation ends on {date} – {unit}',
};

/**
 * Tells the deciding doctor and the facility's directors, once per step, when a legal step of an
 * active involuntary admission becomes overdue, and once per authorisation period when it ends
 * within the warning period. No names in the notification: the link opens the record for those
 * entitled to see it. Each reminder is claimed under an advisory lock keyed by admission and step
 * and recorded in the notification link, so several API instances never send it twice.
 */
export async function runDeadlineRemindersOnce(now = new Date()) {
  const active = await db
    .select({
      ia: involuntaryAdmissions,
      unitName: careUnits.name,
    })
    .from(involuntaryAdmissions)
    .innerJoin(admissions, eq(admissions.id, involuntaryAdmissions.admissionId))
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .where(eq(involuntaryAdmissions.status, 'ACTIVE'));
  let sent = 0;
  for (const { ia, unitName } of active) {
    for (const s of legalSteps(ia, now)) {
      const authorisation = s.step === 'AUTHORISATION_REVIEW';
      const due = authorisation
        ? s.status === 'DUE_SOON' || s.status === 'OVERDUE'
        : s.status === 'OVERDUE';
      if (!due) continue;
      // A renewed authorisation is a new period, so it gets its own reminder.
      const key = authorisation
        ? `ia=${ia.id}&step=${s.step}&until=${s.dueAt!.toISOString().slice(0, 10)}`
        : `ia=${ia.id}&step=${s.step}`;
      const delivered = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
        const [already] = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(eq(notifications.type, DEADLINE_NOTIFICATION), like(notifications.link, `%${key}`)),
          )
          .limit(1);
        if (already) return false;
        const recipients = [ia.decidedById, ...(await directorsOf(ia.facilityId, tx))];
        await notifyUsers(
          recipients,
          {
            type: DEADLINE_NOTIFICATION,
            title: STEP_TITLES[s.step],
            vars: { unit: unitName, date: s.dueAt ?? undefined },
            link: `/mental-health?${key}`,
            important: true,
          },
          tx,
        );
        await audit(
          {
            action: AuditAction.INVOLUNTARY_ADMISSION_CHANGED,
            actor: null,
            resourceType: 'involuntary_admission',
            resourceId: ia.id,
            patientId: ia.patientId,
            metadata: { kind: 'deadline_reminder', step: s.step, status: s.status },
          },
          tx,
        );
        return true;
      });
      if (delivered) sent++;
    }
  }
  return sent;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

async function runSafely() {
  if (running) return;
  running = true;
  try {
    await runDeadlineRemindersOnce();
  } catch (err) {
    logger.error({ err }, 'Mental health deadline reminders failed');
  } finally {
    running = false;
  }
}

/** Hourly (first run after five minutes); never in tests. */
export function startMentalHealthWorker() {
  if (isTest || timer) return;
  setTimeout(() => void runSafely(), 5 * 60_000).unref();
  timer = setInterval(() => void runSafely(), 3_600_000);
  timer.unref();
}

export function stopMentalHealthWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
