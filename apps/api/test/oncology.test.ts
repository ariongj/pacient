import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  cancerCases,
  careAssignments,
  deathRecords,
  mdtCaseReviews,
  notifications,
  patients,
} from '../src/db/schema.js';
import { nextCertificateNumber } from '../src/modules/deaths/deaths.service.js';
import { checkCase, topographyFromIcd10 } from '../src/modules/oncology/definitions.js';
import { api, bearer, createPatient, createUser, createWorld, login } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const doctor = () => bearer(w.tokens.doctor);

const breast = {
  diagnosedOn: iso(Date.now() - 30 * DAY),
  icd10: 'C50.4',
  topography: 'C50.4',
  morphology: '8500/3',
  laterality: 'LEFT',
  basisOfDiagnosis: 'HISTOLOGY',
  tnmT: 'cT2',
  tnmN: 'N1',
  tnmM: 'M0',
  stage: 'II',
  tnmEdition: '8',
};

async function careOf(doctorId: string, extra: Partial<typeof patients.$inferInsert> = {}) {
  const p = await createPatient(w.facility.id, { doctorId });
  if (Object.keys(extra).length) await db.update(patients).set(extra).where(eq(patients.id, p.id));
  return p;
}
const register = (patientId: string, body: Record<string, unknown>, token = w.tokens.doctor) =>
  api().post(`/api/v1/oncology/patients/${patientId}/cases`).set(bearer(token)).send(body);

beforeAll(async () => {
  w = await createWorld();
});

describe('coding rules', () => {
  it('requires the side for paired organs and warns about inconsistent coding', () => {
    expect(
      checkCase({ ...breast, laterality: 'NOT_APPLICABLE' }).problems.map((p) => p.code),
    ).toEqual(['LATERALITY_REQUIRED']);
    expect(checkCase(breast)).toEqual({ problems: [], warnings: [] });
    const w1 = checkCase({ ...breast, topography: 'C18.7' }).warnings.map((x) => x.code);
    expect(w1).toContain('TOPOGRAPHY_MISMATCH');
    expect(w1).toContain('LATERALITY_NOT_PAIRED');
    expect(
      checkCase({ ...breast, icd10: 'D05.1', morphology: '8500/3' }).warnings.map((x) => x.code),
    ).toContain('BEHAVIOUR_MISMATCH');
    expect(checkCase({ ...breast, tnmM: 'M1', stage: 'II' }).warnings.map((x) => x.code)).toContain(
      'STAGE_MISMATCH',
    );
    expect(
      checkCase({ ...breast, icd10: 'C43.5', topography: 'C44.5', laterality: 'NOT_APPLICABLE' })
        .warnings,
    ).toEqual([]);
  });

  it('derives the ICD-O-3 site of a death certificate cause', () => {
    expect(topographyFromIcd10('C34.9')).toBe('C34.9');
    expect(topographyFromIcd10('C61')).toBe('C61.9');
    expect(topographyFromIcd10('C43.5')).toBe('C44.9');
    expect(topographyFromIcd10('C91.0')).toBeNull();
  });
});

describe('registration', () => {
  it('registers a cancer for a patient in the doctor’s care, with audit', async () => {
    const p = await careOf(w.users.doctor.id);
    const res = await register(p.id, breast);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'ACTIVE',
      stage: 'II',
      laterality: 'LEFT',
      warnings: [],
    });
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.resourceId, res.body.id), eq(auditLogs.action, 'oncology.registered')),
      );
    expect(entry?.patientId).toBe(p.id);

    const chart = await api().get(`/api/v1/oncology/patients/${p.id}`).set(doctor());
    expect(chart.status).toBe(200);
    expect(chart.body.cases).toHaveLength(1);
  });

  it('validates codes, laterality, dates and TNM', async () => {
    const p = await careOf(w.users.doctor.id);
    const bad = async (body: Record<string, unknown>) => (await register(p.id, body)).status;
    expect(await bad({ ...breast, laterality: 'NOT_APPLICABLE' })).toBe(400);
    expect(await bad({ ...breast, icd10: 'I21.9' })).toBe(400);
    expect(await bad({ ...breast, topography: 'C504' })).toBe(400);
    expect(await bad({ ...breast, morphology: '8500' })).toBe(400);
    expect(await bad({ ...breast, diagnosedOn: iso(Date.now() + 3 * DAY) })).toBe(400);
    expect(await bad({ ...breast, tnmT: 'T9' })).toBe(400);
    expect(await bad({ ...breast, tnmN: 'pN4' })).toBe(400);
    expect(await bad({ ...breast, tnmM: 'M2' })).toBe(400);
    const rows = await db.select().from(cancerCases).where(eq(cancerCases.patientId, p.id));
    expect(rows).toHaveLength(0);
  });

  it('returns coding warnings but registers', async () => {
    const p = await careOf(w.users.doctor.id);
    const res = await register(p.id, { ...breast, tnmM: 'M1', stage: 'II' });
    expect(res.status).toBe(201);
    expect(res.body.warnings.map((x: { code: string }) => x.code)).toContain('STAGE_MISMATCH');
  });

  it('only the care team’s doctors register; nobody else reads', async () => {
    const p = await careOf(w.users.doctor.id);
    expect((await register(p.id, breast, w.tokens.colleague)).status).toBe(403);
    expect((await register(p.id, breast, w.tokens.outsideDoctor)).status).toBe(403);
    expect((await register(p.id, breast, w.tokens.nurse)).status).toBe(403);
    expect((await register(p.id, breast, w.tokens.director)).status).toBe(403);
    for (const token of [w.tokens.director, w.tokens.ministry, w.tokens.outsideDoctor]) {
      const res = await api().get(`/api/v1/oncology/patients/${p.id}`).set(bearer(token));
      expect(res.status).toBe(403);
    }
  });
});

describe('duplicates and withdrawal', () => {
  it('warns about a second cancer of the same site within three months', async () => {
    const p = await careOf(w.users.doctor.id);
    const first = await register(p.id, breast);
    expect(first.status).toBe(201);
    const second = await register(p.id, {
      ...breast,
      topography: 'C50.2',
      icd10: 'C50.2',
      diagnosedOn: iso(Date.now() - 2 * DAY),
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('POSSIBLE_DUPLICATE');
    expect(second.body.error.details.duplicateOfId).toBe(first.body.id);

    // Different site: no warning.
    expect(
      (
        await register(p.id, {
          ...breast,
          icd10: 'C18.7',
          topography: 'C18.7',
          laterality: 'NOT_APPLICABLE',
        })
      ).status,
    ).toBe(201);

    // The doctor confirms it is another primary, then marks it a duplicate after all.
    const confirmed = await register(p.id, {
      ...breast,
      laterality: 'RIGHT',
      diagnosedOn: iso(Date.now() - 2 * DAY),
      confirmNotDuplicate: true,
    });
    expect(confirmed.status).toBe(201);
    const marked = await api()
      .post(`/api/v1/oncology/cases/${confirmed.body.id}/mark-duplicate`)
      .set(doctor())
      .send({ duplicateOfId: first.body.id, reason: 'Same tumour registered twice by mistake' });
    expect(marked.status).toBe(200);
    expect(marked.body.status).toBe('DUPLICATE');
    const edit = await api()
      .patch(`/api/v1/oncology/cases/${confirmed.body.id}`)
      .set(doctor())
      .send({ stage: 'III' });
    expect(edit.status).toBe(409);
  });

  it('does not warn about the same site years apart', async () => {
    const p = await careOf(w.users.doctor.id);
    await register(p.id, { ...breast, diagnosedOn: iso(Date.now() - 900 * DAY) });
    expect((await register(p.id, breast)).status).toBe(201);
  });

  it('withdraws a registration with a reason and corrects coding', async () => {
    const p = await careOf(w.users.doctor.id);
    const c = await register(p.id, breast);
    const patched = await api()
      .patch(`/api/v1/oncology/cases/${c.body.id}`)
      .set(doctor())
      .send({ tnmT: 'pT1c', stage: 'I' });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ tnmT: 'pT1c', stage: 'I' });
    const noReason = await api()
      .post(`/api/v1/oncology/cases/${c.body.id}/withdraw`)
      .set(doctor())
      .send({ reason: 'x' });
    expect(noReason.status).toBe(400);
    const res = await api()
      .post(`/api/v1/oncology/cases/${c.body.id}/withdraw`)
      .set(doctor())
      .send({ reason: 'Pathology revised: benign fibroadenoma' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('WITHDRAWN');
    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.resourceId, c.body.id), eq(auditLogs.action, 'oncology.updated')));
    expect(audits.map((a) => a.metadata?.change).sort()).toEqual(['CODING', 'WITHDRAWN']);
    // A withdrawn registration no longer counts for duplicates.
    expect((await register(p.id, breast)).status).toBe(201);
  });
});

describe('death certificate only', () => {
  async function signedDeath(patientId: string, icd10: string, certifiedById: string) {
    await db.transaction(async (tx) => {
      const diedAt = new Date(Date.now() - 5 * DAY);
      await tx.insert(deathRecords).values({
        patientId,
        facilityId: w.facility.id,
        diedAt,
        placeOfDeath: 'HOSPITAL',
        causes: [{ line: 'a', text: 'Cancer', icd10, interval: null }],
        underlyingCauseIcd10: icd10,
        mannerOfDeath: 'NATURAL',
        certifiedById,
        status: 'SIGNED',
        signedAt: diedAt,
        certificateNumber: await nextCertificateNumber(tx, diedAt),
      });
    });
  }

  it('lists cancer deaths without a registration and registers them', async () => {
    const lung = await careOf(w.users.doctor.id);
    const heart = await careOf(w.users.doctor.id);
    const known = await careOf(w.users.doctor.id);
    await register(known.id, { ...breast, diagnosedOn: iso(Date.now() - 400 * DAY) });
    const stranger = await createPatient(w.facility.id);
    await signedDeath(lung.id, 'C34.9', w.users.doctor.id);
    await signedDeath(heart.id, 'I21.9', w.users.doctor.id);
    await signedDeath(known.id, 'C50.9', w.users.doctor.id);
    await signedDeath(stranger.id, 'C16.9', w.users.outsideDoctor.id);

    const list = await api().get('/api/v1/oncology/dco-candidates').set(doctor());
    expect(list.status).toBe(200);
    const ids = list.body.items.map((i: { patientId: string }) => i.patientId);
    expect(ids).toContain(lung.id);
    expect(ids).not.toContain(heart.id);
    expect(ids).not.toContain(known.id);
    expect(ids).not.toContain(stranger.id);

    const colleague = await api()
      .get('/api/v1/oncology/dco-candidates')
      .set(bearer(w.tokens.colleague));
    expect(colleague.body.items.map((i: { patientId: string }) => i.patientId)).not.toContain(
      lung.id,
    );

    const item = list.body.items.find((i: { patientId: string }) => i.patientId === lung.id);
    const reg = await api()
      .post(`/api/v1/oncology/dco-candidates/${item.deathRecordId}/register`)
      .set(doctor())
      .send({});
    expect(reg.status).toBe(201);
    expect(reg.body).toMatchObject({
      basisOfDiagnosis: 'DEATH_CERTIFICATE_ONLY',
      topography: 'C34.9',
      morphology: '8000/3',
      laterality: 'UNKNOWN',
    });
    const again = await api().get('/api/v1/oncology/dco-candidates').set(doctor());
    expect(again.body.items.map((i: { patientId: string }) => i.patientId)).not.toContain(lung.id);
    const twice = await api()
      .post(`/api/v1/oncology/dco-candidates/${item.deathRecordId}/register`)
      .set(doctor())
      .send({});
    expect(twice.status).toBe(404);
  });
});

describe('statistics', () => {
  const MUN = `Testkomuna-${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    // Six lung cancers (3 men, 3 women) and three thyroid cancers in a municipality of 20 people.
    const year = new Date().getUTCFullYear();
    const people = [];
    for (let i = 0; i < 20; i++) {
      people.push(
        await careOf(w.users.doctor.id, {
          municipality: MUN,
          sex: i % 2 ? 'MALE' : 'FEMALE',
          dateOfBirth: '1960-03-01',
        }),
      );
    }
    for (let i = 0; i < 6; i++) {
      await db.insert(cancerCases).values({
        patientId: people[i]!.id,
        facilityId: w.facility.id,
        diagnosedOn: `${year}-01-1${i}`,
        icd10: 'C34.1',
        topography: 'C34.1',
        morphology: '8140/3',
        laterality: 'LEFT',
        basisOfDiagnosis: i === 0 ? 'DEATH_CERTIFICATE_ONLY' : 'HISTOLOGY',
        stage: 'III',
        registeredById: w.users.doctor.id,
      });
    }
    for (let i = 6; i < 9; i++) {
      await db.insert(cancerCases).values({
        patientId: people[i]!.id,
        facilityId: w.otherFacility.id,
        diagnosedOn: `${year}-02-0${i - 5}`,
        icd10: 'C73',
        topography: 'C73.9',
        morphology: '8260/3',
        basisOfDiagnosis: 'CYTOLOGY',
        stage: 'I',
        registeredById: w.users.outsideDoctor.id,
      });
    }
  });

  it('gives the Ministry national incidence with suppression and crude rates', async () => {
    const res = await api().get('/api/v1/oncology/stats').set(bearer(w.tokens.ministry));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('NATIONAL');
    const mun = res.body.byMunicipality.find(
      (m: { municipality: string }) => m.municipality === MUN,
    );
    expect(mun.count).toBe(9);
    expect(mun.population).toBe(20);
    expect(mun.ratePer100k).toBeGreaterThan(0);
    expect(typeof res.body.deathCertificateOnlyCandidates).toBe('number');
    const json = JSON.stringify(res.body);
    expect(json).not.toMatch(/patientId|nationalId|firstName/);
  });

  it('suppresses small cells for the director’s own facility', async () => {
    const res = await api().get('/api/v1/oncology/stats').set(bearer(w.tokens.otherDirector));
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('FACILITY');
    expect(res.body.total).toBeNull(); // 3 cases only
    const thyroid = res.body.bySite.find((s: { code: string }) => s.code === 'C73');
    expect(thyroid).toMatchObject({ total: null, male: null, female: null });
    expect(res.body.byMunicipality[0].ratePer100k).toBeNull();
    expect(res.body.byMunicipality[0].population).toBeNull();
    expect(res.body.quality.histologicallyVerifiedPct).toBeNull();
    expect(res.body.deathCertificateOnlyCandidates).toBeNull();
  });

  it('applies secondary suppression by sex and computes quality indicators', async () => {
    const res = await api().get('/api/v1/oncology/stats').set(bearer(w.tokens.director));
    const lung = res.body.bySite.find((s: { code: string }) => s.code === 'C34');
    expect(lung.total).toBeGreaterThanOrEqual(6);
    expect(res.body.quality.deathCertificateOnlyPct).toBeGreaterThan(0);
  });

  it('is not available to doctors or patients', async () => {
    expect((await api().get('/api/v1/oncology/stats').set(doctor())).status).toBe(403);
    expect((await api().get('/api/v1/oncology/stats').set(bearer(w.tokens.patient))).status).toBe(
      403,
    );
  });
});

describe('tumour boards', () => {
  let meetingId: string;
  let nextMeetingId: string;
  let patientId: string;
  let reviewId: string;
  let thirdToken: string;

  beforeAll(async () => {
    const third = await createUser('DOCTOR', w.facility.id);
    thirdToken = await login(third.email);
    patientId = (await careOf(w.users.doctor.id)).id;
  });

  it('schedules a meeting with a chair from the facility', async () => {
    const wrongChair = await api()
      .post('/api/v1/oncology/mdt/meetings')
      .set(doctor())
      .send({
        tumourGroup: 'BREAST',
        scheduledFor: new Date(Date.now() + 2 * DAY).toISOString(),
        chairId: w.users.outsideDoctor.id,
      });
    expect(wrongChair.status).toBe(400);
    const res = await api()
      .post('/api/v1/oncology/mdt/meetings')
      .set(doctor())
      .send({
        tumourGroup: 'BREAST',
        scheduledFor: new Date(Date.now() + 2 * DAY).toISOString(),
        chairId: w.users.colleague.id,
      });
    expect(res.status).toBe(201);
    meetingId = res.body.id;
    const next = await api()
      .post('/api/v1/oncology/mdt/meetings')
      .set(bearer(w.tokens.colleague))
      .send({ tumourGroup: 'BREAST', scheduledFor: new Date(Date.now() + 9 * DAY).toISOString() });
    nextMeetingId = next.body.id;
    const list = await api().get('/api/v1/oncology/mdt/meetings').set(bearer(w.tokens.nurse));
    expect(list.body.items.map((m: { id: string }) => m.id)).toEqual(
      expect.arrayContaining([meetingId, nextMeetingId]),
    );
    const outside = await api()
      .get('/api/v1/oncology/mdt/meetings')
      .set(bearer(w.tokens.outsideDoctor));
    expect(outside.body.items.map((m: { id: string }) => m.id)).not.toContain(meetingId);
  });

  it('lets the care team add a patient and notifies the chair', async () => {
    const c = await register(patientId, breast);
    const notInCare = await api()
      .post(`/api/v1/oncology/mdt/meetings/${meetingId}/cases`)
      .set(bearer(thirdToken))
      .send({ patientId, question: 'Surgery first?' });
    expect(notInCare.status).toBe(403);
    const res = await api()
      .post(`/api/v1/oncology/mdt/meetings/${meetingId}/cases`)
      .set(doctor())
      .send({
        patientId,
        cancerCaseId: c.body.id,
        question: 'Surgery first or neoadjuvant chemotherapy?',
        summary: 'IDC left breast 28 mm, one positive node, ER+/HER2–.',
      });
    expect(res.status).toBe(201);
    reviewId = res.body.id;
    const again = await api()
      .post(`/api/v1/oncology/mdt/meetings/${meetingId}/cases`)
      .set(doctor())
      .send({ patientId, question: 'Again?' + ' please' });
    expect(again.status).toBe(409);
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.colleague.id));
    expect(notes.some((n) => n.title.startsWith('A patient was added to the tumour board'))).toBe(
      true,
    );
    expect(notes.every((n) => !/breast|IDC/i.test(n.title))).toBe(true);
  });

  it('shows clinical details only to the chair, referrer and care team', async () => {
    const chair = await api()
      .get(`/api/v1/oncology/mdt/meetings/${meetingId}`)
      .set(bearer(w.tokens.colleague));
    expect(chair.status).toBe(200);
    expect(chair.body.isChair).toBe(true);
    expect(chair.body.cases[0].details.summary).toContain('IDC');
    const other = await api()
      .get(`/api/v1/oncology/mdt/meetings/${meetingId}`)
      .set(bearer(thirdToken));
    expect(other.body.cases[0].patient.lastName).toBeTruthy();
    expect(other.body.cases[0].details).toBeNull();
    const nurse = await api()
      .get(`/api/v1/oncology/mdt/meetings/${meetingId}`)
      .set(bearer(w.tokens.nurse));
    expect(nurse.body.cases[0].details).toBeNull();
    const outside = await api()
      .get(`/api/v1/oncology/mdt/meetings/${meetingId}`)
      .set(bearer(w.tokens.outsideDoctor));
    expect(outside.status).toBe(404);
    const director = await api()
      .get(`/api/v1/oncology/mdt/meetings/${meetingId}`)
      .set(bearer(w.tokens.director));
    expect(director.status).toBe(403);
    const views = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.patientId, patientId), eq(auditLogs.action, 'patient.record.viewed')),
      );
    expect(views.some((v) => v.metadata?.section === 'tumour_board_agenda')).toBe(true);
  });

  it('only the chair records the recommendation; the referrer is notified', async () => {
    const notChair = await api()
      .post(`/api/v1/oncology/mdt/cases/${reviewId}/decision`)
      .set(doctor())
      .send({
        status: 'DISCUSSED',
        recommendation: 'COMBINED',
        recommendationText: 'Neoadjuvant chemotherapy.',
      });
    expect(notChair.status).toBe(403);
    const noText = await api()
      .post(`/api/v1/oncology/mdt/cases/${reviewId}/decision`)
      .set(bearer(w.tokens.colleague))
      .send({ status: 'DISCUSSED', recommendation: 'COMBINED' });
    expect(noText.status).toBe(400);
    const informedEarly = await api()
      .post(`/api/v1/oncology/mdt/cases/${reviewId}/informed`)
      .set(doctor());
    expect(informedEarly.status).toBe(409);
    const res = await api()
      .post(`/api/v1/oncology/mdt/cases/${reviewId}/decision`)
      .set(bearer(w.tokens.colleague))
      .send({
        status: 'DISCUSSED',
        recommendation: 'COMBINED',
        recommendationText: 'Neoadjuvant chemotherapy, then breast-conserving surgery.',
      });
    expect(res.status).toBe(200);
    expect(res.body.updated.status).toBe('DISCUSSED');
    const twice = await api()
      .post(`/api/v1/oncology/mdt/cases/${reviewId}/decision`)
      .set(bearer(w.tokens.colleague))
      .send({
        status: 'DISCUSSED',
        recommendation: 'SURGERY',
        recommendationText: 'Changed our mind.',
      });
    expect(twice.status).toBe(409);
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, w.users.doctor.id));
    expect(
      notes.some((n) => n.title === 'Tumour board recommendation recorded for your patient'),
    ).toBe(true);

    const informed = await api()
      .post(`/api/v1/oncology/mdt/cases/${reviewId}/informed`)
      .set(doctor());
    expect(informed.status).toBe(200);
    expect(informed.body.patientInformedAt).toBeTruthy();

    const chart = await api().get(`/api/v1/oncology/patients/${patientId}`).set(doctor());
    expect(chart.body.reviews[0]).toMatchObject({
      status: 'DISCUSSED',
      recommendation: 'COMBINED',
    });
  });

  it('defers a patient to the next meeting and records the meeting', async () => {
    const p2 = await careOf(w.users.doctor.id);
    await db.insert(careAssignments).values({ patientId: p2.id, doctorId: w.users.colleague.id });
    const added = await api()
      .post(`/api/v1/oncology/mdt/meetings/${meetingId}/cases`)
      .set(doctor())
      .send({ patientId: p2.id, question: 'Needs imaging review' });
    const cancelBlocked = await api()
      .post(`/api/v1/oncology/mdt/meetings/${meetingId}/cancel`)
      .set(bearer(w.tokens.colleague))
      .send({ reason: 'Chair on leave this week' });
    expect(cancelBlocked.status).toBe(409);
    const deferred = await api()
      .post(`/api/v1/oncology/mdt/cases/${added.body.id}/decision`)
      .set(bearer(w.tokens.colleague))
      .send({ status: 'DEFERRED', deferToMeetingId: nextMeetingId });
    expect(deferred.status).toBe(200);
    expect(deferred.body.deferredTo.meetingId).toBe(nextMeetingId);
    const [moved] = await db
      .select()
      .from(mdtCaseReviews)
      .where(and(eq(mdtCaseReviews.meetingId, nextMeetingId), eq(mdtCaseReviews.patientId, p2.id)));
    expect(moved?.status).toBe('PENDING');

    const notChair = await api()
      .post(`/api/v1/oncology/mdt/meetings/${meetingId}/hold`)
      .set(doctor())
      .send({ attendees: ['Dr A – oncology', 'Dr B – surgery'] });
    expect(notChair.status).toBe(403);
    const held = await api()
      .post(`/api/v1/oncology/mdt/meetings/${meetingId}/hold`)
      .set(bearer(w.tokens.colleague))
      .send({ attendees: ['Dr A – oncology', 'Dr B – surgery', 'Dr C – radiology'] });
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({ status: 'HELD' });
    const addAfter = await api()
      .post(`/api/v1/oncology/mdt/meetings/${meetingId}/cases`)
      .set(doctor())
      .send({ patientId: p2.id, question: 'Too late now' });
    expect(addAfter.status).toBe(409);
    const recorded = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.patientId, p2.id), eq(auditLogs.action, 'oncology.mdt_review')));
    expect(recorded.map((a) => a.metadata?.event).sort()).toEqual(['ADDED', 'DEFERRED']);
  });
});
