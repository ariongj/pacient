import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  admissions,
  careUnits,
  edVisits,
  earlyWarningScores,
  patients,
  sepsisScreens,
  users,
} from './schema.js';
import { SEPSIS_STEPS, type SepsisStep } from '../modules/sepsis/sepsis.service.js';

const MIN = 60_000;
const DAY = 86_400_000;

/** Bundle steps at the given minutes after the start, by the given clinicians (synthetic). */
function bundleAt(start: Date, minutes: Partial<Record<SepsisStep, number>>, by: string[]) {
  const bundle: Record<string, string> = {};
  SEPSIS_STEPS.forEach((step, i) => {
    const m = minutes[step];
    if (m === undefined) return;
    bundle[step] = new Date(start.getTime() + m * MIN).toISOString();
    bundle[`${step}By`] = by[i % by.length]!;
  });
  return bundle;
}

/**
 * Synthetic demo data for sepsis (development only): on the wards of the demo facility a pending
 * prompt, a red-flag bundle running for about 35 minutes with four of six steps done, a completed
 * bundle and a screen that found no sepsis; plus a year of history for the director's dashboard.
 */
export async function seedSepsis(opts: { facilityId: string; demoDoctorId: string }) {
  const { facilityId, demoDoctorId } = opts;
  const now = Date.now();
  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  const staff = [nurse?.id ?? demoDoctorId, demoDoctorId];

  // Adult inpatients on general wards of the facility (children are scored with PEWS and are left
  // to the prompt that their scores create).
  const stays = await db
    .select({
      admissionId: admissions.id,
      patientId: admissions.patientId,
      unitType: careUnits.type,
      dateOfBirth: patients.dateOfBirth,
    })
    .from(admissions)
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .where(
      and(
        eq(admissions.facilityId, facilityId),
        eq(admissions.status, 'ADMITTED'),
        inArray(careUnits.type, ['GENERAL_WARD', 'SURGICAL_WARD', 'ICU']),
        sql`${patients.dateOfBirth} < (now() - interval '18 years')::date`,
      ),
    )
    .orderBy(asc(admissions.admittedAt));
  const already = new Set(
    (
      await db
        .select({ patientId: sepsisScreens.patientId })
        .from(sepsisScreens)
        .where(eq(sepsisScreens.facilityId, facilityId))
    ).map((r) => r.patientId),
  );
  const free = stays.filter((s) => !already.has(s.patientId));
  const latestScore = async (patientId: string) =>
    (
      await db
        .select({ id: earlyWarningScores.id })
        .from(earlyWarningScores)
        .where(eq(earlyWarningScores.patientId, patientId))
        .orderBy(sql`${earlyWarningScores.computedAt} DESC`)
        .limit(1)
    )[0]?.id ?? null;

  // 1. Red flag, bundle running ~35 minutes, four of six steps done.
  const red = free[0];
  if (red) {
    const start = new Date(now - 35 * MIN);
    await db.insert(sepsisScreens).values({
      patientId: red.patientId,
      facilityId,
      admissionId: red.admissionId,
      earlyWarningScoreId: await latestScore(red.patientId),
      trigger: 'PROMPTED',
      status: 'RED_FLAG',
      suspectedSource: 'RESPIRATORY',
      redFlags: ['HR_GE_130', 'RR_GE_25', 'NEEDS_OXYGEN'],
      screenedAt: start,
      screenedById: staff[0],
      bundle: bundleAt(start, { oxygen: 2, cultures: 9, lactate: 12, fluids: 18 }, staff),
      bundleStartedAt: start,
      notes: 'Kollë me pështymë, temperaturë 38,9 °C, takipne.',
      createdAt: new Date(now - 40 * MIN),
    });
  }
  // 2. Completed bundle two days ago (all six in 48 minutes, senior review).
  const done = free[1];
  if (done) {
    const start = new Date(now - 2 * DAY);
    const bundle = bundleAt(
      start,
      { oxygen: 3, cultures: 10, antibiotics: 32, fluids: 20, lactate: 14, urineOutput: 48 },
      staff,
    );
    await db.insert(sepsisScreens).values({
      patientId: done.patientId,
      facilityId,
      admissionId: done.admissionId,
      trigger: 'PROMPTED',
      status: 'RED_FLAG',
      suspectedSource: 'URINARY',
      redFlags: ['SYSTOLIC_LE_90', 'LACTATE_GE_2'],
      screenedAt: start,
      screenedById: staff[0],
      bundle,
      bundleStartedAt: start,
      bundleCompletedAt: new Date(start.getTime() + 48 * MIN),
      seniorReviewAt: new Date(start.getTime() + 25 * MIN),
      createdAt: new Date(start.getTime() - 6 * MIN),
    });
  }
  // 3. Screen that found no sepsis (three hours ago).
  const not = free[2];
  if (not) {
    const at = new Date(now - 3 * 3_600_000);
    await db.insert(sepsisScreens).values({
      patientId: not.patientId,
      facilityId,
      admissionId: not.admissionId,
      trigger: 'PROMPTED',
      status: 'NOT_SEPSIS',
      redFlags: [],
      screenedAt: at,
      screenedById: staff[0],
      notes: 'Takikardi pas dhimbjes; pa shenja infeksioni.',
      createdAt: new Date(at.getTime() - 15 * MIN),
    });
  }
  // 4. A pending prompt (twenty minutes old), unless the scores already produced one.
  const [pending] = await db
    .select({ id: sepsisScreens.id })
    .from(sepsisScreens)
    .where(and(eq(sepsisScreens.facilityId, facilityId), eq(sepsisScreens.status, 'PENDING')))
    .limit(1);
  const waiting = free[3];
  if (!pending && waiting) {
    await db.insert(sepsisScreens).values({
      patientId: waiting.patientId,
      facilityId,
      admissionId: waiting.admissionId,
      earlyWarningScoreId: await latestScore(waiting.patientId),
      trigger: 'PROMPTED',
      status: 'PENDING',
      createdAt: new Date(now - 20 * MIN),
    });
  }
  // An emergency patient with suspected sepsis (amber flags, senior review pending).
  const [ed] = await db
    .select({ id: edVisits.id, patientId: edVisits.patientId })
    .from(edVisits)
    .where(
      and(
        eq(edVisits.facilityId, facilityId),
        inArray(edVisits.status, ['WAITING', 'IN_TREATMENT']),
      ),
    )
    .limit(1);
  if (ed && !already.has(ed.patientId)) {
    const at = new Date(now - 25 * MIN);
    await db.insert(sepsisScreens).values({
      patientId: ed.patientId,
      facilityId,
      edVisitId: ed.id,
      trigger: 'MANUAL',
      status: 'SEPSIS_SUSPECTED',
      suspectedSource: 'SKIN_SOFT_TISSUE',
      redFlags: ['HR_91_130', 'RIGORS'],
      screenedAt: at,
      screenedById: staff[0],
      createdAt: at,
    });
  }

  // History for the director's dashboard: closed screens over the last eleven months, spread over
  // the facility's patients (no stay attached).
  const pool = await db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.primaryFacilityId, facilityId),
        sql`${patients.dateOfBirth} < (now() - interval '18 years')::date`,
        sql`${patients.deceasedAt} IS NULL`,
      ),
    )
    .limit(60);
  if (!pool.length) return;
  const history: (typeof sepsisScreens.$inferInsert)[] = [];
  for (let i = 0; i < 70; i++) {
    const patient = pool[(i * 7) % pool.length]!;
    const start = new Date(now - (5 + ((i * 97) % 330)) * DAY - ((i * 37) % 600) * MIN);
    const kind = i % 5; // 0–2 red flag, 3 suspected, 4 not sepsis
    if (kind === 4) {
      history.push({
        patientId: patient.id,
        facilityId,
        trigger: i % 2 ? 'PROMPTED' : 'MANUAL',
        status: 'NOT_SEPSIS',
        redFlags: [],
        screenedAt: start,
        screenedById: staff[i % 2],
        createdAt: new Date(start.getTime() - 10 * MIN),
      });
      continue;
    }
    // Times vary: most bundles inside the hour, some late.
    const late = i % 4 === 0 ? 35 : 0;
    const minutes = {
      oxygen: 3,
      cultures: 12 + (i % 9),
      lactate: 15 + (i % 7),
      fluids: 20 + (i % 11),
      antibiotics: 25 + ((i * 13) % 30) + late,
      urineOutput: 40 + (i % 15) + late,
    };
    const bundle = bundleAt(start, minutes, staff);
    const last = Math.max(...Object.values(minutes));
    history.push({
      patientId: patient.id,
      facilityId,
      trigger: i % 3 ? 'PROMPTED' : 'MANUAL',
      status: kind === 3 ? 'SEPSIS_SUSPECTED' : 'RED_FLAG',
      suspectedSource: ['RESPIRATORY', 'URINARY', 'ABDOMINAL', 'SKIN_SOFT_TISSUE'][i % 4]!,
      redFlags: kind === 3 ? ['HR_91_130'] : ['SYSTOLIC_LE_90', 'RR_GE_25'],
      screenedAt: start,
      screenedById: staff[i % 2],
      bundle,
      bundleStartedAt: start,
      bundleCompletedAt: new Date(start.getTime() + last * MIN),
      seniorReviewAt: new Date(start.getTime() + (20 + (i % 30)) * MIN),
      createdAt: new Date(start.getTime() - 8 * MIN),
    });
  }
  await db.insert(sepsisScreens).values(history);
}
