import { inArray, isNotNull, and } from 'drizzle-orm';
import { db } from './client.js';
import { professionalLicences, users } from './schema.js';

/**
 * Synthetic demo data for professional licences (development only).
 *
 * Every seeded doctor, nurse and pharmacist with a licence number gets an ACTIVE, linked licence,
 * so the demo keeps working with LICENCE_ENFORCEMENT=on. doctor9@ (not a main demo login) expires
 * in 20 days, an invited doctor without a password has a suspended licence, and 20 further
 * register entries are not linked to any account.
 */
const ISSUERS: Record<string, string> = {
  PHYSICIAN: 'Oda e Mjekëve të Kosovës',
  DENTIST: 'Oda e Stomatologëve të Kosovës',
  NURSE: 'Oda e Infermierëve, Mamive dhe Profesionistëve Shëndetësorë të Kosovës',
  MIDWIFE: 'Oda e Infermierëve, Mamive dhe Profesionistëve Shëndetësorë të Kosovës',
  PHARMACIST: 'Oda e Farmacistëve të Kosovës',
};
const PROFESSION_OF = { DOCTOR: 'PHYSICIAN', NURSE: 'NURSE', PHARMACIST: 'PHARMACIST' } as const;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysFromNow = (n: number) => iso(new Date(Date.now() + n * 86_400_000));

const UNLINKED: [string, string, keyof typeof ISSUERS, string | null, number][] = [
  // number, holder, profession, specialty, days until expiry (negative = expired)
  ['KMC-40101', 'Dr. Agron Berisha', 'PHYSICIAN', 'Kardiologji', 900],
  ['KMC-40102', 'Dr. Blerta Hoxha', 'PHYSICIAN', 'Pediatri', 640],
  ['KMC-40103', 'Dr. Driton Gashi', 'PHYSICIAN', 'Kirurgji e përgjithshme', 45],
  ['KMC-40104', 'Dr. Fjolla Krasniqi', 'PHYSICIAN', 'Gjinekologji dhe obstetrikë', 1200],
  ['KMC-40105', 'Dr. Gëzim Shala', 'PHYSICIAN', 'Mjekësi familjare', -15],
  ['KMC-40106', 'Dr. Hana Rexhepi', 'PHYSICIAN', 'Neurologji', 300],
  ['KDC-41001', 'Dr. Ilir Morina', 'DENTIST', 'Stomatologji', 520],
  ['KDC-41002', 'Dr. Jeta Bytyqi', 'DENTIST', 'Ortodonci', 75],
  ['KNC-42001', 'Kaltrina Ahmeti', 'NURSE', null, 800],
  ['KNC-42002', 'Labinot Kastrati', 'NURSE', null, 28],
  ['KNC-42003', 'Mimoza Zeqiri', 'NURSE', 'Infermieri pediatrike', 410],
  ['KNC-42004', 'Nora Musliu', 'NURSE', null, -60],
  ['KMW-43001', 'Arbnora Kelmendi', 'MIDWIFE', null, 700],
  ['KMW-43002', 'Teuta Sylejmani', 'MIDWIFE', null, 160],
  ['KPC-44001', 'Përparim Haxhiu', 'PHARMACIST', null, 950],
  ['KPC-44002', 'Qëndresa Osmani', 'PHARMACIST', 'Farmaci klinike', 55],
  ['KPC-44003', 'Rinor Salihu', 'PHARMACIST', null, 330],
  ['KMC-40107', 'Dr. Shpresa Avdiu', 'PHYSICIAN', 'Anesteziologji', 1100],
  ['KMC-40108', 'Dr. Valon Islami', 'PHYSICIAN', 'Ortopedi', 220],
  ['KNC-42005', 'Zana Halimi', 'NURSE', null, 365],
];

export async function seedLicences(opts: { facilityId: string; demoDoctorId: string }) {
  const clinical = await db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      specialty: users.specialty,
      licenseNumber: users.licenseNumber,
    })
    .from(users)
    .where(
      and(inArray(users.role, ['DOCTOR', 'NURSE', 'PHARMACIST']), isNotNull(users.licenseNumber)),
    );
  const values: (typeof professionalLicences.$inferInsert)[] = clinical.map((u, i) => {
    const profession = PROFESSION_OF[u.role as keyof typeof PROFESSION_OF];
    return {
      licenceNumber: u.licenseNumber!.trim(),
      holderName: u.fullName,
      profession,
      specialty: u.specialty,
      issuedBy: ISSUERS[profession]!,
      issuedOn: daysFromNow(-365 * 3 - i * 17),
      // doctor9@ shows the expiry reminders (not one of the main demo logins).
      validUntil: u.email === 'doctor9@pacient.local' ? daysFromNow(20) : daysFromNow(600 + i * 23),
      cpdCredits: 20 + ((i * 7) % 60),
      userId: u.id,
    };
  });

  // An invited doctor who never activated the account: licence suspended by the chamber.
  const [suspendedDoctor] = await db
    .insert(users)
    .values({
      email: 'dr.mentor.hasani@pacient.local',
      fullName: 'Dr. Mentor Hasani',
      role: 'DOCTOR',
      facilityId: opts.facilityId,
      specialty: 'Mjekësi interne',
      licenseNumber: 'KMC-10099',
    })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (suspendedDoctor) {
    values.push({
      licenceNumber: 'KMC-10099',
      holderName: 'Dr. Mentor Hasani',
      profession: 'PHYSICIAN',
      specialty: 'Mjekësi interne',
      issuedBy: ISSUERS.PHYSICIAN!,
      issuedOn: daysFromNow(-1500),
      validUntil: daysFromNow(400),
      status: 'SUSPENDED',
      statusReason:
        'Pezulluar përkohësisht nga Oda e Mjekëve deri në përfundimin e procedurës disiplinore',
      cpdCredits: 12,
      userId: suspendedDoctor.id,
    });
  }

  for (const [licenceNumber, holderName, profession, specialty, days] of UNLINKED) {
    values.push({
      licenceNumber,
      holderName,
      profession,
      specialty,
      issuedBy: ISSUERS[profession]!,
      issuedOn: daysFromNow(days - 5 * 365),
      validUntil: daysFromNow(days),
      cpdCredits: Math.max(0, 40 + days / 30) | 0,
    });
  }
  values.push({
    licenceNumber: 'KMC-40109',
    holderName: 'Dr. Xhevdet Lila',
    profession: 'PHYSICIAN',
    specialty: 'Kirurgji plastike',
    issuedBy: ISSUERS.PHYSICIAN!,
    issuedOn: daysFromNow(-2000),
    validUntil: daysFromNow(500),
    status: 'REVOKED',
    statusReason: 'Revokuar me vendim të Odës së Mjekëve',
    cpdCredits: 0,
  });

  await db.insert(professionalLicences).values(values).onConflictDoNothing();
}
