/**
 * Demo data for barcode-checked medication administration (development seed only): internal
 * EAN-13 pack barcodes (prefix 290, valid check digit) for every catalogue item, and a few days of
 * scanned doses on the wards – mostly with both scans, some with a documented override – so the
 * ward compliance figure has something to show. Runs from seedStock, after seedHospital.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from './client.js';
import {
  admissions,
  medicationAdministrations,
  medicationCatalog,
  prescriptions,
  users,
} from './schema.js';
import { internalEan13 } from '../modules/bcma/barcode.js';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const OVERRIDES = [
  'Byzylyku i dëmtuar; identiteti u konfirmua me emër dhe datëlindje',
  'Skaneri jashtë funksionit në dhomën 4; kontroll i dyfishtë me infermieren e dytë',
];

export async function seedBcma({ facilityId }: { facilityId: string }) {
  /* Barcodes: one per catalogue item, stable across reseeds (ordered by name, form, strength). */
  const catalog = await db
    .select()
    .from(medicationCatalog)
    .orderBy(
      asc(medicationCatalog.name),
      asc(medicationCatalog.form),
      asc(medicationCatalog.strength),
    );
  for (let i = 0; i < catalog.length; i++) {
    const item = catalog[i]!;
    if (item.barcode) continue;
    await db
      .update(medicationCatalog)
      .set({ barcode: internalEan13(i + 1, 290) })
      .where(eq(medicationCatalog.id, item.id));
  }

  /* Historical scanned doses for up to four admitted patients. */
  const [nurse] = await db.select().from(users).where(eq(users.email, 'nurse@pacient.local'));
  if (!nurse) return;
  const stays = await db
    .select({
      patientId: admissions.patientId,
      doctorId: admissions.attendingDoctorId,
      admittedAt: admissions.admittedAt,
    })
    .from(admissions)
    .where(and(eq(admissions.facilityId, facilityId), eq(admissions.status, 'ADMITTED')))
    .orderBy(asc(admissions.admittedAt))
    .limit(4);
  if (!stays.length) return;
  const [paracetamol] = await db
    .select()
    .from(medicationCatalog)
    .where(
      and(eq(medicationCatalog.name, 'Paracetamol'), eq(medicationCatalog.strength, '500 mg')),
    );
  const existing = await db
    .select({ patientId: medicationAdministrations.patientId })
    .from(medicationAdministrations)
    .where(
      inArray(
        medicationAdministrations.patientId,
        stays.map((s) => s.patientId),
      ),
    );
  const done = new Set(existing.map((e) => e.patientId));

  let overrideIdx = 0;
  for (const [n, stay] of stays.entries()) {
    if (done.has(stay.patientId)) continue;
    let [rx] = await db
      .select()
      .from(prescriptions)
      .where(
        and(
          eq(prescriptions.patientId, stay.patientId),
          eq(prescriptions.status, 'ACTIVE'),
          inArray(prescriptions.pharmacyStatus, ['VERIFIED', 'DISPENSED']),
        ),
      )
      .limit(1);
    if (!rx) {
      [rx] = await db
        .insert(prescriptions)
        .values({
          patientId: stay.patientId,
          doctorId: stay.doctorId,
          medication: 'Paracetamol 500 mg',
          catalogItemId: paracetamol?.id ?? null,
          dosage: '1 tabletë (500 mg)',
          frequency: 'çdo 6 orë',
          frequencyCode: 'Q6H',
          route: 'oral',
          instructions: 'Për temperaturë mbi 38 °C ose dhimbje',
          startDate: stay.admittedAt.toISOString().slice(0, 10),
          pharmacyStatus: 'VERIFIED',
          verifiedAt: stay.admittedAt,
          createdAt: stay.admittedAt,
        })
        .returning();
    }
    if (!rx) continue;
    // Doses every 6 hours over the last ~2 days, not earlier than the admission.
    const doses = [42, 36, 30, 24, 18, 12, 6].filter((h) => hoursAgo(h) > stay.admittedAt);
    const rows = doses.map((h, i) => {
      const override = (n + i) % 5 === 3;
      return {
        prescriptionId: rx!.id,
        patientId: stay.patientId,
        administeredById: nurse.id,
        status: 'GIVEN' as const,
        doseGiven: rx!.dosage.slice(0, 100),
        patientScanned: !override || i % 2 === 0,
        medicationScanned: !override,
        scanOverrideReason: override ? OVERRIDES[overrideIdx++ % OVERRIDES.length]! : null,
        administeredAt: hoursAgo(h),
        createdAt: hoursAgo(h),
      };
    });
    if (rows.length) await db.insert(medicationAdministrations).values(rows);
  }
}
