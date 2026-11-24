import { and, eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  emailOutbox,
  notifications,
  operatorRequestMessages,
  operatorRequests,
} from '../src/db/schema.js';
import { AuditAction } from '../src/modules/audit/audit.service.js';
import { looksLikePersonalNumber } from '../src/modules/requests/requests.service.js';
import { api, bearer, createUser, createWorld, login } from './helpers.js';

/**
 * Requests from a facility's directors and IT support to the operator: own facility only, never
 * about a patient, every change audited with its transaction, administrators and requesters told.
 * Administrators of other test files share the database and are told too; the assertions look at
 * this file's own accounts only.
 */

let w: Awaited<ReturnType<typeof createWorld>>;
type Account = { id: string; email: string; token: string };
let admin: Account;
let quietAdmin: Account;
let disabledAdmin: { id: string };
let itSupport: Account;
let otherIt: Account;

async function account(role: 'ADMIN' | 'IT_SUPPORT', facilityId: string | null, extra = {}) {
  const u = await createUser(role, facilityId, extra);
  return { id: u.id, email: u.email, token: await login(u.email) };
}

const create = (token: string, body: Record<string, unknown>) =>
  api().post('/api/v1/operator-requests').set(bearer(token)).send(body);
const reply = (token: string, id: string, body: string) =>
  api().post(`/api/v1/operator-requests/${id}/messages`).set(bearer(token)).send({ body });
const answer = (id: string, body: Record<string, unknown>, token = admin.token) =>
  api().post(`/api/v1/admin/requests/${id}/messages`).set(bearer(token)).send(body);
const setStatus = (id: string, status: string) =>
  api().post(`/api/v1/admin/requests/${id}/status`).set(bearer(admin.token)).send({ status });
const REQUEST = {
  category: 'BILLING',
  subject: 'Question about the November invoice',
  body: 'The invoice shows 12 staff accounts, we have 10. Can you check?',
};

const notificationsOf = (userId: string, link?: string) =>
  db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), link ? eq(notifications.link, link) : undefined));
const auditsOf = (requestId: string, action?: string) =>
  db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.resourceType, 'operator_request'),
        eq(auditLogs.resourceId, requestId),
        action ? eq(auditLogs.action, action) : undefined,
      ),
    );

/** Makes the database refuse audit rows of one action: the change must be rolled back with it. */
async function withAuditRefused<T>(action: string, fn: () => Promise<T>) {
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION test_refuse_audit_requests() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = '${action}' THEN RAISE EXCEPTION 'audit refused (test)'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
  );
  await db.execute(
    sql.raw(`CREATE TRIGGER test_refuse_audit_requests BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION test_refuse_audit_requests()`),
  );
  try {
    return await fn();
  } finally {
    await db.execute(sql.raw('DROP TRIGGER IF EXISTS test_refuse_audit_requests ON audit_logs'));
    await db.execute(sql.raw('DROP FUNCTION IF EXISTS test_refuse_audit_requests()'));
  }
}

beforeAll(async () => {
  w = await createWorld();
  admin = await account('ADMIN', null, { emailNotifications: 'IMPORTANT' });
  quietAdmin = await account('ADMIN', null, { emailNotifications: 'OFF' });
  disabledAdmin = await createUser('ADMIN', null, { isActive: false });
  itSupport = await account('IT_SUPPORT', w.facility.id);
  otherIt = await account('IT_SUPPORT', w.otherFacility.id);
});

describe('access', () => {
  it('lets only directors and IT support of a facility ask, and only administrators answer', async () => {
    expect((await api().get('/api/v1/operator-requests')).status).toBe(401);
    for (const token of [
      w.tokens.doctor,
      w.tokens.nurse,
      w.tokens.reception,
      w.tokens.ministry,
      w.tokens.patient,
      admin.token,
    ]) {
      expect((await api().get('/api/v1/operator-requests').set(bearer(token))).status).toBe(403);
      expect((await create(token, REQUEST)).status).toBe(403);
    }
    for (const token of [w.tokens.director, itSupport.token, w.tokens.ministry]) {
      expect((await api().get('/api/v1/admin/requests').set(bearer(token))).status).toBe(403);
    }
  });
});

describe('never about a patient', () => {
  it('recognises a 10-digit number, but not phone numbers or IBANs', () => {
    expect(looksLikePersonalNumber('patient 1234567890 cannot sign in')).toBe(true);
    expect(looksLikePersonalNumber('nr.1234567890.')).toBe(true);
    expect(looksLikePersonalNumber('call 044 123 456 or +38344123456')).toBe(false);
    expect(looksLikePersonalNumber('IBAN XK05 1212 0123 4567 8906')).toBe(false);
    expect(looksLikePersonalNumber('XK051212012345678906')).toBe(false);
    expect(looksLikePersonalNumber('invoice PAC-2026-00012 of 15 900 €')).toBe(false);
  });

  it('refuses subjects and messages that contain one', async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(operatorRequests);
    const subject = await create(w.tokens.director, {
      ...REQUEST,
      subject: 'Record of 1234567890 is wrong',
    });
    expect(subject.status).toBe(400);
    expect(subject.body.error.message).toContain('Do not include patient information');
    expect(subject.body.error.details).toEqual([expect.objectContaining({ path: 'subject' })]);
    const body = await create(w.tokens.director, {
      ...REQUEST,
      body: 'Please merge the record with personal number 1234567890.',
    });
    expect(body.status).toBe(400);
    expect(body.body.error.details).toEqual([expect.objectContaining({ path: 'body' })]);
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(operatorRequests);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('validates category, subject and length', async () => {
    expect((await create(w.tokens.director, { ...REQUEST, category: 'PATIENT' })).status).toBe(400);
    expect((await create(w.tokens.director, { ...REQUEST, subject: 'Hi' })).status).toBe(400);
    expect((await create(w.tokens.director, { ...REQUEST, subject: 'x'.repeat(201) })).status).toBe(
      400,
    );
    expect((await create(w.tokens.director, { ...REQUEST, body: 'x'.repeat(4001) })).status).toBe(
      400,
    );
    expect((await create(w.tokens.director, { category: 'OTHER', subject: 'Only' })).status).toBe(
      400,
    );
  });
});

describe('a request from a facility', () => {
  let id: string;
  let reference: string;

  it('is numbered, audited without its text, and reaches every administrator', async () => {
    const res = await create(w.tokens.director, REQUEST);
    expect(res.status).toBe(201);
    id = res.body.id;
    reference = res.body.reference;
    expect(reference).toMatch(/^REQ-\d{4}-\d{5}$/);
    expect(res.body).toMatchObject({
      facilityId: w.facility.id,
      requesterId: w.users.director.id,
      category: 'BILLING',
      subject: REQUEST.subject,
      status: 'OPEN',
      priority: 'NORMAL',
      firstResponseAt: null,
      resolvedAt: null,
    });
    expect(res.body.messages).toEqual([
      expect.objectContaining({
        body: REQUEST.body,
        fromOperator: false,
        authorName: w.users.director.fullName,
      }),
    ]);

    // Gapless per year: the next request has the next number.
    const next = await create(itSupport.token, { ...REQUEST, category: 'TECHNICAL' });
    const [y, n] = reference.split('-').slice(1).map(Number);
    expect(next.body.reference).toBe(`REQ-${y}-${String(n! + 1).padStart(5, '0')}`);

    const [created] = await auditsOf(id, AuditAction.OPERATOR_REQUEST_CREATED);
    expect(created).toMatchObject({
      actorUserId: w.users.director.id,
      actorFacilityId: w.facility.id,
    });
    expect(created!.metadata).toMatchObject({
      reference,
      category: 'BILLING',
      priority: 'NORMAL',
      facilityId: w.facility.id,
    });
    const audits = await auditsOf(id);
    expect(audits.map((a) => a.action).sort()).toEqual(
      [AuditAction.OPERATOR_REQUEST_CREATED, AuditAction.OPERATOR_REQUEST_MESSAGE].sort(),
    );
    // Ids, category and statuses only: the facility's words stay in the request.
    for (const a of audits) {
      expect(JSON.stringify(a.metadata)).not.toContain('invoice');
    }

    // An important notification for every active administrator, linking to the inbox.
    for (const a of [admin, quietAdmin]) {
      const [note] = await notificationsOf(a.id, `/admin/requests/${id}`);
      expect(note).toMatchObject({
        type: 'operator_request',
        title: `New request ${reference} from ${w.facility.name}`,
      });
    }
    expect(await notificationsOf(disabledAdmin.id)).toHaveLength(0);
    // Important: e-mailed to those whose preference covers it, not to who turned e-mail off.
    const mails = await db
      .select()
      .from(emailOutbox)
      .where(inArray(emailOutbox.userId, [admin.id, quietAdmin.id]));
    expect(mails.map((m) => m.userId)).toEqual([admin.id, admin.id]);
  });

  it('stores nothing, and keeps the numbers gapless, when the audit entry cannot be written', async () => {
    const count = async () =>
      (await db.select({ n: sql<number>`count(*)::int` }).from(operatorRequests))[0]!.n;
    const before = await count();
    const refused = await withAuditRefused(AuditAction.OPERATOR_REQUEST_CREATED, () =>
      create(w.tokens.director, REQUEST),
    );
    expect(refused.status).toBe(500);
    expect(await count()).toBe(before);
    // A message whose audit entry fails is not stored either, and the status stays.
    const messages = async () =>
      (
        await db
          .select()
          .from(operatorRequestMessages)
          .where(eq(operatorRequestMessages.requestId, id))
      ).length;
    const stored = await messages();
    const reply500 = await withAuditRefused(AuditAction.OPERATOR_REQUEST_MESSAGE, () =>
      reply(w.tokens.director, id, 'This one is not stored.'),
    );
    expect(reply500.status).toBe(500);
    expect(await messages()).toBe(stored);
    const [y, n] = reference.split('-').slice(1).map(Number);
    const next = await create(w.tokens.director, REQUEST);
    // Two requests were created in the first test; the refused one used no number.
    expect(next.body.reference).toBe(`REQ-${y}-${String(n! + 2).padStart(5, '0')}`);
  });

  it('is seen by the facility’s directors and IT support, and by nobody from another facility', async () => {
    const mine = await api().get('/api/v1/operator-requests').set(bearer(itSupport.token));
    expect(mine.status).toBe(200);
    expect((mine.body.items as { id: string }[]).map((r) => r.id)).toContain(id);
    expect(mine.body.items[0]).toMatchObject({ facilityName: w.facility.name });
    expect(
      (await api().get(`/api/v1/operator-requests/${id}`).set(bearer(itSupport.token))).status,
    ).toBe(200);

    const theirs = await api().get('/api/v1/operator-requests').set(bearer(otherIt.token));
    expect((theirs.body.items as { id: string }[]).map((r) => r.id)).not.toContain(id);
    for (const token of [otherIt.token, w.tokens.otherDirector]) {
      expect((await api().get(`/api/v1/operator-requests/${id}`).set(bearer(token))).status).toBe(
        404,
      );
      expect((await reply(token, id, 'Can we see this?')).status).toBe(404);
    }
  });

  it('is answered by the operator: first response, status, the requester told', async () => {
    const res = await answer(id, {
      body: 'We checked: two accounts were disabled after the invoice. Credit note follows.',
      status: 'WAITING_CUSTOMER',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('WAITING_CUSTOMER');
    const first = res.body.firstResponseAt as string;
    expect(first).toBeTruthy();
    const [note] = await notificationsOf(w.users.director.id, `/operator-requests/${id}`);
    expect(note).toMatchObject({
      type: 'operator_request',
      title: `The operator answered your request ${reference}`,
    });
    expect(
      (await auditsOf(id, AuditAction.OPERATOR_REQUEST_STATUS_CHANGED))[0]!.metadata,
    ).toMatchObject({ from: 'OPEN', to: 'WAITING_CUSTOMER' });
    const message = (await auditsOf(id, AuditAction.OPERATOR_REQUEST_MESSAGE)).find(
      (a) => a.actorUserId === admin.id,
    );
    expect(message).toMatchObject({ actorRole: 'ADMIN' });

    // A second answer keeps the time of the first.
    await answer(id, { body: 'One more detail for you.' }, quietAdmin.token);
    const again = await api().get(`/api/v1/admin/requests/${id}`).set(bearer(admin.token));
    expect(again.body.firstResponseAt).toBe(first);
    expect(again.body.messages).toHaveLength(3);
    // The administrator sees who answered; the facility sees "the operator".
    expect(again.body.messages[1]).toMatchObject({ fromOperator: true, authorId: admin.id });
    const facilityView = await api()
      .get(`/api/v1/operator-requests/${id}`)
      .set(bearer(w.tokens.director));
    expect(facilityView.body.messages[1]).toMatchObject({
      fromOperator: true,
      authorId: null,
      authorName: null,
    });
    expect(JSON.stringify(facilityView.body.messages)).not.toContain(admin.email);
  });

  it('opens again when the facility writes, and the administrators are told', async () => {
    const res = await reply(itSupport.token, id, 'Thank you, the credit note is fine.');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('OPEN');
    expect(
      (await auditsOf(id, AuditAction.OPERATOR_REQUEST_STATUS_CHANGED)).map((a) => a.metadata),
    ).toContainEqual(
      expect.objectContaining({ from: 'WAITING_CUSTOMER', to: 'OPEN', cause: 'message' }),
    );
    const notes = await notificationsOf(admin.id, `/admin/requests/${id}`);
    expect(notes.map((n) => n.title)).toContain(
      `New message on request ${reference} from ${w.facility.name}`,
    );
    expect((await reply(itSupport.token, id, 'Our IBAN is XK05 1212 0123 4567 8906.')).status).toBe(
      201,
    );
    expect((await reply(itSupport.token, id, 'Patient 1234567890 again')).status).toBe(400);
  });

  it('is resolved and opened again by the administrator, resolved_at following the status', async () => {
    const resolved = await setStatus(id, 'RESOLVED');
    expect(resolved.status).toBe(200);
    expect(resolved.body.resolvedAt).toBeTruthy();
    const titles = (await notificationsOf(w.users.director.id, `/operator-requests/${id}`)).map(
      (n) => n.title,
    );
    expect(titles).toContain(`Your request ${reference} was resolved`);
    // The same status again changes nothing and is not audited twice.
    const auditCount = (await auditsOf(id, AuditAction.OPERATOR_REQUEST_STATUS_CHANGED)).length;
    await setStatus(id, 'RESOLVED');
    expect(await auditsOf(id, AuditAction.OPERATOR_REQUEST_STATUS_CHANGED)).toHaveLength(
      auditCount,
    );

    const reopened = await setStatus(id, 'OPEN');
    expect(reopened.body).toMatchObject({ status: 'OPEN', resolvedAt: null });
    expect((await setStatus(id, 'CLOSED')).status).toBe(400);
    expect((await answer(id, { body: 'See 1234567890' })).status).toBe(400);
  });

  it('keeps the conversation append-only and the status consistent in the database', async () => {
    await expect(
      db.execute(
        sql`UPDATE operator_request_messages SET body = 'changed' WHERE request_id = ${id}`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`DELETE FROM operator_request_messages WHERE request_id = ${id}`),
    ).rejects.toThrow();
    await expect(
      db.update(operatorRequests).set({ status: 'RESOLVED' }).where(eq(operatorRequests.id, id)),
    ).rejects.toThrow();
    const messages = await db
      .select()
      .from(operatorRequestMessages)
      .where(eq(operatorRequestMessages.requestId, id));
    expect(messages.length).toBeGreaterThanOrEqual(5);
  });
});

describe('a security incident', () => {
  it('is of high priority and e-mailed to every administrator at once', async () => {
    const mailsOf = async () => {
      const rows = await db
        .select({ userId: emailOutbox.userId })
        .from(emailOutbox)
        .where(inArray(emailOutbox.userId, [admin.id, quietAdmin.id, disabledAdmin.id]));
      return (userId: string) => rows.filter((m) => m.userId === userId).length;
    };
    const before = await mailsOf();
    const res = await create(w.tokens.director, {
      category: 'SECURITY_INCIDENT',
      subject: 'A laptop with a signed-in session was stolen',
      body: 'The laptop of a nurse was stolen this morning; she was signed in.',
    });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe('HIGH');
    const link = `/admin/requests/${res.body.id}`;
    for (const a of [admin, quietAdmin]) {
      const [note] = await notificationsOf(a.id, link);
      expect(note!.title).toBe(
        `Security incident reported by ${w.facility.name} (${res.body.reference})`,
      );
    }
    // Exactly one e-mail each: by preference, or – e-mail turned off – sent anyway.
    const after = await mailsOf();
    expect(before(quietAdmin.id)).toBe(0);
    expect(after(quietAdmin.id)).toBe(1);
    expect(after(admin.id) - before(admin.id)).toBe(1);
    expect(after(disabledAdmin.id)).toBe(0);
  });
});

describe('the administrator’s inbox', () => {
  it('filters by status, category and facility, with counts and high priority first', async () => {
    const other = await create(w.tokens.otherDirector, {
      category: 'ACCOUNT',
      subject: 'A director left',
      body: 'Please help us to give the director role to a colleague.',
    });
    expect(other.status).toBe(201);
    const all = await api()
      .get('/api/v1/admin/requests')
      .query({ pageSize: 100 })
      .set(bearer(admin.token));
    expect(all.status).toBe(200);
    expect(all.body.counts.OPEN).toBeGreaterThanOrEqual(3);
    expect(all.body.counts.highOpen).toBeGreaterThanOrEqual(1);
    expect(all.body.items[0]).toMatchObject({ priority: 'HIGH' });
    expect((all.body.facilities as { id: string }[]).map((f) => f.id)).toEqual(
      expect.arrayContaining([w.facility.id, w.otherFacility.id]),
    );

    const byFacility = await api()
      .get('/api/v1/admin/requests')
      .query({ facilityId: w.otherFacility.id })
      .set(bearer(admin.token));
    expect(byFacility.body.items).toEqual([
      expect.objectContaining({ id: other.body.id, facilityName: w.otherFacility.name }),
    ]);
    const byCategory = await api()
      .get('/api/v1/admin/requests')
      .query({ category: 'SECURITY_INCIDENT', facilityId: w.facility.id })
      .set(bearer(admin.token));
    expect(byCategory.body.items).toHaveLength(1);
    const waiting = await api()
      .get('/api/v1/admin/requests')
      .query({ status: 'WAITING_CUSTOMER', facilityId: w.otherFacility.id })
      .set(bearer(admin.token));
    expect(waiting.body.items).toHaveLength(0);
    const unresolved = await api()
      .get('/api/v1/admin/requests')
      .query({ status: 'UNRESOLVED', facilityId: w.otherFacility.id })
      .set(bearer(admin.token));
    expect(unresolved.body.total).toBe(1);
    expect(
      (await api().get('/api/v1/admin/requests').query({ status: 'NEW' }).set(bearer(admin.token)))
        .status,
    ).toBe(400);
    expect(
      (await api().get(`/api/v1/admin/requests/${w.facility.id}`).set(bearer(admin.token))).status,
    ).toBe(404);
  });
});
