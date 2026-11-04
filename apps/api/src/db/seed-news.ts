/**
 * Demo data for NEWS2 (development seed only): observations of the current inpatients over the last
 * 24 hours, scored through the real scoring and escalation code so the early-warning board shows a
 * deteriorating (septic) patient, an urgent review, a single "red" parameter and an overdue set.
 */
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { db } from './client.js';
import { admissions, users, vitalSigns } from './schema.js';
import { scoreVitalSign } from '../modules/news/news.service.js';

type Obs = {
  hoursAgo: number;
  rr: number;
  spo2: number;
  o2: boolean;
  sbp: number;
  dbp: number;
  hr: number;
  acvpu: 'A' | 'C' | 'V' | 'P' | 'U';
  temp: number;
  pain?: number;
};

const normal = (hoursAgo: number, over: Partial<Obs> = {}): Obs => ({
  hoursAgo,
  rr: 16,
  spo2: 97,
  o2: false,
  sbp: 124,
  dbp: 78,
  hr: 76,
  acvpu: 'A',
  temp: 36.8,
  ...over,
});

/** Observation series per inpatient, oldest first. */
const PROFILES: Obs[][] = [
  // Sepsis developing over the day: LOW → MEDIUM → HIGH.
  [
    normal(22, { hr: 92, temp: 37.9 }),
    normal(8, { rr: 22, hr: 108, temp: 38.6, sbp: 106, spo2: 95 }),
    normal(0.5, { rr: 26, spo2: 93, sbp: 92, dbp: 54, hr: 124, temp: 39.3, pain: 6 }),
  ],
  // On oxygen with tachycardia and tachypnoea: urgent review (MEDIUM).
  [
    normal(14, { spo2: 95, hr: 96 }),
    normal(1, { rr: 22, spo2: 94, o2: true, hr: 108, temp: 37.6 }),
  ],
  // New confusion, everything else normal: a single parameter scoring 3.
  [normal(10), normal(0.7, { acvpu: 'C' })],
  // Low score but the last set is 7 hours old: observations overdue.
  [normal(13, { hr: 94 }), normal(7, { hr: 95, temp: 38.2 })],
];

export async function seedNews({ facilityId }: { facilityId: string }) {
  const stays = await db
    .select({ id: admissions.id, patientId: admissions.patientId })
    .from(admissions)
    .where(
      and(
        eq(admissions.facilityId, facilityId),
        eq(admissions.status, 'ADMITTED'),
        isNotNull(admissions.bedId),
      ),
    )
    .orderBy(asc(admissions.admittedAt));
  if (!stays.length) return;
  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.facilityId, facilityId), eq(users.role, 'NURSE')))
    .limit(1);
  if (!nurse) return;

  for (const [i, stay] of stays.entries()) {
    const series = PROFILES[i] ?? [normal(9), normal(2.5, { hr: 80 })];
    for (const o of series) {
      const [v] = await db
        .insert(vitalSigns)
        .values({
          patientId: stay.patientId,
          recordedById: nurse.id,
          respiratoryRate: o.rr,
          oxygenSaturation: o.spo2,
          onSupplementalOxygen: o.o2,
          systolic: o.sbp,
          diastolic: o.dbp,
          heartRate: o.hr,
          consciousness: o.acvpu,
          temperatureC: o.temp.toFixed(1),
          painScore: o.pain ?? null,
          recordedAt: new Date(Date.now() - o.hoursAgo * 3_600_000),
        })
        .returning({ id: vitalSigns.id });
      await scoreVitalSign(v!.id);
    }
  }
}
