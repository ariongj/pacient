import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  allergies,
  correctionRequests,
  diagnoses,
  encounterAddenda,
  encounters,
  facilities,
  careTasks,
  immunizations,
  labResults,
  medicationAdministrations,
  patients,
  prescriptions,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { notFound } from '../../lib/errors.js';
import { paginated, toOffset, type Pagination } from '../../lib/pagination.js';
import type { ClinicalAccessBasis } from '../access/policy.js';

/**
 * What the reader may see depends on *why* they have access. Patients see released results and
 * signed notes only; clinicians see the working record, including drafts and unreleased results.
 */
export interface ViewOptions {
  /** Patient-facing view: released results and signed notes only. */
  patientView: boolean;
  /** Guardian view: additionally hide confidential visits and everything recorded during them. */
  hideConfidential: boolean;
}
export const viewFor = (basis: ClinicalAccessBasis): ViewOptions => ({
  patientView: basis === 'SELF' || basis === 'GUARDIAN',
  hideConfidential: basis === 'GUARDIAN',
});
const CLINICIAN_VIEW: ViewOptions = { patientView: false, hideConfidential: false };

/** Excludes entries recorded during a visit marked confidential from guardians. */
const notConfidential = (encounterIdColumn: SQL | AnyColumn) =>
  sql`NOT EXISTS (SELECT 1 FROM encounters ce WHERE ce.id = ${encounterIdColumn} AND ce.confidential_from_guardians)`;
const scoped = (base: SQL, encounterIdColumn: AnyColumn, view: ViewOptions) =>
  view.hideConfidential ? and(base, notConfidential(encounterIdColumn))! : base;

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
      allergyAssessment: patients.allergyAssessment,
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
      verificationStatus: allergies.verificationStatus,
      source: allergies.source,
      recordedAt: allergies.recordedAt,
      recordedBy: doctorName,
    })
    .from(allergies)
    .innerJoin(users, eq(users.id, allergies.recordedById))
    .where(eq(allergies.patientId, patientId))
    .orderBy(desc(allergies.recordedAt));
}

export function listDiagnoses(patientId: string, view: ViewOptions = CLINICIAN_VIEW) {
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
    .where(scoped(eq(diagnoses.patientId, patientId), diagnoses.encounterId, view))
    .orderBy(desc(diagnoses.diagnosedAt));
}

export function listPrescriptions(patientId: string, view: ViewOptions = CLINICIAN_VIEW) {
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
      pharmacyStatus: prescriptions.pharmacyStatus,
      pharmacistNote: prescriptions.pharmacistNote,
      verifiedAt: prescriptions.verifiedAt,
      dispensedAt: prescriptions.dispensedAt,
      doctorId: prescriptions.doctorId,
      doctorName,
      createdAt: prescriptions.createdAt,
    })
    .from(prescriptions)
    .innerJoin(users, eq(users.id, prescriptions.doctorId))
    .where(scoped(eq(prescriptions.patientId, patientId), prescriptions.encounterId, view))
    .orderBy(desc(prescriptions.startDate));
}

export function listVitals(patientId: string, limit = 50, view: ViewOptions = CLINICIAN_VIEW) {
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
    .where(scoped(eq(vitalSigns.patientId, patientId), vitalSigns.encounterId, view))
    .orderBy(desc(vitalSigns.recordedAt))
    .limit(limit);
}

export function listLabResults(patientId: string, view: ViewOptions = CLINICIAN_VIEW) {
  const filters: SQL[] = [eq(labResults.patientId, patientId)];
  if (view.patientView) filters.push(isNotNull(labResults.releasedAt));
  if (view.hideConfidential) filters.push(notConfidential(labResults.encounterId));
  return db
    .select({
      id: labResults.id,
      encounterId: labResults.encounterId,
      testName: labResults.testName,
      value: labResults.value,
      unit: labResults.unit,
      referenceRange: labResults.referenceRange,
      flag: labResults.flag,
      status: labResults.status,
      collectedAt: labResults.collectedAt,
      acknowledgedAt: labResults.acknowledgedAt,
      releasedAt: labResults.releasedAt,
      orderedById: labResults.orderedById,
      orderedBy: doctorName,
    })
    .from(labResults)
    .innerJoin(users, eq(users.id, labResults.orderedById))
    .where(and(...filters))
    .orderBy(desc(labResults.collectedAt));
}

/** Encounters, newest first, each with the diagnoses and prescriptions recorded during it. */
export async function listEncounters(
  patientId: string,
  page: Pagination,
  view: ViewOptions = CLINICIAN_VIEW,
) {
  const where = view.hideConfidential
    ? and(eq(encounters.patientId, patientId), eq(encounters.confidentialFromGuardians, false))
    : eq(encounters.patientId, patientId);
  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: encounters.id,
        type: encounters.type,
        reason: encounters.reason,
        notes: encounters.notes,
        noteStatus: encounters.noteStatus,
        confidentialFromGuardians: encounters.confidentialFromGuardians,
        signedAt: encounters.signedAt,
        version: encounters.version,
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
  const [dx, rx, addenda] = ids.length
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
        db
          .select({
            id: encounterAddenda.id,
            encounterId: encounterAddenda.encounterId,
            reason: encounterAddenda.reason,
            content: encounterAddenda.content,
            createdAt: encounterAddenda.createdAt,
            authorName: users.fullName,
          })
          .from(encounterAddenda)
          .innerJoin(users, eq(users.id, encounterAddenda.authorId))
          .where(inArray(encounterAddenda.encounterId, ids))
          .orderBy(encounterAddenda.createdAt),
      ])
    : [[], [], []];

  const items = rows.map((e) => ({
    ...e,
    // Unsigned drafts are working documents and are not shown to patients.
    notes: view.patientView && e.noteStatus !== 'SIGNED' ? null : e.notes,
    diagnoses: dx.filter((d) => d.encounterId === e.id),
    prescriptions: rx.filter((p) => p.encounterId === e.id),
    addenda: addenda.filter((a) => a.encounterId === e.id),
  }));
  return paginated(items, total?.total ?? 0, page);
}

export function listImmunizations(patientId: string, view: ViewOptions = CLINICIAN_VIEW) {
  return db
    .select({
      id: immunizations.id,
      encounterId: immunizations.encounterId,
      vaccine: immunizations.vaccine,
      doseNumber: immunizations.doseNumber,
      lotNumber: immunizations.lotNumber,
      site: immunizations.site,
      administeredAt: immunizations.administeredAt,
      notes: immunizations.notes,
      administeredBy: doctorName,
      facilityName: facilities.name,
    })
    .from(immunizations)
    .innerJoin(users, eq(users.id, immunizations.administeredById))
    .innerJoin(facilities, eq(facilities.id, immunizations.facilityId))
    .where(scoped(eq(immunizations.patientId, patientId), immunizations.encounterId, view))
    .orderBy(desc(immunizations.administeredAt));
}

export function listAdministrations(patientId: string, view: ViewOptions = CLINICIAN_VIEW) {
  return db
    .select({
      id: medicationAdministrations.id,
      prescriptionId: medicationAdministrations.prescriptionId,
      medication: prescriptions.medication,
      dosage: prescriptions.dosage,
      status: medicationAdministrations.status,
      doseGiven: medicationAdministrations.doseGiven,
      reason: medicationAdministrations.reason,
      notes: medicationAdministrations.notes,
      administeredAt: medicationAdministrations.administeredAt,
      recordedBy: doctorName,
    })
    .from(medicationAdministrations)
    .innerJoin(prescriptions, eq(prescriptions.id, medicationAdministrations.prescriptionId))
    .innerJoin(users, eq(users.id, medicationAdministrations.administeredById))
    .where(
      scoped(eq(medicationAdministrations.patientId, patientId), prescriptions.encounterId, view),
    )
    .orderBy(desc(medicationAdministrations.administeredAt))
    .limit(500);
}

export function listCareTasks(patientId: string) {
  return db
    .select({
      id: careTasks.id,
      title: careTasks.title,
      details: careTasks.details,
      priority: careTasks.priority,
      status: careTasks.status,
      dueAt: careTasks.dueAt,
      assignedRole: careTasks.assignedRole,
      assignedToId: careTasks.assignedToId,
      assignedToName: sql<
        string | null
      >`(SELECT u.full_name FROM users u WHERE u.id = ${careTasks.assignedToId})`,
      createdById: careTasks.createdById,
      createdByName: doctorName,
      completedAt: careTasks.completedAt,
      completionNote: careTasks.completionNote,
      completedByName: sql<
        string | null
      >`(SELECT u.full_name FROM users u WHERE u.id = ${careTasks.completedById})`,
      createdAt: careTasks.createdAt,
    })
    .from(careTasks)
    .innerJoin(users, eq(users.id, careTasks.createdById))
    .where(eq(careTasks.patientId, patientId))
    .orderBy(sql`CASE ${careTasks.status} WHEN 'OPEN' THEN 0 ELSE 1 END`, careTasks.dueAt);
}

/** The patient summary ("chart"): everything a clinician needs at a glance. */
export async function getClinicalSummary(patientId: string, view: ViewOptions = CLINICIAN_VIEW) {
  const [
    demographics,
    allergyList,
    diagnosisList,
    prescriptionList,
    vitals,
    labs,
    recent,
    vaccines,
  ] = await Promise.all([
    getDemographics(patientId),
    listAllergies(patientId),
    listDiagnoses(patientId, view),
    listPrescriptions(patientId, view),
    listVitals(patientId, 10, view),
    listLabResults(patientId, view),
    listEncounters(patientId, { page: 1, pageSize: 5 }, view),
    listImmunizations(patientId, view),
  ]);
  const [openCorrections] = await db
    .select({ total: count() })
    .from(correctionRequests)
    .where(and(eq(correctionRequests.patientId, patientId), eq(correctionRequests.status, 'OPEN')));
  return {
    patient: demographics,
    allergies: allergyList,
    activeProblems: diagnosisList.filter((d) => d.status !== 'RESOLVED'),
    activeMedications: prescriptionList.filter((p) => p.status === 'ACTIVE'),
    latestVitals: vitals[0] ?? null,
    recentLabResults: labs.slice(0, 10),
    recentEncounters: recent.items,
    immunizations: vaccines,
    counts: {
      encounters: recent.total,
      diagnoses: diagnosisList.length,
      prescriptions: prescriptionList.length,
      labResults: labs.length,
      openCorrectionRequests: openCorrections?.total ?? 0,
    },
  };
}

/** Complete record for patient data portability (right of access / GDPR Art. 15 & 20). */
export async function exportFullRecord(patientId: string, view: ViewOptions = CLINICIAN_VIEW) {
  const [
    demographics,
    allergyList,
    diagnosisList,
    prescriptionList,
    vitals,
    labs,
    allEncounters,
    vaccines,
  ] = await Promise.all([
    getDemographics(patientId),
    listAllergies(patientId),
    listDiagnoses(patientId, view),
    listPrescriptions(patientId, view),
    listVitals(patientId, 10_000, view),
    listLabResults(patientId, view),
    listEncounters(patientId, { page: 1, pageSize: 10_000 }, view),
    listImmunizations(patientId, view),
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
    immunizations: vaccines,
  };
}

export async function assertEncounterBelongsToPatient(encounterId: string, patientId: string) {
  const [row] = await db
    .select({ id: encounters.id })
    .from(encounters)
    .where(and(eq(encounters.id, encounterId), eq(encounters.patientId, patientId)));
  if (!row) throw notFound('Encounter not found for this patient');
}
