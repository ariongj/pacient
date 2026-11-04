/** Demo data for the blood bank and transfusions (development seed only). Text is in Albanian. */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db } from './client.js';
import {
  admissions,
  bloodGroupTests,
  bloodUnits,
  careUnits,
  surgicalCases,
  transfusionRequests,
  transfusions,
  unitStaff,
  users,
} from './schema.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

const GROUPS = [
  ['O', 'POS'],
  ['O', 'NEG'],
  ['A', 'POS'],
  ['A', 'NEG'],
  ['B', 'POS'],
  ['B', 'NEG'],
  ['AB', 'POS'],
  ['AB', 'NEG'],
] as const;

export async function seedBloodBank({ facilityId }: { facilityId: string }) {
  // The blood bank unit and its staff: the demo nurse and a second doctor of the facility.
  let [unit] = await db
    .select({ id: careUnits.id })
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.type, 'BLOOD_BANK')));
  if (!unit) {
    [unit] = await db
      .insert(careUnits)
      .values({ facilityId, code: 'BG', name: 'Banka e gjakut', type: 'BLOOD_BANK' })
      .returning({ id: careUnits.id });
  }
  const [nurse] = await db.select().from(users).where(eq(users.email, 'nurse@pacient.local'));
  const [demoDoctor] = await db.select().from(users).where(eq(users.email, 'doctor@pacient.local'));
  const [bbDoctor] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.facilityId, facilityId),
        eq(users.role, 'DOCTOR'),
        eq(users.isActive, true),
        ne(users.email, 'doctor@pacient.local'),
      ),
    )
    .limit(1);
  if (!nurse || !bbDoctor || !demoDoctor) return;
  for (const u of [nurse, bbDoctor]) {
    await db.insert(unitStaff).values({ unitId: unit!.id, userId: u.id }).onConflictDoNothing();
  }

  // ~40 units across products and groups; a few expiring soon, one already expired.
  let n = 0;
  const unitNo = () =>
    `KS${new Date().getFullYear() % 100}-${String(40101 + n++).padStart(6, '0')}`;
  const stock: (typeof bloodUnits.$inferInsert)[] = [];
  const add = (
    product: (typeof bloodUnits.$inferInsert)['product'],
    abo: string,
    rhD: string,
    expiresInDays: number,
    volumeMl: number,
  ) =>
    stock.push({
      facilityId,
      unitNumber: unitNo(),
      product,
      abo,
      rhD,
      volumeMl,
      collectedAt: ago(Math.max(2, 35 - expiresInDays) * DAY),
      expiresAt: ahead(expiresInDays * DAY),
      receivedById: nurse.id,
    });
  const redCellCounts: Record<string, number> = {
    'O POS': 6,
    'O NEG': 4,
    'A POS': 6,
    'A NEG': 2,
    'B POS': 3,
    'B NEG': 1,
    'AB POS': 2,
    'AB NEG': 1,
  };
  for (const [abo, rh] of GROUPS) {
    for (let i = 0; i < redCellCounts[`${abo} ${rh}`]!; i++) {
      add('RED_CELLS', abo, rh, i === 0 && abo === 'A' && rh === 'POS' ? 2 : 10 + i * 4, 280);
    }
  }
  for (const [abo, rh] of [
    ['AB', 'POS'],
    ['AB', 'POS'],
    ['A', 'POS'],
    ['O', 'POS'],
    ['B', 'POS'],
  ] as const) {
    add('PLASMA', abo, rh, 300, 250);
  }
  add('PLATELETS', 'O', 'POS', 2, 250);
  add('PLATELETS', 'A', 'POS', 4, 250);
  add('PLATELETS', 'O', 'NEG', 1, 250);
  add('CRYOPRECIPITATE', 'AB', 'POS', 200, 50);
  add('CRYOPRECIPITATE', 'A', 'POS', 200, 50);
  const inserted = await db.insert(bloodUnits).values(stock).returning();
  // One expired unit still on the shelf (to be discarded).
  await db.insert(bloodUnits).values({
    facilityId,
    unitNumber: unitNo(),
    product: 'RED_CELLS',
    abo: 'B',
    rhD: 'POS',
    volumeMl: 280,
    collectedAt: ago(43 * DAY),
    expiresAt: ago(1 * DAY),
    receivedById: nurse.id,
  });
  const take = (abo: string, rhD: string) => {
    let i = inserted.findIndex(
      (u) =>
        u.product === 'RED_CELLS' && u.abo === abo && u.rhD === rhD && u.status === 'AVAILABLE',
    );
    // Group O RhD-negative red cells suit every recipient.
    if (i < 0)
      i = inserted.findIndex((u) => u.product === 'RED_CELLS' && u.abo === 'O' && u.rhD === 'NEG');
    const u = inserted[i]!;
    inserted.splice(i, 1);
    return u;
  };

  // Blood groups for current inpatients; two concordant tests for most.
  const inpatients = await db
    .select({
      patientId: admissions.patientId,
      admissionId: admissions.id,
      attending: admissions.attendingDoctorId,
    })
    .from(admissions)
    .where(and(eq(admissions.facilityId, facilityId), eq(admissions.status, 'ADMITTED')))
    .limit(8);
  const patientGroups = new Map<string, readonly [string, string]>();
  inpatients.forEach((p, i) => {
    patientGroups.set(p.patientId, GROUPS[[2, 0, 4, 2, 1, 0, 6, 3][i % 8]!]!);
  });
  for (const [patientId, [abo, rhD]] of patientGroups) {
    const tests = [...patientGroups.keys()].indexOf(patientId) % 3 === 2 ? 1 : 2;
    for (let t = 0; t < tests; t++) {
      await db.insert(bloodGroupTests).values({
        patientId,
        facilityId,
        abo,
        rhD,
        testedById: nurse.id,
        testedAt: ago((5 - t * 3) * DAY + t * HOUR),
      });
    }
  }

  // An URGENT red cell request for a patient waiting for an operation – crossmatched, 2 reserved.
  const [surgical] = await db
    .select({
      id: surgicalCases.id,
      patientId: surgicalCases.patientId,
      surgeon: surgicalCases.primarySurgeonId,
      admissionId: surgicalCases.admissionId,
    })
    .from(surgicalCases)
    .where(
      and(
        eq(surgicalCases.facilityId, facilityId),
        inArray(surgicalCases.status, ['SCHEDULED', 'REQUESTED']),
      ),
    )
    .limit(1);
  if (surgical) {
    if (!patientGroups.has(surgical.patientId)) {
      for (let t = 0; t < 2; t++) {
        await db.insert(bloodGroupTests).values({
          patientId: surgical.patientId,
          facilityId,
          abo: 'O',
          rhD: 'POS',
          testedById: nurse.id,
          testedAt: ago((2 - t) * DAY),
        });
      }
      patientGroups.set(surgical.patientId, ['O', 'POS']);
    }
    const [abo, rhD] = patientGroups.get(surgical.patientId)!;
    const [req] = await db
      .insert(transfusionRequests)
      .values({
        patientId: surgical.patientId,
        facilityId,
        admissionId: surgical.admissionId,
        surgicalCaseId: surgical.id,
        product: 'RED_CELLS',
        units: 2,
        urgency: 'URGENT',
        indication: 'Rezervë për operacion me humbje të pritshme gjaku > 500 ml',
        haemoglobinGl: 98,
        status: 'CROSSMATCHED',
        requestedById: surgical.surgeon,
        sampleReceivedAt: ago(3 * HOUR),
        crossmatchedById: bbDoctor.id,
        crossmatchedAt: ago(2 * HOUR),
        createdAt: ago(4 * HOUR),
      })
      .returning();
    for (let i = 0; i < 2; i++) {
      const u = take(abo, rhD);
      await db
        .update(bloodUnits)
        .set({ status: 'RESERVED', reservedForRequestId: req!.id })
        .where(eq(bloodUnits.id, u.id));
    }
  }

  // A completed transfusion and one stopped for a mild febrile reaction last week.
  const others = inpatients.filter((p) => p.patientId !== surgical?.patientId);
  const given = async (
    p: (typeof others)[number],
    daysAgo: number,
    reaction: boolean,
  ): Promise<void> => {
    const [abo, rhD] = patientGroups.get(p.patientId) ?? (['O', 'NEG'] as const);
    const start = ago(daysAgo * DAY);
    const [req] = await db
      .insert(transfusionRequests)
      .values({
        patientId: p.patientId,
        facilityId,
        admissionId: p.admissionId,
        product: 'RED_CELLS',
        units: 1,
        urgency: 'ROUTINE',
        indication: 'Anemi simptomatike (Hb 68 g/L), lodhje dhe takikardi',
        haemoglobinGl: 68,
        status: 'COMPLETED',
        requestedById: p.attending,
        sampleReceivedAt: new Date(start.getTime() - 5 * HOUR),
        crossmatchedById: bbDoctor.id,
        crossmatchedAt: new Date(start.getTime() - 3 * HOUR),
        createdAt: new Date(start.getTime() - 6 * HOUR),
      })
      .returning();
    const u = take(abo, rhD);
    await db
      .update(bloodUnits)
      .set({ status: 'TRANSFUSED', reservedForRequestId: req!.id })
      .where(eq(bloodUnits.id, u.id));
    const at = (min: number) => new Date(start.getTime() + min * 60_000).toISOString();
    const observations: Record<string, unknown>[] = [
      {
        phase: 'PRE',
        at: at(-5),
        by: nurse.id,
        systolic: 112,
        diastolic: 68,
        heartRate: 104,
        temperature: 36.7,
      },
      {
        phase: 'T15',
        at: at(15),
        by: nurse.id,
        systolic: 114,
        diastolic: 70,
        heartRate: 100,
        temperature: 36.8,
      },
    ];
    if (reaction) {
      observations.push({
        phase: 'REACTION',
        at: at(45),
        by: nurse.id,
        temperature: 38.3,
        heartRate: 112,
        actionsTaken: 'Transfuzioni u ndal, u njoftua mjeku, u dha paracetamol 1 g',
      });
    } else {
      observations.push({
        phase: 'END',
        at: at(150),
        by: nurse.id,
        volumeGivenMl: 280,
        systolic: 118,
        diastolic: 72,
        heartRate: 88,
        temperature: 36.8,
      });
    }
    await db.insert(transfusions).values({
      requestId: req!.id,
      unitId: u.id,
      patientId: p.patientId,
      issuedById: bbDoctor.id,
      issuedAt: new Date(start.getTime() - 30 * 60_000),
      checkedById: nurse.id,
      secondCheckerId: demoDoctor.id,
      startedAt: start,
      endedAt: new Date(start.getTime() + (reaction ? 45 : 150) * 60_000),
      observations,
      reaction,
      reactionType: reaction ? 'FEBRILE' : null,
      reactionSeverity: reaction ? 'MILD' : null,
      reactionDetails: reaction
        ? 'Temperatura u rrit në 38,3 °C me të dridhura pas 45 minutash; pa ndryshime të tensionit.'
        : null,
      status: reaction ? 'STOPPED' : 'COMPLETED',
    });
  };
  if (others[0]) await given(others[0], 1, false);
  if (others[1]) await given(others[1], 6, true);
}
