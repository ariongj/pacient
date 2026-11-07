import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  admissions,
  advanceDirectives,
  careAssignments,
  organDonationDecisions,
  patients,
  users,
} from './schema.js';
import { kosovoDate } from '../modules/identity/identity.service.js';

const DAY = 86_400_000;

/** Deterministic pseudo-random number in [0, 1) from a uuid (stable across seeds). */
function hash01(id: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
}

/**
 * Synthetic demo data (development seed only):
 * - organ donation decisions for about 40% of living adults, some changed over time, recorded in
 *   the portal by people with an account and in person (by reception) otherwise; the demo patient
 *   changed from "not a donor" to donating some organs, and named her husband as healthcare proxy;
 * - for the oldest patients in the demo doctor's care (inpatients first): two DNACPR decisions,
 *   one of them past its review date, and one treatment escalation plan (ceiling of care).
 */
export async function seedDirectives({
  facilityId,
  demoDoctorId,
}: {
  facilityId: string;
  demoDoctorId: string;
}): Promise<void> {
  const now = Date.now();
  const today = kosovoDate(new Date());
  const adultBorn = kosovoDate(new Date(now - 18 * 365.25 * DAY));
  const [reception] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, 'RECEPTION'), eq(users.facilityId, facilityId)))
    .limit(1);
  const [demo] = await db
    .select({ id: patients.id, userId: patients.userId })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(eq(users.email, 'patient@pacient.local'));

  /* ------------------------------------------------------------ organ donation decisions */
  const adults = await db
    .select({ id: patients.id, userId: patients.userId })
    .from(patients)
    .where(
      and(
        lte(patients.dateOfBirth, adultBorn),
        isNull(patients.deceasedAt),
        isNull(patients.mergedIntoId),
      ),
    )
    .orderBy(asc(patients.id));
  const rows: (typeof organDonationDecisions.$inferInsert)[] = [];
  const recorder = (p: { userId: string | null }) =>
    p.userId
      ? { recordedVia: 'PORTAL', recordedByUserId: p.userId }
      : reception
        ? { recordedVia: 'IN_PERSON', recordedByUserId: reception.id }
        : null;
  for (const p of adults) {
    if (demo && p.id === demo.id) continue;
    if (hash01(p.id) >= 0.4) continue;
    const who = recorder(p);
    if (!who) continue;
    const r = hash01(p.id, 7);
    const decision = r < 0.55 ? 'DONOR' : r < 0.8 ? 'DONOR_SOME' : 'NOT_DONOR';
    const organs =
      decision === 'DONOR_SOME'
        ? r < 0.7
          ? ['KIDNEYS', 'CORNEAS']
          : ['KIDNEYS', 'LIVER', 'TISSUE']
        : null;
    const daysAgo = 20 + Math.floor(hash01(p.id, 3) * 700);
    // About one in five changed their mind once.
    if (hash01(p.id, 11) < 0.2) {
      rows.push({
        patientId: p.id,
        decision: decision === 'NOT_DONOR' ? 'DONOR' : 'NOT_DONOR',
        organs: null,
        familyInformed: false,
        ...who,
        createdAt: new Date(now - (daysAgo + 200) * DAY),
      });
    }
    rows.push({
      patientId: p.id,
      decision,
      organs,
      familyInformed: hash01(p.id, 5) < 0.6,
      ...who,
      createdAt: new Date(now - daysAgo * DAY),
    });
  }
  if (demo?.userId) {
    rows.push(
      {
        patientId: demo.id,
        decision: 'NOT_DONOR',
        familyInformed: false,
        recordedVia: 'PORTAL',
        recordedByUserId: demo.userId,
        createdAt: new Date(now - 700 * DAY),
      },
      {
        patientId: demo.id,
        decision: 'DONOR_SOME',
        organs: ['KIDNEYS', 'LIVER', 'CORNEAS'],
        familyInformed: true,
        faithOrBeliefNote: 'E kam diskutuar me familjen dhe imamin tonë',
        recordedVia: 'PORTAL',
        recordedByUserId: demo.userId,
        createdAt: new Date(now - 120 * DAY),
      },
    );
  }
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(organDonationDecisions).values(rows.slice(i, i + 200));
  }

  /* ------------------------------------------------------------ advance directives */
  if (demo?.userId) {
    await db.insert(advanceDirectives).values({
      patientId: demo.id,
      kind: 'HEALTHCARE_PROXY',
      summary: 'Bashkëshorti – të konsultohet nëse nuk mund të vendos vetë',
      proxyName: 'Driton Krasniqi',
      proxyPhone: '044 555 120',
      createdById: demo.userId,
      createdAt: new Date(now - 100 * DAY),
    });
  }

  // Oldest living patients in the demo doctor's care, inpatients first.
  const elderly = await db
    .select({ id: patients.id })
    .from(patients)
    .innerJoin(
      careAssignments,
      and(
        eq(careAssignments.patientId, patients.id),
        eq(careAssignments.doctorId, demoDoctorId),
        isNull(careAssignments.endedAt),
      ),
    )
    .where(
      and(
        isNull(patients.deceasedAt),
        isNull(patients.mergedIntoId),
        lte(patients.dateOfBirth, kosovoDate(new Date(now - 60 * 365.25 * DAY))),
      ),
    )
    .orderBy(
      sql`EXISTS (SELECT 1 FROM ${admissions} a WHERE a.patient_id = ${patients.id} AND a.status = 'ADMITTED') DESC`,
      asc(patients.dateOfBirth),
    )
    .limit(3);
  const plan = [
    {
      kind: 'DNACPR',
      summary:
        'Mos tento ringjalljen kardiopulmonare. Insuficiencë kardiake e avancuar; ringjallja nuk do të kishte sukses. Çdo trajtim tjetër vazhdon.',
      discussedWith: 'Pacienti dhe familja, në repart',
      reviewDays: 60,
      createdDaysAgo: 5,
    },
    {
      kind: 'DNACPR',
      summary:
        'Mos tento ringjalljen kardiopulmonare, me dëshirën e pacientit pas bisedës për prognozën.',
      discussedWith: 'Pacienti (me aftësi vendimmarrëse) dhe familja',
      reviewDays: -10,
      createdDaysAgo: 190,
    },
    {
      kind: 'TREATMENT_ESCALATION',
      summary:
        'Kujdes në repart me antibiotikë, oksigjen dhe lëngje; jo për kujdes intensiv ose ventilim. Lajmëroni mjekun kujdestar nëse NEWS2 është 5 ose më shumë.',
      discussedWith: 'Pacienti dhe bashkëshorti/bashkëshortja',
      reviewDays: 30,
      createdDaysAgo: 3,
    },
  ] as const;
  for (const [i, p] of elderly.entries()) {
    const d = plan[i]!;
    await db.insert(advanceDirectives).values({
      patientId: p.id,
      kind: d.kind,
      summary: d.summary,
      discussedWith: d.discussedWith,
      reviewDate: kosovoDate(new Date(Date.parse(`${today}T12:00:00Z`) + d.reviewDays * DAY)),
      facilityId,
      createdById: demoDoctorId,
      createdAt: new Date(now - d.createdDaysAgo * DAY),
    });
  }
}
