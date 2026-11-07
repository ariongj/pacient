/**
 * Demo data for notifiable disease surveillance (development seed only): the disease list, a few
 * diagnoses across facilities (brucellosis, a hepatitis A cluster in Ferizaj, a suspected measles
 * case, tuberculosis, an influenza wave), automatic detection, and reports in every state.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { isProd } from '../config/env.js';
import { db } from './client.js';
import {
  caseReports,
  careAssignments,
  diagnoses,
  facilities,
  notifiableDiseases,
  partnerClients,
  patients,
  users,
} from './schema.js';
import {
  detectCasesOnce,
  ensureDefaultDiseases,
} from '../modules/surveillance/surveillance.service.js';

const DAY = 86_400_000;
const daysAgo = (n: number, hour = 10) => {
  const d = new Date(Date.now() - n * DAY);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

export async function seedSurveillance({ facilityId }: { facilityId: string }) {
  if (isProd) throw new Error('Refusing to seed demo surveillance data in production');
  await ensureDefaultDiseases();

  const [demoDoctor] = await db.select().from(users).where(eq(users.email, 'doctor@pacient.local'));
  const [minister] = await db.select().from(users).where(eq(users.email, 'minister@pacient.local'));
  if (!demoDoctor) return;
  const otherFacilities = await db.select().from(facilities).where(ne(facilities.id, facilityId));
  const otherDoctors = await db
    .select({ id: users.id, facilityId: users.facilityId })
    .from(users)
    .where(
      and(
        eq(users.role, 'DOCTOR'),
        eq(users.isActive, true),
        inArray(
          users.facilityId,
          otherFacilities.map((f) => f.id),
        ),
      ),
    );
  const doctorAt = (fid: string) => otherDoctors.find((d) => d.facilityId === fid)?.id;

  // Synthetic patients for the cluster and wave (unique temporary-style national numbers).
  let seq = 0;
  const [{ max } = { max: null }] = await db
    .select({ max: sql<string | null>`max(${patients.nationalId})` })
    .from(patients)
    .where(sql`${patients.nationalId} LIKE '13%'`);
  let next = max ? Number(max) + 1 : 1_300_000_000;
  async function person(
    first: string,
    last: string,
    dob: string,
    sex: 'FEMALE' | 'MALE',
    municipality: string,
    primaryFacilityId: string,
    doctorId: string,
  ) {
    const [p] = await db
      .insert(patients)
      .values({
        nationalId: String(next++),
        firstName: first,
        lastName: last,
        dateOfBirth: dob,
        sex,
        municipality,
        primaryFacilityId,
      })
      .returning({ id: patients.id });
    await db.insert(careAssignments).values({ patientId: p!.id, doctorId }).onConflictDoNothing();
    seq++;
    return p!.id;
  }
  async function dx(
    patientId: string,
    doctorId: string,
    code: string,
    description: string,
    at: Date,
  ) {
    const [d] = await db
      .insert(diagnoses)
      .values({ patientId, doctorId, icd10Code: code, description, diagnosedAt: at })
      .returning({ id: diagnoses.id });
    return d!.id;
  }

  const prizren = otherFacilities.find((f) => f.municipality === 'Prizren') ?? otherFacilities[0];
  const gjilan = otherFacilities.find((f) => f.municipality === 'Gjilan') ?? otherFacilities[0];
  const peje = otherFacilities.find((f) => f.municipality === 'Pejë') ?? otherFacilities[0];

  // Demo doctor (UCC): suspected measles (immediately notifiable) and brucellosis – left as drafts.
  const measles = await person(
    'Ardian',
    'Morina',
    '2021-03-14',
    'MALE',
    'Prishtinë',
    facilityId,
    demoDoctor.id,
  );
  const measlesDx = await dx(
    measles,
    demoDoctor.id,
    'B05.9',
    'Fruth pa komplikime (i dyshuar)',
    daysAgo(1),
  );
  const bruc = await person(
    'Hajrije',
    'Rexhepi',
    '1968-07-02',
    'FEMALE',
    'Drenas',
    facilityId,
    demoDoctor.id,
  );
  const brucDx = await dx(bruc, demoDoctor.id, 'A23.9', 'Bruceloza, e papërcaktuar', daysAgo(3));

  // Hepatitis A cluster in Ferizaj (UCC and Gjilan), most of it in the last two weeks.
  const hepA: string[] = [];
  const hepNames: [string, string, string, 'FEMALE' | 'MALE'][] = [
    ['Elira', 'Kastrati', '2014-05-11', 'FEMALE'],
    ['Dren', 'Kastrati', '2016-09-23', 'MALE'],
    ['Leutrim', 'Shala', '2012-01-30', 'MALE'],
    ['Blerta', 'Shala', '2015-12-04', 'FEMALE'],
    ['Agon', 'Hasani', '2013-03-17', 'MALE'],
    ['Vesa', 'Hoxha', '2017-06-08', 'FEMALE'],
    ['Florent', 'Bajrami', '2011-10-21', 'MALE'],
  ];
  for (const [i, [f, l, dob, sex]] of hepNames.entries()) {
    const atUcc = i % 2 === 0 || !gjilan || !doctorAt(gjilan.id);
    const fid = atUcc ? facilityId : gjilan!.id;
    const doc = atUcc ? demoDoctor.id : doctorAt(gjilan!.id)!;
    const p = await person(f, l, dob, sex, 'Ferizaj', fid, doc);
    hepA.push(
      await dx(
        p,
        doc,
        'B15.9',
        'Hepatiti akut A pa koma hepatike',
        daysAgo(i < 5 ? i + 1 : 16 + i),
      ),
    );
  }

  // Tuberculosis (Prizren) and an influenza wave across the country over six weeks.
  if (prizren && doctorAt(prizren.id)) {
    const tb = await person(
      'Sefedin',
      'Krasniqi',
      '1959-02-19',
      'MALE',
      'Prizren',
      prizren.id,
      doctorAt(prizren.id)!,
    );
    await dx(
      tb,
      doctorAt(prizren.id)!,
      'A15.0',
      'Tuberkuloz pulmonare, e konfirmuar mikroskopikisht',
      daysAgo(9),
    );
  }
  const fluPlaces = [
    { f: facilityId, m: 'Prishtinë', d: demoDoctor.id },
    ...(peje && doctorAt(peje.id) ? [{ f: peje.id, m: 'Pejë', d: doctorAt(peje.id)! }] : []),
    ...(prizren && doctorAt(prizren.id)
      ? [{ f: prizren.id, m: 'Prizren', d: doctorAt(prizren.id)! }]
      : []),
  ];
  const fluPerWeek = [1, 2, 2, 4, 6, 9];
  const fluNames = [
    'Arbër',
    'Teuta',
    'Liridon',
    'Mimoza',
    'Besnik',
    'Shpresa',
    'Valon',
    'Donika',
    'Ilir',
    'Nora',
  ];
  for (const [weekIdx, n] of fluPerWeek.entries()) {
    for (let k = 0; k < n; k++) {
      const place = fluPlaces[(weekIdx + k) % fluPlaces.length]!;
      const nameIndex = (weekIdx * 3 + k) % fluNames.length;
      const name = fluNames[nameIndex]!;
      const p = await person(
        name,
        'Gashi',
        `19${60 + ((weekIdx * 7 + k) % 39)}-0${1 + (k % 9)}-1${k % 9}`,
        // The list alternates male and female first names.
        nameIndex % 2 ? 'FEMALE' : 'MALE',
        place.m,
        place.f,
        place.d,
      );
      await dx(
        p,
        place.d,
        'J11.1',
        'Grip me manifestime të tjera respiratore',
        daysAgo((5 - weekIdx) * 7 + (k % 5)),
      );
    }
  }

  await detectCasesOnce();

  // Most reports are submitted (and some reviewed); the demo doctor keeps a few drafts.
  const keepDrafts = new Set([measlesDx, brucDx, hepA[0]!]);
  const all = await db
    .select({
      id: caseReports.id,
      diagnosisId: caseReports.diagnosisId,
      createdAt: caseReports.createdAt,
    })
    .from(caseReports);
  const details = {
    symptoms: ['ethe', 'lodhje'],
    hospitalised: false,
    vaccinationStatus: 'UNKNOWN',
    notes: 'Raport demonstrues – të dhëna sintetike.',
  };
  for (const [i, c] of all.entries()) {
    if (c.diagnosisId && keepDrafts.has(c.diagnosisId)) continue;
    const reviewed = i % 3 === 0 && minister;
    await db
      .update(caseReports)
      .set({
        status: reviewed ? 'REVIEWED' : 'SUBMITTED',
        classification: i % 4 === 0 ? 'CONFIRMED' : 'PROBABLE',
        details,
        submittedAt: new Date(c.createdAt.getTime() + 6 * 3_600_000),
        ...(reviewed
          ? {
              reviewedById: minister!.id,
              reviewedAt: new Date(),
              reviewNote: 'Rasti u verifikua nga IKShPK.',
            }
          : {}),
      })
      .where(eq(caseReports.id, c.id));
  }

  // The public-health partner system may read the surveillance feed.
  await db
    .update(partnerClients)
    .set({ scopes: sql`array_append(${partnerClients.scopes}, 'surveillance.read')` })
    .where(
      and(
        eq(partnerClients.organisation, 'Instituti Kombëtar i Shëndetit Publik'),
        sql`NOT ('surveillance.read' = ANY(${partnerClients.scopes}))`,
      ),
    );
  void seq;
  void notifiableDiseases;
}
