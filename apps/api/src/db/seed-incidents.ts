/**
 * Synthetic demo data for patient safety incident reporting (development only): about a dozen
 * reports at the demo hospital in every state – one anonymous, one about the system itself
 * (barcode scanning, hazard H17), one severe fall with open disclosure – plus reports at the other
 * facilities so the Ministry's national counts have cells above the suppression threshold.
 * The pharmacist (pharmacist@pacient.local) is named medication-safety lead and reviews alongside
 * the director.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { isProd } from '../config/env.js';
import { db } from './client.js';
import {
  admissions,
  careUnits,
  facilities,
  incidentActions,
  incidentReviewers,
  patients,
  safetyIncidents,
  users,
  type Role,
} from './schema.js';
import { nextIncidentReference } from '../modules/incidents/incidents.service.js';

const DAY = 86_400_000;
/** A time n days ago (never in the future). */
const daysAgo = (n: number, hour = 10) => {
  const d = new Date(Date.now() - n * DAY);
  d.setUTCHours(hour, 15, 0, 0);
  return new Date(Math.min(d.getTime(), Date.now() - 60_000));
};
const isoDay = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

interface Demo {
  reporter: string | null;
  role: Role;
  unit?: string;
  location?: string;
  category: string;
  harm: string;
  occurred: number;
  description: string;
  immediateAction?: string;
  status?: 'NEW' | 'UNDER_REVIEW' | 'ACTION_PLANNED' | 'CLOSED';
  reviewedHarm?: string;
  factors?: string[];
  findings?: string;
  lessons?: string;
  hazardRef?: string;
  informed?: number;
  patient?: boolean;
  actions?: { description: string; owner: string | null; due: number; done?: boolean }[];
}

const UCC: Demo[] = [
  {
    reporter: 'nurse@pacient.local',
    role: 'NURSE',
    unit: 'Interna A',
    category: 'MEDICATION',
    harm: 'NEAR_MISS',
    occurred: 3,
    description:
      'Gjatë përgatitjes së barnave të mbrëmjes vura re se doza e enoksaparinës ishte shkruar 80 mg në vend të 40 mg. E ndalova para dhënies dhe e njoftova mjekun.',
    immediateAction: 'Doza nuk u dha; mjeku e korrigjoi recetën.',
  },
  {
    reporter: null,
    role: 'NURSE',
    unit: 'Kirurgjia',
    category: 'COMMUNICATION',
    harm: 'NO_HARM',
    occurred: 6,
    description:
      'Në ndërrimin e turnit nuk u përcoll informacioni se pacienti duhej të ishte esëll para operacionit. Pacienti hëngri mëngjes dhe operacioni u shty për pasdite.',
    immediateAction: 'Kirurgu u njoftua, operacioni u riplanifikua.',
  },
  {
    reporter: 'pharmacist@pacient.local',
    role: 'PHARMACIST',
    location: 'Farmacia e spitalit',
    category: 'MEDICATION',
    harm: 'NO_HARM',
    occurred: 12,
    description:
      'Dy barna me emra të ngjashëm (hidroksizinë / hidralazinë) ishin vendosur në të njëjtin raft. U dha pakoja e gabuar në repart, por infermierja e kapi gabimin me skanimin e barkodit.',
    status: 'ACTION_PLANNED',
    reviewedHarm: 'NEAR_MISS',
    factors: ['ENVIRONMENT', 'TASK'],
    findings:
      'Barnat me emra të ngjashëm nuk ndaheshin në farmaci; skanimi i barkodit e ndaloi gabimin.',
    actions: [
      {
        description:
          'Ndani barnat me emra të ngjashëm dhe shënoni raftet me etiketa paralajmëruese',
        owner: 'pharmacist@pacient.local',
        due: 10,
      },
    ],
  },
  {
    reporter: 'nurse@pacient.local',
    role: 'NURSE',
    unit: 'Interna A',
    category: 'FALL',
    harm: 'SEVERE',
    occurred: 40,
    patient: true,
    description:
      'Pacienti u rrëzua natën gjatë rrugës për në tualet, pa e thirrur infermieren. Dyshim për frakturë të kofshës, u konfirmua me radiografi.',
    immediateAction: 'Vlerësim nga mjeku kujdestar, radiografi, konsultë ortopedike.',
    status: 'CLOSED',
    reviewedHarm: 'SEVERE',
    factors: ['PATIENT', 'ENVIRONMENT', 'TEAM'],
    findings:
      'Vlerësimi i rrezikut për rrëzim nuk ishte bërë në pranim; zilja e thirrjes ishte larg shtratit; drita e natës nuk punonte.',
    lessons:
      'Vlerësimi i rrezikut për rrëzim bëhet tani në çdo pranim; zilja vendoset brenda dorës; kontroll javor i dritave të natës.',
    informed: 39,
    actions: [
      {
        description: 'Shtoni vlerësimin e rrezikut për rrëzim në listën e pranimit',
        owner: 'nurse@pacient.local',
        due: -20,
        done: true,
      },
      {
        description: 'Riparoni dritat e natës në të gjitha dhomat e Internës A',
        owner: null,
        due: -25,
        done: true,
      },
    ],
  },
  {
    reporter: 'nurse@pacient.local',
    role: 'NURSE',
    unit: 'Interna A',
    category: 'IT_SYSTEM',
    harm: 'NO_HARM',
    occurred: 25,
    description:
      'Skaneri i dorës nuk lexonte byzylykët e printuar në printerin e ri; për dy orë dozat u regjistruan pa skanim me arsye.',
    immediateAction: 'U përdor futja e kodit me dorë; IT u njoftua.',
    status: 'CLOSED',
    reviewedHarm: 'NO_HARM',
    factors: ['EQUIPMENT', 'IT_SYSTEM'],
    hazardRef: 'H17',
    findings:
      'Printeri i ri printonte kodin QR me rezolucion shumë të ulët për skanerin. Kontrolli me barkod funksionoi si duhet: dozat pa skanim kërkuan arsye.',
    lessons:
      'Çdo printer i ri byzylykësh testohet me skanerët e repartit para përdorimit; rezolucioni minimal u shtua në udhëzimin e instalimit.',
    actions: [
      {
        description: 'Shtoni testin e skanimit në procedurën e instalimit të printerëve',
        owner: 'director@pacient.local',
        due: -10,
        done: true,
      },
    ],
  },
  {
    reporter: 'doctor@pacient.local',
    role: 'DOCTOR',
    unit: 'Emergjenca',
    category: 'DIAGNOSTIC',
    harm: 'LOW',
    occurred: 18,
    description:
      'Rezultati kritik i kaliumit u pa me vonesë 3 orë sepse njoftimi shkoi te mjeku i turnit të mëparshëm.',
    status: 'UNDER_REVIEW',
  },
  {
    reporter: 'reception@pacient.local',
    role: 'RECEPTION',
    location: 'Sporteli i regjistrimit',
    category: 'IDENTIFICATION',
    harm: 'NEAR_MISS',
    occurred: 9,
    description:
      'Dy pacientë me emër dhe mbiemër të njëjtë u thirrën për të njëjtin termin. U kontrollua data e lindjes para hyrjes te mjeku.',
    status: 'CLOSED',
    reviewedHarm: 'NEAR_MISS',
    factors: ['TASK'],
    findings: 'Thirrja bëhej vetëm me emër; identifikimi me dy të dhëna nuk zbatohej në sportel.',
    lessons: 'Në sportel pacienti identifikohet gjithmonë me emër dhe datëlindje.',
  },
  {
    reporter: 'nurse@pacient.local',
    role: 'NURSE',
    unit: 'Kujdesi intensiv',
    category: 'PRESSURE_INJURY',
    harm: 'MODERATE',
    occurred: 30,
    description:
      'Plagë nga shtypja e shkallës 2 në sakrum te pacient i shtrirë 6 ditë. Ndryshimi i pozicionit nuk ishte dokumentuar çdo 2 orë.',
    status: 'ACTION_PLANNED',
    reviewedHarm: 'MODERATE',
    factors: ['TEAM', 'ORGANISATIONAL'],
    findings: 'Mungesë stafi në turnet e natës; dyshekët kundër shtypjes nuk mjaftonin.',
    actions: [
      {
        description: 'Porositni 4 dyshekë kundër shtypjes për kujdesin intensiv',
        owner: 'director@pacient.local',
        due: -5,
      },
      {
        description: 'Trajnim për parandalimin e plagëve nga shtypja për stafin e natës',
        owner: 'nurse@pacient.local',
        due: 14,
      },
    ],
  },
  {
    reporter: 'doctor@pacient.local',
    role: 'DOCTOR',
    unit: 'Salla e operacionit 1',
    category: 'SURGICAL',
    harm: 'NEAR_MISS',
    occurred: 50,
    description:
      'Gjatë pauzës para incizionit u vu re se ana e shënuar nuk përputhej me pëlqimin. Lista e kontrollit e ndaloi procedurën derisa u verifikua.',
    status: 'CLOSED',
    reviewedHarm: 'NEAR_MISS',
    factors: ['COMMUNICATION'],
    findings: 'Shënimi i anës u bë nga specializanti pa e krahasuar me pëlqimin.',
    lessons: 'Ana shënohet vetëm nga kirurgu operues, duke pasur pëlqimin para vetes.',
  },
  {
    reporter: 'nurse@pacient.local',
    role: 'NURSE',
    unit: 'Pediatria',
    category: 'MEDICATION',
    harm: 'LOW',
    occurred: 1,
    description:
      'Pompa e infuzionit ishte programuar me shpejtësi më të lartë se e përshkruara për 20 minuta. Fëmija u monitorua, pa shenja të dëmit përveç të vjellave.',
    immediateAction: 'Infuzioni u ndal dhe u rifillua me shpejtësinë e duhur; mjeku u njoftua.',
  },
  {
    reporter: 'doctor@pacient.local',
    role: 'DOCTOR',
    unit: 'Emergjenca',
    category: 'VIOLENCE',
    harm: 'LOW',
    occurred: 14,
    description:
      'Një shoqërues agresiv shtyu infermieren në triazh. Sigurimi ndërhyri; infermierja pati lëndim të lehtë në krah.',
    status: 'UNDER_REVIEW',
  },
  {
    reporter: 'pharmacist@pacient.local',
    role: 'PHARMACIST',
    location: 'Farmacia e spitalit',
    category: 'EQUIPMENT',
    harm: 'NO_HARM',
    occurred: 75,
    description:
      'Frigoriferi i vaksinave tregoi 11 °C në mëngjes. Vaksinat u veçuan dhe u kontaktua furnizuesi për stabilitetin.',
    status: 'CLOSED',
    reviewedHarm: 'NO_HARM',
    factors: ['EQUIPMENT'],
    findings: 'Alarmi i temperaturës nuk ishte i lidhur me telefonin e kujdestarit.',
    lessons: 'Alarmi i frigoriferit tani dërgon SMS te farmacisti kujdestar.',
  },
];

/** Reports at the other facilities: counts only matter for the national view. */
const OTHER: { category: string; harm: string; occurred: number; role: Role }[] = [
  { category: 'MEDICATION', harm: 'NEAR_MISS', occurred: 5, role: 'NURSE' },
  { category: 'MEDICATION', harm: 'NO_HARM', occurred: 20, role: 'PHARMACIST' },
  { category: 'MEDICATION', harm: 'LOW', occurred: 33, role: 'NURSE' },
  { category: 'FALL', harm: 'LOW', occurred: 8, role: 'NURSE' },
  { category: 'FALL', harm: 'NO_HARM', occurred: 44, role: 'NURSE' },
  { category: 'FALL', harm: 'MODERATE', occurred: 61, role: 'NURSE' },
  { category: 'FALL', harm: 'LOW', occurred: 90, role: 'DOCTOR' },
  { category: 'IDENTIFICATION', harm: 'NEAR_MISS', occurred: 12, role: 'RECEPTION' },
  { category: 'COMMUNICATION', harm: 'NO_HARM', occurred: 27, role: 'DOCTOR' },
  { category: 'IT_SYSTEM', harm: 'NO_HARM', occurred: 16, role: 'DOCTOR' },
];

export async function seedIncidents({ facilityId }: { facilityId: string; demoDoctorId: string }) {
  if (isProd) throw new Error('Refusing to seed demo incidents in production');
  const emails = [
    'director@pacient.local',
    'doctor@pacient.local',
    'nurse@pacient.local',
    'pharmacist@pacient.local',
    'reception@pacient.local',
  ];
  const staff = new Map(
    (
      await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.email, emails))
    ).map((u) => [u.email, u.id]),
  );
  const director = staff.get('director@pacient.local');
  const pharmacist = staff.get('pharmacist@pacient.local');
  if (!director) return;
  if (pharmacist) {
    await db
      .insert(incidentReviewers)
      .values({ facilityId, userId: pharmacist })
      .onConflictDoNothing();
  }
  const units = new Map(
    (
      await db
        .select({ id: careUnits.id, name: careUnits.name })
        .from(careUnits)
        .where(eq(careUnits.facilityId, facilityId))
    ).map((u) => [u.name, u.id]),
  );
  const [admitted] = await db
    .select({ id: patients.id })
    .from(admissions)
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .where(and(eq(admissions.facilityId, facilityId), eq(admissions.status, 'ADMITTED')))
    .limit(1);

  // Oldest first, so references follow the order in which reports were made.
  for (const d of [...UCC].sort((a, b) => b.occurred - a.occurred)) {
    const reportedAt = new Date(daysAgo(d.occurred).getTime() + 2 * 3_600_000);
    const status = d.status ?? 'NEW';
    await db.transaction(async (tx) => {
      const reference = await nextIncidentReference(tx, reportedAt);
      const [row] = await tx
        .insert(safetyIncidents)
        .values({
          reference,
          facilityId,
          reportedById: d.reporter ? (staff.get(d.reporter) ?? null) : null,
          reporterRole: d.role,
          anonymous: d.reporter === null,
          occurredAt: daysAgo(d.occurred),
          reportedAt,
          unitId: d.unit ? (units.get(d.unit) ?? null) : null,
          location: d.location ?? null,
          category: d.category,
          harm: d.harm,
          description: d.description,
          immediateAction: d.immediateAction ?? null,
          patientId: d.patient ? (admitted?.id ?? null) : null,
          status,
          reviewerId: status === 'NEW' ? null : d.category === 'MEDICATION' ? pharmacist : director,
          reviewedHarm: d.reviewedHarm ?? null,
          contributingFactors: d.factors ?? null,
          findings: d.findings ?? null,
          lessons: d.lessons ?? null,
          hazardRef: d.hazardRef ?? null,
          patientInformedAt: d.informed !== undefined ? daysAgo(d.informed, 14) : null,
          closedAt: status === 'CLOSED' ? daysAgo(Math.max(0, d.occurred - 12)) : null,
        })
        .returning({ id: safetyIncidents.id });
      for (const a of d.actions ?? []) {
        await tx.insert(incidentActions).values({
          incidentId: row!.id,
          description: a.description,
          ownerId: a.owner ? (staff.get(a.owner) ?? null) : null,
          dueDate: isoDay(a.due),
          completedAt: a.done ? daysAgo(Math.max(0, -a.due)) : null,
          createdById: director,
        });
      }
    });
  }

  const others = await db
    .select({ id: facilities.id })
    .from(facilities)
    .where(inArray(facilities.code, ['RH-PZ', 'FMC-PE', 'FMC-GJ']));
  for (const [i, d] of [...OTHER].sort((a, b) => b.occurred - a.occurred).entries()) {
    const facility = others[i % Math.max(1, others.length)];
    if (!facility) break;
    const reportedAt = daysAgo(d.occurred, 13);
    const closed = d.occurred > 25;
    await db.transaction(async (tx) => {
      await tx.insert(safetyIncidents).values({
        reference: await nextIncidentReference(tx, reportedAt),
        facilityId: facility.id,
        reporterRole: d.role,
        anonymous: true,
        occurredAt: daysAgo(d.occurred, 9),
        reportedAt,
        category: d.category,
        harm: d.harm,
        description: 'Raport demonstrues (i sintetizuar) për statistikat kombëtare.',
        status: closed ? 'CLOSED' : 'NEW',
        reviewedHarm: closed ? d.harm : null,
        findings: closed ? 'Shqyrtim demonstrues.' : null,
        lessons: closed ? 'Mësim demonstrues.' : null,
        hazardRef: d.category === 'IT_SYSTEM' ? 'H01' : null,
        patientInformedAt: closed && d.harm === 'MODERATE' ? daysAgo(d.occurred - 1) : null,
        closedAt: closed ? daysAgo(d.occurred - 10) : null,
      });
    });
  }
}
