import { and, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import {
  careProcessRecords,
  diagnoses,
  immunizations,
  labResults,
  patients,
  registerEnrolments,
  vitalSigns,
} from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import {
  RECALL_INTERVAL_DAYS,
  REGISTERS,
  registersForIcd10,
  type RegisterCode,
} from './definitions.js';
import { evaluateRegister, isOverdue, type PatientData } from './evaluate.js';

/** Clinical data older than this is not needed for any register rule. */
const LOOKBACK_DAYS = 3 * 365;
const DAY = 86_400_000;

/* ------------------------------------------------------------------------- enrolment -- */

/**
 * Enrols the patient in every register matching an ICD-10 code. Idempotent: an existing active
 * enrolment is kept (the partial unique index allows one per register). Returns the registers
 * newly joined.
 */
export async function enrolPatient(
  patientId: string,
  registers: RegisterCode[],
  opts: {
    source: 'DIAGNOSIS' | 'MANUAL';
    diagnosisId?: string | null;
    enrolledById?: string | null;
    facilityId?: string;
  },
  executor: Executor = db,
): Promise<RegisterCode[]> {
  if (!registers.length) return [];
  const [patient] = await executor
    .select({
      facilityId: patients.primaryFacilityId,
      mergedIntoId: patients.mergedIntoId,
      deceasedAt: patients.deceasedAt,
    })
    .from(patients)
    .where(eq(patients.id, patientId));
  if (!patient || patient.mergedIntoId || patient.deceasedAt) return [];
  const joined: RegisterCode[] = [];
  for (const register of registers) {
    const rows = await executor
      .insert(registerEnrolments)
      .values({
        patientId,
        register,
        facilityId: opts.facilityId ?? patient.facilityId,
        source: opts.source,
        diagnosisId: opts.diagnosisId ?? null,
        enrolledById: opts.enrolledById ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: registerEnrolments.id });
    if (rows.length) joined.push(register);
  }
  return joined;
}

/**
 * Called after a diagnosis is recorded: enrols the patient in the matching chronic disease
 * register (if any). Never throws into the caller's flow.
 */
export async function enrolFromDiagnosis(diagnosisId: string, executor: Executor = db) {
  try {
    const [d] = await executor
      .select({
        patientId: diagnoses.patientId,
        icd10Code: diagnoses.icd10Code,
        status: diagnoses.status,
        doctorId: diagnoses.doctorId,
      })
      .from(diagnoses)
      .where(eq(diagnoses.id, diagnosisId));
    if (!d || d.status === 'RESOLVED') return [];
    const joined = await enrolPatient(
      d.patientId,
      registersForIcd10(d.icd10Code),
      { source: 'DIAGNOSIS', diagnosisId, enrolledById: d.doctorId },
      executor,
    );
    for (const register of joined) {
      await audit(
        {
          action: AuditAction.REGISTER_ENROLLED,
          actor: null,
          resourceType: 'patient',
          resourceId: d.patientId,
          patientId: d.patientId,
          metadata: { register, source: 'DIAGNOSIS', diagnosisId },
        },
        executor,
      );
    }
    return joined;
  } catch (err) {
    logger.error({ err, diagnosisId }, 'Register enrolment from diagnosis failed');
    return [];
  }
}

/** Enrols every patient whose active or chronic diagnoses match a register (daily backfill). */
export async function backfillEnrolments(): Promise<number> {
  const prefixes = Object.values(REGISTERS).flatMap((r) => r.icd10Prefixes);
  const pattern = `^(${prefixes.join('|')})`;
  const rows = await db.execute<{ id: string }>(sql`
    SELECT d.id FROM diagnoses d
    JOIN patients p ON p.id = d.patient_id
    WHERE d.status IN ('ACTIVE', 'CHRONIC')
      AND p.merged_into_id IS NULL AND p.deceased_at IS NULL
      AND upper(regexp_replace(d.icd10_code, '[^A-Za-z0-9]', '', 'g')) ~ ${pattern}
      AND NOT EXISTS (
        SELECT 1 FROM register_enrolments e
        WHERE e.patient_id = d.patient_id AND e.diagnosis_id = d.id)
    ORDER BY d.diagnosed_at
    LIMIT 5000`);
  let joined = 0;
  for (const r of rows.rows) joined += (await enrolFromDiagnosis(r.id)).length;
  return joined;
}

/* ------------------------------------------------------------------------ record data -- */

/** Everything the register rules need for these patients, from the last three years. */
export async function loadPatientData(
  patientIds: string[],
  executor: Executor = db,
): Promise<Map<string, PatientData>> {
  const out = new Map<string, PatientData>();
  if (!patientIds.length) return out;
  const since = new Date(Date.now() - LOOKBACK_DAYS * DAY);
  const people = await executor
    .select({ id: patients.id, dateOfBirth: patients.dateOfBirth, sex: patients.sex })
    .from(patients)
    .where(inArray(patients.id, patientIds));
  for (const p of people) {
    out.set(p.id, {
      dateOfBirth: p.dateOfBirth,
      sex: p.sex,
      labs: [],
      vitals: [],
      records: [],
      immunizations: [],
    });
  }
  const [labs, vitals, records, shots] = await Promise.all([
    executor
      .select({
        patientId: labResults.patientId,
        testName: labResults.testName,
        testCode: labResults.testCode,
        value: labResults.value,
        unit: labResults.unit,
        collectedAt: labResults.collectedAt,
      })
      .from(labResults)
      .where(
        and(
          inArray(labResults.patientId, patientIds),
          gte(labResults.collectedAt, since),
          isNull(labResults.supersededById),
          ne(labResults.status, 'PRELIMINARY'),
        ),
      ),
    executor
      .select({
        patientId: vitalSigns.patientId,
        systolic: vitalSigns.systolic,
        diastolic: vitalSigns.diastolic,
        weightKg: vitalSigns.weightKg,
        heightCm: vitalSigns.heightCm,
        recordedAt: vitalSigns.recordedAt,
      })
      .from(vitalSigns)
      .where(and(inArray(vitalSigns.patientId, patientIds), gte(vitalSigns.recordedAt, since))),
    executor
      .select({
        patientId: careProcessRecords.patientId,
        register: careProcessRecords.register,
        process: careProcessRecords.process,
        result: careProcessRecords.result,
        notes: careProcessRecords.notes,
        performedAt: careProcessRecords.performedAt,
      })
      .from(careProcessRecords)
      .where(
        and(
          inArray(careProcessRecords.patientId, patientIds),
          gte(careProcessRecords.performedAt, since),
        ),
      ),
    executor
      .select({
        patientId: immunizations.patientId,
        vaccine: immunizations.vaccine,
        administeredAt: immunizations.administeredAt,
      })
      .from(immunizations)
      .where(
        and(inArray(immunizations.patientId, patientIds), gte(immunizations.administeredAt, since)),
      ),
  ]);
  for (const l of labs) out.get(l.patientId)?.labs.push(l);
  for (const v of vitals) out.get(v.patientId)?.vitals.push(v);
  for (const r of records) out.get(r.patientId)?.records.push(r);
  for (const i of shots) out.get(i.patientId)?.immunizations.push(i);
  return out;
}

export async function activeEnrolments(patientIds: string[], executor: Executor = db) {
  if (!patientIds.length) return [];
  return executor
    .select()
    .from(registerEnrolments)
    .where(
      and(
        inArray(registerEnrolments.patientId, patientIds),
        eq(registerEnrolments.status, 'ACTIVE'),
      ),
    )
    .orderBy(registerEnrolments.register);
}

/* ---------------------------------------------------------------------------- recalls -- */

const RECALL_TYPE = 'register_recall';

/**
 * Processes already recalled for a patient within RECALL_INTERVAL_DAYS, from the recall
 * notifications themselves (their link carries "recall=REGISTER.PROCESS,…&patient=<id>").
 */
async function recentlyRecalled(patientId: string, executor: Executor, now: Date) {
  const since = new Date(now.getTime() - RECALL_INTERVAL_DAYS * DAY);
  const rows = await executor.execute<{ link: string | null }>(sql`
    SELECT link FROM notifications
    WHERE type = ${RECALL_TYPE} AND created_at >= ${since}
      AND link LIKE ${`%patient=${patientId}%`}`);
  const done = new Set<string>();
  for (const r of rows.rows) {
    const m = /recall=([^&]+)/.exec(r.link ?? '');
    for (const key of m?.[1]?.split(',') ?? []) done.add(key);
  }
  return done;
}

/**
 * Tells patients (and their guardians) when a review item of a register they are in is overdue:
 * one generic message per patient (no diagnosis or results in it), and the same process at most
 * once every RECALL_INTERVAL_DAYS. Patients without a portal account or guardian are not told
 * (they appear on their doctor's recall list). Safe on several instances: each patient is handled
 * under a transaction-scoped advisory lock and re-checked.
 */
export async function runRegisterRecallsOnce(now = new Date()): Promise<number> {
  const enrolled = await db.execute<{ patient_id: string }>(sql`
    SELECT DISTINCT e.patient_id FROM register_enrolments e
    JOIN patients p ON p.id = e.patient_id
    WHERE e.status = 'ACTIVE' AND p.merged_into_id IS NULL AND p.deceased_at IS NULL
      AND (p.user_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM guardianships g WHERE g.patient_id = p.id AND g.revoked_at IS NULL
          AND g.valid_from <= ${now} AND g.valid_until > ${now}))
    LIMIT 20000`);
  let sent = 0;
  const ids = enrolled.rows.map((r) => r.patient_id);
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const [data, enrolments] = await Promise.all([loadPatientData(batch), activeEnrolments(batch)]);
    for (const patientId of batch) {
      const overdue = enrolments
        .filter((e) => e.patientId === patientId)
        .flatMap((e) =>
          evaluateRegister(e.register as RegisterCode, e.enrolledAt, data.get(patientId)!, now)
            .filter(isOverdue)
            .map((p) => `${e.register}.${p.code}`),
        );
      if (!overdue.length) continue;
      const delivered = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`register_recall:${patientId}`}))`,
        );
        const done = await recentlyRecalled(patientId, tx, now);
        const fresh = overdue.filter((k) => !done.has(k));
        if (!fresh.length) return false;
        await notifyPatient(
          patientId,
          {
            type: RECALL_TYPE,
            title: 'A routine check-up is due',
            body: 'Please book an appointment with your family doctor for your regular review.',
            link: `/portal/appointments?recall=${fresh.join(',')}&patient=${patientId}`,
          },
          tx,
        );
        return true;
      });
      if (delivered) sent++;
    }
  }
  return sent;
}

/* ----------------------------------------------------------------------------- worker -- */

let timer: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;

export async function runRegistersOnce(now = new Date()) {
  const enrolled = await backfillEnrolments();
  const recalls = await runRegisterRecallsOnce(now);
  return { enrolled, recalls };
}

function runSafely() {
  runRegistersOnce().then(
    (r) => (r.enrolled || r.recalls) && logger.info(r, 'Disease registers updated'),
    (err: unknown) => logger.error({ err }, 'Disease register worker failed'),
  );
}

/** Daily (first run five minutes after start). Not started in tests. */
export function startRegistersWorker() {
  if (isTest || timer) return;
  first = setTimeout(runSafely, 5 * 60_000);
  first.unref();
  timer = setInterval(runSafely, DAY);
  timer.unref();
}

export function stopRegistersWorker() {
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = undefined;
  timer = undefined;
}

/** Latest manual records per process for a patient (for the chart). */
export async function recentRecords(patientId: string, limit = 50) {
  return db
    .select()
    .from(careProcessRecords)
    .where(eq(careProcessRecords.patientId, patientId))
    .orderBy(desc(careProcessRecords.performedAt))
    .limit(limit);
}
