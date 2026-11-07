import { Router } from 'express';
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { deathRecordAmendments, deathRecords, facilities, patients } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import { parse, requestMeta } from '../../lib/http.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { auditPartner, requireScope } from '../partner/partner.auth.js';
import { amendmentsFor, effectiveValues } from './deaths.service.js';

/**
 * Civil registry feed of signed death certificates (scope deaths.read). It carries what the
 * registry needs to register the death – identity, date and place – and never the causes. Every
 * certificate read is audited for that patient, so it appears in the record's access log under
 * the organisation's name. The registry acknowledges each death with its own reference.
 */
export const deathsPartnerRouter = Router();
deathsPartnerRouter.use(requireScope('deaths.read'));

deathsPartnerRouter.get('/', async (req, res) => {
  const client = req.partner!;
  const { since } = parse(z.object({ since: z.coerce.date().optional() }), req.query);
  const from = since ?? new Date(Date.now() - 30 * 86_400_000);
  const lastAmended = sql<Date | null>`(SELECT max(a.created_at) FROM ${deathRecordAmendments} a WHERE a.death_record_id = ${deathRecords.id})`;
  const rows = await db
    .select({
      record: deathRecords,
      nationalId: patients.nationalId,
      temporaryIdentity: patients.temporaryIdentity,
      firstName: patients.firstName,
      lastName: patients.lastName,
      sex: patients.sex,
      dateOfBirth: patients.dateOfBirth,
      municipality: patients.municipality,
      facilityCode: facilities.code,
      facilityName: facilities.name,
      lastAmendedAt: lastAmended,
    })
    .from(deathRecords)
    .innerJoin(patients, eq(patients.id, deathRecords.patientId))
    .innerJoin(facilities, eq(facilities.id, deathRecords.facilityId))
    .where(
      and(
        inArray(deathRecords.status, ['SIGNED', 'WITHDRAWN']),
        or(
          gte(deathRecords.signedAt, from),
          gte(deathRecords.withdrawnAt, from),
          sql`EXISTS (SELECT 1 FROM ${deathRecordAmendments} a WHERE a.death_record_id = ${deathRecords.id} AND a.created_at >= ${from})`,
        ),
      ),
    )
    .orderBy(desc(deathRecords.signedAt))
    .limit(500);
  const amendments = await amendmentsFor(rows.map((r) => r.record.id));
  for (const r of rows) {
    await auditPartner(req, client, {
      scope: 'deaths.read',
      patientId: r.record.patientId,
      result: 'death_certificate',
      extra: { certificateNumber: r.record.certificateNumber },
    });
  }
  if (!rows.length) await auditPartner(req, client, { scope: 'deaths.read', result: 'no_deaths' });
  res.json({
    since: from.toISOString(),
    items: rows.map((r) => {
      const v = effectiveValues(r.record, amendments.get(r.record.id) ?? []);
      return {
        certificateNumber: r.record.certificateNumber,
        /** SIGNED, or WITHDRAWN when the Ministry withdrew a certificate issued in error. */
        status: r.record.status,
        withdrawnAt: r.record.withdrawnAt,
        nationalId: r.nationalId,
        /** True for unidentified people and newborns without a national number yet. */
        temporaryIdentity: Boolean(r.temporaryIdentity),
        firstName: r.firstName,
        lastName: r.lastName,
        sex: r.sex,
        dateOfBirth: r.dateOfBirth,
        municipality: r.municipality,
        diedAt: v.diedAt,
        placeOfDeath: v.placeOfDeath,
        placeDetail: v.placeDetail,
        reportedToForensics: v.reportedToForensics,
        facilityCode: r.facilityCode,
        facilityName: r.facilityName,
        signedAt: r.record.signedAt,
        amendedAt: r.lastAmendedAt ? new Date(r.lastAmendedAt) : null,
        civilRegistryAcknowledgedAt: r.record.civilRegistryAcknowledgedAt,
        civilRegistryReference: r.record.civilRegistryReference,
      };
    }),
  });
});

const AckInput = z.object({ reference: z.string().trim().min(1).max(60) });

/** The registry confirms it registered the death (idempotent for the same reference). */
deathsPartnerRouter.post('/:certificateNumber/acknowledge', async (req, res) => {
  const client = req.partner!;
  const { certificateNumber } = parse(
    z.object({ certificateNumber: z.string().regex(/^VD-\d{4}-\d{6}$/) }),
    req.params,
  );
  const { reference } = parse(AckInput, req.body);
  const [row] = await db
    .select()
    .from(deathRecords)
    .where(
      and(
        eq(deathRecords.certificateNumber, certificateNumber),
        inArray(deathRecords.status, ['SIGNED']),
      ),
    );
  if (!row) {
    await auditPartner(req, client, {
      scope: 'deaths.read',
      outcome: 'FAILURE',
      result: 'not_found',
      extra: { certificateNumber },
    });
    throw notFound('Death certificate not found');
  }
  if (row.civilRegistryAcknowledgedAt) {
    if (row.civilRegistryReference === reference) {
      res.json({
        certificateNumber,
        civilRegistryAcknowledgedAt: row.civilRegistryAcknowledgedAt,
        civilRegistryReference: row.civilRegistryReference,
      });
      return;
    }
    throw conflict('This death was already registered under another reference');
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(deathRecords)
      .set({ civilRegistryAcknowledgedAt: now, civilRegistryReference: reference })
      .where(eq(deathRecords.id, row.id));
    await audit(
      {
        action: AuditAction.DEATH_REGISTRY_ACKNOWLEDGED,
        actor: null,
        resourceType: 'death_record',
        resourceId: row.id,
        patientId: row.patientId,
        meta: requestMeta(req),
        metadata: {
          via: 'PARTNER_API',
          clientId: client.id,
          actorLabel: `${client.name} (API)`,
          certificateNumber,
          reference,
        },
      },
      tx,
    );
  });
  await auditPartner(req, client, {
    scope: 'deaths.read',
    patientId: row.patientId,
    result: 'acknowledged',
    extra: { certificateNumber },
  });
  res.json({
    certificateNumber,
    civilRegistryAcknowledgedAt: now,
    civilRegistryReference: reference,
  });
});
