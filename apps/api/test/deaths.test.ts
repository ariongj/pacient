import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  admissions,
  appointments,
  auditLogs,
  careAssignments,
  careUnits,
  deathRecordAmendments,
  deathRecords,
  notifications,
  patients,
  registerEnrolments,
  waitingListEntries,
  waitingListEvents,
} from '../src/db/schema.js';
import {
  checkDeath,
  chapterOf,
  buildMortalityStats,
} from '../src/modules/deaths/deaths.service.js';
import { api, bearer, createPatient, createUser, createWorld, login, PASSWORD } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let unitId: string;

const HOUR = 3_600_000;
const base = {
  placeOfDeath: 'HOSPITAL',
  mannerOfDeath: 'NATURAL',
  causes: [
    { line: 'a', text: 'Acute myocardial infarction', icd10: 'I21.9', interval: '2 hours' },
    { line: 'b', text: 'Coronary atherosclerosis', icd10: 'I25.1', interval: '10 years' },
    { line: 'II', text: 'Type 2 diabetes', icd10: 'E11.9' },
  ],
  underlyingCauseIcd10: 'I25.1',
};
const body = (extra: Record<string, unknown> = {}) => ({
  ...base,
  diedAt: new Date(Date.now() - 2 * HOUR).toISOString(),
  ...extra,
});

async function elderlyPatient(
  opts: { sex?: 'MALE' | 'FEMALE'; dob?: string; userId?: string } = {},
) {
  const p = await createPatient(w.facility.id, {
    doctorId: w.users.doctor.id,
    userId: opts.userId,
  });
  await db
    .update(patients)
    .set({ dateOfBirth: opts.dob ?? '1940-03-01', sex: opts.sex ?? 'MALE' })
    .where(eq(patients.id, p.id));
  return p;
}

const doctor = () => bearer(w.tokens.doctor);
const draft = (patientId: string, extra: Record<string, unknown> = {}) =>
  api().post(`/api/v1/deaths/patients/${patientId}`).set(doctor()).send(body(extra));

beforeAll(async () => {
  w = await createWorld();
  const [unit] = await db
    .insert(careUnits)
    .values({
      facilityId: w.facility.id,
      name: 'Interna D',
      code: `ID${Math.floor(Math.random() * 1e6)}`,
      type: 'GENERAL_WARD',
    })
    .returning();
  unitId = unit!.id;
});

describe('certification rules', () => {
  const patient = { dateOfBirth: '1940-01-01', sex: 'MALE' as const };
  const values = (extra: Partial<Parameters<typeof checkDeath>[0]> = {}) => ({
    diedAt: new Date(Date.now() - HOUR),
    placeOfDeath: 'HOSPITAL',
    placeDetail: null,
    causes: base.causes.map((c) => ({ ...c, line: c.line as 'a', interval: c.interval ?? null })),
    underlyingCauseIcd10: 'I25.1',
    mannerOfDeath: 'NATURAL',
    autopsy: 'NONE',
    pregnancyStatus: null,
    perinatal: null,
    reportedToForensics: false,
    ...extra,
  });

  it('accepts a complete natural death without warnings', () => {
    expect(checkDeath(values(), patient)).toEqual({ problems: [], warnings: [] });
  });

  it('warns about modes of dying, ill-defined causes and a non-lowest underlying cause', () => {
    const mode = checkDeath(
      values({
        causes: [{ line: 'a', text: 'Cardiac arrest', icd10: 'I46.9', interval: null }],
        underlyingCauseIcd10: 'I46.9',
      }),
      patient,
    );
    expect(mode.warnings.map((x) => x.code)).toContain('MODE_OF_DYING_ONLY');
    const ill = checkDeath(
      values({
        causes: [{ line: 'a', text: 'Unknown', icd10: 'R99', interval: null }],
        underlyingCauseIcd10: 'R99',
      }),
      patient,
    );
    expect(ill.warnings.map((x) => x.code)).toEqual(
      expect.arrayContaining(['ILL_DEFINED_UNDERLYING', 'MODE_OF_DYING_ONLY']),
    );
    const notLowest = checkDeath(values({ underlyingCauseIcd10: 'I21.9' }), patient);
    expect(notLowest.warnings.map((x) => x.code)).toEqual(['UNDERLYING_NOT_LOWEST_LINE']);
  });

  it('requires line (a), no gaps, codes, pregnancy status, perinatal data and forensic reports', () => {
    const gap = checkDeath(
      values({
        causes: [
          { line: 'a', text: 'x', icd10: 'I21.9', interval: null },
          { line: 'c', text: 'y', icd10: 'I25.1', interval: null },
        ],
      }),
      patient,
    );
    expect(gap.problems.map((p) => p.code)).toContain('PART_ONE_GAP');
    const noA = checkDeath(
      values({ causes: [{ line: 'b', text: 'x', icd10: 'I25.1', interval: null }] }),
      patient,
    );
    expect(noA.problems.map((p) => p.code)).toContain('PART_ONE_LINE_A');
    const woman = checkDeath(values(), { dateOfBirth: '1990-01-01', sex: 'FEMALE' });
    expect(woman.problems.map((p) => p.code)).toEqual(['PREGNANCY_STATUS_REQUIRED']);
    const infant = checkDeath(values(), {
      dateOfBirth: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
      sex: 'MALE',
    });
    expect(infant.problems.map((p) => p.code)).toEqual(['PERINATAL_REQUIRED']);
    const injury = checkDeath(
      values({
        mannerOfDeath: 'ACCIDENT',
        causes: [{ line: 'a', text: 'Head injury', icd10: 'S06.9', interval: null }],
        underlyingCauseIcd10: 'S06.9',
      }),
      patient,
    );
    expect(injury.problems.map((p) => p.code)).toEqual(['FORENSIC_REPORT_REQUIRED']);
    expect(injury.warnings.map((x) => x.code)).toContain('EXTERNAL_CAUSE_EXPECTED');
    const future = checkDeath(values({ diedAt: new Date(Date.now() + 2 * HOUR) }), patient);
    expect(future.problems.map((p) => p.code)).toContain('DIED_IN_FUTURE');
  });

  it('groups causes by ICD-10 chapter and suppresses small cells', () => {
    expect(chapterOf('I25.1')?.chapter).toBe('IX');
    expect(chapterOf('C34.9')?.chapter).toBe('II');
    expect(chapterOf('V89.2')?.chapter).toBe('XX');
    expect(chapterOf('U07.1')?.chapter).toBe('XXII');
    const d = (icd: string, sex = 'MALE') => ({
      ...values({ underlyingCauseIcd10: icd }),
      facilityId: w.facility.id,
      admissionId: null,
      dateOfBirth: '1940-01-01',
      sex,
    });
    const stats = buildMortalityStats(
      [...Array.from({ length: 6 }, () => d('I21.9')), d('C34.9'), d('C18.9', 'FEMALE')],
      {
        from: new Date(Date.now() - 30 * 86_400_000),
        to: new Date(Date.now() + 86_400_000),
        discharges: 100,
        deceasedDischarges: 6,
        threshold: 5,
      },
    );
    expect(stats.total).toBe(8);
    expect(stats.byChapter.find((c) => c.chapter === 'IX')?.count).toBe(6);
    expect(stats.byChapter.find((c) => c.chapter === 'II')?.count).toBeNull();
    expect(stats.inHospital).toEqual({
      deaths: 8,
      discharges: 100,
      deceasedDischarges: 6,
      ratePer100: 6,
    });
  });
});

describe('drafting', () => {
  it('validates input and keeps one certificate per patient', async () => {
    const p = await elderlyPatient();
    const bad = await api()
      .post(`/api/v1/deaths/patients/${p.id}`)
      .set(doctor())
      .send(body({ underlyingCauseIcd10: 'heart' }));
    expect(bad.status).toBe(400);
    const created = await draft(p.id);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'DRAFT',
      certificateNumber: null,
      underlyingCauseIcd10: 'I25.1',
      canEdit: true,
      checks: { problems: [], warnings: [] },
    });
    expect((await draft(p.id)).status).toBe(409);

    const edited = await api()
      .patch(`/api/v1/deaths/${created.body.id}`)
      .set(doctor())
      .send(
        body({
          causes: [{ line: 'a', text: 'Cardiac arrest', icd10: 'I46.9' }],
          underlyingCauseIcd10: 'I46.9',
        }),
      );
    expect(edited.status).toBe(200);
    expect(edited.body.checks.warnings.map((x: { code: string }) => x.code)).toContain(
      'MODE_OF_DYING_ONLY',
    );

    const view = await api().get(`/api/v1/deaths/patients/${p.id}`).set(bearer(w.tokens.nurse));
    // The nurse is not in the care team.
    expect(view.status).toBe(403);

    expect((await api().delete(`/api/v1/deaths/${created.body.id}`).set(doctor())).status).toBe(
      204,
    );
    const after = await api().get(`/api/v1/deaths/patients/${p.id}`).set(doctor());
    expect(after.body).toMatchObject({ record: null, canCertify: true });
  });

  it('refuses doctors outside the care team and other roles', async () => {
    const p = await elderlyPatient();
    const outside = await api()
      .post(`/api/v1/deaths/patients/${p.id}`)
      .set(bearer(w.tokens.outsideDoctor))
      .send(body());
    expect(outside.status).toBe(403);
    const colleague = await api()
      .post(`/api/v1/deaths/patients/${p.id}`)
      .set(bearer(w.tokens.colleague))
      .send(body());
    expect(colleague.status).toBe(403);
    for (const token of [
      w.tokens.nurse,
      w.tokens.director,
      w.tokens.reception,
      w.tokens.ministry,
    ]) {
      expect(
        (await api().post(`/api/v1/deaths/patients/${p.id}`).set(bearer(token)).send(body()))
          .status,
      ).toBe(403);
    }
    expect(
      (await api().get(`/api/v1/deaths/patients/${p.id}`).set(bearer(w.tokens.director))).status,
    ).toBe(403);
    expect((await api().get('/api/v1/deaths').set(bearer(w.tokens.reception))).status).toBe(403);
    expect((await api().get('/api/v1/deaths').set(bearer(w.tokens.ministry))).status).toBe(403);
  });
});

describe('signing', () => {
  let patientId: string;
  let recordId: string;
  let portalEmail: string;

  beforeAll(async () => {
    const portal = await createUser('PATIENT');
    portalEmail = portal.email;
    const p = await elderlyPatient({ userId: portal.id });
    patientId = p.id;
    await db.insert(careAssignments).values({ patientId, doctorId: w.users.colleague.id });
    // A future and a past appointment, a waiting-list entry and a register enrolment.
    await db.insert(appointments).values([
      {
        patientId,
        doctorId: w.users.colleague.id,
        facilityId: w.facility.id,
        scheduledAt: new Date(Date.now() + 5 * 86_400_000),
        reason: 'Kontroll',
        status: 'CONFIRMED',
      },
      {
        patientId,
        doctorId: w.users.doctor.id,
        facilityId: w.facility.id,
        scheduledAt: new Date(Date.now() - 5 * 86_400_000),
        reason: 'Kontroll',
        status: 'COMPLETED',
      },
    ]);
    await db.insert(waitingListEntries).values({
      patientId,
      facilityId: w.facility.id,
      specialty: 'CARDIOLOGY',
      procedureName: 'Koronarografi',
      priority: 'ROUTINE',
      addedById: w.users.doctor.id,
      targetDate: '2027-01-01',
    });
    await db.insert(registerEnrolments).values({
      patientId,
      register: 'DIABETES',
      facilityId: w.facility.id,
      source: 'MANUAL',
    });
    await db.insert(admissions).values({
      patientId,
      facilityId: w.facility.id,
      unitId,
      admittingDoctorId: w.users.doctor.id,
      attendingDoctorId: w.users.doctor.id,
      source: 'EMERGENCY',
      reason: 'Dhimbje gjoksi',
      admittedAt: new Date(Date.now() - 20 * HOUR),
    });
    const created = await draft(patientId, { underlyingCauseIcd10: 'I21.9' });
    expect(created.status).toBe(201);
    recordId = created.body.id;
  });

  it('is refused while the patient is still admitted, then needs the warnings acknowledged', async () => {
    const admitted = await api().post(`/api/v1/deaths/${recordId}/sign`).set(doctor()).send({});
    expect(admitted.status).toBe(409);
    expect(admitted.body.error.code).toBe('WARNINGS_NOT_ACKNOWLEDGED');
    expect(admitted.body.error.details[0].code).toBe('UNDERLYING_NOT_LOWEST_LINE');
    const stillAdmitted = await api()
      .post(`/api/v1/deaths/${recordId}/sign`)
      .set(doctor())
      .send({ acknowledgedWarnings: ['UNDERLYING_NOT_LOWEST_LINE'] });
    expect(stillAdmitted.status).toBe(409);
    expect(stillAdmitted.body.error.message).toMatch(/still admitted/);
    await db
      .update(admissions)
      .set({ status: 'DISCHARGED', dischargedAt: new Date(), disposition: 'DECEASED' })
      .where(eq(admissions.patientId, patientId));
  });

  it('signs, numbers the certificate and stops everything that assumes a living patient', async () => {
    const res = await api()
      .post(`/api/v1/deaths/${recordId}/sign`)
      .set(doctor())
      .send({ acknowledgedWarnings: ['UNDERLYING_NOT_LOWEST_LINE'] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SIGNED');
    expect(res.body.certificateNumber).toMatch(/^VD-\d{4}-\d{6}$/);
    expect(res.body.effects).toEqual({
      appointmentsCancelled: 1,
      waitingListRemoved: 1,
      registersLeft: 1,
      portalDisabled: true,
    });
    const [p] = await db.select().from(patients).where(eq(patients.id, patientId));
    expect(p!.deceasedAt).not.toBeNull();
    const appts = await db.select().from(appointments).where(eq(appointments.patientId, patientId));
    expect(appts.map((a) => a.status).sort()).toEqual(['CANCELLED', 'COMPLETED']);
    const [entry] = await db
      .select()
      .from(waitingListEntries)
      .where(eq(waitingListEntries.patientId, patientId));
    expect(entry).toMatchObject({ status: 'REMOVED', removedReason: 'DECEASED' });
    const events = await db
      .select()
      .from(waitingListEvents)
      .where(eq(waitingListEvents.entryId, entry!.id));
    expect(events.map((e) => e.event)).toContain('REMOVED');
    const [enrolment] = await db
      .select()
      .from(registerEnrolments)
      .where(eq(registerEnrolments.patientId, patientId));
    expect(enrolment).toMatchObject({ status: 'LEFT', leftReason: 'Deceased' });
    // The patient's portal account no longer signs in.
    const signIn = await api()
      .post('/api/v1/auth/login')
      .send({ email: portalEmail, password: PASSWORD });
    expect(signIn.status).not.toBe(200);
    // The care team is told, without the cause of death.
    const told = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, w.users.colleague.id), eq(notifications.type, 'death')));
    expect(told).toHaveLength(1);
    expect(told[0]!.title).not.toMatch(/infar|I21/i);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'death.signed'), eq(auditLogs.resourceId, recordId)));
    expect(audit).toHaveLength(1);
    // Sequence: the next certificate gets the next number.
    const other = await elderlyPatient();
    const second = await draft(other.id);
    const signed2 = await api()
      .post(`/api/v1/deaths/${second.body.id}/sign`)
      .set(doctor())
      .send({});
    expect(signed2.status).toBe(200);
    const n1 = Number(res.body.certificateNumber.slice(-6));
    const n2 = Number(signed2.body.certificateNumber.slice(-6));
    expect(n2).toBeGreaterThan(n1);
  });

  it('keeps the signed certificate immutable', async () => {
    expect(
      (await api().patch(`/api/v1/deaths/${recordId}`).set(doctor()).send(body())).status,
    ).toBe(409);
    expect((await api().delete(`/api/v1/deaths/${recordId}`).set(doctor())).status).toBe(409);
    await expect(
      db
        .update(deathRecords)
        .set({ underlyingCauseIcd10: 'C34.9' })
        .where(eq(deathRecords.id, recordId)),
    ).rejects.toThrow();
    await expect(db.delete(deathRecords).where(eq(deathRecords.id, recordId))).rejects.toThrow();
    expect(
      (await api().post(`/api/v1/deaths/${recordId}/sign`).set(doctor()).send({})).status,
    ).toBe(409);
  });

  it('records amendments, shows the effective values and keeps the original', async () => {
    const short = await api()
      .post(`/api/v1/deaths/${recordId}/amendments`)
      .set(doctor())
      .send({ changes: { underlyingCauseIcd10: 'I25.1' }, reason: 'typo' });
    expect(short.status).toBe(400);
    const same = await api()
      .post(`/api/v1/deaths/${recordId}/amendments`)
      .set(doctor())
      .send({ changes: { underlyingCauseIcd10: 'I21.9' }, reason: 'No real change here' });
    expect(same.status).toBe(400);
    const res = await api()
      .post(`/api/v1/deaths/${recordId}/amendments`)
      .set(doctor())
      .send({
        changes: { underlyingCauseIcd10: 'I25.1', autopsy: 'PERFORMED' },
        reason: 'Autopsy findings: coronary atherosclerosis is the underlying cause',
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'SIGNED',
      underlyingCauseIcd10: 'I25.1',
      autopsy: 'PERFORMED',
      original: { underlyingCauseIcd10: 'I21.9', autopsy: 'NONE' },
    });
    expect(res.body.amendments).toHaveLength(1);
    expect(res.body.amendments[0].changes.underlyingCauseIcd10).toEqual(['I21.9', 'I25.1']);
    const [row] = await db.select().from(deathRecords).where(eq(deathRecords.id, recordId));
    expect(row!.underlyingCauseIcd10).toBe('I21.9');
    await expect(
      db
        .update(deathRecordAmendments)
        .set({ reason: 'changed' })
        .where(eq(deathRecordAmendments.deathRecordId, recordId)),
    ).rejects.toThrow();
    expect(
      (
        await api()
          .post(`/api/v1/deaths/${recordId}/amendments`)
          .set(bearer(w.tokens.outsideDoctor))
          .send({ changes: { autopsy: 'NONE' }, reason: 'Outside doctor attempt' })
      ).status,
    ).toBe(403);
  });

  it('exports the death in FHIR and lists it for the director without causes', async () => {
    const fhir = await api().get(`/api/v1/fhir/Patient/${patientId}/$everything`).set(doctor());
    expect(fhir.status).toBe(200);
    const bundle = JSON.parse(fhir.text) as { entry: { resource: Record<string, unknown> }[] };
    const patient = bundle.entry.find((e) => e.resource.resourceType === 'Patient')!.resource;
    expect(patient.deceasedDateTime).toBeTruthy();

    const list = await api().get('/api/v1/deaths?status=SIGNED').set(bearer(w.tokens.director));
    expect(list.status).toBe(200);
    const item = list.body.items.find((i: { id: string }) => i.id === recordId);
    expect(item).toMatchObject({ status: 'SIGNED', amendments: 1 });
    expect(item.causes).toBeUndefined();
    expect(item.underlyingCauseIcd10).toBeUndefined();
    const other = await api().get('/api/v1/deaths').set(bearer(w.tokens.otherDirector));
    expect(other.body.items.find((i: { id: string }) => i.id === recordId)).toBeUndefined();
  });

  it('feeds the civil registry with identity, date and place only, and records the acknowledgement', async () => {
    const client = await api()
      .post('/api/v1/partner/clients')
      .set(bearer(w.tokens.ministry))
      .send({ name: 'Civil registry deaths', organisation: 'ARC', scopes: ['deaths.read'] });
    expect(client.status).toBe(201);
    const key = { Authorization: `Bearer ${client.body.apiKey}` };
    const feed = await api().get('/api/v1/partner/deaths').set(key);
    expect(feed.status).toBe(200);
    const [p] = await db.select().from(patients).where(eq(patients.id, patientId));
    const item = feed.body.items.find(
      (i: { nationalId: string }) => i.nationalId === p!.nationalId,
    );
    expect(item).toMatchObject({ placeOfDeath: 'HOSPITAL', facilityCode: w.facility.code });
    expect(item.certificateNumber).toMatch(/^VD-/);
    expect(item.amendedAt).toBeTruthy();
    expect(item.causes).toBeUndefined();
    expect(item.underlyingCauseIcd10).toBeUndefined();
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, 'partner.api.access'),
          eq(auditLogs.patientId, patientId),
          sql`${auditLogs.metadata}->>'clientId' = ${client.body.id}`,
        ),
      );
    expect(audits.length).toBeGreaterThan(0);

    const ack = await api()
      .post(`/api/v1/partner/deaths/${item.certificateNumber}/acknowledge`)
      .set(key)
      .send({ reference: 'ARC-2026-777' });
    expect(ack.status).toBe(200);
    const again = await api()
      .post(`/api/v1/partner/deaths/${item.certificateNumber}/acknowledge`)
      .set(key)
      .send({ reference: 'ARC-2026-777' });
    expect(again.status).toBe(200);
    const clash = await api()
      .post(`/api/v1/partner/deaths/${item.certificateNumber}/acknowledge`)
      .set(key)
      .send({ reference: 'ARC-OTHER' });
    expect(clash.status).toBe(409);
    const [row] = await db.select().from(deathRecords).where(eq(deathRecords.id, recordId));
    expect(row!.civilRegistryReference).toBe('ARC-2026-777');
    const missing = await api()
      .post('/api/v1/partner/deaths/VD-1999-000001/acknowledge')
      .set(key)
      .send({ reference: 'x' });
    expect(missing.status).toBe(404);

    const noScope = await api()
      .post('/api/v1/partner/clients')
      .set(bearer(w.tokens.ministry))
      .send({ name: 'Stats only', organisation: 'ASK', scopes: ['stats.read'] });
    expect(
      (
        await api()
          .get('/api/v1/partner/deaths')
          .set({ Authorization: `Bearer ${noScope.body.apiKey}` })
      ).status,
    ).toBe(403);
  });

  it('reports suppressed mortality statistics to the director and the Ministry', async () => {
    const national = await api().get('/api/v1/deaths/stats').set(bearer(w.tokens.ministry));
    expect(national.status).toBe(200);
    expect(national.body.scope).toBe('NATIONAL');
    const ok = (n: number | null) => n === null || n === 0 || n >= 5;
    for (const m of national.body.byMonth) expect(ok(m.count)).toBe(true);
    for (const c of national.body.byChapter) expect(ok(c.count)).toBe(true);
    for (const b of national.body.byAgeBand) {
      expect(ok(b.male) && ok(b.female) && ok(b.total)).toBe(true);
    }
    expect(JSON.stringify(national.body)).not.toMatch(/firstName|nationalId/);
    const facility = await api().get('/api/v1/deaths/stats').set(bearer(w.tokens.director));
    expect(facility.status).toBe(200);
    expect(facility.body.scope).toBe('FACILITY');
    expect((await api().get('/api/v1/deaths/stats').set(doctor())).status).toBe(403);
  });
  it('lets the Ministry withdraw a certificate issued in error and restores the record', async () => {
    const [signedRow] = await db.select().from(deathRecords).where(eq(deathRecords.id, recordId));
    const number = signedRow!.certificateNumber!;
    expect((await api().get(`/api/v1/deaths/by-number/${number}`).set(doctor())).status).toBe(403);
    const found = await api()
      .get(`/api/v1/deaths/by-number/${number}`)
      .set(bearer(w.tokens.ministry));
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ id: recordId, status: 'SIGNED' });
    expect(found.body.causes).toBeUndefined();

    expect(
      (
        await api()
          .post(`/api/v1/deaths/${recordId}/withdraw`)
          .set(doctor())
          .send({ reason: 'Certified for the wrong person by mistake' })
      ).status,
    ).toBe(403);
    expect(
      (
        await api()
          .post(`/api/v1/deaths/${recordId}/withdraw`)
          .set(bearer(w.tokens.ministry))
          .send({ reason: 'wrong' })
      ).status,
    ).toBe(400);
    const res = await api()
      .post(`/api/v1/deaths/${recordId}/withdraw`)
      .set(bearer(w.tokens.ministry))
      .send({ reason: 'Certified for the wrong person by mistake (identity mix-up)' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'WITHDRAWN',
      effects: { registersRestored: 1, waitingListRestored: 1, portalRestored: true },
    });
    const [p] = await db.select().from(patients).where(eq(patients.id, patientId));
    expect(p!.deceasedAt).toBeNull();
    const [entry] = await db
      .select()
      .from(waitingListEntries)
      .where(eq(waitingListEntries.patientId, patientId));
    expect(entry).toMatchObject({ status: 'WAITING', removedReason: null });
    const [enrolment] = await db
      .select()
      .from(registerEnrolments)
      .where(eq(registerEnrolments.patientId, patientId));
    expect(enrolment).toMatchObject({ status: 'ACTIVE', leftReason: null });
    // Cancelled appointments stay cancelled; the care team is asked to rebook.
    const appts = await db.select().from(appointments).where(eq(appointments.patientId, patientId));
    expect(appts.map((a) => a.status).sort()).toEqual(['CANCELLED', 'COMPLETED']);
    const told = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, w.users.colleague.id), eq(notifications.type, 'death')));
    expect(told.some((n) => /withdrawn/i.test(n.title))).toBe(true);
    // The portal account signs in again.
    const signIn = await api()
      .post('/api/v1/auth/login')
      .send({ email: portalEmail, password: PASSWORD });
    expect(signIn.status).toBe(200);

    // Final: no second withdrawal, no amendment, no direct change.
    expect(
      (
        await api()
          .post(`/api/v1/deaths/${recordId}/withdraw`)
          .set(bearer(w.tokens.ministry))
          .send({ reason: 'Certified for the wrong person by mistake again' })
      ).status,
    ).toBe(409);
    await expect(
      db.update(deathRecords).set({ status: 'SIGNED' }).where(eq(deathRecords.id, recordId)),
    ).rejects.toThrow();

    // The civil registry sees the withdrawal; the chart allows a new certificate.
    const client = await api()
      .post('/api/v1/partner/clients')
      .set(bearer(w.tokens.ministry))
      .send({ name: 'Civil registry withdrawals', organisation: 'ARC', scopes: ['deaths.read'] });
    const feed = await api()
      .get('/api/v1/partner/deaths')
      .set({ Authorization: `Bearer ${client.body.apiKey}` });
    const item = feed.body.items.find(
      (i: { certificateNumber: string }) => i.certificateNumber === number,
    );
    expect(item).toMatchObject({ status: 'WITHDRAWN' });
    expect(item.withdrawnAt).toBeTruthy();
    const chart = await api()
      .get(`/api/v1/deaths/patients/${patientId}`)
      .set(bearer(w.tokens.colleague));
    expect(chart.status).toBe(200);
    expect(chart.body.record).toBeNull();
    expect(chart.body.withdrawn).toHaveLength(1);
    expect(chart.body.canCertify).toBe(true);
    const audit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'death.withdrawn'), eq(auditLogs.resourceId, recordId)));
    expect(audit).toHaveLength(1);
  });
});

describe('reminders skip deceased patients', () => {
  it('does not send appointment reminders for a deceased patient', async () => {
    const { runAppointmentRemindersOnce } = await import('../src/modules/scheduling/reminders.js');
    const p = await elderlyPatient();
    const at = new Date(Date.now() + 24 * HOUR);
    const [appt] = await db
      .insert(appointments)
      .values({
        patientId: p.id,
        doctorId: w.users.doctor.id,
        facilityId: w.facility.id,
        scheduledAt: at,
        reason: 'Kontroll',
        status: 'CONFIRMED',
      })
      .returning();
    await db.update(patients).set({ deceasedAt: new Date() }).where(eq(patients.id, p.id));
    await runAppointmentRemindersOnce();
    const [after] = await db.select().from(appointments).where(eq(appointments.id, appt!.id));
    expect(after!.reminderSentAt).toBeNull();
    // A token is still valid for the doctor (sanity).
    expect(await login(w.users.doctor.email)).toBeTruthy();
  });
});
