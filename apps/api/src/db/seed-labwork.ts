import { and, eq, isNull } from 'drizzle-orm';
import { hashPassword } from '../lib/password.js';
import { AuditAction } from '../modules/audit/audit.service.js';
import { catalogByCode, flagFor } from '../modules/lab/catalog.js';
import { newPlacerOrderNumber } from '../modules/lab/orders.routes.js';
import { db } from './client.js';
import { auditLogs, labOrders, labResults, labSpecimenEvents, patients, users } from './schema.js';

const HOUR = 3_600_000;

/**
 * Synthetic demo data for laboratory work (development only): two laboratory technicians
 * (lab@pacient.local and a colleague), open orders in each state, a rejected specimen, a result
 * waiting for validation and a month of resulted orders for the turnaround statistics.
 */
export async function seedLabwork(opts: { facilityId: string; demoDoctorId: string }) {
  const [existing] = await db.select().from(users).where(eq(users.email, 'lab@pacient.local'));
  if (existing) return;
  const passwordHash = await hashPassword('Pacient-Demo-2026');
  const account = { passwordHash, passwordChangedAt: new Date(), facilityId: opts.facilityId };
  const [lab, lab2] = await db
    .insert(users)
    .values([
      {
        email: 'lab@pacient.local',
        fullName: 'Valbona Morina',
        role: 'LAB_TECHNICIAN' as const,
        ...account,
      },
      {
        email: 'lab2@pacient.local',
        fullName: 'Ardian Hoxha',
        role: 'LAB_TECHNICIAN' as const,
        ...account,
      },
    ])
    .returning();

  const people = await db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.primaryFacilityId, opts.facilityId),
        isNull(patients.mergedIntoId),
        isNull(patients.temporaryIdentity),
      ),
    )
    .limit(24);
  if (people.length < 4) return;
  let n = 0;
  const nextPatient = () => people[n++ % people.length]!.id;

  const newOrder = async (
    testCode: string,
    priority: 'ROUTINE' | 'URGENT' | 'STAT',
    ageHours: number,
    notes: string | null = null,
  ) => {
    const t = catalogByCode(testCode)!;
    const [row] = await db
      .insert(labOrders)
      .values({
        placerOrderNumber: newPlacerOrderNumber(),
        patientId: nextPatient(),
        orderedById: opts.demoDoctorId,
        facilityId: opts.facilityId,
        testCode: t.code,
        testName: t.name,
        specimen: t.specimen,
        priority,
        clinicalNotes: notes,
        createdAt: new Date(Date.now() - ageHours * HOUR),
      })
      .returning();
    return row!;
  };
  const event = (
    orderId: string,
    actorId: string,
    kind: 'COLLECTED' | 'RECEIVED' | 'REJECTED' | 'RESULT_ENTERED' | 'VALIDATED',
    at: Date,
    extra: { reason?: string; specimenBarcode?: string } = {},
  ) =>
    db
      .insert(labSpecimenEvents)
      .values({ orderId, actorId, event: kind, occurredAt: at, ...extra });
  const receive = async (o: typeof labOrders.$inferSelect, at: Date) => {
    await event(o.id, lab!.id, 'COLLECTED', new Date(at.getTime() - 0.5 * HOUR), {
      specimenBarcode: o.placerOrderNumber,
    });
    await event(o.id, lab!.id, 'RECEIVED', at, { specimenBarcode: o.placerOrderNumber });
    await db
      .update(labOrders)
      .set({ status: 'RECEIVED', receivedAt: at })
      .where(eq(labOrders.id, o.id));
  };
  const enter = async (
    o: typeof labOrders.$inferSelect,
    value: string,
    by: string,
    at: Date,
    status: 'PRELIMINARY' | 'FINAL',
  ) => {
    const t = catalogByCode(o.testCode)!;
    const [r] = await db
      .insert(labResults)
      .values({
        patientId: o.patientId,
        orderedById: o.orderedById,
        orderId: o.id,
        testCode: o.testCode,
        testName: o.testName,
        value,
        unit: t.unit,
        referenceRange: t.referenceRange,
        flag: flagFor(t, value),
        status,
        collectedAt: o.receivedAt ?? at,
        source: 'MANUAL',
        createdAt: at,
        ...(status === 'FINAL'
          ? { acknowledgedAt: new Date(at.getTime() + 2 * HOUR), acknowledgedById: o.orderedById }
          : {}),
      })
      .returning();
    return r!;
  };
  const auditAs = (
    actorId: string,
    action: string,
    resourceId: string,
    patientId: string,
    at: Date,
  ) =>
    db.insert(auditLogs).values({
      action,
      actorUserId: actorId,
      actorRole: 'LAB_TECHNICIAN',
      actorFacilityId: opts.facilityId,
      resourceType: 'lab_result',
      resourceId,
      patientId,
      occurredAt: at,
    });

  // Waiting for collection or receipt.
  await newOrder('2823-3', 'STAT', 0.5, 'Dobësi e papritur, në terapi me spironolakton');
  await newOrder('6690-2', 'ROUTINE', 5);
  const collected = await newOrder('718-7', 'URGENT', 2, 'Melena');
  await event(collected.id, lab!.id, 'COLLECTED', new Date(Date.now() - HOUR), {
    specimenBarcode: collected.placerOrderNumber,
  });
  // Received, waiting for a result.
  for (const [code, age] of [
    ['2345-7', 3],
    ['2160-0', 4],
  ] as const) {
    const o = await newOrder(code, 'ROUTINE', age + 1);
    await receive(o, new Date(Date.now() - age * HOUR));
  }
  // A rejected specimen: the order is back to "ordered", the doctor was told.
  const rejected = await newOrder('2951-2', 'ROUTINE', 6);
  await event(rejected.id, lab!.id, 'COLLECTED', new Date(Date.now() - 5 * HOUR), {
    specimenBarcode: rejected.placerOrderNumber,
  });
  await event(rejected.id, lab!.id, 'REJECTED', new Date(Date.now() - 4 * HOUR), {
    reason: 'HAEMOLYSED',
  });
  // A result entered by the colleague, waiting for lab@ to validate (four eyes).
  const pending = await newOrder('718-7', 'URGENT', 3, 'Kontroll pas transfuzionit');
  await receive(pending, new Date(Date.now() - 2 * HOUR));
  const enteredAt = new Date(Date.now() - HOUR);
  const prelim = await enter(pending, '84', lab2!.id, enteredAt, 'PRELIMINARY');
  await auditAs(lab2!.id, AuditAction.LAB_RESULT_ENTERED, prelim.id, pending.patientId, enteredAt);
  await event(pending.id, lab2!.id, 'RESULT_ENTERED', enteredAt);
  await db.update(labOrders).set({ status: 'IN_PROGRESS' }).where(eq(labOrders.id, pending.id));

  // A month of resulted orders (turnaround statistics), entered and validated by two people.
  const codes = ['718-7', '2345-7', '2160-0', '2823-3', '2951-2', '1988-5', '3016-3'];
  const values: Record<string, string[]> = {
    '718-7': ['128', '141', '112', '135'],
    '2345-7': ['5.1', '6.8', '4.7'],
    '2160-0': ['88', '132', '75'],
    '2823-3': ['4.2', '3.3', '4.8'],
    '2951-2': ['139', '141', '133'],
    '1988-5': ['3.1', '24.5', '1.2'],
    '3016-3': ['2.10', '5.60', '1.40'],
  };
  for (let i = 0; i < 28; i++) {
    const code = codes[i % codes.length]!;
    const priority = i % 9 === 0 ? 'STAT' : i % 4 === 0 ? 'URGENT' : 'ROUTINE';
    const daysAgo = 1 + ((i * 7) % 29);
    const created = new Date(Date.now() - daysAgo * 24 * HOUR - 3 * HOUR);
    const o = await newOrder(code, priority, (Date.now() - created.getTime()) / HOUR);
    const receivedAt = new Date(created.getTime() + 0.75 * HOUR);
    await receive(o, receivedAt);
    const minutes =
      priority === 'STAT'
        ? 35 + (i % 4) * 10
        : priority === 'URGENT'
          ? 80 + (i % 5) * 15
          : 150 + (i % 7) * 40;
    const validatedAt = new Date(receivedAt.getTime() + minutes * 60_000);
    const entered = new Date(validatedAt.getTime() - 15 * 60_000);
    const list = values[code]!;
    const value = list[i % list.length]!;
    const [author, validator] = i % 2 ? [lab!, lab2!] : [lab2!, lab!];
    const p = await enter({ ...o, receivedAt }, value, author.id, entered, 'PRELIMINARY');
    const f = await enter({ ...o, receivedAt }, value, validator.id, validatedAt, 'FINAL');
    await db
      .update(labResults)
      .set({ supersededById: f.id, supersededAt: validatedAt })
      .where(eq(labResults.id, p.id));
    await auditAs(author.id, AuditAction.LAB_RESULT_ENTERED, p.id, o.patientId, entered);
    await auditAs(validator.id, AuditAction.LAB_RESULT_VALIDATED, f.id, o.patientId, validatedAt);
    await event(o.id, author.id, 'RESULT_ENTERED', entered);
    await event(o.id, validator.id, 'VALIDATED', validatedAt);
    await db
      .update(labOrders)
      .set({ status: 'RESULTED', resultedAt: validatedAt })
      .where(eq(labOrders.id, o.id));
  }
}
