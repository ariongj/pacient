import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import { encounters, facilities, medicalCertificates, patients, users } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { kosovoDate } from '../identity/identity.service.js';
import { suppressGroup, THRESHOLD } from '../opendata/suppression.js';

/**
 * Medical certificates: sick leave, fitness (work, sports, driving), school absence and general
 * certificates. Issued once and never edited (database trigger); a wrong one is revoked with a
 * reason and a new one issued. Each carries a random verification code for the QR link that
 * employers and schools open to check it – they see validity, kind, dates and issuer only.
 */

export const CERTIFICATE_KINDS = [
  'SICK_LEAVE',
  'FITNESS_FOR_WORK',
  'SCHOOL_ABSENCE',
  'SPORTS_FITNESS',
  'DRIVING_FITNESS',
  'GENERAL',
] as const;
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];
export const FITNESS_KINDS: readonly CertificateKind[] = [
  'FITNESS_FOR_WORK',
  'SPORTS_FITNESS',
  'DRIVING_FITNESS',
];
export const FITNESS_OUTCOMES = ['FIT', 'FIT_WITH_RESTRICTIONS', 'UNFIT'] as const;

/** One sick-leave or school-absence certificate covers at most this many days. */
export const MAX_DAYS_PER_CERTIFICATE = 30;
/** Continuous sick leave beyond this needs assessment by a medical commission. */
export const MEDICAL_COMMISSION_DAYS = 90;
/** Starting earlier than this many days before today needs an explanatory remark. */
export const BACKDATE_DAYS_WITHOUT_REMARK = 3;
/** Certificates may be issued in advance by at most this many days. */
export const MAX_DAYS_IN_ADVANCE = 7;
/** School absence certificates are for pupils (under 19 at the start date). */
export const SCHOOL_MAX_AGE = 19;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD');

export const IssueCertificateSchema = z.object({
  kind: z.enum(CERTIFICATE_KINDS),
  startDate: isoDate,
  endDate: isoDate.optional().nullable(),
  icd10Code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]\d{2}(\.[0-9A-Z]{1,4})?$/, 'Enter a valid ICD-10 code, e.g. J06.9')
    .optional()
    .nullable(),
  diagnosisOnCertificate: z.boolean().default(false),
  outcome: z.enum(FITNESS_OUTCOMES).optional().nullable(),
  restrictions: z.string().trim().max(500).optional().nullable(),
  purpose: z.string().trim().max(200).optional().nullable(),
  remarks: z.string().trim().max(2000).optional().nullable(),
  encounterId: z.string().uuid().optional().nullable(),
  extendsCertificateId: z.string().uuid().optional().nullable(),
});
export type IssueCertificateInput = z.infer<typeof IssueCertificateSchema>;

/* ------------------------------------------------------------------- dates ---------------- */

const dayMs = 86_400_000;
const toDay = (d: string) => Date.parse(`${d}T00:00:00Z`) / dayMs;
const fromDay = (n: number) => new Date(n * dayMs).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromDay(toDay(d) + n);
/** Calendar days covered, both ends included. */
export const daysCovered = (start: string, end: string) => toDay(end) - toDay(start) + 1;

export function ageOn(dateOfBirth: string, on: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [y, m, d] = on.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/* ------------------------------------------------------------------- codes ---------------- */

/** 144 random bits, URL-safe (24 characters). */
export const newVerificationCode = () => randomBytes(18).toString('base64url');
export const VERIFICATION_CODE_PATTERN = /^[A-Za-z0-9_-]{16,40}$/;
export const verificationUrl = (code: string) =>
  `${env.WEB_APP_URL.replace(/\/$/, '')}/verify/${code}`;

/**
 * Next serial number for the facility and year ("UCC-PR-2026-000123"). A transaction-scoped
 * advisory lock serialises concurrent issues at the same facility, so numbers never collide.
 */
export async function nextSerialNumber(tx: Executor, facilityId: string, issuedOn: string) {
  const year = issuedOn.slice(0, 4);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`certificate:${facilityId}:${year}`}))`,
  );
  const [facility] = await tx
    .select({ code: facilities.code })
    .from(facilities)
    .where(eq(facilities.id, facilityId));
  const prefix = `${facility!.code}-${year}-`;
  const [last] = await tx
    .select({ serial: medicalCertificates.serialNumber })
    .from(medicalCertificates)
    .where(like(medicalCertificates.serialNumber, `${prefix}%`))
    .orderBy(desc(medicalCertificates.serialNumber))
    .limit(1);
  const n = last ? Number(last.serial.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(n).padStart(6, '0')}`;
}

/* --------------------------------------------------------------- validation ---------------- */

type CertificateRow = typeof medicalCertificates.$inferSelect;

export interface CertificateWarning {
  code: 'MEDICAL_COMMISSION';
  message: string;
  days: number;
}

/** Total continuous sick-leave days of the chain ending with this certificate. */
export function chainDays(
  cert: Pick<CertificateRow, 'id' | 'startDate' | 'endDate' | 'extendsCertificateId'>,
  byId: Map<string, Pick<CertificateRow, 'id' | 'startDate' | 'endDate' | 'extendsCertificateId'>>,
): number {
  let total = 0;
  let current: typeof cert | undefined = cert;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.endDate) total += daysCovered(current.startDate, current.endDate);
    current = current.extendsCertificateId ? byId.get(current.extendsCertificateId) : undefined;
  }
  return total;
}

/**
 * Checks the clinical and administrative rules for a new certificate. Returns non-blocking
 * warnings; throws 400 (invalid input) or 409 (conflicts with existing certificates).
 */
export async function validateNewCertificate(
  tx: Executor,
  patient: { id: string; dateOfBirth: string; deceasedAt: Date | null },
  input: IssueCertificateInput,
  today = kosovoDate(new Date()),
): Promise<{ warnings: CertificateWarning[]; chainTotal: number | null }> {
  const warnings: CertificateWarning[] = [];
  const { kind, startDate } = input;
  const endDate = input.endDate ?? null;
  if (patient.deceasedAt) throw conflict('Certificates cannot be issued for a deceased patient');

  if (Number.isNaN(toDay(startDate)) || (endDate && Number.isNaN(toDay(endDate)))) {
    throw badRequest('Enter valid dates');
  }
  if (endDate && endDate < startDate)
    throw badRequest('The end date must not be before the start date');
  if (toDay(startDate) > toDay(today) + MAX_DAYS_IN_ADVANCE) {
    throw badRequest('A certificate cannot start more than 7 days from today');
  }
  if (toDay(startDate) < toDay(today) - BACKDATE_DAYS_WITHOUT_REMARK && !input.remarks?.trim()) {
    throw badRequest('Explain in the remarks why the certificate starts more than 3 days ago');
  }
  if (input.diagnosisOnCertificate && !input.icd10Code) {
    throw badRequest('Enter the diagnosis code to print it on the certificate');
  }
  if (input.extendsCertificateId && kind !== 'SICK_LEAVE') {
    throw badRequest('Only sick leave can be extended');
  }

  if (kind === 'SICK_LEAVE' || kind === 'SCHOOL_ABSENCE') {
    if (!endDate) throw badRequest('Enter the last day of the absence');
    if (daysCovered(startDate, endDate) > MAX_DAYS_PER_CERTIFICATE) {
      throw badRequest(
        'One certificate covers at most 30 days – issue an extension for a longer absence',
      );
    }
  }
  if (kind === 'SCHOOL_ABSENCE' && ageOn(patient.dateOfBirth, startDate) >= SCHOOL_MAX_AGE) {
    throw badRequest('School absence certificates are for pupils under 19');
  }
  if (FITNESS_KINDS.includes(kind)) {
    if (!input.outcome) throw badRequest('Choose the outcome of the fitness assessment');
    if (input.outcome === 'FIT_WITH_RESTRICTIONS' && !input.restrictions?.trim()) {
      throw badRequest('Describe the restrictions');
    }
  } else if (input.outcome) {
    throw badRequest('An outcome is only recorded on fitness certificates');
  }
  if (kind === 'GENERAL' && !input.purpose?.trim()) {
    throw badRequest('Enter what the certificate is for');
  }

  if (input.encounterId) {
    const [enc] = await tx
      .select({ id: encounters.id })
      .from(encounters)
      .where(and(eq(encounters.id, input.encounterId), eq(encounters.patientId, patient.id)));
    if (!enc) throw badRequest('Encounter does not belong to this patient');
  }

  let chainTotal: number | null = null;
  if (kind === 'SICK_LEAVE') {
    // All issued sick leave of this person, at any facility.
    const leave = await tx
      .select({
        id: medicalCertificates.id,
        startDate: medicalCertificates.startDate,
        endDate: medicalCertificates.endDate,
        extendsCertificateId: medicalCertificates.extendsCertificateId,
        status: medicalCertificates.status,
      })
      .from(medicalCertificates)
      .where(
        and(
          eq(medicalCertificates.patientId, patient.id),
          eq(medicalCertificates.kind, 'SICK_LEAVE'),
          eq(medicalCertificates.status, 'ISSUED'),
        ),
      )
      .for('update');
    const overlapping = leave.find(
      (c) => c.endDate && c.startDate <= endDate! && c.endDate >= startDate,
    );
    if (overlapping) {
      throw conflict(
        'The patient already has sick leave for part of this period – extend or revoke that certificate instead',
      );
    }
    const byId = new Map(leave.map((c) => [c.id, c]));
    if (input.extendsCertificateId) {
      const previous = byId.get(input.extendsCertificateId);
      if (!previous) {
        throw badRequest('The certificate to extend must be issued sick leave of this patient');
      }
      if (leave.some((c) => c.extendsCertificateId === previous.id)) {
        throw conflict('This sick leave has already been extended – extend the latest certificate');
      }
      if (startDate !== addDays(previous.endDate!, 1)) {
        throw badRequest('An extension starts on the day after the previous certificate ends', {
          expectedStartDate: addDays(previous.endDate!, 1),
        });
      }
    }
    chainTotal = chainDays(
      { id: 'new', startDate, endDate, extendsCertificateId: input.extendsCertificateId ?? null },
      byId,
    );
    if (chainTotal > MEDICAL_COMMISSION_DAYS) {
      warnings.push({
        code: 'MEDICAL_COMMISSION',
        message:
          'Sick leave of more than 90 days in a row needs assessment by a medical commission',
        days: chainTotal,
      });
    }
  }
  return { warnings, chainTotal };
}

/* ----------------------------------------------------------------- views ----------------- */

/** Certificate list for one patient (newest first) with issuer and facility names. */
export async function listPatientCertificates(
  patientId: string,
  opts: { hideConfidential: boolean },
) {
  const rows = await db
    .select({
      cert: medicalCertificates,
      issuedByName: users.fullName,
      facilityName: facilities.name,
      encounterConfidential: encounters.confidentialFromGuardians,
    })
    .from(medicalCertificates)
    .innerJoin(users, eq(users.id, medicalCertificates.issuedById))
    .innerJoin(facilities, eq(facilities.id, medicalCertificates.facilityId))
    .leftJoin(encounters, eq(encounters.id, medicalCertificates.encounterId))
    .where(eq(medicalCertificates.patientId, patientId))
    .orderBy(desc(medicalCertificates.issuedAt))
    .limit(200);
  const visible = rows.filter((r) => !(opts.hideConfidential && r.encounterConfidential));
  const byId = new Map(rows.map((r) => [r.cert.id, r.cert]));
  const extendedBy = new Map(
    rows
      .filter((r) => r.cert.extendsCertificateId && r.cert.status === 'ISSUED')
      .map((r) => [r.cert.extendsCertificateId!, r.cert.id]),
  );
  return visible.map(({ cert, issuedByName, facilityName }) => ({
    ...publicFields(cert),
    icd10Code: cert.icd10Code,
    diagnosisOnCertificate: cert.diagnosisOnCertificate,
    purpose: cert.purpose,
    remarks: cert.remarks,
    restrictions: cert.restrictions,
    encounterId: cert.encounterId,
    extendsCertificateId: cert.extendsCertificateId,
    extendedById: extendedBy.get(cert.id) ?? null,
    revokeReason: cert.revokeReason,
    issuedById: cert.issuedById,
    issuedByName,
    facilityId: cert.facilityId,
    facilityName,
    days: cert.endDate ? daysCovered(cert.startDate, cert.endDate) : null,
    chainDays:
      cert.kind === 'SICK_LEAVE' && cert.status === 'ISSUED' ? chainDays(cert, byId) : null,
  }));
}

function publicFields(cert: CertificateRow) {
  return {
    id: cert.id,
    kind: cert.kind as CertificateKind,
    serialNumber: cert.serialNumber,
    startDate: cert.startDate,
    endDate: cert.endDate,
    outcome: cert.outcome,
    status: cert.status as 'ISSUED' | 'REVOKED',
    issuedAt: cert.issuedAt,
    revokedAt: cert.revokedAt,
  };
}

/** Everything needed to print a certificate (for people allowed to see it). */
export async function certificateForPrint(id: string) {
  const [row] = await db
    .select({
      cert: medicalCertificates,
      patient: {
        id: patients.id,
        firstName: patients.firstName,
        lastName: patients.lastName,
        dateOfBirth: patients.dateOfBirth,
        nationalId: patients.nationalId,
        sex: patients.sex,
        address: patients.address,
        municipality: patients.municipality,
      },
      doctor: {
        fullName: users.fullName,
        specialty: users.specialty,
        licenseNumber: users.licenseNumber,
      },
      facility: {
        name: facilities.name,
        code: facilities.code,
        municipality: facilities.municipality,
        address: facilities.address,
        phone: facilities.phone,
      },
      encounterConfidential: encounters.confidentialFromGuardians,
    })
    .from(medicalCertificates)
    .innerJoin(patients, eq(patients.id, medicalCertificates.patientId))
    .innerJoin(users, eq(users.id, medicalCertificates.issuedById))
    .innerJoin(facilities, eq(facilities.id, medicalCertificates.facilityId))
    .leftJoin(encounters, eq(encounters.id, medicalCertificates.encounterId))
    .where(eq(medicalCertificates.id, id));
  return row ?? null;
}

export type VerificationState = 'VALID' | 'EXPIRED' | 'REVOKED';

/** What an employer or school sees when opening the QR link: never the diagnosis or remarks. */
export async function verifyByCode(code: string, today = kosovoDate(new Date())) {
  const [row] = await db
    .select({
      cert: medicalCertificates,
      firstName: patients.firstName,
      lastName: patients.lastName,
      dateOfBirth: patients.dateOfBirth,
      doctorName: users.fullName,
      facilityName: facilities.name,
      facilityMunicipality: facilities.municipality,
    })
    .from(medicalCertificates)
    .innerJoin(patients, eq(patients.id, medicalCertificates.patientId))
    .innerJoin(users, eq(users.id, medicalCertificates.issuedById))
    .innerJoin(facilities, eq(facilities.id, medicalCertificates.facilityId))
    .where(eq(medicalCertificates.verificationCode, code));
  if (!row) return null;
  const { cert } = row;
  const state: VerificationState =
    cert.status === 'REVOKED'
      ? 'REVOKED'
      : cert.endDate && cert.endDate < today
        ? 'EXPIRED'
        : 'VALID';
  const fitness = FITNESS_KINDS.includes(cert.kind as CertificateKind);
  return {
    patientId: cert.patientId,
    certificateId: cert.id,
    body: {
      genuine: true,
      state,
      kind: cert.kind as CertificateKind,
      serialNumber: cert.serialNumber,
      startDate: cert.startDate,
      endDate: cert.endDate,
      outcome: fitness ? cert.outcome : null,
      restrictions: fitness ? cert.restrictions : null,
      issuedAt: cert.issuedAt,
      revokedAt: cert.revokedAt,
      issuer: {
        facility: row.facilityName,
        municipality: row.facilityMunicipality,
        doctor: row.doctorName,
      },
      patient: {
        initials: `${row.firstName.charAt(0)}. ${row.lastName.charAt(0)}.`.toUpperCase(),
        birthYear: Number(row.dateOfBirth.slice(0, 4)),
      },
    },
  };
}

/* ----------------------------------------------------------------- statistics ------------- */

/** Monthly counts by kind and sick-leave days (aggregate only, no names). */
export async function certificateStats(opts: {
  facilityId: string | null;
  from: string;
  to: string;
}) {
  const where = and(
    opts.facilityId ? eq(medicalCertificates.facilityId, opts.facilityId) : undefined,
    sql`(${medicalCertificates.issuedAt} AT TIME ZONE 'Europe/Belgrade')::date BETWEEN ${opts.from}::date AND ${opts.to}::date`,
  );
  const month = sql<string>`to_char(${medicalCertificates.issuedAt} AT TIME ZONE 'Europe/Belgrade', 'YYYY-MM')`;
  const rows = await db
    .select({
      month,
      kind: medicalCertificates.kind,
      issued: sql<number>`count(*) FILTER (WHERE ${medicalCertificates.status} = 'ISSUED')::int`,
      revoked: sql<number>`count(*) FILTER (WHERE ${medicalCertificates.status} = 'REVOKED')::int`,
      days: sql<number>`coalesce(sum(${medicalCertificates.endDate} - ${medicalCertificates.startDate} + 1) FILTER (WHERE ${medicalCertificates.status} = 'ISSUED' AND ${medicalCertificates.endDate} IS NOT NULL), 0)::int`,
    })
    .from(medicalCertificates)
    .where(where)
    .groupBy(month, medicalCertificates.kind)
    .orderBy(month, medicalCertificates.kind);
  return { from: opts.from, to: opts.to, ...protectCertificateStats(rows) };
}

type StatRow = { month: string; kind: string; issued: number; revoked: number; days: number };

/**
 * Small-cell protection: issued and revoked counts of 1–4 are hidden, with a second count hidden
 * where a single one could be worked out from the totals. Sick-leave days are hidden with their
 * certificate count (few certificates would reveal one person's leave), and the totals derived
 * from hidden values are hidden too when they would give a hidden value away.
 */
export function protectCertificateStats(rows: StatRow[]) {
  const issuedTotal = rows.reduce((a, r) => a + r.issued, 0);
  const revokedTotal = rows.reduce((a, r) => a + r.revoked, 0);
  const issued = suppressGroup(
    rows.map((r) => r.issued),
    issuedTotal,
  );
  const revoked = suppressGroup(
    rows.map((r) => r.revoked),
    revokedTotal,
  );
  const sickIdx = rows.flatMap((r, i) => (r.kind === 'SICK_LEAVE' ? [i] : []));
  const sickCount = sickIdx.reduce((a, i) => a + rows[i]!.issued, 0);
  const sickDays = sickIdx.reduce((a, i) => a + rows[i]!.days, 0);
  const daysHidden = rows.map((_, i) => issued.hidden[i]!);
  let sickTotalsHidden = sickCount > 0 && sickCount < THRESHOLD;
  // One hidden sick-leave month could be worked out from the total days: hide another, or the total.
  if (!sickTotalsHidden && sickIdx.filter((i) => daysHidden[i]).length === 1) {
    const other = sickIdx
      .filter((i) => !daysHidden[i] && rows[i]!.days > 0)
      .sort((a, b) => rows[a]!.days - rows[b]!.days)[0];
    if (other !== undefined) daysHidden[other] = true;
    else sickTotalsHidden = true;
  }
  return {
    smallCellThreshold: THRESHOLD,
    rows: rows.map((r, i) => ({
      month: r.month,
      kind: r.kind,
      issued: issued.hidden[i] ? null : r.issued,
      revoked: revoked.hidden[i] ? null : r.revoked,
      days: daysHidden[i] ? null : r.days,
    })),
    totals: {
      issued: issued.totalHidden ? null : issuedTotal,
      revoked: revoked.totalHidden ? null : revokedTotal,
      sickLeaveCertificates: sickTotalsHidden ? null : sickCount,
      sickLeaveDays: sickTotalsHidden ? null : sickDays,
      averageSickLeaveDays:
        sickTotalsHidden || !sickCount ? null : Math.round((sickDays / sickCount) * 10) / 10,
    },
  };
}

/** Ids of certificates that extend any of the given ones (still issued). */
export async function activeExtensionsOf(tx: Executor, ids: string[]) {
  if (!ids.length) return [];
  return tx
    .select({ id: medicalCertificates.id })
    .from(medicalCertificates)
    .where(
      and(
        inArray(medicalCertificates.extendsCertificateId, ids),
        eq(medicalCertificates.status, 'ISSUED'),
      ),
    );
}
