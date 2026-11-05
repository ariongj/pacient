/**
 * Synthetic demo data for death registration (development only): one signed certificate and one
 * draft for elderly synthetic patients in the demo doctor's care, plus a year of signed
 * certificates of other synthetic people so the mortality statistics have something to show.
 */
import { and, eq } from 'drizzle-orm';
import { nextCertificateNumber } from '../modules/deaths/deaths.service.js';
import { db } from './client.js';
import {
  admissions,
  careAssignments,
  careUnits,
  deathRecords,
  patients,
  type DeathCause,
} from './schema.js';

const DAY = 86_400_000;

async function freeNationalId(seed: number) {
  for (let n = seed; ; n++) {
    const candidate = String(n).padStart(10, '0');
    const [taken] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(eq(patients.nationalId, candidate));
    if (!taken) return candidate;
  }
}

async function person(
  facilityId: string,
  seed: number,
  p: { firstName: string; lastName: string; dateOfBirth: string; sex: 'MALE' | 'FEMALE' },
) {
  const [row] = await db
    .insert(patients)
    .values({
      ...p,
      nationalId: await freeNationalId(seed),
      primaryFacilityId: facilityId,
      municipality: 'Prishtinë',
    })
    .returning({ id: patients.id });
  return row!.id;
}

const cause = (
  line: DeathCause['line'],
  text: string,
  icd10: string,
  interval: string | null = null,
): DeathCause => ({ line, text, icd10, interval });

async function sign(id: string, signedAt: Date) {
  await db.transaction(async (tx) => {
    const certificateNumber = await nextCertificateNumber(tx, signedAt);
    await tx
      .update(deathRecords)
      .set({ status: 'SIGNED', signedAt, certificateNumber })
      .where(eq(deathRecords.id, id));
  });
}

export async function seedDeaths({
  facilityId,
  demoDoctorId,
}: {
  facilityId: string;
  demoDoctorId: string;
}): Promise<void> {
  const now = Date.now();

  // 1. Signed: an elderly man who died on the ward three days ago (stay discharged as deceased).
  const rexhep = await person(facilityId, 1938_000_001, {
    firstName: 'Rexhep',
    lastName: 'Morina',
    dateOfBirth: '1938-04-12',
    sex: 'MALE',
  });
  await db
    .insert(careAssignments)
    .values({ patientId: rexhep, doctorId: demoDoctorId, assignedById: demoDoctorId });
  const diedAt = new Date(now - 3 * DAY);
  const [ward] = await db
    .select({ id: careUnits.id })
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.type, 'GENERAL_WARD')))
    .limit(1);
  let admissionId: string | null = null;
  if (ward) {
    const [stay] = await db
      .insert(admissions)
      .values({
        patientId: rexhep,
        facilityId,
        unitId: ward.id,
        admittingDoctorId: demoDoctorId,
        attendingDoctorId: demoDoctorId,
        source: 'EMERGENCY',
        reason: 'Dhimbje gjoksi',
        admittedAt: new Date(now - 4 * DAY),
        status: 'DISCHARGED',
        dischargedAt: new Date(diedAt.getTime() + 2 * 3_600_000),
        dischargedById: demoDoctorId,
        disposition: 'DECEASED',
        dischargeSummary:
          'Pacienti u shtrua me infarkt akut të miokardit. Pavarësisht trajtimit vdiq në repart.',
        dischargeSignedAt: new Date(diedAt.getTime() + 2 * 3_600_000),
      })
      .returning({ id: admissions.id });
    admissionId = stay!.id;
  }
  const [signed] = await db
    .insert(deathRecords)
    .values({
      patientId: rexhep,
      facilityId,
      diedAt,
      placeOfDeath: 'HOSPITAL',
      admissionId,
      causes: [
        cause('a', 'Infarkt akut i miokardit', 'I21.9', '6 orë'),
        cause('b', 'Sëmundje aterosklerotike e zemrës', 'I25.1', '10 vjet'),
        cause('II', 'Diabet mellitus tip 2', 'E11.9', '15 vjet'),
      ],
      underlyingCauseIcd10: 'I25.1',
      mannerOfDeath: 'NATURAL',
      autopsy: 'NONE',
      certifiedById: demoDoctorId,
    })
    .returning({ id: deathRecords.id });
  await sign(signed!.id, new Date(diedAt.getTime() + 3 * 3_600_000));
  await db.update(patients).set({ deceasedAt: diedAt }).where(eq(patients.id, rexhep));

  // 2. Draft: an elderly woman who died at home this morning.
  const shpresa = await person(facilityId, 1945_000_001, {
    firstName: 'Shpresa',
    lastName: 'Lleshi',
    dateOfBirth: '1945-09-30',
    sex: 'FEMALE',
  });
  await db
    .insert(careAssignments)
    .values({ patientId: shpresa, doctorId: demoDoctorId, assignedById: demoDoctorId });
  await db.insert(deathRecords).values({
    patientId: shpresa,
    facilityId,
    diedAt: new Date(now - 8 * 3_600_000),
    placeOfDeath: 'HOME',
    causes: [
      cause('a', 'Pneumoni', 'J18.9', '5 ditë'),
      cause('b', 'Sëmundja e Alzheimerit', 'G30.9', '6 vjet'),
    ],
    underlyingCauseIcd10: 'G30.9',
    mannerOfDeath: 'NATURAL',
    autopsy: 'NONE',
    certifiedById: demoDoctorId,
  });

  // 3. A year of earlier certificates (synthetic people) for the statistics.
  const history: {
    first: string;
    last: string;
    dob: string;
    sex: 'MALE' | 'FEMALE';
    daysAgo: number;
    place: string;
    manner?: string;
    causes: DeathCause[];
    underlying: string;
  }[] = [
    {
      first: 'Avdyl',
      last: 'Hasani',
      dob: '1941-02-03',
      sex: 'MALE',
      daysAgo: 20,
      place: 'HOSPITAL',
      causes: [cause('a', 'Infarkt cerebral', 'I63.9')],
      underlying: 'I63.9',
    },
    {
      first: 'Fatime',
      last: 'Rama',
      dob: '1936-07-19',
      sex: 'FEMALE',
      daysAgo: 41,
      place: 'HOME',
      causes: [cause('a', 'Insuficiencë kardiake', 'I50.0'), cause('b', 'Hipertension', 'I11.0')],
      underlying: 'I11.0',
    },
    {
      first: 'Xhavit',
      last: 'Gashi',
      dob: '1950-11-08',
      sex: 'MALE',
      daysAgo: 63,
      place: 'HOSPITAL',
      causes: [cause('a', 'Kancer i mushkërive', 'C34.9')],
      underlying: 'C34.9',
    },
    {
      first: 'Hava',
      last: 'Berisha',
      dob: '1944-01-27',
      sex: 'FEMALE',
      daysAgo: 79,
      place: 'HOSPITAL',
      causes: [cause('a', 'Infarkt akut i miokardit', 'I21.9')],
      underlying: 'I21.9',
    },
    {
      first: 'Sabri',
      last: 'Kelmendi',
      dob: '1947-05-14',
      sex: 'MALE',
      daysAgo: 102,
      place: 'HOME',
      causes: [cause('a', 'Sëmundje obstruktive kronike e mushkërive', 'J44.9')],
      underlying: 'J44.9',
    },
    {
      first: 'Nazmije',
      last: 'Shala',
      dob: '1939-12-02',
      sex: 'FEMALE',
      daysAgo: 130,
      place: 'NURSING_HOME',
      causes: [cause('a', 'Goditje cerebrale', 'I64')],
      underlying: 'I64',
    },
    {
      first: 'Ilir',
      last: 'Osmani',
      dob: '1988-06-21',
      sex: 'MALE',
      daysAgo: 151,
      place: 'EMERGENCY_DEPARTMENT',
      manner: 'ACCIDENT',
      causes: [cause('a', 'Lëndim i shumëfishtë', 'T07'), cause('b', 'Aksident trafiku', 'V89.2')],
      underlying: 'V89.2',
    },
    {
      first: 'Mevlude',
      last: 'Krasniqi',
      dob: '1952-03-09',
      sex: 'FEMALE',
      daysAgo: 177,
      place: 'HOSPITAL',
      causes: [cause('a', 'Kancer i gjirit', 'C50.9')],
      underlying: 'C50.9',
    },
    {
      first: 'Bajram',
      last: 'Hoti',
      dob: '1943-08-30',
      sex: 'MALE',
      daysAgo: 205,
      place: 'HOSPITAL',
      causes: [cause('a', 'Sëmundje aterosklerotike e zemrës', 'I25.1')],
      underlying: 'I25.1',
    },
    {
      first: 'Remzije',
      last: 'Bytyqi',
      dob: '1949-10-11',
      sex: 'FEMALE',
      daysAgo: 233,
      place: 'HOME',
      causes: [cause('a', 'Diabet mellitus me komplikime', 'E11.7')],
      underlying: 'E11.7',
    },
    {
      first: 'Shaban',
      last: 'Zeqiri',
      dob: '1940-04-05',
      sex: 'MALE',
      daysAgo: 266,
      place: 'HOSPITAL',
      causes: [cause('a', 'Kancer i zorrës së trashë', 'C18.9')],
      underlying: 'C18.9',
    },
    {
      first: 'Zyhra',
      last: 'Mustafa',
      dob: '1935-09-17',
      sex: 'FEMALE',
      daysAgo: 301,
      place: 'HOSPITAL',
      causes: [cause('a', 'Infarkt cerebral', 'I63.9')],
      underlying: 'I63.9',
    },
    {
      first: 'Qazim',
      last: 'Ahmeti',
      dob: '1946-02-22',
      sex: 'MALE',
      daysAgo: 330,
      place: 'HOME',
      causes: [cause('a', 'Sëmundje obstruktive kronike e mushkërive', 'J44.9')],
      underlying: 'J44.9',
    },
  ];
  for (const [i, h] of history.entries()) {
    const id = await person(facilityId, 1930_000_100 + i * 13, {
      firstName: h.first,
      lastName: h.last,
      dateOfBirth: h.dob,
      sex: h.sex,
    });
    const at = new Date(now - h.daysAgo * DAY);
    const [rec] = await db
      .insert(deathRecords)
      .values({
        patientId: id,
        facilityId,
        diedAt: at,
        placeOfDeath: h.place,
        causes: h.causes,
        underlyingCauseIcd10: h.underlying,
        mannerOfDeath: h.manner ?? 'NATURAL',
        reportedToForensics: Boolean(h.manner),
        autopsy: h.manner ? 'PERFORMED' : 'NONE',
        certifiedById: demoDoctorId,
        createdAt: at,
      })
      .returning({ id: deathRecords.id });
    await sign(rec!.id, new Date(at.getTime() + 4 * 3_600_000));
    await db.update(patients).set({ deceasedAt: at }).where(eq(patients.id, id));
  }
}
