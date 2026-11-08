import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from './client.js';
import {
  beds,
  careUnits,
  dialysisSchedules,
  dialysisSessions,
  patients,
  unitStaff,
  users,
} from './schema.js';
import {
  addDays,
  kosovoDate,
  planSessions,
  weekdayOf,
  type Day,
} from '../modules/dialysis/dialysis.service.js';

/**
 * Synthetic demo data for dialysis (development only): the haemodialysis unit “Dializa – QKUK”
 * with 12 stations, nurse@ and doctor@pacient.local as its staff, 24 patients on Mon/Wed/Fri or
 * Tue/Thu/Sat in the morning or afternoon shift with six weeks of sessions (a few missed, some with
 * complications, monthly urea for URR and Kt/V, two patients below target and one with large
 * weight gains), today's sessions partly running, one schedule ended after a transplant, and the
 * next 14 days planned.
 */
const STATIONS = 12;
const HISTORY_DAYS = 42;
const MWF: Day[] = ['MON', 'WED', 'FRI'];
const TTS: Day[] = ['TUE', 'THU', 'SAT'];

const NAMES: [string, string, 'FEMALE' | 'MALE', string][] = [
  ['Agim', 'Shala', 'MALE', '1958-03-14'],
  ['Shqipe', 'Hoxha', 'FEMALE', '1962-07-02'],
  ['Besim', 'Gashi', 'MALE', '1949-11-21'],
  ['Mimoza', 'Krasniqi', 'FEMALE', '1971-01-09'],
  ['Naim', 'Berisha', 'MALE', '1955-05-30'],
  ['Lindita', 'Morina', 'FEMALE', '1967-09-17'],
  ['Hysen', 'Bytyqi', 'MALE', '1946-02-03'],
  ['Valdete', 'Rexhepi', 'FEMALE', '1975-12-12'],
  ['Xhevdet', 'Kelmendi', 'MALE', '1960-04-25'],
  ['Arta', 'Thaçi', 'FEMALE', '1983-06-08'],
  ['Remzi', 'Zeqiri', 'MALE', '1952-10-19'],
  ['Hava', 'Avdiu', 'FEMALE', '1948-08-28'],
  ['Petrit', 'Hasani', 'MALE', '1969-03-03'],
  ['Drita', 'Mustafa', 'FEMALE', '1957-01-27'],
  ['Selim', 'Islami', 'MALE', '1964-05-15'],
  ['Florije', 'Osmani', 'FEMALE', '1979-11-04'],
  ['Ilir', 'Halili', 'MALE', '1988-02-22'],
  ['Zyrafete', 'Sylejmani', 'FEMALE', '1951-07-11'],
  ['Milan', 'Petrović', 'MALE', '1959-09-29'],
  ['Jelena', 'Nikolić', 'FEMALE', '1966-12-01'],
  ['Fadil', 'Rama', 'MALE', '1944-04-07'],
  ['Teuta', 'Ahmeti', 'FEMALE', '1973-10-23'],
  ['Bekim', 'Jashari', 'MALE', '1961-06-16'],
  ['Kimete', 'Bajrami', 'FEMALE', '1954-03-30'],
];

/** Deterministic pseudo-random numbers so the demo looks the same on every seed. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function freeNationalId(start: number) {
  for (let n = start; ; n++) {
    const [taken] = await db
      .select({ id: patients.id })
      .from(patients)
      .where(sql`${patients.nationalId} = ${String(n)}`);
    if (!taken) return String(n);
  }
}

/** A Kosovo local clock time on a date (CET/CEST is close enough for demo data). */
const localTime = (date: string, hour: number, minute = 0) =>
  new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+01:00`);

export async function seedDialysis(opts: { facilityId: string; demoDoctorId: string }) {
  const { facilityId, demoDoctorId } = opts;
  const [existing] = await db
    .select({ id: careUnits.id })
    .from(careUnits)
    .where(and(eq(careUnits.facilityId, facilityId), eq(careUnits.code, 'DIAL')));
  if (existing) return;
  const [unit] = await db
    .insert(careUnits)
    .values({ facilityId, name: 'Dializa – QKUK', code: 'DIAL', type: 'DIALYSIS' })
    .returning({ id: careUnits.id });
  const unitId = unit!.id;
  await db
    .insert(beds)
    .values(Array.from({ length: STATIONS }, (_, i) => ({ unitId, label: `Vendi ${i + 1}` })));

  const staff = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(inArray(users.email, ['nurse@pacient.local', 'doctor@pacient.local']));
  for (const s of staff) {
    await db.insert(unitStaff).values({ unitId, userId: s.id }).onConflictDoNothing();
  }
  const nurseId = staff.find((s) => s.email === 'nurse@pacient.local')?.id ?? null;
  const doctorId = staff.find((s) => s.email === 'doctor@pacient.local')?.id ?? demoDoctorId;

  const today = kosovoDate(new Date());
  const rand = random(20260301);
  const between = (lo: number, hi: number) => lo + rand() * (hi - lo);
  const round1 = (x: number) => Math.round(x * 10) / 10;

  // 25 people: 24 on dialysis and one whose schedule ended with a transplant two weeks ago.
  const people = [...NAMES, ['Arbër', 'Dushi', 'MALE', '1985-08-19'] as const];
  for (const [i, [firstName, lastName, sex, dateOfBirth]] of people.entries()) {
    const transplanted = i === NAMES.length;
    const days = i % 2 === 0 ? MWF : TTS;
    const shift = transplanted ? 'MORNING' : Math.floor(i / 2) % 2 === 0 ? 'MORNING' : 'AFTERNOON';
    // Station within the shift group (MWF/TTS × morning/afternoon has six patients each).
    const station = (Math.floor(i / 4) % STATIONS) + 1;
    const target = round1(between(54, 92));
    const poorAdequacy = i === 5 || i === 14;
    const bigGains = i === 3;
    const longTerm = i % 3 !== 0;
    const startedOn = addDays(today, longTerm ? -400 - i * 11 : -HISTORY_DAYS - 3);
    const endedOn = transplanted ? addDays(today, -14) : null;

    const [p] = await db
      .insert(patients)
      .values({
        nationalId: await freeNationalId(1291500001 + i * 3),
        firstName,
        lastName,
        dateOfBirth,
        sex,
        primaryFacilityId: facilityId,
        municipality: i % 4 === 0 ? 'Fushë Kosovë' : 'Prishtinë',
        phone: `+38344${String(520000 + i * 173).padStart(6, '0')}`,
      })
      .returning({ id: patients.id });
    const patientId = p!.id;
    const [schedule] = await db
      .insert(dialysisSchedules)
      .values({
        patientId,
        unitId,
        days,
        shift,
        durationMinutes: i % 5 === 0 ? 210 : 240,
        targetWeightKg: target.toString(),
        vascularAccess: i % 7 === 0 ? 'TUNNELLED_CATHETER' : i % 9 === 0 ? 'GRAFT' : 'FISTULA',
        status: transplanted ? 'ENDED' : 'ACTIVE',
        startedOn,
        endedOn,
        endReason: transplanted ? 'TRANSPLANT' : null,
        createdById: doctorId,
      })
      .returning();
    const s = schedule!;

    const rows: (typeof dialysisSessions.$inferInsert)[] = [];
    let previousPost = target + between(-0.2, 0.4);
    let measuredMonth = '';
    for (let d = -HISTORY_DAYS; d <= 0; d++) {
      const date = addDays(today, d);
      if (date < startedOn || (endedOn && date > endedOn)) continue;
      if (!days.includes(weekdayOf(date))) continue;
      const base = {
        patientId,
        unitId,
        scheduleId: s.id,
        sessionDate: date,
        machine: `Vendi ${station}`,
        nurseId,
      };
      if (d < 0 && rand() < 0.04) {
        rows.push({
          ...base,
          status: 'MISSED',
          missedReason: rand() < 0.5 ? 'Nuk erdhi – pa transport' : 'I shtruar në spital',
        });
        continue;
      }
      const startHour = shift === 'MORNING' ? 7 : 12;
      const startedAt = localTime(date, startHour, Math.floor(between(0, 40)));
      const gain = bigGains && rand() < 0.6 ? between(3.4, 4.6) : between(1.0, 2.9);
      const pre = round1(previousPost + gain);
      const preSystolic = Math.round(
        i === 8 && rand() < 0.5 ? between(182, 196) : between(118, 168),
      );
      const preDiastolic = Math.round(between(66, 96));
      const isToday = d === 0;
      // Today: the morning shift is on the machines, the afternoon shift has not come yet.
      if (isToday && shift === 'AFTERNOON') {
        rows.push({ ...base, status: 'PLANNED', machine: null, nurseId: null });
        continue;
      }
      if (isToday) {
        rows.push({
          ...base,
          status: 'IN_PROGRESS',
          startedAt,
          preWeightKg: pre.toString(),
          preSystolic,
          preDiastolic,
        });
        continue;
      }
      const post = round1(target + between(-0.3, 0.5));
      const minutes = s.durationMinutes + Math.round(between(-12, 6));
      const hypotension = rand() < 0.07;
      const complications = [
        ...(hypotension ? ['HYPOTENSION'] : []),
        ...(rand() < 0.06 ? ['CRAMPS'] : []),
        ...(s.vascularAccess !== 'FISTULA' && rand() < 0.05 ? ['ACCESS_PROBLEM'] : []),
      ];
      const month = date.slice(0, 7);
      const measure = month !== measuredMonth;
      let preUrea: string | null = null;
      let postUrea: string | null = null;
      if (measure) {
        measuredMonth = month;
        const u = between(17, 31);
        const r = poorAdequacy ? between(0.4, 0.46) : between(0.26, 0.34);
        preUrea = round1(u).toString();
        postUrea = round1(u * r).toString();
      }
      rows.push({
        ...base,
        status: 'COMPLETED',
        startedAt,
        endedAt: new Date(startedAt.getTime() + minutes * 60_000),
        preWeightKg: pre.toString(),
        postWeightKg: post.toString(),
        preSystolic,
        preDiastolic,
        postSystolic: Math.round(hypotension ? between(82, 92) : between(108, 142)),
        postDiastolic: Math.round(between(58, 82)),
        ultrafiltrationMl: Math.max(0, Math.round((pre - post) * 10) * 100),
        bloodFlowMlMin: Math.round(between(25, 35)) * 10,
        preUrea,
        postUrea,
        complications,
        notes: hypotension
          ? 'Hipotension në orën e tretë – u ul ultrafiltrimi, pozicion Trendelenburg, NaCl 0.9% 200 ml.'
          : null,
      });
      previousPost = post;
    }
    if (rows.length) await db.insert(dialysisSessions).values(rows).onConflictDoNothing();
  }
  await planSessions({ today });
}
