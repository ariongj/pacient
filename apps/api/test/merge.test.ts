import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  appointments,
  careAssignments,
  consentRecords,
  encounters,
  guardianships,
  labResults,
  medicationAdministrations,
  patients,
  promAssignments,
  prescriptions,
} from '../src/db/schema.js';
import {
  EXCLUDED_REFERENCES,
  OTHER_PATIENT_COLUMNS,
  PATIENT_TABLES,
  scorePair,
} from '../src/modules/merge/merge.service.js';
import { api, bearer, createUser, createWorld, login, nextNationalId } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});

const merges = (token = w.tokens.director) => ({
  get: (path = '') => api().get(`/api/v1/patient-merges${path}`).set(bearer(token)),
  post: (path: string, body: object) =>
    api().post(`/api/v1/patient-merges${path}`).set(bearer(token)).send(body),
});

async function person(
  first: string,
  last: string,
  extra: Partial<typeof patients.$inferInsert> = {},
) {
  const [p] = await db
    .insert(patients)
    .values({
      nationalId: nextNationalId(),
      firstName: first,
      lastName: last,
      dateOfBirth: '1979-04-12',
      sex: 'MALE',
      primaryFacilityId: w.facility.id,
      ...extra,
    })
    .returning();
  return p!;
}

/** Clinical history on a record: a signed visit, a prescription with a dose given, a result,
 * a consent decision, an appointment and a care-team membership. */
async function history(patientId: string) {
  const doctorId = w.users.doctor.id;
  const [enc] = await db
    .insert(encounters)
    .values({
      patientId,
      doctorId,
      facilityId: w.facility.id,
      type: 'OUTPATIENT',
      reason: 'Check-up',
      notes: 'Signed note',
      noteStatus: 'SIGNED',
      signedAt: new Date(),
    })
    .returning();
  const [rx] = await db
    .insert(prescriptions)
    .values({
      patientId,
      doctorId,
      medication: 'Amlodipine',
      dosage: '5 mg',
      frequency: 'daily',
      startDate: '2026-01-01',
    })
    .returning();
  const [mar] = await db
    .insert(medicationAdministrations)
    .values({
      prescriptionId: rx!.id,
      patientId,
      administeredById: w.users.nurse.id,
      status: 'GIVEN',
    })
    .returning();
  const [lab] = await db
    .insert(labResults)
    .values({
      patientId,
      orderedById: doctorId,
      testName: 'Haemoglobin',
      value: '130',
      unit: 'g/L',
      flag: 'NORMAL',
      status: 'FINAL',
      collectedAt: new Date(),
    })
    .returning();
  const [consent] = await db
    .insert(consentRecords)
    .values({
      patientId,
      type: 'RESEARCH',
      decision: 'GRANTED',
      method: 'IN_PERSON',
      wordingVersion: '2026-1',
      recordedById: doctorId,
    })
    .returning();
  const [appt] = await db
    .insert(appointments)
    .values({
      patientId,
      doctorId,
      facilityId: w.facility.id,
      scheduledAt: new Date(Date.now() + 86_400_000),
      reason: 'Follow-up',
    })
    .returning();
  await db.insert(careAssignments).values({ patientId, doctorId }).onConflictDoNothing();
  return { enc: enc!, rx: rx!, mar: mar!, lab: lab!, consent: consent!, appt: appt! };
}

const ownerOf = async (table: string, id: string) =>
  (
    await db.execute<{ patient_id: string }>(
      sql`SELECT patient_id FROM ${sql.identifier(table)} WHERE id = ${id}`,
    )
  ).rows[0]?.patient_id;

describe('duplicate detection', () => {
  it('scores name, swapped name, typos and shared contact details', () => {
    const base = { sex: 'MALE' as const, phone: null, email: null };
    expect(
      scorePair(
        { ...base, firstName: 'Blerim', lastName: 'Gashi' },
        { ...base, firstName: 'blerim', lastName: 'GASHI' },
      ),
    ).toMatchObject({ score: 90 });
    expect(
      scorePair(
        { ...base, firstName: 'Blerim', lastName: 'Gashi' },
        { ...base, firstName: 'Gashi', lastName: 'Blerim' },
      )?.reasons,
    ).toContain('First and last name swapped');
    expect(
      scorePair(
        { ...base, firstName: 'Blerim', lastName: 'Gashi', phone: '+383 44 111 222' },
        { ...base, firstName: 'Blerim', lastName: 'Gashl', phone: '044111222' },
      ),
    ).toMatchObject({ reasons: expect.arrayContaining(['Same phone number']) });
    expect(
      scorePair(
        { ...base, firstName: 'Arta', lastName: 'Krasniqi' },
        { ...base, firstName: 'Driton', lastName: 'Berisha' },
      ),
    ).toBeNull();
    // Diacritics do not hide a duplicate.
    expect(
      scorePair(
        { ...base, firstName: 'Ëndrit', lastName: 'Çeku' },
        { ...base, firstName: 'Endrit', lastName: 'Ceku' },
      )?.score,
    ).toBe(90);
  });

  it('lists likely duplicates at the director’s facility only', async () => {
    const a = await person('Fatmir', 'Hoxha', { phone: '+38344555111' });
    const b = await person('Fatmir', 'Hoxhaa', { phone: '044 555 111' });
    await person('Fatmir', 'Hoxha', { dateOfBirth: '1980-01-01' }); // different DOB
    const res = await merges().get('/candidates');
    expect(res.status).toBe(200);
    const pair = res.body.items.find(
      (c: { a: { id: string }; b: { id: string } }) =>
        [c.a.id, c.b.id].sort().join() === [a.id, b.id].sort().join(),
    );
    expect(pair.reasons).toEqual(
      expect.arrayContaining(['Very similar name and same date of birth', 'Same phone number']),
    );
    const other = await merges(w.tokens.otherDirector).get('/candidates');
    expect(JSON.stringify(other.body)).not.toContain(a.id);
  });

  it('is director-only', async () => {
    for (const token of [w.tokens.doctor, w.tokens.reception, w.tokens.ministry]) {
      expect((await merges(token).get('/candidates')).status).toBe(403);
    }
  });
});

describe('merging', () => {
  it('compares two records with counts, never clinical content', async () => {
    const a = await person('Ilir', 'Shala');
    const b = await person('Ilir', 'Shala');
    await history(b.id);
    const res = await merges().get(`/compare?a=${a.id}&b=${b.id}`);
    expect(res.status).toBe(200);
    expect(res.body.b.counts).toMatchObject({ encounters: 1, lab_results: 1, consent_records: 1 });
    expect(res.body.a.totalRecords).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain('Signed note');
    expect(JSON.stringify(res.body)).not.toContain('Haemoglobin');
    const other = await merges(w.tokens.otherDirector).get(`/compare?a=${a.id}&b=${b.id}`);
    expect(other.status).toBe(403);
  });

  it('moves every part of the duplicate (incl. protected rows) and can be undone exactly', async () => {
    const survivor = await person('Blerim', 'Gashi', { phone: '+38344111222' });
    const dupUser = await createUser('PATIENT');
    const duplicate = await person('Blerim', 'Gashl', {
      phone: null,
      email: 'blerim@example.com',
      userId: dupUser.id,
    });
    const s = await history(survivor.id);
    const d = await history(duplicate.id);
    const guardian = await createUser('PATIENT');
    await db.insert(guardianships).values({
      patientId: duplicate.id,
      guardianUserId: guardian.id,
      relationship: 'PARENT',
      evidence: 'Birth certificate',
      verifiedById: w.users.reception.id,
      validUntil: new Date(Date.now() + 365 * 86_400_000),
    });

    const res = await merges().post('', {
      survivorId: survivor.id,
      mergedId: duplicate.id,
      reason: 'Same person registered twice (typo in surname)',
      fieldChoices: { email: 'merged', phone: 'survivor' },
    });
    expect(res.status).toBe(201);
    expect(res.body.moved).toMatchObject({ encounters: 1, medication_administrations: 1 });
    // The doctor was on both care teams: the duplicate's membership is ended, not duplicated.
    expect(res.body.moved['care_assignments:ended']).toBe(1);

    for (const [table, row] of [
      ['encounters', d.enc],
      ['medication_administrations', d.mar],
      ['consent_records', d.consent],
      ['lab_results', d.lab],
      ['appointments', d.appt],
    ] as const) {
      expect(await ownerOf(table, row.id)).toBe(survivor.id);
    }
    const [after] = await db.select().from(patients).where(eq(patients.id, survivor.id));
    expect(after).toMatchObject({
      email: 'blerim@example.com',
      phone: '+38344111222',
      userId: dupUser.id,
    });
    const [closed] = await db.select().from(patients).where(eq(patients.id, duplicate.id));
    expect(closed!.mergedIntoId).toBe(survivor.id);
    expect(closed!.userId).toBeNull();

    // The duplicate's portal user now sees the combined record.
    const patientToken = await login(dupUser.email);
    const mine = await api()
      .get(`/api/v1/patients/${survivor.id}/encounters`)
      .set(bearer(patientToken));
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((e: { id: string }) => e.id)).toEqual(
      expect.arrayContaining([s.enc.id, d.enc.id]),
    );

    // The closed record: shown for redirection, closed for clinical use, absent from search.
    const shown = await api()
      .get(`/api/v1/patients/${duplicate.id}`)
      .set(bearer(w.tokens.director));
    expect(shown.body.mergedIntoId).toBe(survivor.id);
    const clinical = await api()
      .get(`/api/v1/patients/${duplicate.id}/encounters`)
      .set(bearer(w.tokens.doctor));
    expect(clinical.status).toBe(409);
    expect(clinical.body.error ?? clinical.body).toMatchObject({ code: 'PATIENT_MERGED' });
    const write = await api()
      .post(`/api/v1/patients/${duplicate.id}/diagnoses`)
      .set(bearer(w.tokens.doctor))
      .send({ icd10Code: 'I10', description: 'Hypertension', status: 'CHRONIC' });
    expect(write.status).toBe(409);
    const search = await api()
      .get('/api/v1/patients?scope=facility&search=Gashl')
      .set(bearer(w.tokens.director));
    expect(search.body.items.map((p: { id: string }) => p.id)).not.toContain(duplicate.id);

    // Merging again is refused.
    const again = await merges().post('', {
      survivorId: survivor.id,
      mergedId: duplicate.id,
      reason: 'Trying the same merge twice',
    });
    expect(again.status).toBe(409);

    // A visit recorded after the merge stays with the survivor when the merge is undone.
    const [later] = await db
      .insert(encounters)
      .values({
        patientId: survivor.id,
        doctorId: w.users.doctor.id,
        facilityId: w.facility.id,
        type: 'OUTPATIENT',
        reason: 'After the merge',
      })
      .returning();

    const history_ = await merges().get('');
    const record = history_.body.items.find(
      (m: { survivor: { id: string } }) => m.survivor.id === survivor.id,
    );
    expect(record).toMatchObject({ accountMoved: true, changedFields: ['email'] });
    const undo = await merges().post(`/${record.id}/unmerge`, {
      reason: 'Different people after all – twins',
    });
    expect(undo.status).toBe(200);

    for (const [table, row] of [
      ['encounters', d.enc],
      ['medication_administrations', d.mar],
      ['consent_records', d.consent],
      ['lab_results', d.lab],
      ['appointments', d.appt],
    ] as const) {
      expect(await ownerOf(table, row.id)).toBe(duplicate.id);
    }
    expect(await ownerOf('encounters', s.enc.id)).toBe(survivor.id);
    expect(await ownerOf('encounters', later!.id)).toBe(survivor.id);
    const [s2] = await db.select().from(patients).where(eq(patients.id, survivor.id));
    const [d2] = await db.select().from(patients).where(eq(patients.id, duplicate.id));
    expect(s2).toMatchObject({ email: null, userId: null });
    expect(d2).toMatchObject({ mergedIntoId: null, userId: dupUser.id });
    const active = await db
      .select()
      .from(careAssignments)
      .where(eq(careAssignments.patientId, duplicate.id));
    expect(active.some((c) => c.endedAt === null)).toBe(true);
    const g = await db
      .select()
      .from(guardianships)
      .where(eq(guardianships.patientId, duplicate.id));
    expect(g).toHaveLength(1);

    // Undone pairs are no longer suggested as duplicates.
    const cands = await merges().get('/candidates');
    expect(
      cands.body.items.some(
        (c: { a: { id: string }; b: { id: string } }) =>
          [c.a.id, c.b.id].includes(survivor.id) && [c.a.id, c.b.id].includes(duplicate.id),
      ),
    ).toBe(false);
    expect(
      (await merges().post(`/${record.id}/unmerge`, { reason: 'Undo twice please' })).status,
    ).toBe(409);
  });

  it('refuses when both records have portal accounts, across facilities, or for other roles', async () => {
    const u1 = await createUser('PATIENT');
    const u2 = await createUser('PATIENT');
    const a = await person('Teuta', 'Rama', { userId: u1.id });
    const b = await person('Teuta', 'Rama', { userId: u2.id });
    const both = await merges().post('', {
      survivorId: a.id,
      mergedId: b.id,
      reason: 'Same person registered twice',
    });
    expect(both.status).toBe(409);
    expect(both.body.error?.message ?? both.body.message).toMatch(/portal account/);

    const c = await person('Teuta', 'Rama');
    const outside = await merges(w.tokens.otherDirector).post('', {
      survivorId: a.id,
      mergedId: c.id,
      reason: 'Same person registered twice',
    });
    expect(outside.status).toBe(403);
    const doctor = await merges(w.tokens.doctor).post('', {
      survivorId: a.id,
      mergedId: c.id,
      reason: 'Same person registered twice',
    });
    expect(doctor.status).toBe(403);
    const short = await merges().post('', { survivorId: a.id, mergedId: c.id, reason: 'dup' });
    expect(short.status).toBe(400);
  });

  it('refuses while both records have an active request for the same questionnaire', async () => {
    const a = await person('Blerim', 'Gashi');
    const b = await person('Blerim', 'Gashi');
    const ask = (patientId: string, instrument: string) =>
      db.insert(promAssignments).values({
        patientId,
        facilityId: w.facility.id,
        assignedById: w.users.doctor.id,
        instrument,
        frequency: 'MONTHLY',
      });
    await ask(a.id, 'PHQ9');
    await ask(b.id, 'GAD7');
    // Different questionnaires do not clash (checked via the comparison, not a full merge).
    await ask(b.id, 'PHQ9');
    const res = await merges().post('', {
      survivorId: a.id,
      mergedId: b.id,
      reason: 'Same person registered twice',
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.message ?? res.body.message).toMatch(/questionnaire/);
  });
});

describe('coverage', () => {
  it('moves every table that references a patient (except the audit trail and lineage)', async () => {
    const result = await db.execute<{ table_name: string; column_name: string }>(sql`
      SELECT tc.table_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'patients'
        AND tc.table_schema = 'public'`);
    const references = result.rows
      .map((r) => `${r.table_name}.${r.column_name}`)
      .filter((r) => !EXCLUDED_REFERENCES.includes(r));
    const other = references.filter((r) => !r.endsWith('.patient_id'));
    expect(other.sort()).toEqual([...OTHER_PATIENT_COLUMNS].sort());
    expect(
      references
        .filter((r) => r.endsWith('.patient_id'))
        .map((r) => r.split('.')[0])
        .sort(),
    ).toEqual([...PATIENT_TABLES].sort());
  });
});
