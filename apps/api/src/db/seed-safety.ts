/**
 * Demo data for medication safety (development seed only): the curated interaction set, active
 * ingredients for the medication catalogue, and – for the demo patient – the stored safety alerts
 * of her current prescriptions, including an override with a reason.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './client.js';
import {
  drugInteractions,
  medicationCatalog,
  patients,
  prescriptionAlerts,
  prescriptions,
  users,
} from './schema.js';
import {
  checkMedication,
  ingredientsFromText,
  invalidateInteractionCache,
  orderPair,
  renderEnglish,
} from '../modules/safety/engine.js';
import { SEED_INTERACTIONS, SEED_SOURCE } from '../modules/safety/knowledge.js';

/** Catalogue names → ingredients where the name alone is ambiguous. */
const CATALOG_INGREDIENTS: Record<string, string[]> = {
  'acetylsalicylic acid': ['acetylsalicylic acid'],
  'amoxicillin/clavulanic acid': ['amoxicillin', 'clavulanic acid'],
  'budesonide/formoterol': ['budesonide', 'formoterol'],
  'sodium chloride': ['sodium chloride'],
};

export async function seedSafety({ facilityId }: { facilityId: string }) {
  // 1. Interaction database.
  const seen = new Set<string>();
  const rows = [];
  for (const [x, y, severity, effect, management] of SEED_INTERACTIONS) {
    const [a, b] = orderPair(x, y);
    if (seen.has(`${a}+${b}`)) continue;
    seen.add(`${a}+${b}`);
    rows.push({ ingredientA: a, ingredientB: b, severity, effect, management, source: SEED_SOURCE });
  }
  await db.insert(drugInteractions).values(rows).onConflictDoNothing();
  invalidateInteractionCache();

  // 2. Ingredients for the catalogue (INN names, lower case).
  const items = await db
    .select({ id: medicationCatalog.id, name: medicationCatalog.name })
    .from(medicationCatalog)
    .where(isNull(medicationCatalog.ingredients));
  for (const item of items) {
    const key = item.name.toLowerCase();
    const ingredients = CATALOG_INGREDIENTS[key] ?? ingredientsFromText(item.name);
    await db
      .update(medicationCatalog)
      .set({ ingredients })
      .where(eq(medicationCatalog.id, item.id));
  }

  // 3. Stored alerts for the demo patient's active prescriptions (as if checked when written).
  const [demo] = await db
    .select({ id: patients.id })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(and(eq(users.email, 'patient@pacient.local'), eq(patients.primaryFacilityId, facilityId)));
  if (!demo) return;
  const active = await db
    .select({
      id: prescriptions.id,
      medication: prescriptions.medication,
      catalogItemId: prescriptions.catalogItemId,
      doctorId: prescriptions.doctorId,
    })
    .from(prescriptions)
    .where(and(eq(prescriptions.patientId, demo.id), eq(prescriptions.status, 'ACTIVE')));
  for (const rx of active) {
    const alerts = await checkMedication(demo.id, rx.medication, rx.catalogItemId, {
      excludePrescriptionIds: [rx.id],
    });
    if (!alerts.length) continue;
    await db.insert(prescriptionAlerts).values(
      alerts.map((a) => ({
        prescriptionId: rx.id,
        patientId: demo.id,
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
        overrideReason: a.blocking
          ? 'Alergjia e regjistruar ishte skuqje e lehtë në fëmijëri; testi i lëkurës në 2025 ishte negativ.'
          : null,
        overriddenById: a.blocking ? rx.doctorId : null,
      })),
    );
  }
}
