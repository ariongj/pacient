import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { emailOutbox } from '../src/db/schema.js';
import { MAX_ATTEMPTS, processOutboxOnce } from '../src/modules/email/outbox.js';
import { sentEmails, setTransportForTests } from '../src/modules/email/transport.js';
import { api, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});
afterEach(() => setTransportForTests(null));

/** Delivers everything due (one pass handles a batch of 20). */
async function drain() {
  while ((await processOutboxOnce()) > 0) {
    /* keep going */
  }
}
const mailTo = (email: string) => sentEmails.filter((m) => m.to === email.toLowerCase());
const outboxFor = (email: string) =>
  db.select().from(emailOutbox).where(eq(emailOutbox.toEmail, email.toLowerCase()));

describe('transactional email outbox', () => {
  it('queues activation emails with the invitation, encrypted at rest, erased after delivery', async () => {
    const email = `nurse-${Date.now()}@test.local`;
    await api()
      .post('/api/v1/staff/invitations')
      .set(bearer(w.tokens.director))
      .send({ email, fullName: 'Nurse Email', role: 'NURSE', licenseNumber: 'N-77' })
      .expect(201);
    const [queued] = await outboxFor(email);
    expect(queued).toMatchObject({ status: 'PENDING', template: 'activation' });
    expect(queued!.textSealed).not.toContain('token=');
    expect(queued!.subjectSealed).toMatch(/^v1\./);

    await drain();
    const [mail] = mailTo(email);
    expect(mail!.subject).toBe('Activate your Pacient account');
    expect(mail!.text).toMatch(/\/activate\?token=/);
    expect(mail!.html).toContain('Choose a password');
    const [sent] = await outboxFor(email);
    expect(sent).toMatchObject({
      status: 'SENT',
      subjectSealed: null,
      textSealed: null,
      htmlSealed: null,
    });
  });

  it('enqueues nothing when the change rolls back', async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(emailOutbox);
    const dup = await api().post('/api/v1/staff/invitations').set(bearer(w.tokens.director)).send({
      email: w.users.doctor.email,
      fullName: 'Duplicate',
      role: 'DOCTOR',
      licenseNumber: 'D-1',
    });
    expect(dup.status).toBe(409);
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(emailOutbox);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('retries with backoff, then gives up and erases the content', async () => {
    const email = `retry-${Date.now()}@test.local`;
    await api()
      .post('/api/v1/staff/invitations')
      .set(bearer(w.tokens.director))
      .send({ email, fullName: 'Retry Me', role: 'RECEPTION' });
    // Make this the oldest message so the worker claims it first.
    await db
      .update(emailOutbox)
      .set({ createdAt: new Date(0) })
      .where(eq(emailOutbox.toEmail, email));
    setTransportForTests({
      send: async () => Promise.reject(new Error('SMTP 421 try again later')),
    });
    await processOutboxOnce();
    let [row] = await outboxFor(email);
    expect(row).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      lastError: 'SMTP 421 try again later',
    });
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await db
      .update(emailOutbox)
      .set({ attempts: MAX_ATTEMPTS - 1, nextAttemptAt: new Date(0) })
      .where(eq(emailOutbox.id, row!.id));
    await processOutboxOnce();
    [row] = await outboxFor(email);
    expect(row).toMatchObject({ status: 'FAILED', textSealed: null });
  });

  it('never sends a message twice when workers run concurrently', async () => {
    const stamp = Date.now();
    const emails = Array.from({ length: 6 }, (_, i) => `concurrent-${stamp}-${i}@test.local`);
    for (const email of emails) {
      await api()
        .post('/api/v1/staff/invitations')
        .set(bearer(w.tokens.director))
        .send({ email, fullName: 'Parallel Person', role: 'RECEPTION' });
    }
    let calls = 0;
    setTransportForTests({
      send: async (m) => {
        calls += emails.includes(m.to) ? 1 : 0;
        await new Promise((r) => setTimeout(r, 20));
      },
    });
    await Promise.all([processOutboxOnce(), processOutboxOnce(), processOutboxOnce()]);
    expect(calls).toBe(emails.length);
  });
});

describe('notification emails', () => {
  it('follow each user’s preference and contain no clinical details', async () => {
    const prefs = (token: string, emailNotifications: string) =>
      api().patch('/api/v1/auth/me/preferences').set(bearer(token)).send({ emailNotifications });
    expect((await prefs(w.tokens.patient, 'SOMETIMES')).status).toBe(400);
    await prefs(w.tokens.patient, 'OFF').expect(200);

    const base = `/api/v1/patients/${w.patient.id}`;
    const release = async (testName: string) => {
      const r = await api()
        .post(`${base}/lab-results`)
        .set(bearer(w.tokens.doctor))
        .send({ testName, value: 'Positive' });
      await api().post(`${base}/lab-results/${r.body.id}/acknowledge`).set(bearer(w.tokens.doctor));
      await api()
        .post(`${base}/lab-results/${r.body.id}/release`)
        .set(bearer(w.tokens.doctor))
        .expect(200);
    };
    await release('Chlamydia PCR');
    await drain();
    expect(mailTo(w.users.patientUser.email)).toHaveLength(0);

    await prefs(w.tokens.patient, 'IMPORTANT').expect(200);
    await release('Hepatitis C antibody');
    await drain();
    const mails = mailTo(w.users.patientUser.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe('Pacient: A new test result is available');
    expect(mails[0]!.text).not.toMatch(/Hepatitis|Positive/);
    expect(mails[0]!.text).toContain('http://localhost:5173/portal/results');

    const me = await api().get('/api/v1/auth/me').set(bearer(w.tokens.patient));
    expect(me.body.emailNotifications).toBe('IMPORTANT');
  });

  it('routine notifications are only emailed to users who want everything', async () => {
    const book = (hour: number) => {
      const at = new Date(Date.now() + 8 * 86_400_000);
      at.setUTCHours(hour, 0, 0, 0);
      return api()
        .post('/api/v1/appointments')
        .set(bearer(w.tokens.patient))
        .send({ doctorId: w.users.doctor.id, scheduledAt: at.toISOString(), reason: 'Routine' })
        .expect(201);
    };
    await book(8);
    await drain();
    expect(mailTo(w.users.doctor.email)).toHaveLength(0); // doctor default: important only

    await api()
      .patch('/api/v1/auth/me/preferences')
      .set(bearer(w.tokens.doctor))
      .send({ emailNotifications: 'ALL' })
      .expect(200);
    await book(9);
    await drain();
    expect(mailTo(w.users.doctor.email).map((m) => m.subject)).toContain(
      'Pacient: New appointment request',
    );
  });

  it('the ministry can monitor delivery health', async () => {
    const res = await api().get('/api/v1/stats/email').set(bearer(w.tokens.ministry));
    expect(res.status).toBe(200);
    expect(res.body.SENT.count).toBeGreaterThan(0);
    expect((await api().get('/api/v1/stats/email').set(bearer(w.tokens.director))).status).toBe(
      403,
    );
  });
});
