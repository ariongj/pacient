import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  emailOutbox,
  notifications,
  operatorAlerts,
  opsHeartbeats,
  platformSettings,
  smsOutbox,
  workerRuns,
} from '../src/db/schema.js';
import { recordRun, registerWorker, type WorkerName } from '../src/lib/worker-runs.js';
import { enqueueEmail, processOutboxOnce } from '../src/modules/email/outbox.js';
import { sentEmails } from '../src/modules/email/transport.js';
import {
  clearWorkerStatusCache,
  lastRunsQuery,
  PROCESS_STARTED_AT,
  workerStatuses,
} from '../src/modules/monitoring/operations.service.js';
import {
  ALERT_NOTIFY_EVERY_MS,
  raiseOperatorAlert,
  resolveOperatorAlert,
} from '../src/modules/platform/alerts.js';
import { maskEmail, maskErrorText } from '../src/modules/platform/operations.routes.js';
import {
  abandonedWorkerAlerts,
  checkBackup,
  checkBillingSettings,
  checkOutbox,
  checkWorkers,
  runWatchdogOnce,
} from '../src/modules/platform/watchdog.js';
import { enqueueSms, processSmsOnce } from '../src/modules/sms/outbox.js';
import { api, bearer, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
type Account = { id: string; email: string; token: string };
let admin: Account;
let albanianAdmin: Account;
let inactiveAdminId: string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Alert keys made up by this file, removed at the end. */
const testKey = () => `test.${randomUUID()}`;
const testKeys: string[] = [];

beforeAll(async () => {
  w = await createWorld();
  const a = await createUser('ADMIN', null, { emailNotifications: 'IMPORTANT' });
  admin = { id: a.id, email: a.email, token: await login(a.email) };
  const sq = await createUser('ADMIN', null, { locale: 'sq', emailNotifications: 'IMPORTANT' });
  albanianAdmin = { id: sq.id, email: sq.email, token: await login(sq.email) };
  inactiveAdminId = (await createUser('ADMIN', null, { isActive: false })).id;
});

afterAll(async () => {
  // The watchdog's conditions this file raised on purpose; the next pass decides again anyway.
  for (const worker of [
    'dialysis',
    'sepsis',
    'maternity',
    'proms',
    'licences',
    'equipment',
    'email',
    'infection',
  ]) {
    await resolveOperatorAlert(`worker.stale:${worker}`);
  }
  if (testKeys.length) {
    await db.delete(operatorAlerts).where(inArray(operatorAlerts.conditionKey, testKeys));
  }
});

const alertRow = async (key: string) =>
  (await db.select().from(operatorAlerts).where(eq(operatorAlerts.conditionKey, key)))[0];

const auditFor = (action: string, resourceId: string) =>
  db
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.resourceId, resourceId)))
    .orderBy(desc(auditLogs.occurredAt));

const notificationsOf = (userId: string) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, 'operator_alert')))
    .orderBy(desc(notifications.createdAt));

const notificationMailsTo = (email: string) =>
  db
    .select()
    .from(emailOutbox)
    .where(and(eq(emailOutbox.toEmail, email), eq(emailOutbox.template, 'notification')));

/** A successful run of `worker` at `at` (tests that judge staleness at a later time). */
async function insertRun(worker: WorkerName, at: Date) {
  await db.insert(workerRuns).values({ worker, startedAt: at, finishedAt: at, ok: true });
}

/** Delivers every e-mail and SMS that is due (memory transports in tests). */
async function drain() {
  while ((await processOutboxOnce()) > 0 || (await processSmsOnce()) > 0) {
    /* keep going */
  }
}

/**
 * Makes the next audit insert of `action` for `resourceId`… fail, to show that what was written
 * with it in the same transaction is rolled back. The trigger only matches this test's own rows
 * and is removed again.
 */
async function withFailingAudit(match: string, fn: () => Promise<void>) {
  const name = `test_fail_audit_${randomUUID().replace(/-/g, '')}`;
  await db.execute(
    sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger AS $$
      BEGIN
        IF NEW.metadata::text LIKE '%${match}%' OR NEW.resource_id::text = '${match}' THEN
          RAISE EXCEPTION 'audit refused by the test';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
  );
  await db.execute(
    sql.raw(
      `CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    ),
  );
  try {
    await fn();
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER ${name} ON audit_logs`));
    await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
  }
}

/* ------------------------------------------------------------------ alerts ------------------ */

describe('operator alerts', () => {
  it('creates an alert, audits it and tells every active administrator in their language', async () => {
    const key = testKey();
    testKeys.push(key);
    await raiseOperatorAlert(key, {
      severity: 'CRITICAL',
      message: 'Three things are wrong. Check the API log.',
    });
    const row = (await alertRow(key))!;
    expect(row).toMatchObject({
      severity: 'CRITICAL',
      message: 'Three things are wrong. Check the API log.',
      resolvedAt: null,
    });
    expect(row.lastNotifiedAt).not.toBeNull();

    const [audited] = await auditFor('platform.alert_raised', row.id);
    expect(audited).toMatchObject({
      actorUserId: null,
      resourceType: 'operator_alert',
      patientId: null,
      outcome: 'SUCCESS',
    });
    expect(audited!.metadata).toEqual({ conditionKey: key, severity: 'CRITICAL', reopened: false });

    const [english] = await notificationsOf(admin.id);
    expect(english!.title).toBe('Critical: Pacient needs the operator’s attention');
    expect(english!.body).toBe('Three things are wrong. Check the API log.');
    expect(english!.link).toBe('/admin');
    const [albanian] = await notificationsOf(albanianAdmin.id);
    expect(albanian!.title).toBe('Kritik: Pacient kërkon vëmendjen e operatorit');

    // Important: e-mailed to administrators who get important notifications by e-mail.
    const mails = await db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.toEmail, admin.email), eq(emailOutbox.template, 'notification')));
    expect(mails.length).toBeGreaterThanOrEqual(1);

    // Nobody else: not a disabled administrator, not the Ministry, not a director.
    for (const id of [inactiveAdminId, w.users.ministry.id, w.users.director.id]) {
      expect(await notificationsOf(id)).toHaveLength(0);
    }
  });

  it('names the condition: a stalled worker, failing e-mail, an old backup', async () => {
    const key = `worker.stale:${testKey()}`;
    testKeys.push(key);
    await raiseOperatorAlert(key, { severity: 'WARNING', message: 'No run for a while.' });
    const [n] = await notificationsOf(admin.id);
    expect(n!.title).toBe(`Warning: The background job “${key.slice(13)}” has stopped`);
  });

  it('names a stalled job by what it does, in each administrator’s language, not by its id', async () => {
    const key = 'worker.stale:email';
    // Told less than 6 hours ago by an earlier run of this file: tell again.
    await resolveOperatorAlert(key);
    await db
      .update(operatorAlerts)
      .set({ lastNotifiedAt: null })
      .where(eq(operatorAlerts.conditionKey, key));
    await raiseOperatorAlert(key, { severity: 'CRITICAL', message: 'No run for a while.' });
    const [english] = await notificationsOf(admin.id);
    expect(english!.title).toBe('Critical: The background job “E-mail delivery” has stopped');
    const [albanian] = await notificationsOf(albanianAdmin.id);
    expect(albanian!.title).toBe('Kritik: Puna në sfond „Dërgimi i e-mailit” është ndalur');
    await resolveOperatorAlert(key);
  });

  it('e-mails every active administrator once, also those who turned e-mail off (cross-6)', async () => {
    const off = await createUser('ADMIN', null, { emailNotifications: 'OFF', locale: 'sr' });
    const before = (await notificationMailsTo(admin.email)).length;
    const key = testKey();
    testKeys.push(key);
    await raiseOperatorAlert(key, { severity: 'WARNING', message: 'Backups are late.' });
    expect(await notificationsOf(off.id)).toHaveLength(1);
    expect(await notificationMailsTo(off.email)).toHaveLength(1);
    // Exactly one each: notifyUsers e-mails those whose preference covers it, not again here.
    expect(await notificationMailsTo(admin.email)).toHaveLength(before + 1);
    await drain();
    const mail = sentEmails.find((m) => m.to === off.email)!;
    expect(mail.text).toContain('Upozorenje: Pacient traži pažnju operatera');
    // Not a disabled administrator.
    const inactive = await createUser('ADMIN', null, {
      emailNotifications: 'OFF',
      isActive: false,
    });
    const again = testKey();
    testKeys.push(again);
    await raiseOperatorAlert(again, { severity: 'WARNING', message: 'Again.' });
    expect(await notificationMailsTo(inactive.email)).toHaveLength(0);
  });

  it('updates an open alert without repeating it, and reminds after 6 hours', async () => {
    const key = testKey();
    testKeys.push(key);
    await raiseOperatorAlert(key, { severity: 'WARNING', message: 'First' });
    const first = (await alertRow(key))!;
    const notified = (await notificationsOf(admin.id)).length;

    await raiseOperatorAlert(key, { severity: 'CRITICAL', message: 'Worse now' });
    const second = (await alertRow(key))!;
    expect(second).toMatchObject({ id: first.id, severity: 'CRITICAL', message: 'Worse now' });
    expect(second.firstSeenAt).toEqual(first.firstSeenAt);
    expect(second.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first.lastSeenAt.getTime());
    expect(second.lastNotifiedAt).toEqual(first.lastNotifiedAt);
    expect(await notificationsOf(admin.id)).toHaveLength(notified);
    // Kept open: audited once, when it was created.
    expect(await auditFor('platform.alert_raised', first.id)).toHaveLength(1);

    // Six hours later it is still open: the administrators are reminded.
    await db
      .update(operatorAlerts)
      .set({ lastNotifiedAt: new Date(Date.now() - ALERT_NOTIFY_EVERY_MS - MINUTE) })
      .where(eq(operatorAlerts.id, first.id));
    await raiseOperatorAlert(key, { severity: 'CRITICAL', message: 'Still wrong' });
    expect(await notificationsOf(admin.id)).toHaveLength(notified + 1);
    expect(await auditFor('platform.alert_raised', first.id)).toHaveLength(1);
  });

  it('resolves an open alert once, and reopens it as a new occurrence', async () => {
    const key = testKey();
    testKeys.push(key);
    await raiseOperatorAlert(key, { severity: 'WARNING', message: 'Comes and goes' });
    const raised = (await alertRow(key))!;
    const notified = (await notificationsOf(admin.id)).length;

    await resolveOperatorAlert(key);
    const resolved = (await alertRow(key))!;
    expect(resolved.resolvedAt).not.toBeNull();
    const [audited] = await auditFor('platform.alert_resolved', raised.id);
    expect(audited).toMatchObject({ actorUserId: null, resourceType: 'operator_alert' });
    expect(audited!.metadata).toEqual({ conditionKey: key, severity: 'WARNING' });

    // Resolving what is not open does nothing.
    await resolveOperatorAlert(key);
    await resolveOperatorAlert(testKey());
    expect(await auditFor('platform.alert_resolved', raised.id)).toHaveLength(1);

    // Raised again: open again, a new first-seen time, audited as reopened – but the
    // administrators were told less than 6 hours ago, so not again.
    await raiseOperatorAlert(key, { severity: 'WARNING', message: 'Back again' });
    const reopened = (await alertRow(key))!;
    expect(reopened.id).toBe(raised.id);
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.firstSeenAt.getTime()).toBeGreaterThan(raised.firstSeenAt.getTime());
    const audits = await auditFor('platform.alert_raised', raised.id);
    expect(audits).toHaveLength(2);
    expect(audits[0]!.metadata).toMatchObject({ reopened: true });
    expect(await notificationsOf(admin.id)).toHaveLength(notified);
  });

  it('never stores identifiers in the message, and never throws', async () => {
    const key = testKey();
    testKeys.push(key);
    await raiseOperatorAlert(key, {
      severity: 'WARNING',
      message: `Mail to jane.doe@example.org about 1234567890 (row 2b1c0a6e-3f0d-4c55-9a51-0d4f1c2e7b9a) failed.\n${'x'.repeat(800)}`,
    });
    const row = (await alertRow(key))!;
    expect(row.message).not.toContain('jane.doe');
    expect(row.message).not.toContain('2b1c0a6e-3f0d-4c55-9a51-0d4f1c2e7b9a');
    expect(row.message).not.toContain('1234567890');
    expect(row.message).not.toContain('\n');
    expect(row.message.length).toBeLessThanOrEqual(500);

    // A key that is too long is refused without an exception, and nothing is written.
    const long = `test.${'k'.repeat(200)}`;
    await expect(
      raiseOperatorAlert(long, { severity: 'WARNING', message: 'x' }),
    ).resolves.toBeUndefined();
    expect(await alertRow(long)).toBeUndefined();
    await expect(resolveOperatorAlert(long)).resolves.toBeUndefined();
  });

  it('writes the alert, its audit entry and the notices together or not at all', async () => {
    const key = testKey();
    testKeys.push(key);
    const notified = (await notificationsOf(admin.id)).length;
    await withFailingAudit(key, async () => {
      await expect(
        raiseOperatorAlert(key, { severity: 'WARNING', message: 'Rolled back' }),
      ).resolves.toBeUndefined();
    });
    expect(await alertRow(key)).toBeUndefined();
    expect(await notificationsOf(admin.id)).toHaveLength(notified);

    // And a resolution whose audit entry fails leaves the alert open.
    await raiseOperatorAlert(key, { severity: 'WARNING', message: 'Open' });
    await withFailingAudit(key, () => resolveOperatorAlert(key));
    expect((await alertRow(key))!.resolvedAt).toBeNull();
  });

  it('lists open alerts, critical first, to the platform administrator only', async () => {
    const warning = testKey();
    const critical = testKey();
    const gone = testKey();
    testKeys.push(warning, critical, gone);
    await raiseOperatorAlert(warning, { severity: 'WARNING', message: 'Minor' });
    await raiseOperatorAlert(critical, { severity: 'CRITICAL', message: 'Major' });
    await raiseOperatorAlert(gone, { severity: 'CRITICAL', message: 'Over' });
    await resolveOperatorAlert(gone);

    const res = await api().get('/api/v1/admin/platform/alerts').set(bearer(admin.token));
    expect(res.status).toBe(200);
    const keys = (res.body.items as { conditionKey: string }[]).map((a) => a.conditionKey);
    expect(keys).toContain(warning);
    expect(keys).toContain(critical);
    expect(keys).not.toContain(gone);
    expect(keys.indexOf(critical)).toBeLessThan(keys.indexOf(warning));
    const item = (res.body.items as Record<string, unknown>[]).find(
      (a) => a.conditionKey === critical,
    )!;
    expect(Object.keys(item).sort()).toEqual(
      [
        'conditionKey',
        'firstSeenAt',
        'id',
        'lastNotifiedAt',
        'lastSeenAt',
        'message',
        'severity',
      ].sort(),
    );

    for (const token of [w.tokens.ministry, w.tokens.director, w.tokens.doctor]) {
      expect((await api().get('/api/v1/admin/platform/alerts').set(bearer(token))).status).toBe(
        403,
      );
    }
    expect((await api().get('/api/v1/admin/platform/alerts')).status).toBe(401);
  });
});

/* ------------------------------------------------------------------ watchdog ---------------- */

describe('watchdog', () => {
  it('raises an alert for a worker without success for three intervals, and resolves it', async () => {
    registerWorker('dialysis', MINUTE);
    // Ten minutes from now nothing has succeeded for over three minutes (and over five, the
    // least a worker is given).
    const later = new Date(Date.now() + 10 * MINUTE);
    const stale = (await checkWorkers(later)).find((d) => d.key === 'worker.stale:dialysis')!;
    expect(stale.alert).toMatchObject({ severity: 'WARNING' });
    expect(stale.alert!.message).toContain('"dialysis"');
    expect(stale.alert!.message).toContain(
      'expected every 1 minute; stalled after 5 minutes without one',
    );

    // A successful run a minute before: fine again.
    await db.insert(workerRuns).values({
      worker: 'dialysis',
      startedAt: new Date(later.getTime() - MINUTE),
      finishedAt: new Date(later.getTime() - MINUTE),
      ok: true,
    });
    const fine = (await checkWorkers(later)).find((d) => d.key === 'worker.stale:dialysis')!;
    expect(fine.alert).toBeNull();
    await db
      .delete(workerRuns)
      .where(
        and(
          eq(workerRuns.worker, 'dialysis'),
          sql`${workerRuns.startedAt} > now() + interval '1 minute'`,
        ),
      );

    // Workers whose stop endangers patients are critical; the watchdog does not judge itself.
    registerWorker('sepsis', MINUTE);
    const decisions = await checkWorkers(later);
    expect(decisions.find((d) => d.key === 'worker.stale:sepsis')!.alert!.severity).toBe(
      'CRITICAL',
    );
    expect(decisions.some((d) => d.key === 'worker.stale:watchdog')).toBe(false);
    // A worker this process did not start (switched off here, or run by another instance) is
    // not decided on at all: neither raised nor resolved.
    expect(decisions.some((d) => d.key === 'worker.stale:proms')).toBe(false);
  });

  it('gives a worker at least 5 minutes, and says so with its real interval (ops-2, ops-6)', async () => {
    // Like the e-mail and SMS workers: due every 5 seconds.
    registerWorker('equipment', 5_000);
    const at = new Date(Date.now() + 2 * HOUR);
    await insertRun('equipment', new Date(at.getTime() - 18_000));
    try {
      // 18 seconds after its last success (a long batch is still being sent): not stalled.
      const busy = (await checkWorkers(at)).find((d) => d.key === 'worker.stale:equipment')!;
      expect(busy.alert).toBeNull();
      // 5 minutes 18 seconds after it: stalled, with the interval and threshold it really has.
      const stalled = (await checkWorkers(new Date(at.getTime() + 5 * MINUTE))).find(
        (d) => d.key === 'worker.stale:equipment',
      )!;
      expect(stalled.alert!.message).toContain(
        '(expected every 5 seconds; stalled after 5 minutes without one).',
      );
      // No failure since the last success: no error class in the message.
      expect(stalled.alert!.message).not.toContain('Last error');

      // A failure since then names its class and code only, not its text.
      await db.insert(workerRuns).values({
        worker: 'equipment',
        startedAt: new Date(at.getTime() - 10_000),
        finishedAt: new Date(at.getTime() - 10_000),
        ok: false,
        error: 'DatabaseError 40P01: deadlock detected (table equipment)',
      });
      const failed = (await checkWorkers(new Date(at.getTime() + 5 * MINUTE))).find(
        (d) => d.key === 'worker.stale:equipment',
      )!;
      expect(failed.alert!.message).toContain(
        'Last error: DatabaseError 40P01 (System health › Background jobs).',
      );
      expect(failed.alert!.message).not.toContain('deadlock');

      const health = (await workerStatuses({ now: at, fresh: true })).find(
        (s) => s.name === 'equipment',
      )!;
      expect(health).toMatchObject({ intervalSeconds: 5, staleAfterSeconds: 300, stale: false });
    } finally {
      await db
        .delete(workerRuns)
        .where(
          and(
            eq(workerRuns.worker, 'equipment'),
            sql`${workerRuns.startedAt} > now() + interval '1 hour'`,
          ),
        );
    }
  });

  it('resolves incomplete billing settings once they are complete, never raising them (cross-5)', async () => {
    const key = 'billing.settings_incomplete';
    const [saved] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1));
    try {
      await db
        .update(platformSettings)
        .set({ operatorName: '', operatorIban: null })
        .where(eq(platformSettings.id, 1));
      await raiseOperatorAlert(key, { severity: 'CRITICAL', message: 'Missing: Operator name.' });
      // Still incomplete: left to the subscription worker, which knows whether invoices wait.
      expect(await checkBillingSettings()).toEqual([]);
      await runWatchdogOnce();
      expect((await alertRow(key))!.resolvedAt).toBeNull();

      // Completed: resolved by the next pass, not at the worker's next run (every 6 hours).
      await db
        .update(platformSettings)
        .set({
          operatorName: 'Operator Ops SH.P.K.',
          operatorAddress: 'Rr. Operacionet 1, Prishtinë',
          operatorFiscalNumber: '810000009',
          operatorIban: 'XK05 1212 0123 4567 8906',
          vatRateBp: 0,
        })
        .where(eq(platformSettings.id, 1));
      expect(await checkBillingSettings()).toEqual([{ key, alert: null }]);
      await runWatchdogOnce();
      expect((await alertRow(key))!.resolvedAt).not.toBeNull();
    } finally {
      await db.update(platformSettings).set(saved!).where(eq(platformSettings.id, 1));
      await resolveOperatorAlert(key);
    }
  });

  it('counts e-mail given up in the last 24 hours, never naming the recipient', async () => {
    const to = `failing-${randomUUID().slice(0, 8)}@test.local`;
    await enqueueEmail(db, {
      to,
      template: 'test_email',
      locale: 'en',
      name: 'Failing',
    });
    await db
      .update(emailOutbox)
      .set({ status: 'FAILED', attempts: 6, nextAttemptAt: new Date(Date.now() - HOUR) })
      .where(eq(emailOutbox.toEmail, to));
    const [failing] = await checkOutbox('email');
    expect(failing!.key).toBe('email.failing');
    expect(failing!.alert).toMatchObject({ severity: 'WARNING' });
    expect(failing!.alert!.message).toMatch(/^\d+ e-mail\(s\) could not be delivered/);
    expect(failing!.alert!.message).not.toContain(to);
    // Two days later the failure is out of the window.
    const [later] = await checkOutbox('email', new Date(Date.now() + 2 * 24 * HOUR));
    expect(later!.alert).toBeNull();
  });

  it('raises a backlog for a due message waiting over 30 minutes, not for a later one', async () => {
    await drain();
    const to = `late-${randomUUID().slice(0, 8)}@test.local`;
    await enqueueEmail(db, { to, template: 'test_email', locale: 'en', name: 'Late' });
    await db
      .update(emailOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 40 * MINUTE) })
      .where(eq(emailOutbox.toEmail, to));
    const backlog = (await checkOutbox('email'))[1]!;
    expect(backlog.key).toBe('email.backlog');
    expect(backlog.alert).toMatchObject({ severity: 'CRITICAL' });
    expect(backlog.alert!.message).toMatch(/waited more than 30 minutes/);
    expect(backlog.alert!.message).toMatch(/the oldest for 4\d minutes/);

    // Delivered: no backlog. A message created long ago but due later (a retry, quiet hours)
    // is not late.
    await drain();
    const held = `held-${randomUUID().slice(0, 8)}@test.local`;
    await enqueueEmail(db, { to: held, template: 'test_email', locale: 'en', name: 'Held' });
    await db
      .update(emailOutbox)
      .set({
        createdAt: new Date(Date.now() - 3 * HOUR),
        nextAttemptAt: new Date(Date.now() + 2 * HOUR),
      })
      .where(eq(emailOutbox.toEmail, held));
    expect((await checkOutbox('email'))[1]!.alert).toBeNull();
    await db.delete(emailOutbox).where(eq(emailOutbox.toEmail, held));
  });

  it('watches SMS the same way, and only warns when no SMS provider is configured', async () => {
    await drain();
    const phone = `+38349${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
    await enqueueSms(db, { to: phone, template: 'test', body: 'Test', urgent: true });
    await db
      .update(smsOutbox)
      .set({ nextAttemptAt: new Date(Date.now() - 45 * MINUTE) })
      .where(eq(smsOutbox.toPhone, phone));
    const [, backlog] = await checkOutbox('sms');
    expect(backlog).toMatchObject({ key: 'sms.backlog', alert: { severity: 'CRITICAL' } });
    expect(backlog!.alert!.message).not.toContain(phone);

    const saved = env.SMS_PROVIDER;
    env.SMS_PROVIDER = 'held';
    try {
      const [, held] = await checkOutbox('sms');
      expect(held!.alert).toMatchObject({ severity: 'WARNING' });
      expect(held!.alert!.message).toContain('No SMS provider is configured');
    } finally {
      env.SMS_PROVIDER = saved;
    }
    await drain();
    expect((await checkOutbox('sms'))[1]!.alert).toBeNull();
  });

  it('watches the backup heartbeat only when it is configured', async () => {
    const saved = env.OPS_HEARTBEAT_TOKEN;
    try {
      await db.delete(opsHeartbeats).where(eq(opsHeartbeats.name, 'backup'));
      const in27h = new Date(Date.now() + 27 * HOUR);
      env.OPS_HEARTBEAT_TOKEN = undefined;
      expect(await checkBackup(in27h)).toEqual([{ key: 'backup.stale', alert: null }]);

      env.OPS_HEARTBEAT_TOKEN = 'test-heartbeat-token-0123456789';
      // Never reported: counted from the start of the API.
      expect((await checkBackup())[0]!.alert).toBeNull();
      const [never] = await checkBackup(in27h);
      expect(never!.alert).toMatchObject({ severity: 'CRITICAL' });
      expect(never!.alert!.message).toContain('since the API started');

      await db.insert(opsHeartbeats).values({ name: 'backup', lastOkAt: new Date() });
      expect((await checkBackup())[0]!.alert).toBeNull();
      const [late] = await checkBackup(in27h);
      expect(late!.alert!.message).toMatch(
        /No successful database backup has been reported for 27 hours/,
      );
    } finally {
      env.OPS_HEARTBEAT_TOKEN = saved;
    }
  });

  it('applies its decisions in one recorded run: raises, then resolves only what is open', async () => {
    // Another API instance runs proms and raised its alert; this one does not run proms, so it
    // cannot judge it and leaves it as it is – resolving it would make it come and go (ops-4).
    await raiseOperatorAlert('worker.stale:proms', { severity: 'WARNING', message: 'Stopped' });
    const raised = (await alertRow('worker.stale:proms'))!;
    const resolvedBefore = (await auditFor('platform.alert_resolved', raised.id)).length;
    const since = new Date();
    const result = await recordRun('watchdog', () => runWatchdogOnce());
    expect(result).toMatchObject({ checked: expect.any(Number) });
    const kept = (await alertRow('worker.stale:proms'))!;
    expect(kept.resolvedAt).toBeNull();
    expect(kept.firstSeenAt).toEqual(raised.firstSeenAt);
    expect(await auditFor('platform.alert_resolved', raised.id)).toHaveLength(resolvedBefore);
    // A worker this process runs is resolved here once it succeeds again.
    registerWorker('infection', HOUR);
    await raiseOperatorAlert('worker.stale:infection', { severity: 'WARNING', message: 'Stopped' });
    await runWatchdogOnce();
    expect((await alertRow('worker.stale:infection'))!.resolvedAt).not.toBeNull();
    await resolveOperatorAlert('worker.stale:proms');

    const [run] = await db
      .select()
      .from(workerRuns)
      .where(and(eq(workerRuns.worker, 'watchdog'), sql`${workerRuns.startedAt} >= ${since}`))
      .orderBy(desc(workerRuns.id))
      .limit(1);
    expect(run!.ok).toBe(true);
    expect(Object.keys(run!.summary!).sort()).toEqual(['checked', 'raised', 'resolved']);

    // Registered here and stale ten minutes from now: raised by a pass at that time.
    registerWorker('maternity', MINUTE);
    await runWatchdogOnce(new Date(Date.now() + 10 * MINUTE));
    expect((await alertRow('worker.stale:maternity'))!.resolvedAt).toBeNull();
    await resolveOperatorAlert('worker.stale:maternity');
  });

  it('resolves a stalled job’s alert that no instance raises any more, never one that is raised', async () => {
    // mental-health is not started in this process. Another instance that runs it and finds it
    // stalled raises the alert again at every pass (every 10 minutes).
    const key = 'worker.stale:mental-health';
    await raiseOperatorAlert(key, { severity: 'WARNING', message: 'Stopped' });
    const raised = (await alertRow(key))!;
    const lastSeen = (minutesAgo: number) =>
      db
        .update(operatorAlerts)
        .set({ lastSeenAt: new Date(Date.now() - minutesAgo * MINUTE) })
        .where(eq(operatorAlerts.id, raised.id));
    try {
      // Raised just now, or 50 minutes ago: still that instance's to judge.
      await runWatchdogOnce();
      expect((await alertRow(key))!.resolvedAt).toBeNull();
      await lastSeen(50);
      await runWatchdogOnce();
      expect((await alertRow(key))!.resolvedAt).toBeNull();

      // Nobody has raised it for over an hour (the job was switched off everywhere): resolved,
      // so that it does not stay on the Overview for good.
      await lastSeen(61);
      await runWatchdogOnce();
      expect((await alertRow(key))!.resolvedAt).not.toBeNull();
      const [resolved] = await auditFor('platform.alert_resolved', raised.id);
      expect(resolved!.metadata).toMatchObject({ conditionKey: key });
    } finally {
      await resolveOperatorAlert(key);
    }

    // Only stalled-job alerts this process did not decide on: its own workers and the other
    // conditions are decided by their checks.
    const old = new Date(Date.now() - 2 * HOUR);
    expect(
      abandonedWorkerAlerts(
        [
          { conditionKey: 'worker.stale:mental-health', lastSeenAt: old },
          { conditionKey: 'worker.stale:sepsis', lastSeenAt: old },
          { conditionKey: 'backup.stale', lastSeenAt: old },
        ],
        [{ key: 'worker.stale:sepsis', alert: { severity: 'CRITICAL', message: 'Stopped' } }],
      ),
    ).toEqual([{ key: 'worker.stale:mental-health', alert: null }]);
  });
});

/* ------------------------------------------------------------------ health and metrics ------ */

describe('workers and backups on System health and /metrics', () => {
  afterEach(() => clearWorkerStatusCache());

  it('shows the national view each worker’s last run, success, error and whether it is stale', async () => {
    registerWorker('proms', HOUR);
    await recordRun('proms', async () => ({ reminded: 2 }));
    // The next run starts later (two runs started in the same millisecond tie on started_at).
    await new Promise((resolve) => setTimeout(resolve, 5));
    const recordId = randomUUID();
    await recordRun('proms', async () => {
      throw new Error(`Could not reach mail for person@example.org about row ${recordId}`);
    });
    // Due every millisecond, but every worker is given at least 5 minutes (ops-2).
    registerWorker('licences', 1);
    // A run recorded before failed queries were unwrapped: it holds the SQL and a patient's
    // name. charge-capture is not started in this process (another instance's worker).
    const old = new Date(Date.now() - MINUTE);
    const [legacy] = await db
      .insert(workerRuns)
      .values({
        worker: 'charge-capture',
        startedAt: old,
        finishedAt: old,
        ok: false,
        error: `Failed query: select "first_name" from "patients" where "id" = $1\nparams: ${recordId},Arben Krasniqi`,
      })
      .returning({ id: workerRuns.id });
    clearWorkerStatusCache();

    try {
      for (const token of [admin.token, w.tokens.ministry]) {
        const res = await api().get('/api/v1/monitoring/health').set(bearer(token));
        expect(res.status).toBe(200);
        const workers = res.body.workers as Record<string, unknown>[];
        const proms = workers.find((x) => x.name === 'proms')!;
        expect(proms).toMatchObject({
          running: true,
          intervalSeconds: 3600,
          staleAfterSeconds: 10_800,
          lastRunOk: false,
          stale: false,
        });
        expect(proms.lastOkAt).toEqual(expect.any(String));
        expect((proms.lastError as { text: string }).text).toBe(
          'Error: Could not reach mail for …@… about row …',
        );
        expect(workers.find((x) => x.name === 'licences')).toMatchObject({
          staleAfterSeconds: 300,
          stale: false,
        });
        // Not run by this instance: shown with its last run and error, but not judged.
        expect(workers.find((x) => x.name === 'charge-capture')).toMatchObject({
          running: false,
          intervalSeconds: null,
          staleAfterSeconds: null,
          stale: null,
          lastRunOk: false,
          lastError: {
            text: 'DrizzleQueryError: a database query failed (its cause was not recorded)',
          },
        });
        expect(JSON.stringify(res.body)).not.toContain('Arben');
        expect(JSON.stringify(res.body)).not.toContain(recordId);
        expect(res.body.backups).toMatchObject({ maxAgeHours: 26 });
      }
    } finally {
      await db.delete(workerRuns).where(eq(workerRuns.id, legacy!.id));
    }
    // Six minutes on, licences is stalled.
    const later = await workerStatuses({ now: new Date(Date.now() + 6 * MINUTE), fresh: true });
    expect(later.find((s) => s.name === 'licences')!.stale).toBe(true);

    // A director sees their facility's indicators, not the service's workers or backups.
    const own = await api().get('/api/v1/monitoring/health').set(bearer(w.tokens.director));
    expect(own.status).toBe(200);
    expect(own.body.workers).toBeNull();
    expect(own.body.backups).toBeNull();
  });

  it('exports the real last success, the threshold and the process start for Prometheus (ops-7)', async () => {
    registerWorker('proms', HOUR);
    // An hour after the process started, so that it cannot be mistaken for the process start.
    const finishedAt = new Date(PROCESS_STARTED_AT.getTime() + HOUR + 1234);
    await insertRun('proms', finishedAt);
    // Never ran (no test records it): no last success, whatever the process start.
    registerWorker('screening', HOUR);
    registerWorker('equipment', 5_000);
    clearWorkerStatusCache();
    try {
      const res = await api().get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toContain('# TYPE pacient_worker_last_success_timestamp_seconds gauge');
      expect(res.text).toContain(
        `pacient_worker_last_success_timestamp_seconds{worker="proms"} ${Math.floor(finishedAt.getTime() / 1000)}\n`,
      );
      expect(res.text).toContain(
        'pacient_worker_last_success_timestamp_seconds{worker="screening"} 0\n',
      );
      expect(res.text).toContain(
        `pacient_process_start_time_seconds ${Math.floor(PROCESS_STARTED_AT.getTime() / 1000)}\n`,
      );
      expect(res.text).toContain('pacient_worker_expected_interval_seconds{worker="proms"} 3600');
      expect(res.text).toContain('pacient_worker_stale_after_seconds{worker="proms"} 10800');
      // Every 5 seconds, but given 5 minutes.
      expect(res.text).toContain('pacient_worker_stale_after_seconds{worker="equipment"} 300');
      // Workers this process does not run are not exported (the rule judges per instance).
      expect(res.text).not.toContain('{worker="charge-capture"}');
    } finally {
      await db
        .delete(workerRuns)
        .where(and(eq(workerRuns.worker, 'proms'), eq(workerRuns.finishedAt, finishedAt)));
    }
  });

  it('judges a cached answer at the time it was read, not when it is served (ops-2)', async () => {
    registerWorker('complaints', MINUTE);
    const at = new Date(Date.now() + 3 * HOUR);
    // 4 minutes 55 seconds before `at`: 5 seconds short of stalled.
    await insertRun('complaints', new Date(at.getTime() - 5 * MINUTE + 5_000));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(at);
      clearWorkerStatusCache();
      const fresh = await workerStatuses();
      expect(fresh.find((s) => s.name === 'complaints')!.stale).toBe(false);
      // Served from the cache 14 seconds later: still what was true when it was read.
      vi.setSystemTime(at.getTime() + 14_000);
      const cached = await workerStatuses();
      expect(cached.find((s) => s.name === 'complaints')!.stale).toBe(false);
      // Read again then: stalled.
      const reread = await workerStatuses({ fresh: true });
      expect(reread.find((s) => s.name === 'complaints')!.stale).toBe(true);
    } finally {
      vi.useRealTimers();
      await db
        .delete(workerRuns)
        .where(
          and(
            eq(workerRuns.worker, 'complaints'),
            sql`${workerRuns.startedAt} > now() + interval '1 hour'`,
          ),
        );
    }
  });

  it('reads the runs through the indexes, without sorting them (ops-3)', async () => {
    const plan = await db.transaction(async (tx) => {
      // On a small table a scan is cheaper; what matters is that no sort is needed.
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      const { rows } = await tx.execute<Record<string, unknown>>(
        sql`EXPLAIN (FORMAT JSON) ${lastRunsQuery()}`,
      );
      return JSON.stringify(rows[0]);
    });
    expect(plan).toContain('worker_runs_worker_idx');
    expect(plan).toContain('worker_runs_failed_idx');
    expect(plan).not.toMatch(/"Node Type":\s*"(Incremental )?Sort"/);
  });
});

/* ------------------------------------------------------------------ heartbeat --------------- */

describe('backup heartbeat', () => {
  const TOKEN = 'test-heartbeat-token-0123456789';
  const beat = (token?: string, body: Record<string, unknown> = {}) => {
    const r = api().post('/api/v1/ops/heartbeat/backup');
    return (token ? r.set(bearer(token)) : r).send(body);
  };
  let saved: string | undefined;
  beforeAll(() => {
    saved = env.OPS_HEARTBEAT_TOKEN;
  });
  afterEach(() => {
    env.OPS_HEARTBEAT_TOKEN = saved;
  });

  it('is switched off without OPS_HEARTBEAT_TOKEN', async () => {
    env.OPS_HEARTBEAT_TOKEN = undefined;
    expect((await beat(TOKEN)).status).toBe(404);
  });

  it('needs the token', async () => {
    env.OPS_HEARTBEAT_TOKEN = TOKEN;
    expect((await beat()).status).toBe(401);
    expect((await beat('test-heartbeat-token-0123456780')).status).toBe(401);
    expect((await beat('short')).status).toBe(401);
    // A user's access token is not the heartbeat token.
    expect((await beat(admin.token)).status).toBe(401);
  });

  it('records the backup with sizes and durations only, and resolves the alert', async () => {
    env.OPS_HEARTBEAT_TOKEN = TOKEN;
    await raiseOperatorAlert('backup.stale', { severity: 'CRITICAL', message: 'Old backup' });
    const before = Date.now();
    const res = await beat(TOKEN, { sizeBytes: 123_456, durationSeconds: 42.5 });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(opsHeartbeats).where(eq(opsHeartbeats.name, 'backup'));
    expect(row!.lastOkAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.detail).toEqual({ sizeBytes: 123_456, durationSeconds: 42.5 });
    expect((await alertRow('backup.stale'))!.resolvedAt).not.toBeNull();

    // Anything else is refused: no paths, names or free text reach the database.
    expect((await beat(TOKEN, { file: '/var/backups/pacient-x.dump' })).status).toBe(400);
    expect((await beat(TOKEN, { sizeBytes: -1 })).status).toBe(400);
    expect((await beat(TOKEN, { sizeBytes: 'big' })).status).toBe(400);
    // Without details is fine.
    expect((await beat(TOKEN)).status).toBe(200);

    const health = await api().get('/api/v1/monitoring/health').set(bearer(admin.token));
    expect(health.body.backups).toMatchObject({ monitored: true, stale: false, detail: null });
    expect(new Date(health.body.backups.lastOkAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });
});

/* ------------------------------------------------------------------ e-mail ------------------ */

describe('test e-mail', () => {
  const send = (token: string) =>
    api().post('/api/v1/admin/platform/test-email').set(bearer(token)).send({});
  const testMails = (userId: string) =>
    db
      .select()
      .from(emailOutbox)
      .where(and(eq(emailOutbox.userId, userId), eq(emailOutbox.template, 'test_email')));
  const audits = (userId: string) =>
    db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'platform.test_email_sent'), eq(auditLogs.actorUserId, userId)),
      );

  it('queues one message to the caller’s own address, audited, at most once a minute', async () => {
    const res = await send(admin.token);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ to: admin.email, deliveryConfigured: true });
    const [queued] = await testMails(admin.id);
    expect(queued!.toEmail).toBe(admin.email);
    const [audited] = await audits(admin.id);
    expect(audited).toMatchObject({
      actorRole: 'ADMIN',
      resourceType: 'user',
      resourceId: admin.id,
      outcome: 'SUCCESS',
    });

    // Again within the minute: refused, nothing queued or audited.
    const again = await send(admin.token);
    expect(again.status).toBe(429);
    expect(await testMails(admin.id)).toHaveLength(1);
    expect(await audits(admin.id)).toHaveLength(1);

    // A minute later it may be sent again.
    await db
      .update(emailOutbox)
      .set({ createdAt: new Date(Date.now() - 2 * MINUTE) })
      .where(eq(emailOutbox.id, queued!.id));
    expect((await send(admin.token)).status).toBe(202);
    expect(await testMails(admin.id)).toHaveLength(2);
  });

  it('is written in the administrator’s language and delivered like every e-mail', async () => {
    expect((await send(albanianAdmin.token)).status).toBe(202);
    await drain();
    const mail = sentEmails.find(
      (m) => m.to === albanianAdmin.email && m.subject === 'Pacient: e-mail provë',
    );
    expect(mail!.text).toContain('dërgimi i e-mailit funksionon');
    expect(mail!.html).toContain('<html lang="sq">');
  });

  it('queues nothing when its audit entry cannot be written', async () => {
    const other = await createUser('ADMIN');
    const token = await login(other.email);
    await withFailingAudit(other.id, async () => {
      expect((await send(token)).status).toBe(500);
    });
    expect(await testMails(other.id)).toHaveLength(0);
  });

  it('is for the platform administrator only', async () => {
    for (const token of [w.tokens.ministry, w.tokens.director, w.tokens.doctor, w.tokens.patient]) {
      expect((await send(token)).status).toBe(403);
    }
    expect((await api().post('/api/v1/admin/platform/test-email').send({})).status).toBe(401);
  });
});

describe('Reply-To', () => {
  it('is the support address from the operator settings when it is set', async () => {
    const [settings] = await db.select().from(platformSettings).where(eq(platformSettings.id, 1));
    const saved = settings?.supportEmail ?? null;
    try {
      await db
        .update(platformSettings)
        .set({ supportEmail: 'help@operator.test' })
        .where(eq(platformSettings.id, 1));
      const to = `reply-${randomUUID().slice(0, 8)}@test.local`;
      await enqueueEmail(db, { to, template: 'test_email', locale: 'en', name: 'Reply' });
      await drain();
      expect(sentEmails.find((m) => m.to === to)!.replyTo).toBe('help@operator.test');

      await db
        .update(platformSettings)
        .set({ supportEmail: null })
        .where(eq(platformSettings.id, 1));
      const plain = `noreply-${randomUUID().slice(0, 8)}@test.local`;
      await enqueueEmail(db, { to: plain, template: 'test_email', locale: 'en', name: 'Plain' });
      await drain();
      expect(sentEmails.find((m) => m.to === plain)!.replyTo).toBeUndefined();
    } finally {
      await db
        .update(platformSettings)
        .set({ supportEmail: saved })
        .where(eq(platformSettings.id, 1));
    }
  });
});

describe('recent e-mail failures', () => {
  it('masks addresses and never shows a subject or a body', async () => {
    expect(maskEmail('jane.doe@example.org')).toBe('j***@example.org');
    expect(maskEmail('not-an-address')).toBe('***');
    expect(maskErrorText('550 <jane.doe@example.org>: no such user 1234567890')).toBe(
      '550 <j***@example.org>: no such user …',
    );

    const tag = randomUUID().slice(0, 8);
    const failed = `given-up-${tag}@example.org`;
    const retrying = `retrying-${tag}@example.org`;
    await enqueueEmail(db, { to: failed, template: 'test_email', locale: 'en', name: 'A' });
    await enqueueEmail(db, { to: retrying, template: 'test_email', locale: 'en', name: 'B' });
    await db
      .update(emailOutbox)
      .set({
        status: 'FAILED',
        attempts: 6,
        lastError: `550 5.1.1 <${failed}>: Recipient address rejected`,
        nextAttemptAt: new Date(Date.now() - MINUTE),
        subjectSealed: null,
        textSealed: null,
        htmlSealed: null,
      })
      .where(eq(emailOutbox.toEmail, failed));
    await db
      .update(emailOutbox)
      .set({
        attempts: 2,
        lastError: 'Connection timeout',
        nextAttemptAt: new Date(Date.now() + 2 * MINUTE),
      })
      .where(eq(emailOutbox.toEmail, retrying));

    const res = await api().get('/api/v1/admin/platform/email-failures').set(bearer(admin.token));
    expect(res.status).toBe(200);
    expect(res.body.failedLast24h).toBeGreaterThanOrEqual(1);
    expect(res.body.retrying).toBeGreaterThanOrEqual(1);
    expect(res.body.maxAttempts).toBe(6);
    expect(JSON.stringify(res.body)).not.toContain(failed);
    expect(JSON.stringify(res.body)).not.toContain(retrying);
    const items = res.body.items as Record<string, unknown>[];
    const gaveUp = items.find((i) => i.recipient === `g***@example.org` && i.status === 'FAILED')!;
    expect(gaveUp).toMatchObject({
      template: 'test_email',
      attempts: 6,
      lastError: '550 5.1.1 <g***@example.org>: Recipient address rejected',
      nextAttemptAt: null,
    });
    expect(gaveUp.failedAt).toEqual(expect.any(String));
    const again = items.find((i) => i.recipient === `r***@example.org` && i.status === 'RETRYING')!;
    expect(again).toMatchObject({ attempts: 2, lastError: 'Connection timeout', failedAt: null });
    expect(Object.keys(again).sort()).toEqual(
      [
        'attempts',
        'createdAt',
        'failedAt',
        'id',
        'lastError',
        'nextAttemptAt',
        'recipient',
        'status',
        'template',
      ].sort(),
    );
    await db.delete(emailOutbox).where(like(emailOutbox.toEmail, `%-${tag}@example.org`));

    for (const token of [w.tokens.ministry, w.tokens.director]) {
      expect(
        (await api().get('/api/v1/admin/platform/email-failures').set(bearer(token))).status,
      ).toBe(403);
    }
  });
});

/* ------------------------------------------------------------------ smoke test -------------- */

describe('deploy/smoke-test.mjs --mail-domain', () => {
  const script = fileURLToPath(new URL('../../../deploy/smoke-test.mjs', import.meta.url));

  /** Runs the e-mail checks against a made-up zone (the script's DNS look-ups are replaced). */
  async function smokeTest(domain: string, zone: Record<string, string[]>) {
    const mock = `import { Resolver } from 'node:dns/promises';
      const zone = ${JSON.stringify(zone)};
      Resolver.prototype.resolveTxt = async (name) => {
        if (zone[name]) return zone[name].map((r) => [r]);
        throw Object.assign(new Error('queryTxt ENOTFOUND ' + name), { code: 'ENOTFOUND' });
      };`;
    const args = ['--import', `data:text/javascript,${encodeURIComponent(mock)}`, script];
    return new Promise<{ code: number; out: string }>((resolve) => {
      execFile(process.execPath, [...args, '--mail-domain', domain], (err, stdout) => {
        resolve({ code: err ? Number(err.code) : 0, out: stdout });
      });
    });
  }

  it('accepts the DMARC record of the parent domain for a subdomain, with its sp= policy (ops-5)', async () => {
    const spf = 'v=spf1 include:_spf.provider.example -all';
    const parent = await smokeTest('pacienti.example.tech', {
      'pacienti.example.tech': [spf],
      '_dmarc.example.tech': ['v=DMARC1; p=reject; sp=quarantine'],
    });
    expect(parent.out).toContain(
      'OK    DMARC record of pacienti.example.tech – sp=quarantine (from _dmarc.example.tech)',
    );
    expect(parent.code).toBe(0);

    // Without sp= the parent's p= applies; the subdomain's own record comes first.
    const policy = await smokeTest('pacienti.example.tech', {
      'pacienti.example.tech': [spf],
      '_dmarc.example.tech': ['v=DMARC1; p=none'],
    });
    expect(policy.out).toContain('p=none (from _dmarc.example.tech): reports only');
    const own = await smokeTest('pacienti.example.tech', {
      'pacienti.example.tech': [spf],
      '_dmarc.pacienti.example.tech': ['v=DMARC1; p=quarantine'],
      '_dmarc.example.tech': ['v=DMARC1; p=none'],
    });
    expect(own.out).toContain('OK    DMARC record of pacienti.example.tech – p=quarantine\n');

    // No record anywhere: still a failure.
    const none = await smokeTest('pacienti.example.tech', { 'pacienti.example.tech': [spf] });
    expect(none.out).toContain(
      'FAIL  DMARC record of pacienti.example.tech – no TXT record "v=DMARC1; p=…" at _dmarc.pacienti.example.tech or at its parent domains',
    );
    expect(none.code).toBe(1);
  });
});
