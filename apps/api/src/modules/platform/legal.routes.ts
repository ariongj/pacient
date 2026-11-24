import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { legalAcceptances, users } from '../../db/schema.js';
import { conflict, notFound } from '../../lib/errors.js';
import { parse, requestMeta, requireAuth } from '../../lib/http.js';
import { authenticate } from '../../middleware/auth.js';
import { audit, AuditAction } from '../audit/audit.service.js';
import {
  currentDocument,
  getSettings,
  LEGAL_LOCALES,
  pendingDocuments,
  presentDocument,
  USER_LEGAL_KINDS,
} from './platform.service.js';

/**
 * Terms of use and privacy notice (/legal): the current published text is public; signed-in users
 * see which versions they still have to accept and accept them. The service agreement and the data
 * processing agreement are public here too, but they are accepted per facility (/subscription).
 */
export const legalRouter = Router();

const LocaleQuery = z.object({ locale: z.enum(LEGAL_LOCALES).optional() });
/** The public address of each text: /legal/terms, /legal/privacy, /legal/service-agreement, /legal/dpa. */
const KIND_BY_SLUG = {
  terms: 'TERMS',
  privacy: 'PRIVACY',
  'service-agreement': 'SERVICE_AGREEMENT',
  dpa: 'DPA',
} as const;
const KindParam = z.object({
  kind: z.enum(['terms', 'privacy', 'service-agreement', 'dpa']).transform((k) => KIND_BY_SLUG[k]),
});
// Only the texts of the legal gate: agreements are accepted for a facility (/subscription).
const AcceptInput = z.object({
  kind: z.enum(USER_LEGAL_KINDS),
  version: z.string().trim().min(1).max(20),
});

/** The signed-in user's language unless the page asks for another one. */
async function localeOf(userId: string, requested?: string) {
  if (requested) return requested;
  const [u] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, userId));
  return u?.locale ?? 'sq';
}

/** Current versions the signed-in user still has to accept (shown before the workspace). */
legalRouter.get('/status', authenticate, async (req, res) => {
  const ctx = requireAuth(req);
  const { locale } = parse(LocaleQuery, req.query);
  // The operator's own administrators publish the texts; they are not asked to accept them.
  if (ctx.role === 'ADMIN') {
    res.json({ pending: [] });
    return;
  }
  const settings = await getSettings();
  const pending = await pendingDocuments(ctx.userId, await localeOf(ctx.userId, locale));
  res.json({ pending: pending.map((p) => presentDocument(p, settings)) });
});

/** Accept the current version of the terms of use or the privacy notice (idempotent). */
legalRouter.post('/accept', authenticate, async (req, res) => {
  const ctx = requireAuth(req);
  const input = parse(AcceptInput, req.body);
  const meta = requestMeta(req);
  const current = await currentDocument(input.kind, await localeOf(ctx.userId));
  if (!current || current.version !== input.version) {
    throw conflict('This is not the current version. Reload the page and read the current text.');
  }
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(legalAcceptances)
      .values({
        userId: ctx.userId,
        kind: input.kind,
        version: input.version,
        locale: current.doc.locale,
        ip: meta.ipAddress?.slice(0, 64) ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (row) {
      await audit(
        {
          action: AuditAction.LEGAL_ACCEPTED,
          actor: ctx,
          resourceType: 'legal_document',
          resourceId: current.doc.id,
          meta,
          metadata: { kind: input.kind, version: input.version, locale: current.doc.locale },
        },
        tx,
      );
    }
  });
  const settings = await getSettings();
  const pending = await pendingDocuments(ctx.userId, await localeOf(ctx.userId));
  res.json({ accepted: true, pending: pending.map((p) => presentDocument(p, settings)) });
});

/** The current published text of a kind (public; language fallback sq, en). */
legalRouter.get('/:kind', async (req, res) => {
  const { kind } = parse(KindParam, req.params);
  const { locale } = parse(LocaleQuery, req.query);
  const current = await currentDocument(kind, locale ?? 'sq');
  if (!current) throw notFound('Not published yet');
  const settings = await getSettings();
  res.json({
    ...presentDocument(current, settings),
    operator: {
      name: settings.operatorName.trim() || null,
      address: settings.operatorAddress.trim() || null,
      supportEmail: settings.supportEmail?.trim() || null,
      privacyEmail: settings.privacyEmail?.trim() || null,
    },
  });
});
