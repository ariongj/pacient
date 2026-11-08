/**
 * Synthetic demo data for blood donors (development only; every person here is invented):
 * ~80 donors with two years of visits, a few current deferrals and one permanent deferral, today's
 * visits, a testing queue, and three donations of the demo patient Arta Krasniqi.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  bloodDonations,
  bloodDonors,
  bloodGroupTests,
  bloodUnits,
  careUnits,
  patients,
  unitStaff,
  users,
} from './schema.js';
import {
  isoDate,
  LIMITS,
  nextDonationUnitNumber,
  QUESTIONS,
  SCREENING_DISCARD,
  WHOLE_BLOOD_SHELF_DAYS,
} from '../modules/donors/donors.service.js';

const DAY = 86_400_000;

const FIRST_F = ['Ardita', 'Blerta', 'Drita', 'Elira', 'Fjolla', 'Gentiana', 'Mimoza', 'Teuta'];
const FIRST_M = ['Agon', 'Besnik', 'Driton', 'Fatos', 'Gëzim', 'Ilir', 'Labinot', 'Valon'];
const LAST = ['Berisha', 'Gashi', 'Hoxha', 'Kastrati', 'Morina', 'Rexhepi', 'Shala', 'Zeka'];
/** Roughly the ABO/RhD distribution of a European population. */
const GROUPS: [string, string, number][] = [
  ['O', 'POS', 33],
  ['A', 'POS', 36],
  ['B', 'POS', 12],
  ['AB', 'POS', 5],
  ['O', 'NEG', 6],
  ['A', 'NEG', 6],
  ['B', 'NEG', 1.5],
  ['AB', 'NEG', 0.5],
];

/** Deterministic pseudo-random numbers so every seed looks the same. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
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

const allNo = () => Object.fromEntries(QUESTIONS.map((q) => [q.code, q.code === 'FEELING_WELL']));

type Visit = {
  at: Date;
  outcome: 'COMPLETED' | 'DEFERRED' | 'ABORTED';
  problems?: string[];
  answers?: Record<string, boolean>;
  haemoglobin?: number;
  /** Untested: stays in the testing queue (no unit yet). */
  untested?: boolean;
  reactive?: boolean;
  adverseReaction?: string;
};

export async function seedDonors(opts: { facilityId: string; demoDoctorId: string }) {
  const { facilityId } = opts;
  const [unit] = await db
    .select({ id: careUnits.id })
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.type, 'BLOOD_BANK')));
  if (!unit) return;
  const [recorder] = await db
    .select({ id: users.id })
    .from(unitStaff)
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(and(eq(unitStaff.unitId, unit.id), eq(users.email, 'nurse@pacient.local')));
  if (!recorder) return;
  const [already] = await db
    .select({ id: bloodDonors.id })
    .from(bloodDonors)
    .where(eq(bloodDonors.registeredAtFacilityId, facilityId))
    .limit(1);
  if (already) return;

  const rand = rng(20_240_917);
  const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const group = () => {
    let r = rand() * 100;
    for (const [abo, rhD, w] of GROUPS) {
      if ((r -= w) <= 0) return [abo, rhD] as const;
    }
    return ['O', 'POS'] as const;
  };
  const now = Date.now();
  // Kosovo morning: 07:30 UTC is 08:30 or 09:30 local.
  const today = new Date();
  today.setUTCHours(7, 30, 0, 0);
  const daysAgo = (d: number, minutes = 0) =>
    new Date(today.getTime() - d * DAY + minutes * 60_000);

  /** Visits of an ordinary donor: every 3–8 months (men) or 4–9 months (women). */
  const history = (female: boolean, startDaysAgo: number, stopDaysAgo: number): Visit[] => {
    const visits: Visit[] = [];
    const min = female ? LIMITS.intervalDaysWomen : LIMITS.intervalDaysMen;
    for (let d = startDaysAgo; d > stopDaysAgo; d -= min + int(10, 150)) {
      const r = rand();
      if (r < 0.06) {
        const low = female ? int(110, 123) : int(118, 133);
        visits.push({
          at: daysAgo(d, int(0, 300)),
          outcome: 'DEFERRED',
          problems: ['HB_LOW'],
          haemoglobin: low,
        });
      } else if (r < 0.1) {
        visits.push({
          at: daysAgo(d, int(0, 300)),
          outcome: 'DEFERRED',
          problems: ['Q_RECENT_ILLNESS'],
          answers: { ...allNo(), RECENT_ILLNESS: true },
        });
      } else if (r < 0.12) {
        visits.push({ at: daysAgo(d, int(0, 300)), outcome: 'ABORTED' });
      } else {
        visits.push({
          at: daysAgo(d, int(0, 300)),
          outcome: 'COMPLETED',
          adverseReaction:
            rand() < 0.03 ? 'Ndjenjë e lehtë të fikëti, u përmirësua pas pushimit' : undefined,
        });
      }
    }
    return visits;
  };

  type Person = {
    firstName: string;
    lastName: string;
    female: boolean;
    dateOfBirth: string;
    group: readonly [string, string];
    consent: boolean;
    visits: Visit[];
    patientId?: string;
  };
  const people: Person[] = [];
  for (let i = 0; i < 80; i++) {
    const female = rand() < 0.4;
    const age = int(19, 62);
    const dob = new Date(Date.UTC(new Date().getUTCFullYear() - age, int(0, 11), int(1, 28)));
    // The first five donors visit today (their history stops months ago); the next ones after.
    const stop = i < 5 ? 120 : 0;
    const p: Person = {
      firstName: pick(female ? FIRST_F : FIRST_M),
      lastName: pick(LAST),
      female,
      dateOfBirth: isoDate(dob),
      group: group(),
      consent: rand() < 0.7,
      visits: history(female, int(stop + 30, 730), stop),
    };
    people.push(p);
  }
  // Today's visits.
  people[0]!.visits.push({ at: daysAgo(0, 15), outcome: 'COMPLETED' });
  people[1]!.visits.push({ at: daysAgo(0, 40), outcome: 'COMPLETED', untested: true });
  people[2]!.visits.push({ at: daysAgo(0, 75), outcome: 'COMPLETED', untested: true });
  people[3]!.visits.push({
    at: daysAgo(0, 95),
    outcome: 'DEFERRED',
    problems: ['HB_LOW'],
    haemoglobin: people[3]!.female ? 118 : 127,
  });
  people[4]!.visits.push({
    at: daysAgo(0, 120),
    outcome: 'ABORTED',
    adverseReaction: 'Hematomë në vendin e shpimit',
  });
  // Yesterday's donations still waiting for their tests.
  for (const i of [5, 6, 7]) {
    const p = people[i]!;
    p.visits = p.visits.filter((v) => v.at.getTime() < now - 130 * DAY);
    p.visits.push({ at: daysAgo(1, 20 * i), outcome: 'COMPLETED', untested: true });
  }
  // Current temporary deferrals (tattoo, travel, illness).
  for (const [i, code, days] of [
    [8, 'TATTOO_PIERCING', 20],
    [9, 'MALARIA_TRAVEL', 35],
    [10, 'RECENT_ILLNESS', 4],
    [11, 'SURGERY', 50],
  ] as const) {
    const p = people[i]!;
    p.visits = p.visits.filter((v) => v.at.getTime() < now - 130 * DAY);
    p.visits.push({
      at: daysAgo(days, 30),
      outcome: 'DEFERRED',
      problems: [`Q_${code}`],
      answers: { ...allNo(), [code]: true },
    });
  }
  // One donor permanently deferred after a reactive screening test months ago.
  const permanent = people[12]!;
  permanent.visits = permanent.visits.filter((v) => v.at.getTime() < now - 250 * DAY);
  permanent.visits.push({ at: daysAgo(200, 45), outcome: 'COMPLETED', reactive: true });

  // The demo patient Arta Krasniqi gives blood about twice a year.
  const [arta] = await db
    .select({ id: patients.id, bloodType: patients.bloodType, dateOfBirth: patients.dateOfBirth })
    .from(patients)
    .where(eq(patients.email, 'patient@pacient.local'));
  if (arta) {
    const bt = /^(AB|A|B|O)([+-])$/.exec(arta.bloodType);
    people.push({
      firstName: 'Arta',
      lastName: 'Krasniqi',
      female: true,
      dateOfBirth: arta.dateOfBirth,
      group: bt ? [bt[1]!, bt[2] === '+' ? 'POS' : 'NEG'] : ['A', 'POS'],
      consent: true,
      visits: [
        { at: daysAgo(470, 60), outcome: 'COMPLETED' },
        { at: daysAgo(300, 90), outcome: 'COMPLETED' },
        { at: daysAgo(140, 30), outcome: 'COMPLETED' },
      ],
      patientId: arta.id,
    });
  }

  for (const [i, p] of people.entries()) {
    p.visits.sort((a, b) => a.at.getTime() - b.at.getTime());
    if (!p.visits.length) continue;
    if (!p.patientId) {
      const [row] = await db
        .insert(patients)
        .values({
          nationalId: await freeNationalId(1_290_100_001 + i * 3),
          firstName: p.firstName,
          lastName: p.lastName,
          dateOfBirth: p.dateOfBirth,
          sex: p.female ? 'FEMALE' : 'MALE',
          primaryFacilityId: facilityId,
          municipality: 'Prishtinë',
          address: 'Prishtinë',
          phone: `+38345${String(410000 + i * 211).padStart(6, '0')}`,
        })
        .returning({ id: patients.id });
      p.patientId = row!.id;
    }
    const firstAt = p.visits[0]!.at;
    const [donor] = await db
      .insert(bloodDonors)
      .values({
        patientId: p.patientId,
        registeredAtFacilityId: facilityId,
        contactConsent: p.consent,
        createdAt: firstAt,
      })
      .returning({ id: bloodDonors.id });
    const [abo, rhD] = p.group;
    let tested = false;
    let count = 0;
    let first: Date | null = null;
    let last: Date | null = null;
    let status = 'ACTIVE';
    let deferredUntil: string | null = null;
    let deferralReason: string | null = null;
    for (const v of p.visits) {
      let bloodUnitId: string | null = null;
      if (v.outcome === 'COMPLETED' && !v.untested) {
        const expiresAt = new Date(v.at.getTime() + WHOLE_BLOOD_SHELF_DAYS * DAY);
        const inStock = expiresAt.getTime() > now;
        const [u] = await db
          .insert(bloodUnits)
          .values({
            facilityId,
            unitNumber: await nextDonationUnitNumber(db, v.at),
            product: 'WHOLE_BLOOD',
            abo,
            rhD,
            volumeMl: 450 + int(-15, 15),
            collectedAt: v.at,
            expiresAt,
            status: v.reactive
              ? 'DISCARDED'
              : inStock
                ? 'AVAILABLE'
                : rand() < 0.9
                  ? 'TRANSFUSED'
                  : 'DISCARDED',
            discardReason: v.reactive ? SCREENING_DISCARD : null,
            receivedById: recorder.id,
            createdAt: new Date(v.at.getTime() + DAY),
          })
          .returning({ id: bloodUnits.id, status: bloodUnits.status });
        if (u!.status === 'DISCARDED' && !v.reactive) {
          await db
            .update(bloodUnits)
            .set({ discardReason: 'Skadoi në magazinë' })
            .where(eq(bloodUnits.id, u!.id));
        }
        bloodUnitId = u!.id;
        if (!tested) {
          await db.insert(bloodGroupTests).values({
            patientId: p.patientId,
            facilityId,
            abo,
            rhD,
            testedById: recorder.id,
            testedAt: new Date(v.at.getTime() + DAY),
          });
          tested = true;
        }
      }
      const hb = v.haemoglobin ?? (p.female ? int(128, 145) : int(138, 162));
      await db.insert(bloodDonations).values({
        donorId: donor!.id,
        patientId: p.patientId,
        facilityId,
        attendedAt: v.at,
        questionnaire: {
          answers: v.answers ?? allNo(),
          medications: null,
          problems: v.problems ?? [],
        },
        haemoglobin: String(hb),
        systolic: int(110, 145),
        diastolic: int(68, 90),
        pulse: int(60, 88),
        weightKg: String(p.female ? int(55, 80) : int(68, 98)),
        outcome: v.outcome,
        deferralReason: v.outcome === 'DEFERRED' ? (v.problems ?? []).join('; ') : null,
        volumeMl:
          v.outcome === 'COMPLETED'
            ? 450 + int(-15, 15)
            : v.outcome === 'ABORTED'
              ? int(80, 250)
              : null,
        bloodUnitId,
        adverseReaction: v.adverseReaction ?? null,
        recordedById: recorder.id,
        createdAt: v.at,
      });
      if (v.outcome === 'COMPLETED') {
        count++;
        first ??= v.at;
      }
      if (v.outcome !== 'DEFERRED') last = v.at;
      if (v.outcome === 'DEFERRED') {
        const q = QUESTIONS.find((x) => `Q_${x.code}` === v.problems?.[0]);
        const days = q && typeof q.defer === 'number' ? q.defer : LIMITS.hbDeferDays;
        const until = new Date(v.at.getTime() + days * DAY);
        if (until.getTime() > now) {
          status = 'DEFERRED';
          deferredUntil = isoDate(until);
          deferralReason = (v.problems ?? []).join('; ');
        }
      }
      if (v.reactive) {
        status = 'PERMANENTLY_DEFERRED';
        deferredUntil = null;
        deferralReason =
          'Reactive donation screening: Hepatitis B – confirmatory testing and counselling';
      }
    }
    await db
      .update(bloodDonors)
      .set({
        abo: tested ? abo : null,
        rhD: tested ? rhD : null,
        donationCount: count,
        firstDonationAt: first,
        lastDonationAt: last,
        status,
        deferredUntil,
        deferralReason,
      })
      .where(eq(bloodDonors.id, donor!.id));
  }
}
