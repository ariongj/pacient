import { and, eq, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  careAssignments,
  patients,
  users,
  waitingListEntries,
  waitingListEvents,
} from './schema.js';
import { targetDateFor, type Priority } from '../modules/waiting/waiting.service.js';

/**
 * Synthetic elective waiting lists at the demo facility (development only): four specialties,
 * waits of different lengths (some past the maximum), postponed, scheduled and completed
 * entries, and one entry for the demo patient so the portal shows it.
 */

const DAY = 86_400_000;

const PEOPLE: [string, string, string, 'MALE' | 'FEMALE'][] = [
  ['Agim', 'Rexhepi', '1958-03-14', 'MALE'],
  ['Shqipe', 'Morina', '1962-07-02', 'FEMALE'],
  ['Bekim', 'Hasani', '1971-11-20', 'MALE'],
  ['Fitore', 'Kelmendi', '1949-01-09', 'FEMALE'],
  ['Naim', 'Sadiku', '1966-05-30', 'MALE'],
  ['Valbona', 'Thaçi', '1955-09-17', 'FEMALE'],
  ['Ilir', 'Bajrami', '1980-02-25', 'MALE'],
  ['Mimoza', 'Shala', '1952-12-03', 'FEMALE'],
  ['Driton', 'Gashi', '1975-04-11', 'MALE'],
  ['Hana', 'Berisha', '1969-08-08', 'FEMALE'],
  ['Luan', 'Krasniqi', '1960-06-19', 'MALE'],
  ['Teuta', 'Hoxha', '1947-10-27', 'FEMALE'],
  ['Arben', 'Zeqiri', '1983-03-05', 'MALE'],
  ['Merita', 'Ahmeti', '1957-01-31', 'FEMALE'],
];

type Spec = {
  specialty: string;
  kind: 'PROCEDURE' | 'OUTPATIENT';
  procedureCode: string | null;
  procedureName: string;
};
const ORTHO: Spec[] = [
  {
    specialty: 'ORTHOPAEDICS',
    kind: 'PROCEDURE',
    procedureCode: 'NGB',
    procedureName: 'Total knee replacement',
  },
  {
    specialty: 'ORTHOPAEDICS',
    kind: 'PROCEDURE',
    procedureCode: 'NFB',
    procedureName: 'Total hip replacement',
  },
];
const EYE: Spec = {
  specialty: 'OPHTHALMOLOGY',
  kind: 'PROCEDURE',
  procedureCode: 'CJE',
  procedureName: 'Cataract surgery with lens implant',
};
const SURG: Spec[] = [
  {
    specialty: 'GENERAL_SURGERY',
    kind: 'PROCEDURE',
    procedureCode: 'JKA',
    procedureName: 'Laparoscopic cholecystectomy',
  },
  {
    specialty: 'GENERAL_SURGERY',
    kind: 'PROCEDURE',
    procedureCode: 'JAB',
    procedureName: 'Inguinal hernia repair',
  },
];
const CARDIO: Spec = {
  specialty: 'CARDIOLOGY',
  kind: 'OUTPATIENT',
  procedureCode: null,
  procedureName: 'First cardiology consultation',
};

/** [person index, spec, priority, days ago added, status, extra] */
type Row = [
  number,
  Spec,
  Priority,
  number,
  'WAITING' | 'SCHEDULED' | 'SUSPENDED' | 'COMPLETED',
  {
    suspendedDays?: number;
    openSuspensionDays?: number;
    scheduledInDays?: number;
    waitedDays?: number;
  },
];
const ROWS: Row[] = [
  [0, ORTHO[0]!, 'ROUTINE', 210, 'WAITING', {}],
  [1, ORTHO[1]!, 'ROUTINE', 160, 'WAITING', {}],
  [2, ORTHO[0]!, 'PRIORITY', 95, 'WAITING', {}],
  [3, ORTHO[1]!, 'URGENT', 12, 'SCHEDULED', { scheduledInDays: 9 }],
  [4, ORTHO[0]!, 'ROUTINE', 120, 'SUSPENDED', { openSuspensionDays: 25 }],
  [5, ORTHO[1]!, 'ROUTINE', 60, 'WAITING', {}],
  [6, ORTHO[0]!, 'ROUTINE', 300, 'COMPLETED', { waitedDays: 170 }],
  [7, ORTHO[1]!, 'PRIORITY', 200, 'COMPLETED', { waitedDays: 84 }],
  [8, EYE, 'ROUTINE', 190, 'WAITING', { suspendedDays: 14 }],
  [9, EYE, 'ROUTINE', 140, 'SCHEDULED', { scheduledInDays: 20 }],
  [10, EYE, 'PRIORITY', 70, 'WAITING', {}],
  [11, EYE, 'ROUTINE', 30, 'WAITING', {}],
  [12, EYE, 'ROUTINE', 250, 'COMPLETED', { waitedDays: 150 }],
  [13, EYE, 'ROUTINE', 220, 'COMPLETED', { waitedDays: 120 }],
  [0, EYE, 'ROUTINE', 260, 'COMPLETED', { waitedDays: 175 }],
  [1, EYE, 'ROUTINE', 200, 'COMPLETED', { waitedDays: 95 }],
  [2, EYE, 'PRIORITY', 150, 'COMPLETED', { waitedDays: 60 }],
  [3, SURG[0]!, 'PRIORITY', 100, 'WAITING', {}],
  [5, SURG[1]!, 'ROUTINE', 45, 'WAITING', {}],
  [7, SURG[0]!, 'URGENT', 26, 'WAITING', {}],
  [9, SURG[1]!, 'ROUTINE', 85, 'SUSPENDED', { openSuspensionDays: 10 }],
  [11, SURG[0]!, 'PRIORITY', 40, 'SCHEDULED', { scheduledInDays: 5 }],
  [4, CARDIO, 'PRIORITY', 50, 'WAITING', {}],
  [6, CARDIO, 'URGENT', 8, 'WAITING', {}],
  [8, CARDIO, 'ROUTINE', 130, 'WAITING', {}],
  [10, CARDIO, 'ROUTINE', 20, 'SCHEDULED', { scheduledInDays: 12 }],
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

export async function seedWaiting(opts: { facilityId: string; demoDoctorId: string }) {
  const { facilityId, demoDoctorId } = opts;
  const people: string[] = [];
  for (const [i, [firstName, lastName, dateOfBirth, sex]] of PEOPLE.entries()) {
    const [p] = await db
      .insert(patients)
      .values({
        nationalId: await freeNationalId(1277100001 + i * 3),
        firstName,
        lastName,
        dateOfBirth,
        sex,
        primaryFacilityId: facilityId,
        municipality: 'Prishtinë',
      })
      .returning({ id: patients.id });
    people.push(p!.id);
    // The demo doctor manages these patients (so their charts open from the list).
    await db
      .insert(careAssignments)
      .values({ patientId: p!.id, doctorId: demoDoctorId, assignedById: demoDoctorId });
  }

  const now = Date.now();
  const insert = async (patientId: string, [, spec, priority, daysAgo, status, extra]: Row) => {
    const addedAt = new Date(now - daysAgo * DAY);
    const suspendedDays = extra.suspendedDays ?? 0;
    const [entry] = await db
      .insert(waitingListEntries)
      .values({
        patientId,
        facilityId,
        ...spec,
        priority,
        clinicalReason: 'Synthetic demo entry',
        addedById: demoDoctorId,
        addedAt,
        createdAt: addedAt,
        targetDate: targetDateFor(addedAt, priority, suspendedDays),
        status,
        suspendedDays,
        suspendedSince:
          status === 'SUSPENDED' ? new Date(now - (extra.openSuspensionDays ?? 7) * DAY) : null,
        scheduledFor:
          status === 'SCHEDULED' ? new Date(now + (extra.scheduledInDays ?? 7) * DAY) : null,
        completedAt:
          status === 'COMPLETED'
            ? new Date(addedAt.getTime() + (extra.waitedDays ?? 90) * DAY)
            : null,
      })
      .returning();
    const e = entry!;
    const history: { event: string; at: Date; reason?: string }[] = [
      { event: 'ADDED', at: addedAt },
    ];
    if (suspendedDays) {
      history.push({
        event: 'SUSPENDED',
        at: new Date(addedAt.getTime() + 20 * DAY),
        reason: 'Patient asked to postpone (family reasons)',
      });
      history.push({
        event: 'RESUMED',
        at: new Date(addedAt.getTime() + (20 + suspendedDays) * DAY),
      });
    }
    if (status === 'SUSPENDED') {
      history.push({
        event: 'SUSPENDED',
        at: e.suspendedSince!,
        reason: 'Patient abroad for work',
      });
    }
    if (status === 'SCHEDULED') history.push({ event: 'SCHEDULED', at: new Date(now - 2 * DAY) });
    if (status === 'COMPLETED') history.push({ event: 'COMPLETED', at: e.completedAt! });
    await db.insert(waitingListEvents).values(
      history.map((h) => ({
        entryId: e.id,
        patientId,
        actorId: demoDoctorId,
        event: h.event,
        reason: h.reason ?? null,
        details: h.event === 'ADDED' ? { priority, targetDate: e.targetDate } : null,
        createdAt: h.at,
      })),
    );
  };

  for (const row of ROWS) await insert(people[row[0]]!, row);

  // The demo patient waits for a first cardiology consultation.
  const [demo] = await db
    .select({ id: patients.id })
    .from(patients)
    .innerJoin(users, eq(users.id, patients.userId))
    .where(
      and(eq(users.email, 'patient@pacient.local'), eq(patients.primaryFacilityId, facilityId)),
    );
  if (demo) {
    await insert(demo.id, [0, CARDIO, 'ROUTINE', 35, 'WAITING', {}]);
  }
}
