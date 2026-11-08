/**
 * Synthetic demo data for the cancer registry (development only): about 120 registered cancers of
 * synthetic people over five years in several municipalities, a few cancers in the demo doctor's
 * care, registrations for two of the seeded cancer deaths (the third stays a death-certificate-only
 * candidate) and two tumour board meetings: one held with recommendations, one upcoming.
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from './client.js';
import {
  cancerCases,
  careAssignments,
  deathRecords,
  facilities,
  mdtCaseReviews,
  mdtMeetings,
  patients,
  users,
} from './schema.js';

const DAY = 86_400_000;

/** Small deterministic generator so every seed gives the same registry. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

type Site = {
  icd10: string;
  topography: string;
  morphology: string;
  weight: number;
  sex?: 'MALE' | 'FEMALE';
  paired?: boolean;
};

const SITES: Site[] = [
  { icd10: 'C34.1', topography: 'C34.1', morphology: '8140/3', weight: 14, paired: true },
  { icd10: 'C34.9', topography: 'C34.9', morphology: '8070/3', weight: 8, paired: true },
  {
    icd10: 'C50.4',
    topography: 'C50.4',
    morphology: '8500/3',
    weight: 16,
    sex: 'FEMALE',
    paired: true,
  },
  { icd10: 'C18.7', topography: 'C18.7', morphology: '8140/3', weight: 9 },
  { icd10: 'C20', topography: 'C20.9', morphology: '8140/3', weight: 5 },
  { icd10: 'C61', topography: 'C61.9', morphology: '8140/3', weight: 10, sex: 'MALE' },
  { icd10: 'C67.9', topography: 'C67.9', morphology: '8120/3', weight: 5 },
  { icd10: 'C16.9', topography: 'C16.9', morphology: '8140/3', weight: 4 },
  { icd10: 'C53.9', topography: 'C53.9', morphology: '8070/3', weight: 4, sex: 'FEMALE' },
  { icd10: 'C73', topography: 'C73.9', morphology: '8260/3', weight: 4 },
  { icd10: 'C22.0', topography: 'C22.0', morphology: '8170/3', weight: 2 },
  { icd10: 'C25.9', topography: 'C25.9', morphology: '8500/3', weight: 3 },
  { icd10: 'C64', topography: 'C64.9', morphology: '8312/3', weight: 3, paired: true },
  { icd10: 'C71.9', topography: 'C71.9', morphology: '9440/3', weight: 2 },
  { icd10: 'C90.0', topography: 'C42.1', morphology: '9732/3', weight: 2 },
  { icd10: 'C43.5', topography: 'C44.5', morphology: '8720/3', weight: 2 },
  { icd10: 'C32.9', topography: 'C32.9', morphology: '8070/3', weight: 2, sex: 'MALE' },
  {
    icd10: 'D05.1',
    topography: 'C50.2',
    morphology: '8500/2',
    weight: 2,
    sex: 'FEMALE',
    paired: true,
  },
];

const MUNICIPALITIES = [
  ['Prishtinë', 30],
  ['Prizren', 14],
  ['Ferizaj', 10],
  ['Pejë', 9],
  ['Gjakovë', 9],
  ['Gjilan', 8],
  ['Mitrovicë', 8],
  ['Podujevë', 6],
  ['Vushtrri', 4],
  ['Suharekë', 2],
] as const;

const FIRST_M = [
  'Agim',
  'Besim',
  'Driton',
  'Fatmir',
  'Gëzim',
  'Hysen',
  'Ilir',
  'Kujtim',
  'Nexhat',
  'Rexhep',
  'Shkelzen',
  'Valon',
];
const FIRST_F = [
  'Arta',
  'Blerta',
  'Drita',
  'Fatime',
  'Hana',
  'Lirije',
  'Mimoza',
  'Nora',
  'Shqipe',
  'Teuta',
  'Valbona',
  'Zana',
];
const LAST = [
  'Berisha',
  'Gashi',
  'Krasniqi',
  'Hoxha',
  'Morina',
  'Shala',
  'Bytyqi',
  'Kastrati',
  'Rexhepi',
  'Kryeziu',
  'Hajdari',
  'Sylaj',
];

function pick<T>(r: () => number, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)]!;
}
function weighted<T>(r: () => number, items: readonly T[], w: (t: T) => number): T {
  const total = items.reduce((s, x) => s + w(x), 0);
  let x = r() * total;
  for (const it of items) {
    x -= w(it);
    if (x < 0) return it;
  }
  return items[items.length - 1]!;
}

function stageFor(r: () => number, morphology: string) {
  if (morphology.endsWith('/2')) return { stage: '0', t: 'Tis', n: 'N0', m: 'M0' } as const;
  const roll = r();
  if (roll < 0.08) return { stage: 'UNKNOWN', t: null, n: null, m: null } as const;
  if (roll < 0.3) return { stage: 'I', t: 'cT1', n: 'N0', m: 'M0' } as const;
  if (roll < 0.55) return { stage: 'II', t: 'cT2', n: 'N0', m: 'M0' } as const;
  if (roll < 0.8) return { stage: 'III', t: 'cT3', n: 'N1', m: 'M0' } as const;
  return { stage: 'IV', t: 'cT3', n: 'N2', m: 'M1' } as const;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function seedOncology(opts: { facilityId: string; demoDoctorId: string }) {
  const { facilityId, demoDoctorId } = opts;
  const r = rng(20_211);
  const now = Date.now();
  const allFacilities = await db
    .select({ id: facilities.id, municipality: facilities.municipality })
    .from(facilities)
    .where(eq(facilities.isActive, true));
  const doctors = await db
    .select({ id: users.id, facilityId: users.facilityId })
    .from(users)
    .where(and(eq(users.role, 'DOCTOR'), eq(users.isActive, true)));
  const doctorOf = (fid: string) => doctors.find((d) => d.facilityId === fid)?.id ?? demoDoctorId;
  const facilityFor = (mun: string) =>
    allFacilities.find((f) => f.municipality === mun)?.id ?? facilityId;

  // 1. Registry history: synthetic people, one cancer each.
  const taken = new Set(
    (
      await db
        .select({ n: patients.nationalId })
        .from(patients)
        .where(like(patients.nationalId, '19500%'))
    ).map((x) => x.n),
  );
  let idSeed = 1_950_020_000;
  const nextId = () => {
    while (taken.has(String(idSeed).padStart(10, '0'))) idSeed++;
    const v = String(idSeed++).padStart(10, '0');
    taken.add(v);
    return v;
  };

  const rows: (typeof cancerCases.$inferInsert)[] = [];
  for (let i = 0; i < 115; i++) {
    const site = weighted(r, SITES, (s) => s.weight);
    const sex = site.sex ?? (r() < 0.52 ? 'MALE' : 'FEMALE');
    const [mun] = weighted(r, MUNICIPALITIES, (m) => m[1]);
    const diagnosed = new Date(now - Math.floor(r() * 5 * 365) * DAY - 2 * DAY);
    const age =
      site.morphology === '8260/3' ? 30 + Math.floor(r() * 35) : 42 + Math.floor(r() * 44);
    const dob = new Date(diagnosed.getTime() - (age * 365.25 + Math.floor(r() * 300)) * DAY);
    const fid = facilityFor(mun);
    const [p] = await db
      .insert(patients)
      .values({
        nationalId: nextId(),
        firstName: pick(r, sex === 'MALE' ? FIRST_M : FIRST_F),
        lastName: pick(r, LAST),
        dateOfBirth: iso(dob),
        sex,
        municipality: mun,
        primaryFacilityId: fid,
      })
      .returning({ id: patients.id });
    const st = stageFor(r, site.morphology);
    const basisRoll = r();
    rows.push({
      patientId: p!.id,
      facilityId: fid,
      diagnosedOn: iso(diagnosed),
      icd10: site.icd10,
      topography: site.topography,
      morphology: site.morphology,
      laterality: site.paired ? (r() < 0.5 ? 'LEFT' : 'RIGHT') : 'NOT_APPLICABLE',
      basisOfDiagnosis:
        basisRoll < 0.82 ? 'HISTOLOGY' : basisRoll < 0.9 ? 'CYTOLOGY' : 'CLINICAL_INVESTIGATION',
      tnmT: st.t,
      tnmN: st.n,
      tnmM: st.m,
      stage: st.stage,
      tnmEdition: st.t ? '8' : null,
      registeredById: doctorOf(fid),
      createdAt: new Date(diagnosed.getTime() + 10 * DAY),
    });
  }
  await db.insert(cancerCases).values(rows);

  // 2. Cancers in the demo doctor's care (patients for the chart tab and the tumour boards).
  const demo = [
    {
      firstName: 'Merita',
      lastName: 'Dervishi',
      dateOfBirth: '1968-04-12',
      sex: 'FEMALE' as const,
      site: {
        icd10: 'C50.4',
        topography: 'C50.4',
        morphology: '8500/3',
        laterality: 'LEFT' as const,
      },
      tnm: ['cT2', 'N1', 'M0', 'II'],
      daysAgo: 40,
    },
    {
      firstName: 'Bujar',
      lastName: 'Lushi',
      dateOfBirth: '1957-09-03',
      sex: 'MALE' as const,
      site: {
        icd10: 'C34.1',
        topography: 'C34.1',
        morphology: '8140/3',
        laterality: 'RIGHT' as const,
      },
      tnm: ['cT3', 'N2', 'M0', 'III'],
      daysAgo: 25,
    },
    {
      firstName: 'Sevdije',
      lastName: 'Thaçi',
      dateOfBirth: '1961-01-28',
      sex: 'FEMALE' as const,
      site: {
        icd10: 'C18.7',
        topography: 'C18.7',
        morphology: '8140/3',
        laterality: 'NOT_APPLICABLE' as const,
      },
      tnm: ['pT3', 'pN0', 'M0', 'II'],
      daysAgo: 70,
    },
    {
      firstName: 'Fadil',
      lastName: 'Hyseni',
      dateOfBirth: '1950-06-17',
      sex: 'MALE' as const,
      site: {
        icd10: 'C61',
        topography: 'C61.9',
        morphology: '8140/3',
        laterality: 'NOT_APPLICABLE' as const,
      },
      tnm: ['cT2', 'N0', 'M0', 'II'],
      daysAgo: 12,
    },
  ];
  const demoCases: { patientId: string; caseId: string }[] = [];
  for (const d of demo) {
    const [p] = await db
      .insert(patients)
      .values({
        nationalId: nextId(),
        firstName: d.firstName,
        lastName: d.lastName,
        dateOfBirth: d.dateOfBirth,
        sex: d.sex,
        municipality: 'Prishtinë',
        primaryFacilityId: facilityId,
      })
      .returning({ id: patients.id });
    await db.insert(careAssignments).values({ patientId: p!.id, doctorId: demoDoctorId });
    const [c] = await db
      .insert(cancerCases)
      .values({
        patientId: p!.id,
        facilityId,
        diagnosedOn: iso(new Date(now - d.daysAgo * DAY)),
        ...d.site,
        basisOfDiagnosis: 'HISTOLOGY',
        tnmT: d.tnm[0],
        tnmN: d.tnm[1],
        tnmM: d.tnm[2],
        stage: d.tnm[3],
        tnmEdition: '8',
        registeredById: demoDoctorId,
        createdAt: new Date(now - (d.daysAgo - 5) * DAY),
      })
      .returning({ id: cancerCases.id });
    demoCases.push({ patientId: p!.id, caseId: c!.id });
  }

  // 3. Seeded cancer deaths: breast and colon were registered in life; lung stays a
  //    death-certificate-only candidate for the demo doctor.
  const deaths = await db
    .select({
      patientId: deathRecords.patientId,
      icd10: deathRecords.underlyingCauseIcd10,
      diedAt: deathRecords.diedAt,
    })
    .from(deathRecords)
    .where(
      and(
        eq(deathRecords.status, 'SIGNED'),
        eq(deathRecords.certifiedById, demoDoctorId),
        inArray(deathRecords.underlyingCauseIcd10, ['C50.9', 'C18.9']),
      ),
    );
  for (const d of deaths) {
    const breast = d.icd10 === 'C50.9';
    await db.insert(cancerCases).values({
      patientId: d.patientId,
      facilityId,
      diagnosedOn: iso(new Date(d.diedAt.getTime() - 600 * DAY)),
      icd10: breast ? 'C50.9' : 'C18.9',
      topography: breast ? 'C50.9' : 'C18.9',
      morphology: breast ? '8500/3' : '8140/3',
      laterality: breast ? 'RIGHT' : 'NOT_APPLICABLE',
      basisOfDiagnosis: 'HISTOLOGY',
      stage: 'III',
      registeredById: demoDoctorId,
    });
  }

  // 4. Tumour boards: one held a week ago, one next week with three patients.
  const at = (days: number, hour: number) => {
    const d = new Date(now + days * DAY);
    d.setUTCHours(hour - 1, 0, 0, 0); // 13:00 local (CET) for hour 13
    return d;
  };
  const colleague = doctors.find((d) => d.facilityId === facilityId && d.id !== demoDoctorId);
  const attendees = [
    'Dr. Arben Hoxha – onkolog',
    'Dr. Lindita Morina – kirurge',
    'Dr. Valon Kryeziu – radiolog',
    'Dr. Shpresa Gashi – patologe',
  ];
  const [held] = await db
    .insert(mdtMeetings)
    .values({
      facilityId,
      tumourGroup: 'BREAST',
      scheduledFor: at(-7, 13),
      chairId: demoDoctorId,
      status: 'HELD',
      attendees,
    })
    .returning({ id: mdtMeetings.id });
  const [upcoming] = await db
    .insert(mdtMeetings)
    .values({
      facilityId,
      tumourGroup: 'OTHER',
      scheduledFor: at(7, 13),
      chairId: colleague?.id ?? demoDoctorId,
    })
    .returning({ id: mdtMeetings.id });
  const [merita, bujar, sevdije, fadil] = demoCases;
  await db.insert(mdtCaseReviews).values([
    {
      meetingId: held!.id,
      patientId: merita!.patientId,
      cancerCaseId: merita!.caseId,
      referredById: demoDoctorId,
      question: 'Kirurgji fillestare apo kimioterapi neoadjuvante?',
      summary:
        'Karcinom duktal invaziv i gjirit të majtë, 28 mm, një nyje limfatike aksilare e prekur. ER+/HER2–.',
      recommendation: 'COMBINED',
      recommendationText:
        'Kimioterapi neoadjuvante, pastaj kirurgji konservuese dhe radioterapi. Rivlerësim pas 3 cikleve.',
      status: 'DISCUSSED',
      decidedAt: at(-7, 14),
      recordedById: demoDoctorId,
      patientInformedAt: at(-5, 10),
      createdAt: at(-12, 9),
    },
    {
      meetingId: held!.id,
      patientId: sevdije!.patientId,
      cancerCaseId: sevdije!.caseId,
      referredById: demoDoctorId,
      question: 'A nevojitet kimioterapi adjuvante pas hemikolektomisë?',
      summary: 'Adenokarcinom i kolonit sigmoid, pT3 pN0 (0/18), kufij të lirë.',
      recommendation: 'SURVEILLANCE',
      recommendationText: 'Pa kimioterapi adjuvante. Ndjekje me CEA dhe CT sipas protokollit.',
      status: 'DISCUSSED',
      decidedAt: at(-7, 14),
      recordedById: demoDoctorId,
      createdAt: at(-11, 9),
    },
    {
      meetingId: upcoming!.id,
      patientId: bujar!.patientId,
      cancerCaseId: bujar!.caseId,
      referredById: demoDoctorId,
      question: 'Kemoradioterapi definitive apo kirurgji pas induksionit?',
      summary:
        'Adenokarcinom i lobit të sipërm të djathtë, cT3 N2 M0; PET pa metastaza në distancë.',
      createdAt: at(-2, 9),
    },
    {
      meetingId: upcoming!.id,
      patientId: fadil!.patientId,
      cancerCaseId: fadil!.caseId,
      referredById: demoDoctorId,
      question: 'Prostatektomi radikale apo radioterapi?',
      summary: 'Adenokarcinom i prostatës, Gleason 3+4, PSA 8,2 ng/ml, cT2 N0 M0.',
      createdAt: at(-1, 9),
    },
    {
      meetingId: upcoming!.id,
      patientId: merita!.patientId,
      cancerCaseId: merita!.caseId,
      referredById: demoDoctorId,
      question: 'Rivlerësim pas tre cikleve të kimioterapisë neoadjuvante.',
      summary: 'Përgjigje e pjesshme klinike, tumori 15 mm në ultratingull.',
      createdAt: at(-1, 10),
    },
  ]);
}
