import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  allergies,
  diagnoses,
  encounters,
  facilities,
  labResults,
  patients,
  prescriptions,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { paginated, toOffset, type Pagination } from '../../lib/pagination.js';

const doctorName = users.fullName;

export async function getDemographics(patientId: string) {
  const [row] = await db
    .select({
      id: patients.id,
      nationalId: patients.nationalId,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      bloodType: patients.bloodType,
      phone: patients.phone,
      email: patients.email,
      address: patients.address,
      municipality: patients.municipality,
      emergencyContactName: patients.emergencyContactName,
      emergencyContactPhone: patients.emergencyContactPhone,
      primaryFacilityId: patients.primaryFacilityId,
      primaryFacilityName: facilities.name,
    })
    .from(patients)
    .innerJoin(facilities, eq(facilities.id, patients.primaryFacilityId))
    .where(eq(patients.id, patientId));
  if (!row) throw notFound('Patient not found');
  return row;
}

export function listAllergies(patientId: string) {
  return db
    .select({
      id: allergies.id,
      substance: allergies.substance,
      reaction: allergies.reaction,
      severity: allergies.severity,
      recordedAt: allergies.recordedAt,
      recordedBy: doctorName,
    })
    .from(allergies)
    .innerJoin(users, eq(users.id, allergies.recordedById))
    .where(eq(allergies.patientId, patientId))
    .orderBy(desc(allergies.recordedAt));
}

export function listDiagnoses(patientId: string) {
  return db
    .select({
      id: diagnoses.id,
      encounterId: diagnoses.encounterId,
      icd10Code: diagnoses.icd10Code,
      description: diagnoses.description,
      status: diagnoses.status,
      diagnosedAt: diagnoses.diagnosedAt,
      resolvedAt: diagnoses.resolvedAt,
      notes: diagnoses.notes,
      doctorId: diagnoses.doctorId,
      doctorName,
    })
    .from(diagnoses)
    .innerJoin(users, eq(users.id, diagnoses.doctorId))
    .where(eq(diagnoses.patientId, patientId))
    .orderBy(desc(diagnoses.diagnosedAt));
}

export function listPrescriptions(patientId: string) {
  return db
    .select({
      id: prescriptions.id,
      encounterId: prescriptions.encounterId,
      medication: prescriptions.medication,
      dosage: prescriptions.dosage,
      frequency: prescriptions.frequency,
      route: prescriptions.route,
      instructions: prescriptions.instructions,
      startDate: prescriptions.startDate,
      endDate: prescriptions.endDate,
      status: prescriptions.status,
      doctorId: prescriptions.doctorId,
      doctorName,
      createdAt: prescriptions.createdAt,
    })
    .from(prescriptions)
    .innerJoin(users, eq(users.id, prescriptions.doctorId))
    .where(eq(prescriptions.patientId, patientId))
    .orderBy(desc(prescriptions.startDate));
}

export function listVitals(patientId: string, limit = 50) {
  return db
    .select({
      id: vitalSigns.id,
      encounterId: vitalSigns.encounterId,
      systolic: vitalSigns.systolic,
      diastolic: vitalSigns.diastolic,
      heartRate: vitalSigns.heartRate,
      temperatureC: vitalSigns.temperatureC,
      respiratoryRate: vitalSigns.respiratoryRate,
      oxygenSaturation: vitalSigns.oxygenSaturation,
      weightKg: vitalSigns.weightKg,
      heightCm: vitalSigns.heightCm,
      recordedAt: vitalSigns.recordedAt,
      recordedBy: doctorName,
    })
    .from(vitalSigns)
    .innerJoin(users, eq(users.id, vitalSigns.recordedById))
    .where(eq(vitalSigns.patientId, patientId))
    .orderBy(desc(vitalSigns.recordedAt))
    .limit(limit);
}

export function listLabResults(patientId: string) {
  return db
    .select({
      id: labResults.id,
      encounterId: labResults.encounterId,
      testName: labResults.testName,
      value: labResults.value,
      unit: labResults.unit,
      referenceRange: labResults.referenceRange,
      flag: labResults.flag,
      collectedAt: labResults.collectedAt,
      orderedBy: doctorName,
    })
    .from(labResults)
    .innerJoin(users, eq(users.id, labResults.orderedById))
    .where(eq(labResults.patientId, patientId))
    .orderBy(desc(labResults.collectedAt));
}

/** Encounters, newest first, each with the diagnoses and prescriptions recorded during it. */
export async function listEncounters(patientId: string, page: Pagination) {
  const where = eq(encounters.patientId, patientId);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: encounters.id,
        type: encounters.type,
        reason: encounters.reason,
        notes: encounters.notes,
        startedAt: encounters.startedAt,
        endedAt: encounters.endedAt,
        doctorId: encounters.doctorId,
        doctorName,
        doctorSpecialty: users.specialty,
        facilityId: encounters.facilityId,
        facilityName: facilities.name,
      })
      .from(encounters)
      .innerJoin(users, eq(users.id, encounters.doctorId))
      .innerJoin(facilities, eq(facilities.id, encounters.facilityId))
      .where(where)
      .orderBy(desc(encounters.startedAt))
      .limit(toOffset(page).limit)
      .offset(toOffset(page).offset),
    db.select({ total: count() }).from(encounters).where(where),
  ]);

  const ids = rows.map((r) => r.id);
  const [dx, rx] = ids.length
    ? await Promise.all([
        db
          .select({
            id: diagnoses.id,
            encounterId: diagnoses.encounterId,
            icd10Code: diagnoses.icd10Code,
            description: diagnoses.description,
            status: diagnoses.status,
          })
          .from(diagnoses)
          .where(inArray(diagnoses.encounterId, ids)),
        db
          .select({
            id: prescriptions.id,
            encounterId: prescriptions.encounterId,
            medication: prescriptions.medication,
            dosage: prescriptions.dosage,
            frequency: prescriptions.frequency,
            status: prescriptions.status,
          })
          .from(prescriptions)
          .where(inArray(prescriptions.encounterId, ids)),
      ])
    : [[], []];

  const items = rows.map((e) => ({
    ...e,
    diagnoses: dx.filter((d) => d.encounterId === e.id),
    prescriptions: rx.filter((p) => p.encounterId === e.id),
  }));
  return paginated(items, total?.total ?? 0, page);
}

/** The patient summary ("chart"): everything a clinician needs at a glance. */
export async function getClinicalSummary(patientId: string) {
  const [demographics, allergyList, diagnosisList, prescriptionList, vitals, labs, recent] =
    await Promise.all([
      getDemographics(patientId),
      listAllergies(patientId),
      listDiagnoses(patientId),
      listPrescriptions(patientId),
      listVitals(patientId, 10),
      listLabResults(patientId),
      listEncounters(patientId, { page: 1, pageSize: 5 }),
    ]);
  return {
    patient: demographics,
    allergies: allergyList,
    activeProblems: diagnosisList.filter((d) => d.status !== 'RESOLVED'),
    activeMedications: prescriptionList.filter((p) => p.status === 'ACTIVE'),
    latestVitals: vitals[0] ?? null,
    recentLabResults: labs.slice(0, 10),
    recentEncounters: recent.items,
    counts: {
      encounters: recent.total,
      diagnoses: diagnosisList.length,
      prescriptions: prescriptionList.length,
      labResults: labs.length,
    },
  };
}

/** Complete record for patient data portability (right of access / GDPR Art. 15 & 20). */
export async function exportFullRecord(patientId: string) {
  const [demographics, allergyList, diagnosisList, prescriptionList, vitals, labs, allEncounters] =
    await Promise.all([
      getDemographics(patientId),
      listAllergies(patientId),
      listDiagnoses(patientId),
      listPrescriptions(patientId),
      listVitals(patientId, 10_000),
      listLabResults(patientId),
      listEncounters(patientId, { page: 1, pageSize: 10_000 }),
    ]);
  return {
    exportedAt: new Date().toISOString(),
    format: 'pacient-record/v1',
    patient: demographics,
    allergies: allergyList,
    diagnoses: diagnosisList,
    prescriptions: prescriptionList,
    vitalSigns: vitals,
    labResults: labs,
    encounters: allEncounters.items,
  };
}

export async function assertEncounterBelongsToPatient(encounterId: string, patientId: string) {
  const [row] = await db
    .select({ id: encounters.id })
    .from(encounters)
    .where(and(eq(encounters.id, encounterId), eq(encounters.patientId, patientId)));
  if (!row) throw notFound('Encounter not found for this patient');
}
