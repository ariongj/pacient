import { eq, inArray } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  dataSubjectRequests,
  emailOutbox,
  legalHolds,
  notifications,
  patients,
  retentionPolicies,
} from '../src/db/schema.js';
import { AuditAction } from '../src/modules/audit/audit.service.js';
import { runRetentionOnce } from '../src/modules/privacy/retention.js';
import {
  api,
  bearer,
  createPatient,
  createUser,
  createWorld,
  login,
  nextNationalId,
} from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let child: typeof patients.$inferSelect;
let fullParentToken: string;
let apptParentToken: string;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

beforeAll(async () => {
  w = await createWorld();
  child = (
    await db
      .insert(patients)
      .values({
        nationalId: nextNationalId(),
        firstName: 'Arta',
        lastName: 'Privacy',
        dateOfBirth: '2018-03-02',
        sex: 'FEMALE',
        primaryFacilityId: w.facility.id,
      })
      .returning()
  )[0]!;
  const fullParent = await createUser('PATIENT');
  const apptParent = await createUser('PATIENT');
  for (const [u, scope] of [
    [fullParent, 'FULL'],
    [apptParent, 'APPOINTMENTS'],
  ] as const) {
    const res = await api()
      .post(`/api/v1/patients/${child.id}/guardians`)
      .set(bearer(w.tokens.reception))
      .send({
        email: u.email,
        fullName: u.fullName,
        relationship: 'PARENT',
        evidence: 'Birth certificate 99/2018',
        scope,
      });
    expect(res.status).toBe(201);
  }
  fullParentToken = await login(fullParent.email);
  apptParentToken = await login(apptParent.email);
});

describe('retention', () => {
  it('lists the default policies to directors and the Ministry only', async () => {
    const res = await api().get('/api/v1/privacy/retention').set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    expect(res.body.canEdit).toBe(false);
    const categories = res.body.items.map((i: { category: string }) => i.category);
    expect(categories).toEqual(expect.arrayContaining(['EMAIL_OUTBOX', 'NOTIFICATIONS_READ']));
    expect(categories.some((c: string) => /AUDIT/.test(c))).toBe(false);
    for (const token of [w.tokens.doctor, w.tokens.reception, w.tokens.patient]) {
      expect((await api().get('/api/v1/privacy/retention').set(bearer(token))).status).toBe(403);
    }
  });

  it('lets only the Ministry change a policy, with an audit entry', async () => {
    const body = { retainDays: 120, legalBasis: 'Ministry instruction 1/2026 on storage limits' };
    expect(
      (
        await api()
          .patch('/api/v1/privacy/retention/EMAIL_OUTBOX')
          .set(bearer(w.tokens.director))
          .send(body)
      ).status,
    ).toBe(403);
    const res = await api()
      .patch('/api/v1/privacy/retention/EMAIL_OUTBOX')
      .set(bearer(w.tokens.ministry))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.retainDays).toBe(120);
    const logged = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, AuditAction.RETENTION_POLICY_CHANGED));
    expect(logged.length).toBeGreaterThan(0);
    expect(
      (
        await api()
          .patch('/api/v1/privacy/retention/AUDIT_LOGS')
          .set(bearer(w.tokens.ministry))
          .send({ retainDays: 1 })
      ).status,
    ).toBe(404);
    await api()
      .patch('/api/v1/privacy/retention/EMAIL_OUTBOX')
      .set(bearer(w.tokens.ministry))
      .send({ retainDays: 90 });
  });

  it('purges only eligible rows, respects legal holds, previews without deleting and never touches the audit trail', async () => {
    const heldUser = await createUser('PATIENT');
    const held = await createPatient(w.facility.id, { userId: heldUser.id });
    await db.insert(legalHolds).values({
      patientId: held.id,
      reason: 'Court case 12/2026',
      createdById: w.users.director.id,
    });

    const mail = (userId: string, status: 'SENT' | 'PENDING', createdAt: Date) => ({
      userId,
      toEmail: 'x@test.local',
      template: 'notification',
      status,
      createdAt,
    });
    const rows = await db
      .insert(emailOutbox)
      .values([
        mail(w.users.patientUser.id, 'SENT', ago(200)), // eligible
        mail(w.users.patientUser.id, 'SENT', ago(10)), // too recent
        mail(w.users.patientUser.id, 'PENDING', ago(200)), // not delivered yet
        mail(heldUser.id, 'SENT', ago(200)), // on legal hold
      ])
      .returning({ id: emailOutbox.id });
    const ids = rows.map((r) => r.id);
    const [oldRead, oldUnread] = await db
      .insert(notifications)
      .values([
        { userId: w.users.patientUser.id, type: 't', title: 'x', readAt: ago(800) },
        { userId: w.users.patientUser.id, type: 't', title: 'x', createdAt: ago(800) },
      ])
      .returning({ id: notifications.id });
    const [oldAudit] = await db
      .insert(auditLogs)
      .values({ action: 'RECORD_VIEWED', occurredAt: ago(4000) })
      .returning({ id: auditLogs.id });

    const preview = await api()
      .post('/api/v1/privacy/retention/preview')
      .set(bearer(w.tokens.director));
    expect(preview.status).toBe(200);
    expect(preview.body.dryRun).toBe(true);
    const emailCount = preview.body.categories.find(
      (c: { category: string }) => c.category === 'EMAIL_OUTBOX',
    ).count;
    expect(emailCount).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(emailOutbox).where(inArray(emailOutbox.id, ids))).toHaveLength(4);

    expect(
      (await api().post('/api/v1/privacy/retention/run').set(bearer(w.tokens.director))).status,
    ).toBe(403);
    const run = await api().post('/api/v1/privacy/retention/run').set(bearer(w.tokens.ministry));
    expect(run.status).toBe(200);
    expect(run.body.dryRun).toBe(false);
    expect(
      run.body.categories.find((c: { category: string }) => c.category === 'EMAIL_OUTBOX').count,
    ).toBe(emailCount);

    const left = (await db.select().from(emailOutbox).where(inArray(emailOutbox.id, ids))).map(
      (r) => r.id,
    );
    expect(left.sort()).toEqual([ids[1], ids[2], ids[3]].sort());
    const notes = (
      await db
        .select()
        .from(notifications)
        .where(inArray(notifications.id, [oldRead!.id, oldUnread!.id]))
    ).map((n) => n.id);
    expect(notes).toEqual([oldUnread!.id]);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.id, oldAudit!.id))).toHaveLength(1);

    const [policy] = await db
      .select()
      .from(retentionPolicies)
      .where(eq(retentionPolicies.category, 'EMAIL_OUTBOX'));
    expect(policy!.lastRunAt).toBeTruthy();
    expect(policy!.lastRunCount).toBe(emailCount);
    expect(
      await db.select().from(auditLogs).where(eq(auditLogs.action, AuditAction.RETENTION_RUN)),
    ).not.toHaveLength(0);
  });

  it('skips inactive policies', async () => {
    await db
      .update(retentionPolicies)
      .set({ isActive: false })
      .where(eq(retentionPolicies.category, 'EMAIL_OUTBOX'));
    const [row] = await db
      .insert(emailOutbox)
      .values({
        userId: w.users.patientUser.id,
        toEmail: 'x@test.local',
        template: 'notification',
        status: 'SENT',
        createdAt: ago(400),
      })
      .returning({ id: emailOutbox.id });
    const result = await runRetentionOnce(new Date());
    expect(result.categories.some((c) => c.category === 'EMAIL_OUTBOX')).toBe(false);
    expect(await db.select().from(emailOutbox).where(eq(emailOutbox.id, row!.id))).toHaveLength(1);
    await db
      .update(retentionPolicies)
      .set({ isActive: true })
      .where(eq(retentionPolicies.category, 'EMAIL_OUTBOX'));
  });
});

describe('data-subject requests', () => {
  it('lets a patient file a request with a 30-day deadline, and tells the directors', async () => {
    const res = await api()
      .post('/api/v1/privacy/my-requests')
      .set(bearer(w.tokens.patient))
      .send({ kind: 'OBJECTION', details: 'Please stop SMS reminders.' });
    expect(res.status).toBe(201);
    expect(res.body.receivedVia).toBe('PORTAL');
    expect(res.body.status).toBe('RECEIVED');
    const days =
      (new Date(res.body.dueAt).getTime() - new Date(res.body.receivedAt).getTime()) / DAY;
    expect(days).toBe(30);
    expect(res.body.overdue).toBe(false);
    const mine = await api().get('/api/v1/privacy/my-requests').set(bearer(w.tokens.patient));
    expect(mine.body.items.map((r: { id: string }) => r.id)).toContain(res.body.id);
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.director.id));
    expect(notes.some((n) => n.title === 'A new data protection request was received')).toBe(true);
    // Explanations are required except for a copy of the data.
    expect(
      (
        await api()
          .post('/api/v1/privacy/my-requests')
          .set(bearer(w.tokens.patient))
          .send({ kind: 'ERASURE' })
      ).status,
    ).toBe(400);
    // Staff cannot use the portal endpoint.
    expect(
      (
        await api()
          .post('/api/v1/privacy/my-requests')
          .set(bearer(w.tokens.doctor))
          .send({ kind: 'ACCESS' })
      ).status,
    ).toBe(403);
  });

  it('lets a full-scope guardian file for the child, but not an appointments-only one', async () => {
    const acting = { 'X-Acting-For': child.id };
    const res = await api()
      .post('/api/v1/privacy/my-requests')
      .set(bearer(fullParentToken))
      .set(acting)
      .send({ kind: 'ACCESS' });
    expect(res.status).toBe(201);
    expect(res.body.patientId).toBe(child.id);
    expect(
      (
        await api()
          .post('/api/v1/privacy/my-requests')
          .set(bearer(apptParentToken))
          .set(acting)
          .send({ kind: 'ACCESS' })
      ).status,
    ).toBe(403);
  });

  it('lets staff record in-person requests within their scope', async () => {
    const res = await api()
      .post('/api/v1/privacy/requests')
      .set(bearer(w.tokens.director))
      .send({ patientId: w.otherPatient.id, kind: 'RESTRICTION', receivedVia: 'POST' });
    expect(res.status).toBe(201);
    expect(res.body.createdById).toBe(w.users.director.id);
    expect(
      (
        await api()
          .post('/api/v1/privacy/requests')
          .set(bearer(w.tokens.otherDirector))
          .send({ patientId: w.otherPatient.id, kind: 'ACCESS', receivedVia: 'IN_PERSON' })
      ).status,
    ).toBe(403);
    const byNationalId = await api()
      .post('/api/v1/privacy/requests')
      .set(bearer(w.tokens.ministry))
      .send({ nationalId: w.patient.nationalId, kind: 'PORTABILITY', receivedVia: 'EMAIL' });
    expect(byNationalId.status).toBe(201);
    expect(byNationalId.body.patientId).toBe(w.patient.id);
    for (const token of [w.tokens.doctor, w.tokens.reception, w.tokens.patient]) {
      expect(
        (
          await api()
            .post('/api/v1/privacy/requests')
            .set(bearer(token))
            .send({ patientId: w.patient.id, kind: 'ACCESS', receivedVia: 'IN_PERSON' })
        ).status,
      ).toBe(403);
    }
  });

  it('flags overdue requests and scopes the register', async () => {
    const [late] = await db
      .insert(dataSubjectRequests)
      .values({
        patientId: w.patient.id,
        facilityId: w.facility.id,
        kind: 'ACCESS',
        receivedVia: 'POST',
        receivedAt: ago(40),
        dueAt: ago(10),
      })
      .returning();
    const res = await api()
      .get('/api/v1/privacy/requests?overdue=true')
      .set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    const row = res.body.items.find((r: { id: string }) => r.id === late!.id);
    expect(row.overdue).toBe(true);
    expect(res.body.overdueCount).toBeGreaterThanOrEqual(1);
    expect(res.body.items.every((r: { overdue: boolean }) => r.overdue)).toBe(true);
    const other = await api().get('/api/v1/privacy/requests').set(bearer(w.tokens.otherDirector));
    expect(other.body.items.some((r: { id: string }) => r.id === late!.id)).toBe(false);
    const national = await api().get('/api/v1/privacy/requests').set(bearer(w.tokens.ministry));
    expect(national.body.items.some((r: { id: string }) => r.id === late!.id)).toBe(true);
    expect((await api().get('/api/v1/privacy/requests').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
  });

  it('records the outcome, notifies the patient and audits every step', async () => {
    const created = await api()
      .post('/api/v1/privacy/my-requests')
      .set(bearer(w.tokens.patient))
      .send({ kind: 'RECTIFICATION', details: 'My address is wrong.' });
    const id = created.body.id as string;
    const patch = (token: string, body: Record<string, unknown>) =>
      api().patch(`/api/v1/privacy/requests/${id}`).set(bearer(token)).send(body);
    expect((await patch(w.tokens.otherDirector, { status: 'IN_PROGRESS' })).status).toBe(403);
    expect((await patch(w.tokens.director, { status: 'IN_PROGRESS' })).status).toBe(200);
    expect((await patch(w.tokens.director, { status: 'COMPLETED' })).status).toBe(400);
    const done = await patch(w.tokens.director, {
      status: 'COMPLETED',
      outcome: 'Address corrected at the front desk.',
    });
    expect(done.status).toBe(200);
    expect(done.body.completedAt).toBeTruthy();
    expect(done.body.handledById).toBe(w.users.director.id);
    expect((await patch(w.tokens.director, { status: 'IN_PROGRESS' })).status).toBe(409);

    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.patientUser.id));
    expect(notes.some((n) => n.title === 'Your data protection request has been answered')).toBe(
      true,
    );
    const trail = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, id));
    expect(trail.filter((a) => a.action === AuditAction.DATA_SUBJECT_REQUEST)).toHaveLength(3);
  });
});

describe('legal holds', () => {
  it('lets directors and the Ministry place and release holds with a reason', async () => {
    const patient = await createPatient(w.facility.id);
    const place = (token: string, body: Record<string, unknown>) =>
      api().post('/api/v1/privacy/holds').set(bearer(token)).send(body);
    expect(
      (await place(w.tokens.doctor, { patientId: patient.id, reason: 'Court case 1/2026' })).status,
    ).toBe(403);
    expect(
      (await place(w.tokens.otherDirector, { patientId: patient.id, reason: 'Court case 1/2026' }))
        .status,
    ).toBe(403);
    expect(
      (await place(w.tokens.director, { patientId: patient.id, reason: 'short' })).status,
    ).toBe(400);
    const res = await place(w.tokens.director, {
      patientId: patient.id,
      reason: 'Court case 1/2026 – preserve',
    });
    expect(res.status).toBe(201);
    expect(
      (
        await place(w.tokens.ministry, {
          patientId: patient.id,
          reason: 'Court case 1/2026 – again',
        })
      ).status,
    ).toBe(409);

    const status = await api()
      .get(`/api/v1/privacy/patients/${patient.id}/holds`)
      .set(bearer(w.tokens.ministry));
    expect(status.body.onHold).toBe(true);
    const list = await api().get('/api/v1/privacy/holds').set(bearer(w.tokens.director));
    expect(list.body.items.some((h: { id: string }) => h.id === res.body.id)).toBe(true);

    const release = await api()
      .post(`/api/v1/privacy/holds/${res.body.id}/release`)
      .set(bearer(w.tokens.ministry))
      .send({ reason: 'Court released the records' });
    expect(release.status).toBe(200);
    expect(release.body.releasedAt).toBeTruthy();
    expect(
      (
        await api()
          .post(`/api/v1/privacy/holds/${res.body.id}/release`)
          .set(bearer(w.tokens.ministry))
          .send({ reason: 'Court released the records' })
      ).status,
    ).toBe(409);
    const trail = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, res.body.id));
    expect(trail.filter((a) => a.action === AuditAction.LEGAL_HOLD_CHANGED)).toHaveLength(2);
  });
});
