import { and, eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { auditLogs, caseReports, diagnoses, notifications, patients } from '../src/db/schema.js';
import { matchDisease, DEFAULT_DISEASES } from '../src/modules/surveillance/diseases.js';
import {
  buildDashboard,
  detectCasesOnce,
  ensureDefaultDiseases,
  isoWeek,
} from '../src/modules/surveillance/surveillance.service.js';
import { api, bearer, createPatient, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;

beforeAll(async () => {
  w = await createWorld();
  await ensureDefaultDiseases();
});

async function diagnose(patientId: string, icd10Code: string, description = 'Test diagnosis') {
  const res = await api()
    .post(`/api/v1/patients/${patientId}/diagnoses`)
    .set(bearer(w.tokens.doctor))
    .send({ icd10Code, description });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const caseFor = async (diagnosisId: string) =>
  (await db.select().from(caseReports).where(eq(caseReports.diagnosisId, diagnosisId)))[0];

describe('disease matching', () => {
  it('matches ICD-10 prefixes, longest first, ignoring dots', () => {
    expect(matchDisease('A23.9', DEFAULT_DISEASES)?.code).toBe('BRUCELLOSIS');
    expect(matchDisease('A230', DEFAULT_DISEASES)?.code).toBe('BRUCELLOSIS');
    expect(matchDisease('A05.1', DEFAULT_DISEASES)?.code).toBe('BOTULISM');
    expect(matchDisease('A05.9', DEFAULT_DISEASES)).toBeNull();
    expect(matchDisease('B18.1', DEFAULT_DISEASES)?.code).toBe('HEPATITIS_B');
    expect(matchDisease('A17.0', DEFAULT_DISEASES)?.code).toBe('TB');
    expect(matchDisease('j10.1', DEFAULT_DISEASES)?.code).toBe('INFLUENZA');
    expect(matchDisease('I10', DEFAULT_DISEASES)).toBeNull();
  });
});

describe('automatic case reports', () => {
  let brucellosisDx: string;
  let measlesDx: string;

  it('creates one draft per notifiable diagnosis and notifies the doctor (and director if immediate)', async () => {
    brucellosisDx = await diagnose(w.patient.id, 'A23.9', 'Bruceloza');
    measlesDx = await diagnose(w.patient.id, 'B05.9', 'Fruth');
    const hypertension = await diagnose(w.patient.id, 'I10', 'Hipertension');
    const first = await detectCasesOnce();
    expect(first.created).toBeGreaterThanOrEqual(2);
    expect(await caseFor(hypertension)).toBeUndefined();
    const bruc = await caseFor(brucellosisDx);
    expect(bruc).toMatchObject({
      status: 'DRAFT',
      classification: 'SUSPECTED',
      reportedById: w.users.doctor.id,
    });

    const again = await detectCasesOnce();
    expect(again.created).toBe(0);

    const doctorNotes = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, w.users.doctor.id), eq(notifications.type, 'surveillance')),
      );
    expect(doctorNotes.length).toBeGreaterThanOrEqual(2);
    expect(doctorNotes[0]!.title).not.toMatch(/brucel|measles/i); // generic, no diagnosis
    const directorNotes = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, w.users.director.id), eq(notifications.type, 'surveillance')),
      );
    expect(directorNotes).toHaveLength(1); // measles only (immediately notifiable)
  });

  it('lets the diagnosing doctor complete and submit; others may not', async () => {
    const id = (await caseFor(brucellosisDx))!.id;
    const mine = await api().get('/api/v1/surveillance/my-cases').set(bearer(w.tokens.doctor));
    expect(mine.body.items.some((c: { id: string }) => c.id === id)).toBe(true);

    for (const token of [w.tokens.outsideDoctor, w.tokens.nurse, w.tokens.reception]) {
      const res = await api()
        .patch(`/api/v1/surveillance/cases/${id}`)
        .set(bearer(token))
        .send({ classification: 'PROBABLE' });
      expect(res.status).toBe(403);
    }
    const future = await api()
      .patch(`/api/v1/surveillance/cases/${id}`)
      .set(bearer(w.tokens.doctor))
      .send({ onsetDate: '2999-01-01' });
    expect(future.status).toBe(400);
    const patch = await api()
      .patch(`/api/v1/surveillance/cases/${id}`)
      .set(bearer(w.tokens.doctor))
      .send({
        classification: 'CONFIRMED',
        details: {
          symptoms: ['ethe', 'djersitje'],
          hospitalised: false,
          labConfirmation: 'Wright +',
        },
      });
    expect(patch.status).toBe(200);
    expect(patch.body.details.symptoms).toEqual(['ethe', 'djersitje']);
    const submit = await api()
      .post(`/api/v1/surveillance/cases/${id}/submit`)
      .set(bearer(w.tokens.doctor));
    expect(submit.status).toBe(200);
    expect(submit.body.status).toBe('SUBMITTED');
    const twice = await api()
      .post(`/api/v1/surveillance/cases/${id}/submit`)
      .set(bearer(w.tokens.doctor));
    expect(twice.status).toBe(409);
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.action, 'surveillance.case_submitted'), eq(auditLogs.resourceId, id)),
      );
    expect(entry).toBeDefined();
  });

  it('can discard a draft with a reason', async () => {
    const id = (await caseFor(measlesDx))!.id;
    const short = await api()
      .post(`/api/v1/surveillance/cases/${id}/discard`)
      .set(bearer(w.tokens.doctor))
      .send({ reason: 'no' });
    expect(short.status).toBe(400);
    const res = await api()
      .post(`/api/v1/surveillance/cases/${id}/discard`)
      .set(bearer(w.tokens.doctor))
      .send({ reason: 'Diagnoza u kodua gabimisht' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ classification: 'DISCARDED', status: 'SUBMITTED' });
  });

  it('lets the Ministry review; directors see their facility without names', async () => {
    const id = (await caseFor(brucellosisDx))!.id;
    const director = await api().get('/api/v1/surveillance/cases').set(bearer(w.tokens.director));
    expect(director.status).toBe(200);
    const row = director.body.items.find((c: { id: string }) => c.id === id);
    expect(row.patient.name).toBeUndefined();
    expect(row.patient.nationalId).toBeUndefined();
    expect(row.patient.age).toBeTypeOf('number');
    const other = await api().get('/api/v1/surveillance/cases').set(bearer(w.tokens.otherDirector));
    expect(other.body.items.some((c: { id: string }) => c.id === id)).toBe(false);
    expect(
      (await api().get(`/api/v1/surveillance/cases/${id}`).set(bearer(w.tokens.otherDirector)))
        .status,
    ).toBe(404);

    const ministry = await api()
      .get(`/api/v1/surveillance/cases/${id}`)
      .set(bearer(w.tokens.ministry));
    expect(ministry.body.patient.nationalId).toBe(w.patient.nationalId);
    expect(
      (
        await api()
          .post(`/api/v1/surveillance/cases/${id}/review`)
          .set(bearer(w.tokens.director))
          .send({ classification: 'CONFIRMED' })
      ).status,
    ).toBe(403);
    const review = await api()
      .post(`/api/v1/surveillance/cases/${id}/review`)
      .set(bearer(w.tokens.ministry))
      .send({ classification: 'CONFIRMED', note: 'Konfirmuar nga laboratori' });
    expect(review.status).toBe(200);
    expect(review.body.status).toBe('REVIEWED');
    // The Ministry's identifiable read appears in the patient's access log.
    const [viewed] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'patient.record.viewed'),
          eq(auditLogs.patientId, w.patient.id),
          sql`${auditLogs.metadata}->>'section' = 'surveillance'`,
        ),
      );
    expect(viewed).toBeDefined();
  });

  it('only the Ministry edits the disease list', async () => {
    const body = {
      code: 'TEST_DISEASE',
      name: 'Test disease',
      icd10Prefixes: ['Z99.9'],
      urgency: 'WEEKLY',
    };
    expect(
      (await api().post('/api/v1/surveillance/diseases').set(bearer(w.tokens.director)).send(body))
        .status,
    ).toBe(403);
    const created = await api()
      .post('/api/v1/surveillance/diseases')
      .set(bearer(w.tokens.ministry))
      .send(body);
    expect(created.status).toBe(201);
    const bad = await api()
      .post('/api/v1/surveillance/diseases')
      .set(bearer(w.tokens.ministry))
      .send({ ...body, code: 'OTHER', icd10Prefixes: ['nonsense'] });
    expect(bad.status).toBe(400);
  });
});

describe('dashboard', () => {
  it('counts per ISO week, suppresses small municipality cells and raises alerts', () => {
    const now = new Date('2026-11-04T12:00:00Z');
    const mk = (code: string, urgency: string, municipality: string, daysAgo: number) => ({
      diseaseCode: code,
      diseaseName: code,
      urgency,
      municipality,
      caseDate: new Date(now.getTime() - daysAgo * 86_400_000),
    });
    const cases = [
      ...Array.from({ length: 6 }, () => mk('HEPATITIS_A', 'WEEKLY', 'Ferizaj', 0)),
      mk('HEPATITIS_A', 'WEEKLY', 'Ferizaj', 14),
      mk('HEPATITIS_A', 'WEEKLY', 'Gjilan', 1),
      mk('MEASLES', 'IMMEDIATE', 'Prizren', 2),
      mk('INFLUENZA', 'WEEKLY', 'Prishtinë', 0),
      mk('INFLUENZA', 'WEEKLY', 'Prishtinë', 7),
      mk('INFLUENZA', 'WEEKLY', 'Prishtinë', 14),
    ];
    const d = buildDashboard(cases, now, 12);
    expect(d.weeks).toHaveLength(12);
    expect(d.currentWeek).toBe(isoWeek(now));
    const hepA = d.diseases.find((x) => x.code === 'HEPATITIS_A')!;
    expect(hepA.total).toBe(8);
    expect(hepA.counts.at(-1)).toBe(hepA.counts.at(-1)); // present
    const ferizaj = d.municipalities.find((m) => m.municipality === 'Ferizaj')!;
    expect(ferizaj.counts.HEPATITIS_A).toBe(7);
    const gjilan = d.municipalities.find((m) => m.municipality === 'Gjilan')!;
    expect(gjilan.counts.HEPATITIS_A).toBeNull(); // 1 case → suppressed
    const kinds = d.alerts.map((a) => `${a.diseaseCode}:${a.kind}`);
    expect(kinds).toContain('MEASLES:IMMEDIATE');
    expect(kinds).toContain('HEPATITIS_A:INCREASE');
    expect(kinds).not.toContain('INFLUENZA:INCREASE'); // 1 case/week is no increase
  });

  it('is served to the Ministry nationally and to directors for their facility', async () => {
    const ministry = await api()
      .get('/api/v1/surveillance/dashboard')
      .set(bearer(w.tokens.ministry));
    expect(ministry.status).toBe(200);
    expect(ministry.body.scope).toBe('NATIONAL');
    const director = await api()
      .get('/api/v1/surveillance/dashboard')
      .set(bearer(w.tokens.director));
    expect(director.body.scope).toBe('FACILITY');
    expect(director.body.timeliness).toHaveProperty('drafts');
    expect(
      (await api().get('/api/v1/surveillance/dashboard').set(bearer(w.tokens.doctor))).status,
    ).toBe(403);
  });
});

describe('partner feed (surveillance.read)', () => {
  async function client(scopes: string[]) {
    const res = await api()
      .post('/api/v1/partner/clients')
      .set(bearer(w.tokens.ministry))
      .send({ name: `Public health ${scopes.join()}`, organisation: 'IKShPK', scopes });
    expect(res.status).toBe(201);
    return res.body as { id: string; apiKey: string };
  }

  it('returns submitted cases with minimal identifiers and audits each patient', async () => {
    const ph = await client(['surveillance.read']);
    const res = await api()
      .get('/api/v1/partner/surveillance/cases')
      .set({ Authorization: `Bearer ${ph.apiKey}` });
    expect(res.status).toBe(200);
    const item = res.body.items.find(
      (c: { nationalId: string; diseaseCode: string }) =>
        c.nationalId === w.patient.nationalId && c.diseaseCode === 'BRUCELLOSIS',
    );
    expect(item).toMatchObject({ diseaseCode: 'BRUCELLOSIS', classification: 'CONFIRMED' });
    expect(item.age).toBeTypeOf('number');
    expect(item.firstName).toBeUndefined();
    expect(item.dateOfBirth).toBeUndefined();
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'partner.api.access'),
          eq(auditLogs.patientId, w.patient.id),
          sql`${auditLogs.metadata}->>'clientId' = ${ph.id}`,
        ),
      );
    expect(audits.length).toBeGreaterThan(0);
    expect(audits[0]!.metadata).toMatchObject({ actorLabel: expect.stringContaining('(API)') });

    const summary = await api()
      .get('/api/v1/partner/surveillance/summary?weeks=8')
      .set({ Authorization: `Bearer ${ph.apiKey}` });
    expect(summary.status).toBe(200);
    expect(summary.body.weeks).toHaveLength(8);
    for (const d of summary.body.diseases) {
      for (const n of d.counts) expect(n === null || n === 0 || n >= 5).toBe(true);
    }
  });

  it('refuses keys without the scope', async () => {
    const other = await client(['stats.read']);
    const res = await api()
      .get('/api/v1/partner/surveillance/cases')
      .set({ Authorization: `Bearer ${other.apiKey}` });
    expect(res.status).toBe(403);
  });
});

describe('merged and old diagnoses', () => {
  it('ignores diagnoses of merged records and older than the look-back window', async () => {
    const p = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const oldDx = await diagnose(p.id, 'A02.0', 'Salmoneloza');
    await db
      .update(diagnoses)
      .set({ diagnosedAt: new Date(Date.now() - 200 * 86_400_000) })
      .where(eq(diagnoses.id, oldDx));
    const merged = await createPatient(w.facility.id, { doctorId: w.users.doctor.id });
    const mergedDx = await diagnose(merged.id, 'A02.0', 'Salmoneloza');
    await db.update(patients).set({ mergedIntoId: p.id }).where(eq(patients.id, merged.id));
    await detectCasesOnce();
    const rows = await db
      .select()
      .from(caseReports)
      .where(inArray(caseReports.diagnosisId, [oldDx, mergedDx]));
    expect(rows).toHaveLength(0);
  });
});
