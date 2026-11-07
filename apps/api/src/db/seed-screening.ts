import { and, eq, isNull } from 'drizzle-orm';
import { db } from './client.js';
import {
  careAssignments,
  careTasks,
  patients,
  screeningEpisodes,
  screeningOptOuts,
  users,
} from './schema.js';
import {
  addMonths,
  inPopulation,
  isoDate,
  nextDueAfter,
  PROGRAMME_CODES,
  testFor,
  ageOn,
  type ProgrammeCode,
  type ScreeningResult,
} from '../modules/screening/definitions.js';
import { notifyPatient } from '../modules/notifications/notifications.service.js';

/**
 * Synthetic cancer screening at the demo facility (development only): people in the programmes'
 * age ranges with normal results at different times, one abnormal result awaiting a referral
 * (it shows on the doctor's safety net), one inadequate sample, a declined invitation, an
 * opt-out, open invitations (one past the reminder) and a booking – and an open cervical
 * screening invitation for the demo patient, so the portal shows it.
 */

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

export async function seedScreening(opts: { facilityId: string; demoDoctorId: string }) {
  const { facilityId, demoDoctorId } = opts;
  const people = await db
    .select({
      id: patients.id,
      sex: patients.sex,
      dateOfBirth: patients.dateOfBirth,
      userId: patients.userId,
    })
    .from(patients)
    .where(
      and(
        eq(patients.primaryFacilityId, facilityId),
        isNull(patients.mergedIntoId),
        isNull(patients.deceasedAt),
        isNull(patients.temporaryIdentity),
      ),
    )
    .orderBy(patients.nationalId);
  const [demoUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'patient@pacient.local'));
  const demo = people.find((p) => p.userId && p.userId === demoUser?.id);
  const now = new Date();

  // Eligible (person, programme) pairs, demo patient excluded (handled below).
  const pairs: { patientId: string; dateOfBirth: string; programme: ProgrammeCode }[] = [];
  for (const p of people) {
    if (p.id === demo?.id) continue;
    for (const code of PROGRAMME_CODES) {
      if (inPopulation(code, p, now)) {
        pairs.push({ patientId: p.id, dateOfBirth: p.dateOfBirth, programme: code });
      }
    }
  }
  if (!pairs.length) return;

  const doctorPatients = new Set(
    (
      await db
        .select({ patientId: careAssignments.patientId })
        .from(careAssignments)
        .where(and(eq(careAssignments.doctorId, demoDoctorId), isNull(careAssignments.endedAt)))
    ).map((r) => r.patientId),
  );

  type Plan =
    | { kind: 'RESULT'; result: ScreeningResult; screenedDaysAgo: number }
    | { kind: 'DECLINED' }
    | { kind: 'OPT_OUT' }
    | { kind: 'INVITED'; invitedDaysAgo: number; booked?: boolean };
  // Roughly two thirds screened normally; one of each special case.
  const plans: Plan[] = [
    { kind: 'RESULT', result: 'ABNORMAL', screenedDaysAgo: 25 },
    { kind: 'RESULT', result: 'INADEQUATE', screenedDaysAgo: 20 },
    { kind: 'DECLINED' },
    { kind: 'OPT_OUT' },
    { kind: 'INVITED', invitedDaysAgo: 50 },
    { kind: 'INVITED', invitedDaysAgo: 12, booked: true },
    { kind: 'INVITED', invitedDaysAgo: 3 },
  ];
  // The abnormal result goes to someone in the demo doctor's care, so it shows on their worklist.
  pairs.sort(
    (a, b) => Number(doctorPatients.has(b.patientId)) - Number(doctorPatients.has(a.patientId)),
  );
  for (let i = plans.length; i < pairs.length; i++) {
    if (i % 3 !== 0) plans.push({ kind: 'RESULT', result: 'NORMAL', screenedDaysAgo: 30 + i * 23 });
  }

  for (const [i, plan] of plans.entries()) {
    const pair = pairs[i];
    if (!pair) break;
    const { patientId, programme, dateOfBirth } = pair;
    const test = testFor(programme, ageOn(dateOfBirth, now));
    if (plan.kind === 'OPT_OUT') {
      await db.insert(screeningOptOuts).values({
        patientId,
        programme,
        reason: 'Prefers to be screened privately',
        recordedVia: 'IN_PERSON',
        recordedById: demoDoctorId,
        createdAt: daysAgo(90),
      });
      continue;
    }
    if (plan.kind === 'DECLINED') {
      await db.insert(screeningEpisodes).values({
        patientId,
        programme,
        facilityId,
        status: 'DECLINED',
        invitedAt: daysAgo(70),
        dueDate: isoDate(daysAgo(70)),
        resultDetail: 'Not this year',
        nextDueDate: isoDate(addMonths(now, 24)),
        recordedById: demoDoctorId,
        createdAt: daysAgo(70),
      });
      continue;
    }
    if (plan.kind === 'INVITED') {
      const invitedAt = daysAgo(plan.invitedDaysAgo);
      await db.insert(screeningEpisodes).values({
        patientId,
        programme,
        facilityId,
        status: plan.booked ? 'BOOKED' : 'INVITED',
        invitedAt,
        reminderSentAt: plan.invitedDaysAgo > 42 ? daysAgo(plan.invitedDaysAgo - 42) : null,
        dueDate: isoDate(invitedAt),
        bookedFor: plan.booked ? new Date(Date.now() + 6 * DAY) : null,
        testType: test,
        createdAt: invitedAt,
      });
      continue;
    }
    const screenedAt = daysAgo(Math.min(plan.screenedDaysAgo, 700));
    const resultedAt = new Date(screenedAt.getTime() + 7 * DAY);
    await db.insert(screeningEpisodes).values({
      patientId,
      programme,
      facilityId,
      status: plan.result === 'ABNORMAL' ? 'REFERRED' : 'RESULTED',
      invitedAt: new Date(screenedAt.getTime() - 21 * DAY),
      dueDate: isoDate(new Date(screenedAt.getTime() - 21 * DAY)),
      screenedAt,
      testType: test,
      result: plan.result,
      resultDetail:
        plan.result === 'ABNORMAL'
          ? 'Rezultat jo normal – dërgim për vlerësim'
          : plan.result === 'INADEQUATE'
            ? 'Mostër e pamjaftueshme'
            : null,
      resultedAt,
      nextDueDate: nextDueAfter(programme, { dateOfBirth }, screenedAt, plan.result),
      recordedById: demoDoctorId,
      createdAt: new Date(screenedAt.getTime() - 21 * DAY),
    });
    if (plan.result === 'ABNORMAL') {
      await db.insert(careTasks).values({
        patientId,
        facilityId,
        createdById: demoDoctorId,
        assignedToId: demoDoctorId,
        assignedRole: 'DOCTOR',
        title: 'Follow up an abnormal screening result',
        priority: 'URGENT',
        dueAt: new Date(resultedAt.getTime() + 14 * DAY),
        createdAt: resultedAt,
      });
    }
  }

  // The demo patient: an open invitation to cervical screening, with its notification.
  if (demo && inPopulation('CERVICAL', demo, now)) {
    const invitedAt = daysAgo(10);
    await db.insert(screeningEpisodes).values({
      patientId: demo.id,
      programme: 'CERVICAL',
      facilityId,
      status: 'INVITED',
      invitedAt,
      dueDate: isoDate(invitedAt),
      testType: testFor('CERVICAL', ageOn(demo.dateOfBirth, now)),
      createdAt: invitedAt,
    });
    await notifyPatient(demo.id, {
      type: 'screening_invitation',
      title: 'Invitation to a free screening programme',
      body: 'Please contact your family medicine centre to book an appointment. The details are in the portal.',
      link: '/portal/screening',
    });
  }
}
