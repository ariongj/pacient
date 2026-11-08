import { and, eq, like } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  auditLogs,
  careUnits,
  equipmentEvents,
  equipmentItems,
  notifications,
  safetyIncidents,
} from '../src/db/schema.js';
import {
  maintenanceState,
  runEquipmentWorkerOnce,
  statusAfterEvent,
  todayIso,
  validateCsv,
} from '../src/modules/equipment/equipment.service.js';
import { api, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let icuId: string;
const director = () => bearer(w.tokens.director);
const DAY = 86_400_000;
const isoDaysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const uniq = () => Math.random().toString(36).slice(2, 7).toUpperCase();

async function addItem(body: Record<string, unknown> = {}) {
  return api()
    .post('/api/v1/equipment/items')
    .set(director())
    .send({
      assetTag: `VEN-${uniq()}`,
      category: 'VENTILATOR',
      name: 'Ventilator mekanik',
      criticality: 'HIGH',
      serviceIntervalDays: 180,
      unitId: icuId,
      ...body,
    });
}

beforeAll(async () => {
  w = await createWorld();
  const [icu] = await db
    .insert(careUnits)
    .values({
      facilityId: w.facility.id,
      name: 'Kujdesi intensiv',
      code: `ICU${uniq()}`,
      type: 'ICU',
    })
    .returning();
  icuId = icu!.id;
});

describe('rules', () => {
  it('computes the maintenance state and the status after an event', () => {
    const today = '2026-06-15';
    expect(maintenanceState({ nextServiceDue: '2026-06-14', status: 'IN_SERVICE' }, today)).toBe(
      'OVERDUE',
    );
    expect(maintenanceState({ nextServiceDue: '2026-07-15', status: 'IN_SERVICE' }, today)).toBe(
      'DUE_SOON',
    );
    expect(maintenanceState({ nextServiceDue: '2026-07-16', status: 'IN_SERVICE' }, today)).toBe(
      'OK',
    );
    expect(maintenanceState({ nextServiceDue: '2026-01-01', status: 'RETIRED' }, today)).toBe(
      'NONE',
    );
    expect(maintenanceState({ nextServiceDue: null, status: 'IN_SERVICE' }, today)).toBe('NONE');
    const high = { criticality: 'HIGH', status: 'IN_SERVICE' };
    const low = { criticality: 'LOW', status: 'IN_SERVICE' };
    expect(statusAfterEvent('FAULT', high, 'IN_SERVICE')).toBe('OUT_OF_SERVICE');
    expect(statusAfterEvent('FAULT', low, undefined)).toBeNull();
    expect(statusAfterEvent('FAULT', low, 'OUT_OF_SERVICE')).toBe('OUT_OF_SERVICE');
    expect(statusAfterEvent('SERVICE', high, undefined)).toBe('IN_SERVICE');
    expect(statusAfterEvent('REPAIR', high, undefined)).toBe('IN_SERVICE');
  });

  it('validates CSV rows and reports errors per line', () => {
    const { rows, errors } = validateCsv(
      [
        'assetTag,category,name,criticality,serviceIntervalDays,lastServiceAt',
        'mon-1,MONITOR,Monitor,MEDIUM,365,2026-01-01',
        'MON-1,MONITOR,Monitor,MEDIUM,365,2026-01-01',
        'X,TOASTER,?,EXTREME,0,2026-13-40',
      ].join('\n'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assetTag: 'MON-1',
      category: 'MONITOR',
      serviceIntervalDays: 365,
    });
    expect(errors.map((e) => e.line)).toEqual([3, 4]);
    expect(errors[0]!.message).toMatch(/repeated/);
    expect(errors[1]!.message).toMatch(/category/);
    expect(validateCsv('name,category\nx,y').errors[0]!.message).toMatch(/Missing columns/);
  });
});

describe('register', () => {
  it('lets the director add equipment with unique tags per facility and computes the next service', async () => {
    const tag = `VEN-${uniq()}`;
    const res = await addItem({ assetTag: tag.toLowerCase(), lastServiceAt: isoDaysAgo(10) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ assetTag: tag, status: 'IN_SERVICE', maintenance: 'OK' });
    const due = new Date(Date.now() - 10 * DAY + 180 * DAY).toISOString().slice(0, 10);
    expect(res.body.nextServiceDue).toBe(due);
    expect((await addItem({ assetTag: tag })).status).toBe(409);
    // The same tag at another facility is fine.
    const other = await api()
      .post('/api/v1/equipment/items')
      .set(bearer(w.tokens.otherDirector))
      .send({ assetTag: tag, category: 'VENTILATOR', name: 'Ventilator', criticality: 'HIGH' });
    expect(other.status).toBe(201);

    expect((await addItem({ assetTag: '!!' })).status).toBe(400);
    expect((await addItem({ category: 'TOASTER' })).status).toBe(400);
    expect((await addItem({ lastServiceAt: '2999-01-01' })).status).toBe(400);
    // A ward of another facility is refused.
    const [foreign] = await db
      .insert(careUnits)
      .values({ facilityId: w.otherFacility.id, name: 'ICU', code: `X${uniq()}`, type: 'ICU' })
      .returning();
    expect((await addItem({ unitId: foreign!.id })).status).toBe(400);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'equipment.changed'), eq(auditLogs.resourceId, res.body.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.patientId).toBeNull();
  });

  it('allows only the director to manage, staff to view, and hides other facilities', async () => {
    const res = await addItem();
    const id = res.body.id as string;
    for (const token of [w.tokens.doctor, w.tokens.nurse, w.tokens.pharmacist]) {
      expect((await api().post('/api/v1/equipment/items').set(bearer(token)).send({})).status).toBe(
        403,
      );
      expect(
        (await api().patch(`/api/v1/equipment/items/${id}`).set(bearer(token)).send({ name: 'X' }))
          .status,
      ).toBe(403);
      expect((await api().get(`/api/v1/equipment/items/${id}`).set(bearer(token))).status).toBe(
        200,
      );
    }
    for (const token of [w.tokens.reception, w.tokens.patient, w.tokens.ministry]) {
      expect((await api().get('/api/v1/equipment/items').set(bearer(token))).status).toBe(403);
    }
    expect(
      (await api().get(`/api/v1/equipment/items/${id}`).set(bearer(w.tokens.outsideDoctor))).status,
    ).toBe(404);
    expect(
      (
        await api()
          .post(`/api/v1/equipment/items/${id}/events`)
          .set(bearer(w.tokens.outsideDoctor))
          .send({ kind: 'FAULT', description: 'Alarmi nuk bie' })
      ).status,
    ).toBe(404);
    const list = await api()
      .get(`/api/v1/equipment/items?tag=${res.body.assetTag}`)
      .set(bearer(w.tokens.nurse));
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([id]);
  });

  it('edits, recomputes the schedule and retires', async () => {
    const res = await addItem({ lastServiceAt: isoDaysAgo(100) });
    const id = res.body.id as string;
    const edited = await api()
      .patch(`/api/v1/equipment/items/${id}`)
      .set(director())
      .send({ serviceIntervalDays: 90 });
    expect(edited.status).toBe(200);
    expect(edited.body.maintenance).toBe('OVERDUE');
    const retired = await api()
      .post(`/api/v1/equipment/items/${id}/retire`)
      .set(director())
      .send({ reason: 'Zëvendësuar me model të ri' });
    expect(retired.body).toMatchObject({ status: 'RETIRED', nextServiceDue: null });
    expect(
      (
        await api()
          .post(`/api/v1/equipment/items/${id}/events`)
          .set(director())
          .send({ kind: 'SERVICE', description: 'Servis vjetor' })
      ).status,
    ).toBe(409);
    const list = await api().get('/api/v1/equipment/items?pageSize=100').set(director());
    expect(list.body.items.some((i: { id: string }) => i.id === id)).toBe(false);
  });

  it('imports CSV with a dry run first and never applies a file with errors', async () => {
    const [unit] = await db.select().from(careUnits).where(eq(careUnits.id, icuId));
    const tag = `PMP-${uniq()}`;
    const csv = [
      'assetTag,category,name,unitCode,criticality,serviceIntervalDays,lastServiceAt',
      `${tag},INFUSION_PUMP,Pompë infuzioni,${unit!.code},MEDIUM,365,${isoDaysAgo(30)}`,
    ].join('\n');
    const dry = await api().post('/api/v1/equipment/import').set(director()).send({ csv });
    expect(dry.body).toMatchObject({ dryRun: true, applied: false, toCreate: 1, errors: [] });
    expect(
      await db.select().from(equipmentItems).where(eq(equipmentItems.assetTag, tag)),
    ).toHaveLength(0);
    const bad = await api()
      .post('/api/v1/equipment/import')
      .set(director())
      .send({ csv: `${csv}\nBAD-1,MONITOR,Monitor,NOPE,MEDIUM,,`, dryRun: false });
    expect(bad.body.applied).toBe(false);
    expect(bad.body.errors[0].message).toMatch(/unknown unit code/);
    const applied = await api()
      .post('/api/v1/equipment/import')
      .set(director())
      .send({ csv, dryRun: false });
    expect(applied.body).toMatchObject({ applied: true, toCreate: 1 });
    const [row] = await db.select().from(equipmentItems).where(eq(equipmentItems.assetTag, tag));
    expect(row).toMatchObject({ unitId: icuId, status: 'IN_SERVICE' });
    // Re-import updates instead of duplicating.
    const again = await api()
      .post('/api/v1/equipment/import')
      .set(director())
      .send({ csv, dryRun: true });
    expect(again.body).toMatchObject({ toCreate: 0, toUpdate: 1 });
    expect(
      (await api().post('/api/v1/equipment/import').set(bearer(w.tokens.nurse)).send({ csv }))
        .status,
    ).toBe(403);
  });
});

describe('events', () => {
  it('records a service that sets the next due date and keeps the history append-only', async () => {
    const res = await addItem({ lastServiceAt: isoDaysAgo(200) });
    const id = res.body.id as string;
    expect(res.body.maintenance).toBe('OVERDUE');
    const service = await api()
      .post(`/api/v1/equipment/items/${id}/events`)
      .set(director())
      .send({ kind: 'SERVICE', description: 'Servis i planifikuar dhe kalibrim' });
    expect(service.status).toBe(201);
    expect(service.body.item).toMatchObject({ lastServiceAt: todayIso(), maintenance: 'OK' });
    // Ward staff cannot record services.
    expect(
      (
        await api()
          .post(`/api/v1/equipment/items/${id}/events`)
          .set(bearer(w.tokens.nurse))
          .send({ kind: 'SERVICE', description: 'Servis i planifikuar' })
      ).status,
    ).toBe(403);
    await expect(
      db
        .update(equipmentEvents)
        .set({ description: 'changed' })
        .where(eq(equipmentEvents.id, service.body.event.id)),
    ).rejects.toThrow();
    await expect(
      db.delete(equipmentEvents).where(eq(equipmentEvents.id, service.body.event.id)),
    ).rejects.toThrow();
  });

  it('takes life-support equipment out of service on a fault and links a safety incident', async () => {
    const res = await addItem();
    const id = res.body.id as string;
    const [incident] = await db
      .insert(safetyIncidents)
      .values({
        reference: `INC-2026-${uniq()}`,
        facilityId: w.facility.id,
        reportedById: w.users.nurse.id,
        reporterRole: 'NURSE',
        occurredAt: new Date(Date.now() - 3_600_000),
        category: 'EQUIPMENT',
        harm: 'NEAR_MISS',
        description: 'Ventilatori ndaloi për pak sekonda',
      })
      .returning();
    const fault = await api()
      .post(`/api/v1/equipment/items/${id}/events`)
      .set(bearer(w.tokens.nurse))
      .send({
        kind: 'FAULT',
        description: 'Ventilatori ndaloi gjatë përdorimit',
        status: 'IN_SERVICE',
        incidentReference: incident!.reference.toLowerCase(),
      });
    expect(fault.status).toBe(201);
    expect(fault.body.item.status).toBe('OUT_OF_SERVICE');
    expect(fault.body.event).toMatchObject({ incidentId: incident!.id, status: 'OUT_OF_SERVICE' });
    const detail = await api().get(`/api/v1/equipment/items/${id}`).set(bearer(w.tokens.doctor));
    expect(detail.body.events[0]).toMatchObject({
      kind: 'FAULT',
      incidentReference: incident!.reference,
    });
    // An unknown reference, or one of another facility, is refused.
    expect(
      (
        await api()
          .post(`/api/v1/equipment/items/${id}/events`)
          .set(bearer(w.tokens.nurse))
          .send({
            kind: 'FAULT',
            description: 'Alarmi nuk bie',
            incidentReference: 'INC-1999-00001',
          })
      ).status,
    ).toBe(400);
    // Repair puts it back in service.
    const repair = await api()
      .post(`/api/v1/equipment/items/${id}/events`)
      .set(director())
      .send({ kind: 'REPAIR', description: 'U zëvendësua sensori i rrjedhës' });
    expect(repair.body.item.status).toBe('IN_SERVICE');
  });

  it('lets the reporter choose for lower-criticality equipment and requires a status for status changes', async () => {
    const res = await addItem({ category: 'INFUSION_PUMP', criticality: 'MEDIUM', name: 'Pompë' });
    const id = res.body.id as string;
    const usable = await api()
      .post(`/api/v1/equipment/items/${id}/events`)
      .set(bearer(w.tokens.doctor))
      .send({ kind: 'FAULT', description: 'Ekrani dridhet pak' });
    expect(usable.body.item.status).toBe('IN_SERVICE');
    const out = await api()
      .post(`/api/v1/equipment/items/${id}/events`)
      .set(bearer(w.tokens.doctor))
      .send({
        kind: 'FAULT',
        description: 'Alarmi i okluzionit nuk bie',
        status: 'OUT_OF_SERVICE',
      });
    expect(out.body.item.status).toBe('OUT_OF_SERVICE');
    expect(
      (
        await api()
          .post(`/api/v1/equipment/items/${id}/events`)
          .set(director())
          .send({ kind: 'STATUS', description: 'Dërguar për riparim' })
      ).status,
    ).toBe(400);
    const status = await api()
      .post(`/api/v1/equipment/items/${id}/events`)
      .set(director())
      .send({ kind: 'STATUS', description: 'Dërguar për riparim', status: 'IN_MAINTENANCE' });
    expect(status.body.item.status).toBe('IN_MAINTENANCE');
  });
});

describe('maintenance, availability and national view', () => {
  it('lists overdue, due-soon and out-of-service equipment and per-ward availability', async () => {
    const overdue = await addItem({ lastServiceAt: isoDaysAgo(190) });
    const soon = await addItem({ lastServiceAt: isoDaysAgo(170) });
    const res = await api().get('/api/v1/equipment/maintenance').set(bearer(w.tokens.nurse));
    expect(res.status).toBe(200);
    expect(res.body.overdue.map((i: { id: string }) => i.id)).toContain(overdue.body.id);
    expect(res.body.dueSoon.map((i: { id: string }) => i.id)).toContain(soon.body.id);
    const avail = await api().get('/api/v1/equipment/availability').set(bearer(w.tokens.doctor));
    const icu = avail.body.units.find((u: { unitId: string }) => u.unitId === icuId);
    expect(icu.categories.VENTILATOR.total).toBeGreaterThan(0);
    expect(icu.categories.VENTILATOR.inService).toBeLessThanOrEqual(
      icu.categories.VENTILATOR.total,
    );
    expect(avail.body.totals.overdue).toBeGreaterThan(0);
    expect(
      (await api().get('/api/v1/equipment/maintenance').set(bearer(w.tokens.ministry))).status,
    ).toBe(403);
  });

  it('gives the Ministry national aggregates only', async () => {
    const res = await api().get('/api/v1/equipment/national').set(bearer(w.tokens.ministry));
    expect(res.status).toBe(200);
    const mine = res.body.byFacility.find(
      (f: { facilityId: string }) => f.facilityId === w.facility.id,
    );
    expect(mine.categories.VENTILATOR.total).toBeGreaterThan(0);
    expect(mine.assetTag).toBeUndefined();
    expect(res.body.faultsByMonth.length).toBeGreaterThan(0);
    expect(typeof res.body.overduePct).toBe('number');
    expect((await api().get('/api/v1/equipment/national').set(director())).status).toBe(403);
  });
});

describe('worker', () => {
  it('tells the director once about overdue equipment and long outages of life-support equipment', async () => {
    const overdue = await addItem({ lastServiceAt: isoDaysAgo(200) });
    const down = await addItem();
    await db.insert(equipmentEvents).values({
      itemId: down.body.id,
      kind: 'FAULT',
      occurredAt: new Date(Date.now() - 30 * 3_600_000),
      description: 'Dështoi vetëtestimi',
      status: 'OUT_OF_SERVICE',
      recordedById: w.users.nurse.id,
    });
    await db
      .update(equipmentItems)
      .set({ status: 'OUT_OF_SERVICE' })
      .where(eq(equipmentItems.id, down.body.id));
    await runEquipmentWorkerOnce();
    await runEquipmentWorkerOnce();
    const mine = (id: string) =>
      db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, w.users.director.id),
            eq(notifications.type, 'equipment'),
            like(notifications.link, `%${id}%`),
          ),
        );
    expect(await mine(overdue.body.id)).toHaveLength(1);
    const outage = await mine(down.body.id);
    expect(outage).toHaveLength(1);
    expect(outage[0]!.title).toMatch(/24/);
    // Other facilities' directors hear nothing about it.
    const others = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.otherDirector.id),
          like(notifications.link, `%${overdue.body.id}%`),
        ),
      );
    expect(others).toHaveLength(0);
  });
});
