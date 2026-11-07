/**
 * Demo national e-prescriptions (development seed only): a community pharmacy partner system with a
 * fixed development key, and e-prescriptions in every state – one partly dispensed with repeats
 * (fixed code, see README), one not yet dispensed, one expired, one cancelled, one fully dispensed –
 * plus a spread for the statistics.
 */
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { isProd } from '../config/env.js';
import { hashToken } from '../lib/tokens.js';
import { generateCode, DEMO_ERX_CODE } from '../modules/erx/erx.service.js';
import { db } from './client.js';
import {
  careAssignments,
  communityDispensings,
  medicationCatalog,
  partnerClients,
  patients,
  prescriptions,
  users,
} from './schema.js';

export const DEMO_COMMUNITY_PHARMACY_API_KEY =
  'pk_dev_community_pharmacy_demo_key_not_for_production';

const DAY = 86_400_000;
const isoDay = (msAgo: number) => new Date(Date.now() - msAgo).toISOString().slice(0, 10);

export async function seedErx(opts: { facilityId: string; demoDoctorId: string }) {
  if (isProd) throw new Error('Refusing to create demo e-prescriptions in production');
  const [pharmacy] = await db
    .insert(partnerClients)
    .values({
      name: 'Barnatorja Qendrore (demo)',
      organisation: 'Barnatorja Qendrore – Prishtinë',
      scopes: ['prescriptions.dispense'],
      apiKeyHash: hashToken(DEMO_COMMUNITY_PHARMACY_API_KEY),
      apiKeyPrefix: DEMO_COMMUNITY_PHARMACY_API_KEY.slice(0, 10),
    })
    .returning();
  const [second] = await db
    .insert(partnerClients)
    .values({
      name: 'Barnatorja Dardania (demo)',
      organisation: 'Barnatorja Dardania – Prishtinë',
      scopes: ['prescriptions.dispense'],
      apiKeyHash: hashToken(`pk_dev_${generateCode()}_not_used`),
      apiKeyPrefix: 'pk_dev_dar',
    })
    .returning();

  const catalog = new Map(
    (
      await db
        .select({
          id: medicationCatalog.id,
          name: medicationCatalog.name,
          strength: medicationCatalog.strength,
        })
        .from(medicationCatalog)
        .where(
          inArray(medicationCatalog.name, [
            'Atorvastatin',
            'Amoxicillin',
            'Ibuprofen',
            'Metformin',
            'Amlodipine',
            'Omeprazole',
            'Salbutamol',
          ]),
        )
    ).map((c) => [c.name, c]),
  );

  const [demo] = await db
    .select({ id: patients.id })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(eq(users.email, 'patient@pacient.local'));
  const others = await db
    .select({ id: patients.id })
    .from(patients)
    .innerJoin(careAssignments, eq(careAssignments.patientId, patients.id))
    .where(
      and(
        eq(careAssignments.doctorId, opts.demoDoctorId),
        isNull(careAssignments.endedAt),
        isNull(patients.deceasedAt),
        isNull(patients.mergedIntoId),
        demo ? ne(patients.id, demo.id) : undefined,
      ),
    )
    .limit(12);

  type Plan = {
    patientId: string;
    medicine: string;
    dosage: string;
    frequency: string;
    daysAgo: number;
    validDays: number;
    repeats: number;
    code?: string;
    status?: 'ACTIVE' | 'CANCELLED';
    /** Days ago of each supply (and who dispensed it). */
    supplies?: { daysAgo: number; by?: 'second' }[];
  };
  const plans: Plan[] = [];
  if (demo) {
    plans.push(
      {
        patientId: demo.id,
        medicine: 'Atorvastatin',
        dosage: '20 mg',
        frequency: 'një herë në ditë, në mbrëmje',
        daysAgo: 25,
        validDays: 90,
        repeats: 2,
        code: DEMO_ERX_CODE,
        supplies: [{ daysAgo: 24 }],
      },
      {
        patientId: demo.id,
        medicine: 'Amoxicillin',
        dosage: '500 mg',
        frequency: 'tri herë në ditë, 7 ditë',
        daysAgo: 1,
        validDays: 30,
        repeats: 0,
      },
      {
        patientId: demo.id,
        medicine: 'Ibuprofen',
        dosage: '400 mg',
        frequency: 'sipas nevojës, deri 3 herë në ditë',
        daysAgo: 70,
        validDays: 30,
        repeats: 0,
      },
    );
  }
  const regimens = [
    ['Metformin', '850 mg', 'dy herë në ditë'],
    ['Amlodipine', '5 mg', 'një herë në ditë'],
    ['Omeprazole', '20 mg', 'një herë në ditë, para mëngjesit'],
    ['Salbutamol', '100 mcg/dozë', '2 shtypje sipas nevojës'],
    ['Atorvastatin', '20 mg', 'një herë në ditë'],
    ['Amoxicillin', '500 mg', 'tri herë në ditë, 7 ditë'],
  ] as const;
  others.forEach((p, i) => {
    const [medicine, dosage, frequency] = regimens[i % regimens.length]!;
    const daysAgo = 5 + ((i * 23) % 150);
    plans.push({
      patientId: p.id,
      medicine,
      dosage,
      frequency,
      daysAgo,
      validDays: medicine === 'Amoxicillin' ? 30 : 180,
      repeats: medicine === 'Amoxicillin' ? 0 : 3,
      status: i === 1 ? 'CANCELLED' : 'ACTIVE',
      supplies:
        i === 1
          ? []
          : i % 3 === 0
            ? [
                { daysAgo: daysAgo - 1 },
                ...(daysAgo > 40 ? [{ daysAgo: daysAgo - 31, by: 'second' as const }] : []),
              ]
            : [{ daysAgo: Math.max(0, daysAgo - 2), by: i % 2 ? ('second' as const) : undefined }],
    });
  });

  for (const plan of plans) {
    const item = catalog.get(plan.medicine);
    const issuedAt = new Date(Date.now() - plan.daysAgo * DAY);
    const startDate = isoDay(plan.daysAgo * DAY);
    const [rx] = await db
      .insert(prescriptions)
      .values({
        patientId: plan.patientId,
        doctorId: opts.demoDoctorId,
        medication: item ? `${item.name} ${item.strength ?? ''}`.trim() : plan.medicine,
        catalogItemId: item?.id ?? null,
        dosage: plan.dosage,
        frequency: plan.frequency,
        startDate,
        status: plan.status ?? 'ACTIVE',
        endDate: plan.status === 'CANCELLED' ? isoDay((plan.daysAgo - 2) * DAY) : null,
        ePrescriptionCode: plan.code ?? generateCode(),
        repeatsAllowed: plan.repeats,
        communityValidUntil: isoDay((plan.daysAgo - plan.validDays + 1) * DAY),
        createdAt: issuedAt,
      })
      .returning();
    for (const [n, supply] of (plan.supplies ?? []).entries()) {
      if (n > plan.repeats) break;
      await db.insert(communityDispensings).values({
        prescriptionId: rx!.id,
        patientId: plan.patientId,
        partnerClientId: supply.by === 'second' ? second!.id : pharmacy!.id,
        pharmacyName: supply.by === 'second' ? 'Barnatorja Dardania' : 'Barnatorja Qendrore',
        pharmacistName: supply.by === 'second' ? 'Farm. Blerta Hoti' : 'Farm. Arben Gashi',
        pharmacistLicence: supply.by === 'second' ? 'FARM-2231' : 'FARM-1187',
        supplyNumber: n,
        productName: rx!.medication,
        quantity: plan.medicine === 'Amoxicillin' ? '21 kapsula' : '1 kuti (30 tableta)',
        dispensedAt: new Date(Date.now() - supply.daysAgo * DAY),
      });
    }
  }
}
