import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { diagnoses } from '../src/db/schema.js';
import { SMALL_CELL_THRESHOLD } from '../src/modules/stats/stats.service.js';
import { api, bearer, createPatient, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
  // One rare condition (below threshold) and one common one (at threshold) in this facility.
  await db.insert(diagnoses).values({
    patientId: w.patient.id,
    doctorId: w.users.doctor.id,
    icd10Code: 'Q99.9',
    description: 'Rare chromosomal abnormality',
  });
  for (let i = 0; i < SMALL_CELL_THRESHOLD; i++) {
    const p = await createPatient(w.facility.id);
    await db.insert(diagnoses).values({
      patientId: p.id,
      doctorId: w.users.doctor.id,
      icd10Code: 'Z00.0',
      description: 'General examination',
    });
  }
});

describe('director dashboard', () => {
  it('is scoped to the director’s own facility and suppresses small cells', async () => {
    const res = await api()
      .get(`/api/v1/stats/facility?facilityId=${w.otherFacility.id}`)
      .set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    expect(res.body.totals.activeDoctors).toBe(2); // own facility, despite the query parameter
    expect(res.body.encountersByMonth).toHaveLength(12);
    expect(res.body.exceptions).toHaveProperty('resultsUnacknowledgedOver48h');

    const rare = res.body.topDiagnoses.find((d: { icd10Code: string }) => d.icd10Code === 'Q99.9');
    expect(rare).toMatchObject({ count: null, suppressed: true });
    const common = res.body.topDiagnoses.find(
      (d: { icd10Code: string }) => d.icd10Code === 'Z00.0',
    );
    expect(common).toMatchObject({ count: SMALL_CELL_THRESHOLD, suppressed: false });
  });

  it('is not available to doctors or patients', async () => {
    expect((await api().get('/api/v1/stats/facility').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
    expect((await api().get('/api/v1/stats/facility').set(bearer(w.tokens.patient))).status).toBe(
      403,
    );
  });
});

describe('ministry dashboard', () => {
  it('returns national aggregates only', async () => {
    const res = await api().get('/api/v1/stats/national').set(bearer(w.tokens.ministry));
    expect(res.status).toBe(200);
    expect(res.body.totals.facilities).toBeGreaterThanOrEqual(2);
    expect(res.body.byFacility[0]).toHaveProperty('patients');
    expect(JSON.stringify(res.body)).not.toContain(w.patient.nationalId);
    expect(JSON.stringify(res.body)).not.toContain(w.patient.lastName);
  });

  it('is restricted to the ministry', async () => {
    expect((await api().get('/api/v1/stats/national').set(bearer(w.tokens.director))).status).toBe(
      403,
    );
  });
});

describe('audit trail', () => {
  it('directors only see audit events from their own facility', async () => {
    const res = await api().get('/api/v1/audit-logs').set(bearer(w.tokens.director));
    expect(res.status).toBe(200);
    expect(
      res.body.items.every((e: { actorFacilityId: string }) => e.actorFacilityId === w.facility.id),
    ).toBe(true);
    expect((await api().get('/api/v1/audit-logs').set(bearer(w.tokens.doctor))).status).toBe(403);
  });

  it('is append-only at the database level', async () => {
    const cause = (p: Promise<unknown>) =>
      p.then(
        () => 'succeeded',
        (e: { cause?: { message?: string } }) => e.cause?.message ?? '',
      );
    expect(await cause(db.execute(sql`UPDATE audit_logs SET action = 'tampered'`))).toMatch(
      /append-only/,
    );
    expect(await cause(db.execute(sql`DELETE FROM audit_logs`))).toMatch(/append-only/);
  });
});

describe('platform', () => {
  it('exposes health checks and hides framework fingerprints', async () => {
    const live = await api().get('/health/live');
    expect(live.status).toBe(200);
    expect(live.headers['x-powered-by']).toBeUndefined();
    expect((await api().get('/health/ready')).status).toBe(200);
  });

  it('returns structured errors for unknown routes and malformed JSON', async () => {
    const missing = await api().get('/api/v1/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
    const bad = await api()
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');
    expect(bad.status).toBe(400);
  });
});
