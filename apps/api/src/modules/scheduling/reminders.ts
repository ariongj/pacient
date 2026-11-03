import { sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db } from '../../db/client.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import { localTime } from './time.js';

/** Reminders go out for confirmed appointments that start 20–28 hours from now. */
const WINDOW_FROM_H = 20;
const WINDOW_TO_H = 28;
const INTERVAL_MS = 10 * 60_000;

/**
 * Sends the day-before reminder once per appointment. Claiming the rows with
 * `UPDATE … WHERE reminder_sent_at IS NULL … RETURNING` makes this safe when several API
 * instances run the worker at the same time. Returns the number of reminders sent.
 */
export async function runAppointmentRemindersOnce(now = new Date()): Promise<number> {
  const from = new Date(now.getTime() + WINDOW_FROM_H * 3_600_000);
  const to = new Date(now.getTime() + WINDOW_TO_H * 3_600_000);
  return db.transaction(async (tx) => {
    const claimed = await tx.execute<{
      id: string;
      patient_id: string;
      scheduled_at: string | Date;
      doctor_name: string;
    }>(sql`
      UPDATE appointments a SET reminder_sent_at = ${now.toISOString()}
      FROM users d
      WHERE d.id = a.doctor_id AND a.status = 'CONFIRMED' AND a.reminder_sent_at IS NULL
        AND a.scheduled_at >= ${from.toISOString()} AND a.scheduled_at < ${to.toISOString()}
      RETURNING a.id, a.patient_id, a.scheduled_at, d.full_name AS doctor_name`);
    for (const row of claimed.rows) {
      const at = new Date(row.scheduled_at);
      // No reason or other health information – only that an appointment is coming up.
      await notifyPatient(
        row.patient_id,
        {
          type: 'appointment',
          title: 'Reminder: appointment tomorrow at {time} with {doctor}',
          vars: { time: localTime(at), doctor: row.doctor_name },
          important: true,
          link: '/portal/appointments',
        },
        tx,
        { guardians: 'all' },
      );
      await audit(
        {
          action: AuditAction.APPOINTMENT_REMINDER_SENT,
          actor: null,
          resourceType: 'appointment',
          resourceId: row.id,
          patientId: row.patient_id,
        },
        tx,
      );
    }
    return claimed.rows.length;
  });
}

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

export function startAppointmentReminderWorker() {
  if (isTest || timer) return;
  const run = () =>
    runAppointmentRemindersOnce().then(
      (n) => n && logger.info({ reminders: n }, 'Appointment reminders sent'),
      (err: unknown) => logger.error({ err }, 'Appointment reminders failed'),
    );
  first = setTimeout(run, 30_000);
  first.unref();
  timer = setInterval(run, INTERVAL_MS);
  timer.unref();
}

export function stopAppointmentReminderWorker() {
  clearTimeout(first);
  clearInterval(timer);
  first = undefined;
  timer = undefined;
}
