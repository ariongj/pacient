/**
 * Demo data for pharmacy stock (development seed only): the national medication catalogue,
 * stock at every facility with a pharmacist, and a realistic mix at UCC – one item low, one out,
 * a batch expiring soon and an expired batch – with deliveries and dispensing in the ledger.
 */
import { and, eq, ilike, isNull, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  facilities,
  medicationCatalog,
  prescriptions,
  stockBatches,
  stockMovements,
  stockSettings,
  users,
} from './schema.js';

type Item = [
  name: string,
  atc: string,
  form: string,
  strength: string | null,
  unit: string,
  essential: boolean,
];

/** Names are international non-proprietary names (INN), as the pharmacy safety checks expect. */
const CATALOG: Item[] = [
  ['Amoxicillin', 'J01CA04', 'capsule', '500 mg', 'capsule', true],
  ['Amoxicillin/clavulanic acid', 'J01CR02', 'tablet', '875/125 mg', 'tablet', true],
  ['Azithromycin', 'J01FA10', 'tablet', '500 mg', 'tablet', true],
  ['Ciprofloxacin', 'J01MA02', 'tablet', '500 mg', 'tablet', true],
  ['Nitrofurantoin', 'J01XE01', 'capsule', '100 mg', 'capsule', true],
  ['Ceftriaxone', 'J01DD04', 'powder for injection', '1 g', 'vial', true],
  ['Paracetamol', 'N02BE01', 'tablet', '500 mg', 'tablet', true],
  ['Paracetamol', 'N02BE01', 'solution for infusion', '10 mg/ml', 'bottle 100 ml', true],
  ['Ibuprofen', 'M01AE01', 'tablet', '400 mg', 'tablet', true],
  ['Diclofenac', 'M01AB05', 'tablet', '50 mg', 'tablet', false],
  ['Metamizole', 'N02BB02', 'solution for injection', '500 mg/ml', 'ampoule', false],
  ['Tramadol', 'N02AX02', 'capsule', '50 mg', 'capsule', false],
  ['Metformin', 'A10BA02', 'tablet', '850 mg', 'tablet', true],
  ['Gliclazide', 'A10BB09', 'modified-release tablet', '30 mg', 'tablet', true],
  ['Insulin glargine', 'A10AE04', 'solution for injection (pen)', '100 U/ml', 'pen', true],
  ['Insulin aspart', 'A10AB05', 'solution for injection (pen)', '100 U/ml', 'pen', true],
  ['Amlodipine', 'C08CA01', 'tablet', '5 mg', 'tablet', true],
  ['Ramipril', 'C09AA05', 'tablet', '5 mg', 'tablet', true],
  ['Bisoprolol', 'C07AB07', 'tablet', '5 mg', 'tablet', true],
  ['Furosemide', 'C03CA01', 'tablet', '40 mg', 'tablet', true],
  ['Furosemide', 'C03CA01', 'solution for injection', '10 mg/ml', 'ampoule', true],
  ['Atorvastatin', 'C10AA05', 'tablet', '20 mg', 'tablet', true],
  ['Acetylsalicylic acid', 'B01AC06', 'tablet', '100 mg', 'tablet', true],
  ['Clopidogrel', 'B01AC04', 'tablet', '75 mg', 'tablet', true],
  ['Enoxaparin', 'B01AB05', 'solution for injection (syringe)', '40 mg/0.4 ml', 'syringe', true],
  ['Warfarin', 'B01AA03', 'tablet', '5 mg', 'tablet', true],
  ['Omeprazole', 'A02BC01', 'capsule', '20 mg', 'capsule', true],
  ['Pantoprazole', 'A02BC02', 'powder for injection', '40 mg', 'vial', false],
  ['Metoclopramide', 'A03FA01', 'tablet', '10 mg', 'tablet', false],
  ['Salbutamol', 'R03AC02', 'inhaler', '100 mcg/dose', 'inhaler', true],
  ['Budesonide/formoterol', 'R03AK07', 'inhaler', '160/4.5 mcg', 'inhaler', false],
  ['Prednisolone', 'H02AB06', 'tablet', '5 mg', 'tablet', true],
  ['Dexamethasone', 'H02AB02', 'solution for injection', '4 mg/ml', 'ampoule', true],
  ['Levothyroxine', 'H03AA01', 'tablet', '50 mcg', 'tablet', true],
  ['Ferrous sulfate', 'B03AA07', 'tablet', '325 mg', 'tablet', true],
  ['Folic acid', 'B03BB01', 'tablet', '5 mg', 'tablet', true],
  ['Sodium chloride', 'B05XA03', 'solution for infusion', '0.9 %', 'bag 500 ml', true],
  ['Glucose', 'B05BA03', 'solution for infusion', '5 %', 'bag 500 ml', true],
  ['Oxytocin', 'H01BB02', 'solution for injection', '10 IU/ml', 'ampoule', true],
  ['Lidocaine', 'N01BB02', 'solution for injection', '2 %', 'ampoule', true],
  ['Sertraline', 'N06AB06', 'tablet', '50 mg', 'tablet', false],
  ['Diazepam', 'N05BA01', 'tablet', '5 mg', 'tablet', false],
];

const SUPPLIER = 'Depo Farmaceutike Kosova (demo)';
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

export async function seedStock({ facilityId }: { facilityId: string }) {
  const inserted = await db
    .insert(medicationCatalog)
    .values(
      CATALOG.map(([name, atcCode, form, strength, unit, isEssential]) => ({
        name,
        atcCode,
        form,
        strength,
        unit,
        isEssential,
      })),
    )
    .onConflictDoNothing()
    .returning();
  const catalog = inserted.length ? inserted : await db.select().from(medicationCatalog);
  const find = (name: string, strength?: string) =>
    catalog.find((c) => c.name === name && (!strength || c.strength === strength))!;

  const pharmacists = await db
    .select({ id: users.id, facilityId: users.facilityId })
    .from(users)
    .where(eq(users.role, 'PHARMACIST'));
  const allFacilities = await db
    .select({ id: facilities.id, code: facilities.code })
    .from(facilities);

  /** Receives a batch `daysAgo` days ago and optionally dispenses part of it. */
  async function batch(
    fid: string,
    by: string,
    item: (typeof catalog)[number],
    batchNumber: string,
    expiry: string,
    received: number,
    opts: { daysAgo?: number; dispensed?: number } = {},
  ) {
    const left = received - (opts.dispensed ?? 0);
    const [b] = await db
      .insert(stockBatches)
      .values({
        facilityId: fid,
        itemId: item.id,
        batchNumber,
        expiryDate: expiry,
        quantity: left,
        supplier: SUPPLIER,
        receivedAt: ago(opts.daysAgo ?? 30),
        createdById: by,
      })
      .returning();
    await db.insert(stockMovements).values({
      facilityId: fid,
      itemId: item.id,
      batchId: b!.id,
      type: 'RECEIPT',
      quantity: received,
      reason: `Dërgesë nga ${SUPPLIER}`,
      createdById: by,
      createdAt: ago(opts.daysAgo ?? 30),
    });
    if (opts.dispensed) {
      await db.insert(stockMovements).values({
        facilityId: fid,
        itemId: item.id,
        batchId: b!.id,
        type: 'DISPENSE',
        quantity: -opts.dispensed,
        createdById: by,
        createdAt: ago(Math.max(1, (opts.daysAgo ?? 30) - 5)),
      });
    }
    return b!;
  }
  const reorder = (fid: string, item: (typeof catalog)[number], level: number) =>
    db
      .insert(stockSettings)
      .values({ facilityId: fid, itemId: item.id, reorderLevel: level })
      .onConflictDoNothing();

  const ucc = pharmacists.find((p) => p.facilityId === facilityId)!;

  // ---- UCC: a realistic mix.
  const regular: [string, string | undefined, number, number, number][] = [
    // name, strength, received, dispensed, reorder level
    ['Amoxicillin', '500 mg', 600, 220, 150],
    ['Amoxicillin/clavulanic acid', undefined, 300, 90, 80],
    ['Paracetamol', '500 mg', 2000, 640, 400],
    ['Ibuprofen', '400 mg', 1200, 410, 300],
    ['Metformin', '850 mg', 1800, 700, 500],
    ['Amlodipine', '5 mg', 900, 300, 200],
    ['Atorvastatin', '20 mg', 900, 280, 200],
    ['Omeprazole', '20 mg', 700, 260, 150],
    ['Ramipril', '5 mg', 600, 150, 150],
    ['Bisoprolol', '5 mg', 600, 120, 150],
    ['Furosemide', '40 mg', 400, 90, 100],
    ['Ceftriaxone', '1 g', 200, 70, 50],
    ['Enoxaparin', undefined, 250, 110, 60],
    ['Insulin glargine', undefined, 80, 25, 20],
    ['Levothyroxine', '50 mcg', 500, 120, 100],
    ['Sodium chloride', '0.9 %', 400, 150, 100],
    ['Nitrofurantoin', '100 mg', 300, 80, 60],
    ['Ferrous sulfate', '325 mg', 600, 180, 100],
  ];
  let n = 1;
  for (const [name, strength, received, dispensed, level] of regular) {
    const item = find(name, strength);
    await batch(
      facilityId,
      ucc.id,
      item,
      `UCC-${String(n++).padStart(4, '0')}`,
      day(200 + n * 11),
      received,
      {
        daysAgo: 40,
        dispensed,
      },
    );
    await reorder(facilityId, item, level);
  }
  // Low: salbutamol inhalers below the reorder level.
  const salbutamol = find('Salbutamol');
  await batch(facilityId, ucc.id, salbutamol, 'UCC-SAL-0912', day(320), 60, {
    daysAgo: 50,
    dispensed: 52,
  });
  await reorder(facilityId, salbutamol, 20);
  // Out: prednisolone used up (the batch stays in the ledger with 0 left).
  const prednisolone = find('Prednisolone');
  await batch(facilityId, ucc.id, prednisolone, 'UCC-PRD-0417', day(150), 200, {
    daysAgo: 60,
    dispensed: 200,
  });
  await reorder(facilityId, prednisolone, 50);
  // Expiring soon: a paracetamol infusion batch expiring in 20 days.
  await batch(facilityId, ucc.id, find('Paracetamol', '10 mg/ml'), 'UCC-PCI-2208', day(20), 120, {
    daysAgo: 300,
    dispensed: 70,
  });
  await reorder(facilityId, find('Paracetamol', '10 mg/ml'), 30);
  // Expired: a diclofenac batch past its date, still on the shelf until it is written off.
  await batch(facilityId, ucc.id, find('Diclofenac'), 'UCC-DCF-1103', day(-12), 100, {
    daysAgo: 400,
    dispensed: 64,
  });

  // ---- Other facilities: enough stock for a meaningful national picture.
  const essentials = catalog.filter((c) => c.isEssential);
  for (const f of allFacilities) {
    if (f.id === facilityId) continue;
    const ph = pharmacists.find((p) => p.facilityId === f.id);
    if (!ph) continue;
    let k = 0;
    for (const item of essentials.slice(0, 22)) {
      k++;
      // Every facility runs out of something, and is low on something else.
      const out = (k + f.code.length) % 9 === 0;
      const low = (k + f.code.length) % 7 === 0;
      const received = 300;
      const dispensed = out ? 300 : low ? 280 : 120;
      await batch(
        f.id,
        ph.id,
        item,
        `${f.code}-${String(k).padStart(3, '0')}`,
        day(180 + k * 9),
        received,
        {
          daysAgo: 35,
          dispensed,
        },
      );
      await reorder(f.id, item, 40);
    }
  }

  // Link existing prescriptions written at UCC to the catalogue where the name matches.
  const links: [string, string | undefined][] = [
    ['Amoxicillin', '500 mg'],
    ['Ibuprofen', '400 mg'],
    ['Metformin', '850 mg'],
    ['Atorvastatin', '20 mg'],
    ['Omeprazole', '20 mg'],
    ['Amlodipine', '5 mg'],
    ['Nitrofurantoin', '100 mg'],
    ['Salbutamol', undefined],
  ];
  for (const [name, strength] of links) {
    const item = find(name, strength);
    await db
      .update(prescriptions)
      .set({ catalogItemId: item.id })
      .where(
        and(
          ilike(prescriptions.medication, `${name}%`),
          isNull(prescriptions.catalogItemId),
          sql`${prescriptions.doctorId} IN (SELECT id FROM users WHERE facility_id = ${facilityId})`,
        ),
      );
  }
}
