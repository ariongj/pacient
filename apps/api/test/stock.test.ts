import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import {
  medicationCatalog,
  notifications,
  stockBatches,
  stockMovements,
} from '../src/db/schema.js';
import { allocateFefo, checkExpiries } from '../src/modules/stock/stock.service.js';
import { api, bearer, createWorld } from './helpers.js';

let w: Awaited<ReturnType<typeof createWorld>>;
let amox: string;
let para: string;
let unique = 0;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  w = await createWorld();
  const a = await api().post('/api/v1/stock/catalog').set(bearer(w.tokens.ministry)).send({
    name: 'Amoxicillin',
    atcCode: 'J01CA04',
    form: 'capsule',
    strength: '500 mg',
    unit: 'capsule',
    isEssential: true,
  });
  expect(a.status).toBe(201);
  amox = a.body.id;
  const p = await api().post('/api/v1/stock/catalog').set(bearer(w.tokens.ministry)).send({
    name: 'Paracetamol',
    atcCode: 'N02BE01',
    form: 'tablet',
    strength: '500 mg',
    unit: 'tablet',
    isEssential: true,
  });
  para = p.body.id;
});

const receive = (token: string, items: Record<string, unknown>[]) =>
  api().post('/api/v1/stock/receipts').set(bearer(token)).send({ supplier: 'Test depot', items });

async function verifiedPrescription(medication: string, catalogItemId?: string) {
  const base = `/api/v1/patients/${w.patient.id}`;
  const rx = await api()
    .post(`${base}/prescriptions`)
    .set(bearer(w.tokens.doctor))
    .send({
      medication,
      catalogItemId,
      dosage: '500 mg',
      frequency: 'three times daily',
      startDate: day(0),
      endDate: day(6),
    });
  expect(rx.status).toBe(201);
  const v = await api()
    .post(`/api/v1/pharmacy/prescriptions/${rx.body.id}/verify`)
    .set(bearer(w.tokens.pharmacist))
    .send({ alertsReviewed: true, note: 'Checked, no concerns' });
  expect(v.status).toBe(200);
  return rx.body.id as string;
}

describe('catalogue', () => {
  it('only the Ministry maintains the catalogue; all staff can search it', async () => {
    const denied = await api()
      .post('/api/v1/stock/catalog')
      .set(bearer(w.tokens.pharmacist))
      .send({ name: 'Ibuprofen', form: 'tablet', unit: 'tablet' });
    expect(denied.status).toBe(403);
    const dup = await api()
      .post('/api/v1/stock/catalog')
      .set(bearer(w.tokens.ministry))
      .send({ name: 'amoxicillin', form: 'Capsule', strength: '500 MG', unit: 'capsule' });
    expect(dup.status).toBe(409);
    const search = await api().get('/api/v1/stock/catalog?q=amox').set(bearer(w.tokens.doctor));
    expect(search.body.items.map((i: { id: string }) => i.id)).toContain(amox);
    const byAtc = await api().get('/api/v1/stock/catalog?q=N02').set(bearer(w.tokens.nurse));
    expect(byAtc.body.items.map((i: { id: string }) => i.id)).toContain(para);
    expect((await api().get('/api/v1/stock/catalog').set(bearer(w.tokens.patient))).status).toBe(
      403,
    );
    const patch = await api()
      .patch(`/api/v1/stock/catalog/${para}`)
      .set(bearer(w.tokens.ministry))
      .send({ isEssential: false });
    expect(patch.body.isEssential).toBe(false);
    await api()
      .patch(`/api/v1/stock/catalog/${para}`)
      .set(bearer(w.tokens.ministry))
      .send({ isEssential: true });
  });
});

describe('facility stock', () => {
  it('receives deliveries, adding to an existing batch', async () => {
    const r1 = await receive(w.tokens.pharmacist, [
      { itemId: amox, batchNumber: 'A-LATE', expiryDate: day(300), quantity: 100 },
      { itemId: amox, batchNumber: 'A-SOON', expiryDate: day(60), quantity: 20 },
    ]);
    expect(r1.status).toBe(201);
    const r2 = await receive(w.tokens.pharmacist, [
      { itemId: amox, batchNumber: 'A-SOON', expiryDate: day(60), quantity: 10 },
    ]);
    expect(r2.status).toBe(201);
    const other = await receive(w.tokens.pharmacist, [
      { itemId: amox, batchNumber: 'A-SOON', expiryDate: day(90), quantity: 1 },
    ]);
    expect(other.status).toBe(409); // same batch number, different expiry
    const past = await receive(w.tokens.pharmacist, [
      { itemId: amox, batchNumber: 'OLD', expiryDate: day(-1), quantity: 1 },
    ]);
    expect(past.status).toBe(400);

    const batches = await api()
      .get(`/api/v1/stock/items/${amox}/batches`)
      .set(bearer(w.tokens.pharmacist));
    expect(batches.body.level.onHand).toBe(130);
    expect(batches.body.batches.map((b: { batchNumber: string }) => b.batchNumber)).toEqual([
      'A-SOON',
      'A-LATE',
    ]);
    expect(batches.body.level.flags).toContain('EXPIRING');
    const moves = await api()
      .get(`/api/v1/stock/movements?itemId=${amox}`)
      .set(bearer(w.tokens.pharmacist));
    expect(moves.body.items.filter((m: { type: string }) => m.type === 'RECEIPT')).toHaveLength(3);
  });

  it('directors may look but not change; other facilities see nothing', async () => {
    const levels = await api().get('/api/v1/stock/levels').set(bearer(w.tokens.director));
    expect(levels.status).toBe(200);
    expect(levels.body.canEdit).toBe(false);
    expect(levels.body.items.some((i: { itemId: string }) => i.itemId === amox)).toBe(true);
    expect(
      (
        await receive(w.tokens.director, [
          { itemId: amox, batchNumber: 'X', expiryDate: day(10), quantity: 1 },
        ])
      ).status,
    ).toBe(403);
    const outside = await api().get('/api/v1/stock/levels').set(bearer(w.tokens.outsidePharmacist));
    expect(outside.body.items.some((i: { itemId: string }) => i.itemId === amox)).toBe(false);
    for (const token of [w.tokens.doctor, w.tokens.nurse, w.tokens.reception]) {
      expect((await api().get('/api/v1/stock/levels').set(bearer(token))).status).toBe(403);
    }
  });

  it('adjustments never take a batch below zero and need a reason', async () => {
    const [batch] = await db
      .select()
      .from(stockBatches)
      .where(and(eq(stockBatches.itemId, amox), eq(stockBatches.batchNumber, 'A-SOON')));
    const tooMuch = await api()
      .post('/api/v1/stock/adjustments')
      .set(bearer(w.tokens.pharmacist))
      .send({ batchId: batch!.id, quantity: -31, type: 'DAMAGED', reason: 'Box dropped' });
    expect(tooMuch.status).toBe(409);
    const noReason = await api()
      .post('/api/v1/stock/adjustments')
      .set(bearer(w.tokens.pharmacist))
      .send({ batchId: batch!.id, quantity: -1, type: 'DAMAGED', reason: '' });
    expect(noReason.status).toBe(400);
    const wrongSign = await api()
      .post('/api/v1/stock/adjustments')
      .set(bearer(w.tokens.pharmacist))
      .send({ batchId: batch!.id, quantity: 2, type: 'EXPIRED', reason: 'Wrong direction' });
    expect(wrongSign.status).toBe(400);
    const ok = await api()
      .post('/api/v1/stock/adjustments')
      .set(bearer(w.tokens.pharmacist))
      .send({ batchId: batch!.id, quantity: -2, type: 'DAMAGED', reason: 'Two capsules crushed' });
    expect(ok.status).toBe(201);
    expect(ok.body.quantity).toBe(28);
  });

  it('keeps the movement ledger append-only', async () => {
    const [m] = await db.select().from(stockMovements).limit(1);
    const message = async (q: Promise<unknown>) =>
      q.then(
        () => 'succeeded',
        (e: Error & { cause?: Error }) => e.cause?.message ?? e.message,
      );
    expect(
      await message(db.execute(sql`UPDATE stock_movements SET quantity = 999 WHERE id = ${m!.id}`)),
    ).toMatch(/append-only/);
    expect(await message(db.execute(sql`DELETE FROM stock_movements WHERE id = ${m!.id}`))).toMatch(
      /append-only/,
    );
  });
});

describe('dispensing from stock', () => {
  it('suggests first-expiry-first-out batches', () => {
    const today = day(0);
    const res = allocateFefo(
      [
        { id: 'late', quantity: 50, expiryDate: day(200) },
        { id: 'expired', quantity: 50, expiryDate: day(-3) },
        { id: 'soon', quantity: 5, expiryDate: day(20) },
      ],
      12,
      today,
    );
    expect(res).toEqual({
      lines: [
        { batchId: 'soon', units: 5 },
        { batchId: 'late', units: 7 },
      ],
      shortBy: 0,
    });
    expect(allocateFefo([{ id: 'x', quantity: 3, expiryDate: day(5) }], 5, today).shortBy).toBe(2);
  });

  it('dispensing takes stock FEFO and records the movement', async () => {
    const rxId = await verifiedPrescription('Amoxicillin 500 mg capsules', amox);
    const info = await api()
      .get(`/api/v1/pharmacy/prescriptions/${rxId}/stock`)
      .set(bearer(w.tokens.pharmacist));
    expect(info.body.item.id).toBe(amox);
    expect(info.body.suggestedUnits).toBe(21); // three times daily for 7 days
    expect(info.body.suggestion.lines[0]).toMatchObject({ units: 21 });

    const res = await api()
      .post(`/api/v1/pharmacy/prescriptions/${rxId}/dispense`)
      .set(bearer(w.tokens.pharmacist))
      .send({ stock: { units: 21 } });
    expect(res.status).toBe(200);
    expect(res.body.pharmacyStatus).toBe('DISPENSED');
    expect(res.body.dispensedQuantity).toBe('21 capsule');
    const moves = await db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.prescriptionId, rxId), eq(stockMovements.type, 'DISPENSE')));
    expect(moves.reduce((a, m) => a + m.quantity, 0)).toBe(-21);
    const [soon] = await db
      .select()
      .from(stockBatches)
      .where(and(eq(stockBatches.itemId, amox), eq(stockBatches.batchNumber, 'A-SOON')));
    expect(soon!.quantity).toBe(7); // 28 - 21, taken from the batch that expires first
  });

  it('refuses insufficient stock and expired batches', async () => {
    const rxId = await verifiedPrescription('Amoxicillin 500 mg', amox);
    const tooMuch = await api()
      .post(`/api/v1/pharmacy/prescriptions/${rxId}/dispense`)
      .set(bearer(w.tokens.pharmacist))
      .send({ stock: { units: 10_000 } });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_STOCK');

    const [expired] = await db
      .insert(stockBatches)
      .values({
        facilityId: w.facility.id,
        itemId: amox,
        batchNumber: `EXP-${unique++}`,
        expiryDate: day(-10),
        quantity: 40,
        createdById: w.users.pharmacist.id,
      })
      .returning();
    const fromExpired = await api()
      .post(`/api/v1/pharmacy/prescriptions/${rxId}/dispense`)
      .set(bearer(w.tokens.pharmacist))
      .send({ stock: { units: 5, lines: [{ batchId: expired!.id, units: 5 }] } });
    expect(fromExpired.status).toBe(409);
    expect(fromExpired.body.error.code).toBe('BATCH_EXPIRED');
    const levels = await api()
      .get(`/api/v1/stock/items/${amox}/batches`)
      .set(bearer(w.tokens.pharmacist));
    expect(levels.body.level.flags).toContain('EXPIRED');
    expect(levels.body.level.expiredQuantity).toBe(40);
  });

  it('a prescription without a catalogue link can be linked while dispensing', async () => {
    await receive(w.tokens.pharmacist, [
      { itemId: para, batchNumber: 'P-1', expiryDate: day(400), quantity: 30 },
    ]);
    const rxId = await verifiedPrescription('Paracetamol 500 mg tablets');
    const info = await api()
      .get(`/api/v1/pharmacy/prescriptions/${rxId}/stock`)
      .set(bearer(w.tokens.pharmacist));
    expect(info.body.item).toBeNull();
    expect(info.body.candidates.map((c: { id: string }) => c.id)).toContain(para);
    const res = await api()
      .post(`/api/v1/pharmacy/prescriptions/${rxId}/dispense`)
      .set(bearer(w.tokens.pharmacist))
      .send({ stock: { itemId: para, units: 21 }, quantity: '21 tablets' });
    expect(res.status).toBe(200);
    expect(res.body.catalogItemId).toBe(para);
  });

  it('alerts pharmacists once a day when stock runs low', async () => {
    await api()
      .put(`/api/v1/stock/settings/${para}`)
      .set(bearer(w.tokens.pharmacist))
      .send({ reorderLevel: 10 });
    const low = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.pharmacist.id),
          eq(notifications.link, `/pharmacy/stock?item=${para}`),
        ),
      );
    expect(low).toHaveLength(1); // 9 left ≤ 10
    expect(low[0]!.title).toContain('Paracetamol');
    const [batch] = await db.select().from(stockBatches).where(eq(stockBatches.batchNumber, 'P-1'));
    await api()
      .post('/api/v1/stock/adjustments')
      .set(bearer(w.tokens.pharmacist))
      .send({ batchId: batch!.id, quantity: -1, type: 'DAMAGED', reason: 'Blister torn' });
    const again = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, w.users.pharmacist.id),
          eq(notifications.link, `/pharmacy/stock?item=${para}`),
        ),
      );
    expect(again).toHaveLength(1); // still the same day: no duplicate
  });

  it('warns about batches that expire within 30 days, once per batch per day', async () => {
    const [soon] = await db
      .insert(stockBatches)
      .values({
        facilityId: w.facility.id,
        itemId: para,
        batchNumber: `SOON-${unique++}`,
        expiryDate: day(15),
        quantity: 12,
        createdById: w.users.pharmacist.id,
      })
      .returning();
    const first = await checkExpiries(w.facility.id);
    expect(first.map((b) => b.id)).toContain(soon!.id);
    const second = await checkExpiries(w.facility.id);
    expect(second.map((b) => b.id)).not.toContain(soon!.id);
  });
});

describe('national availability', () => {
  it('shows the Ministry shortages per facility, without patient data', async () => {
    // The other facility stocks paracetamol but has run out.
    const [cat] = await db.select().from(medicationCatalog).where(eq(medicationCatalog.id, para));
    await db.insert(stockBatches).values({
      facilityId: w.otherFacility.id,
      itemId: cat!.id,
      batchNumber: `ZERO-${unique++}`,
      expiryDate: day(100),
      quantity: 0,
      createdById: w.users.outsidePharmacist.id,
    });
    // …and at this facility paracetamol is now below its reorder level.
    await api()
      .put(`/api/v1/stock/settings/${para}`)
      .set(bearer(w.tokens.pharmacist))
      .send({ reorderLevel: 100 });
    const res = await api().get('/api/v1/stock/national').set(bearer(w.tokens.ministry));
    expect(res.status).toBe(200);
    const p = res.body.items.find((i: { itemId: string }) => i.itemId === para);
    expect(p.out).toBeGreaterThanOrEqual(1);
    expect(p.outFacilities).toContain(w.otherFacility.name);
    expect(p.low).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(res.body)).not.toContain(w.patient.lastName);
    expect((await api().get('/api/v1/stock/national').set(bearer(w.tokens.director))).status).toBe(
      403,
    );
    const csv = await api().get('/api/v1/stock/national?format=csv').set(bearer(w.tokens.ministry));
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Paracetamol');
  });
});
