import { Router } from 'express';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { caseReports, facilities, notifiableDiseases, patients } from '../../db/schema.js';
import { parse } from '../../lib/http.js';
import { auditPartner, requireScope } from '../partner/partner.auth.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import { buildDashboard, casesForStats } from './surveillance.service.js';

/**
 * Feed for the National Institute of Public Health (scope surveillance.read): submitted case
 * reports with minimal identifiers, and weekly aggregates with small-cell suppression. Every
 * patient-level read is audited for that patient, so it appears in their access log under the
 * organisation's name.
 */
export const surveillancePartnerRouter = Router();
surveillancePartnerRouter.use(requireScope('surveillance.read'));

const ageAt = (dob: string, at: Date) => {
  const d = new Date(`${dob}T00:00:00Z`);
  let a = at.getUTCFullYear() - d.getUTCFullYear();
  const m = at.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) a--;
  return a;
};

surveillancePartnerRouter.get('/cases', async (req, res) => {
  const client = req.partner!;
  const { since } = parse(z.object({ since: z.coerce.date().optional() }), req.query);
  const from = since ?? new Date(Date.now() - 7 * 86_400_000);
  const rows = await db
    .select({
      caseId: caseReports.id,
      patientId: patients.id,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      municipality: patients.municipality,
      diseaseCode: notifiableDiseases.code,
      diseaseName: notifiableDiseases.name,
      urgency: notifiableDiseases.urgency,
      onsetDate: caseReports.onsetDate,
      classification: caseReports.classification,
      status: caseReports.status,
      facilityCode: facilities.code,
      submittedAt: caseReports.submittedAt,
      reviewedAt: caseReports.reviewedAt,
    })
    .from(caseReports)
    .innerJoin(notifiableDiseases, eq(notifiableDiseases.id, caseReports.diseaseId))
    .innerJoin(patients, eq(patients.id, caseReports.patientId))
    .innerJoin(facilities, eq(facilities.id, caseReports.facilityId))
    .where(
      and(
        inArray(caseReports.status, ['SUBMITTED', 'REVIEWED']),
        gte(caseReports.submittedAt, from),
      ),
    )
    .orderBy(desc(caseReports.submittedAt))
    .limit(500);
  for (const r of rows) {
    await auditPartner(req, client, {
      scope: 'surveillance.read',
      purpose: 'PUBLIC_HEALTH',
      patientId: r.patientId,
      result: 'case_report',
      extra: { caseId: r.caseId, disease: r.diseaseCode },
    });
  }
  if (!rows.length) {
    await auditPartner(req, client, { scope: 'surveillance.read', result: 'no_cases' });
  }
  res.json({
    since: from.toISOString(),
    items: rows.map(({ patientId: _p, dateOfBirth, submittedAt, ...r }) => ({
      ...r,
      age: ageAt(dateOfBirth, submittedAt ?? new Date()),
      submittedAt,
    })),
  });
});

surveillancePartnerRouter.get('/summary', async (req, res) => {
  const client = req.partner!;
  const { weeks } = parse(
    z.object({ weeks: z.coerce.number().int().min(4).max(52).default(12) }),
    req.query,
  );
  const now = new Date();
  const cases = await casesForStats({
    from: new Date(now.getTime() - (weeks + 5) * 7 * 86_400_000),
    statuses: ['SUBMITTED', 'REVIEWED'],
  });
  const d = buildDashboard(cases, now, weeks);
  const suppress = (n: number) => (n > 0 && n < SMALL_CELL_THRESHOLD ? null : n);
  await auditPartner(req, client, { scope: 'surveillance.read', result: 'summary' });
  res.json({
    weeks: d.weeks,
    suppressionThreshold: d.suppressionThreshold,
    diseases: d.diseases.map((x) => ({
      code: x.code,
      name: x.name,
      urgency: x.urgency,
      total: suppress(x.total),
      counts: x.counts.map(suppress),
    })),
    municipalities: d.municipalities,
    alerts: d.alerts.map((a) => ({ ...a, count: suppress(a.count) })),
  });
});
