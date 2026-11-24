import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  organizationAcceptances,
  platformSettings,
  subscriptionPlans,
  subscriptions,
} from '../src/db/schema.js';
import { AuditAction } from '../src/modules/audit/audit.service.js';
import { REVIEW_NOTES } from '../src/modules/platform/legal-templates.js';
import { api, bearer, createFacility, createUser, createWorld, login } from './helpers.js';

/**
 * The service agreement and the data processing agreement: templates, publishing, acceptance per
 * facility by a director, and the administrator's view. A missing acceptance never blocks anything
 * (H74) and never enters the users' legal gate (H75). Versions carry a random suffix: the current
 * version is whatever was published last, whatever other files did.
 */

let w: Awaited<ReturnType<typeof createWorld>>;
let admin: { id: string; token: string };
let otherDirectorSameFacility: { id: string; token: string };
let itSupport: string;
const run = randomUUID().slice(0, 6);
const v = (n: string) => `${n}-${run}`;
const BODY = 'A text that is long enough to be the body of an agreement for the test.';

const asAdmin = () => bearer(admin.token);
const createDoc = (body: Record<string, unknown>) =>
  api().post('/api/v1/admin/legal').set(asAdmin()).send(body);
const publish = (id: string) =>
  api().post(`/api/v1/admin/legal/${id}/publish`).set(asAdmin()).send({});
const agreementsOf = (token: string, locale?: string) =>
  api()
    .get('/api/v1/subscription/agreements')
    .query(locale ? { locale } : {})
    .set(bearer(token));
const accept = (token: string, documentId: string, body: Record<string, unknown>) =>
  api().post(`/api/v1/subscription/agreements/${documentId}/accept`).set(bearer(token)).send(body);
const SIGNER = { signerName: 'Arta Krasniqi', signerTitle: 'Director' };

/** Creates and publishes one translation of a version; returns the document id. */
async function published(
  kind: 'SERVICE_AGREEMENT' | 'DPA',
  version: string,
  locale = 'en',
  requiresAcceptance = true,
) {
  const created = await createDoc({
    kind,
    version,
    locale,
    title: `${kind} ${version} ${locale}`,
    body: BODY,
    requiresAcceptance,
  });
  expect(created.status).toBe(201);
  const res = await publish(created.body.id);
  expect(res.status).toBe(200);
  return created.body.id as string;
}

type KindView = {
  kind: string;
  currentVersion: string | null;
  pending: boolean;
  acceptedCurrent: { version: string; signerName: string } | null;
  acceptances: { version: string; signerName: string; signerTitle: string }[];
  document?: { id: string; version: string; locale: string; body: string } | null;
};
const kindOf = (body: { agreements: KindView[] }, kind: string) =>
  body.agreements.find((a) => a.kind === kind)!;

async function customer(facilityId: string, status: 'TRIAL' | 'ACTIVE' | 'CANCELLED' = 'ACTIVE') {
  const [plan] = await db
    .insert(subscriptionPlans)
    .values({
      code: `AGR-${randomUUID().slice(0, 8)}`.toUpperCase(),
      name: 'Agreements test plan',
      monthlyPriceCents: 1000,
      yearlyPriceCents: 10000,
    })
    .returning();
  const now = new Date();
  await db.insert(subscriptions).values({
    facilityId,
    planId: plan!.id,
    status,
    priceCents: 1000,
    currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000),
  });
}

/** Makes the database refuse audit rows of one action: the change must be rolled back with it. */
async function withAuditRefused<T>(action: string, fn: () => Promise<T>) {
  await db.execute(
    sql.raw(`CREATE OR REPLACE FUNCTION test_refuse_audit_agreements() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = '${action}' THEN RAISE EXCEPTION 'audit refused (test)'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`),
  );
  await db.execute(
    sql.raw(`CREATE TRIGGER test_refuse_audit_agreements BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION test_refuse_audit_agreements()`),
  );
  try {
    return await fn();
  } finally {
    await db.execute(sql.raw('DROP TRIGGER IF EXISTS test_refuse_audit_agreements ON audit_logs'));
    await db.execute(sql.raw('DROP FUNCTION IF EXISTS test_refuse_audit_agreements()'));
  }
}

beforeAll(async () => {
  w = await createWorld();
  const a = await createUser('ADMIN');
  admin = { id: a.id, token: await login(a.email) };
  const d2 = await createUser('DIRECTOR', w.facility.id);
  otherDirectorSameFacility = { id: d2.id, token: await login(d2.email) };
  itSupport = await login((await createUser('IT_SUPPORT', w.facility.id)).email);
  await customer(w.facility.id);
  await customer(w.otherFacility.id, 'TRIAL');
});

describe('access', () => {
  it('keeps the facility’s agreements to its directors and the overview to the administrator', async () => {
    expect((await api().get('/api/v1/subscription/agreements')).status).toBe(401);
    for (const token of [
      w.tokens.doctor,
      w.tokens.nurse,
      itSupport,
      admin.token,
      w.tokens.patient,
    ]) {
      expect((await agreementsOf(token)).status).toBe(403);
    }
    const adminPaths = [
      '/agreements/missing',
      `/organizations/${w.facility.id}/agreements`,
      `/agreements/acceptances?kind=DPA&version=1.0`,
    ];
    for (const token of [w.tokens.director, w.tokens.ministry, w.tokens.doctor]) {
      for (const p of adminPaths) {
        expect((await api().get(`/api/v1/admin${p}`).set(bearer(token))).status).toBe(403);
      }
    }
    expect(
      (await api().get(`/api/v1/admin/organizations/${randomUUID()}/agreements`).set(asAdmin()))
        .status,
    ).toBe(404);
  });
});

describe('templates and publishing', () => {
  it('offers drafts in three languages with the points a processor agreement needs', async () => {
    for (const kind of ['SERVICE_AGREEMENT', 'DPA'] as const) {
      for (const locale of ['sq', 'sr', 'en'] as const) {
        const res = await api()
          .get('/api/v1/admin/legal/templates')
          .query({ kind, locale })
          .set(asAdmin());
        expect(res.status).toBe(200);
        // Marked for the lawyer's review, and filled in from the operator settings on publishing.
        expect(res.body.body.startsWith(REVIEW_NOTES[locale])).toBe(true);
        expect(res.body.body).toContain('{operatorName}');
        expect(res.body.body).toContain('{privacyEmail}');
      }
    }
    const dpa = await api()
      .get('/api/v1/admin/legal/templates')
      .query({ kind: 'DPA', locale: 'en' })
      .set(asAdmin());
    expect(dpa.body.title).toBe('Data processing agreement');
    for (const point of [
      'documented instructions',
      'Data subjects and categories of data',
      'SECURITY.md',
      'Hosting: [',
      'E-mail delivery: [',
      'SMS delivery: [',
      '72 hours',
      'Audits',
      'deletes the data',
      'Clinical access is never withheld for non-payment',
    ]) {
      expect(dpa.body.body).toContain(point);
    }
    const service = await api()
      .get('/api/v1/admin/legal/templates')
      .query({ kind: 'SERVICE_AGREEMENT', locale: 'en' })
      .set(asAdmin());
    expect(service.body.body).toContain('Clinical access is never withheld for non-payment');
  });

  it('refuses to publish a template that still carries the note for the lawyer', async () => {
    // The templates refer to the operator details: fill them in, as the operator does first.
    await db
      .update(platformSettings)
      .set({
        operatorName: 'Operator Agreements SH.P.K.',
        operatorAddress: 'Rr. Testi 2, Prishtinë',
        supportEmail: 'support@example.org',
        supportPhone: '+383 38 000 001',
        privacyEmail: 'privacy@example.org',
      })
      .where(eq(platformSettings.id, 1));
    const template = await api()
      .get('/api/v1/admin/legal/templates')
      .query({ kind: 'DPA', locale: 'sr' })
      .set(asAdmin());
    const draft = await createDoc({
      kind: 'DPA',
      version: v('0.9'),
      locale: 'sr',
      title: template.body.title,
      body: template.body.body,
    });
    expect(draft.status).toBe(201);
    const refused = await publish(draft.body.id);
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('draft note');

    // Reviewed: the note is deleted, and the text is published with the operator details.
    const reviewed = template.body.body.replace(`${REVIEW_NOTES.sr}\n\n`, '');
    expect(
      (
        await api()
          .patch(`/api/v1/admin/legal/${draft.body.id}`)
          .set(asAdmin())
          .send({ body: reviewed })
      ).status,
    ).toBe(200);
    const ok = await publish(draft.body.id);
    expect(ok.status).toBe(200);
    expect(ok.body.body).toContain('privacy@example.org');
    expect(ok.body.body).not.toContain('{privacyEmail}');

    // Public like the terms of use, and listed with the other texts for the administrator.
    const pub = await api().get('/api/v1/legal/dpa').query({ locale: 'sr' });
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ kind: 'DPA', version: v('0.9'), locale: 'sr' });
    const list = await api().get('/api/v1/admin/legal').set(asAdmin());
    expect(list.body.current.DPA).toBe(v('0.9'));
    expect(list.body.current).toHaveProperty('SERVICE_AGREEMENT');
    expect((await api().get('/api/v1/legal/contract')).status).toBe(400);
  });
});

describe('acceptance by the facility', () => {
  let serviceEn: string;
  let serviceSq: string;
  let dpaEn: string;

  it('asks the directors, in their language, and never through the users’ legal gate', async () => {
    serviceEn = await published('SERVICE_AGREEMENT', v('1.0'), 'en');
    serviceSq = await published('SERVICE_AGREEMENT', v('1.0'), 'sq');
    dpaEn = await published('DPA', v('1.0'), 'en');
    expect((await api().get('/api/v1/legal/service-agreement')).body.version).toBe(v('1.0'));

    const res = await agreementsOf(w.tokens.director, 'sq');
    expect(res.status).toBe(200);
    expect(res.body.facility).toMatchObject({ id: w.facility.id });
    expect(res.body.pending).toBe(2);
    const service = kindOf(res.body, 'SERVICE_AGREEMENT');
    expect(service).toMatchObject({
      currentVersion: v('1.0'),
      pending: true,
      acceptedCurrent: null,
    });
    expect(service.document).toMatchObject({ id: serviceSq, locale: 'sq' });
    // No Serbian translation: the Albanian one, then English.
    expect(
      kindOf((await agreementsOf(w.tokens.director, 'sr')).body, 'DPA').document,
    ).toMatchObject({
      id: dpaEn,
      locale: 'en',
    });

    // The legal gate keeps asking only the terms of use and the privacy notice.
    const gate = await api().get('/api/v1/legal/status').set(bearer(w.tokens.director));
    expect(gate.status).toBe(200);
    for (const p of gate.body.pending as { kind: string }[]) {
      expect(['TERMS', 'PRIVACY']).toContain(p.kind);
    }
    const viaGate = await api()
      .post('/api/v1/legal/accept')
      .set(bearer(w.tokens.director))
      .send({ kind: 'SERVICE_AGREEMENT', version: v('1.0') });
    expect(viaGate.status).toBe(400);
  });

  it('blocks nothing while an agreement is not accepted (H74)', async () => {
    expect((await agreementsOf(w.tokens.director)).body.pending).toBe(2);
    expect((await api().get('/api/v1/subscription').set(bearer(w.tokens.director))).status).toBe(
      200,
    );
    expect((await api().get('/api/v1/auth/me').set(bearer(w.tokens.doctor))).status).toBe(200);
    const chart = await api().get(`/api/v1/patients/${w.patient.id}`).set(bearer(w.tokens.doctor));
    expect(chart.status).toBe(200);
  });

  it('validates the signer and accepts only a published, current agreement', async () => {
    expect((await accept(w.tokens.director, serviceEn, {})).status).toBe(400);
    expect(
      (await accept(w.tokens.director, serviceEn, { signerName: 'A', signerTitle: 'Director' }))
        .status,
    ).toBe(400);
    expect((await accept(w.tokens.director, randomUUID(), SIGNER)).status).toBe(404);
    // A draft, or a text of another kind, is not an agreement to accept.
    const draft = await createDoc({
      kind: 'SERVICE_AGREEMENT',
      version: v('draft'),
      locale: 'en',
      title: 'Draft',
      body: BODY,
    });
    expect((await accept(w.tokens.director, draft.body.id, SIGNER)).status).toBe(404);
    const terms = await createDoc({
      kind: 'TERMS',
      version: v('t'),
      locale: 'en',
      title: 'Terms',
      body: BODY,
    });
    expect((await accept(w.tokens.director, terms.body.id, SIGNER)).status).toBe(404);
    await api().delete(`/api/v1/admin/legal/${draft.body.id}`).set(asAdmin());
    await api().delete(`/api/v1/admin/legal/${terms.body.id}`).set(asAdmin());
  });

  it('records the signer, audits in the same transaction, and is not repeated in another language', async () => {
    const res = await accept(w.tokens.director, serviceEn, {
      signerName: '  Arta Krasniqi ',
      signerTitle: 'Chief executive',
    });
    expect(res.status).toBe(201);
    expect(res.body.pending).toBe(1);
    const service = kindOf(res.body, 'SERVICE_AGREEMENT');
    expect(service.pending).toBe(false);
    expect(service.acceptedCurrent).toMatchObject({
      version: v('1.0'),
      signerName: 'Arta Krasniqi',
      signerTitle: 'Chief executive',
      acceptedByName: w.users.director.fullName,
      locale: 'en',
    });

    const rows = await db
      .select()
      .from(organizationAcceptances)
      .where(eq(organizationAcceptances.facilityId, w.facility.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      documentId: serviceEn,
      kind: 'SERVICE_AGREEMENT',
      version: v('1.0'),
      acceptedById: w.users.director.id,
    });
    expect(rows[0]!.ip).toBeTruthy();
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, AuditAction.LEGAL_ORGANIZATION_ACCEPTED),
          eq(auditLogs.resourceId, serviceEn),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: w.users.director.id,
      actorFacilityId: w.facility.id,
      resourceType: 'legal_document',
    });
    expect(audits[0]!.metadata).toMatchObject({
      kind: 'SERVICE_AGREEMENT',
      version: v('1.0'),
      facilityId: w.facility.id,
      acceptanceId: rows[0]!.id,
    });
    // Ids and versions only: the signer's name stays in the acceptance.
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain('Krasniqi');

    // Another director of the facility, the Albanian text of the same version: already accepted.
    const again = await accept(otherDirectorSameFacility.token, serviceSq, SIGNER);
    expect(again.status).toBe(200);
    expect(
      await db
        .select()
        .from(organizationAcceptances)
        .where(eq(organizationAcceptances.facilityId, w.facility.id)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, AuditAction.LEGAL_ORGANIZATION_ACCEPTED),
            eq(auditLogs.actorUserId, otherDirectorSameFacility.id),
          ),
        ),
    ).toHaveLength(0);
    // The other facility has accepted nothing.
    expect((await agreementsOf(w.tokens.otherDirector)).body.pending).toBe(2);
  });

  it('stores nothing when the audit entry cannot be written (same transaction)', async () => {
    const res = await withAuditRefused(AuditAction.LEGAL_ORGANIZATION_ACCEPTED, () =>
      accept(w.tokens.otherDirector, serviceEn, SIGNER),
    );
    expect(res.status).toBe(500);
    expect(
      await db
        .select()
        .from(organizationAcceptances)
        .where(eq(organizationAcceptances.facilityId, w.otherFacility.id)),
    ).toHaveLength(0);
    expect(
      kindOf((await agreementsOf(w.tokens.otherDirector)).body, 'SERVICE_AGREEMENT').pending,
    ).toBe(true);
  });

  it('keeps a published agreement fixed, like the terms of use', async () => {
    const patch = await api()
      .patch(`/api/v1/admin/legal/${serviceEn}`)
      .set(asAdmin())
      .send({ body: `${BODY} Changed afterwards.` });
    expect(patch.status).toBe(409);
    expect((await api().delete(`/api/v1/admin/legal/${serviceEn}`).set(asAdmin())).status).toBe(
      409,
    );
    await expect(
      db.execute(sql`UPDATE legal_documents SET body = 'changed' WHERE id = ${serviceEn}`),
    ).rejects.toThrow();
  });

  it('keeps acceptances append-only in the database', async () => {
    await expect(
      db.execute(
        sql`UPDATE organization_acceptances SET signer_name = 'Someone else' WHERE facility_id = ${w.facility.id}`,
      ),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`DELETE FROM organization_acceptances WHERE facility_id = ${w.facility.id}`),
    ).rejects.toThrow();
  });

  it('accepts only the current version', async () => {
    await accept(w.tokens.director, dpaEn, SIGNER);
    const dpa2 = await published('DPA', v('2.0'), 'en');
    const stale = await accept(w.tokens.otherDirector, dpaEn, SIGNER);
    expect(stale.status).toBe(409);
    // A new version that asks for acceptance is pending again for everyone.
    expect(kindOf((await agreementsOf(w.tokens.director)).body, 'DPA').pending).toBe(true);
    expect((await accept(w.tokens.director, dpa2, SIGNER)).status).toBe(201);
    expect((await accept(w.tokens.otherDirector, dpa2, SIGNER)).status).toBe(201);
    expect(kindOf((await agreementsOf(w.tokens.otherDirector)).body, 'DPA').pending).toBe(false);
  });

  it('does not ask again for a version for information only, except who never accepted', async () => {
    // 2.1 asks nobody new to accept: the facilities that accepted 2.0 are up to date.
    await published('DPA', v('2.1'), 'en', false);
    const mine = kindOf((await agreementsOf(w.tokens.director)).body, 'DPA');
    expect(mine).toMatchObject({ currentVersion: v('2.1'), pending: false, acceptedCurrent: null });
    expect(mine.acceptances.map((a) => a.version)).toEqual([v('2.0'), v('1.0')]);
    // A facility that never accepted any version accepts the current one.
    const newcomer = await createFacility();
    const director = await login((await createUser('DIRECTOR', newcomer.id)).email);
    const theirs = kindOf((await agreementsOf(director)).body, 'DPA');
    expect(theirs.pending).toBe(true);
    expect((await accept(director, theirs.document!.id, SIGNER)).status).toBe(201);
    expect(kindOf((await agreementsOf(director)).body, 'DPA').pending).toBe(false);
  });
});

describe('the administrator’s view', () => {
  it('shows a facility’s acceptances', async () => {
    const res = await api()
      .get(`/api/v1/admin/organizations/${w.facility.id}/agreements`)
      .set(asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.facility).toMatchObject({ id: w.facility.id, name: w.facility.name });
    const service = kindOf(res.body, 'SERVICE_AGREEMENT');
    expect(service).toMatchObject({ pending: false });
    expect(service.acceptances[0]).toMatchObject({
      signerName: 'Arta Krasniqi',
      signerTitle: 'Chief executive',
    });
    // The texts themselves are on the legal pages; the facility page lists acceptances.
    expect(service).not.toHaveProperty('document');
  });

  it('lists the customers without the current agreements, and only customers', async () => {
    const pendingCustomer = await createFacility({ name: `AAA Pending ${run}` });
    await customer(pendingCustomer.id);
    const formerCustomer = await createFacility({ name: `AAA Former ${run}` });
    await customer(formerCustomer.id, 'CANCELLED');
    const noSubscription = await createFacility({ name: `AAA None ${run}` });

    const res = await api().get('/api/v1/admin/agreements/missing').set(asAdmin());
    expect(res.status).toBe(200);
    const ids = (res.body.items as { facilityId: string }[]).map((i) => i.facilityId);
    expect(ids).toContain(pendingCustomer.id);
    expect(ids).not.toContain(formerCustomer.id);
    expect(ids).not.toContain(noSubscription.id);
    // The world's facility accepted both current agreements; the other one only the DPA.
    expect(ids).not.toContain(w.facility.id);
    const other = (res.body.items as { facilityId: string; missing: string[] }[]).find(
      (i) => i.facilityId === w.otherFacility.id,
    );
    expect(other).toMatchObject({ missing: ['SERVICE_AGREEMENT'], subscriptionStatus: 'TRIAL' });
    expect(
      (res.body.items as { facilityId: string; missing: string[] }[]).find(
        (i) => i.facilityId === pendingCustomer.id,
      )!.missing,
    ).toEqual(['SERVICE_AGREEMENT', 'DPA']);
    const service = (res.body.kinds as { kind: string; upToDate: number; pending: number }[]).find(
      (k) => k.kind === 'SERVICE_AGREEMENT',
    )!;
    expect(service).toMatchObject({ currentVersion: v('1.0'), requiresAcceptance: true });
    expect(service.upToDate + service.pending).toBe(res.body.customers);
  });

  it('lists who accepted a version', async () => {
    const res = await api()
      .get('/api/v1/admin/agreements/acceptances')
      .query({ kind: 'DPA', version: v('2.0') })
      .set(asAdmin());
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(2);
    expect((res.body.latest as { facilityId: string }[]).map((a) => a.facilityId).sort()).toEqual(
      [w.facility.id, w.otherFacility.id].sort(),
    );
    expect(
      (
        await api()
          .get('/api/v1/admin/agreements/acceptances')
          .query({ kind: 'TERMS', version: '1' })
          .set(asAdmin())
      ).status,
    ).toBe(400);
    // The users' acceptance list stays for the terms of use and the privacy notice.
    expect(
      (
        await api()
          .get('/api/v1/admin/legal/acceptances')
          .query({ kind: 'DPA', version: v('2.0') })
          .set(asAdmin())
      ).status,
    ).toBe(400);
  });
});

describe('operator contact details', () => {
  it('saves the support hours and shows them publicly with the phone', async () => {
    const put = await api()
      .put('/api/v1/admin/settings')
      .set(asAdmin())
      .send({ supportPhone: '+383 38 000 002', supportHours: '  Mon–Fri 08:00–16:00 ' });
    expect(put.status).toBe(200);
    expect(put.body.supportHours).toBe('Mon–Fri 08:00–16:00');
    const info = await api().get('/api/v1/platform/info');
    expect(info.body).toMatchObject({
      supportPhone: '+383 38 000 002',
      supportHours: 'Mon–Fri 08:00–16:00',
    });
    expect(
      (
        await api()
          .put('/api/v1/admin/settings')
          .set(asAdmin())
          .send({ supportHours: 'x'.repeat(121) })
      ).status,
    ).toBe(400);
    await api().put('/api/v1/admin/settings').set(asAdmin()).send({ supportHours: null });
    expect((await api().get('/api/v1/platform/info')).body.supportHours).toBeNull();
  });
});
