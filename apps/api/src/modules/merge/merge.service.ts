import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { patientMerges, patients } from '../../db/schema.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';

/**
 * Every table whose rows belong to a patient (column `patient_id`). A merge re-points them from
 * the duplicate to the surviving record; an unmerge moves exactly those rows back.
 *
 * Keep this list complete: a test compares it with the database's foreign keys, so a new table
 * that references patients cannot be forgotten. Deliberately excluded:
 *  - audit_logs – the audit trail is never rewritten; merge lineage explains its history;
 *  - patient_merges and patients.merged_into_id – the lineage itself.
 */
export const PATIENT_TABLES = [
  'admissions',
  'advance_directives',
  'allergies',
  'antenatal_visits',
  'antimicrobial_approvals',
  'appointments',
  'blood_donations',
  'blood_donors',
  'blood_group_tests',
  'cancer_cases',
  'care_assignments',
  'care_process_records',
  'care_tasks',
  'case_reports',
  'charges',
  'community_dispensings',
  'complaints',
  'consent_records',
  'correction_requests',
  'data_subject_requests',
  'death_record_amendments',
  'death_records',
  'diagnoses',
  'dialysis_schedules',
  'dialysis_sessions',
  'diet_orders',
  'early_warning_scores',
  'ed_visits',
  'emergency_access_grants',
  'ems_care_records',
  'ems_incidents',
  'encounter_addenda',
  'encounters',
  'guardianships',
  'hai_events',
  'home_care_episodes',
  'home_readings',
  'home_visits',
  'imaging_orders',
  'immunization_reminders',
  'immunizations',
  'insurance_coverages',
  'integration_messages',
  'involuntary_admissions',
  'isolation_orders',
  'lab_orders',
  'lab_results',
  'legal_holds',
  'mdt_case_reviews',
  'medical_certificates',
  'medication_administrations',
  'message_threads',
  'monitoring_plans',
  'nutrition_screenings',
  'organ_donation_decisions',
  'patient_documents',
  'payments',
  'pregnancies',
  'prom_assignments',
  'prom_responses',
  'prescription_alerts',
  'prescriptions',
  'referrals',
  'register_enrolments',
  'restrictive_interventions',
  'safety_incidents',
  'screening_episodes',
  'screening_opt_outs',
  'sepsis_screens',
  'surgical_cases',
  'transfusion_requests',
  'transfusions',
  'vital_signs',
  'waiting_list_entries',
  'waiting_list_events',
] as const;
export type PatientTable = (typeof PATIENT_TABLES)[number];

/**
 * Patient references in columns other than `patient_id` (table.column). They move like the
 * tables above and are recorded in movedRows under the same "table.column" key.
 */
export const OTHER_PATIENT_COLUMNS = [
  'births.mother_patient_id',
  'births.newborn_patient_id',
] as const;

/** Tables/columns that intentionally reference patients but are not moved. */
export const EXCLUDED_REFERENCES = [
  'patient_merges.survivor_id',
  'patient_merges.merged_id',
  'patients.merged_into_id',
];

/** Human labels for the counts shown to the director (no clinical content, counts only). */
export const SECTION_LABELS: Record<PatientTable, string> = {
  blood_donations: 'Blood donations',
  prom_assignments: 'Questionnaires assigned',
  prom_responses: 'Questionnaire answers',
  blood_donors: 'Blood donor record',
  cancer_cases: 'Cancer registry',
  dialysis_schedules: 'Dialysis schedule',
  dialysis_sessions: 'Dialysis sessions',
  home_readings: 'Home readings',
  involuntary_admissions: 'Involuntary admissions',
  mdt_case_reviews: 'Tumour board reviews',
  monitoring_plans: 'Home monitoring',
  restrictive_interventions: 'Restrictive interventions',
  antimicrobial_approvals: 'Restricted antibiotic approvals',
  ems_care_records: 'Ambulance care records',
  ems_incidents: 'Ambulance calls',
  hai_events: 'Healthcare-associated infections',
  home_care_episodes: 'Home care',
  home_visits: 'Home visits',
  isolation_orders: 'Isolation precautions',
  sepsis_screens: 'Sepsis screens',
  advance_directives: 'Advance directives',
  antenatal_visits: 'Antenatal visits',
  community_dispensings: 'Community pharmacy dispensings',
  complaints: 'Complaints',
  organ_donation_decisions: 'Organ donation decisions',
  pregnancies: 'Pregnancies',
  screening_episodes: 'Cancer screening',
  screening_opt_outs: 'Screening opt-outs',
  care_process_records: 'Chronic care reviews',
  death_record_amendments: 'Death certificate amendments',
  death_records: 'Death certificate',
  medical_certificates: 'Medical certificates',
  register_enrolments: 'Disease registers',
  safety_incidents: 'Safety incident reports',
  waiting_list_entries: 'Waiting lists',
  waiting_list_events: 'Waiting list history',
  data_subject_requests: 'Data protection requests',
  legal_holds: 'Legal holds',
  prescription_alerts: 'Medication safety alerts',
  blood_group_tests: 'Blood group results',
  transfusion_requests: 'Transfusion requests',
  transfusions: 'Transfusions',
  diet_orders: 'Diet orders',
  nutrition_screenings: 'Nutrition screenings',
  insurance_coverages: 'Insurance',
  charges: 'Charges',
  payments: 'Payments',
  early_warning_scores: 'Early warning scores',
  case_reports: 'Notifiable disease reports',
  admissions: 'Hospital stays',
  allergies: 'Allergies',
  appointments: 'Appointments',
  care_assignments: 'Care team',
  care_tasks: 'Care tasks',
  consent_records: 'Consent records',
  correction_requests: 'Correction requests',
  diagnoses: 'Diagnoses',
  ed_visits: 'Emergency visits',
  emergency_access_grants: 'Emergency access grants',
  encounter_addenda: 'Note addenda',
  encounters: 'Visits',
  guardianships: 'Guardians',
  imaging_orders: 'Imaging',
  immunization_reminders: 'Vaccination reminders',
  immunizations: 'Vaccinations',
  integration_messages: 'Laboratory messages',
  lab_orders: 'Laboratory orders',
  lab_results: 'Laboratory results',
  medication_administrations: 'Medication administrations',
  message_threads: 'Message threads',
  patient_documents: 'Documents',
  prescriptions: 'Prescriptions',
  referrals: 'Referrals',
  surgical_cases: 'Operations',
  vital_signs: 'Vital signs',
};

/** Demographic fields the director may take from the duplicate. */
export const CHOOSABLE_FIELDS = {
  phone: ['phone'],
  email: ['email'],
  address: ['address'],
  municipality: ['municipality'],
  emergencyContact: ['emergencyContactName', 'emergencyContactPhone'],
  bloodType: ['bloodType'],
} as const;
export type ChoosableField = keyof typeof CHOOSABLE_FIELDS;
type PatientRow = typeof patients.$inferSelect;

const idsJson = (ids: string[]) =>
  sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)`;

export async function countsFor(patientId: string, executor: Executor = db) {
  const parts = PATIENT_TABLES.map(
    (t) =>
      sql`SELECT ${t}::text AS t, count(*)::int AS n FROM ${sql.identifier(t)} WHERE patient_id = ${patientId}`,
  );
  const result = await executor.execute<{ t: PatientTable; n: number }>(
    sql.join(parts, sql` UNION ALL `),
  );
  return Object.fromEntries(result.rows.map((r) => [r.t, r.n])) as Record<PatientTable, number>;
}

export function demographics(p: PatientRow) {
  return {
    id: p.id,
    nationalId: p.nationalId,
    firstName: p.firstName,
    lastName: p.lastName,
    dateOfBirth: p.dateOfBirth,
    sex: p.sex,
    bloodType: p.bloodType,
    phone: p.phone,
    email: p.email,
    address: p.address,
    municipality: p.municipality,
    emergencyContactName: p.emergencyContactName,
    emergencyContactPhone: p.emergencyContactPhone,
    primaryFacilityId: p.primaryFacilityId,
    hasPortalAccount: Boolean(p.userId),
    mergedIntoId: p.mergedIntoId,
    createdAt: p.createdAt,
  };
}

/* ------------------------------------------------------------------ candidates */

const normalise = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const phoneKey = (s: string | null | undefined) => {
  const d = (s ?? '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-8) : '';
};

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

export interface DuplicateScore {
  score: number;
  reasons: string[];
}

/** Scores two records that share a date of birth. Returns null when they are not likely the same. */
export function scorePair(
  a: Pick<PatientRow, 'firstName' | 'lastName' | 'phone' | 'email' | 'sex'>,
  b: Pick<PatientRow, 'firstName' | 'lastName' | 'phone' | 'email' | 'sex'>,
): DuplicateScore | null {
  const reasons: string[] = [];
  let score = 0;
  const an = `${normalise(a.firstName)} ${normalise(a.lastName)}`;
  const bn = `${normalise(b.firstName)} ${normalise(b.lastName)}`;
  const swapped = `${normalise(b.lastName)} ${normalise(b.firstName)}`;
  if (an === bn) {
    score = 90;
    reasons.push('Same name and date of birth');
  } else if (an === swapped) {
    score = 80;
    reasons.push('First and last name swapped');
  } else {
    const d = Math.min(levenshtein(an, bn), levenshtein(an, swapped));
    if (d <= 2) {
      score = 75 - d * 5;
      reasons.push('Very similar name and same date of birth');
    }
  }
  const pa = phoneKey(a.phone);
  if (pa && pa === phoneKey(b.phone)) {
    score += score ? 10 : 60;
    reasons.push('Same phone number');
  }
  const ea = normalise(a.email?.replace(/[@.]/g, ' '));
  if (a.email && ea && a.email.toLowerCase() === b.email?.toLowerCase()) {
    score += score ? 10 : 60;
    reasons.push('Same email address');
  }
  if (!score) return null;
  if (a.sex !== b.sex && a.sex !== 'UNKNOWN' && b.sex !== 'UNKNOWN') {
    score -= 15;
    reasons.push('Different sex recorded');
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

export async function findCandidates(facilityId: string, limit = 50) {
  const pairs = await db.execute<Record<string, string | null>>(sql`
    SELECT a.id AS a_id, b.id AS b_id
    FROM patients a
    JOIN patients b ON b.date_of_birth = a.date_of_birth AND a.id < b.id
    WHERE a.primary_facility_id = ${facilityId} AND b.primary_facility_id = ${facilityId}
      AND a.merged_into_id IS NULL AND b.merged_into_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM patient_merges m
        WHERE m.unmerged_at IS NOT NULL
          AND ((m.survivor_id = a.id AND m.merged_id = b.id) OR (m.survivor_id = b.id AND m.merged_id = a.id))
      )
    LIMIT 2000`);
  if (!pairs.rows.length) return [];
  const ids = [...new Set(pairs.rows.flatMap((r) => [r.a_id!, r.b_id!]))];
  const rows = await db.select().from(patients).where(inArray(patients.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  for (const pr of pairs.rows) {
    const a = byId.get(pr.a_id!)!;
    const b = byId.get(pr.b_id!)!;
    const s = scorePair(a, b);
    if (!s || s.score < 50) continue;
    out.push({ a: demographics(a), b: demographics(b), ...s });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, limit);
}

/* ------------------------------------------------------------------ merge / unmerge */

/** Loads both records for update and checks the director may merge them. */
async function lockPair(tx: Executor, survivorId: string, mergedId: string, facilityId: string) {
  const rows = await tx
    .select()
    .from(patients)
    .where(inArray(patients.id, [survivorId, mergedId]))
    .for('update');
  const survivor = rows.find((r) => r.id === survivorId);
  const merged = rows.find((r) => r.id === mergedId);
  if (!survivor || !merged) throw notFound('Patient not found');
  if (survivor.primaryFacilityId !== facilityId || merged.primaryFacilityId !== facilityId) {
    throw forbidden('Both records must be registered at your facility');
  }
  return { survivor, merged };
}

export interface MergeInput {
  survivorId: string;
  mergedId: string;
  reason: string;
  fieldChoices?: Partial<Record<ChoosableField, 'survivor' | 'merged'>>;
}

export interface MergeSnapshot {
  survivor: ReturnType<typeof demographics>;
  merged: ReturnType<typeof demographics>;
  /** Survivor fields overwritten with the duplicate's values. */
  changedFields: string[];
  /** Portal account moved from the duplicate to the survivor. */
  movedUserId: string | null;
}

export async function mergePatients(
  tx: Executor,
  input: MergeInput,
  actor: { userId: string; facilityId: string },
) {
  if (input.survivorId === input.mergedId) throw conflict('Choose two different records');
  // Declares this transaction as a merge to the database's protection triggers.
  await tx.execute(sql`SET LOCAL pacient.patient_merge = 'on'`);
  const { survivor, merged } = await lockPair(
    tx,
    input.survivorId,
    input.mergedId,
    actor.facilityId,
  );
  if (survivor.mergedIntoId || merged.mergedIntoId) {
    throw conflict('One of these records has already been merged');
  }
  if (survivor.userId && merged.userId) {
    throw conflict(
      'Both records have a portal account. Deactivate the account the patient no longer uses, then merge.',
    );
  }

  // A birth links a mother to her baby: those two records are different people.
  const linked = await tx.execute(sql`
    SELECT 1 FROM births
    WHERE (mother_patient_id = ${survivor.id} AND newborn_patient_id = ${merged.id})
       OR (mother_patient_id = ${merged.id} AND newborn_patient_id = ${survivor.id})
    LIMIT 1`);
  if (linked.rows.length) {
    throw conflict('These records are a mother and her baby – they cannot be merged');
  }
  // Records that exist at most once per person (or once while active).
  const single = await tx.execute<{ what: string; n: number }>(sql`
    SELECT 'blood donor record' AS what, count(*)::int AS n FROM blood_donors
      WHERE patient_id IN (${survivor.id}, ${merged.id})
    UNION ALL SELECT 'active home monitoring plan', count(*)::int FROM monitoring_plans
      WHERE status = 'ACTIVE' AND patient_id IN (${survivor.id}, ${merged.id})
    UNION ALL SELECT 'active dialysis schedule', count(*)::int FROM dialysis_schedules
      WHERE status = 'ACTIVE' AND patient_id IN (${survivor.id}, ${merged.id})
    UNION ALL SELECT 'active involuntary admission', count(*)::int FROM involuntary_admissions
      WHERE status = 'ACTIVE' AND patient_id IN (${survivor.id}, ${merged.id})
    UNION ALL SELECT 'active questionnaire request', coalesce(max(c), 0)::int FROM (
      SELECT count(*)::int AS c FROM prom_assignments
      WHERE status = 'ACTIVE' AND patient_id IN (${survivor.id}, ${merged.id})
      GROUP BY instrument) x`);
  const SINGLE_CLASH: Record<string, string> = {
    'blood donor record':
      'Both records have a blood donor record. Contact the blood bank, then merge.',
    'active home monitoring plan':
      'Both records have an active home monitoring plan. End one of them, then merge.',
    'active dialysis schedule':
      'Both records have an active dialysis schedule. End one of them, then merge.',
    'active involuntary admission':
      'Both records have an active involuntary admission. End one of them, then merge.',
    'active questionnaire request':
      'Both records ask for the same questionnaire. Stop one of the requests, then merge.',
  };
  const clash = single.rows.find((r) => r.n > 1);
  if (clash) throw conflict(SINGLE_CLASH[clash.what]!);
  // One death certificate per person.
  const deaths = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM death_records
    WHERE status <> 'WITHDRAWN' AND patient_id IN (${survivor.id}, ${merged.id})`);
  if ((deaths.rows[0]?.n ?? 0) > 1) {
    throw conflict(
      'Both records have a death certificate. Amend or withdraw one of them, then merge.',
    );
  }
  const pregnant = await tx.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pregnancies
    WHERE status = 'ONGOING' AND patient_id IN (${survivor.id}, ${merged.id})`);
  if ((pregnant.rows[0]?.n ?? 0) > 1) {
    throw conflict('Both records have an ongoing pregnancy. Close the duplicate one, then merge.');
  }
  // Only one active hospital stay and one active emergency attendance per person.
  const active = await tx.execute<{ admissions: number; ed: number }>(sql`
    SELECT
      (SELECT count(DISTINCT patient_id)::int FROM admissions
        WHERE status = 'ADMITTED' AND patient_id IN (${survivor.id}, ${merged.id})) AS admissions,
      (SELECT count(DISTINCT patient_id)::int FROM ed_visits
        WHERE status IN ('WAITING', 'IN_TREATMENT') AND patient_id IN (${survivor.id}, ${merged.id})) AS ed`);
  if ((active.rows[0]?.admissions ?? 0) > 1) {
    throw conflict(
      'Both records have an active hospital stay. Discharge or cancel one of the stays, then merge.',
    );
  }
  if ((active.rows[0]?.ed ?? 0) > 1) {
    throw conflict(
      'Both records have an open emergency attendance. Close one of them, then merge.',
    );
  }

  const movedRows: Record<string, string[]> = {};
  const now = new Date();

  // Equivalent active rows the survivor already has are ended instead of moved (unique keys).
  const ended = await tx.execute<{ id: string }>(sql`
    UPDATE care_assignments d SET ended_at = ${now}
    WHERE d.patient_id = ${merged.id} AND d.ended_at IS NULL
      AND EXISTS (SELECT 1 FROM care_assignments s WHERE s.patient_id = ${survivor.id}
                  AND s.doctor_id = d.doctor_id AND s.ended_at IS NULL)
    RETURNING d.id`);
  if (ended.rows.length) movedRows['care_assignments:ended'] = ended.rows.map((r) => r.id);
  const revoked = await tx.execute<{ id: string }>(sql`
    UPDATE guardianships d SET revoked_at = ${now}, revoked_by_id = ${actor.userId},
      revoke_reason = 'Duplicate record merged'
    WHERE d.patient_id = ${merged.id} AND d.revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM guardianships s WHERE s.patient_id = ${survivor.id}
                  AND s.guardian_user_id = d.guardian_user_id AND s.revoked_at IS NULL)
    RETURNING d.id`);
  if (revoked.rows.length) movedRows['guardianships:revoked'] = revoked.rows.map((r) => r.id);
  const left = await tx.execute<{ id: string }>(sql`
    UPDATE register_enrolments d SET status = 'LEFT', left_at = ${now},
      left_reason = 'Duplicate record merged'
    WHERE d.patient_id = ${merged.id} AND d.status = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM register_enrolments s WHERE s.patient_id = ${survivor.id}
                  AND s.register = d.register AND s.status = 'ACTIVE')
    RETURNING d.id`);
  if (left.rows.length) movedRows['register_enrolments:left'] = left.rows.map((r) => r.id);
  const optOuts = await tx.execute<{ id: string }>(sql`
    UPDATE screening_opt_outs d SET withdrawn_at = ${now}
    WHERE d.patient_id = ${merged.id} AND d.withdrawn_at IS NULL
      AND EXISTS (SELECT 1 FROM screening_opt_outs s WHERE s.patient_id = ${survivor.id}
                  AND s.programme = d.programme AND s.withdrawn_at IS NULL)
    RETURNING d.id`);
  if (optOuts.rows.length)
    movedRows['screening_opt_outs:withdrawn'] = optOuts.rows.map((r) => r.id);

  for (const table of PATIENT_TABLES) {
    const result = await tx.execute<{ id: string }>(
      sql`UPDATE ${sql.identifier(table)} SET patient_id = ${survivor.id} WHERE patient_id = ${merged.id} RETURNING id`,
    );
    if (result.rows.length) movedRows[table] = result.rows.map((r) => r.id);
  }
  for (const ref of OTHER_PATIENT_COLUMNS) {
    const [table, column] = ref.split('.') as [string, string];
    const result = await tx.execute<{ id: string }>(
      sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${survivor.id} WHERE ${sql.identifier(column)} = ${merged.id} RETURNING id`,
    );
    if (result.rows.length) movedRows[ref] = result.rows.map((r) => r.id);
  }

  // Demographics the director chose to take from the duplicate.
  const changes: Partial<PatientRow> = {};
  const changedFields: string[] = [];
  for (const [choice, source] of Object.entries(input.fieldChoices ?? {})) {
    if (source !== 'merged') continue;
    for (const f of CHOOSABLE_FIELDS[choice as ChoosableField] ?? []) {
      if (merged[f] !== survivor[f]) {
        (changes as Record<string, unknown>)[f] = merged[f];
        changedFields.push(f);
      }
    }
  }

  let movedUserId: string | null = null;
  // The portal account follows the person: unlink from the duplicate first (unique userId).
  await tx
    .update(patients)
    .set({ mergedIntoId: survivor.id, mergedAt: now, userId: null })
    .where(eq(patients.id, merged.id));
  if (merged.userId && !survivor.userId) {
    movedUserId = merged.userId;
    changes.userId = merged.userId;
  }
  if (Object.keys(changes).length) {
    await tx.update(patients).set(changes).where(eq(patients.id, survivor.id));
  }

  const snapshot: MergeSnapshot = {
    survivor: demographics(survivor),
    merged: demographics(merged),
    changedFields,
    movedUserId,
  };
  const [record] = await tx
    .insert(patientMerges)
    .values({
      survivorId: survivor.id,
      mergedId: merged.id,
      facilityId: actor.facilityId,
      reason: input.reason,
      movedRows,
      snapshot: snapshot as unknown as Record<string, unknown>,
      mergedById: actor.userId,
    })
    .returning();
  return { record: record!, survivor, merged, movedRows };
}

export async function unmergePatients(
  tx: Executor,
  mergeId: string,
  reason: string,
  actor: { userId: string; facilityId: string },
) {
  await tx.execute(sql`SET LOCAL pacient.patient_merge = 'on'`);
  const [m] = await tx
    .select()
    .from(patientMerges)
    .where(eq(patientMerges.id, mergeId))
    .for('update');
  if (!m || m.facilityId !== actor.facilityId) throw notFound('Merge not found');
  if (m.unmergedAt) throw conflict('This merge has already been undone');
  const { survivor, merged } = await lockPair(tx, m.survivorId, m.mergedId, actor.facilityId);
  if (merged.mergedIntoId !== survivor.id) throw conflict('The records changed since the merge');

  const snapshot = m.snapshot as unknown as MergeSnapshot;
  const restored: Record<string, number> = {};
  // Move rows back first; re-activate rows the merge ended (they moved too) afterwards.
  const entries = Object.entries(m.movedRows).sort(
    ([a], [b]) => Number(a.includes(':')) - Number(b.includes(':')),
  );
  for (const [key, ids] of entries) {
    if (!ids.length) continue;
    if (key === 'care_assignments:ended') {
      const r = await tx.execute(sql`
        UPDATE care_assignments d SET ended_at = NULL
        WHERE d.id IN ${idsJson(ids)} AND d.patient_id = ${merged.id}
          AND NOT EXISTS (SELECT 1 FROM care_assignments s WHERE s.patient_id = ${merged.id}
                          AND s.doctor_id = d.doctor_id AND s.ended_at IS NULL)`);
      restored[key] = r.rowCount ?? 0;
      continue;
    }
    if (key === 'screening_opt_outs:withdrawn') {
      const r = await tx.execute(sql`
        UPDATE screening_opt_outs d SET withdrawn_at = NULL
        WHERE d.id IN ${idsJson(ids)} AND d.patient_id = ${merged.id}
          AND NOT EXISTS (SELECT 1 FROM screening_opt_outs s WHERE s.patient_id = ${merged.id}
                          AND s.programme = d.programme AND s.withdrawn_at IS NULL)`);
      restored[key] = r.rowCount ?? 0;
      continue;
    }
    if (key === 'register_enrolments:left') {
      const r = await tx.execute(sql`
        UPDATE register_enrolments d SET status = 'ACTIVE', left_at = NULL, left_reason = NULL
        WHERE d.id IN ${idsJson(ids)} AND d.patient_id = ${merged.id}
          AND d.left_reason = 'Duplicate record merged'
          AND NOT EXISTS (SELECT 1 FROM register_enrolments s WHERE s.patient_id = ${merged.id}
                          AND s.register = d.register AND s.status = 'ACTIVE')`);
      restored[key] = r.rowCount ?? 0;
      continue;
    }
    if (key === 'guardianships:revoked') {
      const r = await tx.execute(sql`
        UPDATE guardianships d SET revoked_at = NULL, revoked_by_id = NULL, revoke_reason = NULL
        WHERE d.id IN ${idsJson(ids)} AND d.patient_id = ${merged.id}
          AND d.revoke_reason = 'Duplicate record merged'
          AND NOT EXISTS (SELECT 1 FROM guardianships s WHERE s.patient_id = ${merged.id}
                          AND s.guardian_user_id = d.guardian_user_id AND s.revoked_at IS NULL)`);
      restored[key] = r.rowCount ?? 0;
      continue;
    }
    if ((OTHER_PATIENT_COLUMNS as readonly string[]).includes(key)) {
      const [table, column] = key.split('.') as [string, string];
      const r = await tx.execute(
        sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${merged.id} WHERE id IN ${idsJson(ids)} AND ${sql.identifier(column)} = ${survivor.id}`,
      );
      restored[key] = r.rowCount ?? 0;
      continue;
    }
    if (!(PATIENT_TABLES as readonly string[]).includes(key)) continue;
    const r = await tx.execute(
      sql`UPDATE ${sql.identifier(key)} SET patient_id = ${merged.id} WHERE id IN ${idsJson(ids)} AND patient_id = ${survivor.id}`,
    );
    restored[key] = r.rowCount ?? 0;
  }

  // Survivor demographics: undo only what the merge changed (if nobody edited it since).
  const survivorPatch: Record<string, unknown> = {};
  for (const f of snapshot.changedFields ?? []) {
    const key = f as keyof PatientRow;
    if (survivor[key] === (snapshot.merged as Record<string, unknown>)[f]) {
      survivorPatch[f] = (snapshot.survivor as Record<string, unknown>)[f] ?? null;
    }
  }
  let accountMovedBack = false;
  if (snapshot.movedUserId && survivor.userId === snapshot.movedUserId) {
    survivorPatch.userId = null;
    accountMovedBack = true;
  }
  if (Object.keys(survivorPatch).length) {
    await tx.update(patients).set(survivorPatch).where(eq(patients.id, survivor.id));
  }
  await tx
    .update(patients)
    .set({
      mergedIntoId: null,
      mergedAt: null,
      ...(accountMovedBack ? { userId: snapshot.movedUserId } : {}),
    })
    .where(eq(patients.id, merged.id));
  const [record] = await tx
    .update(patientMerges)
    .set({ unmergedAt: new Date(), unmergedById: actor.userId, unmergeReason: reason })
    .where(and(eq(patientMerges.id, m.id), isNull(patientMerges.unmergedAt)))
    .returning();
  return { record: record!, restored, survivor, merged };
}
