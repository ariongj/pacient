import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { isTest } from '../../config/env.js';
import { db, type Executor } from '../../db/client.js';
import { caseReports, diagnoses, notifiableDiseases, patients, users } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { notifyFacilityRole, notifyUsers } from '../notifications/notifications.service.js';
import { SMALL_CELL_THRESHOLD } from '../stats/stats.service.js';
import { DEFAULT_DISEASES, matchDisease, normaliseIcd } from './diseases.js';

/** Diagnoses older than this are not turned into case reports by the detector. */
export const DETECTION_LOOKBACK_DAYS = 90;

/** Inserts the default disease list (missing codes only). */
export async function ensureDefaultDiseases(executor: Executor = db) {
  await executor
    .insert(notifiableDiseases)
    .values(DEFAULT_DISEASES.map((d) => ({ ...d })))
    .onConflictDoNothing({ target: notifiableDiseases.code });
}

export async function activeDiseases(executor: Executor = db) {
  return executor.select().from(notifiableDiseases).where(eq(notifiableDiseases.isActive, true));
}

/**
 * Turns recent diagnoses of notifiable diseases into DRAFT case reports, once per diagnosis
 * (unique diagnosis_id + ON CONFLICT DO NOTHING – safe with several API instances). The
 * diagnosing doctor is asked to complete the report; for immediately notifiable diseases the
 * facility's director is alerted too. Notifications are generic (no disease or patient names).
 */
export async function detectCasesOnce(now = new Date()): Promise<{ created: number }> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifiableDiseases);
  if (!n) await ensureDefaultDiseases();
  const diseases = await activeDiseases();
  if (!diseases.length) return { created: 0 };

  const prefixes = [...new Set(diseases.flatMap((d) => d.icd10Prefixes.map(normaliseIcd)))];
  const since = new Date(now.getTime() - DETECTION_LOOKBACK_DAYS * 86_400_000);
  const candidates = await db
    .select({
      id: diagnoses.id,
      patientId: diagnoses.patientId,
      doctorId: diagnoses.doctorId,
      icd10Code: diagnoses.icd10Code,
      diagnosedAt: diagnoses.diagnosedAt,
      doctorFacilityId: users.facilityId,
      patientFacilityId: patients.primaryFacilityId,
    })
    .from(diagnoses)
    .innerJoin(patients, eq(patients.id, diagnoses.patientId))
    .innerJoin(users, eq(users.id, diagnoses.doctorId))
    .leftJoin(caseReports, eq(caseReports.diagnosisId, diagnoses.id))
    .where(
      and(
        isNull(caseReports.id),
        isNull(patients.mergedIntoId),
        gt(diagnoses.diagnosedAt, since),
        sql`upper(replace(${diagnoses.icd10Code}, '.', '')) LIKE ANY (${sql.raw(
          `ARRAY[${prefixes.map((p) => `'${p.replace(/[^A-Z0-9]/g, '')}%'`).join(',')}]`,
        )})`,
      ),
    )
    .limit(500);

  let created = 0;
  for (const c of candidates) {
    const disease = matchDisease(c.icd10Code, diseases);
    if (!disease) continue;
    const facilityId = c.doctorFacilityId ?? c.patientFacilityId;
    const inserted = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(caseReports)
        .values({
          patientId: c.patientId,
          diseaseId: disease.id,
          diagnosisId: c.id,
          facilityId,
          classification: 'SUSPECTED',
          status: 'DRAFT',
          onsetDate: c.diagnosedAt.toISOString().slice(0, 10),
          reportedById: c.doctorId,
        })
        .onConflictDoNothing({ target: caseReports.diagnosisId })
        .returning({ id: caseReports.id });
      if (!row) return null;
      await audit(
        {
          action: AuditAction.CASE_REPORT_CREATED,
          actor: null,
          resourceType: 'case_report',
          resourceId: row.id,
          patientId: c.patientId,
          metadata: { disease: disease.code, urgency: disease.urgency, automatic: true },
        },
        tx,
      );
      await notifyUsers(
        [c.doctorId],
        {
          type: 'surveillance',
          title: 'A notifiable disease case report needs completing',
          link: '/surveillance',
          important: disease.urgency === 'IMMEDIATE',
        },
        tx,
      );
      if (disease.urgency === 'IMMEDIATE') {
        await notifyFacilityRole(
          facilityId,
          ['DIRECTOR'],
          {
            type: 'surveillance',
            title: 'An immediately notifiable disease was diagnosed at your facility',
            link: '/surveillance',
            important: true,
          },
          tx,
        );
      }
      return row;
    });
    if (inserted) created++;
  }
  return { created };
}

let timer: NodeJS.Timeout | undefined;
const FIVE_MINUTES = 5 * 60_000;

async function runSafely() {
  try {
    const { created } = await detectCasesOnce();
    if (created) logger.info({ created }, 'Notifiable disease case reports created');
  } catch (err) {
    logger.error({ err }, 'Notifiable disease detection failed');
  }
}

export function startSurveillanceWorker() {
  if (isTest || timer) return;
  timer = setInterval(() => void runSafely(), FIVE_MINUTES);
  timer.unref();
  setTimeout(() => void runSafely(), 30_000).unref();
}

export function stopSurveillanceWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/* ------------------------------------------------------------------------------ epidemiology -- */

/** ISO 8601 week key, e.g. "2026-W45". */
export function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The last `count` ISO weeks ending with the week of `now`, oldest first. */
export function lastWeeks(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--)
    out.push(isoWeek(new Date(now.getTime() - i * 7 * 86_400_000)));
  return [...new Set(out)];
}

export interface CaseForStats {
  diseaseCode: string;
  diseaseName: string;
  urgency: string;
  municipality: string | null;
  caseDate: Date;
}

/** Cases (not discarded) dated within the window, for aggregate views. */
export async function casesForStats(opts: {
  from: Date;
  facilityId?: string | null;
  statuses?: ('DRAFT' | 'SUBMITTED' | 'REVIEWED')[];
}): Promise<CaseForStats[]> {
  const caseDate = sql<Date>`coalesce(${caseReports.onsetDate}::timestamptz, ${caseReports.createdAt})`;
  const rows = await db
    .select({
      diseaseCode: notifiableDiseases.code,
      diseaseName: notifiableDiseases.name,
      urgency: notifiableDiseases.urgency,
      municipality: patients.municipality,
      caseDate,
    })
    .from(caseReports)
    .innerJoin(notifiableDiseases, eq(notifiableDiseases.id, caseReports.diseaseId))
    .innerJoin(patients, eq(patients.id, caseReports.patientId))
    .where(
      and(
        sql`${caseReports.classification} <> 'DISCARDED'`,
        sql`${caseDate} >= ${opts.from}`,
        opts.facilityId ? eq(caseReports.facilityId, opts.facilityId) : undefined,
        opts.statuses?.length ? inArray(caseReports.status, opts.statuses) : undefined,
      ),
    );
  return rows.map((r) => ({ ...r, caseDate: new Date(r.caseDate) }));
}

export interface SurveillanceAlert {
  diseaseCode: string;
  diseaseName: string;
  kind: 'IMMEDIATE' | 'INCREASE';
  week: string;
  count: number;
  baseline: number | null;
}

/**
 * Weekly counts per disease, a municipality breakdown with small-cell suppression and alerts:
 * any immediately notifiable case in the current or previous week, or a current week with at
 * least 3 cases and more than twice the mean of the previous 4 weeks.
 */
export function buildDashboard(cases: CaseForStats[], now: Date, weeks: number) {
  const allWeeks = lastWeeks(now, weeks + 4);
  const shown = allWeeks.slice(-weeks);
  const current = allWeeks[allWeeks.length - 1]!;
  const previous = allWeeks[allWeeks.length - 2];
  const byDisease = new Map<
    string,
    { code: string; name: string; urgency: string; weeks: Map<string, number>; total: number }
  >();
  const byMunicipality = new Map<string, Map<string, number>>();
  for (const c of cases) {
    const week = isoWeek(c.caseDate);
    if (!allWeeks.includes(week)) continue;
    let d = byDisease.get(c.diseaseCode);
    if (!d) {
      d = {
        code: c.diseaseCode,
        name: c.diseaseName,
        urgency: c.urgency,
        weeks: new Map(),
        total: 0,
      };
      byDisease.set(c.diseaseCode, d);
    }
    d.weeks.set(week, (d.weeks.get(week) ?? 0) + 1);
    if (shown.includes(week)) {
      d.total++;
      const m = c.municipality ?? '—';
      const mm = byMunicipality.get(m) ?? new Map<string, number>();
      mm.set(c.diseaseCode, (mm.get(c.diseaseCode) ?? 0) + 1);
      byMunicipality.set(m, mm);
    }
  }

  const alerts: SurveillanceAlert[] = [];
  for (const d of byDisease.values()) {
    const cur = d.weeks.get(current) ?? 0;
    const prev = previous ? (d.weeks.get(previous) ?? 0) : 0;
    if (d.urgency === 'IMMEDIATE' && cur + prev > 0) {
      alerts.push({
        diseaseCode: d.code,
        diseaseName: d.name,
        kind: 'IMMEDIATE',
        week: cur ? current : previous!,
        count: cur || prev,
        baseline: null,
      });
      continue;
    }
    const base = allWeeks.slice(-5, -1).map((w) => d.weeks.get(w) ?? 0);
    const mean = base.reduce((a, b) => a + b, 0) / (base.length || 1);
    if (cur >= 3 && cur > 2 * mean) {
      alerts.push({
        diseaseCode: d.code,
        diseaseName: d.name,
        kind: 'INCREASE',
        week: current,
        count: cur,
        baseline: Math.round(mean * 10) / 10,
      });
    }
  }

  const suppress = (n: number) => (n > 0 && n < SMALL_CELL_THRESHOLD ? null : n);
  return {
    weeks: shown,
    currentWeek: current,
    diseases: [...byDisease.values()]
      .filter((d) => d.total > 0)
      .sort((a, b) => b.total - a.total)
      .map((d) => ({
        code: d.code,
        name: d.name,
        urgency: d.urgency,
        total: d.total,
        counts: shown.map((w) => d.weeks.get(w) ?? 0),
      })),
    /** Municipality × disease counts for the shown weeks; counts 1–4 are suppressed (null). */
    municipalities: [...byMunicipality.entries()]
      .map(([municipality, m]) => ({
        municipality,
        counts: Object.fromEntries([...m.entries()].map(([code, n]) => [code, suppress(n)])),
        total: suppress([...m.values()].reduce((a, b) => a + b, 0)),
      }))
      .sort((a, b) => (b.total ?? 0) - (a.total ?? 0)),
    alerts,
    suppressionThreshold: SMALL_CELL_THRESHOLD,
  };
}
