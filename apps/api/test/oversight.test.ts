import { beforeAll, describe, expect, it } from 'vitest';
import { toCsv } from '../src/modules/reports/reports.routes.js';
import { api, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
beforeAll(async () => {
  w = await createWorld();
});

describe('emergency access review', () => {
  it('directors review every break-glass event of their facility', async () => {
    await api()
      .post(`/api/v1/patients/${w.patient.id}/emergency-access`)
      .set(bearer(w.tokens.colleague))
      .send({ reason: 'Collapsed in waiting room, care team doctor unavailable' })
      .expect(201);
    await api()
      .get(`/api/v1/patients/${w.patient.id}/summary`)
      .set(bearer(w.tokens.colleague))
      .expect(200);

    const n = await api().get('/api/v1/notifications').set(bearer(w.tokens.director));
    expect(n.body.items.some((i: { type: string }) => i.type === 'emergency_access')).toBe(true);

    const queue = await api().get('/api/v1/emergency-access').set(bearer(w.tokens.director));
    expect(queue.status).toBe(200);
    const event = queue.body.items[0];
    expect(event).toMatchObject({ doctorId: w.users.colleague.id, reviewedAt: null });
    expect(event.recordViews).toBeGreaterThanOrEqual(1);

    // Other facilities' directors cannot see or review it.
    const other = await api().get('/api/v1/emergency-access').set(bearer(w.tokens.otherDirector));
    expect(other.body.items.map((e: { id: string }) => e.id)).not.toContain(event.id);
    expect(
      (
        await api()
          .post(`/api/v1/emergency-access/${event.id}/review`)
          .set(bearer(w.tokens.otherDirector))
          .send({ outcome: 'APPROPRIATE', notes: 'Looks fine' })
      ).status,
    ).toBe(404);

    const review = await api()
      .post(`/api/v1/emergency-access/${event.id}/review`)
      .set(bearer(w.tokens.director))
      .send({ outcome: 'APPROPRIATE', notes: 'Confirmed with ward staff: genuine emergency.' });
    expect(review.status).toBe(204);
    const again = await api()
      .post(`/api/v1/emergency-access/${event.id}/review`)
      .set(bearer(w.tokens.director))
      .send({ outcome: 'INAPPROPRIATE', notes: 'Changing my mind' });
    expect(again.status).toBe(409);

    const summary = await api()
      .get('/api/v1/emergency-access/summary')
      .set(bearer(w.tokens.ministry));
    expect(summary.status).toBe(200);
    const row = summary.body.items.find(
      (r: { facilityId: string }) => r.facilityId === w.facility.id,
    );
    expect(row).toMatchObject({ total: 1, unreviewed: 0 });
    expect(JSON.stringify(summary.body)).not.toContain(w.patient.id);
    expect(
      (await api().get('/api/v1/emergency-access').set(bearer(w.tokens.ministry))).status,
    ).toBe(403);
  });
});

describe('announcements', () => {
  it('reach the right audience and facility', async () => {
    const national = await api()
      .post('/api/v1/announcements')
      .set(bearer(w.tokens.ministry))
      .send({
        title: 'Flu vaccination campaign',
        body: 'Free flu vaccines at all centres.',
        audience: 'EVERYONE',
      });
    expect(national.status).toBe(201);
    expect(national.body).toMatchObject({ scope: 'NATIONAL', facilityId: null });

    const staffOnly = await api()
      .post('/api/v1/announcements')
      .set(bearer(w.tokens.director))
      .send({ title: 'Staff meeting', body: 'Monday 08:00 in the main hall.', audience: 'STAFF' });
    expect(staffOnly.body).toMatchObject({ scope: 'FACILITY', facilityId: w.facility.id });

    const titles = async (token: string) =>
      (await api().get('/api/v1/announcements').set(bearer(token))).body.items.map(
        (a: { title: string }) => a.title,
      );

    expect(await titles(w.tokens.patient)).toContain('Flu vaccination campaign');
    expect(await titles(w.tokens.patient)).not.toContain('Staff meeting');
    expect(await titles(w.tokens.doctor)).toEqual(
      expect.arrayContaining(['Flu vaccination campaign', 'Staff meeting']),
    );
    expect(await titles(w.tokens.outsideDoctor)).not.toContain('Staff meeting');

    expect(
      (
        await api()
          .post('/api/v1/announcements')
          .set(bearer(w.tokens.doctor))
          .send({ title: 'Hi', body: 'x' })
      ).status,
    ).toBe(403);
    // Directors cannot withdraw national announcements.
    expect(
      (
        await api()
          .post(`/api/v1/announcements/${national.body.id}/withdraw`)
          .set(bearer(w.tokens.director))
      ).status,
    ).toBe(404);
    await api()
      .post(`/api/v1/announcements/${staffOnly.body.id}/withdraw`)
      .set(bearer(w.tokens.director))
      .expect(204);
    expect(await titles(w.tokens.doctor)).not.toContain('Staff meeting');
  });
});

describe('reports', () => {
  it('directors are limited to their facility', async () => {
    const own = await api().get('/api/v1/reports/activity').set(bearer(w.tokens.director));
    expect(own.status).toBe(200);
    expect(own.body.rows).toHaveLength(1);
    expect(
      (await api().get('/api/v1/reports/activity?region=Prizren').set(bearer(w.tokens.director)))
        .status,
    ).toBe(400);
    expect((await api().get('/api/v1/reports/activity').set(bearer(w.tokens.doctor))).status).toBe(
      403,
    );
  });

  it('the ministry can filter and export, with suppression and an audit record', async () => {
    const report = await api()
      .get(`/api/v1/reports/diagnoses?from=2025-01-01&to=2026-12-31&facilityId=${w.facility.id}`)
      .set(bearer(w.tokens.ministry));
    expect(report.status).toBe(200);
    expect(
      report.body.rows.every((r: { patients: number | null; suppressed: boolean }) =>
        r.suppressed ? r.patients === null : r.patients! >= 5,
      ),
    ).toBe(true);

    const csv = await api().get('/api/v1/reports/activity/export').set(bearer(w.tokens.ministry));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toMatch(/^code,name,region,encounters/);

    const audit = await api()
      .get('/api/v1/audit-logs?action=report.exported')
      .set(bearer(w.tokens.ministry));
    expect(audit.body.items[0].metadata).toMatchObject({ report: 'activity' });

    const bad = await api()
      .get('/api/v1/reports/activity?from=2020-01-01&to=2026-01-01')
      .set(bearer(w.tokens.ministry));
    expect(bad.status).toBe(400);
  });

  it('neutralises spreadsheet formulas in CSV exports', () => {
    const out = toCsv(['a', 'b'], [{ a: '=HYPERLINK("x")', b: 'plain, text' }]);
    expect(out).toContain(`"'=HYPERLINK(""x"")"`);
    expect(out).toContain('"plain, text"');
  });
});
