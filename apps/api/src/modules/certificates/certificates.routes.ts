import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Executor } from '../../db/client.js';
import { encounters, medicalCertificates, patients, users } from '../../db/schema.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth, type AuthContext } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  getPatientOrThrow,
  resolveAndAuditRead,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { kosovoDate } from '../identity/identity.service.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import {
  activeExtensionsOf,
  certificateForPrint,
  certificateStats,
  daysCovered,
  IssueCertificateSchema,
  listPatientCertificates,
  newVerificationCode,
  nextSerialNumber,
  validateNewCertificate,
  verificationUrl,
} from './certificates.service.js';

/** Medical certificates: issue, list, print, revoke, statistics. See certificates.service.ts. */
export const certificatesRouter = Router();
certificatesRouter.use(authenticate);

const PatientParam = z.object({ patientId: z.string().uuid() });
const IdParam = z.object({ id: z.string().uuid() });

/** Who may see a patient's certificates: the care team, the patient and full-scope guardians. */
async function readAccess(
  ctx: AuthContext,
  patientId: string,
  meta: ReturnType<typeof requestMeta>,
) {
  if (!['DOCTOR', 'NURSE', 'PATIENT'].includes(ctx.role)) {
    // Reception, pharmacy, directors and the Ministry never see certificates of named patients
    // (they may carry a diagnosis); directors see facility statistics.
    throw forbidden('Medical certificates are only available to the care team and the patient');
  }
  return resolveAndAuditRead(ctx, patientId, meta, 'certificates');
}

/* ------------------------------------------------------------------ statistics ----------- */

const StatsQuery = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  facilityId: z.string().uuid().optional(),
});

certificatesRouter.get('/stats', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(StatsQuery, req.query);
  const to = q.to ?? kosovoDate(new Date());
  const from = q.from ?? `${String(Number(to.slice(0, 4)) - 1)}${to.slice(4, 8)}01`;
  if (from > to) throw badRequest('The start date must be before the end date.');
  const facilityId = ctx.role === 'DIRECTOR' ? ctx.facilityId : (q.facilityId ?? null);
  if (ctx.role === 'DIRECTOR' && !facilityId) throw forbidden();
  res.json(await certificateStats({ facilityId, from, to }));
});

/* -------------------------------------------------------------- issued by me ------------ */

/** The signed-in doctor's most recently issued certificates (no diagnosis in the list). */
certificatesRouter.get('/mine', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const rows = await db
    .select({
      id: medicalCertificates.id,
      kind: medicalCertificates.kind,
      serialNumber: medicalCertificates.serialNumber,
      startDate: medicalCertificates.startDate,
      endDate: medicalCertificates.endDate,
      status: medicalCertificates.status,
      issuedAt: medicalCertificates.issuedAt,
      patientId: patients.id,
      firstName: patients.firstName,
      lastName: patients.lastName,
    })
    .from(medicalCertificates)
    .innerJoin(patients, eq(patients.id, medicalCertificates.patientId))
    .where(eq(medicalCertificates.issuedById, ctx.userId))
    .orderBy(desc(medicalCertificates.issuedAt))
    .limit(50);
  res.json({
    items: rows.map(({ firstName, lastName, ...r }) => ({
      ...r,
      patientName: `${firstName} ${lastName}`,
    })),
  });
});

/* --------------------------------------------------------- director lookup by number ------ */

/** Directors find a certificate of their facility by its number (e.g. to revoke it). */
certificatesRouter.get('/by-serial/:serial', requireRole('DIRECTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const serial = String(req.params.serial).trim().toUpperCase();
  const [row] = await db
    .select({
      id: medicalCertificates.id,
      kind: medicalCertificates.kind,
      serialNumber: medicalCertificates.serialNumber,
      startDate: medicalCertificates.startDate,
      endDate: medicalCertificates.endDate,
      status: medicalCertificates.status,
      issuedAt: medicalCertificates.issuedAt,
      revokedAt: medicalCertificates.revokedAt,
      revokeReason: medicalCertificates.revokeReason,
      issuedByName: users.fullName,
      patientId: patients.id,
      patientName: patients.firstName,
      patientLastName: patients.lastName,
    })
    .from(medicalCertificates)
    .innerJoin(users, eq(users.id, medicalCertificates.issuedById))
    .innerJoin(patients, eq(patients.id, medicalCertificates.patientId))
    .where(
      and(
        eq(medicalCertificates.serialNumber, serial),
        eq(medicalCertificates.facilityId, ctx.facilityId ?? ''),
      ),
    );
  if (!row) throw notFound('No certificate with this number at your facility');
  const { patientName, patientLastName, ...rest } = row;
  res.json({ ...rest, patientName: `${patientName} ${patientLastName}` });
});

/* --------------------------------------------------------------- per patient ------------- */

certificatesRouter.get('/patients/:patientId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const basis = await readAccess(ctx, patientId, requestMeta(req));
  res.json({
    items: await listPatientCertificates(patientId, { hideConfidential: basis === 'GUARDIAN' }),
  });
});

certificatesRouter.post('/patients/:patientId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const meta = requestMeta(req);
  const basis = await assertClinicalWriteAccess(ctx, patientId, meta);
  if (basis === 'EMERGENCY') {
    throw forbidden('Certificates are issued by the treating doctor, not under emergency access');
  }
  if (!ctx.facilityId) throw forbidden('Your account is not linked to a facility');
  const input = parse(IssueCertificateSchema, req.body);
  const patient = await getPatientOrThrow(patientId);
  const today = kosovoDate(new Date());

  const result = await db.transaction(async (tx) => {
    const { warnings, chainTotal } = await validateNewCertificate(tx, patient, input, today);
    const serialNumber = await nextSerialNumber(tx, ctx.facilityId!, today);
    const [created] = await tx
      .insert(medicalCertificates)
      .values({
        patientId,
        facilityId: ctx.facilityId!,
        issuedById: ctx.userId,
        encounterId: input.encounterId ?? null,
        kind: input.kind,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        icd10Code: input.icd10Code ?? null,
        diagnosisOnCertificate: input.diagnosisOnCertificate,
        outcome: input.outcome ?? null,
        restrictions: input.restrictions?.trim() || null,
        purpose: input.purpose?.trim() || null,
        remarks: input.remarks?.trim() || null,
        extendsCertificateId: input.extendsCertificateId ?? null,
        serialNumber,
        verificationCode: newVerificationCode(),
      })
      .returning();
    await audit(
      {
        action: AuditAction.CERTIFICATE_ISSUED,
        actor: ctx,
        resourceType: 'medical_certificate',
        resourceId: created!.id,
        patientId,
        meta,
        metadata: {
          kind: input.kind,
          serialNumber,
          days: input.endDate ? daysCovered(input.startDate, input.endDate) : null,
          extendsCertificateId: input.extendsCertificateId ?? null,
        },
      },
      tx,
    );
    const confidential = input.encounterId
      ? await isConfidentialEncounter(tx, input.encounterId)
      : false;
    await notifyPatient(
      patientId,
      {
        type: 'certificate',
        title: 'A medical certificate was issued for you',
        link: '/portal/certificates',
      },
      tx,
      { guardians: confidential ? 'none' : 'full' },
    );
    return { created: created!, warnings, chainTotal };
  });
  const { verificationCode, ...cert } = result.created;
  res.status(201).json({
    ...cert,
    verificationUrl: verificationUrl(verificationCode),
    chainDays: result.chainTotal,
    warnings: result.warnings,
  });
});

async function isConfidentialEncounter(tx: Executor, id: string) {
  const [row] = await tx
    .select({ c: encounters.confidentialFromGuardians })
    .from(encounters)
    .where(eq(encounters.id, id));
  return Boolean(row?.c);
}

/* --------------------------------------------------------------- one certificate --------- */

/** Full certificate for printing, with the verification link (care team, patient, guardian). */
certificatesRouter.get('/:id', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const row = await certificateForPrint(id);
  if (!row) throw notFound('Certificate not found');
  const basis = await readAccess(ctx, row.cert.patientId, requestMeta(req));
  if (basis === 'GUARDIAN' && row.encounterConfidential) throw notFound('Certificate not found');
  const { verificationCode, ...cert } = row.cert;
  res.json({
    ...cert,
    days: cert.endDate ? daysCovered(cert.startDate, cert.endDate) : null,
    verificationUrl: verificationUrl(verificationCode),
    patient: row.patient,
    doctor: row.doctor,
    facility: row.facility,
  });
});

const RevokeSchema = z.object({ reason: z.string().trim().min(5).max(300) });

/** The issuing doctor or the director of the issuing facility revokes a certificate. */
certificatesRouter.post('/:id/revoke', async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(IdParam, req.params);
  const { reason } = parse(RevokeSchema, req.body);
  const meta = requestMeta(req);
  const updated = await db.transaction(async (tx) => {
    const [cert] = await tx
      .select()
      .from(medicalCertificates)
      .where(eq(medicalCertificates.id, id))
      .for('update');
    if (!cert) throw notFound('Certificate not found');
    const isIssuer = ctx.role === 'DOCTOR' && cert.issuedById === ctx.userId;
    const isDirector = ctx.role === 'DIRECTOR' && cert.facilityId === ctx.facilityId;
    if (!isIssuer && !isDirector) {
      await audit(
        {
          action: AuditAction.CERTIFICATE_REVOKED,
          actor: ctx,
          resourceType: 'medical_certificate',
          resourceId: id,
          patientId: cert.patientId,
          outcome: 'DENIED',
          meta,
        },
        tx,
      );
      throw forbidden('Only the issuing doctor or the facility director can revoke a certificate');
    }
    if (cert.status === 'REVOKED') throw conflict('This certificate has already been revoked');
    if ((await activeExtensionsOf(tx, [cert.id])).length) {
      throw conflict('Revoke the extension of this certificate first');
    }
    const [row] = await tx
      .update(medicalCertificates)
      .set({
        status: 'REVOKED',
        revokedAt: new Date(),
        revokedById: ctx.userId,
        revokeReason: reason,
      })
      .where(eq(medicalCertificates.id, id))
      .returning();
    await audit(
      {
        action: AuditAction.CERTIFICATE_REVOKED,
        actor: ctx,
        resourceType: 'medical_certificate',
        resourceId: id,
        patientId: cert.patientId,
        meta,
        metadata: { serialNumber: cert.serialNumber, reason },
      },
      tx,
    );
    const confidential = cert.encounterId
      ? await isConfidentialEncounter(tx, cert.encounterId)
      : false;
    await notifyPatient(
      cert.patientId,
      {
        type: 'certificate',
        title: 'A medical certificate was revoked',
        link: '/portal/certificates',
      },
      tx,
      { guardians: confidential ? 'none' : 'full' },
    );
    return row!;
  });
  const { verificationCode: _code, ...cert } = updated;
  res.json(cert);
});
