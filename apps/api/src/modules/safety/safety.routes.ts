import { Router } from 'express';
import { and, asc, count, eq, ilike, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { drugInteractions, interactionSeverityEnum, medicationCatalog } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { paginated, PaginationSchema, toOffset } from '../../lib/pagination.js';
import { tr } from '../../i18n/index.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  checkMedication,
  evaluate,
  interactionIndex,
  invalidateInteractionCache,
  orderPair,
  pairKey,
  resolveCandidate,
  toPublicAlert,
  type PatientSafetyContext,
  loadContexts,
} from './engine.js';
import { KNOWN_INGREDIENTS, SYNONYMS } from './knowledge.js';
import { assertSafetyAccess, localeOf, storedAlertsFor } from './safety.service.js';

/**
 * Medication safety decision support: checks while prescribing and verifying, an interaction
 * checker, and the interaction database the Ministry maintains. Alerts support professionals –
 * blocking alerts can be overridden with a recorded reason.
 */
export const safetyRouter = Router();
safetyRouter.use(authenticate);

const STAFF = ['DOCTOR', 'NURSE', 'PHARMACIST', 'MINISTRY', 'DIRECTOR'] as const;

const CheckSchema = z.object({
  patientId: z.string().uuid(),
  medication: z.string().trim().min(2).max(200),
  catalogItemId: z.string().uuid().optional().nullable(),
  /** When re-checking an existing prescription, leave it out of the comparison. */
  excludePrescriptionId: z.string().uuid().optional(),
});

/** Checks one medication for a patient (live, while prescribing or verifying). */
safetyRouter.post('/check', requireRole('DOCTOR', 'NURSE', 'PHARMACIST'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(CheckSchema, req.body);
  await assertSafetyAccess(ctx, input.patientId, requestMeta(req));
  const [alerts, locale, candidate] = await Promise.all([
    checkMedication(input.patientId, input.medication, input.catalogItemId, {
      excludePrescriptionIds: input.excludePrescriptionId ? [input.excludePrescriptionId] : [],
    }),
    localeOf(ctx.userId),
    resolveCandidate(input.medication, input.catalogItemId),
  ]);
  res.json({
    ingredients: candidate.ingredients,
    alerts: alerts.map((a) => toPublicAlert(a, locale)),
  });
});

const ListSchema = z.object({
  medications: z
    .array(
      z.object({
        medication: z.string().trim().min(2).max(200),
        catalogItemId: z.string().uuid().optional().nullable(),
      }),
    )
    .min(1)
    .max(10),
  patientId: z.string().uuid().optional(),
});

/**
 * Interaction checker: all pairwise interactions and duplicates within a list of medicines, and –
 * for a patient – each medicine against the patient's record.
 */
safetyRouter.post('/check-list', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(ListSchema, req.body);
  if (input.patientId) await assertSafetyAccess(ctx, input.patientId, requestMeta(req));
  const [locale, index] = await Promise.all([localeOf(ctx.userId), interactionIndex()]);
  const resolved = await Promise.all(
    input.medications.map((m) => resolveCandidate(m.medication, m.catalogItemId)),
  );
  // Pairwise: evaluate each medicine against the others as a pseudo-patient without other data.
  const pairwise = [];
  for (let i = 0; i < resolved.length; i++) {
    const pseudo: PatientSafetyContext = {
      patientId: 'list',
      ageYears: null,
      sex: 'UNKNOWN',
      allergies: [],
      kidney: null,
      pregnant: false,
      medications: resolved
        .map((r, j) => ({ id: String(j), medication: r.medication, ingredients: r.ingredients, atc: r.atc }))
        .filter((_, j) => j > i),
    };
    for (const a of evaluate(pseudo, resolved[i]!, index.pairs)) {
      pairwise.push({
        medications: [resolved[i]!.medication, resolved[Number(a.details?.prescriptionId)]?.medication],
        ...toPublicAlert(a, locale),
      });
    }
  }
  let patient: { medication: string; alerts: ReturnType<typeof toPublicAlert>[] }[] | undefined;
  if (input.patientId) {
    const contexts = await loadContexts([input.patientId]);
    const pctx = contexts.get(input.patientId);
    patient = pctx
      ? resolved.map((r) => ({
          medication: r.medication,
          alerts: evaluate(pctx, r, index.pairs).map((a) => toPublicAlert(a, locale)),
        }))
      : [];
  }
  res.json({
    medications: resolved.map((r) => ({ medication: r.medication, ingredients: r.ingredients })),
    pairwise,
    patient,
  });
});

/** Stored alerts (with override reasons) for a patient's prescriptions, by prescription. */
safetyRouter.get(
  '/patients/:patientId/alerts',
  requireRole('DOCTOR', 'NURSE', 'PHARMACIST'),
  async (req, res) => {
    const ctx = requireAuth(req);
    const { patientId } = parse(z.object({ patientId: z.string().uuid() }), req.params);
    await assertSafetyAccess(ctx, patientId, requestMeta(req));
    const map = await storedAlertsFor({ patientId }, await localeOf(ctx.userId));
    res.json({ byPrescription: Object.fromEntries(map) });
  },
);

/** Known ingredient names for autocomplete (catalogue, synonyms, interaction database). */
safetyRouter.get('/ingredients', requireRole(...STAFF), async (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().max(60).default('') }), req.query);
  const index = await interactionIndex();
  const catalog = await db
    .select({ ingredients: medicationCatalog.ingredients })
    .from(medicationCatalog)
    .where(eq(medicationCatalog.isActive, true));
  const all = new Set<string>([...KNOWN_INGREDIENTS, ...index.names]);
  for (const c of catalog) for (const i of c.ingredients ?? []) all.add(i);
  for (const v of Object.values(SYNONYMS)) for (const i of v) all.add(i);
  const needle = q.toLowerCase();
  res.json({
    items: [...all]
      .filter((n) => !needle || n.includes(needle))
      .sort()
      .slice(0, 50),
  });
});

/* ------------------------------------------------------------------ interaction database ---- */

const InteractionQuery = PaginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  severity: z.enum(interactionSeverityEnum.enumValues).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

safetyRouter.get('/interactions', requireRole(...STAFF), async (req, res) => {
  const ctx = requireAuth(req);
  const q = parse(InteractionQuery, req.query);
  const filters: SQL[] = [];
  if (q.q) {
    const term = `%${q.q.toLowerCase()}%`;
    filters.push(
      or(ilike(drugInteractions.ingredientA, term), ilike(drugInteractions.ingredientB, term))!,
    );
  }
  if (q.severity) filters.push(eq(drugInteractions.severity, q.severity));
  if (q.includeInactive !== 'true') filters.push(eq(drugInteractions.isActive, true));
  const where = filters.length ? and(...filters) : undefined;
  const { limit, offset } = toOffset(q);
  const [rows, [total], locale] = await Promise.all([
    db
      .select()
      .from(drugInteractions)
      .where(where)
      .orderBy(asc(drugInteractions.ingredientA), asc(drugInteractions.ingredientB))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(drugInteractions).where(where),
    localeOf(ctx.userId),
  ]);
  res.json({
    ...paginated(
      rows.map((r) => ({
        ...r,
        effectTranslated: tr(locale, r.effect),
        managementTranslated: tr(locale, r.management),
      })),
      total?.total ?? 0,
      q,
    ),
    canEdit: ctx.role === 'MINISTRY',
  });
});

const InteractionInput = z
  .object({
    ingredientA: z.string().trim().toLowerCase().min(2).max(100),
    ingredientB: z.string().trim().toLowerCase().min(2).max(100),
    severity: z.enum(interactionSeverityEnum.enumValues),
    effect: z.string().trim().min(5).max(500),
    management: z.string().trim().min(5).max(500),
    source: z.string().trim().max(200).optional().nullable(),
  })
  .refine((v) => v.ingredientA !== v.ingredientB, {
    message: 'Choose two different ingredients',
    path: ['ingredientB'],
  });

safetyRouter.post('/interactions', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(InteractionInput, req.body);
  const [a, b] = orderPair(input.ingredientA, input.ingredientB);
  const [existing] = await db
    .select({ id: drugInteractions.id })
    .from(drugInteractions)
    .where(and(eq(drugInteractions.ingredientA, a), eq(drugInteractions.ingredientB, b)));
  if (existing) throw conflict('This pair is already in the interaction database');
  const [row] = await db
    .insert(drugInteractions)
    .values({
      ingredientA: a,
      ingredientB: b,
      severity: input.severity,
      effect: input.effect,
      management: input.management,
      source: input.source ?? 'Ministry of Health',
    })
    .returning();
  await audit({
    action: AuditAction.INTERACTION_DB_CHANGED,
    actor: ctx,
    resourceType: 'drug_interaction',
    resourceId: row!.id,
    meta: requestMeta(req),
    metadata: { op: 'create', pair: pairKey(a, b), severity: input.severity },
  });
  invalidateInteractionCache();
  res.status(201).json(row);
});

const InteractionPatch = z
  .object({
    severity: z.enum(interactionSeverityEnum.enumValues).optional(),
    effect: z.string().trim().min(5).max(500).optional(),
    management: z.string().trim().min(5).max(500).optional(),
    source: z.string().trim().max(200).optional().nullable(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

safetyRouter.patch('/interactions/:id', requireRole('MINISTRY'), async (req, res) => {
  const ctx = requireAuth(req);
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const input = parse(InteractionPatch, req.body);
  const [row] = await db
    .update(drugInteractions)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(drugInteractions.id, id))
    .returning();
  if (!row) throw notFound('Interaction not found');
  await audit({
    action: AuditAction.INTERACTION_DB_CHANGED,
    actor: ctx,
    resourceType: 'drug_interaction',
    resourceId: id,
    meta: requestMeta(req),
    metadata: { op: 'update', changes: Object.keys(input) },
  });
  invalidateInteractionCache();
  res.json(row);
});
