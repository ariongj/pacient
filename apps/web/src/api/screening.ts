import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import type { Tone } from '../components/ui';
import { api } from './client';

/** API client and types for cancer screening. */

export type ProgrammeCode = 'CERVICAL' | 'BREAST' | 'COLORECTAL';
export const PROGRAMME_CODES: ProgrammeCode[] = ['CERVICAL', 'BREAST', 'COLORECTAL'];
export type TestType = 'CYTOLOGY' | 'HPV' | 'MAMMOGRAPHY' | 'FIT';
export type ScreeningResult = 'NORMAL' | 'ABNORMAL' | 'INADEQUATE';
export type EpisodeStatus =
  | 'INVITED'
  | 'BOOKED'
  | 'SCREENED'
  | 'RESULTED'
  | 'REFERRED'
  | 'DECLINED'
  | 'NOT_ELIGIBLE'
  | 'CLOSED';
export type ProgrammeState =
  | 'NOT_IN_POPULATION'
  | 'OPTED_OUT'
  | 'CEASED'
  | 'FOLLOW_UP'
  | 'IN_PROGRESS'
  | 'UP_TO_DATE'
  | 'LEFT'
  | 'DUE';

export const PROGRAMME_TESTS: Record<ProgrammeCode, TestType[]> = {
  CERVICAL: ['CYTOLOGY', 'HPV'],
  BREAST: ['MAMMOGRAPHY'],
  COLORECTAL: ['FIT'],
};

export interface Episode {
  id: string;
  patientId: string;
  programme: ProgrammeCode;
  facilityId: string;
  status: EpisodeStatus;
  invitedAt: string | null;
  reminderSentAt: string | null;
  dueDate: string;
  bookedFor: string | null;
  screenedAt: string | null;
  testType: TestType | null;
  result: ScreeningResult | null;
  resultDetail: string | null;
  resultedAt: string | null;
  referralId: string | null;
  nextDueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProgrammeStatus {
  programme: ProgrammeCode;
  state: ProgrammeState;
  inPopulation: boolean;
  testOffered: TestType;
  openEpisode: Episode | null;
  lastScreenedAt: string | null;
  lastResult: ScreeningResult | null;
  nextDueDate: string | null;
  optOut: { id: string; programme: ProgrammeCode; reason: string | null; createdAt: string } | null;
  invitationOverdue: boolean;
  followUpOverdue: boolean;
}

export interface PatientScreening {
  referrals: {
    id: string;
    specialty: string;
    status: string;
    createdAt: string;
    toFacilityName: string;
  }[];
  person: { sex: string; age: number; deceased: boolean };
  programmes: ProgrammeStatus[];
  history: (Episode & { facilityName: string; recordedBy: string | null })[];
  canRecord: boolean;
  canDecide: boolean;
  disclaimer: string;
}

export interface WorklistItem {
  patient: {
    id: string;
    firstName: string;
    lastName: string;
    nationalId: string;
    dateOfBirth: string;
    sex: string;
    phone: string | null;
  };
  programmes: {
    programme: ProgrammeCode;
    state: ProgrammeState;
    testOffered: TestType;
    nextDueDate: string | null;
    lastScreenedAt: string | null;
    invitationOverdue: boolean;
    followUpOverdue: boolean;
    episodeId: string | null;
    invitedAt: string | null;
  }[];
}

export interface Worklist {
  items: WorklistItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: { due: number; followUp: number; followUpOverdue: number; inCare: number };
}

export interface CoverageRow {
  group: string | null;
  programme: ProgrammeCode;
  population: number | null;
  screenedInInterval: number | null;
  coveragePct: number | null;
  optedOut: number | null;
  invited12m: number | null;
  tookUp12m: number | null;
  uptakePct: number | null;
  resulted12m: number | null;
  abnormal12m: number | null;
  abnormalPct: number | null;
  followUpOverdue: number | null;
  suppressed: boolean;
}

export interface Coverage {
  scope: 'FACILITY' | 'NATIONAL';
  groupBy: 'NONE' | 'MUNICIPALITY';
  asOf: string;
  threshold: number;
  total: CoverageRow[];
  rows: CoverageRow[];
  disclaimer: string;
}

export interface MyScreening {
  programmes: {
    programme: ProgrammeCode;
    state: ProgrammeState;
    inPopulation: boolean;
    testOffered: TestType;
    nextDueDate: string | null;
    lastScreenedAt: string | null;
    lastResult: ScreeningResult | null;
    optedOut: boolean;
    openEpisode: {
      id: string;
      status: EpisodeStatus;
      invitedAt: string | null;
      bookedFor: string | null;
      screenedAt: string | null;
    } | null;
  }[];
  optOuts: { programme: ProgrammeCode; since: string }[];
  history: {
    id: string;
    programme: ProgrammeCode;
    status: EpisodeStatus;
    facilityName: string;
    invitedAt: string | null;
    bookedFor: string | null;
    screenedAt: string | null;
    testType: TestType | null;
    result: ScreeningResult | null;
    nextDueDate: string | null;
  }[];
  disclaimer: string;
}

/* ------------------------------------------------------------------------------ labels -- */

export function programmeLabel(p: ProgrammeCode): string {
  return {
    CERVICAL: t('Cervical screening'),
    BREAST: t('Breast screening'),
    COLORECTAL: t('Bowel screening'),
  }[p];
}

export function programmeAudience(p: ProgrammeCode): string {
  return {
    CERVICAL: t('Women aged 25 to 64, every 3 years (every 5 years from 50)'),
    BREAST: t('Women aged 50 to 69, every 2 years'),
    COLORECTAL: t('Women and men aged 50 to 74, every 2 years'),
  }[p];
}

export function testLabel(x: TestType): string {
  return {
    CYTOLOGY: t('Cervical cytology (Pap test)'),
    HPV: t('HPV test'),
    MAMMOGRAPHY: t('Mammography'),
    FIT: t('Stool test (FIT)'),
  }[x];
}

export function resultLabel(r: ScreeningResult): string {
  return {
    NORMAL: t('Normal|screening'),
    ABNORMAL: t('Abnormal – follow-up needed'),
    INADEQUATE: t('Sample not adequate – repeat'),
  }[r];
}

export const RESULT_TONE: Record<ScreeningResult, Tone> = {
  NORMAL: 'success',
  ABNORMAL: 'danger',
  INADEQUATE: 'warning',
};

export function episodeStatusLabel(s: EpisodeStatus): string {
  return {
    INVITED: t('Invited|screening'),
    BOOKED: t('Booked|screening'),
    SCREENED: t('Test taken, result awaited'),
    RESULTED: t('Result recorded|screening'),
    REFERRED: t('Under follow-up|screening'),
    DECLINED: t('Declined this round'),
    NOT_ELIGIBLE: t('No longer applicable'),
    CLOSED: t('Follow-up closed'),
  }[s];
}

export function stateLabel(s: ProgrammeState): string {
  return {
    NOT_IN_POPULATION: t('Not in the age group'),
    OPTED_OUT: t('Opted out|screening'),
    CEASED: t('No longer applicable'),
    FOLLOW_UP: t('Under follow-up|screening'),
    IN_PROGRESS: t('In progress|screening'),
    UP_TO_DATE: t('Up to date|screening'),
    LEFT: t('No further invitations'),
    DUE: t('Due|screening'),
  }[s];
}

export const STATE_TONE: Record<ProgrammeState, Tone> = {
  NOT_IN_POPULATION: 'neutral',
  OPTED_OUT: 'neutral',
  CEASED: 'neutral',
  FOLLOW_UP: 'danger',
  IN_PROGRESS: 'info',
  UP_TO_DATE: 'success',
  LEFT: 'neutral',
  DUE: 'warning',
};

/* ------------------------------------------------------------------------------ hooks -- */

const KEY = ['screening'] as const;

export const usePatientScreening = (patientId: string) =>
  useQuery({
    queryKey: ['patient', patientId, 'screening'],
    queryFn: () => api<PatientScreening>(`/screening/patients/${patientId}`),
  });

export const useScreeningWorklist = (query: {
  view: 'due' | 'followup' | 'all';
  programme?: ProgrammeCode;
  q?: string;
  page: number;
}) =>
  useQuery({
    queryKey: [...KEY, 'worklist', query],
    queryFn: () => api<Worklist>('/screening/worklist', { query: { ...query, pageSize: 25 } }),
  });

export const useScreeningCoverage = (query: { groupBy?: 'NONE' | 'MUNICIPALITY' }) =>
  useQuery({
    queryKey: [...KEY, 'coverage', query],
    queryFn: () => api<Coverage>('/screening/coverage', { query }),
  });

export const useMyScreening = () =>
  useQuery({ queryKey: [...KEY, 'mine'], queryFn: () => api<MyScreening>('/screening/mine') });

/** POST helper that refreshes the chart, the worklist and the portal view. */
function useScreeningMutation<V>(
  patientId: string | null,
  request: (v: V) => { path: string; body?: unknown },
  onDone?: () => void,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) => {
      const { path, body } = request(v);
      return api(path, { method: 'POST', body: body ?? {} });
    },
    onSuccess: () => {
      if (patientId) void qc.invalidateQueries({ queryKey: ['patient', patientId, 'screening'] });
      void qc.invalidateQueries({ queryKey: KEY });
      onDone?.();
    },
  });
}

export const useInvite = (patientId: string, onDone?: () => void) =>
  useScreeningMutation(
    patientId,
    (v: { programme: ProgrammeCode }) => ({
      path: `/screening/patients/${patientId}/invitations`,
      body: v,
    }),
    onDone,
  );

export const useEpisodeAction = (patientId: string, onDone?: () => void) =>
  useScreeningMutation(
    patientId,
    (v: {
      episodeId: string;
      action: 'book' | 'test' | 'result' | 'decline' | 'close' | 'referral';
      body: Record<string, unknown>;
    }) => ({ path: `/screening/episodes/${v.episodeId}/${v.action}`, body: v.body }),
    onDone,
  );

export const useCease = (patientId: string, onDone?: () => void) =>
  useScreeningMutation(
    patientId,
    (v: { programme: ProgrammeCode; reason: string }) => ({
      path: `/screening/patients/${patientId}/cease`,
      body: v,
    }),
    onDone,
  );

export const useStaffOptOut = (patientId: string, onDone?: () => void) =>
  useScreeningMutation(
    patientId,
    (v: { programme: ProgrammeCode; reason?: string; withdraw?: boolean }) =>
      v.withdraw
        ? { path: `/screening/patients/${patientId}/opt-outs/${v.programme}/withdraw` }
        : {
            path: `/screening/patients/${patientId}/opt-outs`,
            body: { programme: v.programme, reason: v.reason },
          },
    onDone,
  );

export const useMyOptOut = (onDone?: () => void) =>
  useScreeningMutation(
    null,
    (v: { programme: ProgrammeCode; reason?: string; withdraw?: boolean }) =>
      v.withdraw
        ? { path: `/screening/mine/opt-outs/${v.programme}/withdraw` }
        : { path: '/screening/mine/opt-outs', body: { programme: v.programme, reason: v.reason } },
    onDone,
  );
