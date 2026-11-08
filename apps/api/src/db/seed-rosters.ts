import { and, eq, inArray } from 'drizzle-orm';
import { db } from './client.js';
import { careUnits, rosterShifts, unitStaff, users } from './schema.js';
import { audit, AuditAction } from '../modules/audit/audit.service.js';
import {
  shiftWindow,
  weekStartOf,
  type OnCallSpecialty,
  type ShiftKind,
} from '../modules/rosters/rosters.service.js';
import { addDays, localDate } from '../modules/scheduling/time.js';

/**
 * Synthetic demo rosters (development only): this week and next for four wards and an on-call
 * rota for five specialties, with two deliberate gaps – Pediatria has no night nurse on Wednesday
 * next week, and anaesthesia has no on-call cover on Saturday night next week.
 *
 * Each ward is covered by four nurses on the 7-day pattern D D L L N N – with offsets 0, 2, 4 and
 * 6, which puts at least one nurse on every day, late and night shift and keeps 11 hours of rest
 * and 48 hours a week.
 */
const PATTERN: (ShiftKind | null)[] = ['DAY', 'DAY', 'LATE', 'LATE', 'NIGHT', 'NIGHT', null];
const OFFSETS = [0, 2, 4, 6];

const SYNTHETIC_NURSES = [
  'Arta Berisha',
  'Blerina Krasniqi',
  'Drita Gashi',
  'Edona Hoti',
  'Fatime Rexhepi',
  'Gresa Shala',
  'Hana Morina',
  'Ilirjana Kelmendi',
  'Jehona Bytyqi',
  'Kaltrina Hyseni',
  'Lumnije Sopi',
  'Merita Zeka',
  'Nora Dervishi',
  'Qëndresa Ahmeti',
  'Rina Mustafa',
];

const SYNTHETIC_DOCTORS: { name: string; specialty: string; onCall: OnCallSpecialty }[] = [
  { name: 'Dr. Arsim Berisha', specialty: 'Kirurgji e përgjithshme', onCall: 'GENERAL_SURGERY' },
  { name: 'Dr. Lindita Gashi', specialty: 'Kirurgji e përgjithshme', onCall: 'GENERAL_SURGERY' },
  { name: 'Dr. Fatos Hyseni', specialty: 'Anesteziologji', onCall: 'ANAESTHESIA' },
  { name: 'Dr. Merita Kelmendi', specialty: 'Anesteziologji', onCall: 'ANAESTHESIA' },
  { name: 'Dr. Ilir Rexhepi', specialty: 'Mjekësi interne', onCall: 'INTERNAL_MEDICINE' },
  { name: 'Dr. Agron Hoxha', specialty: 'Mjekësi interne', onCall: 'INTERNAL_MEDICINE' },
  { name: 'Dr. Blerta Morina', specialty: 'Kardiologji', onCall: 'CARDIOLOGY' },
  { name: 'Dr. Vjosa Sylejmani', specialty: 'Pediatri', onCall: 'PAEDIATRICS' },
];

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/^dr\.\s*/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]+/g, '.');

export async function seedRosters(opts: { facilityId: string; demoDoctorId: string }) {
  const { facilityId } = opts;
  const wards = await db
    .select({ id: careUnits.id, name: careUnits.name, type: careUnits.type })
    .from(careUnits)
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        inArray(careUnits.type, ['GENERAL_WARD', 'SURGICAL_WARD', 'ICU', 'PAEDIATRIC']),
      ),
    );
  const order = ['GENERAL_WARD', 'SURGICAL_WARD', 'ICU', 'PAEDIATRIC'];
  wards.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  const [director] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.facilityId, facilityId), eq(users.role, 'DIRECTOR')))
    .limit(1);
  if (!director || !wards.length) return;

  // Nurses: the demo nurse plus synthetic, non-login colleagues (no password).
  const [demoNurse] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'nurse@pacient.local'));
  const nurseIds: string[] = demoNurse ? [demoNurse.id] : [];
  for (const [i, name] of SYNTHETIC_NURSES.entries()) {
    if (nurseIds.length >= wards.length * OFFSETS.length) break;
    const [u] = await db
      .insert(users)
      .values({
        email: `infermiere.${slug(name)}@pacient.local`,
        fullName: name,
        role: 'NURSE',
        facilityId,
        specialty: 'Infermiere',
        licenseNumber: `KIK-R${String(i + 1).padStart(3, '0')}`,
        locale: 'sq',
      })
      .returning({ id: users.id });
    nurseIds.push(u!.id);
  }

  const thisMonday = weekStartOf(localDate(new Date()));
  const nextMonday = addDays(thisMonday, 7);
  const rows: (typeof rosterShifts.$inferInsert)[] = [];
  for (const [w, ward] of wards.entries()) {
    const team = nurseIds.slice(w * OFFSETS.length, (w + 1) * OFFSETS.length);
    for (const nurseId of team) {
      await db.insert(unitStaff).values({ unitId: ward.id, userId: nurseId }).onConflictDoNothing();
    }
    for (const [n, nurseId] of team.entries()) {
      for (let d = 0; d < 14; d++) {
        const kind = PATTERN[(d + OFFSETS[n]!) % 7];
        if (!kind) continue;
        const date = addDays(thisMonday, d);
        // Deliberate gap: no night nurse on Pediatria on Wednesday next week.
        if (ward.type === 'PAEDIATRIC' && kind === 'NIGHT' && date === addDays(nextMonday, 2)) {
          continue;
        }
        const window = shiftWindow(date, kind);
        if (!window) continue;
        rows.push({
          facilityId,
          unitId: ward.id,
          userId: nurseId,
          kind,
          ...window,
          createdById: director.id,
        });
      }
    }
  }

  // On-call rota: existing doctors by specialty plus synthetic colleagues.
  const byEmail = async (email: string) =>
    (await db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0]?.id;
  const rota = new Map<OnCallSpecialty, string[]>();
  const add = (s: OnCallSpecialty, id: string | undefined) => {
    if (id) rota.set(s, [...(rota.get(s) ?? []), id]);
  };
  add('CARDIOLOGY', await byEmail('doctor2@pacient.local'));
  add('PAEDIATRICS', await byEmail('doctor4@pacient.local'));
  for (const [i, d] of SYNTHETIC_DOCTORS.entries()) {
    const [u] = await db
      .insert(users)
      .values({
        email: `dr.${slug(d.name)}@pacient.local`,
        fullName: d.name,
        role: 'DOCTOR',
        facilityId,
        specialty: d.specialty,
        licenseNumber: `KMC-R${String(i + 1).padStart(3, '0')}`,
        locale: 'sq',
      })
      .returning({ id: users.id });
    add(d.onCall, u!.id);
  }
  for (const [specialty, doctors] of rota) {
    for (let d = 0; d < 14; d++) {
      const date = addDays(thisMonday, d);
      // Deliberate gap: no anaesthetist on call on Saturday night next week.
      if (specialty === 'ANAESTHESIA' && date === addDays(nextMonday, 5)) continue;
      const window = shiftWindow(date, 'ON_CALL');
      if (!window) continue;
      rows.push({
        facilityId,
        userId: doctors[d % doctors.length]!,
        kind: 'ON_CALL',
        specialty,
        ...window,
        createdById: director.id,
      });
    }
  }
  if (rows.length) await db.insert(rosterShifts).values(rows);

  // This week counts as published (no notifications are sent by the seed).
  await audit({
    action: AuditAction.ROSTER_CHANGED,
    actor: { userId: director.id, role: 'DIRECTOR', facilityId },
    resourceType: 'roster_week',
    metadata: { event: 'PUBLISHED', weekStart: thisMonday, unitId: null, seeded: true },
  });
}
