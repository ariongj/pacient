/**
 * Synthetic demo data for the medical equipment register (development only): about 70 items across
 * the wards of the demo hospital with service histories – some overdue, some due within 30 days –
 * a ventilator in intensive care out of service after a fault (life-support, so the director is
 * alerted after 24 hours), an infusion pump fault, and the vaccine-fridge fault linked to the
 * seeded equipment safety incident. A few ventilators, defibrillators and dialysis machines at the
 * other facilities feed the Ministry's national view.
 */
import { and, eq, ne } from 'drizzle-orm';
import { isProd } from '../config/env.js';
import { db } from './client.js';
import {
  careUnits,
  equipmentEvents,
  equipmentItems,
  facilities,
  safetyIncidents,
  users,
} from './schema.js';

const DAY = 86_400_000;
const isoDaysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const at = (iso: string, hour = 10) => new Date(`${iso}T${String(hour).padStart(2, '0')}:00:00Z`);
const addDaysIso = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

type Category =
  | 'VENTILATOR'
  | 'MONITOR'
  | 'DEFIBRILLATOR'
  | 'INFUSION_PUMP'
  | 'IMAGING'
  | 'LAB_ANALYSER'
  | 'DIALYSIS'
  | 'OTHER';

interface Model {
  category: Category;
  name: string;
  manufacturer: string;
  model: string;
  criticality: 'HIGH' | 'MEDIUM' | 'LOW';
  interval: number;
}

const MODELS: Record<string, Model> = {
  VEN: {
    category: 'VENTILATOR',
    name: 'Ventilator mekanik',
    manufacturer: 'Dräger',
    model: 'Evita V500',
    criticality: 'HIGH',
    interval: 180,
  },
  AVN: {
    category: 'VENTILATOR',
    name: 'Aparat anestezie me ventilator',
    manufacturer: 'GE Healthcare',
    model: 'Aisys CS2',
    criticality: 'HIGH',
    interval: 180,
  },
  NVN: {
    category: 'VENTILATOR',
    name: 'Ventilator neonatal',
    manufacturer: 'Dräger',
    model: 'Babylog VN500',
    criticality: 'HIGH',
    interval: 180,
  },
  MON: {
    category: 'MONITOR',
    name: 'Monitor i pacientit',
    manufacturer: 'Philips',
    model: 'IntelliVue MX450',
    criticality: 'MEDIUM',
    interval: 365,
  },
  DEF: {
    category: 'DEFIBRILLATOR',
    name: 'Defibrilator',
    manufacturer: 'ZOLL',
    model: 'R Series',
    criticality: 'HIGH',
    interval: 180,
  },
  PMP: {
    category: 'INFUSION_PUMP',
    name: 'Pompë infuzioni',
    manufacturer: 'B. Braun',
    model: 'Infusomat Space',
    criticality: 'MEDIUM',
    interval: 365,
  },
  DIA: {
    category: 'DIALYSIS',
    name: 'Aparat dialize',
    manufacturer: 'Fresenius',
    model: '5008S',
    criticality: 'HIGH',
    interval: 180,
  },
};

/** Ward code → equipment prefixes and how many of each. */
const LAYOUT: Record<string, [string, number][]> = {
  ICU: [
    ['VEN', 6],
    ['MON', 8],
    ['DEF', 2],
    ['PMP', 8],
  ],
  EMG: [
    ['VEN', 2],
    ['MON', 5],
    ['DEF', 2],
    ['PMP', 4],
  ],
  'INT-A': [
    ['MON', 3],
    ['DEF', 1],
    ['PMP', 4],
    ['DIA', 2],
  ],
  KIR: [
    ['MON', 2],
    ['DEF', 1],
    ['PMP', 3],
  ],
  PED: [
    ['MON', 2],
    ['DEF', 1],
    ['PMP', 2],
  ],
  NEO: [
    ['NVN', 2],
    ['MON', 2],
  ],
  OT1: [
    ['AVN', 1],
    ['MON', 1],
  ],
  OT2: [
    ['AVN', 1],
    ['MON', 1],
  ],
};

interface Spec {
  tag: string;
  unitCode: string | null;
  category: Category;
  name: string;
  manufacturer: string;
  model: string;
  criticality: 'HIGH' | 'MEDIUM' | 'LOW';
  interval: number | null;
  /** Days since the last service (null: never serviced). */
  lastServiceDaysAgo: number | null;
}

function buildSpecs(): Spec[] {
  const specs: Spec[] = [];
  let n = 0;
  for (const [unitCode, list] of Object.entries(LAYOUT)) {
    for (const [prefix, count] of list) {
      const m = MODELS[prefix]!;
      for (let i = 1; i <= count; i++) {
        n++;
        // Spread services across the interval: a few overdue (beyond the interval), a few due
        // within 30 days, the rest comfortably in date.
        const ago =
          n % 11 === 0
            ? m.interval + 10 + (n % 25)
            : n % 7 === 0
              ? m.interval - 12 - (n % 10)
              : 20 + ((n * 37) % Math.max(30, m.interval - 60));
        specs.push({
          tag: `${prefix}-${unitCode.replace('-', '')}-${String(i).padStart(2, '0')}`,
          unitCode,
          category: m.category,
          name: m.name,
          manufacturer: m.manufacturer,
          model: m.model,
          criticality: m.criticality,
          interval: m.interval,
          lastServiceDaysAgo: ago,
        });
      }
    }
  }
  specs.push(
    {
      tag: 'CT-RAD-01',
      unitCode: 'RAD',
      category: 'IMAGING',
      name: 'Tomografi e kompjuterizuar (CT)',
      manufacturer: 'Siemens Healthineers',
      model: 'SOMATOM go.Up',
      criticality: 'MEDIUM',
      interval: 180,
      lastServiceDaysAgo: 150,
    },
    {
      tag: 'XR-RAD-01',
      unitCode: 'RAD',
      category: 'IMAGING',
      name: 'Aparat rëntgeni',
      manufacturer: 'Philips',
      model: 'DigitalDiagnost C90',
      criticality: 'MEDIUM',
      interval: 365,
      lastServiceDaysAgo: 400,
    },
    {
      tag: 'US-RAD-01',
      unitCode: 'RAD',
      category: 'IMAGING',
      name: 'Aparat ultrazëri',
      manufacturer: 'GE Healthcare',
      model: 'LOGIQ E10',
      criticality: 'LOW',
      interval: 365,
      lastServiceDaysAgo: 90,
    },
    {
      tag: 'LAB-BIO-01',
      unitCode: null,
      category: 'LAB_ANALYSER',
      name: 'Analizator biokimik',
      manufacturer: 'Roche',
      model: 'cobas c 311',
      criticality: 'MEDIUM',
      interval: 90,
      lastServiceDaysAgo: 40,
    },
    {
      tag: 'LAB-HEM-01',
      unitCode: null,
      category: 'LAB_ANALYSER',
      name: 'Analizator hematologjik',
      manufacturer: 'Sysmex',
      model: 'XN-550',
      criticality: 'MEDIUM',
      interval: 90,
      lastServiceDaysAgo: 75,
    },
    {
      tag: 'FRG-BG-01',
      unitCode: 'BG',
      category: 'OTHER',
      name: 'Frigorifer për gjak',
      manufacturer: 'Helmer',
      model: 'iB111',
      criticality: 'HIGH',
      interval: 180,
      lastServiceDaysAgo: 60,
    },
    {
      tag: 'FRG-FAR-01',
      unitCode: null,
      category: 'OTHER',
      name: 'Frigorifer për vaksina (farmacia)',
      manufacturer: 'Liebherr',
      model: 'MKv 3910',
      criticality: 'MEDIUM',
      interval: 365,
      lastServiceDaysAgo: 74,
    },
  );
  return specs;
}

/** A few life-support and dialysis machines at each other facility (national view). */
const OTHER_FACILITY: [string, number][] = [
  ['VEN', 3],
  ['DEF', 2],
  ['DIA', 2],
];

export async function seedEquipment(opts: {
  facilityId: string;
  demoDoctorId: string;
}): Promise<void> {
  if (isProd) return;
  const { facilityId } = opts;
  const [director] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR')))
    .limit(1);
  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'))
    .limit(1);
  const recorder = director?.id ?? opts.demoDoctorId;
  const units = new Map(
    (
      await db
        .select({ id: careUnits.id, code: careUnits.code })
        .from(careUnits)
        .where(eq(careUnits.facilityId, facilityId))
    ).map((u) => [u.code, u.id]),
  );

  const byTag = new Map<string, typeof equipmentItems.$inferSelect>();
  for (const s of buildSpecs()) {
    const last = s.lastServiceDaysAgo === null ? null : isoDaysAgo(s.lastServiceDaysAgo);
    const commissioned = isoDaysAgo(900 + ((s.tag.length * 53) % 700));
    const [item] = await db
      .insert(equipmentItems)
      .values({
        facilityId,
        unitId: s.unitCode ? (units.get(s.unitCode) ?? null) : null,
        assetTag: s.tag,
        category: s.category,
        name: s.name,
        manufacturer: s.manufacturer,
        model: s.model,
        serialNumber: `SN${s.tag.replace(/-/g, '')}${String(s.tag.length * 97).padStart(4, '0')}`,
        criticality: s.criticality,
        serviceIntervalDays: s.interval,
        commissionedOn: commissioned,
        lastServiceAt: last,
        nextServiceDue: last && s.interval ? addDaysIso(last, s.interval) : null,
      })
      .returning();
    byTag.set(s.tag, item!);
    // Service history: the last service, and the one before it when the item is old enough.
    if (last && s.interval) {
      const previous = addDaysIso(last, -s.interval);
      const history = previous > commissioned ? [previous, last] : [last];
      await db.insert(equipmentEvents).values(
        history.map((d) => ({
          itemId: item!.id,
          kind: 'SERVICE' as const,
          occurredAt: at(d),
          description: 'Servis i planifikuar: kontroll i sigurisë elektrike dhe kalibrim',
          status: 'IN_SERVICE',
          recordedById: recorder,
        })),
      );
    }
  }

  // An intensive-care ventilator failed its self-test two days ago (life support → out of service).
  const ventilator = byTag.get('VEN-ICU-03');
  if (ventilator) {
    await db.insert(equipmentEvents).values({
      itemId: ventilator.id,
      kind: 'FAULT',
      occurredAt: new Date(Date.now() - 2 * DAY),
      description:
        'Ventilatori dështoi në vetëtestimin e sensorit të rrjedhës; u zëvendësua me një aparat rezervë',
      status: 'OUT_OF_SERVICE',
      recordedById: nurse?.id ?? recorder,
    });
    await db
      .update(equipmentItems)
      .set({ status: 'OUT_OF_SERVICE' })
      .where(eq(equipmentItems.id, ventilator.id));
  }

  // An infusion pump on Interna A: occlusion alarm not sounding – taken out of use by the nurse.
  const pump = byTag.get('PMP-INTA-02');
  if (pump) {
    await db.insert(equipmentEvents).values({
      itemId: pump.id,
      kind: 'FAULT',
      occurredAt: new Date(Date.now() - 6 * 3_600_000),
      description: 'Alarmi i okluzionit nuk bie gjatë testit; pompa u hoq nga përdorimi',
      status: 'OUT_OF_SERVICE',
      recordedById: nurse?.id ?? recorder,
    });
    await db
      .update(equipmentItems)
      .set({ status: 'OUT_OF_SERVICE' })
      .where(eq(equipmentItems.id, pump.id));
  }

  // The pharmacy's vaccine fridge: the fault behind the seeded equipment incident, then repaired.
  const fridge = byTag.get('FRG-FAR-01');
  if (fridge) {
    const [incident] = await db
      .select({ id: safetyIncidents.id, occurredAt: safetyIncidents.occurredAt })
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.facilityId, facilityId),
          eq(safetyIncidents.category, 'EQUIPMENT'),
          ne(safetyIncidents.status, 'NEW'),
        ),
      )
      .limit(1);
    const faultAt = incident?.occurredAt ?? new Date(Date.now() - 75 * DAY);
    await db.insert(equipmentEvents).values([
      {
        itemId: fridge.id,
        kind: 'FAULT',
        occurredAt: faultAt,
        description: 'Temperatura 11 °C në mëngjes; alarmi nuk njoftoi farmacistin kujdestar',
        status: 'OUT_OF_SERVICE',
        incidentId: incident?.id ?? null,
        recordedById: recorder,
      },
      {
        itemId: fridge.id,
        kind: 'REPAIR',
        occurredAt: new Date(faultAt.getTime() + DAY),
        description: 'U zëvendësua termostati; alarmi u lidh me SMS te farmacisti kujdestar',
        status: 'IN_SERVICE',
        recordedById: recorder,
      },
    ]);
  }

  // Other facilities: aggregates for the Ministry.
  const others = await db
    .select({ id: facilities.id, code: facilities.code })
    .from(facilities)
    .where(ne(facilities.id, facilityId));
  for (const [fi, f] of others.entries()) {
    const [someone] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.facilityId, f.id))
      .limit(1);
    for (const [prefix, count] of OTHER_FACILITY) {
      const m = MODELS[prefix]!;
      for (let i = 1; i <= count; i++) {
        const ago = (fi * 41 + i * 67) % (m.interval + 40);
        const last = isoDaysAgo(ago + 5);
        const outOfService = fi === 0 && prefix === 'DIA' && i === 1;
        const [item] = await db
          .insert(equipmentItems)
          .values({
            facilityId: f.id,
            assetTag: `${prefix}-${f.code.replace(/[^A-Z0-9]/g, '')}-${String(i).padStart(2, '0')}`,
            category: m.category,
            name: m.name,
            manufacturer: m.manufacturer,
            model: m.model,
            criticality: m.criticality,
            serviceIntervalDays: m.interval,
            commissionedOn: isoDaysAgo(1200),
            lastServiceAt: last,
            nextServiceDue: addDaysIso(last, m.interval),
            status: outOfService ? 'OUT_OF_SERVICE' : 'IN_SERVICE',
          })
          .returning();
        if (outOfService && someone) {
          await db.insert(equipmentEvents).values({
            itemId: item!.id,
            kind: 'FAULT',
            occurredAt: new Date(Date.now() - 10 * DAY),
            description: 'Pompa e gjakut nuk arrin rrjedhën e caktuar',
            status: 'OUT_OF_SERVICE',
            recordedById: someone.id,
          });
        }
      }
    }
  }
}
