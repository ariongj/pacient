import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { consentDecisionEnum, consentMethodEnum, consentTypeEnum } from '../../db/schema.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import {
  assertClinicalWriteAccess,
  assertDemographicsAccess,
  resolveClinicalReadAccess,
  WRITERS,
} from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyPatient } from '../notifications/notifications.service.js';
import {
  assertConsentForm,
  consentHistory,
  currentFromHistory,
  recordConsent,
  treatmentFromHistory,
} from './consent.service.js';
import { CONSENT_TEXTS } from './texts.js';

/**
 * Consent records (blueprint §2/§3: purpose and consent). Patients – or a guardian with full
 * scope – manage record sharing and research use in the portal; doctors record treatment consent
 * and decisions taken in clinic. Every decision is a new, immutable row.
 */
const PatientParam = z.object({ patientId: z.string().uuid() });

const RecordSchema = z.object({
  type: z.enum(consentTypeEnum.enumValues),
  decision: z.enum(consentDecisionEnum.enumValues),
  method: z.enum(consentMethodEnum.enumValues).optional(),
  procedure: z.string().trim().min(2).max(200).optional(),
  note: z.string().trim().max(1000).optional(),
  documentId: z.string().uuid().optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

export const consentRouter = Router({ mergeParams: true });
consentRouter.use(authenticate);

consentRouter.get('/', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const meta = requestMeta(req);

  if (ctx.role === 'RECEPTION') {
    // Front desk: whether sharing/research is agreed, never treatment details or notes.
    await assertDemographicsAccess(ctx, patientId);
    const history = (await consentHistory(patientId)).filter((r) => r.type !== 'TREATMENT');
    await audit({
      action: AuditAction.PATIENT_RECORD_VIEWED,
      actor: ctx,
      resourceType: 'patient',
      resourceId: patientId,
      patientId,
      meta,
      metadata: { section: 'consents', basis: 'FACILITY' },
    });
    res.json({
      current: currentFromHistory(history),
      treatment: [],
      history: history.map(({ note: _n, documentId: _d, ...r }) => r),
      texts: CONSENT_TEXTS.filter((t) => t.type !== 'TREATMENT'),
    });
    return;
  }
  // Patients, guardians (full scope) and the care team; directors, the Ministry and pharmacists are
  // refused (and the refusal audited) like any other clinical read.
  const basis = await resolveClinicalReadAccess(ctx, patientId, meta);
  if (basis !== 'SELF') {
    await audit({
      action: AuditAction.PATIENT_RECORD_VIEWED,
      actor: ctx,
      resourceType: 'patient',
      resourceId: patientId,
      patientId,
      meta,
      metadata: { section: 'consents', basis },
    });
  }
  const history = await consentHistory(patientId);
  res.json({
    current: currentFromHistory(history),
    treatment: treatmentFromHistory(history),
    history,
    texts: CONSENT_TEXTS,
  });
});

consentRouter.post('/', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  const input = parse(RecordSchema, req.body);
  const meta = requestMeta(req);

  if (ctx.role === 'PATIENT') {
    // SELF or GUARDIAN (full scope); appointments-only guardians are refused here.
    await resolveClinicalReadAccess(ctx, patientId, meta);
    if (input.type === 'TREATMENT') {
      throw forbidden('Treatment consent is recorded by your doctor');
    }
    if (input.decision === 'REFUSED') throw badRequest('Choose to grant or withdraw');
    const row = await db.transaction((tx) =>
      recordConsent(
        tx,
        ctx,
        {
          patientId,
          type: input.type,
          decision: input.decision,
          method: 'PORTAL',
          note: input.note ?? null,
          onBehalfGuardianshipId: ctx.proxy?.guardianshipId ?? null,
        },
        meta,
      ),
    );
    res.status(201).json(row);
    return;
  }

  await assertClinicalWriteAccess(ctx, patientId, meta, WRITERS.doctorOnly);
  const method = input.method ?? 'IN_PERSON';
  if (method === 'PORTAL')
    throw badRequest('Clinicians record consent given in person or in writing');
  if (input.type === 'TREATMENT' && !input.procedure) {
    throw badRequest('Name the treatment or procedure');
  }
  const row = await db.transaction(async (tx) => {
    if (method === 'WRITTEN') await assertConsentForm(patientId, input.documentId, tx);
    const created = await recordConsent(
      tx,
      ctx,
      {
        patientId,
        type: input.type,
        decision: input.decision,
        method,
        procedure: input.procedure ?? null,
        note: input.note ?? null,
        documentId: method === 'WRITTEN' ? input.documentId : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      },
      meta,
    );
    await notifyPatient(
      patientId,
      {
        type: 'consent',
        title: 'A consent decision was recorded in your record',
        link: '/portal/consents',
      },
      tx,
    );
    return created;
  });
  res.status(201).json(row);
});
