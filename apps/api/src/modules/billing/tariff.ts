import { sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import { LAB_CATALOG } from '../lab/catalog.js';

/**
 * DEMO national tariff (euro cents). Prices and co-payments are illustrative only – modelled on the
 * idea of small fixed co-payments in Kosovo's public system – and must be replaced by the official
 * tariff of the Health Insurance Fund (FSSH) before real use. The Ministry can edit them in the app.
 */
export interface TariffItem {
  code: string;
  name: string;
  category: string;
  priceCents: number;
  copayCents: number;
}

const LAB_PRICES: Record<string, number> = {
  '718-7': 300,
  '6690-2': 300,
  '777-3': 300,
  '2345-7': 250,
  '4548-4': 800,
  '2160-0': 300,
  '2823-3': 300,
  '2951-2': 300,
  '2093-3': 350,
  '1988-5': 500,
  '3016-3': 900,
  '2276-4': 900,
};

export const DEMO_TARIFF: TariffItem[] = [
  {
    code: 'CONS-FM',
    name: 'Konsultë në mjekësi familjare',
    category: 'CONSULTATION',
    priceCents: 1000,
    copayCents: 100,
  },
  {
    code: 'CONS-SP',
    name: 'Konsultë specialistike',
    category: 'CONSULTATION',
    priceCents: 2000,
    copayCents: 300,
  },
  {
    code: 'CONS-TELE',
    name: 'Konsultë në distancë (video)',
    category: 'CONSULTATION',
    priceCents: 1200,
    copayCents: 100,
  },
  {
    code: 'ED-L1',
    name: 'Emergjencë – niveli 1 (menjëherë)',
    category: 'EMERGENCY',
    priceCents: 8000,
    copayCents: 0,
  },
  {
    code: 'ED-L2',
    name: 'Emergjencë – niveli 2 (shumë urgjent)',
    category: 'EMERGENCY',
    priceCents: 6000,
    copayCents: 0,
  },
  {
    code: 'ED-L3',
    name: 'Emergjencë – niveli 3 (urgjent)',
    category: 'EMERGENCY',
    priceCents: 4000,
    copayCents: 200,
  },
  {
    code: 'ED-L4',
    name: 'Emergjencë – niveli 4 (standard)',
    category: 'EMERGENCY',
    priceCents: 2500,
    copayCents: 300,
  },
  {
    code: 'ED-L5',
    name: 'Emergjencë – niveli 5 (jo urgjent)',
    category: 'EMERGENCY',
    priceCents: 1500,
    copayCents: 300,
  },
  ...LAB_CATALOG.map((t) => ({
    code: `LAB-${t.code}`,
    name: `Analizë laboratorike – ${t.name}`,
    category: 'LABORATORY',
    priceCents: LAB_PRICES[t.code] ?? 400,
    copayCents: 50,
  })),
  {
    code: 'LAB-OTHER',
    name: 'Analizë laboratorike – tjetër',
    category: 'LABORATORY',
    priceCents: 400,
    copayCents: 50,
  },
  { code: 'IMG-XRAY', name: 'Radiografi', category: 'IMAGING', priceCents: 1500, copayCents: 200 },
  {
    code: 'IMG-ULTRASOUND',
    name: 'Ekografi',
    category: 'IMAGING',
    priceCents: 2000,
    copayCents: 300,
  },
  {
    code: 'IMG-CT',
    name: 'Tomografi e kompjuterizuar (CT)',
    category: 'IMAGING',
    priceCents: 8000,
    copayCents: 1000,
  },
  {
    code: 'IMG-MRI',
    name: 'Rezonancë magnetike (MRI)',
    category: 'IMAGING',
    priceCents: 15000,
    copayCents: 1500,
  },
  {
    code: 'IMG-MAMMOGRAPHY',
    name: 'Mamografi',
    category: 'IMAGING',
    priceCents: 3000,
    copayCents: 300,
  },
  {
    code: 'IMG-FLUOROSCOPY',
    name: 'Fluoroskopi',
    category: 'IMAGING',
    priceCents: 4000,
    copayCents: 500,
  },
  {
    code: 'BED-GENERAL',
    name: 'Ditë shtrimi – repart',
    category: 'BED_DAY',
    priceCents: 4000,
    copayCents: 100,
  },
  {
    code: 'BED-ICU',
    name: 'Ditë shtrimi – kujdes intensiv',
    category: 'BED_DAY',
    priceCents: 20000,
    copayCents: 0,
  },
  {
    code: 'SURG-MINOR',
    name: 'Operacion i vogël (deri në 60 min)',
    category: 'SURGERY',
    priceCents: 30000,
    copayCents: 1000,
  },
  {
    code: 'SURG-MEDIUM',
    name: 'Operacion mesatar (60–120 min)',
    category: 'SURGERY',
    priceCents: 80000,
    copayCents: 2000,
  },
  {
    code: 'SURG-MAJOR',
    name: 'Operacion i madh (mbi 120 min)',
    category: 'SURGERY',
    priceCents: 150000,
    copayCents: 3000,
  },
  {
    code: 'DISP-FEE',
    name: 'Tarifë për dhënien e barnave',
    category: 'PHARMACY',
    priceCents: 100,
    copayCents: 50,
  },
];

export const SERVICE_CATEGORIES = [
  'CONSULTATION',
  'EMERGENCY',
  'LABORATORY',
  'IMAGING',
  'BED_DAY',
  'SURGERY',
  'PHARMACY',
  'OTHER',
] as const;

/** Inserts tariff items that do not exist yet (never overwrites prices the Ministry changed). */
export async function ensureTariff(executor: Executor = db) {
  const values = DEMO_TARIFF.map(
    (t) => sql`(${t.code}, ${t.name}, ${t.category}, ${t.priceCents}, ${t.copayCents})`,
  );
  await executor.execute(sql`
    INSERT INTO billable_services (code, name, category, price_cents, copay_cents)
    VALUES ${sql.join(values, sql`, `)}
    ON CONFLICT (code) DO NOTHING`);
}
