import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careAssignments,
  encounters,
  guardianships,
  medicalCertificates,
  notifications,
  patients,
} from '../src/db/schema.js';
import { addDays } from '../src/modules/certificates/certificates.service.js';
import { kosovoDate } from '../src/modules/identity/identity.service.js';
import { api, bearer, createUser, createWorld, login, nextNationalId } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const today = kosovoDate(new Date());
const base = () => `/api/v1/certificates/patients/${w.patient.id}`;
const doctor = () => bearer(w.tokens.doctor);
const issue = (body: Record<string, unknown>, patientId = w.patient.id, token = w.tokens.doctor) =>
  api().post(`/api/v1/certificates/patients/${patientId}`).set(bearer(token)).send(body);
const verify = (code: string) => api().get(`/api/v1/verify/certificates/${code}`);
const codeOf = async (id: string) =>
  (
    await db
      .select({ c: medicalCertificates.verificationCode })
      .from(medicalCertificates)
      .where(eq(medicalCertificates.id, id))
  )[0]!.c;

let child: typeof patients.$inferSelect;
let parentToken: string;
let limitedGuardianToken: string;
const asGuardian = (token: string, patientId: string) => ({
  ...bearer(token),
  'X-Acting-For': patientId,
});

beforeAll(async () => {
  w = await createWorld();
  await db
    .insert(careAssignments)
    .values({ patientId: w.otherPatient.id, doctorId: w.users.doctor.id });
  child = (
    await db
      .insert(patients)
      .values({
        nationalId: nextNationalId(),
        firstName: 'Lea',
        lastName: 'Gashi',
        dateOfBirth: '2016-05-10',
        sex: 'FEMALE',
        primaryFacilityId: w.facility.id,
      })
      .returning()
  )[0]!;
  await db.insert(careAssignments).values({ patientId: child.id, doctorId: w.users.doctor.id });
  const parent = await createUser('PATIENT');
  const limited = await createUser('PATIENT');
  const validUntil = new Date(Date.now() + 365 * 86_400_000);
  await db.insert(guardianships).values([
    {
      patientId: child.id,
      guardianUserId: parent.id,
      relationship: 'PARENT',
      evidence: 'Birth certificate 1/2016',
      verifiedById: w.users.reception.id,
      validUntil,
    },
    {
      patientId: child.id,
      guardianUserId: limited.id,
      relationship: 'LEGAL_GUARDIAN',
      scope: 'APPOINTMENTS',
      evidence: 'Court order 2/2024',
      verifiedById: w.users.reception.id,
      validUntil,
    },
  ]);
  parentToken = await login(parent.email);
  limitedGuardianToken = await login(limited.email);
});

describe('issuing certificates', () => {
  it('issues sick leave with a facility serial number and a verification link', async () => {
    const res = await issue({
      kind: 'SICK_LEAVE',
      startDate: addDays(today, -1),
      endDate: addDays(today, 3),
      icd10Code: 'j06.9',
    });
    expect(res.status).toBe(201);
    expect(res.body.serialNumber).toBe(`${w.facility.code}-${today.slice(0, 4)}-000001`);
    expect(res.body.verificationUrl).toMatch(/\/verify\/[A-Za-z0-9_-]{24}$/);
    expect(res.body.verificationCode).toBeUndefined();
    expect(res.body).toMatchObject({ icd10Code: 'J06.9', chainDays: 5, warnings: [] });

    const second = await issue({ kind: 'GENERAL', startDate: today, purpose: 'Për bankën' });
    expect(second.body.serialNumber).toBe(`${w.facility.code}-${today.slice(0, 4)}-000002`);

    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'certificate.issued'), eq(auditLogs.resourceId, res.body.id)),
      );
    expect(entry).toMatchObject({ patientId: w.patient.id, actorUserId: w.users.doctor.id });
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.patientUser.id));
    expect(notes.some((n) => n.type === 'certificate' && n.link === '/portal/certificates')).toBe(
      true,
    );
    expect(notes.every((n) => !n.title.includes('J06'))).toBe(true);
  });

  it('validates each kind', async () => {
    const bad = async (body: Record<string, unknown>, patientId = w.patient.id) =>
      (await issue(body, patientId)).status;
    const far = addDays(today, 200);
    expect(await bad({ kind: 'SICK_LEAVE', startDate: today })).toBe(400);
    expect(await bad({ kind: 'SICK_LEAVE', startDate: today, endDate: addDays(today, 30) })).toBe(
      400,
    );
    expect(await bad({ kind: 'GENERAL', startDate: far, purpose: 'x' })).toBe(400);
    expect(
      await bad({ kind: 'GENERAL', startDate: addDays(today, -5), purpose: 'Për punën' }),
    ).toBe(400);
    expect(await bad({ kind: 'GENERAL', startDate: today })).toBe(400);
    expect(await bad({ kind: 'FITNESS_FOR_WORK', startDate: today })).toBe(400);
    expect(
      await bad({ kind: 'DRIVING_FITNESS', startDate: today, outcome: 'FIT_WITH_RESTRICTIONS' }),
    ).toBe(400);
    expect(
      await bad({ kind: 'GENERAL', startDate: today, purpose: 'Për punën', outcome: 'FIT' }),
    ).toBe(400);
    expect(
      await bad({
        kind: 'GENERAL',
        startDate: today,
        purpose: 'Për punën',
        diagnosisOnCertificate: true,
      }),
    ).toBe(400);
    expect(
      await bad({ kind: 'SCHOOL_ABSENCE', startDate: today, endDate: addDays(today, 1) }),
    ).toBe(400);
    expect(await bad({ kind: 'GENERAL', startDate: today, purpose: 'x', icd10Code: 'flu' })).toBe(
      400,
    );

    // Valid examples.
    const backdated = await issue({
      kind: 'GENERAL',
      startDate: addDays(today, -5),
      purpose: 'Për punën',
      remarks: 'Pacienti u paraqit me vonesë',
    });
    expect(backdated.status).toBe(201);
    const fit = await issue({
      kind: 'SPORTS_FITNESS',
      startDate: today,
      endDate: addDays(today, 364),
      outcome: 'FIT_WITH_RESTRICTIONS',
      restrictions: 'Pa sporte kontakti',
    });
    expect(fit.status).toBe(201);
    const school = await issue(
      { kind: 'SCHOOL_ABSENCE', startDate: addDays(today, -2), endDate: today },
      child.id,
    );
    expect(school.status).toBe(201);
  });

  it('enforces sick-leave extension chains and warns after 90 days', async () => {
    const start = addDays(today, -60);
    const remarks = 'Regjistrim i vonuar nga ambulanca';
    const first = await issue(
      { kind: 'SICK_LEAVE', startDate: start, endDate: addDays(start, 29), remarks },
      w.otherPatient.id,
    );
    expect(first.status).toBe(201);
    const overlap = await issue(
      { kind: 'SICK_LEAVE', startDate: addDays(start, 20), endDate: addDays(start, 35), remarks },
      w.otherPatient.id,
    );
    expect(overlap.status).toBe(409);
    const gap = await issue(
      {
        kind: 'SICK_LEAVE',
        startDate: addDays(start, 31),
        endDate: addDays(start, 40),
        remarks,
        extendsCertificateId: first.body.id,
      },
      w.otherPatient.id,
    );
    expect(gap.status).toBe(400);
    expect(gap.body.error.details).toMatchObject({ expectedStartDate: addDays(start, 30) });
    const second = await issue(
      {
        kind: 'SICK_LEAVE',
        startDate: addDays(start, 30),
        endDate: addDays(start, 59),
        remarks,
        extendsCertificateId: first.body.id,
      },
      w.otherPatient.id,
    );
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ chainDays: 60, warnings: [] });
    const again = await issue(
      {
        kind: 'SICK_LEAVE',
        startDate: addDays(start, 30),
        endDate: addDays(start, 35),
        remarks,
        extendsCertificateId: first.body.id,
      },
      w.otherPatient.id,
    );
    expect(again.status).toBe(409);
    const notSick = await issue(
      { kind: 'GENERAL', startDate: today, purpose: 'x', extendsCertificateId: first.body.id },
      w.otherPatient.id,
    );
    expect(notSick.status).toBe(400);
    const third = await issue(
      {
        kind: 'SICK_LEAVE',
        startDate: addDays(start, 60),
        endDate: addDays(start, 65),
        extendsCertificateId: second.body.id,
      },
      w.otherPatient.id,
    );
    expect(third.status).toBe(201);
    expect(third.body.chainDays).toBe(66);

    // A long chain on a fresh person crosses 90 days.
    const [p] = await db
      .insert(patients)
      .values({
        nationalId: nextNationalId(),
        firstName: 'Agim',
        lastName: 'Hoti',
        dateOfBirth: '1975-02-02',
        sex: 'MALE',
        primaryFacilityId: w.facility.id,
      })
      .returning();
    await db.insert(careAssignments).values({ patientId: p!.id, doctorId: w.users.doctor.id });
    let prev: string | undefined;
    let s = addDays(today, -89);
    let last: { body: { chainDays: number; warnings: { code: string; days: number }[] } } | null =
      null;
    for (let i = 0; i < 4; i++) {
      const r = await issue(
        {
          kind: 'SICK_LEAVE',
          startDate: s,
          endDate: addDays(s, 29),
          remarks,
          extendsCertificateId: prev,
        },
        p!.id,
      );
      expect(r.status).toBe(201);
      prev = r.body.id;
      s = addDays(s, 30);
      last = r;
    }
    expect(last!.body.chainDays).toBe(120);
    expect(last!.body.warnings).toEqual([
      expect.objectContaining({ code: 'MEDICAL_COMMISSION', days: 120 }),
    ]);

    // The list reports the chain length and which certificate extends which.
    const list = await api()
      .get(`/api/v1/certificates/patients/${w.otherPatient.id}`)
      .set(doctor());
    const firstItem = list.body.items.find((c: { id: string }) => c.id === first.body.id);
    expect(firstItem).toMatchObject({ days: 30, extendedById: second.body.id });

    // Revoking the start of a chain requires revoking its extensions first.
    const blocked = await api()
      .post(`/api/v1/certificates/${first.body.id}/revoke`)
      .set(doctor())
      .send({ reason: 'Gabim në datë' });
    expect(blocked.status).toBe(409);
  });

  it('only the treating doctor issues certificates', async () => {
    const body = { kind: 'GENERAL', startDate: today, purpose: 'Për punën' };
    expect((await issue(body, w.patient.id, w.tokens.outsideDoctor)).status).toBe(403);
    expect((await issue(body, w.patient.id, w.tokens.nurse)).status).toBe(403);
    expect((await issue(body, w.patient.id, w.tokens.reception)).status).toBe(403);
    expect((await issue(body, w.patient.id, w.tokens.patient)).status).toBe(403);
  });
});

describe('issued certificates are immutable', () => {
  it('blocks edits and deletion in the database; only revocation changes a row', async () => {
    const res = await issue({ kind: 'GENERAL', startDate: today, purpose: 'Për shkollën' });
    await expect(
      db
        .update(medicalCertificates)
        .set({ startDate: addDays(today, -1) })
        .where(eq(medicalCertificates.id, res.body.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(medicalCertificates).where(eq(medicalCertificates.id, res.body.id)),
    ).rejects.toThrow();
  });

  it('revokes by the issuer or the director, with a reason, once', async () => {
    const res = await issue({ kind: 'GENERAL', startDate: today, purpose: 'Për punëdhënësin' });
    const revoke = (token: string, reason = 'Lëshuar gabimisht') =>
      api().post(`/api/v1/certificates/${res.body.id}/revoke`).set(bearer(token)).send({ reason });
    expect((await revoke(w.tokens.colleague)).status).toBe(403);
    expect((await revoke(w.tokens.otherDirector)).status).toBe(403);
    expect((await revoke(w.tokens.doctor, 'x')).status).toBe(400);
    const ok = await revoke(w.tokens.doctor);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'REVOKED', revokeReason: 'Lëshuar gabimisht' });
    expect((await revoke(w.tokens.director)).status).toBe(409);
    await expect(
      db
        .update(medicalCertificates)
        .set({ status: 'ISSUED' })
        .where(eq(medicalCertificates.id, res.body.id)),
    ).rejects.toThrow();

    const other = await issue({ kind: 'GENERAL', startDate: today, purpose: 'Për bankën' });
    const byDirector = await api()
      .post(`/api/v1/certificates/${other.body.id}/revoke`)
      .set(bearer(w.tokens.director))
      .send({ reason: 'Kërkesë e pacientit' });
    expect(byDirector.status).toBe(200);
  });
});

describe('public verification', () => {
  it('shows validity, kind, dates and issuer – never the diagnosis', async () => {
    const res = await issue({
      kind: 'SICK_LEAVE',
      startDate: addDays(today, 5),
      endDate: addDays(today, 7),
      icd10Code: 'F32.1',
      remarks: 'Shënim i brendshëm',
    });
    const code = await codeOf(res.body.id);
    const v = await verify(code);
    expect(v.status).toBe(200);
    expect(v.headers['cache-control']).toBe('no-store');
    expect(v.headers['ratelimit-policy']).toBeDefined();
    expect(v.body).toMatchObject({
      genuine: true,
      state: 'VALID',
      kind: 'SICK_LEAVE',
      startDate: addDays(today, 5),
      endDate: addDays(today, 7),
      issuer: { facility: w.facility.name, doctor: w.users.doctor.fullName },
      patient: { initials: `T. ${w.patient.lastName.charAt(0).toUpperCase()}.`, birthYear: 1990 },
    });
    const text = JSON.stringify(v.body);
    expect(text).not.toContain('F32');
    expect(text).not.toContain('Shënim');
    expect(text).not.toContain(w.patient.nationalId);
    expect(text).not.toContain(w.patient.lastName);

    // Audited for the patient as an external verification.
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'certificate.verified'), eq(auditLogs.resourceId, res.body.id)),
      );
    expect(entry).toMatchObject({ patientId: w.patient.id, actorUserId: null });
    const log = await api().get('/api/v1/portal/access-log').set(bearer(w.tokens.patient));
    expect(
      log.body.items.some(
        (i: { action: string; actorLabel: string }) =>
          i.action === 'certificate.verified' && i.actorLabel === 'External verification (QR code)',
      ),
    ).toBe(true);
  });

  it('reports revoked and expired certificates; unknown codes are not found', async () => {
    const old = await issue({
      kind: 'SICK_LEAVE',
      startDate: addDays(today, -120),
      endDate: addDays(today, -115),
      remarks: 'Kopje e vonuar',
    });
    expect((await verify(await codeOf(old.body.id))).body.state).toBe('EXPIRED');
    const gen = await issue({ kind: 'GENERAL', startDate: today, purpose: 'Për palestrën' });
    await api()
      .post(`/api/v1/certificates/${gen.body.id}/revoke`)
      .set(doctor())
      .send({ reason: 'Lëshuar gabimisht' });
    const revoked = await verify(await codeOf(gen.body.id));
    expect(revoked.body).toMatchObject({ state: 'REVOKED', genuine: true });
    expect(revoked.body.revokedAt).toBeTruthy();
    expect((await verify('A'.repeat(24))).status).toBe(404);
    expect((await verify('not a code!')).status).toBe(404);
  });
});

describe('who sees certificates', () => {
  it('care team, the patient and full-scope guardians; never reception or other patients', async () => {
    expect((await api().get(base()).set(doctor())).status).toBe(200);
    expect((await api().get(base()).set(bearer(w.tokens.outsideDoctor))).status).toBe(403);
    expect((await api().get(base()).set(bearer(w.tokens.reception))).status).toBe(403);
    expect((await api().get(base()).set(bearer(w.tokens.director))).status).toBe(403);
    expect((await api().get(base()).set(bearer(w.tokens.pharmacist))).status).toBe(403);
    expect((await api().get(base()).set(bearer(w.tokens.otherPatient))).status).toBe(403);
    const own = await api().get(base()).set(bearer(w.tokens.patient));
    expect(own.status).toBe(200);
    expect(own.body.items.length).toBeGreaterThan(3);

    // Detail for printing.
    const id = own.body.items[0].id as string;
    const detail = await api().get(`/api/v1/certificates/${id}`).set(bearer(w.tokens.patient));
    expect(detail.status).toBe(200);
    expect(detail.body.verificationUrl).toMatch(/\/verify\//);
    expect(detail.body.facility.name).toBe(w.facility.name);
    expect(
      (await api().get(`/api/v1/certificates/${id}`).set(bearer(w.tokens.otherPatient))).status,
    ).toBe(403);
  });

  it('guardians see a child’s certificates except those of confidential visits', async () => {
    const [enc] = await db
      .insert(encounters)
      .values({
        patientId: child.id,
        doctorId: w.users.doctor.id,
        facilityId: w.facility.id,
        type: 'OUTPATIENT',
        reason: 'Konsultë konfidenciale',
        confidentialFromGuardians: true,
      })
      .returning();
    const hidden = await issue(
      {
        kind: 'GENERAL',
        startDate: today,
        purpose: 'Për shkollën',
        encounterId: enc!.id,
      },
      child.id,
    );
    expect(hidden.status).toBe(201);
    const path = `/api/v1/certificates/patients/${child.id}`;
    const list = await api().get(path).set(asGuardian(parentToken, child.id));
    expect(list.status).toBe(200);
    const ids = list.body.items.map((c: { id: string }) => c.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(hidden.body.id);
    expect(
      (
        await api()
          .get(`/api/v1/certificates/${hidden.body.id}`)
          .set(asGuardian(parentToken, child.id))
      ).status,
    ).toBe(404);
    expect((await api().get(path).set(asGuardian(limitedGuardianToken, child.id))).status).toBe(
      403,
    );
  });
});

describe('statistics and lookup', () => {
  it('gives directors and the Ministry aggregate figures only', async () => {
    const stats = await api().get('/api/v1/certificates/stats').set(bearer(w.tokens.director));
    expect(stats.status).toBe(200);
    expect(stats.body.totals.issued).toBeGreaterThan(5);
    expect(stats.body.totals.sickLeaveDays).toBeGreaterThan(30);
    expect(JSON.stringify(stats.body)).not.toContain(w.patient.lastName);
    expect(
      (await api().get('/api/v1/certificates/stats').set(bearer(w.tokens.ministry))).status,
    ).toBe(200);
    expect((await api().get('/api/v1/certificates/stats').set(doctor())).status).toBe(403);
  });

  it('lists the certificates a doctor issued, without diagnoses', async () => {
    const mine = await api().get('/api/v1/certificates/mine').set(doctor());
    expect(mine.status).toBe(200);
    expect(mine.body.items.length).toBeGreaterThan(5);
    expect(mine.body.items[0].icd10Code).toBeUndefined();
    const colleague = await api().get('/api/v1/certificates/mine').set(bearer(w.tokens.colleague));
    expect(colleague.body.items).toEqual([]);
    expect((await api().get('/api/v1/certificates/mine').set(bearer(w.tokens.nurse))).status).toBe(
      403,
    );
  });

  it('lets a director find a certificate of their facility by number', async () => {
    const serial = `${w.facility.code}-${today.slice(0, 4)}-000001`;
    const found = await api()
      .get(`/api/v1/certificates/by-serial/${serial}`)
      .set(bearer(w.tokens.director));
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ serialNumber: serial, kind: 'SICK_LEAVE' });
    expect(found.body.icd10Code).toBeUndefined();
    expect(
      (
        await api()
          .get(`/api/v1/certificates/by-serial/${serial}`)
          .set(bearer(w.tokens.otherDirector))
      ).status,
    ).toBe(404);
  });
});
