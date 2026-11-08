import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Executor } from '../../db/client.js';
import {
  careUnits,
  homeCareEpisodes,
  homeVisits,
  notifications,
  unitStaff,
  users,
} from '../../db/schema.js';
import { forbidden, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../lib/http.js';
import { notifyUsers } from '../notifications/notifications.service.js';

/**
 * Home care and community nursing.
 *
 * A doctor refers a patient to a community nursing team (a COMMUNITY_NURSING care unit); the team
 * accepts the referral, agrees a care plan, schedules home visits and records them. Team members
 * get record access to the patient while the episode is open (unitAccessVia in access/policy.ts).
 *
 * Storage notes (the schema is shared):
 * - the care plan is stored in `home_care_episodes.care_plan` as JSON `{ goals, tasks }`; plain
 *   text from older rows is read as goals;
 * - `home_visits.visited_at` is the check-in time (visit started); the visit is finished when it is
 *   recorded as DONE and `updated_at` of that change is the check-out time (a DONE visit is never
 *   edited again);
 * - the reason for a cancelled visit is kept in `missed_reason` like the reason for a missed one.
 */

export const TASKS = [
  'WOUND_CARE',
  'MEDICATION',
  'INJECTION',
  'CATHETER',
  'OBSERVATIONS',
  'PALLIATIVE',
  'ASSESSMENT',
  'OTHER',
] as const;
export type HomeCareTask = (typeof TASKS)[number];

/** A missed visit with one of these tasks may harm the patient: the referrer and team are told. */
export const HIGH_RISK_TASKS: ReadonlySet<string> = new Set([
  'MEDICATION',
  'INJECTION',
  'PALLIATIVE',
]);

export const EPISODE_STATUSES = ['REFERRED', 'ACTIVE', 'ON_HOLD', 'DISCHARGED'] as const;
export const OPEN_EPISODE_STATUSES = ['REFERRED', 'ACTIVE', 'ON_HOLD'] as const;
export const VISIT_STATUSES = ['PLANNED', 'DONE', 'MISSED', 'CANCELLED'] as const;

export const FREQUENCIES = ['ONCE', 'DAILY', 'TWICE_WEEKLY', 'WEEKLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** A visit checked in this long ago without a check-out is flagged on the team board. */
export const CHECK_OUT_OVERDUE_MINUTES = 120;
/** Upper bounds for recurring schedules. */
export const MAX_SCHEDULE_WEEKS = 12;
export const MAX_VISITS_PER_SCHEDULE = 90;

export interface CarePlan {
  goals: string;
  tasks: HomeCareTask[];
}

export function parseCarePlan(raw: string | null | undefined): CarePlan {
  if (!raw) return { goals: '', tasks: [] };
  try {
    const value = JSON.parse(raw) as Partial<CarePlan>;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return {
        goals: typeof value.goals === 'string' ? value.goals : '',
        tasks: Array.isArray(value.tasks)
          ? value.tasks.filter((x): x is HomeCareTask => (TASKS as readonly string[]).includes(x))
          : [],
      };
    }
  } catch {
    // Plain text (not JSON): the whole text is the goals.
  }
  return { goals: raw, tasks: [] };
}

export const serialiseCarePlan = (plan: CarePlan) =>
  JSON.stringify({ goals: plan.goals.trim(), tasks: [...new Set(plan.tasks)] });

/**
 * Visit times for a schedule, starting at `start` (Europe/Belgrade wall-clock time is kept by
 * adding whole days, which is what the UI sends). TWICE_WEEKLY visits on the start day and three
 * days later each week.
 */
export function scheduleTimes(start: Date, frequency: Frequency, weeks: number): Date[] {
  const day = 86_400_000;
  const addDays = (d: Date, n: number) => {
    // Keep the local time across daylight-saving changes in Kosovo.
    const out = new Date(d.getTime() + n * day);
    const shift = tzOffsetMinutes(d) - tzOffsetMinutes(out);
    return new Date(out.getTime() - shift * 60_000);
  };
  const out: Date[] = [];
  if (frequency === 'ONCE') return [start];
  for (let w = 0; w < weeks; w++) {
    if (frequency === 'DAILY') for (let d = 0; d < 7; d++) out.push(addDays(start, w * 7 + d));
    if (frequency === 'TWICE_WEEKLY') out.push(addDays(start, w * 7), addDays(start, w * 7 + 3));
    if (frequency === 'WEEKLY') out.push(addDays(start, w * 7));
  }
  return out.slice(0, MAX_VISITS_PER_SCHEDULE);
}

/** Offset of Europe/Belgrade from UTC in minutes at a given instant (60 or 120). */
function tzOffsetMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Belgrade',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((local - Math.floor(d.getTime() / 60_000) * 60_000) / 60_000);
}

/** Calendar date in Kosovo (YYYY-MM-DD). */
export function kosovoDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export type VisitRow = typeof homeVisits.$inferSelect;
export type EpisodeRow = typeof homeCareEpisodes.$inferSelect;

/** Visit state derived from the stored columns (see the storage notes above). */
export function visitState(v: VisitRow, now = new Date()) {
  const inProgress = v.status === 'PLANNED' && v.visitedAt !== null;
  return {
    startedAt: v.visitedAt,
    finishedAt: v.status === 'DONE' ? v.updatedAt : null,
    inProgress,
    checkOutOverdue:
      inProgress && v.visitedAt!.getTime() < now.getTime() - CHECK_OUT_OVERDUE_MINUTES * 60_000,
    /** Planned for a time that has passed by more than 2 hours and not started. */
    late:
      v.status === 'PLANNED' &&
      v.visitedAt === null &&
      v.scheduledFor.getTime() < now.getTime() - CHECK_OUT_OVERDUE_MINUTES * 60_000,
  };
}

/* ------------------------------------------------------------------ teams ----------------- */

export async function loadTeam(unitId: string, executor: Executor = db) {
  const [team] = await executor
    .select()
    .from(careUnits)
    .where(and(eq(careUnits.id, unitId), sql`${careUnits.type}::text = 'COMMUNITY_NURSING'`));
  if (!team || !team.isActive) throw notFound('Community nursing team not found');
  return team;
}

/** The community nursing teams the user belongs to. */
export async function teamsOf(userId: string, executor: Executor = db) {
  return executor
    .select({ id: careUnits.id, name: careUnits.name, facilityId: careUnits.facilityId })
    .from(unitStaff)
    .innerJoin(careUnits, eq(careUnits.id, unitStaff.unitId))
    .where(
      and(
        eq(unitStaff.userId, userId),
        eq(careUnits.isActive, true),
        sql`${careUnits.type}::text = 'COMMUNITY_NURSING'`,
      ),
    );
}

export async function isTeamMember(userId: string, unitId: string, executor: Executor = db) {
  const [row] = await executor
    .select({ id: unitStaff.id })
    .from(unitStaff)
    .where(and(eq(unitStaff.userId, userId), eq(unitStaff.unitId, unitId)));
  return Boolean(row);
}

/** Team work (accepting, scheduling, recording visits) is done by the team's nurses and doctors. */
export async function assertTeamMember(ctx: AuthContext, unitId: string) {
  if (
    (ctx.role !== 'NURSE' && ctx.role !== 'DOCTOR') ||
    !(await isTeamMember(ctx.userId, unitId))
  ) {
    throw forbidden('Only members of the community nursing team can do this');
  }
}

export async function teamMembers(unitId: string, executor: Executor = db) {
  return executor
    .select({ id: users.id, name: users.fullName, role: users.role })
    .from(unitStaff)
    .innerJoin(users, eq(users.id, unitStaff.userId))
    .where(
      and(
        eq(unitStaff.unitId, unitId),
        eq(users.isActive, true),
        inArray(users.role, ['NURSE', 'DOCTOR']),
      ),
    )
    .orderBy(users.fullName);
}

/* ------------------------------------------------------------------ missed visits ---------- */

/**
 * A missed visit with medication, injections or palliative care: the referring doctor and the other
 * team members are told once (the notification link identifies the visit).
 */
export async function notifyMissedVisit(
  visit: VisitRow,
  episode: EpisodeRow,
  recordedById: string,
  executor: Executor = db,
): Promise<boolean> {
  const plan = parseCarePlan(episode.carePlan);
  const tasks = new Set([...visit.tasks, ...plan.tasks]);
  if (![...tasks].some((t) => HIGH_RISK_TASKS.has(t))) return false;
  const link = `/home-care?visit=${visit.id}&missed=1`;
  const [already] = await executor
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.link, link))
    .limit(1);
  if (already) return false;
  const members = await teamMembers(episode.teamUnitId, executor);
  await notifyUsers(
    [episode.referredById, ...members.map((m) => m.id)].filter((id) => id !== recordedById),
    {
      type: 'home_care',
      title: 'A home visit with medication or palliative care was missed – {team}',
      vars: { team: (await loadTeam(episode.teamUnitId, executor)).name },
      link,
      important: true,
    },
    executor,
  );
  return true;
}
