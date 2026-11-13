import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  ambulanceUnits,
  careUnits,
  emsCareRecords,
  emsIncidents,
  patients,
  unitStaff,
  users,
} from './schema.js';
import { nextReference } from '../modules/ems/ems.service.js';

/**
 * Synthetic ambulance service at the demo facility (development only): a pre-hospital emergency
 * unit with doctor@ and nurse@ on its staff, four vehicles, three months of closed calls for the
 * statistics and three open calls – one P1 on its way to the demo emergency department (it shows
 * as a pre-alert on the ED board), one crew on scene and one call waiting for dispatch.
 */

const MIN = 60_000;
const DAY = 86_400_000;

const MUNICIPALITIES = [
  'Prishtinë',
  'Prishtinë',
  'Prishtinë',
  'Fushë Kosovë',
  'Obiliq',
  'Podujevë',
  'Lipjan',
  'Graçanicë',
];
const STREETS = [
  'Rr. Agim Ramadani',
  'Rr. Nëna Terezë',
  'Rr. Lidhja e Prizrenit',
  'Rr. Fehmi Agani',
  'Rr. UÇK',
  'Rr. Rexhep Luci',
  'Rr. Garibaldi',
  'Lagjja Dardania',
];
const COMPLAINTS: [string, 'P1' | 'P2' | 'P3'][] = [
  ['Dhimbje gjoksi', 'P1'],
  ['Vështirësi në frymëmarrje', 'P1'],
  ['Pa vetëdije', 'P1'],
  ['Shenja të goditjes në tru', 'P1'],
  ['Aksident trafiku, lëndime', 'P2'],
  ['Rënie, dyshim për thyerje kofshe', 'P2'],
  ['Dhimbje e fortë barku', 'P2'],
  ['Temperaturë e lartë te fëmija', 'P3'],
  ['Marramendje', 'P3'],
  ['Plagë e vogël, gjakderdhje e kontrolluar', 'P3'],
];
const DESCRIPTIONS = [
  'Burrë rreth 60 vjeç',
  'Grua rreth 75 vjeçe',
  'Burrë rreth 35 vjeç',
  'Grua rreth 45 vjeçe',
  'Fëmijë rreth 6 vjeç',
];

/** Small deterministic generator so every seed run looks the same. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

export async function seedEms(opts: { facilityId: string; demoDoctorId: string }): Promise<void> {
  const { facilityId } = opts;
  const [service] = await db
    .insert(careUnits)
    .values({
      facilityId,
      name: 'Emergjenca Parahospitalore Prishtinë',
      code: 'QEP',
      type: 'AMBULANCE_SERVICE',
    })
    .returning();
  const serviceId = service!.id;
  const staff = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.email, ['doctor@pacient.local', 'nurse@pacient.local']));
  if (staff.length) {
    await db.insert(unitStaff).values(staff.map((s) => ({ unitId: serviceId, userId: s.id })));
  }
  const nurseId = staff.find((s) => s.email === 'nurse@pacient.local')?.id ?? opts.demoDoctorId;
  const doctorId = staff.find((s) => s.email === 'doctor@pacient.local')?.id ?? opts.demoDoctorId;

  const fleet = await db
    .insert(ambulanceUnits)
    .values([
      { stationUnitId: serviceId, callSign: 'QEP-01', level: 'ALS' },
      { stationUnitId: serviceId, callSign: 'QEP-02', level: 'ALS' },
      { stationUnitId: serviceId, callSign: 'QEP-03', level: 'BLS' },
      { stationUnitId: serviceId, callSign: 'QEP-04', level: 'BLS' },
    ])
    .returning();
  const vehicle = (sign: string) => fleet.find((v) => v.callSign === sign)!;

  // Three months of closed calls, oldest first so references follow the time of the call.
  const rand = rng(20_260_907);
  const now = Date.now();
  const history = Array.from({ length: 42 }, (_, i) => {
    const receivedAt = new Date(now - (90 - i * 2.1) * DAY - Math.floor(rand() * 12) * 60 * MIN);
    return { receivedAt, i };
  });
  for (const { receivedAt, i } of history) {
    const [complaint, priority] = COMPLAINTS[Math.floor(rand() * COMPLAINTS.length)]!;
    const municipality = MUNICIPALITIES[Math.floor(rand() * MUNICIPALITIES.length)]!;
    const cancelled = i % 17 === 5;
    const dispatchedAt = new Date(receivedAt.getTime() + (1 + Math.floor(rand() * 4)) * MIN);
    const responseBase = priority === 'P1' ? 6 : priority === 'P2' ? 9 : 14;
    const onSceneAt = new Date(
      dispatchedAt.getTime() +
        (responseBase + Math.floor(rand() * (priority === 'P1' ? 14 : 22))) * MIN,
    );
    const onScene = !cancelled;
    const transport = onScene && rand() < 0.75;
    const leftSceneAt = transport
      ? new Date(onSceneAt.getTime() + (15 + Math.floor(rand() * 15)) * MIN)
      : null;
    const atHospitalAt = leftSceneAt
      ? new Date(leftSceneAt.getTime() + (8 + Math.floor(rand() * 15)) * MIN)
      : null;
    const handedOverAt = atHospitalAt
      ? new Date(atHospitalAt.getTime() + (5 + Math.floor(rand() * 10)) * MIN)
      : null;
    const outcome = cancelled
      ? 'CANCELLED'
      : transport
        ? 'TRANSPORTED'
        : rand() < 0.7
          ? 'TREATED_ON_SCENE'
          : 'REFUSED_TRANSPORT';
    const closedAt = new Date(
      (handedOverAt ?? (cancelled ? dispatchedAt : onSceneAt)).getTime() +
        (10 + Math.floor(rand() * 20)) * MIN,
    );
    await db.transaction(async (tx) => {
      const reference = await nextReference(tx, receivedAt);
      await tx.insert(emsIncidents).values({
        reference,
        serviceUnitId: serviceId,
        receivedAt,
        address: `${STREETS[Math.floor(rand() * STREETS.length)]} ${1 + Math.floor(rand() * 90)}`,
        municipality,
        complaint,
        priority,
        status: cancelled ? 'CANCELLED' : 'CLOSED',
        patientDescription: DESCRIPTIONS[i % DESCRIPTIONS.length],
        ambulanceUnitId: fleet[i % fleet.length]!.id,
        dispatchedAt,
        onSceneAt: onScene ? onSceneAt : null,
        leftSceneAt,
        atHospitalAt,
        handedOverAt,
        destinationFacilityId: transport ? facilityId : null,
        outcome,
        closedAt,
        createdById: i % 2 ? nurseId : doctorId,
      });
    });
  }

  // A synthetic patient on the way to the demo emergency department (pre-alert on the ED board).
  const nationalId = await freeNationalId(1288800001);
  const [patient] = await db
    .insert(patients)
    .values({
      nationalId,
      firstName: 'Xhavit',
      lastName: 'Hyseni',
      dateOfBirth: '1956-02-14',
      sex: 'MALE',
      primaryFacilityId: facilityId,
      municipality: 'Prishtinë',
    })
    .returning();

  const open = async (minutesAgo: number, values: Partial<typeof emsIncidents.$inferInsert>) =>
    db.transaction(async (tx) => {
      const receivedAt = new Date(now - minutesAgo * MIN);
      const reference = await nextReference(tx, receivedAt);
      const [row] = await tx
        .insert(emsIncidents)
        .values({
          reference,
          serviceUnitId: serviceId,
          receivedAt,
          address: 'Rr. Agim Ramadani 24',
          complaint: 'Dhimbje gjoksi',
          priority: 'P1',
          createdById: nurseId,
          ...values,
        })
        .returning();
      return row!;
    });

  const p1 = await open(31, {
    callerName: 'Drita Hyseni',
    callerPhone: '+383 44 555 101',
    address: 'Rr. Fehmi Agani 18',
    municipality: 'Prishtinë',
    complaint: 'Dhimbje gjoksi që përhapet në krahun e majtë',
    priority: 'P1',
    status: 'TRANSPORTING',
    patientId: patient!.id,
    ambulanceUnitId: vehicle('QEP-01').id,
    dispatchedAt: new Date(now - 29 * MIN),
    onSceneAt: new Date(now - 19 * MIN),
    leftSceneAt: new Date(now - 6 * MIN),
    expectedAt: new Date(now + 5 * MIN),
    destinationFacilityId: facilityId,
  });
  await db.insert(emsCareRecords).values([
    {
      incidentId: p1.id,
      patientId: patient!.id,
      kind: 'OBSERVATION',
      recordedAt: new Date(now - 17 * MIN),
      data: {
        systolic: 102,
        diastolic: 64,
        heartRate: 112,
        respiratoryRate: 22,
        spo2: 93,
        gcs: 15,
        glucose: 7.8,
        temperature: 36.9,
        onOxygen: false,
      },
      recordedById: doctorId,
    },
    {
      incidentId: p1.id,
      patientId: patient!.id,
      kind: 'MEDICATION',
      recordedAt: new Date(now - 14 * MIN),
      data: { medication: 'Aspirinë', dose: '300 mg', route: 'oral' },
      text: 'Aspirinë 300 mg (oral)',
      recordedById: doctorId,
    },
    {
      incidentId: p1.id,
      patientId: patient!.id,
      kind: 'INTERVENTION',
      recordedAt: new Date(now - 12 * MIN),
      data: {},
      text: 'EKG me 12 kanale: ngritje e ST në V2–V4; oksigjen me maskë 4 L/min',
      recordedById: doctorId,
    },
    {
      incidentId: p1.id,
      patientId: patient!.id,
      kind: 'OBSERVATION',
      recordedAt: new Date(now - 7 * MIN),
      data: {
        systolic: 98,
        diastolic: 60,
        heartRate: 118,
        respiratoryRate: 24,
        spo2: 95,
        gcs: 15,
        onOxygen: true,
      },
      recordedById: doctorId,
    },
  ]);

  const onScene = await open(16, {
    callerPhone: '+383 49 222 334',
    address: 'Lagjja Dardania, Blloku 3, hyrja 2',
    municipality: 'Prishtinë',
    complaint: 'Rënie në shtëpi, dyshim për thyerje kofshe',
    priority: 'P2',
    status: 'ON_SCENE',
    patientDescription: 'Grua rreth 80 vjeçe',
    ambulanceUnitId: vehicle('QEP-03').id,
    dispatchedAt: new Date(now - 14 * MIN),
    onSceneAt: new Date(now - 3 * MIN),
  });
  await db.insert(emsCareRecords).values({
    incidentId: onScene.id,
    kind: 'OBSERVATION',
    recordedAt: new Date(now - 2 * MIN),
    data: { systolic: 148, diastolic: 82, heartRate: 92, respiratoryRate: 18, spo2: 97, gcs: 15 },
    recordedById: nurseId,
  });

  await open(4, {
    callerName: 'Fatmir Gashi',
    callerPhone: '+383 45 777 812',
    address: 'Rr. Lidhja e Prizrenit 7',
    municipality: 'Fushë Kosovë',
    complaint: 'Temperaturë e lartë dhe kollë te fëmija',
    priority: 'P3',
    status: 'RECEIVED',
    patientDescription: 'Fëmijë 6 vjeç',
  });

  await db
    .update(ambulanceUnits)
    .set({ status: 'TRANSPORTING' })
    .where(eq(ambulanceUnits.id, vehicle('QEP-01').id));
  await db
    .update(ambulanceUnits)
    .set({ status: 'ON_SCENE' })
    .where(and(eq(ambulanceUnits.id, vehicle('QEP-03').id)));
}

async function freeNationalId(start: number) {
  for (let n = start; ; n++) {
    const [taken] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(sql`${patients.nationalId} = ${String(n)}`);
    if (!taken) return String(n);
  }
}
