/**
 * Radiology demo data (development seed only): a radiologist, the radiology unit's staff and a
 * handful of examinations in every state. Runs after seedHospital, which creates the units.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { hashPassword } from '../lib/password.js';
import { newAccessionNumber } from '../modules/imaging/imaging.service.js';
import { demoStudyUid, pacsConfig } from '../modules/pacs/index.js';
import { db } from './client.js';
import {
  admissions,
  careAssignments,
  careUnits,
  edVisits,
  imagingOrders,
  patients,
  unitStaff,
  users,
} from './schema.js';

/** Same demo password as every other seeded account (see seed.ts). */
const DEMO_PASSWORD = 'Pacient-Demo-2026';
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

export async function seedImaging({
  facilityId,
  demoDoctorId,
  demoPatientId,
}: {
  facilityId: string;
  demoDoctorId: string;
  demoPatientId: string;
}) {
  // The radiology unit (created by seedHospital; created here if that seed did not).
  let [unit] = await db
    .select()
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.type, 'RADIOLOGY')))
    .limit(1);
  if (!unit) {
    [unit] = await db
      .insert(careUnits)
      .values({ facilityId, name: 'Radiologjia', code: 'RAD', type: 'RADIOLOGY' })
      .returning();
  }

  const [radiologist] = await db
    .insert(users)
    .values({
      email: 'radiologist@pacient.local',
      fullName: 'Dr. Arben Krasniqi',
      role: 'DOCTOR',
      facilityId,
      specialty: 'Radiologji',
      licenseNumber: 'KMC-20901',
      passwordHash: await hashPassword(DEMO_PASSWORD),
      passwordChangedAt: new Date(),
    })
    .returning();
  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  await db
    .insert(unitStaff)
    .values(
      [radiologist!.id, nurse?.id]
        .filter((id): id is string => Boolean(id))
        .map((userId) => ({ unitId: unit!.id, userId })),
    )
    .onConflictDoNothing();

  // Another patient of the demo doctor for the critical finding.
  const [other] = await db
    .select({ id: patients.id })
    .from(careAssignments)
    .innerJoin(patients, eq(patients.id, careAssignments.patientId))
    .where(
      and(
        eq(careAssignments.doctorId, demoDoctorId),
        ne(patients.id, demoPatientId),
        sql`${patients.mergedIntoId} IS NULL`,
        sql`${patients.temporaryIdentity} IS NULL`,
      ),
    )
    .limit(1);
  // A patient currently in hospital or in the emergency department, if those seeds created one.
  const [inHospital] = await db
    .select({ patientId: admissions.patientId, admissionId: admissions.id })
    .from(admissions)
    .where(and(eq(admissions.facilityId, facilityId), eq(admissions.status, 'ADMITTED')))
    .limit(1);
  const [inEd] = await db
    .select({ patientId: edVisits.patientId, edVisitId: edVisits.id })
    .from(edVisits)
    .where(
      and(
        eq(edVisits.facilityId, facilityId),
        inArray(edVisits.status, ['WAITING', 'IN_TREATMENT']),
      ),
    )
    .limit(1);

  const base = { facilityId, orderedById: demoDoctorId };
  const rows: (typeof imagingOrders.$inferInsert)[] = [
    {
      ...base,
      accessionNumber: newAccessionNumber(ago(240)),
      patientId: demoPatientId,
      modality: 'XRAY',
      bodyPart: 'Toraksi (PA dhe lateral)',
      clinicalQuestion: 'Kollë e zgjatur prej 3 javësh, pa temperaturë. Përjashtim i pneumonisë.',
      priority: 'ROUTINE',
      safetyChecks: { pregnancy: 'NO' },
      status: 'REPORTED',
      scheduledAt: ago(220),
      performedAt: ago(218),
      performedById: nurse?.id ?? null,
      findings:
        'Fushat pulmonare të pastra, pa infiltrate apo efuzion pleural. Hijet hilare normale. Zemra me madhësi normale. Strukturat kockore pa ndryshime.',
      impression: 'Radiografi normale e toraksit.',
      reportedById: radiologist!.id,
      reportedAt: ago(216),
      acknowledgedById: demoDoctorId,
      acknowledgedAt: ago(200),
      releasedAt: ago(199),
      createdAt: ago(240),
    },
    {
      ...base,
      accessionNumber: newAccessionNumber(),
      patientId: demoPatientId,
      modality: 'ULTRASOUND',
      bodyPart: 'Abdomeni',
      clinicalQuestion: 'Dhimbje në hipokondrin e djathtë pas ushqimit. Kalkulozë biliare?',
      priority: 'ROUTINE',
      safetyChecks: {},
      status: 'ORDERED',
      createdAt: ago(2),
    },
  ];
  const urgent = inEd ?? inHospital;
  if (urgent) {
    rows.push({
      ...base,
      accessionNumber: newAccessionNumber(),
      patientId: urgent.patientId,
      admissionId: 'admissionId' in urgent ? urgent.admissionId : null,
      edVisitId: 'edVisitId' in urgent ? urgent.edVisitId : null,
      modality: 'CT',
      bodyPart: 'Koka (pa kontrast)',
      clinicalQuestion:
        'Rënie me goditje në kokë, të vjella dhe përgjumje. Hemorragji intrakraniale?',
      priority: 'STAT',
      safetyChecks: { pregnancy: 'NO', contrast: false },
      status: 'PERFORMED',
      performedAt: ago(0.5),
      performedById: nurse?.id ?? null,
      createdAt: ago(1),
    });
  }
  if (other) {
    rows.push({
      ...base,
      accessionNumber: newAccessionNumber(),
      patientId: other.id,
      modality: 'CT',
      bodyPart: 'Toraksi (me kontrast, angiografi pulmonare)',
      clinicalQuestion: 'Dispne e papritur dhe takikardi pas operacionit. Embolizëm pulmonar?',
      priority: 'URGENT',
      safetyChecks: {
        pregnancy: 'NO',
        contrast: true,
        contrastAllergy: 'NO',
        renalImpairment: 'NO',
      },
      status: 'REPORTED',
      performedAt: ago(4),
      performedById: nurse?.id ?? null,
      findings:
        'Defekte mbushjeje në arterien pulmonare të djathtë dhe në degët lobare të poshtme bilateralisht. Pa shenja të infarktit pulmonar. Raporti VD/VM 1,1.',
      impression: 'Embolizëm pulmonar bilateral. Njoftuar mjeku që e kërkoi.',
      critical: true,
      reportedById: radiologist!.id,
      reportedAt: ago(3),
      createdAt: ago(5),
    });
  }
  // With the built-in demo archive, performed examinations get synthetic images to view.
  if (pacsConfig().mode === 'demo') {
    for (const r of rows) {
      if ((r.status === 'PERFORMED' || r.status === 'REPORTED') && r.performedAt) {
        r.studyInstanceUid = demoStudyUid(r.accessionNumber);
        r.imagesAvailableAt = r.performedAt;
      }
    }
  }
  await db.insert(imagingOrders).values(rows);
}
