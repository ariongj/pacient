import { and, eq } from 'drizzle-orm';
import { db } from './client.js';
import {
  antenatalVisits,
  births,
  careAssignments,
  labResults,
  patients,
  pregnancies,
  users,
} from './schema.js';
import {
  addDays,
  ageOn,
  encodeRiskFactors,
  eddFromLmp,
  kosovoDay,
  riskLevelFor,
  withAgeFactors,
  type RiskFactor,
} from '../modules/maternity/definitions.js';

interface Obs {
  /** Gestational week of the visit. */
  week: number;
  sys?: number;
  dia?: number;
  protein?: string;
  fhr?: number;
  movements?: boolean;
  presentation?: string;
  notes?: string;
}

interface Demo {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  municipality: string;
  /** Gestational age today (weeks, days). */
  ga: [number, number];
  bookedAtWeek: number;
  gravida: number;
  para: number;
  risk: RiskFactor[];
  visits: Obs[];
  bookingBloods: boolean;
  nextVisitInDays?: number;
}

/** Synthetic pregnant patients in the demo doctor's (and nurse's) care. */
const DEMO: Demo[] = [
  {
    firstName: 'Blerta',
    lastName: 'Gashi',
    dateOfBirth: '1998-04-11',
    municipality: 'Prishtinë',
    ga: [10, 3],
    bookedAtWeek: 9,
    gravida: 1,
    para: 0,
    risk: [],
    visits: [{ week: 9, sys: 112, dia: 70 }],
    bookingBloods: true,
    nextVisitInDays: 12,
  },
  {
    firstName: 'Arbëresha',
    lastName: 'Krasniqi',
    dateOfBirth: '1993-02-02',
    municipality: 'Prishtinë',
    ga: [22, 1],
    bookedAtWeek: 11,
    gravida: 2,
    para: 1,
    risk: [],
    visits: [
      { week: 11, sys: 115, dia: 72 },
      { week: 20, sys: 118, dia: 74, fhr: 148 },
    ],
    bookingBloods: true,
    nextVisitInDays: 24,
  },
  {
    firstName: 'Vjollca',
    lastName: 'Berisha',
    dateOfBirth: '1988-07-19',
    municipality: 'Fushë Kosovë',
    ga: [30, 2],
    bookedAtWeek: 10,
    gravida: 3,
    para: 2,
    risk: ['PREVIOUS_CAESAREAN'],
    visits: [
      { week: 10, sys: 120, dia: 76 },
      { week: 20, sys: 118, dia: 72, fhr: 150 },
      { week: 26, sys: 122, dia: 78, fhr: 144 },
      {
        week: 30,
        sys: 124,
        dia: 80,
        fhr: 140,
        notes: 'U diskutua plani i lindjes: prerje cezariane e përsëritur',
      },
    ],
    bookingBloods: true,
    nextVisitInDays: 14,
  },
  {
    firstName: 'Teuta',
    lastName: 'Shala',
    dateOfBirth: '1984-12-03',
    municipality: 'Prishtinë',
    ga: [34, 0],
    bookedAtWeek: 11,
    gravida: 4,
    para: 2,
    risk: ['GESTATIONAL_DIABETES'],
    visits: [
      { week: 11, sys: 124, dia: 78 },
      { week: 20, sys: 126, dia: 80, fhr: 152 },
      { week: 26, sys: 128, dia: 82, fhr: 146 },
      {
        week: 30,
        sys: 130,
        dia: 84,
        fhr: 142,
        notes: 'U shqyrtua ditari i glukozës; kontroll me dietë',
      },
    ],
    bookingBloods: true,
    nextVisitInDays: 1,
  },
  {
    firstName: 'Mimoza',
    lastName: 'Rexhepi',
    dateOfBirth: '2000-09-14',
    municipality: 'Obiliq',
    ga: [33, 4],
    bookedAtWeek: 12,
    gravida: 1,
    para: 0,
    risk: [],
    visits: [
      { week: 12, sys: 116, dia: 70 },
      { week: 20, sys: 120, dia: 74, fhr: 150 },
      { week: 26, sys: 126, dia: 80, fhr: 146 },
      {
        week: 33,
        sys: 148,
        dia: 96,
        protein: '1+',
        fhr: 140,
        notes: 'Dhimbje koke prej dy ditësh. U dërgua në repartin ditor të lindjes për vlerësim.',
      },
    ],
    bookingBloods: true,
    nextVisitInDays: 2,
  },
  {
    firstName: 'Donjeta',
    lastName: 'Morina',
    dateOfBirth: '1995-05-25',
    municipality: 'Prishtinë',
    ga: [38, 3],
    bookedAtWeek: 10,
    gravida: 2,
    para: 1,
    risk: [],
    visits: [
      { week: 10, sys: 110, dia: 68 },
      { week: 20, sys: 112, dia: 70, fhr: 148 },
      { week: 26, sys: 114, dia: 72, fhr: 144 },
      { week: 30, sys: 116, dia: 72, fhr: 140 },
      { week: 34, sys: 118, dia: 74, fhr: 142, presentation: 'CEPHALIC' },
      { week: 36, sys: 118, dia: 76, fhr: 138, presentation: 'CEPHALIC' },
      { week: 38, sys: 120, dia: 76, fhr: 140, presentation: 'CEPHALIC' },
    ],
    bookingBloods: true,
    nextVisitInDays: 7,
  },
  {
    firstName: 'Fjolla',
    lastName: 'Hoxha',
    dateOfBirth: '1996-01-30',
    municipality: 'Gllogoc',
    ga: [42, 2],
    bookedAtWeek: 12,
    gravida: 1,
    para: 0,
    risk: [],
    visits: [
      { week: 12, sys: 112, dia: 70 },
      { week: 20, sys: 114, dia: 72, fhr: 150 },
      { week: 26, sys: 116, dia: 72, fhr: 146 },
      { week: 30, sys: 116, dia: 74, fhr: 142 },
      { week: 34, sys: 118, dia: 74, fhr: 140, presentation: 'CEPHALIC' },
      { week: 36, sys: 118, dia: 76, fhr: 138, presentation: 'CEPHALIC' },
      { week: 38, sys: 120, dia: 76, fhr: 140, presentation: 'CEPHALIC' },
      {
        week: 40,
        sys: 120,
        dia: 78,
        fhr: 136,
        presentation: 'CEPHALIC',
        notes: 'U ofrua shkëputja e membranave',
      },
    ],
    bookingBloods: true,
  },
  {
    firstName: 'Elona',
    lastName: 'Bytyqi',
    dateOfBirth: '2007-03-08',
    municipality: 'Prishtinë',
    ga: [16, 2],
    bookedAtWeek: 15,
    gravida: 1,
    para: 0,
    risk: [],
    visits: [{ week: 15, sys: 108, dia: 66 }],
    bookingBloods: false,
    nextVisitInDays: 3,
  },
  {
    firstName: 'Lirie',
    lastName: 'Kelmendi',
    dateOfBirth: '2001-10-21',
    municipality: 'Podujevë',
    ga: [26, 0],
    bookedAtWeek: 12,
    gravida: 2,
    para: 0,
    risk: ['SMOKING', 'ANAEMIA'],
    visits: [
      { week: 12, sys: 110, dia: 70, notes: 'U dha këshillë për lënien e duhanit' },
      { week: 16, sys: 112, dia: 70 },
    ],
    bookingBloods: true,
  },
];

const BOOKING_BLOODS: [string, string, string, string | null][] = [
  ['Grupi i gjakut ABO/Rh', 'A Rh+', '', '882-1'],
  ['Hemoglobina', '121', 'g/L', '718-7'],
  ['HIV 1/2 Ag/Ab', 'Negativ', '', '56888-1'],
  ['Sifilizi (RPR)', 'Negativ', '', '20507-0'],
  ['HBsAg', 'Negativ', '', '5196-1'],
];

const at = (day: string, hour = 9) => new Date(`${day}T${String(hour).padStart(2, '0')}:30:00Z`);

async function freeNationalId(start: number) {
  for (let n = start; ; n++) {
    const [taken] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.nationalId, String(n)));
    if (!taken) return String(n);
  }
}

/** Synthetic demo data for antenatal care (development only). */
export async function seedMaternity(opts: { facilityId: string; demoDoctorId: string }) {
  const today = kosovoDay(new Date());
  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  let nextId = 1288100001;
  for (const d of DEMO) {
    const nationalId = await freeNationalId(nextId);
    nextId = Number(nationalId) + 1;
    const [p] = await db
      .insert(patients)
      .values({
        nationalId,
        firstName: d.firstName,
        lastName: d.lastName,
        dateOfBirth: d.dateOfBirth,
        sex: 'FEMALE',
        municipality: d.municipality,
        primaryFacilityId: opts.facilityId,
      })
      .returning({ id: patients.id });
    const team = [opts.demoDoctorId, ...(nurse ? [nurse.id] : [])];
    for (const member of team) {
      await db
        .insert(careAssignments)
        .values({ patientId: p!.id, doctorId: member, assignedById: opts.demoDoctorId });
    }
    const lmp = addDays(today, -(d.ga[0] * 7 + d.ga[1]));
    const bookedDay = addDays(lmp, d.bookedAtWeek * 7);
    const codes = withAgeFactors(d.risk, ageOn(d.dateOfBirth, bookedDay));
    const [preg] = await db
      .insert(pregnancies)
      .values({
        patientId: p!.id,
        facilityId: opts.facilityId,
        lmpDate: lmp,
        eddDate: eddFromLmp(lmp),
        eddMethod: 'LMP',
        gravida: d.gravida,
        para: d.para,
        riskFactors: encodeRiskFactors(codes),
        riskLevel: riskLevelFor(codes),
        bookedById: nurse?.id ?? opts.demoDoctorId,
        createdAt: at(bookedDay),
        updatedAt: at(bookedDay),
      })
      .returning({ id: pregnancies.id });
    for (const [i, v] of d.visits.entries()) {
      const day = addDays(lmp, v.week * 7);
      const last = i === d.visits.length - 1;
      await db.insert(antenatalVisits).values({
        pregnancyId: preg!.id,
        patientId: p!.id,
        facilityId: opts.facilityId,
        visitAt: at(day, 9 + (i % 3)),
        gestationDays: v.week * 7,
        systolic: v.sys ?? null,
        diastolic: v.dia ?? null,
        weightKg: String(58 + v.week * 0.35 + (d.gravida % 3)),
        fundalHeightCm: v.week >= 24 ? String(v.week) : null,
        fetalHeartRate: v.fhr ?? null,
        presentation: v.presentation ?? null,
        urineProtein: v.protein ?? 'NEGATIVE',
        oedema: false,
        fetalMovements: v.week >= 24 ? (v.movements ?? true) : null,
        notes: v.notes ?? null,
        nextVisitDate:
          last && d.nextVisitInDays !== undefined ? addDays(today, d.nextVisitInDays) : null,
        recordedById: nurse?.id ?? opts.demoDoctorId,
        createdAt: at(day, 10),
      });
    }
    if (d.bookingBloods) {
      for (const [testName, value, unit, code] of BOOKING_BLOODS) {
        await db.insert(labResults).values({
          patientId: p!.id,
          orderedById: opts.demoDoctorId,
          testName,
          value,
          unit: unit || null,
          testCode: code,
          collectedAt: at(addDays(bookedDay, 1), 8),
        });
      }
    }
  }

  // Drita Hoxha's pregnancy, closed by the birth seeded earlier.
  const [drita] = await db
    .select({ id: patients.id })
    .from(patients)
    .where(and(eq(patients.firstName, 'Drita'), eq(patients.lastName, 'Hoxha')))
    .limit(1);
  if (drita) {
    const [birth] = await db
      .select()
      .from(births)
      .where(eq(births.motherPatientId, drita.id))
      .limit(1);
    if (birth) {
      const bornDay = kosovoDay(birth.bornAt);
      const gaAtBirth = birth.gestationalWeeks * 7 + birth.gestationalDays;
      const lmp = addDays(bornDay, -gaAtBirth);
      const bookedDay = addDays(lmp, 11 * 7);
      const [preg] = await db
        .insert(pregnancies)
        .values({
          patientId: drita.id,
          facilityId: opts.facilityId,
          lmpDate: lmp,
          eddDate: eddFromLmp(lmp),
          eddMethod: 'LMP',
          gravida: 2,
          para: 1,
          riskFactors: [],
          riskLevel: 'LOW',
          status: 'DELIVERED',
          endedAt: birth.bornAt,
          birthId: birth.id,
          bookedById: opts.demoDoctorId,
          createdAt: at(bookedDay),
          updatedAt: birth.bornAt,
        })
        .returning({ id: pregnancies.id });
      for (const week of [11, 20, 26, 30, 34, 36, 38]) {
        if (week * 7 > gaAtBirth) break;
        const day = addDays(lmp, week * 7);
        await db.insert(antenatalVisits).values({
          pregnancyId: preg!.id,
          patientId: drita.id,
          facilityId: opts.facilityId,
          visitAt: at(day),
          gestationDays: week * 7,
          systolic: 114,
          diastolic: 72,
          weightKg: String(62 + week * 0.3),
          fundalHeightCm: week >= 24 ? String(week) : null,
          fetalHeartRate: week >= 20 ? 144 : null,
          presentation: week >= 36 ? 'CEPHALIC' : null,
          urineProtein: 'NEGATIVE',
          recordedById: opts.demoDoctorId,
          createdAt: at(day, 10),
        });
      }
    }
  }
}
