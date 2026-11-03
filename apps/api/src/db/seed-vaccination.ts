/** National vaccination calendar and demo data (development seed only). */
import { and, eq, isNull } from 'drizzle-orm';
import { DEFAULT_SCHEDULE } from '../modules/vaccination/calendar.js';
import { db } from './client.js';
import {
  births,
  careAssignments,
  guardianships,
  immunizations,
  patients,
  users,
  vaccineSchedule,
} from './schema.js';

const DAY = 86_400_000;
const isoDaysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const SITES = ['Kofsha e majtë', 'Kofsha e djathtë', 'Krahu i majtë', 'Krahu i djathtë'];

export async function seedVaccination({ facilityId }: { facilityId: string }) {
  if (!(await db.select({ id: vaccineSchedule.id }).from(vaccineSchedule).limit(1)).length) {
    await db.insert(vaccineSchedule).values(DEFAULT_SCHEDULE);
  }
  const schedule = new Map((await db.select().from(vaccineSchedule)).map((s) => [s.code, s]));

  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'NURSE'), eq(users.facilityId, facilityId)))
    .limit(1);
  const [doctor] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'doctor@pacient.local'));
  const [arta] = await db
    .select({ id: users.id, patientPhone: patients.phone, address: patients.address })
    .from(users)
    .innerJoin(patients, eq(patients.userId, users.id))
    .where(eq(users.email, 'patient@pacient.local'));
  const vaccinator = nurse?.id ?? doctor?.id;
  if (!vaccinator || !doctor) return;

  let lot = 4100;
  /** Records a scheduled dose given `delayDays` after its recommended age (never in the future). */
  async function give(patientId: string, dateOfBirth: string, codes: string[], delayDays = 3) {
    const rows = codes.map((code, i) => {
      const item = schedule.get(code)!;
      const at =
        new Date(`${dateOfBirth}T09:30:00Z`).getTime() +
        (item.recommendedAgeDays + delayDays) * DAY;
      return {
        patientId,
        vaccine: item.vaccine,
        doseNumber: item.doseNumber,
        scheduleItemId: item.id,
        administeredAt: new Date(Math.min(at, Date.now() - DAY)),
        administeredById: vaccinator!,
        facilityId,
        lotNumber: `KS-${lot++}`,
        site: SITES[i % SITES.length],
      };
    });
    if (rows.length) await db.insert(immunizations).values(rows);
  }

  const INFANT = ['BCG', 'HEPB_0', 'HEXA_1', 'PCV_1', 'HEXA_2', 'PCV_2', 'HEXA_3', 'PCV_3'];

  // Lea (10): complete childhood series. Link her two doses already in the record, add the rest.
  const [lea] = await db.select().from(patients).where(eq(patients.nationalId, '1199000001'));
  if (lea) {
    const existing = await db
      .select()
      .from(immunizations)
      .where(and(eq(immunizations.patientId, lea.id), isNull(immunizations.scheduleItemId)));
    for (const imm of existing) {
      const code = imm.vaccine.startsWith('MMR')
        ? 'MMR_2'
        : imm.vaccine.startsWith('DTaP-IPV')
          ? 'DTAP_IPV_B2'
          : null;
      if (code) {
        const item = schedule.get(code)!;
        await db
          .update(immunizations)
          .set({ scheduleItemId: item.id, vaccine: item.vaccine, doseNumber: item.doseNumber })
          .where(eq(immunizations.id, imm.id));
      }
    }
    await give(lea.id, lea.dateOfBirth, [...INFANT, 'MMR_1', 'DTAP_IPV_B1'], 4);
  }

  // Newborns of the birth seed: birth doses for babies older than a week.
  const babies = await db
    .select({ id: patients.id, dateOfBirth: patients.dateOfBirth, bornAt: births.bornAt })
    .from(births)
    .innerJoin(patients, eq(patients.id, births.newbornPatientId))
    .where(eq(births.facilityId, facilityId));
  for (const b of babies) {
    if (Date.now() - b.bornAt.getTime() > 7 * DAY)
      await give(b.id, b.dateOfBirth, ['BCG', 'HEPB_0'], 1);
  }

  async function addChild(c: {
    firstName: string;
    lastName: string;
    ageDays: number;
    sex: 'FEMALE' | 'MALE';
    phone?: string;
  }) {
    const [row] = await db
      .insert(patients)
      .values({
        nationalId: `12${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
        firstName: c.firstName,
        lastName: c.lastName,
        dateOfBirth: isoDaysAgo(c.ageDays),
        sex: c.sex,
        phone: c.phone ?? null,
        municipality: 'Prishtinë',
        address: 'Prishtinë',
        primaryFacilityId: facilityId,
      })
      .returning();
    await db
      .insert(careAssignments)
      .values({ patientId: row!.id, doctorId: doctor!.id, assignedById: doctor!.id });
    return row!;
  }

  // Arta's baby son: born 8 weeks ago, birth doses given, the 2-month doses become due this week.
  const ardit = await addChild({
    firstName: 'Ardit',
    lastName: 'Krasniqi',
    ageDays: 57,
    sex: 'MALE',
    phone: arta?.patientPhone ?? undefined,
  });
  await give(ardit.id, ardit.dateOfBirth, ['BCG', 'HEPB_0'], 0);
  if (arta) {
    await db.insert(guardianships).values({
      patientId: ardit.id,
      guardianUserId: arta.id,
      relationship: 'PARENT',
      scope: 'FULL',
      evidence: 'Certifikata e lindjes (kontrolluar në recepsion)',
      verifiedById: vaccinator,
      validFrom: new Date(Date.now() - 50 * DAY),
      validUntil: new Date(Date.now() + (18 * 365 - 57) * DAY),
    });
  }

  // Up to date until the 2-month doses, then missed the 12-month MMR (now overdue).
  const rina = await addChild({
    firstName: 'Rina',
    lastName: 'Morina',
    ageDays: 520,
    sex: 'FEMALE',
    phone: '+38344510222',
  });
  await give(rina.id, rina.dateOfBirth, INFANT, 5);

  // Fully up to date for his age (3 years).
  const erion = await addChild({
    firstName: 'Erion',
    lastName: 'Shala',
    ageDays: 1100,
    sex: 'MALE',
    phone: '+38349220318',
  });
  await give(erion.id, erion.dateOfBirth, [...INFANT, 'MMR_1', 'DTAP_IPV_B1'], 6);

  // School entry: second MMR and the booster are due now.
  const dea = await addChild({
    firstName: 'Dea',
    lastName: 'Gashi',
    ageDays: 2280,
    sex: 'FEMALE',
    phone: '+38345710455',
  });
  await give(dea.id, dea.dateOfBirth, [...INFANT, 'MMR_1', 'DTAP_IPV_B1'], 8);

  // Primary series complete at 9 months; MMR is next.
  const arber = await addChild({
    firstName: 'Arbër',
    lastName: 'Rexha',
    ageDays: 275,
    sex: 'MALE',
    phone: '+38344660190',
  });
  await give(arber.id, arber.dateOfBirth, INFANT, 2);
}
