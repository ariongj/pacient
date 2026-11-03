import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { guardianships, immunizations, users, vaccineSchedule } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { isTest } from '../../config/env.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient, notifyUsers } from '../notifications/notifications.service.js';

/**
 * National childhood vaccination calendar. Each active row of `vaccine_schedule` is one
 * recommended dose; a child's dose is DUE from the recommended age, OVERDUE after the overdue age,
 * and NOT_APPLICABLE once past the last age at which it is still offered (catch-up limit).
 */
export type DoseState = 'GIVEN' | 'DUE' | 'OVERDUE' | 'UPCOMING' | 'NOT_APPLICABLE';

export const DAY_MS = 86_400_000;
/** Childhood programme ends at 18 years. */
export const ADULT_AGE_DAYS = 6570;

/**
 * Last age (days) at which a dose is still offered as catch-up. Codes not listed here are
 * offered until 18 years. The Ministry can add codes; this table only refines known ones.
 */
export const LAST_AGE_DAYS: Record<string, number> = {
  BCG: 1825, // up to 5 years
  HEPB_0: 60, // birth dose; later protection comes from the hexavalent doses
  PCV_1: 1825,
  PCV_2: 1825,
  PCV_3: 1825,
  HEXA_1: 2555, // up to 7 years (then age-appropriate catch-up schedules apply)
  HEXA_2: 2555,
  HEXA_3: 2555,
  DTAP_IPV_B1: 2555,
};

export const lastAgeDays = (code: string) => LAST_AGE_DAYS[code] ?? ADULT_AGE_DAYS;

export type ScheduleItem = typeof vaccineSchedule.$inferSelect;

export async function activeSchedule(executor: Executor = db): Promise<ScheduleItem[]> {
  return executor
    .select()
    .from(vaccineSchedule)
    .where(eq(vaccineSchedule.isActive, true))
    .orderBy(asc(vaccineSchedule.sortOrder), asc(vaccineSchedule.recommendedAgeDays));
}

/** Age in whole days at `now` for a YYYY-MM-DD date of birth (UTC dates). */
export function ageInDays(dateOfBirth: string, now: Date): number {
  const dob = Date.UTC(
    Number(dateOfBirth.slice(0, 4)),
    Number(dateOfBirth.slice(5, 7)) - 1,
    Number(dateOfBirth.slice(8, 10)),
  );
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - dob) / DAY_MS);
}

export function addDays(dateOfBirth: string, days: number): string {
  const d = new Date(`${dateOfBirth}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const norm = (s: string) => s.trim().toLowerCase();

export interface RecordedDose {
  id: string;
  vaccine: string;
  doseNumber: number | null;
  scheduleItemId: string | null;
  administeredAt: Date;
}

/**
 * Which recorded immunization counts for a schedule dose: an explicit link wins; otherwise an
 * unlinked immunization with the same vaccine name and dose number.
 */
export function matchDoses<T extends RecordedDose>(
  schedule: ScheduleItem[],
  recorded: T[],
): Map<string, T> {
  const result = new Map<string, T>();
  const used = new Set<string>();
  for (const item of schedule) {
    const linked = recorded.find((r) => r.scheduleItemId === item.id);
    if (linked) {
      result.set(item.id, linked);
      used.add(linked.id);
    }
  }
  for (const item of schedule) {
    if (result.has(item.id)) continue;
    const byName = recorded.find(
      (r) =>
        !used.has(r.id) &&
        !r.scheduleItemId &&
        norm(r.vaccine) === norm(item.vaccine) &&
        (r.doseNumber ?? 1) === item.doseNumber,
    );
    if (byName) {
      result.set(item.id, byName);
      used.add(byName.id);
    }
  }
  return result;
}

export function doseState(item: ScheduleItem, ageDays: number, given: boolean): DoseState {
  if (given) return 'GIVEN';
  if (ageDays > lastAgeDays(item.code)) return 'NOT_APPLICABLE';
  if (ageDays < item.recommendedAgeDays) return 'UPCOMING';
  return ageDays > item.overdueAgeDays ? 'OVERDUE' : 'DUE';
}

export interface DoseStatus<T extends RecordedDose = RecordedDose> {
  item: ScheduleItem;
  state: DoseState;
  dueDate: string;
  overdueDate: string;
  given: T | null;
}

export function computeStatus<T extends RecordedDose>(
  dateOfBirth: string,
  schedule: ScheduleItem[],
  recorded: T[],
  now: Date,
) {
  const age = ageInDays(dateOfBirth, now);
  const matches = matchDoses(schedule, recorded);
  const doses: DoseStatus<T>[] = schedule.map((item) => {
    const given = matches.get(item.id) ?? null;
    return {
      item,
      state: doseState(item, age, Boolean(given)),
      dueDate: addDays(dateOfBirth, item.recommendedAgeDays),
      overdueDate: addDays(dateOfBirth, item.overdueAgeDays),
      given,
    };
  });
  const open = doses.filter(
    (d) => d.state === 'DUE' || d.state === 'OVERDUE' || d.state === 'UPCOMING',
  );
  const nextDueDate = open.length ? open.map((d) => d.dueDate).sort()[0]! : null;
  return { ageDays: age, doses, nextDueDate };
}

/* -------------------------------------------------------------------------------- reminders -- */

/** Active guardians (any scope: vaccinations are booked like appointments). */
async function guardianUserIds(patientId: string, executor: Executor, now: Date) {
  const rows = await executor
    .select({ userId: guardianships.guardianUserId })
    .from(guardianships)
    .where(
      and(
        eq(guardianships.patientId, patientId),
        isNull(guardianships.revokedAt),
        lte(guardianships.validFrom, now),
        gt(guardianships.validUntil, now),
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * Sends each child's record holders one reminder per dose and kind: DUE when the dose becomes
 * due within the next 7 days (or is due now), OVERDUE once past the overdue age. The child's own
 * account is reminded only from 16 years; guardians always. Safe to run on several instances at
 * once: the reminder row is claimed with INSERT … ON CONFLICT DO NOTHING before anyone is told.
 */
export async function runVaccinationRemindersOnce(now = new Date()): Promise<number> {
  const today = now.toISOString().slice(0, 10);
  const candidates = await db.execute<{
    patient_id: string;
    schedule_item_id: string;
    code: string;
    vaccine: string;
    first_name: string;
    kind: 'DUE' | 'OVERDUE';
    age_days: number;
    user_id: string | null;
  }>(sql`
    WITH kids AS (
      SELECT p.id, p.first_name, p.user_id, p.date_of_birth,
             (${today}::date - p.date_of_birth) AS age_days
      FROM patients p
      WHERE p.merged_into_id IS NULL AND p.date_of_birth > (${today}::date - interval '18 years')
    )
    SELECT k.id AS patient_id, vs.id AS schedule_item_id, vs.code, vs.vaccine, k.first_name,
           k.user_id, k.age_days,
           CASE WHEN k.age_days > vs.overdue_age_days THEN 'OVERDUE' ELSE 'DUE' END AS kind
    FROM kids k
    CROSS JOIN vaccine_schedule vs
    WHERE vs.is_active
      AND k.age_days >= vs.recommended_age_days - 7
      AND NOT EXISTS (
        SELECT 1 FROM immunizations i
        WHERE i.patient_id = k.id
          AND (i.schedule_item_id = vs.id
               OR (i.schedule_item_id IS NULL AND lower(trim(i.vaccine)) = lower(trim(vs.vaccine))
                   AND coalesce(i.dose_number, 1) = vs.dose_number)))
      AND NOT EXISTS (
        SELECT 1 FROM immunization_reminders r
        WHERE r.patient_id = k.id AND r.schedule_item_id = vs.id
          AND r.kind = CASE WHEN k.age_days > vs.overdue_age_days THEN 'OVERDUE' ELSE 'DUE' END)
    LIMIT 2000`);

  let sent = 0;
  for (const c of candidates.rows) {
    if (Number(c.age_days) > lastAgeDays(c.code)) continue;
    const delivered = await db.transaction(async (tx) => {
      const claimed = await tx.execute<{ id: string }>(sql`
        INSERT INTO immunization_reminders (patient_id, schedule_item_id, kind, sent_at)
        VALUES (${c.patient_id}, ${c.schedule_item_id}, ${c.kind}, ${now})
        ON CONFLICT (patient_id, schedule_item_id, kind) DO NOTHING
        RETURNING id`);
      if (!claimed.rows.length) return false;
      const notification = {
        type: 'vaccination',
        title:
          c.kind === 'OVERDUE'
            ? 'A vaccination is overdue for {name}: {vaccine}'
            : 'A vaccination is due for {name}: {vaccine}',
        body: 'Book an appointment with your family doctor or the vaccination clinic.',
        vars: { name: c.first_name, vaccine: c.vaccine },
        link: '/portal/vaccinations',
      };
      const ownAccount = c.user_id && Number(c.age_days) >= 16 * 365;
      if (ownAccount) {
        await notifyPatient(c.patient_id, notification, tx, { guardians: 'all' });
      } else {
        const guardians = (await guardianUserIds(c.patient_id, tx, now)).filter(
          (id) => id !== c.user_id,
        );
        await notifyUsers(
          guardians,
          {
            ...notification,
            wrap: [{ text: '{title} (family member)' }],
            link: `/portal/vaccinations?for=${c.patient_id}`,
          },
          tx,
        );
      }
      await audit(
        {
          action: AuditAction.VACCINATION_REMINDER_SENT,
          actor: null,
          resourceType: 'patient',
          resourceId: c.patient_id,
          patientId: c.patient_id,
          metadata: { code: c.code, kind: c.kind },
        },
        tx,
      );
      return true;
    });
    if (delivered) sent++;
  }
  return sent;
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;
const SIX_HOURS = 6 * 3_600_000;

function runSafely() {
  runVaccinationRemindersOnce().then(
    (n) => n && logger.info({ reminders: n }, 'Vaccination reminders sent'),
    (err: unknown) => logger.error({ err }, 'Vaccination reminders failed'),
  );
}

/** Every 6 hours (first run a minute after start). Not started in tests. */
export function startVaccinationReminderWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 60_000);
  first.unref();
  timer = setInterval(runSafely, SIX_HOURS);
  timer.unref();
}

export function stopVaccinationReminderWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}

/* ------------------------------------------------------------------------- recorded doses -- */

export async function recordedDoses(
  patientId: string,
  executor: Executor = db,
  opts: { hideConfidential?: boolean } = {},
) {
  return executor
    .select({
      id: immunizations.id,
      vaccine: immunizations.vaccine,
      doseNumber: immunizations.doseNumber,
      scheduleItemId: immunizations.scheduleItemId,
      administeredAt: immunizations.administeredAt,
      lotNumber: immunizations.lotNumber,
      site: immunizations.site,
      notes: immunizations.notes,
      administeredBy: users.fullName,
      facilityId: immunizations.facilityId,
    })
    .from(immunizations)
    .leftJoin(users, eq(users.id, immunizations.administeredById))
    .where(
      and(
        eq(immunizations.patientId, patientId),
        opts.hideConfidential
          ? sql`NOT EXISTS (SELECT 1 FROM encounters ce WHERE ce.id = ${immunizations.encounterId} AND ce.confidential_from_guardians)`
          : undefined,
      ),
    )
    .orderBy(asc(immunizations.administeredAt));
}
