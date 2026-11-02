import { and, desc, eq } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { consentRecords, patientDocuments, users } from '../../db/schema.js';
import { badRequest } from '../../lib/errors.js';
import type { AuthContext, RequestMeta } from '../../lib/http.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import { CONSENT_WORDING_VERSION, textFor, type ConsentType } from './texts.js';

export type ConsentRow = typeof consentRecords.$inferSelect;

const isCurrent = (r: { expiresAt: Date | null }, now = new Date()) =>
  !r.expiresAt || r.expiresAt > now;

/** Full history for a patient, newest first, with who recorded each decision. */
export async function consentHistory(patientId: string, executor: Executor = db) {
  return executor
    .select({
      id: consentRecords.id,
      type: consentRecords.type,
      decision: consentRecords.decision,
      method: consentRecords.method,
      procedure: consentRecords.procedure,
      wordingVersion: consentRecords.wordingVersion,
      note: consentRecords.note,
      documentId: consentRecords.documentId,
      onBehalfGuardianshipId: consentRecords.onBehalfGuardianshipId,
      expiresAt: consentRecords.expiresAt,
      createdAt: consentRecords.createdAt,
      recordedById: consentRecords.recordedById,
      recordedBy: users.fullName,
      recordedByRole: users.role,
    })
    .from(consentRecords)
    .innerJoin(users, eq(users.id, consentRecords.recordedById))
    .where(eq(consentRecords.patientId, patientId))
    .orderBy(desc(consentRecords.createdAt));
}

export type HistoryRow = Awaited<ReturnType<typeof consentHistory>>[number];

export interface CurrentConsent {
  type: ConsentType;
  /** NOT_GRANTED only appears for a default (no decision recorded yet). */
  decision: 'GRANTED' | 'WITHDRAWN' | 'REFUSED' | 'NOT_GRANTED';
  isDefault: boolean;
  method: string | null;
  recordedAt: Date | null;
  recordedBy: string | null;
  recordedByRole: string | null;
  wordingVersion: string;
  procedure?: string | null;
  expiresAt?: Date | null;
  id?: string;
}

function fromRow(r: HistoryRow): CurrentConsent {
  return {
    id: r.id,
    type: r.type,
    decision: r.decision,
    isDefault: false,
    method: r.method,
    recordedAt: r.createdAt,
    recordedBy: r.recordedBy,
    recordedByRole: r.recordedByRole,
    wordingVersion: r.wordingVersion,
    procedure: r.procedure,
    expiresAt: r.expiresAt,
  };
}

/** Current decision per patient-managed type (latest unexpired row, else the default). */
export function currentFromHistory(history: HistoryRow[], now = new Date()): CurrentConsent[] {
  return (['CROSS_FACILITY_SHARING', 'RESEARCH'] as const).map((type) => {
    const latest = history.find((r) => r.type === type);
    if (latest && isCurrent(latest, now)) return fromRow(latest);
    const text = textFor(type);
    return {
      type,
      decision: text.defaultDecision,
      isDefault: true,
      method: null,
      recordedAt: null,
      recordedBy: null,
      recordedByRole: null,
      wordingVersion: text.version,
    };
  });
}

/** Current treatment consent per procedure (case-insensitive), newest first. */
export function treatmentFromHistory(history: HistoryRow[], now = new Date()): CurrentConsent[] {
  const seen = new Set<string>();
  const out: CurrentConsent[] = [];
  for (const r of history) {
    if (r.type !== 'TREATMENT' || !r.procedure) continue;
    const key = r.procedure.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (isCurrent(r, now)) out.push(fromRow(r));
  }
  return out;
}

/** Is sharing with other facilities currently withdrawn (explicitly – the default is granted)? */
export async function sharingWithdrawn(patientId: string, executor: Executor = db) {
  const [latest] = await executor
    .select({ decision: consentRecords.decision, expiresAt: consentRecords.expiresAt })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.patientId, patientId),
        eq(consentRecords.type, 'CROSS_FACILITY_SHARING'),
      ),
    )
    .orderBy(desc(consentRecords.createdAt))
    .limit(1);
  return Boolean(latest && isCurrent(latest) && latest.decision !== 'GRANTED');
}

export interface RecordConsentInput {
  patientId: string;
  type: ConsentType;
  decision: 'GRANTED' | 'WITHDRAWN' | 'REFUSED';
  method: 'PORTAL' | 'IN_PERSON' | 'WRITTEN';
  procedure?: string | null;
  note?: string | null;
  documentId?: string | null;
  expiresAt?: Date | null;
  onBehalfGuardianshipId?: string | null;
}

/** Appends a consent decision and its audit entry (call inside the caller's transaction). */
export async function recordConsent(
  executor: Executor,
  ctx: AuthContext,
  input: RecordConsentInput,
  meta?: RequestMeta,
  context: Record<string, unknown> = {},
) {
  const [row] = await executor
    .insert(consentRecords)
    .values({
      patientId: input.patientId,
      type: input.type,
      decision: input.decision,
      method: input.method,
      procedure: input.type === 'TREATMENT' ? (input.procedure ?? null) : null,
      wordingVersion: CONSENT_WORDING_VERSION,
      note: input.note ?? null,
      documentId: input.documentId ?? null,
      expiresAt: input.expiresAt ?? null,
      onBehalfGuardianshipId: input.onBehalfGuardianshipId ?? null,
      recordedById: ctx.userId,
    })
    .returning();
  await audit(
    {
      action: AuditAction.CONSENT_RECORDED,
      actor: ctx,
      resourceType: 'consent',
      resourceId: row!.id,
      patientId: input.patientId,
      meta,
      metadata: {
        type: input.type,
        decision: input.decision,
        method: input.method,
        onBehalf: Boolean(input.onBehalfGuardianshipId),
        ...context,
      },
    },
    executor,
  );
  return row!;
}

/** A WRITTEN consent must point at a current CONSENT_FORM document of the same patient. */
export async function assertConsentForm(
  patientId: string,
  documentId: string | null | undefined,
  executor: Executor = db,
) {
  if (!documentId) throw badRequest('Attach the signed consent form for written consent');
  const [doc] = await executor
    .select({ id: patientDocuments.id })
    .from(patientDocuments)
    .where(
      and(
        eq(patientDocuments.id, documentId),
        eq(patientDocuments.patientId, patientId),
        eq(patientDocuments.category, 'CONSENT_FORM'),
        eq(patientDocuments.status, 'CURRENT'),
      ),
    );
  if (!doc)
    throw badRequest('The signed form must be a current consent-form document of this patient');
}
