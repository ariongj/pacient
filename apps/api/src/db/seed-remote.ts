import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  careAssignments,
  homeReadings,
  monitoringPlans,
  patients,
  registerEnrolments,
  users,
} from './schema.js';
import { enrolPatient } from '../modules/registers/registers.service.js';
import {
  evaluateReading,
  planThresholds,
  REGISTER_SUGGESTIONS,
  type ReadingKind,
} from '../modules/remote/definitions.js';
import { REASONS_KEY } from '../modules/remote/remote.service.js';

const DAY = 86_400_000;

/** One clearly urgent value per kind (weight has no urgent limit). */
const URGENT_SAMPLE: Partial<Record<ReadingKind, Record<string, unknown>>> = {
  BLOOD_PRESSURE: { systolic: 192, diastolic: 118, pulse: 96 },
  GLUCOSE: { value: 2.6, context: 'BEFORE_MEAL' },
  SPO2: { value: 87, pulse: 112 },
  HEART_RATE: { value: 138 },
  TEMPERATURE: { value: 40.3 },
};

/**
 * Synthetic demo data for remote monitoring (development only): up to eight register patients in
 * the demo doctor's care are enrolled with 30 days of home readings (a few out of range and
 * reviewed, a few waiting, one urgent reading not yet reviewed, one patient who stopped sending),
 * and the demo patient (Arta Krasniqi, hypertension) has a blood-pressure plan with readings.
 */
export async function seedRemote(opts: { facilityId: string; demoDoctorId: string }) {
  const rand = mulberry32(20261108);
  const jitter = (spread: number) => (rand() - 0.5) * 2 * spread;
  const now = Date.now();
  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  const reviewer = nurse?.id ?? opts.demoDoctorId;

  // The demo patient: hypertension, followed with home blood pressure.
  const [arta] = await db
    .select({ id: patients.id, userId: patients.userId })
    .from(patients)
    .where(eq(patients.email, 'patient@pacient.local'));

  const candidates = await db
    .selectDistinct({ id: patients.id, register: registerEnrolments.register })
    .from(registerEnrolments)
    .innerJoin(patients, eq(patients.id, registerEnrolments.patientId))
    .innerJoin(
      careAssignments,
      and(
        eq(careAssignments.patientId, patients.id),
        eq(careAssignments.doctorId, opts.demoDoctorId),
        isNull(careAssignments.endedAt),
      ),
    )
    .where(
      and(
        eq(registerEnrolments.status, 'ACTIVE'),
        inArray(registerEnrolments.register, Object.keys(REGISTER_SUGGESTIONS)),
        isNull(patients.mergedIntoId),
        isNull(patients.deceasedAt),
      ),
    )
    .orderBy(registerEnrolments.register, patients.id);
  const people = new Map<string, string[]>();
  for (const c of candidates) {
    if (c.id === arta?.id) continue;
    people.set(c.id, [...(people.get(c.id) ?? []), c.register]);
  }
  // A mix of registers (round robin), eight patients at most.
  const queues = Object.keys(REGISTER_SUGGESTIONS).map((r) =>
    [...people].filter(([, regs]) => regs[0] === r),
  );
  const chosen: [string, string[]][] = [];
  while (chosen.length < 8 && queues.some((q) => q.length)) {
    for (const q of queues) if (q.length && chosen.length < 8) chosen.push(q.shift()!);
  }

  /** Typical values per kind; `high` pushes the values towards the limits. */
  const sample = (kind: ReadingKind, high: number, day: number): Record<string, unknown> => {
    switch (kind) {
      case 'BLOOD_PRESSURE': {
        const s = Math.round(138 + high * 24 + jitter(9));
        return {
          systolic: s,
          diastolic: Math.round(s * 0.6 + jitter(5)),
          pulse: Math.round(74 + jitter(8)),
        };
      }
      case 'GLUCOSE':
        return {
          value: Math.round((7.2 + high * 6 + jitter(1.6)) * 10) / 10,
          context: day % 2 ? 'FASTING' : 'AFTER_MEAL',
        };
      case 'WEIGHT':
        return { value: Math.round((84 + high * 0.08 * (30 - day) + jitter(0.4)) * 10) / 10 };
      case 'SPO2':
        return {
          value: Math.round(95 - high * 2 + jitter(1.4)),
          pulse: Math.round(82 + jitter(8)),
        };
      case 'HEART_RATE':
        return { value: Math.round(76 + high * 25 + jitter(8)) };
      case 'TEMPERATURE':
        return { value: Math.round((36.7 + high * 1.2 + jitter(0.3)) * 10) / 10 };
      default:
        return { value: Math.round(380 + jitter(40)) };
    }
  };

  async function addPlan(
    patientId: string,
    kinds: ReadingKind[],
    own: Record<string, number>,
    extra: { frequency: string; instructions: string; startedDaysAgo: number },
  ) {
    const [plan] = await db
      .insert(monitoringPlans)
      .values({
        patientId,
        facilityId: opts.facilityId,
        enrolledById: opts.demoDoctorId,
        kinds,
        thresholds: planThresholds(kinds, own) as Record<string, number>,
        frequency: extra.frequency,
        instructions: extra.instructions,
        createdAt: new Date(now - extra.startedDaysAgo * DAY),
        updatedAt: new Date(now - extra.startedDaysAgo * DAY),
      })
      .onConflictDoNothing()
      .returning();
    return plan;
  }

  async function addReadings(
    patientId: string,
    plan: NonNullable<Awaited<ReturnType<typeof addPlan>>>,
    profile: { high: number; lastDay: number; urgentToday?: boolean; enteredBy: string | null },
  ) {
    const limits = planThresholds(plan.kinds, plan.thresholds);
    const rows: (typeof homeReadings.$inferInsert)[] = [];
    const weights: { at: number; value: number }[] = [];
    for (let day = 30; day >= profile.lastDay; day--) {
      for (const kind of plan.kinds as ReadingKind[]) {
        if (rand() < 0.15) continue; // a missed day now and then
        const at = now - day * DAY - (1 + Math.floor(rand() * 10)) * 3600_000;
        // Some days run high (out of range for review).
        const spike = rand() < 0.12 ? 1 : 0;
        const values = sample(kind, Math.min(1.2, profile.high + spike), day);
        const previousWeights = weights.filter((w) => w.at >= at - 3 * DAY).map((w) => w.value);
        const evaluation = evaluateReading(kind, values, limits, { previousWeights });
        if (kind === 'WEIGHT') weights.push({ at, value: values.value as number });
        // Flagged readings older than two days were reviewed, mostly within a day.
        const reviewed = evaluation.flag !== 'NORMAL' && day > 2;
        rows.push({
          patientId,
          planId: plan.id,
          kind,
          values: { ...values, [REASONS_KEY]: evaluation.reasons },
          measuredAt: new Date(at),
          source: 'PORTAL',
          enteredByUserId: profile.enteredBy,
          flag: evaluation.flag,
          createdAt: new Date(at + 5 * 60_000),
          reviewedAt: reviewed ? new Date(at + (rand() < 0.8 ? 6 : 40) * 3600_000) : null,
          reviewedById: reviewed ? (rand() < 0.5 ? reviewer : opts.demoDoctorId) : null,
          reviewNote: reviewed && rand() < 0.5 ? 'Biseduam me pacientin; vazhdon terapinë.' : null,
        });
      }
    }
    const kind = (plan.kinds as ReadingKind[]).find((k) => URGENT_SAMPLE[k]);
    if (profile.urgentToday && kind) {
      const at = now - 2 * 3600_000;
      const values = URGENT_SAMPLE[kind]!;
      const evaluation = evaluateReading(kind, values, limits);
      rows.push({
        patientId,
        planId: plan.id,
        kind,
        values: { ...values, [REASONS_KEY]: evaluation.reasons },
        measuredAt: new Date(at),
        source: 'PORTAL',
        enteredByUserId: profile.enteredBy,
        note: 'Nuk ndihem mirë që nga mëngjesi.',
        flag: evaluation.flag,
        createdAt: new Date(at + 60_000),
      });
    }
    if (rows.length) await db.insert(homeReadings).values(rows);
  }

  // Register patients: the 3rd one has an urgent reading today, the last one went silent.
  for (const [i, [patientId, registers]] of chosen.entries()) {
    const kinds = [...new Set(registers.flatMap((r) => REGISTER_SUGGESTIONS[r] ?? []))].slice(0, 3);
    const plan = await addPlan(
      patientId,
      kinds,
      {},
      {
        frequency: kinds.includes('BLOOD_PRESSURE') ? 'Dy herë në ditë' : 'Çdo mëngjes',
        instructions: 'Matni në të njëjtën orë çdo ditë dhe shënoni matjet në portal.',
        startedDaysAgo: 35,
      },
    );
    if (!plan) continue;
    const silent = i === chosen.length - 1 && chosen.length > 1;
    await addReadings(patientId, plan, {
      high: i % 3 === 1 ? 0.6 : 0.15,
      lastDay: silent ? 9 : 0,
      urgentToday: i === 2,
      enteredBy: null,
    });
  }

  if (arta) {
    await enrolPatient(arta.id, ['HYPERTENSION'], {
      source: 'MANUAL',
      enrolledById: opts.demoDoctorId,
    });
    const plan = await addPlan(
      arta.id,
      ['BLOOD_PRESSURE'],
      { systolicHigh: 150, diastolicHigh: 95 },
      {
        frequency: 'Dy herë në ditë (mëngjes dhe mbrëmje)',
        instructions:
          'Uluni të qetë 5 minuta para matjes, krahu në nivel të zemrës. Bëni dy matje dhe shënoni të dytën.',
        startedDaysAgo: 32,
      },
    );
    if (plan) await addReadings(arta.id, plan, { high: 0.25, lastDay: 0, enteredBy: arta.userId });
  }

  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(homeReadings);
  return count?.n ?? 0;
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
