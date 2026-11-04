/**
 * Demo billing data (development seed only): insurance coverage for the facility's patients, the
 * demo national tariff, charges captured from the seeded care, a few co-payment receipts and two
 * claims to the Health Insurance Fund (one paid, one submitted). All values are synthetic.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from './client.js';
import { claims, facilities, insuranceCoverages, patients, payments, users } from './schema.js';
import { captureCharges, nextReceiptNumber } from '../modules/billing/billing.service.js';
import { ensureTariff } from '../modules/billing/tariff.js';

const monthBounds = (offset: number) => {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
};

export async function seedBilling({ facilityId }: { facilityId: string }) {
  await ensureTariff();
  const [facility] = await db.select().from(facilities).where(eq(facilities.id, facilityId));
  const [director] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR')));
  const [reception] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.facilityId, facilityId), eq(users.role, 'RECEPTION')));
  const staffId = reception?.id ?? director!.id;

  // Coverage: everyone registered here is insured with the Fund, except one uninsured adult.
  const list = await db
    .select({
      id: patients.id,
      nationalId: patients.nationalId,
      dateOfBirth: patients.dateOfBirth,
      firstName: patients.firstName,
      lastName: patients.lastName,
      userId: patients.userId,
    })
    .from(patients)
    .where(eq(patients.primaryFacilityId, facilityId))
    .orderBy(patients.lastName, patients.firstName);
  const adults = list.filter(
    (p) => !p.userId && p.dateOfBirth > '1965-01-01' && p.dateOfBirth < '2005-01-01',
  );
  const uninsuredId = adults[adults.length - 1]?.id;
  const chronicId = adults[0]?.id;
  for (const p of list) {
    if (p.id === uninsuredId) continue;
    if (!/^\d{10}$/.test(p.nationalId)) continue; // temporary numbers are verified later
    await db.insert(insuranceCoverages).values({
      patientId: p.id,
      insurer: 'FSSH',
      policyNumber: `FSSH-${p.nationalId}`,
      status: 'ACTIVE',
      exemption: p.id === chronicId ? 'CHRONIC' : null,
      validFrom: '2024-01-01',
      verifiedAt: new Date(),
      createdById: staffId,
    });
  }

  await captureCharges(facilityId);

  // Co-payment receipts for the demo patient (Arta) and a few others.
  const [arta] = await db
    .select({ id: patients.id })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(eq(users.email, 'patient@pacient.local'));
  const payers = [arta?.id, ...list.slice(0, 4).map((p) => p.id)].filter((x): x is string =>
    Boolean(x),
  );
  for (const [i, patientId] of payers.entries()) {
    const open = await db.execute<{ id: string; copay_cents: number }>(sql`
      SELECT c.id, c.copay_cents FROM charges c
      WHERE c.patient_id = ${patientId} AND c.facility_id = ${facilityId} AND c.copay_cents > 0
        AND c.status <> 'VOID'
        AND NOT EXISTS (SELECT 1 FROM payments p WHERE c.id = ANY(p.charge_ids))
      ORDER BY c.service_date LIMIT 2`);
    // Leave Arta one open co-payment so the portal shows something to pay.
    const rows = patientId === arta?.id ? open.rows.slice(0, 1) : open.rows;
    if (!rows.length) continue;
    await db.transaction(async (tx) => {
      const receiptNumber = await nextReceiptNumber(tx, facilityId);
      await tx.insert(payments).values({
        patientId,
        facilityId,
        receiptNumber,
        amountCents: rows.reduce((a, r) => a + Number(r.copay_cents), 0),
        method: i % 2 ? 'CARD' : 'CASH',
        chargeIds: rows.map((r) => r.id),
        receivedById: staffId,
        receivedAt: new Date(Date.now() - (i + 1) * 3 * 86_400_000),
      });
      await tx.execute(sql`UPDATE charges SET status = 'PAID'
        WHERE id IN (${sql.join(
          rows.map((r) => sql`${r.id}::uuid`),
          sql`, `,
        )}) AND insurer_cents = 0`);
    });
  }

  // Claims: two months ago – paid by the Fund; last month – submitted, awaiting the Fund.
  for (const [offset, status] of [
    [-2, 'PAID'],
    [-1, 'SUBMITTED'],
  ] as const) {
    const { from, to } = monthBounds(offset);
    const [claim] = await db
      .insert(claims)
      .values({
        facilityId,
        insurer: 'FSSH',
        reference: `FSSH-${facility!.code}-${from.slice(0, 7).replace('-', '')}-DEMO`,
        periodFrom: from,
        periodTo: to,
        status,
        submittedAt: new Date(`${to}T15:00:00Z`),
        createdById: director!.id,
      })
      .returning();
    const lines = await db.execute<{ insurer_cents: number }>(sql`
      UPDATE charges c SET claim_id = ${claim!.id}, status = ${status === 'PAID' ? 'PAID' : 'CLAIMED'}
      WHERE c.facility_id = ${facilityId} AND c.status = 'OPEN' AND c.claim_id IS NULL
        AND c.insurer_cents > 0 AND c.service_date BETWEEN ${from}::date AND ${to}::date
      RETURNING c.insurer_cents`);
    const total = lines.rows.reduce((a, r) => a + Number(r.insurer_cents), 0);
    if (!lines.rows.length) {
      await db.delete(claims).where(eq(claims.id, claim!.id));
      continue;
    }
    await db
      .update(claims)
      .set({
        totalCents: total,
        paidCents: status === 'PAID' ? total : 0,
        respondedAt: status === 'PAID' ? new Date(`${to}T15:00:00Z`) : null,
        responseNote: status === 'PAID' ? 'Paguar plotësisht (demo).' : null,
      })
      .where(eq(claims.id, claim!.id));
  }

  // The demo Health Insurance Fund key may also read claims.
  await db.execute(sql`
    UPDATE partner_clients SET scopes = array_append(scopes, 'claims.read')
    WHERE name = 'Fondi i Sigurimit Shëndetësor (demo)' AND NOT ('claims.read' = ANY(scopes))`);
}
