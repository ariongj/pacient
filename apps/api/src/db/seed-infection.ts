import { and, asc, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  admissions,
  antimicrobialApprovals,
  careAssignments,
  careUnits,
  haiEvents,
  isolationOrders,
  labResults,
  patients,
  prescriptions,
  unitStaff,
  users,
} from './schema.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * Synthetic demo data for infection prevention (development only): an infection control unit with
 * doctor@ as a member, isolated inpatients, healthcare-associated infections over the past months,
 * restricted antibiotics in every stewardship state and one positive culture to review.
 */
export async function seedInfection(opts: { facilityId: string; demoDoctorId: string }) {
  const { facilityId, demoDoctorId } = opts;
  const [unit] = await db
    .insert(careUnits)
    .values({
      facilityId,
      name: 'Njësia e kontrollit të infeksioneve',
      code: 'KI',
      type: 'INFECTION_CONTROL',
    })
    .returning();
  await db.insert(unitStaff).values({ unitId: unit!.id, userId: demoDoctorId });
  const [pharmacist] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'pharmacist@pacient.local'));

  // Current inpatients (living, not newborn rooming-in) in the demo doctor's care first.
  const current = await db
    .select({
      admissionId: admissions.id,
      patientId: admissions.patientId,
      unitId: admissions.unitId,
      admittedAt: admissions.admittedAt,
      inCare: sql<boolean>`EXISTS (SELECT 1 FROM ${careAssignments} ca WHERE ca.patient_id = ${admissions.patientId}
        AND ca.doctor_id = ${demoDoctorId} AND ca.ended_at IS NULL)`,
    })
    .from(admissions)
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .where(
      and(
        eq(admissions.facilityId, facilityId),
        eq(admissions.status, 'ADMITTED'),
        isNull(patients.deceasedAt),
        sql`${careUnits.type} IN ('GENERAL_WARD', 'SURGICAL_WARD', 'ICU')`,
      ),
    )
    .orderBy(asc(admissions.admittedAt));
  const inCare = current.filter((c) => c.inCare);
  const pick = (i: number) => inCare[i] ?? current[i];
  const now = Date.now();

  // Isolation: MRSA (contact) and suspected TB (airborne).
  const iso = [
    { at: pick(0), precaution: 'CONTACT', reason: 'MRSA (ekzaminim në pranim)' },
    { at: pick(1), precaution: 'AIRBORNE', reason: 'Dyshim për TBC pulmonare' },
  ] as const;
  for (const i of iso) {
    if (!i.at) continue;
    await db.insert(isolationOrders).values({
      patientId: i.at.patientId,
      facilityId,
      precaution: i.precaution,
      reason: i.reason,
      orderedById: demoDoctorId,
      startedAt: new Date(Math.max(i.at.admittedAt.getTime() + 6 * HOUR, now - 2 * DAY)),
    });
  }
  // An ended isolation (history).
  if (pick(0)) {
    await db.insert(isolationOrders).values({
      patientId: pick(0)!.patientId,
      facilityId,
      precaution: 'DROPLET',
      reason: 'Grip (influenca A)',
      orderedById: demoDoctorId,
      startedAt: new Date(now - 40 * DAY),
      endedAt: new Date(now - 35 * DAY),
      endedById: demoDoctorId,
      endReason: '5 ditë pas fillimit të simptomave, pa ethe',
    });
  }

  // Healthcare-associated infections during stays of the last six months.
  const stays = await db
    .select({
      id: admissions.id,
      patientId: admissions.patientId,
      unitId: admissions.unitId,
      admittedAt: admissions.admittedAt,
      dischargedAt: admissions.dischargedAt,
    })
    .from(admissions)
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .where(
      and(
        eq(admissions.facilityId, facilityId),
        gte(admissions.admittedAt, new Date(now - 300 * DAY)),
        sql`${careUnits.type} IN ('GENERAL_WARD', 'SURGICAL_WARD', 'ICU')`,
        sql`coalesce(${admissions.dischargedAt}, now()) - ${admissions.admittedAt} > interval '2 days'`,
      ),
    )
    .orderBy(desc(admissions.admittedAt))
    .limit(12);
  const hai = [
    { type: 'CAUTI', organism: 'Escherichia coli', device: true, status: 'CONFIRMED' },
    { type: 'SSI', organism: 'Staphylococcus aureus', device: false, status: 'CONFIRMED' },
    { type: 'CLABSI', organism: 'Klebsiella pneumoniae (ESBL)', device: true, status: 'CONFIRMED' },
    { type: 'CDI', organism: 'Clostridioides difficile', device: false, status: 'CONFIRMED' },
    { type: 'VAP', organism: 'Pseudomonas aeruginosa', device: true, status: 'SUSPECTED' },
    { type: 'CAUTI', organism: null, device: true, status: 'RULED_OUT' },
    { type: 'MRSA_BACTERAEMIA', organism: 'MRSA', device: false, status: 'CONFIRMED' },
    { type: 'OTHER', organism: 'Candida albicans', device: false, status: 'SUSPECTED' },
  ] as const;
  for (const [i, h] of hai.entries()) {
    const stay = stays[i];
    if (!stay) break;
    const end = stay.dischargedAt?.getTime() ?? now;
    const onset = new Date(Math.min(stay.admittedAt.getTime() + (3 + (i % 3)) * DAY, end - HOUR));
    const reviewed = h.status !== 'SUSPECTED';
    await db.insert(haiEvents).values({
      patientId: stay.patientId,
      facilityId,
      admissionId: stay.id,
      unitId: stay.unitId,
      type: h.type,
      organism: h.organism,
      onsetAt: onset,
      deviceRelated: h.device,
      status: h.status,
      notes: h.status === 'RULED_OUT' ? 'Kolonizim, pa shenja infeksioni' : null,
      reportedById: demoDoctorId,
      reviewedById: reviewed ? demoDoctorId : null,
      reviewedAt: reviewed ? new Date(onset.getTime() + DAY) : null,
      createdAt: onset,
    });
  }

  // Restricted antibiotics: awaiting approval, approved with an overdue review, reviewed.
  const today = new Date().toISOString().slice(0, 10);
  const rx = [
    {
      at: pick(0),
      medication: 'Meropenem 1 g',
      frequency: 'çdo 8 orë',
      indication: 'Pneumoni nozokomiale',
      justification: 'Pa përgjigje ndaj piperacilinë-tazobaktamit pas 72 orësh; kultura në pritje',
      startedHoursAgo: 6,
      state: 'REQUESTED',
    },
    {
      at: pick(1) ?? pick(0),
      medication: 'Vankomicinë 1 g',
      frequency: 'çdo 12 orë',
      indication: 'Bakteriemi me MRSA',
      justification: 'Hemokulturë pozitive për MRSA, e ndjeshme ndaj vankomicinës',
      startedHoursAgo: 96,
      state: 'APPROVED',
    },
    {
      at: pick(2) ?? pick(0),
      medication: 'Kolistinë 2 MIU',
      frequency: 'çdo 8 orë',
      indication: 'Infeksion urinar me Klebsiella rezistente ndaj karbapenemeve',
      justification: 'Urokulturë: Klebsiella pneumoniae KPC, e ndjeshme vetëm ndaj kolistinës',
      startedHoursAgo: 120,
      state: 'REVIEWED',
    },
  ] as const;
  for (const r of rx) {
    if (!r.at) continue;
    const created = new Date(now - r.startedHoursAgo * HOUR);
    const [p] = await db
      .insert(prescriptions)
      .values({
        patientId: r.at.patientId,
        doctorId: demoDoctorId,
        medication: r.medication,
        dosage: r.medication.split(' ').slice(1).join(' '),
        frequency: r.frequency,
        route: 'intravenous',
        startDate: today,
        pharmacyStatus: 'VERIFIED',
        createdAt: created,
      })
      .returning();
    await db.insert(antimicrobialApprovals).values({
      prescriptionId: p!.id,
      patientId: r.at.patientId,
      facilityId,
      indication: r.indication,
      justification: r.justification,
      status: r.state === 'REQUESTED' ? 'REQUESTED' : 'APPROVED',
      requestedById: demoDoctorId,
      decidedById: r.state === 'REQUESTED' ? null : (pharmacist?.id ?? null),
      decidedAt: r.state === 'REQUESTED' ? null : new Date(created.getTime() + 2 * HOUR),
      reviewDueAt: new Date(created.getTime() + 72 * HOUR),
      reviewedAt: r.state === 'REVIEWED' ? new Date(created.getTime() + 70 * HOUR) : null,
      reviewOutcome: r.state === 'REVIEWED' ? 'NARROW' : null,
      createdAt: created,
    });
  }

  // A positive culture more than 48 hours after admission, not yet reviewed by infection control.
  const cultureStay = current.find((c) => c.admittedAt.getTime() < now - 3 * DAY) ?? null;
  if (cultureStay) {
    await db.insert(labResults).values({
      patientId: cultureStay.patientId,
      orderedById: demoDoctorId,
      testName: 'Hemokultura',
      value: 'Pseudomonas aeruginosa',
      flag: 'CRITICAL',
      collectedAt: new Date(cultureStay.admittedAt.getTime() + 60 * HOUR),
    });
  }
}
