import { and, eq, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  careAssignments,
  careUnits,
  homeCareEpisodes,
  homeVisits,
  patients,
  unitStaff,
  users,
  vitalSigns,
} from './schema.js';
import { serialiseCarePlan, type HomeCareTask } from '../modules/homecare/homecare.service.js';

/**
 * Synthetic demo data for home care (development only): a community nursing team at the demo
 * facility with nurse@pacient.local and two community nurses (no sign-in), eight home care
 * episodes with a week of visits – done, missed, one checked in three hours ago and never checked
 * out (flagged on the board), today's and future visits – and a short completed episode for the
 * demo patient so her portal shows it.
 */
const PEOPLE: {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: 'FEMALE' | 'MALE';
  address: string;
  access: string | null;
  reason: string;
  goals: string;
  tasks: HomeCareTask[];
}[] = [
  {
    firstName: 'Hajrije',
    lastName: 'Gashi',
    dateOfBirth: '1941-05-03',
    sex: 'FEMALE',
    address: 'Rr. Agim Ramadani 14, Prishtinë',
    access: 'Kati 3, pa ashensor; vajza ka çelësin',
    reason: 'Ulçerë venoze e këmbës së majtë',
    goals: 'Mbyllja e plagës brenda 8 javësh; kompresion i përshtatshëm',
    tasks: ['WOUND_CARE', 'ASSESSMENT'],
  },
  {
    firstName: 'Bajram',
    lastName: 'Krasniqi',
    dateOfBirth: '1946-11-20',
    sex: 'MALE',
    address: 'Lagjja Kalabria, Hyrja C, Nr. 7, Prishtinë',
    access: null,
    reason: 'Diabet tip 2 me insulinë, nuk e administron vetë',
    goals: 'Glukoza 6–10 mmol/L; edukimi i bashkëshortes për injeksionet',
    tasks: ['INJECTION', 'MEDICATION', 'OBSERVATIONS'],
  },
  {
    firstName: 'Fatime',
    lastName: 'Berisha',
    dateOfBirth: '1938-02-11',
    sex: 'FEMALE',
    address: 'Fshati Llukar, rruga kryesore, Prishtinë',
    access: 'Shtëpia e verdhë pas xhamisë; qeni në oborr është i lidhur',
    reason: 'Kujdes paliativ – kancer i avancuar',
    goals: 'Kontroll i dhimbjes dhe komoditet në shtëpi; mbështetje për familjen',
    tasks: ['PALLIATIVE', 'MEDICATION', 'ASSESSMENT'],
  },
  {
    firstName: 'Ramadan',
    lastName: 'Hoti',
    dateOfBirth: '1952-07-30',
    sex: 'MALE',
    address: 'Rr. Bill Clinton 45, Prishtinë',
    access: null,
    reason: 'Pas daljes nga spitali – pneumoni',
    goals: 'Monitorimi i shenjave vitale për 2 javë pas daljes',
    tasks: ['OBSERVATIONS', 'MEDICATION'],
  },
  {
    firstName: 'Nazmije',
    lastName: 'Rexhepi',
    dateOfBirth: '1949-09-09',
    sex: 'FEMALE',
    address: 'Rr. Ulpiana D-4, Prishtinë',
    access: 'Interfoni nuk punon – telefononi para ardhjes',
    reason: 'Kateter urinar i përhershëm',
    goals: 'Ndërrimi i kateterit çdo 4 javë, parandalimi i infeksionit',
    tasks: ['CATHETER', 'ASSESSMENT'],
  },
  {
    firstName: 'Ismet',
    lastName: 'Bytyqi',
    dateOfBirth: '1957-01-18',
    sex: 'MALE',
    address: 'Rr. Muharrem Fejza 3, Prishtinë',
    access: null,
    reason: 'Plagë pas operacionit të barkut',
    goals: 'Shërimi i plagës kirurgjikale; heqja e qepjeve në ditën e 12-të',
    tasks: ['WOUND_CARE'],
  },
  {
    firstName: 'Mihrije',
    lastName: 'Kelmendi',
    dateOfBirth: '1944-04-25',
    sex: 'FEMALE',
    address: 'Rr. Fehmi Agani 21, Prishtinë',
    access: null,
    reason: 'Injeksione antikoagulante pas frakturës së ijës',
    goals: 'Injeksioni i përditshëm për 4 javë; mobilizim i sigurt',
    tasks: ['INJECTION', 'ASSESSMENT'],
  },
  {
    firstName: 'Skender',
    lastName: 'Morina',
    dateOfBirth: '1950-12-02',
    sex: 'MALE',
    address: 'Lagjja Dardania, SU-5, Nr. 12, Prishtinë',
    access: null,
    reason: 'Referim i ri – vlerësim pas rënies në shtëpi',
    goals: '',
    tasks: ['ASSESSMENT'],
  },
];

async function freeNationalId(start: number) {
  for (let n = start; ; n++) {
    const [taken] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(sql`${patients.nationalId} = ${String(n)}`);
    if (!taken) return String(n);
  }
}

export async function seedHomecare(opts: { facilityId: string; demoDoctorId: string }) {
  const { facilityId, demoDoctorId } = opts;
  const [existing] = await db
    .select({ id: careUnits.id })
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.code, 'KSH')));
  const team =
    existing ??
    (
      await db
        .insert(careUnits)
        .values({
          facilityId,
          name: 'Kujdesi në shtëpi – Prishtinë',
          code: 'KSH',
          type: 'COMMUNITY_NURSING',
        })
        .returning({ id: careUnits.id })
    )[0]!;

  const [demoNurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  const nurses: string[] = demoNurse ? [demoNurse.id] : [];
  for (const [email, fullName] of [
    ['infermierja.shtepi1@pacient.local', 'Valbona Hasani'],
    ['infermieri.shtepi2@pacient.local', 'Arben Zeqiri'],
  ] as const) {
    const [u] = await db
      .insert(users)
      .values({
        email,
        fullName,
        role: 'NURSE',
        facilityId,
        specialty: 'Infermiere e komunitetit',
        // No password: synthetic team members who cannot sign in.
      })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (u) nurses.push(u.id);
  }
  for (const userId of nurses) {
    await db.insert(unitStaff).values({ unitId: team.id, userId }).onConflictDoNothing();
  }
  const [nurseA, nurseB, nurseC] = [nurses[0]!, nurses[1] ?? nurses[0]!, nurses[2] ?? nurses[0]!];

  const DAY = 86_400_000;
  const now = Date.now();
  // Kosovo morning: today 08:00 UTC is 09:00 or 10:00 local.
  const today = new Date();
  today.setUTCHours(7, 30, 0, 0);
  const at = (dayOffset: number, hour: number) =>
    new Date(today.getTime() + dayOffset * DAY + (hour - 8) * 3_600_000);

  for (const [i, person] of PEOPLE.entries()) {
    const [p] = await db
      .insert(patients)
      .values({
        nationalId: await freeNationalId(1288100001 + i * 3),
        firstName: person.firstName,
        lastName: person.lastName,
        dateOfBirth: person.dateOfBirth,
        sex: person.sex,
        primaryFacilityId: facilityId,
        municipality: 'Prishtinë',
        address: person.address,
        phone: `+38344${String(310000 + i * 137).padStart(6, '0')}`,
      })
      .returning({ id: patients.id });
    await db
      .insert(careAssignments)
      .values({ patientId: p!.id, doctorId: demoDoctorId, assignedById: demoDoctorId });

    const isNew = i === PEOPLE.length - 1;
    const startedAt = new Date(now - (10 + i * 4) * DAY);
    const [episode] = await db
      .insert(homeCareEpisodes)
      .values({
        patientId: p!.id,
        teamUnitId: team.id,
        referredById: demoDoctorId,
        reason: person.reason,
        carePlan: serialiseCarePlan({ goals: person.goals, tasks: person.tasks }),
        visitAddress: person.address,
        accessNotes: person.access,
        status: isNew ? 'REFERRED' : 'ACTIVE',
        startedAt: isNew ? null : startedAt,
        createdAt: isNew ? new Date(now - 2 * 3_600_000) : new Date(startedAt.getTime() - DAY),
      })
      .returning();
    if (isNew) continue;

    const assignee = [nurseA, nurseB, nurseC][i % 3]!;
    const hour = 8 + (i % 4) * 2;
    // Past week: done visits (one missed for the palliative patient).
    for (let d = -6; d <= -1; d += 2) {
      const scheduledFor = at(d, hour);
      const missed = i === 2 && d === -2;
      const [v] = await db
        .insert(homeVisits)
        .values({
          episodeId: episode!.id,
          patientId: p!.id,
          scheduledFor,
          assignedToId: assignee,
          tasks: person.tasks,
          status: missed ? 'MISSED' : 'DONE',
          visitedAt: missed ? null : new Date(scheduledFor.getTime() + 10 * 60_000),
          notes: missed
            ? null
            : person.tasks.includes('WOUND_CARE')
              ? 'Plaga u pastrua dhe u fashua; pa shenja infeksioni.'
              : 'Vizitë e rregullt; pacienti stabil, terapia u dha sipas planit.',
          missedReason: missed ? 'Familja nuk ishte në shtëpi; u telefonua, vizita u shty.' : null,
          recordedById: assignee,
          createdAt: new Date(scheduledFor.getTime() - 5 * DAY),
        })
        .returning();
      if (!missed && person.tasks.includes('OBSERVATIONS')) {
        await db.insert(vitalSigns).values({
          patientId: p!.id,
          recordedById: assignee,
          systolic: 128 + (d % 3),
          diastolic: 78,
          heartRate: 82,
          respiratoryRate: 16,
          oxygenSaturation: 96,
          temperatureC: '36.8',
          consciousness: 'A',
          onSupplementalOxygen: false,
          recordedAt: v!.visitedAt!,
        });
      }
    }
    // Today: one visit started three hours ago and never checked out (lone-working flag).
    await db.insert(homeVisits).values({
      episodeId: episode!.id,
      patientId: p!.id,
      scheduledFor: i === 0 ? new Date(now - 3.2 * 3_600_000) : at(0, hour),
      assignedToId: i === 0 ? nurseA : assignee,
      tasks: person.tasks,
      visitedAt: i === 0 ? new Date(now - 3 * 3_600_000) : null,
    });
    // The next week.
    for (let d = 1; d <= 7; d += i % 2 === 0 ? 2 : 3) {
      await db.insert(homeVisits).values({
        episodeId: episode!.id,
        patientId: p!.id,
        scheduledFor: at(d, hour),
        assignedToId: assignee,
        tasks: person.tasks,
      });
    }
  }

  // The demo patient: a short episode after a minor operation, completed three weeks ago.
  const [demo] = await db
    .select({ patientId: patients.id, address: patients.address })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(eq(users.email, 'patient@pacient.local'));
  if (demo) {
    const start = new Date(now - 32 * DAY);
    const [episode] = await db
      .insert(homeCareEpisodes)
      .values({
        patientId: demo.patientId,
        teamUnitId: team.id,
        referredById: demoDoctorId,
        reason: 'Kujdes i plagës pas heqjes së një lipome',
        carePlan: serialiseCarePlan({
          goals: 'Shërimi i plagës dhe heqja e qepjeve',
          tasks: ['WOUND_CARE'],
        }),
        visitAddress: demo.address ?? 'Prishtinë',
        status: 'DISCHARGED',
        startedAt: start,
        endedAt: new Date(now - 21 * DAY),
        endReason: 'Plaga u shërua, qepjet u hoqën',
        createdAt: new Date(start.getTime() - DAY),
      })
      .returning();
    for (const d of [0, 4, 8, 11]) {
      const when = new Date(start.getTime() + d * DAY + 2 * 3_600_000);
      await db.insert(homeVisits).values({
        episodeId: episode!.id,
        patientId: demo.patientId,
        scheduledFor: when,
        assignedToId: nurseA,
        tasks: ['WOUND_CARE'],
        status: 'DONE',
        visitedAt: when,
        notes:
          d === 11 ? 'Qepjet u hoqën; plaga e mbyllur.' : 'Plaga u fashua; pa shenja infeksioni.',
        recordedById: nurseA,
        createdAt: start,
      });
    }
  }
}
