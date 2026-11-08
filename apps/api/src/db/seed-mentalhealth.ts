import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  admissions,
  beds,
  careUnits,
  involuntaryAdmissions,
  patients,
  restrictiveInterventions,
  unitStaff,
  users,
} from './schema.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function freeNationalId(start: number) {
  for (let n = start; ; n++) {
    const [taken] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(sql`${patients.nationalId} = ${String(n)}`);
    if (!taken) return String(n);
  }
}

/** Synthetic people (no real persons). */
const CURRENT = [
  ['Ilir', 'Berisha', 'MALE', '1991-04-12'],
  ['Shpresa', 'Kelmendi', 'FEMALE', '1978-09-30'],
  ['Driton', 'Gashi', 'MALE', '1999-01-22'],
  ['Valbona', 'Rexhepi', 'FEMALE', '1985-06-05'],
] as const;
const PAST = [
  ['Arben', 'Hoxha', 'MALE', '1970-02-14'],
  ['Mimoza', 'Shala', 'FEMALE', '1993-11-08'],
  ['Besnik', 'Krasniqi', 'MALE', '1988-07-19'],
  ['Lirije', 'Morina', 'FEMALE', '1964-03-27'],
  ['Fatos', 'Bytyqi', 'MALE', '2001-12-01'],
  ['Teuta', 'Zeqiri', 'FEMALE', '1982-05-16'],
  ['Gëzim', 'Haliti', 'MALE', '1975-10-10'],
  ['Arta', 'Sopi', 'FEMALE', '1996-08-23'],
] as const;

type Obs = { at: string; byId: string; note: string | null; vitalsChecked: boolean };
const obsEvery = (start: number, end: number, byId: string, notes: string[]): Obs[] => {
  const out: Obs[] = [];
  for (let t = start + 15 * MIN, i = 0; t <= end; t += 15 * MIN, i++) {
    out.push({
      at: new Date(t).toISOString(),
      byId,
      note: notes[i % notes.length]!,
      vitalsChecked: i % 2 === 0,
    });
  }
  return out;
};

/**
 * Synthetic demo data for mental health safeguards (development only), on a psychiatric ward of the
 * demo facility:
 *  - an involuntary admission two days old with the court not yet notified (overdue);
 *  - one confirmed by the court whose authorisation ends in five days (review due soon);
 *  - one six hours old with the legal steps still open, and a seclusion running for 25 minutes
 *    whose last observation was 18 minutes ago (observation overdue);
 *  - a restraint that ended yesterday without a debrief yet;
 *  - a year of ended involuntary admissions and restrictive interventions for the statistics.
 * Clinical texts are short and respectful; the people are invented.
 */
export async function seedMentalhealth(opts: { facilityId: string; demoDoctorId: string }) {
  const { facilityId, demoDoctorId } = opts;
  const [existing] = await db
    .select({ id: careUnits.id })
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.code, 'PSY')));
  if (existing) return;
  const [unit] = await db
    .insert(careUnits)
    .values({ facilityId, name: 'Psikiatria', code: 'PSY', type: 'PSYCHIATRIC' })
    .returning({ id: careUnits.id });
  const unitId = unit!.id;
  const bedRows = await db
    .insert(beds)
    .values(Array.from({ length: 10 }, (_, i) => ({ unitId, label: `PS${i + 1}` })))
    .returning({ id: beds.id });

  const [nurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  // The independent second examination needs another doctor of the facility.
  const [second] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.facilityId, facilityId),
        eq(users.role, 'DOCTOR'),
        eq(users.isActive, true),
        ne(users.id, demoDoctorId),
      ),
    )
    .limit(1);
  const nurseId = nurse?.id ?? demoDoctorId;
  const secondId = second?.id ?? null;
  for (const id of [demoDoctorId, nurse?.id, secondId]) {
    if (id) await db.insert(unitStaff).values({ unitId, userId: id }).onConflictDoNothing();
  }

  const now = Date.now();
  const person = async (
    [firstName, lastName, sex, dateOfBirth]: readonly [string, string, string, string],
    n: number,
  ) => {
    const [p] = await db
      .insert(patients)
      .values({
        nationalId: await freeNationalId(1295100001 + n * 7),
        firstName,
        lastName,
        dateOfBirth,
        sex: sex as 'MALE' | 'FEMALE',
        primaryFacilityId: facilityId,
        municipality: n % 3 === 0 ? 'Prishtinë' : 'Podujevë',
      })
      .returning({ id: patients.id });
    return p!.id;
  };
  const admit = async (
    patientId: string,
    admittedAt: number,
    bed?: number,
    dischargedAt?: number,
  ) => {
    const [a] = await db
      .insert(admissions)
      .values({
        patientId,
        facilityId,
        unitId,
        bedId: bed === undefined ? null : bedRows[bed]!.id,
        admittingDoctorId: demoDoctorId,
        attendingDoctorId: demoDoctorId,
        source: 'EMERGENCY',
        reason: 'Krizë psikotike akute',
        admittedAt: new Date(admittedAt),
        ...(dischargedAt
          ? {
              status: 'DISCHARGED' as const,
              dischargedAt: new Date(dischargedAt),
              dischargedById: demoDoctorId,
              disposition: 'HOME' as const,
            }
          : {}),
      })
      .returning({ id: admissions.id });
    if (bed !== undefined && !dischargedAt) {
      await db.update(beds).set({ status: 'OCCUPIED' }).where(eq(beds.id, bedRows[bed]!.id));
    }
    return a!.id;
  };
  const at = (ms: number) => new Date(ms);

  /* ---- current patients ---- */
  const [p1, p2, p3, p4] = [
    await person(CURRENT[0], 0),
    await person(CURRENT[1], 1),
    await person(CURRENT[2], 2),
    await person(CURRENT[3], 3),
  ];

  // 1. Two days in, the court has not been notified (overdue at 48 hours).
  const s1 = now - 52 * HOUR;
  const a1 = await admit(p1, s1 - 2 * HOUR, 0);
  await db.insert(involuntaryAdmissions).values({
    patientId: p1,
    admissionId: a1,
    facilityId,
    grounds: ['DANGER_TO_SELF'],
    assessment:
      'Ide vetëvrasëse me plan konkret pas humbjes së punës; refuzon trajtimin vullnetar. ' +
      'Nuk ka gjykim për nevojën e trajtimit.',
    startedAt: at(s1),
    decidedById: demoDoctorId,
    ...(secondId
      ? {
          secondOpinionById: secondId,
          secondOpinionAt: at(s1 + 20 * HOUR),
          secondOpinionConfirms: true,
        }
      : {}),
    rightsExplainedAt: at(s1 + 3 * HOUR),
    representativeName: 'Bashkëshortja',
    representativeNotifiedAt: at(s1 + 6 * HOUR),
  });

  // 2. Confirmed by the court; the authorisation ends in five days.
  const s2 = now - 10 * DAY;
  const a2 = await admit(p2, s2 - HOUR, 1);
  await db.insert(involuntaryAdmissions).values({
    patientId: p2,
    admissionId: a2,
    facilityId,
    grounds: ['DANGER_TO_OTHERS', 'SEVERE_SELF_NEGLECT'],
    assessment:
      'Gjendje maniakale me agresivitet ndaj familjes; nuk ushqehet dhe nuk fle prej disa ditësh.',
    startedAt: at(s2),
    decidedById: demoDoctorId,
    ...(secondId
      ? {
          secondOpinionById: secondId,
          secondOpinionAt: at(s2 + 14 * HOUR),
          secondOpinionConfirms: true,
        }
      : {}),
    rightsExplainedAt: at(s2 + 2 * HOUR),
    representativeName: 'Djali',
    representativeNotifiedAt: at(s2 + 4 * HOUR),
    courtNotifiedAt: at(s2 + 30 * HOUR),
    courtReference: 'GJTH-PR 214/26',
    courtDecisionAt: at(s2 + 70 * HOUR),
    courtDecision: 'CONFIRMED',
    authorisedUntil: at(now + 5 * DAY),
  });

  // 3. Six hours in: legal steps open, seclusion running with an observation overdue.
  const s3 = now - 6 * HOUR;
  const a3 = await admit(p3, s3 - HOUR, 2);
  await db.insert(involuntaryAdmissions).values({
    patientId: p3,
    admissionId: a3,
    facilityId,
    grounds: ['DANGER_TO_OTHERS'],
    assessment:
      'Ide persekutore dhe kërcënime ndaj fqinjëve; sjellë nga policia. Pa pasqyrë për sëmundjen.',
    startedAt: at(s3),
    decidedById: demoDoctorId,
  });
  const r3 = now - 25 * MIN;
  await db.insert(restrictiveInterventions).values({
    patientId: p3,
    admissionId: a3,
    facilityId,
    kind: 'SECLUSION',
    reason: 'Goditi një infermier pas dështimit të qetësimit verbal; rrezik i menjëhershëm.',
    startedAt: at(r3),
    orderedById: demoDoctorId,
    observations: [
      {
        at: at(r3 + 7 * MIN).toISOString(),
        byId: nurseId,
        note: 'Ecën nëpër dhomë, flet me zë',
        vitalsChecked: false,
      },
    ],
  });

  // 4. Voluntary patient: a restraint ended yesterday, debrief still to hold.
  const a4 = await admit(p4, now - 4 * DAY, 3);
  const r4 = now - 30 * HOUR;
  await db.insert(restrictiveInterventions).values({
    patientId: p4,
    admissionId: a4,
    facilityId,
    kind: 'PHYSICAL_RESTRAINT',
    reason: 'Tentoi të godiste kokën në mur; mbajtje e shkurtër derisa u qetësua.',
    startedAt: at(r4),
    endedAt: at(r4 + 12 * MIN),
    orderedById: nurseId,
    observations: [
      {
        at: at(r4 + 5 * MIN).toISOString(),
        byId: nurseId,
        note: 'Merr frymë lirshëm',
        vitalsChecked: true,
      },
      {
        at: at(r4 + 11 * MIN).toISOString(),
        byId: nurseId,
        note: 'Më i qetë, u lirua',
        vitalsChecked: true,
      },
    ],
    injuries: null,
  });

  /* ---- a year of history (ended) for the statistics ---- */
  const KINDS = [
    'PHYSICAL_RESTRAINT',
    'SECLUSION',
    'MECHANICAL_RESTRAINT',
    'RAPID_TRANQUILLISATION',
  ];
  for (const [i, who] of PAST.entries()) {
    const patientId = await person(who, 10 + i);
    const admittedAt = now - (330 - i * 38) * DAY;
    const stay = (9 + (i % 4) * 5) * DAY;
    const admissionId = await admit(patientId, admittedAt, undefined, admittedAt + stay);
    if (i % 4 !== 3) {
      const started = admittedAt + 2 * HOUR;
      // One in eight: the court was notified after the 48 hours.
      const courtAfter = (i === 5 ? 60 : 20 + i * 2) * HOUR;
      await db.insert(involuntaryAdmissions).values({
        patientId,
        admissionId,
        facilityId,
        grounds: [i % 2 ? 'DANGER_TO_OTHERS' : 'DANGER_TO_SELF'],
        assessment: 'Pranim i pavullnetshëm i mbyllur (të dhëna demonstruese).',
        startedAt: at(started),
        decidedById: demoDoctorId,
        ...(secondId
          ? {
              secondOpinionById: secondId,
              secondOpinionAt: at(started + 12 * HOUR),
              secondOpinionConfirms: true,
            }
          : {}),
        rightsExplainedAt: at(started + 2 * HOUR),
        representativeName: 'Familja',
        representativeNotifiedAt: at(started + 5 * HOUR),
        courtNotifiedAt: at(started + courtAfter),
        courtReference: `GJTH-PR ${100 + i}/26`,
        courtDecisionAt: at(started + courtAfter + 48 * HOUR),
        courtDecision: 'CONFIRMED',
        authorisedUntil: at(admittedAt + stay + 10 * DAY),
        status: 'ENDED',
        endedAt: at(admittedAt + stay),
        endReason: i % 3 === 0 ? 'BECAME_VOLUNTARY' : 'DISCHARGED',
      });
    }
    for (let k = 0; k < 1 + (i % 3); k++) {
      const kind = KINDS[(i + k) % KINDS.length]!;
      const started = admittedAt + (1 + k) * DAY + 3 * HOUR;
      const minutes = kind === 'RAPID_TRANQUILLISATION' ? 1 : 15 + ((i * 7 + k * 11) % 50);
      const ended = started + minutes * MIN;
      await db.insert(restrictiveInterventions).values({
        patientId,
        admissionId,
        facilityId,
        kind,
        reason: 'Rrezik i menjëhershëm pas dështimit të qetësimit verbal (të dhëna demonstruese).',
        startedAt: at(started),
        endedAt: at(ended),
        orderedById: k % 2 ? nurseId : demoDoctorId,
        observations:
          kind === 'RAPID_TRANQUILLISATION'
            ? []
            : obsEvery(started, ended, nurseId, ['I qetë', 'Pi ujë', 'Flet me stafin']),
        debriefAt: at(ended + (20 + k * 10) * HOUR),
        debriefNote: 'Biseda pas ndërhyrjes u mbajt me pacientin dhe stafin.',
      });
    }
  }
}
