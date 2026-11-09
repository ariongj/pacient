import { and, eq, isNull, ne } from 'drizzle-orm';
import { db } from './client.js';
import { careAssignments, patients, promAssignments, promResponses, users } from './schema.js';
import {
  INSTRUMENTS,
  nextDueAfter,
  scoreAnswers,
  type Frequency,
  type InstrumentCode,
} from '../modules/proms/instruments.js';

const DAY = 86_400_000;

/** Answers adding up to `target` (raw score), spread over the items; item 9 of PHQ-9 kept at 0. */
function answersFor(code: InstrumentCode, target: number, opts: { selfHarm?: number } = {}) {
  const inst = INSTRUMENTS[code];
  const max = Math.max(...inst.items[0]!.options.map((o) => o.value));
  const items = inst.items.map((i) => i.code);
  const answers: Record<string, number> = Object.fromEntries(items.map((c) => [c, 0]));
  const fillable = items.filter((c) => !(code === 'PHQ9' && c === 'q9'));
  let left = target - (opts.selfHarm ?? 0);
  if (code === 'PHQ9') answers.q9 = opts.selfHarm ?? 0;
  for (let round = 0; left > 0 && round < max; round++) {
    for (const c of fillable) {
      if (left <= 0) break;
      if (answers[c]! < max) {
        answers[c]! += 1;
        left--;
      }
    }
  }
  return answers;
}

interface Plan {
  patientId: string;
  sex: string | null;
  instrument: InstrumentCode;
  frequency: Frequency;
  startDaysAgo: number;
  /** Raw scores of the answers, oldest first, with how many days ago each was given. */
  answers: { daysAgo: number; raw: number; selfHarm?: number; reviewed?: boolean }[];
  assignedById: string;
}

/**
 * Synthetic demo data for patient-reported outcomes (development only): the demo patient (Arta
 * Krasniqi) has six months of PHQ-9 answers improving from moderately severe to mild and a GAD-7
 * that is due now; other patients in the demo doctor's care have PHQ-9, GAD-7, WHO-5 and AUDIT-C
 * requests (some answered and reviewed, some waiting, one recent PHQ-9 with item 9 answered above
 * zero and not yet reviewed), enough for the director's completion figures.
 */
export async function seedProms(opts: { facilityId: string; demoDoctorId: string }) {
  const [existing] = await db.select({ id: promAssignments.id }).from(promAssignments).limit(1);
  if (existing) return;
  const now = Date.now();
  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  const [arta] = await db
    .select({ id: patients.id, sex: patients.sex })
    .from(patients)
    .where(eq(patients.email, 'patient@pacient.local'));
  const others = await db
    .selectDistinct({ id: patients.id, sex: patients.sex })
    .from(patients)
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
        isNull(patients.mergedIntoId),
        isNull(patients.deceasedAt),
        arta ? ne(patients.id, arta.id) : undefined,
      ),
    )
    .orderBy(patients.id)
    .limit(14);

  const doctor = opts.demoDoctorId;
  const plans: Plan[] = [];
  if (arta) {
    plans.push({
      patientId: arta.id,
      sex: arta.sex,
      instrument: 'PHQ9',
      frequency: 'MONTHLY',
      startDaysAgo: 185,
      answers: [17, 15, 13, 11, 8, 6].map((raw, i) => ({
        daysAgo: 182 - i * 30,
        raw,
        reviewed: true,
      })),
      assignedById: doctor,
    });
    plans.push({
      patientId: arta.id,
      sex: arta.sex,
      instrument: 'GAD7',
      frequency: 'MONTHLY',
      startDaysAgo: 40,
      answers: [{ daysAgo: 33, raw: 9, reviewed: true }],
      assignedById: doctor,
    });
  }
  others.forEach((p, i) => {
    const by = i % 3 === 2 && nurse ? nurse.id : doctor;
    if (i < 9) {
      // PHQ-9: most answered once or twice; two never answered; one recent self-harm answer.
      const answers =
        i === 0
          ? [
              { daysAgo: 35, raw: 12, reviewed: true },
              { daysAgo: 1, raw: 16, selfHarm: 1 },
            ]
          : i >= 7
            ? []
            : [
                { daysAgo: 50, raw: 6 + i, reviewed: true },
                { daysAgo: 20, raw: 4 + i, reviewed: i % 2 === 0 },
              ];
      plans.push({
        patientId: p.id,
        sex: p.sex,
        instrument: 'PHQ9',
        frequency: 'MONTHLY',
        startDaysAgo: 60,
        answers,
        assignedById: by,
      });
    }
    if (i >= 3 && i < 10) {
      plans.push({
        patientId: p.id,
        sex: p.sex,
        instrument: 'GAD7',
        frequency: 'QUARTERLY',
        startDaysAgo: 45,
        answers: i === 9 ? [] : [{ daysAgo: 40, raw: 3 + i, reviewed: i % 2 === 1 }],
        assignedById: by,
      });
    }
    if (i >= 5) {
      plans.push({
        patientId: p.id,
        sex: p.sex,
        instrument: 'WHO5',
        frequency: 'QUARTERLY',
        startDaysAgo: 30,
        answers: i === 13 ? [] : [{ daysAgo: 25, raw: 8 + i, reviewed: true }],
        assignedById: by,
      });
    }
    if (i >= 2 && i < 8) {
      plans.push({
        patientId: p.id,
        sex: p.sex,
        instrument: 'AUDITC',
        frequency: 'ONCE',
        startDaysAgo: 28,
        answers: i === 7 ? [] : [{ daysAgo: 21, raw: i - 1, reviewed: true }],
        assignedById: by,
      });
    }
  });

  for (const plan of plans) {
    const startedAt = new Date(now - plan.startDaysAgo * DAY);
    const last = plan.answers.at(-1);
    const lastAt = last ? new Date(now - last.daysAgo * DAY) : null;
    const once = plan.frequency === 'ONCE';
    const nextDueAt =
      once && lastAt ? null : lastAt ? nextDueAfter(plan.frequency, lastAt) : startedAt;
    const [a] = await db
      .insert(promAssignments)
      .values({
        patientId: plan.patientId,
        facilityId: opts.facilityId,
        assignedById: plan.assignedById,
        instrument: plan.instrument,
        frequency: plan.frequency,
        nextDueAt,
        status: once && lastAt ? 'ENDED' : 'ACTIVE',
        endedAt: once && lastAt ? lastAt : null,
        endReason: once && lastAt ? 'Completed' : null,
        createdAt: startedAt,
        updatedAt: lastAt ?? startedAt,
      })
      .returning({ id: promAssignments.id });
    for (const ans of plan.answers) {
      const answers = answersFor(plan.instrument, ans.raw, { selfHarm: ans.selfHarm });
      const scored = scoreAnswers(plan.instrument, answers, plan.sex);
      const at = new Date(now - ans.daysAgo * DAY);
      await db.insert(promResponses).values({
        patientId: plan.patientId,
        assignmentId: a!.id,
        instrument: plan.instrument,
        answers,
        score: String(scored.score),
        severity: scored.severity,
        safetyFlag: scored.safetyFlag,
        submittedAt: at,
        reviewedAt: ans.reviewed ? new Date(at.getTime() + 6 * 3_600_000) : null,
        reviewedById: ans.reviewed ? plan.assignedById : null,
        reviewNote: ans.reviewed ? 'U diskutua në vizitën e radhës.' : null,
      });
    }
  }
}
