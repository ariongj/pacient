import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careAssignments,
  consentRecords,
  patientDocuments,
  patients,
} from '../src/db/schema.js';
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

beforeAll(async () => {
  w = await createWorld();
  child = (
    await db
      .insert(patients)
      .values({
        nationalId: nextNationalId(),
        firstName: 'Lea',
        lastName: 'Consent',
        dateOfBirth: '2016-05-10',
        sex: 'FEMALE',
        primaryFacilityId: w.facility.id,
      })
      .returning()
  )[0]!;
  await db.insert(careAssignments).values({ patientId: child.id, doctorId: w.users.doctor.id });
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
        evidence: 'Birth certificate 1234/2016',
        scope,
      });
    expect(res.status).toBe(201);
  }
  fullParentToken = await login(fullParent.email);
  apptParentToken = await login(apptParent.email);
});

const url = (patientId = w.patient.id) => `/api/v1/patients/${patientId}/consents`;
const get = (token: string, patientId = w.patient.id, headers: Record<string, string> = {}) =>
  api().get(url(patientId)).set(bearer(token)).set(headers);
const post = (
  token: string,
  body: Record<string, unknown>,
  patientId = w.patient.id,
  headers: Record<string, string> = {},
) => api().post(url(patientId)).set(bearer(token)).set(headers).send(body);
type Current = { type: string; decision: string; isDefault: boolean; method: string | null };
const stateOf = (body: { current: Current[] }, type: string) =>
  body.current.find((c) => c.type === type)!;

const referral = (patientId: string, extra: Record<string, unknown> = {}) => ({
  patientId,
  toFacilityId: w.otherFacility.id,
  specialty: 'Cardiology',
  reason: 'Suspected arrhythmia',
  clinicalSummary: 'Palpitations for two weeks, ECG shows an irregular rhythm.',
  ...extra,
});

async function consentForm(patientId: string) {
  const [doc] = await db
    .insert(patientDocuments)
    .values({
      patientId,
      category: 'CONSENT_FORM',
      title: 'Signed consent form',
      fileName: 'consent.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1000,
      sha256: 'a'.repeat(64),
      uploadedById: w.users.doctor.id,
    })
    .returning();
  return doc!;
}

describe('consent defaults and the portal', () => {
  it('shares on referral by default and keeps research opt-in', async () => {
    const res = await get(w.tokens.patient);
    expect(res.status).toBe(200);
    expect(stateOf(res.body, 'CROSS_FACILITY_SHARING')).toMatchObject({
      decision: 'GRANTED',
      isDefault: true,
    });
    expect(stateOf(res.body, 'RESEARCH')).toMatchObject({
      decision: 'NOT_GRANTED',
      isDefault: true,
    });
    expect(res.body.texts.map((t: { type: string }) => t.type)).toContain('TREATMENT');
    expect(res.body.history).toEqual([]);
  });

  it('lets the patient grant and withdraw; the method is always PORTAL', async () => {
    const granted = await post(w.tokens.patient, {
      type: 'RESEARCH',
      decision: 'GRANTED',
      method: 'WRITTEN',
    });
    expect(granted.status).toBe(201);
    expect(granted.body).toMatchObject({ method: 'PORTAL', wordingVersion: '2026-1' });
    const withdrawn = await post(w.tokens.patient, { type: 'RESEARCH', decision: 'WITHDRAWN' });
    expect(withdrawn.status).toBe(201);
    const res = await get(w.tokens.patient);
    expect(stateOf(res.body, 'RESEARCH')).toMatchObject({
      decision: 'WITHDRAWN',
      isDefault: false,
      method: 'PORTAL',
    });
    expect(res.body.history).toHaveLength(2);
  });

  it('does not let patients record treatment consent or refuse via the portal', async () => {
    expect(
      (
        await post(w.tokens.patient, {
          type: 'TREATMENT',
          decision: 'GRANTED',
          procedure: 'Biopsy',
        })
      ).status,
    ).toBe(403);
    expect((await post(w.tokens.patient, { type: 'RESEARCH', decision: 'REFUSED' })).status).toBe(
      400,
    );
    expect(
      (await post(w.tokens.otherPatient, { type: 'RESEARCH', decision: 'GRANTED' })).status,
    ).toBe(403);
  });

  it('lets a full-scope guardian decide for the child, but not an appointments-only one', async () => {
    const full = { 'X-Acting-For': child.id };
    const res = await post(
      fullParentToken,
      { type: 'CROSS_FACILITY_SHARING', decision: 'WITHDRAWN' },
      child.id,
      full,
    );
    expect(res.status).toBe(201);
    expect(res.body.onBehalfGuardianshipId).toBeTruthy();
    expect((await get(fullParentToken, child.id, full)).status).toBe(200);

    const appt = { 'X-Acting-For': child.id };
    expect((await get(apptParentToken, child.id, appt)).status).toBe(403);
    expect(
      (
        await post(
          apptParentToken,
          { type: 'CROSS_FACILITY_SHARING', decision: 'GRANTED' },
          child.id,
          appt,
        )
      ).status,
    ).toBe(403);
  });
});

describe('clinician-recorded consent', () => {
  it('records treatment consent in person and tells the patient', async () => {
    const res = await post(w.tokens.doctor, {
      type: 'TREATMENT',
      decision: 'GRANTED',
      method: 'IN_PERSON',
      procedure: 'Minor skin excision',
      note: 'Risks of bleeding, infection and scarring explained; questions answered.',
    });
    expect(res.status).toBe(201);
    const view = await get(w.tokens.doctor);
    expect(view.body.treatment[0]).toMatchObject({
      procedure: 'Minor skin excision',
      decision: 'GRANTED',
      method: 'IN_PERSON',
    });
    const notes = await api().get('/api/v1/notifications').set(bearer(w.tokens.patient));
    expect(
      notes.body.items.some((n: { title: string }) => n.title.includes('consent decision')),
    ).toBe(true);

    // A later refusal for the same procedure becomes the current decision.
    await post(w.tokens.doctor, {
      type: 'TREATMENT',
      decision: 'WITHDRAWN',
      method: 'IN_PERSON',
      procedure: 'minor skin excision',
    });
    const after = await get(w.tokens.doctor);
    expect(after.body.treatment).toHaveLength(1);
    expect(after.body.treatment[0].decision).toBe('WITHDRAWN');
  });

  it('requires a name for treatment and a signed form for written consent', async () => {
    expect(
      (await post(w.tokens.doctor, { type: 'TREATMENT', decision: 'GRANTED', method: 'IN_PERSON' }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(w.tokens.doctor, {
          type: 'TREATMENT',
          decision: 'GRANTED',
          method: 'WRITTEN',
          procedure: 'Colonoscopy',
        })
      ).status,
    ).toBe(400);
    const otherPatientsForm = await consentForm(w.otherPatient.id);
    expect(
      (
        await post(w.tokens.doctor, {
          type: 'TREATMENT',
          decision: 'GRANTED',
          method: 'WRITTEN',
          procedure: 'Colonoscopy',
          documentId: otherPatientsForm.id,
        })
      ).status,
    ).toBe(400);
    const form = await consentForm(w.patient.id);
    const ok = await post(w.tokens.doctor, {
      type: 'TREATMENT',
      decision: 'GRANTED',
      method: 'WRITTEN',
      procedure: 'Colonoscopy',
      documentId: form.id,
    });
    expect(ok.status).toBe(201);
    expect(ok.body.documentId).toBe(form.id);
    expect(
      (await post(w.tokens.doctor, { type: 'RESEARCH', decision: 'GRANTED', method: 'PORTAL' }))
        .status,
    ).toBe(400);
  });

  it('keeps consent history append-only', async () => {
    const [row] = await db
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.patientId, w.patient.id))
      .limit(1);
    await expect(
      db.execute(sql`UPDATE consent_records SET decision = 'GRANTED' WHERE id = ${row!.id}`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`DELETE FROM consent_records WHERE id = ${row!.id}`),
    ).rejects.toThrow();
  });

  it('refuses people outside the care team; reception sees only sharing and research', async () => {
    for (const token of [
      w.tokens.outsideDoctor,
      w.tokens.pharmacist,
      w.tokens.director,
      w.tokens.ministry,
    ]) {
      expect((await get(token)).status).toBe(403);
    }
    expect(
      (await post(w.tokens.nurse, { type: 'RESEARCH', decision: 'GRANTED', method: 'IN_PERSON' }))
        .status,
    ).toBe(403);
    expect(
      (
        await post(w.tokens.reception, {
          type: 'RESEARCH',
          decision: 'GRANTED',
          method: 'IN_PERSON',
        })
      ).status,
    ).toBe(403);
    const desk = await get(w.tokens.reception);
    expect(desk.status).toBe(200);
    expect(desk.body.treatment).toEqual([]);
    expect(desk.body.history.some((h: { type: string }) => h.type === 'TREATMENT')).toBe(false);
    expect(JSON.stringify(desk.body)).not.toContain('skin excision');
    expect(desk.body.history.every((h: { note?: string }) => h.note === undefined)).toBe(true);
  });
});

describe('referrals respect withdrawn sharing consent', () => {
  it('blocks a referral to another facility until the doctor confirms agreement', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const patientUser = await createUser('PATIENT');
    await db.update(patients).set({ userId: patientUser.id }).where(eq(patients.id, p.id));
    const pt = await login(patientUser.email);
    expect(
      (await post(pt, { type: 'CROSS_FACILITY_SHARING', decision: 'WITHDRAWN' }, p.id)).status,
    ).toBe(201);

    const blocked = await api()
      .post('/api/v1/referrals')
      .set(bearer(w.tokens.doctor))
      .send(referral(p.id));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CONSENT_WITHDRAWN');
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.patientId, p.id), eq(auditLogs.action, 'consent.check.blocked')));
    expect(audits).toHaveLength(1);

    const shortNote = await api()
      .post('/api/v1/referrals')
      .set(bearer(w.tokens.doctor))
      .send(referral(p.id, { consentConfirmed: { method: 'IN_PERSON', note: 'ok' } }));
    expect(shortNote.status).toBe(400);

    const ok = await api()
      .post('/api/v1/referrals')
      .set(bearer(w.tokens.doctor))
      .send(
        referral(p.id, {
          consentConfirmed: {
            method: 'IN_PERSON',
            note: 'Discussed in clinic; patient agrees to sharing for this cardiology referral.',
          },
        }),
      );
    expect(ok.status).toBe(201);
    expect(ok.body.consentConfirmed).toBeUndefined();
    const view = await get(w.tokens.doctor, p.id);
    expect(stateOf(view.body, 'CROSS_FACILITY_SHARING')).toMatchObject({
      decision: 'GRANTED',
      method: 'IN_PERSON',
      isDefault: false,
    });
    expect(view.body.history).toHaveLength(2);
  });

  it('does not affect referrals when consent was never withdrawn', async () => {
    const res = await api()
      .post('/api/v1/referrals')
      .set(bearer(w.tokens.doctor))
      .send(referral(w.patient.id));
    expect(res.status).toBe(201);
    // Same-facility referrals keep their existing rule (use the care team instead).
    const same = await api()
      .post('/api/v1/referrals')
      .set(bearer(w.tokens.doctor))
      .send(referral(w.patient.id, { toFacilityId: w.facility.id }));
    expect(same.status).toBe(400);
  });
});
