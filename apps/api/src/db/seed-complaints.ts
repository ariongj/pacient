/**
 * Synthetic demo data for complaints and feedback (development only): ten complaints at the demo
 * hospital in every state (one overdue for acknowledgement, one overdue for a response, one
 * escalated to the Ministry awaiting a decision, one from the demo patient Arta Krasniqi) and
 * about sixty anonymous feedback responses over six months. The demo patient also gets a
 * completed appointment three days ago that is left unrated, so the portal shows the rating
 * prompt. Seeded feedback uses random dedupe keys (it is not tied to real visits).
 */
import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import { isProd } from '../config/env.js';
import { db } from './client.js';
import {
  appointments,
  careUnits,
  complaints,
  feedbackResponses,
  patients,
  users,
} from './schema.js';
import {
  deadlinesFor,
  monthOf,
  nextComplaintReference,
} from '../modules/complaints/complaints.service.js';

const DAY = 86_400_000;
const daysAgo = (n: number, hour = 10) => {
  const d = new Date(Date.now() - n * DAY);
  d.setUTCHours(hour, 20, 0, 0);
  return new Date(Math.min(d.getTime(), Date.now() - 60_000));
};

interface Demo {
  patient: 'demo' | number;
  channel: 'PORTAL' | 'IN_PERSON' | 'PHONE' | 'LETTER';
  category: string;
  received: number;
  description: string;
  desiredOutcome?: string;
  acknowledged?: number;
  status: 'RECEIVED' | 'ACKNOWLEDGED' | 'INVESTIGATING' | 'RESPONDED' | 'CLOSED' | 'ESCALATED';
  assignee?: string;
  responded?: number;
  response?: string;
  outcome?: 'UPHELD' | 'PARTLY_UPHELD' | 'NOT_UPHELD' | 'WITHDRAWN';
  escalated?: number;
  escalationReason?: string;
  decision?: string;
  closed?: number;
}

const DEMOS: Demo[] = [
  {
    patient: 'demo',
    channel: 'PORTAL',
    category: 'COMMUNICATION',
    received: 6,
    acknowledged: 4,
    status: 'ACKNOWLEDGED',
    description:
      'Rezultatet e analizave të mia u vonuan dy javë dhe askush nuk më njoftoi. Mora vesh vetëm kur telefonova vetë.',
    desiredOutcome: 'Dua të di pse ndodhi dhe që të njoftohem në kohë herën tjetër.',
  },
  {
    patient: 0,
    channel: 'PORTAL',
    category: 'WAITING_TIME',
    received: 9,
    status: 'RECEIVED',
    description:
      'Prita mbi pesë orë në emergjencë me fëmijën me temperaturë të lartë pa asnjë informacion.',
  },
  {
    patient: 1,
    channel: 'IN_PERSON',
    category: 'STAFF_ATTITUDE',
    received: 20,
    acknowledged: 17,
    status: 'INVESTIGATING',
    assignee: 'nurse@pacient.local',
    description:
      'Gjatë natës në repart, infermierja foli me ton të ashpër me nënën time të moshuar.',
  },
  {
    patient: 2,
    channel: 'PORTAL',
    category: 'CARE_QUALITY',
    received: 34,
    acknowledged: 30,
    status: 'INVESTIGATING',
    assignee: 'doctor@pacient.local',
    description:
      'Pas operacionit nuk më shpjeguan si të kujdesem për plagën dhe u infektua në shtëpi.',
  },
  {
    patient: 3,
    channel: 'LETTER',
    category: 'BILLING',
    received: 35,
    acknowledged: 31,
    status: 'RESPONDED',
    responded: 10,
    outcome: 'UPHELD',
    response:
      'Pas verifikimit konstatuam se participimi ju ishte llogaritur gabimisht dy herë. Shuma do t’ju kthehet brenda 15 ditëve dhe kemi korrigjuar procedurën e arkës.',
    description: 'Më është faturuar dy herë e njëjta vizitë në arkë.',
  },
  {
    patient: 4,
    channel: 'PHONE',
    category: 'FACILITIES',
    received: 60,
    acknowledged: 57,
    status: 'CLOSED',
    responded: 40,
    closed: 30,
    outcome: 'NOT_UPHELD',
    response:
      'Kontrolluam pastrimin e tualeteve në atë ditë dhe ishte kryer sipas orarit. Megjithatë, kemi shtuar një kontroll shtesë pasdite.',
    description: 'Tualetet në katin e dytë ishin të papastra gjithë ditën.',
  },
  {
    patient: 5,
    channel: 'PORTAL',
    category: 'PRIVACY',
    received: 50,
    acknowledged: 46,
    status: 'ESCALATED',
    responded: 25,
    outcome: 'NOT_UPHELD',
    response:
      'Diagnoza juaj nuk u diskutua në korridor; mjeku foli me ju në dhomën e pritjes ndërsa nuk kishte njerëz të tjerë.',
    escalated: 5,
    escalationReason:
      'Kishte njerëz të tjerë në dhomë dhe dëgjuan diagnozën time. Përgjigjja nuk është e saktë.',
    description: 'Mjeku foli për diagnozën time me zë të lartë në dhomën e pritjes.',
  },
  {
    patient: 6,
    channel: 'PORTAL',
    category: 'WAITING_TIME',
    received: 120,
    acknowledged: 116,
    status: 'CLOSED',
    responded: 95,
    outcome: 'PARTLY_UPHELD',
    response:
      'Pritja për ekografi ishte më e gjatë se afati për shkak të një aparati në riparim. Kemi rishikuar renditjen e termineve.',
    escalated: 80,
    escalationReason: 'Pritja vazhdon të jetë e gjatë edhe pas përgjigjes.',
    decision:
      'Ministria konstaton se institucioni ka marrë masa. Institucioni duhet të raportojë çdo muaj kohët e pritjes për ekografi për gjashtë muajt e ardhshëm.',
    closed: 60,
    description: 'Termini për ekografi më është shtyrë tri herë radhazi.',
  },
  {
    patient: 7,
    channel: 'PORTAL',
    category: 'OTHER',
    received: 15,
    status: 'CLOSED',
    outcome: 'WITHDRAWN',
    closed: 12,
    description:
      'Parkingu i spitalit është gjithmonë plot dhe nuk ka vende për persona me aftësi të kufizuara.',
  },
  {
    patient: 8,
    channel: 'PHONE',
    category: 'COMMUNICATION',
    received: 1,
    status: 'RECEIVED',
    description:
      'Telefonoi për të thënë se askush nuk i përgjigjet numrit të repartit të pediatrisë gjatë natës.',
  },
];

const FEEDBACK_COMMENTS = [
  'Infermieret ishin shumë të sjellshme.',
  'Pritja ishte e gjatë, por mjeku shpjegoi gjithçka qartë.',
  'Dhomat ishin të pastra.',
  'Ushqimi mund të ishte më i mirë.',
  'Nuk më shpjeguan sa duhet për barnat.',
  null,
  null,
  null,
];

export async function seedComplaints({ facilityId }: { facilityId: string; demoDoctorId: string }) {
  if (isProd) throw new Error('Refusing to seed demo complaints in production');
  const staff = new Map(
    (
      await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          inArray(users.email, [
            'director@pacient.local',
            'doctor@pacient.local',
            'nurse@pacient.local',
            'patient@pacient.local',
          ]),
        )
    ).map((u) => [u.email, u.id]),
  );
  const director = staff.get('director@pacient.local');
  const patientUser = staff.get('patient@pacient.local');
  if (!director) return;
  const [demoPatient] = patientUser
    ? await db.select().from(patients).where(eq(patients.userId, patientUser))
    : [];
  const others = await db
    .select({ id: patients.id })
    .from(patients)
    .where(
      and(
        eq(patients.primaryFacilityId, facilityId),
        demoPatient ? ne(patients.id, demoPatient.id) : undefined,
      ),
    )
    .limit(9);
  if (!others.length) return;

  for (const d of DEMOS) {
    const patientId =
      d.patient === 'demo' ? demoPatient?.id : others[d.patient % others.length]!.id;
    if (!patientId) continue;
    const receivedAt = daysAgo(d.received, 9);
    await db.transaction(async (tx) => {
      const reference = await nextComplaintReference(tx, receivedAt);
      await tx.insert(complaints).values({
        reference,
        facilityId,
        patientId,
        submittedByUserId: d.patient === 'demo' ? (patientUser ?? null) : null,
        channel: d.channel,
        category: d.category,
        description: d.description,
        desiredOutcome: d.desiredOutcome ?? null,
        status: d.status,
        assignedToId: d.assignee ? (staff.get(d.assignee) ?? null) : null,
        acknowledgedAt: d.acknowledged !== undefined ? daysAgo(d.acknowledged, 11) : null,
        ...deadlinesFor(receivedAt),
        response: d.response ?? null,
        respondedAt: d.responded !== undefined ? daysAgo(d.responded, 14) : null,
        respondedById: d.responded !== undefined ? director : null,
        outcome: d.outcome ?? null,
        escalatedAt: d.escalated !== undefined ? daysAgo(d.escalated, 16) : null,
        escalationReason: d.escalationReason ?? null,
        ministryDecision: d.decision ?? null,
        closedAt: d.closed !== undefined ? daysAgo(d.closed, 15) : null,
        createdAt: receivedAt,
      });
    });
  }

  // Anonymous feedback over the last six months (random keys: not linked to any visit).
  const units = await db
    .select({ id: careUnits.id })
    .from(careUnits)
    .where(
      and(
        eq(careUnits.facilityId, facilityId),
        inArray(careUnits.type, ['GENERAL_WARD', 'SURGICAL_WARD', 'PAEDIATRIC', 'MATERNITY']),
      ),
    );
  const settings = ['OUTPATIENT', 'OUTPATIENT', 'INPATIENT', 'EMERGENCY', 'VIDEO'] as const;
  const rows = Array.from({ length: 64 }, (_, i) => {
    const setting = settings[i % settings.length]!;
    const overall = [5, 4, 4, 3, 5, 2, 4, 5, 3, 4][i % 10]!;
    const month = monthOf(daysAgo((i * 3) % 175));
    return {
      facilityId,
      // Two wards, so one of them has enough responses to be shown.
      unitId:
        setting === 'INPATIENT' && units.length ? units[i % Math.min(2, units.length)]!.id : null,
      setting,
      dedupeKey: `seed-${randomUUID()}`,
      overall,
      scores: {
        waiting: Math.max(1, overall - (setting === 'EMERGENCY' ? 2 : 1)),
        communication: overall,
        cleanliness: Math.min(5, overall + (i % 2)),
        respect: Math.min(5, overall + 1),
        explanation: Math.max(1, overall - (i % 3 === 0 ? 1 : 0)),
      },
      wouldRecommend: overall >= 4 ? true : overall <= 2 ? false : i % 2 === 0,
      comment: FEEDBACK_COMMENTS[i % FEEDBACK_COMMENTS.length] ?? null,
      month,
      createdAt: new Date(`${month}T00:00:00Z`),
    };
  });
  await db.insert(feedbackResponses).values(rows);

  // A recent visit for the demo patient that is left unrated (the portal shows the prompt).
  if (demoPatient) {
    const recent = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.patientId, demoPatient.id),
          eq(appointments.status, 'COMPLETED'),
          gte(appointments.scheduledAt, new Date(Date.now() - 25 * DAY)),
        ),
      )
      .limit(1);
    if (!recent.length) {
      const doctor = staff.get('doctor@pacient.local');
      if (doctor) {
        await db.insert(appointments).values({
          patientId: demoPatient.id,
          doctorId: doctor,
          facilityId,
          scheduledAt: daysAgo(3, 8),
          reason: 'Kontroll i tensionit',
          status: 'COMPLETED',
        });
      }
    }
  }
}
