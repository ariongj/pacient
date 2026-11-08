import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';

/** API client and types for home care (community nursing). */

export const HOME_CARE_TASKS = [
  'WOUND_CARE',
  'MEDICATION',
  'INJECTION',
  'CATHETER',
  'OBSERVATIONS',
  'PALLIATIVE',
  'ASSESSMENT',
  'OTHER',
] as const;
export type HomeCareTask = (typeof HOME_CARE_TASKS)[number];
export type EpisodeStatus = 'REFERRED' | 'ACTIVE' | 'ON_HOLD' | 'DISCHARGED';
export type VisitStatus = 'PLANNED' | 'DONE' | 'MISSED' | 'CANCELLED';
export const FREQUENCIES = ['ONCE', 'DAILY', 'TWICE_WEEKLY', 'WEEKLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface CarePlan {
  goals: string;
  tasks: HomeCareTask[];
}

export interface HomeVisit {
  id: string;
  episodeId: string;
  patientId: string;
  scheduledFor: string;
  assignedToId: string | null;
  assignedTo: string | null;
  status: VisitStatus;
  tasks: HomeCareTask[];
  notes: string | null;
  missedReason: string | null;
  recordedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  inProgress: boolean;
  checkOutOverdue: boolean;
  late: boolean;
}

export interface BoardVisit extends HomeVisit {
  patientName: string;
  phone?: string | null;
  address?: string | null;
  accessNotes?: string | null;
}

export interface HomeCareEpisode {
  id: string;
  patientId: string;
  teamUnitId: string;
  teamName: string;
  teamFacilityName: string;
  referredById: string;
  referredBy: string | null;
  reason: string;
  carePlan: CarePlan;
  visitAddress: string | null;
  accessNotes: string | null;
  status: EpisodeStatus;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
  visits: HomeVisit[];
  isMyTeam?: boolean;
}

export interface Team {
  id: string;
  name: string;
  facilityId: string;
  facilityName: string;
}

export interface TeamMember {
  id: string;
  name: string;
  role: string;
}

export interface Board {
  teams: { id: string; name: string }[];
  team: { id: string; name: string } | null;
  date: string;
  members?: TeamMember[];
  byNurse?: { nurseId: string | null; nurse: string | null; visits: BoardVisit[] }[];
  attention?: BoardVisit[];
  episodes?: {
    id: string;
    patientId: string;
    patientName: string;
    status: EpisodeStatus;
    reason: string;
    tasks: HomeCareTask[];
    referredBy: string | null;
    createdAt: string;
    startedAt: string | null;
  }[];
}

export interface TeamStats {
  teams: {
    id: string;
    name: string;
    referred: number;
    active: number;
    onHold: number;
    dischargedLast12Months: number;
    averageEpisodeDays: number | null;
    weeks: { week: string; planned: number; done: number; missed: number; cancelled: number }[];
  }[];
}

export interface MyHomeCare {
  limited: boolean;
  items: {
    id: string;
    teamName: string;
    teamFacilityName: string;
    status: EpisodeStatus;
    startedAt: string | null;
    endedAt: string | null;
    visitAddress: string | null;
    carePlan: CarePlan | null;
    upcoming: { id: string; scheduledFor: string; nurse: string | null; tasks: HomeCareTask[] }[];
    recent: { id: string; date: string; status: VisitStatus; nurse: string | null }[];
  }[];
}

/* ------------------------------------------------------------------ labels --------------- */

export const taskLabel = (task: string) =>
  ({
    WOUND_CARE: t('Wound care'),
    MEDICATION: t('Medication'),
    INJECTION: t('Injection'),
    CATHETER: t('Catheter care'),
    OBSERVATIONS: t('Observations'),
    PALLIATIVE: t('Palliative care'),
    ASSESSMENT: t('Assessment'),
    OTHER: t('Other'),
  })[task] ?? task;

export const episodeStatusLabel = (s: EpisodeStatus) =>
  ({
    REFERRED: t('Referred|home care'),
    ACTIVE: t('Active|home care'),
    ON_HOLD: t('On hold'),
    DISCHARGED: t('Discharged from home care'),
  })[s];

export const visitStatusLabel = (s: VisitStatus) =>
  ({
    PLANNED: t('Planned|visit'),
    DONE: t('Done|visit'),
    MISSED: t('Missed|visit'),
    CANCELLED: t('Cancelled|visit'),
  })[s];

export const frequencyLabel = (f: Frequency) =>
  ({
    ONCE: t('Once'),
    DAILY: t('Every day'),
    TWICE_WEEKLY: t('Twice a week'),
    WEEKLY: t('Once a week'),
  })[f];

/* ------------------------------------------------------------------ queries -------------- */

const KEY = ['home-care'];

export const useTeams = (patientId?: string) =>
  useQuery({
    queryKey: [...KEY, 'teams', patientId ?? ''],
    queryFn: () =>
      api<{ teams: Team[]; myTeams: string[] }>('/home-care/teams', {
        query: { patientId },
      }),
  });

export const useTeamMembers = (teamId: string | null | undefined) =>
  useQuery({
    queryKey: [...KEY, 'members', teamId],
    queryFn: () => api<{ items: TeamMember[] }>(`/home-care/teams/${teamId}/members`),
    enabled: Boolean(teamId),
  });

export const usePatientHomeCare = (patientId: string) =>
  useQuery({
    queryKey: ['patient', patientId, 'home-care'],
    queryFn: () =>
      api<{ items: HomeCareEpisode[]; canRefer: boolean; defaultAddress: string | null }>(
        `/home-care/patients/${patientId}`,
      ),
  });

export const useEpisode = (id: string | null) =>
  useQuery({
    queryKey: [...KEY, 'episode', id],
    queryFn: () =>
      api<
        HomeCareEpisode & {
          isMyTeam: boolean;
          patient: {
            id: string;
            firstName: string;
            lastName: string;
            nationalId: string;
            dateOfBirth: string;
            phone: string | null;
          };
        }
      >(`/home-care/episodes/${id}`),
    enabled: Boolean(id),
  });

export const useBoard = (teamId: string | undefined, date: string | undefined) =>
  useQuery({
    queryKey: [...KEY, 'board', teamId ?? '', date ?? ''],
    queryFn: () => api<Board>('/home-care/board', { query: { teamId, date } }),
    refetchInterval: 60_000,
  });

export const useTeamStats = (enabled = true) =>
  useQuery({
    queryKey: [...KEY, 'stats'],
    queryFn: () => api<TeamStats>('/home-care/stats'),
    enabled,
  });

export const useMyHomeCare = (patientId: string) =>
  useQuery({
    queryKey: [...KEY, 'mine', patientId],
    queryFn: () => api<MyHomeCare>('/home-care/mine'),
  });

/* ------------------------------------------------------------------ mutations ------------ */

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ['patient'] });
  };
}

export function useHomeCareAction<TBody = Record<string, unknown>>(
  build: (body: TBody) => { path: string; method?: 'POST' | 'PATCH'; body?: unknown },
) {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (body: TBody) => {
      const r = build(body);
      return api<Record<string, unknown>>(r.path, { method: r.method ?? 'POST', body: r.body });
    },
    onSuccess: done,
  });
}
