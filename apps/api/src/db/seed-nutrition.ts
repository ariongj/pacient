/** Demo data for hospital nutrition (development seed only). */
import { and, asc, eq } from 'drizzle-orm';
import { hashPassword } from '../lib/password.js';
import { ageInYears, scoreScreening } from '../modules/nutrition/nutrition.service.js';
import { db } from './client.js';
import {
  admissions,
  allergies,
  careUnits,
  dietOrders,
  nutritionScreenings,
  patients,
  unitStaff,
  users,
} from './schema.js';

const DEMO_PASSWORD = 'Pacient-Demo-2026';

type Diet = typeof dietOrders.$inferInsert;

/** Diets handed out in turn to the current inpatients. */
const PLAN: Omit<Diet, 'patientId' | 'admissionId' | 'orderedById'>[] = [
  {
    dietType: 'DIABETIC',
    notes: 'Pa sheqer të shtuar; 5 vakte të vogla në ditë',
    reason: 'Diabet tip 2',
  },
  {
    dietType: 'LOW_SALT',
    restrictions: ['pa kripë të shtuar'],
    reason: 'Insuficiencë kardiake',
    fluidLimitMl: 1500,
  },
  { dietType: 'SOFT', reason: 'Vështirësi në përtypje', notes: 'Mish i grirë, perime të ziera' },
  { dietType: 'GLUTEN_FREE', restrictions: ['celiaki'], reason: 'Celiaki e konfirmuar' },
  {
    dietType: 'NIL_BY_MOUTH',
    reason: 'Pankreatit akut – pushim i zorrëve',
    notes: 'Vetëm lëngje intravenoze',
  },
  { dietType: 'HIGH_PROTEIN', reason: 'Plagë kirurgjikale, rikuperim' },
  {
    dietType: 'RENAL',
    restrictions: ['pak kalium'],
    fluidLimitMl: 1000,
    reason: 'Sëmundje kronike e veshkave',
  },
  { dietType: 'NORMAL' },
];

export async function seedNutrition({ facilityId }: { facilityId: string }) {
  const [kitchen] = await db
    .insert(careUnits)
    .values({ facilityId, name: 'Kuzhina qendrore', code: 'KUZH', type: 'NUTRITION' })
    .onConflictDoNothing()
    .returning();
  const unit =
    kitchen ??
    (
      await db
        .select()
        .from(careUnits)
        .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.code, 'KUZH')))
    )[0]!;

  // Kitchen / dietitian account: a NURSE-role user assigned to the NUTRITION unit. It sees meal
  // lists only – never patients' records.
  const [cook] = await db
    .insert(users)
    .values({
      email: 'kuzhina@pacient.local',
      fullName: 'Shpresa Morina',
      role: 'NURSE',
      facilityId,
      specialty: 'Dietologe, kuzhina e spitalit',
      passwordHash: await hashPassword(DEMO_PASSWORD),
      passwordChangedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (cook) {
    await db.insert(unitStaff).values({ unitId: unit.id, userId: cook.id }).onConflictDoNothing();
  }

  const stays = await db
    .select({
      admissionId: admissions.id,
      patientId: admissions.patientId,
      attendingDoctorId: admissions.attendingDoctorId,
      admittedAt: admissions.admittedAt,
      dateOfBirth: patients.dateOfBirth,
    })
    .from(admissions)
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .where(and(eq(admissions.facilityId, facilityId), eq(admissions.status, 'ADMITTED')))
    .orderBy(asc(admissions.admittedAt));
  if (!stays.length) return;

  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  const screener = nurse?.id ?? stays[0]!.attendingDoctorId;

  let i = 0;
  for (const stay of stays) {
    const age = ageInYears(stay.dateOfBirth);
    if (age < 1) continue; // newborns are breast- or bottle-fed with their mother
    const plan = PLAN[i % PLAN.length]!;
    i++;
    await db.insert(dietOrders).values({
      ...plan,
      patientId: stay.patientId,
      admissionId: stay.admissionId,
      orderedById: stay.attendingDoctorId,
      startsAt: new Date(stay.admittedAt.getTime() + 60 * 60_000),
    });
    if (plan.dietType === 'GLUTEN_FREE') {
      await db.insert(allergies).values({
        patientId: stay.patientId,
        substance: 'Gluten (celiaki)',
        reaction: 'Diarre, dhimbje barku',
        severity: 'MODERATE',
        verificationStatus: 'CONFIRMED',
        recordedById: stay.attendingDoctorId,
      });
    }
  }

  // Screenings: most adults screened on admission, one at high risk; the last stays are due.
  const toScreen = stays
    .filter((s) => ageInYears(s.dateOfBirth) >= 1)
    .slice(0, Math.max(0, stays.length - 2));
  for (const [n, stay] of toScreen.entries()) {
    const age = ageInYears(stay.dateOfBirth);
    const child = age < 18;
    const tool = child ? 'STRONGKIDS' : 'NRS2002';
    const answers: Record<string, unknown> = child
      ? {
          poorNutritionalStatus: false,
          highRiskDisease: n === 0,
          intakeOrLosses: true,
          weightLoss: false,
        }
      : n === 1
        ? { nutritionalStatus: 2, diseaseSeverity: 2 }
        : { nutritionalStatus: n % 2, diseaseSeverity: 1 };
    const result = scoreScreening(tool, answers, age);
    await db.insert(nutritionScreenings).values({
      patientId: stay.patientId,
      admissionId: stay.admissionId,
      tool,
      score: result.score,
      risk: result.risk,
      answers: { ...answers, ...result.detail },
      screenedById: screener,
      screenedAt: new Date(stay.admittedAt.getTime() + 3 * 3_600_000),
    });
  }
}
