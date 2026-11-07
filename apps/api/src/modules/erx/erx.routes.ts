import { Router } from 'express';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { encounters, patients, prescriptions } from '../../db/schema.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { assertClinicalWriteAccess, resolveAndAuditRead } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import {
  atcOf,
  dispensingsFor,
  eprescriptionStatus,
  eprescriptionTerms,
  formatCode,
  EPrescriptionRequestSchema,
  issueEPrescription,
  notifyEPrescriptionCancelled,
  presentDispensings,
  recordIssued,
} from './erx.service.js';

/**
 * National e-prescriptions: the patient's list (care team, patient, guardian), issuing an existing
 * prescription as an e-prescription, cancelling, the prescriber's own list and statistics.
 * Community pharmacies use the partner API (partner.ts).
 */
export const ePrescriptionsRouter = Router();
ePrescriptionsRouter.use(authenticate);

const PatientParam = z.object({ patientId: z.string().uuid() });
const PrescriptionParam = z.object({ prescriptionId: z.string().uuid() });

type RxRow = typeof prescriptions.$inferSelect;

async function present(rows: RxRow[], opts: { withCode: boolean }) {
  const dispensings = await dispensingsFor(rows.map((r) => r.id));
  return rows.map((rx) => {
    const list = dispensings.get(rx.id) ?? [];
    return {
      prescriptionId: rx.id,
      code: opts.withCode ? formatCode(rx.ePrescriptionCode!) : null,
      medication: rx.medication,
      dosage: rx.dosage,
      frequency: rx.frequency,
      instructions: rx.instructions,
      issuedAt: rx.createdAt,
      validUntil: rx.communityValidUntil,
      repeatsAllowed: rx.repeatsAllowed,
      ...eprescriptionStatus(rx, list),
      dispensings: presentDispensings(list),
    };
  });
}

/** Who may see a patient's e-prescriptions: the care team, the patient and full guardians. */
ePrescriptionsRouter.get('/patients/:patientId', async (req, res) => {
  const ctx = requireAuth(req);
  const { patientId } = parse(PatientParam, req.params);
  if (!['DOCTOR', 'NURSE', 'PATIENT'].includes(ctx.role)) {
    throw forbidden('E-prescriptions are only available to the care team and the patient');
  }
  const basis = await resolveAndAuditRead(ctx, patientId, requestMeta(req), 'e-prescriptions');
  const rows = await db
    .select({ rx: prescriptions, confidential: encounters.confidentialFromGuardians })
    .from(prescriptions)
    .leftJoin(encounters, eq(encounters.id, prescriptions.encounterId))
    .where(and(eq(prescriptions.patientId, patientId), isNotNull(prescriptions.ePrescriptionCode)))
    .orderBy(desc(prescriptions.createdAt));
  const visible = rows.filter((r) => basis !== 'GUARDIAN' || !r.confidential).map((r) => r.rx);
  res.json({ items: await present(visible, { withCode: true }) });
});

/** Issue an existing active prescription as an e-prescription (if it is not one already). */
ePrescriptionsRouter.post('/prescriptions/:prescriptionId/issue', async (req, res) => {
  const ctx = requireAuth(req);
  const { prescriptionId } = parse(PrescriptionParam, req.params);
  const input = parse(EPrescriptionRequestSchema, req.body ?? {});
  const [rx] = await db.select().from(prescriptions).where(eq(prescriptions.id, prescriptionId));
  if (!rx) throw notFound('Prescription not found');
  await assertClinicalWriteAccess(ctx, rx.patientId, requestMeta(req));
  if (rx.status !== 'ACTIVE') throw conflict('Only an active prescription can be sent');
  if (rx.ePrescriptionCode) throw conflict('This prescription is already an e-prescription');
  const terms = eprescriptionTerms(input, {
    atcCode: await atcOf(rx.catalogItemId),
    medication: rx.medication,
  });
  const issued = await db.transaction(async (tx) => {
    const row = await issueEPrescription(tx, rx.id, rx.startDate, terms);
    await recordIssued(tx, ctx, req, row, terms.controlled);
    return row;
  });
  const [item] = await present([issued], { withCode: true });
  res.status(201).json({ ...item, controlled: terms.controlled });
});

const CancelBody = z.object({ reason: z.string().trim().min(5).max(500) });

/** Cancel an e-prescription: no pharmacy can dispense it any more. */
ePrescriptionsRouter.post('/prescriptions/:prescriptionId/cancel', async (req, res) => {
  const ctx = requireAuth(req);
  const { prescriptionId } = parse(PrescriptionParam, req.params);
  const { reason } = parse(CancelBody, req.body);
  const [rx] = await db.select().from(prescriptions).where(eq(prescriptions.id, prescriptionId));
  if (!rx) throw notFound('Prescription not found');
  await assertClinicalWriteAccess(ctx, rx.patientId, requestMeta(req));
  if (!rx.ePrescriptionCode) throw conflict('This prescription is not an e-prescription');
  if (rx.status !== 'ACTIVE') throw conflict('This e-prescription is no longer active');
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(prescriptions)
      .set({ status: 'CANCELLED', endDate: new Date().toISOString().slice(0, 10) })
      .where(and(eq(prescriptions.id, rx.id), eq(prescriptions.status, 'ACTIVE')))
      .returning();
    if (!row) throw conflict('This e-prescription is no longer active');
    await audit(
      {
        action: AuditAction.EPRESCRIPTION_CANCELLED,
        actor: ctx,
        resourceType: 'prescription',
        resourceId: rx.id,
        patientId: rx.patientId,
        meta: requestMeta(req),
        metadata: { reason },
      },
      tx,
    );
    await notifyEPrescriptionCancelled(tx, row);
    return row;
  });
  const [item] = await present([updated], { withCode: true });
  res.json(item);
});

/** The prescriber's recent e-prescriptions and their status. */
ePrescriptionsRouter.get('/mine', requireRole('DOCTOR'), async (req, res) => {
  const ctx = requireAuth(req);
  const rows = await db
    .select({ rx: prescriptions, firstName: patients.firstName, lastName: patients.lastName })
    .from(prescriptions)
    .innerJoin(patients, eq(patients.id, prescriptions.patientId))
    .where(and(eq(prescriptions.doctorId, ctx.userId), isNotNull(prescriptions.ePrescriptionCode)))
    .orderBy(desc(prescriptions.createdAt))
    .limit(50);
  const items = await present(
    rows.map((r) => r.rx),
    { withCode: false },
  );
  res.json({
    items: items.map((item, i) => ({
      ...item,
      patientId: rows[i]!.rx.patientId,
      patientName: `${rows[i]!.firstName} ${rows[i]!.lastName}`,
    })),
  });
});

/* ------------------------------------------------------------------ statistics ----------- */

const suppress = (n: number) =>
  n > 0 && n < SMALL_CELL_THRESHOLD
    ? { value: null, suppressed: true }
    : { value: n, suppressed: false };

/** ATC anatomical main groups (first letter). */
const ATC_GROUPS = ['A', 'B', 'C', 'D', 'G', 'H', 'J', 'L', 'M', 'N', 'P', 'R', 'S', 'V'];

/**
 * Facility (director) or national (Ministry) statistics. Counts below the small-cell threshold are
 * suppressed; no patients appear. A prescription belongs to the facility of its prescriber.
 */
ePrescriptionsRouter.get('/stats', requireRole('DIRECTOR', 'MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { months } = parse(
    z.object({ months: z.coerce.number().int().min(1).max(24).default(12) }),
    req.query,
  );
  const national = ctx.role === 'MINISTRY';
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months + 1, 1);
  since.setUTCHours(0, 0, 0, 0);
  const scope = national ? sql`TRUE` : sql`u.facility_id = ${ctx.facilityId}`;
  const effective = sql`d.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM community_dispensings r WHERE r.reverses_id = d.id)`;
  const base = sql`
    FROM prescriptions p
    JOIN users u ON u.id = p.doctor_id
    LEFT JOIN medication_catalog m ON m.id = p.catalog_item_id
    WHERE p.e_prescription_code IS NOT NULL AND p.created_at >= ${since} AND ${scope}`;

  const [totals, byMonth, topMedicines, byAtc, pharmacies] = await Promise.all([
    db.execute<{
      issued: number;
      dispensed: number;
      cancelled: number;
      median_hours: number | null;
    }>(sql`
      WITH rx AS (
        SELECT p.id, p.status, p.created_at,
          (SELECT min(d.dispensed_at) FROM community_dispensings d
            WHERE d.prescription_id = p.id AND ${effective}) AS first_dispensed
        ${base}
      )
      SELECT count(*)::int AS issued,
        count(first_dispensed)::int AS dispensed,
        count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY extract(epoch FROM first_dispensed - created_at) / 3600
        ) AS median_hours
      FROM rx`),
    db.execute<{ month: string; issued: number; dispensed: number }>(sql`
      SELECT to_char(date_trunc('month', p.created_at AT TIME ZONE 'Europe/Belgrade'), 'YYYY-MM') AS month,
        count(*)::int AS issued,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM community_dispensings d WHERE d.prescription_id = p.id AND ${effective}
        ))::int AS dispensed
      ${base}
      GROUP BY 1 ORDER BY 1`),
    db.execute<{ name: string; issued: number }>(sql`
      SELECT coalesce(m.name, initcap(split_part(p.medication, ' ', 1))) AS name, count(*)::int AS issued
      ${base}
      GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`),
    db.execute<{ group: string | null; issued: number }>(sql`
      SELECT upper(left(m.atc_code, 1)) AS "group", count(*)::int AS issued
      ${base}
      GROUP BY 1 ORDER BY 2 DESC`),
    national
      ? db.execute<{ name: string; supplies: number }>(sql`
          SELECT c.name, count(*)::int AS supplies
          FROM community_dispensings d
          JOIN partner_clients c ON c.id = d.partner_client_id
          JOIN prescriptions p ON p.id = d.prescription_id
          WHERE ${effective} AND d.dispensed_at >= ${since}
          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`)
      : Promise.resolve(null),
  ]);
  const t = totals.rows[0] ?? { issued: 0, dispensed: 0, cancelled: 0, median_hours: null };
  res.json({
    scope: national ? 'NATIONAL' : 'FACILITY',
    since: since.toISOString().slice(0, 10),
    smallCellThreshold: SMALL_CELL_THRESHOLD,
    issued: suppress(t.issued),
    dispensed: suppress(t.dispensed),
    cancelled: suppress(t.cancelled),
    dispensedPct:
      t.issued >= SMALL_CELL_THRESHOLD ? Math.round((t.dispensed / t.issued) * 1000) / 10 : null,
    medianHoursToFirstDispensing:
      t.dispensed >= SMALL_CELL_THRESHOLD && t.median_hours !== null
        ? Math.round(Number(t.median_hours) * 10) / 10
        : null,
    byMonth: byMonth.rows.map((r) => ({
      month: r.month,
      issued: suppress(r.issued),
      dispensed: suppress(r.dispensed),
    })),
    topMedicines: topMedicines.rows.map((r) => ({ name: r.name, issued: suppress(r.issued) })),
    byAtcGroup: byAtc.rows.map((r) => ({
      group: r.group && ATC_GROUPS.includes(r.group) ? r.group : null,
      issued: suppress(r.issued),
    })),
    pharmacies: pharmacies
      ? pharmacies.rows.map((r) => ({ name: r.name, supplies: suppress(r.supplies) }))
      : null,
  });
});
