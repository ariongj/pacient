import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { recordRun, registerWorker } from '../src/lib/worker-runs.js';
import { enqueueEmail, processOutboxOnce } from '../src/modules/email/outbox.js';
import { sentEmails } from '../src/modules/email/transport.js';
import { clearWorkerStatusCache } from '../src/modules/monitoring/operations.service.js';
import {
  ALERT_NOTIFY_EVERY_MS,
  raiseOperatorAlert,
  resolveOperatorAlert,
} from '../src/modules/platform/alerts.js';
import { maskEmail, maskErrorText } from '../src/modules/platform/operations.routes.js';
import {
  checkBackup,
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
  for (const worker of ['dialysis', 'sepsis', 'maternity', 'proms', 'licences']) {
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
    expect(n!.title).toBe(`Warning: The background job ${key.slice(13)} has stopped`);
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
    // Ten minutes from now nothing has succeeded for over three minutes.
    const later = new Date(Date.now() + 10 * MINUTE);
    const stale = (await checkWorkers(later)).find((d) => d.key === 'worker.stale:dialysis')!;
    expect(stale.alert).toMatchObject({ severity: 'WARNING' });
    expect(stale.alert!.message).toContain('"dialysis"');
    expect(stale.alert!.message).toContain('expected every 1 minute;');

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
    // A worker this process did not start (switched off) is not expected to run.
    expect(decisions.find((d) => d.key === 'worker.stale:proms')!.alert).toBeNull();
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
    // An alert of a worker that is not started here, left open: resolved by the next pass.
    await raiseOperatorAlert('worker.stale:proms', { severity: 'WARNING', message: 'Stopped' });
    const since = new Date();
    const result = await recordRun('watchdog', () => runWatchdogOnce());
    expect(result).toMatchObject({ checked: expect.any(Number) });
    expect((await alertRow('worker.stale:proms'))!.resolvedAt).not.toBeNull();

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
});

/* ------------------------------------------------------------------ health and metrics ------ */

describe('workers and backups on System health and /metrics', () => {
  afterEach(() => clearWorkerStatusCache());

  it('shows the national view each worker’s last run, success, error and whether it is stale', async () => {
    registerWorker('proms', HOUR);
    await recordRun('proms', async () => ({ reminded: 2 }));
    const recordId = randomUUID();
    await recordRun('proms', async () => {
      throw new Error(`Could not reach mail for person@example.org about row ${recordId}`);
    });
    // Due every millisecond: stale at once.
    registerWorker('licences', 1);
    clearWorkerStatusCache();

    for (const token of [admin.token, w.tokens.ministry]) {
      const res = await api().get('/api/v1/monitoring/health').set(bearer(token));
      expect(res.status).toBe(200);
      const proms = (res.body.workers as Record<string, unknown>[]).find(
        (x) => x.name === 'proms',
      )!;
      expect(proms).toMatchObject({
        running: true,
        intervalSeconds: 3600,
        lastRunOk: false,
        stale: false,
      });
      expect(proms.lastOkAt).toEqual(expect.any(String));
      expect((proms.lastError as { text: string }).text).toContain('Could not reach mail');
      expect((proms.lastError as { text: string }).text).not.toContain('person@example.org');
      expect((proms.lastError as { text: string }).text).not.toContain(recordId);
      const licences = (res.body.workers as { name: string; stale: boolean }[]).find(
        (x) => x.name === 'licences',
      )!;
      expect(licences.stale).toBe(true);
      expect(res.body.backups).toMatchObject({ maxAgeHours: 26 });
    }

    // A director sees their facility's indicators, not the service's workers or backups.
    const own = await api().get('/api/v1/monitoring/health').set(bearer(w.tokens.director));
    expect(own.status).toBe(200);
    expect(own.body.workers).toBeNull();
    expect(own.body.backups).toBeNull();
  });

  it('exports the last success and the expected interval of each worker for Prometheus', async () => {
    registerWorker('proms', HOUR);
    await recordRun('proms', async () => 1);
    clearWorkerStatusCache();
    const res = await api().get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('# TYPE pacient_worker_last_success_timestamp_seconds gauge');
    const m = /pacient_worker_last_success_timestamp_seconds\{worker="proms"\} (\d+)/.exec(
      res.text,
    );
    expect(Math.abs(Number(m![1]) - Date.now() / 1000)).toBeLessThan(120);
    expect(res.text).toContain('pacient_worker_expected_interval_seconds{worker="proms"} 3600');
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
