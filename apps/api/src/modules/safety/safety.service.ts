import { and, desc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, type Executor } from '../../db/client.js';
import { prescriptionAlerts, prescriptions, users } from '../../db/schema.js';
import { forbidden, HttpError } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { toLocale, type Locale } from '../../i18n/index.js';
import { resolveAndAuditRead } from '../access/policy.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  checkMedication,
  renderEnglish,
  storedToPublic,
  toPublicAlert,
  type EngineAlert,
} from './engine.js';

export async function localeOf(userId: string): Promise<Locale> {
  const [u] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, userId));
  return toLocale(u?.locale);
}

/**
 * Who may run safety checks for a patient: the treating team (clinical read access, audited by
 * the policy) and pharmacists of a facility where the patient has a prescription.
 */
export async function assertSafetyAccess(ctx: AuthContext, patientId: string, meta?: RequestMeta) {
  if (ctx.role === 'DOCTOR' || ctx.role === 'NURSE') {
    await resolveAndAuditRead(ctx, patientId, meta, 'medication-safety');
    return;
  }
  if (ctx.role === 'PHARMACIST' && ctx.facilityId) {
    const prescriber = alias(users, 'prescriber');
    const [row] = await db
      .select({ id: prescriptions.id })
      .from(prescriptions)
      .innerJoin(prescriber, eq(prescriber.id, prescriptions.doctorId))
      .where(and(eq(prescriptions.patientId, patientId), eq(prescriber.facilityId, ctx.facilityId)))
      .limit(1);
    if (row) return;
  }
  throw forbidden('Safety checks are available to the treating team and the pharmacy');
}

export interface Override {
  code: string;
  reason: string;
}

/**
 * Runs the engine for a new prescription. Blocking alerts (contraindicated or major) need an
 * override with a reason; otherwise 409 SAFETY_ALERTS with the alerts in the prescriber's language.
 */
export async function checkBeforePrescribing(
  ctx: AuthContext,
  input: {
    patientId: string;
    medication: string;
    catalogItemId?: string | null;
    overrides?: Override[];
  },
): Promise<EngineAlert[]> {
  const alerts = await checkMedication(input.patientId, input.medication, input.catalogItemId);
  const overridden = new Set((input.overrides ?? []).map((o) => o.code));
  const missing = alerts.filter((a) => a.blocking && !overridden.has(a.code));
  if (missing.length) {
    const locale = await localeOf(ctx.userId);
    throw new HttpError(
      409,
      'SAFETY_ALERTS',
      'This prescription has safety alerts that need a reason to proceed',
      { alerts: alerts.map((a) => toPublicAlert(a, locale)) },
    );
  }
  return alerts;
}

/** Stores the alerts of a new prescription (with override reasons) and audits overrides. */
export async function recordPrescriptionAlerts(
  tx: Executor,
  args: {
    ctx: AuthContext;
    meta?: RequestMeta;
    prescriptionId: string;
    patientId: string;
    alerts: EngineAlert[];
    overrides?: Override[];
  },
) {
  if (!args.alerts.length) return;
  const reasons = new Map((args.overrides ?? []).map((o) => [o.code, o.reason]));
  await tx.insert(prescriptionAlerts).values(
    args.alerts.map((a) => {
      const reason = a.blocking ? (reasons.get(a.code) ?? null) : null;
      return {
        prescriptionId: args.prescriptionId,
        patientId: args.patientId,
        kind: a.kind,
        severity: a.severity,
        message: renderEnglish(a).slice(0, 1000),
        details: {
          code: a.code,
          template: a.template,
          vars: a.vars,
          translateVars: a.translateVars ?? [],
          management: a.management,
          ...a.details,
        },
        overrideReason: reason,
        overriddenById: reason ? args.ctx.userId : null,
      };
    }),
  );
  const overridden = args.alerts.filter((a) => a.blocking && reasons.has(a.code));
  if (overridden.length) {
    await audit(
      {
        action: AuditAction.SAFETY_ALERT_OVERRIDDEN,
        actor: args.ctx,
        resourceType: 'prescription',
        resourceId: args.prescriptionId,
        patientId: args.patientId,
        meta: args.meta,
        metadata: {
          alerts: overridden.map((a) => ({
            code: a.code,
            severity: a.severity,
            reason: reasons.get(a.code),
          })),
        },
      },
      tx,
    );
  }
}

/** Stored alerts of prescriptions, translated for the reader, grouped by prescription id. */
export async function storedAlertsFor(
  where: { patientId?: string; prescriptionIds?: string[] },
  locale: Locale,
) {
  const overrider = alias(users, 'overrider');
  const conditions = [];
  if (where.patientId) conditions.push(eq(prescriptionAlerts.patientId, where.patientId));
  if (where.prescriptionIds) {
    if (!where.prescriptionIds.length)
      return new Map<string, ReturnType<typeof storedToPublic>[]>();
    conditions.push(inArray(prescriptionAlerts.prescriptionId, where.prescriptionIds));
  }
  const rows = await db
    .select({
      id: prescriptionAlerts.id,
      prescriptionId: prescriptionAlerts.prescriptionId,
      kind: prescriptionAlerts.kind,
      severity: prescriptionAlerts.severity,
      message: prescriptionAlerts.message,
      details: prescriptionAlerts.details,
      overrideReason: prescriptionAlerts.overrideReason,
      overriddenById: prescriptionAlerts.overriddenById,
      overriddenByName: overrider.fullName,
      createdAt: prescriptionAlerts.createdAt,
    })
    .from(prescriptionAlerts)
    .leftJoin(overrider, eq(overrider.id, prescriptionAlerts.overriddenById))
    .where(and(...conditions))
    .orderBy(desc(prescriptionAlerts.createdAt));
  const out = new Map<string, ReturnType<typeof storedToPublic>[]>();
  for (const r of rows) {
    out.set(r.prescriptionId, [...(out.get(r.prescriptionId) ?? []), storedToPublic(r, locale)]);
  }
  return out;
}
