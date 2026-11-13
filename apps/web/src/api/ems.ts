import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';
import type { NewsRisk } from './news';

/** API client and types for the ambulance service (emergency medical services). */

export type EmsPriority = 'P1' | 'P2' | 'P3';
export type EmsStatus =
  'RECEIVED' | 'DISPATCHED' | 'ON_SCENE' | 'TRANSPORTING' | 'HANDED_OVER' | 'CLOSED' | 'CANCELLED';
export type EmsOutcome =
  | 'TRANSPORTED'
  | 'TREATED_ON_SCENE'
  | 'REFUSED_TRANSPORT'
  | 'DECEASED_ON_SCENE'
  | 'NO_PATIENT'
  | 'CANCELLED';
export type VehicleStatus =
  'AVAILABLE' | 'DISPATCHED' | 'ON_SCENE' | 'TRANSPORTING' | 'AT_HOSPITAL' | 'OUT_OF_SERVICE';

export const P1_TARGET_MINUTES = 15;
export const ON_SCENE_OUTCOMES: EmsOutcome[] = [
  'TREATED_ON_SCENE',
  'REFUSED_TRANSPORT',
  'DECEASED_ON_SCENE',
  'NO_PATIENT',
];

export interface CallAnswers {
  conscious: boolean;
  breathingNormally: boolean;
  chestPain?: boolean;
  majorBleeding?: boolean;
  strokeSigns?: boolean;
  seriousInjury?: boolean;
  severePain?: boolean;
}

/** Same rule as the server (illustrative until the national dispatch protocol is adopted). */
export function priorityFor(a: CallAnswers): EmsPriority {
  if (!a.conscious || !a.breathingNormally || a.chestPain || a.majorBleeding || a.strokeSigns) {
    return 'P1';
  }
  if (a.seriousInjury || a.severePain) return 'P2';
  return 'P3';
}

export interface EmsPatient {
  id: string;
  firstName: string;
  lastName: string;
  nationalId: string;
  dateOfBirth: string;
  sex: string;
  temporaryIdentity: string | null;
}

export interface EmsIncident {
  id: string;
  reference: string;
  serviceUnitId: string;
  receivedAt: string;
  callerName: string | null;
  callerPhone: string | null;
  /** Null for the receiving emergency department (it sees the municipality only). */
  address: string | null;
  municipality: string | null;
  latitude: string | null;
  longitude: string | null;
  complaint: string;
  priority: EmsPriority;
  status: EmsStatus;
  patientId: string | null;
  patientDescription: string | null;
  ambulanceUnitId: string | null;
  dispatchedAt: string | null;
  onSceneAt: string | null;
  leftSceneAt: string | null;
  /** When the crew expects to arrive (set on leaving the scene). */
  expectedAt: string | null;
  atHospitalAt: string | null;
  handedOverAt: string | null;
  destinationFacilityId: string | null;
  edVisitId: string | null;
  outcome: EmsOutcome | null;
  closedAt: string | null;
  callToDispatchMinutes: number | null;
  responseMinutes: number | null;
}

export interface BoardItem extends EmsIncident {
  vehicle: string | null;
  patient: EmsPatient | null;
  elapsedMinutes: number;
}

export interface Vehicle {
  id: string;
  stationUnitId: string;
  callSign: string;
  level: 'BLS' | 'ALS';
  status: VehicleStatus;
  isActive: boolean;
}

export interface CareRecord {
  id: string;
  kind: 'OBSERVATION' | 'INTERVENTION' | 'MEDICATION' | 'NOTE';
  recordedAt: string;
  data: Record<string, unknown>;
  text: string | null;
  recordedBy: string;
}

export interface EarlyWarningSummary {
  scale: 'NEWS2' | 'PEWS';
  score: number;
  risk: NewsRisk;
  complete?: boolean;
  recordedAt?: string;
}

export interface IncidentDetail extends EmsIncident {
  /** The receiving ED sees no identity until it takes over the patient. */
  identityWithheld?: boolean;
  patient: EmsPatient | null;
  vehicle: { id: string; callSign: string; level: string } | null;
  destination: { id: string; name: string } | null;
  careRecords: CareRecord[];
  earlyWarning: EarlyWarningSummary | null;
  canAct: boolean;
}

export interface IncomingAmbulance {
  id: string;
  reference: string;
  priority: EmsPriority;
  complaint: string;
  callSign: string | null;
  level: string | null;
  leftSceneAt: string | null;
  /** When the crew expects to arrive (set on leaving the scene). */
  expectedAt: string | null;
  atHospitalAt: string | null;
  sex: string | null;
  ageBand: 'INFANT' | 'CHILD' | 'ADULT' | 'OLDER_ADULT' | null;
  earlyWarning: EarlyWarningSummary | null;
}

export interface EmsServices {
  mine: { id: string; name: string; code: string; facilityId: string }[];
  atFacility: { id: string; name: string; code: string }[];
  canSeeStats: boolean;
  canTakeHandover: boolean;
  p1TargetMinutes: number;
}

export interface EmsStats {
  from: string;
  to: string;
  smallCellThreshold: number;
  p1TargetMinutes: number;
  total: number | null;
  byPriority: {
    priority: EmsPriority;
    calls: number | null;
    medianResponseMinutes: number | null;
    p90ResponseMinutes: number | null;
    medianCallToDispatchMinutes: number | null;
  }[];
  p1WithinTargetPercent: number | null;
  byMunicipality: { municipality: string | null; calls: number | null }[];
  byMonth: { month: string; calls: number | null }[];
  byOutcome: { outcome: EmsOutcome; calls: number | null }[];
}

/* ------------------------------------------------------------------ labels -------------- */

export const priorityLabel = (p: EmsPriority) =>
  ({
    P1: t('P1 – immediately life-threatening'),
    P2: t('P2 – urgent'),
    P3: t('P3 – not urgent'),
  })[p];

export const priorityTone = (p: EmsPriority) =>
  (({ P1: 'danger', P2: 'warning', P3: 'info' }) as const)[p];

export const statusLabel = (s: EmsStatus) =>
  ({
    RECEIVED: t('Waiting for dispatch'),
    DISPATCHED: t('Dispatched'),
    ON_SCENE: t('On scene'),
    TRANSPORTING: t('Transporting'),
    HANDED_OVER: t('Handed over'),
    CLOSED: t('Closed|ambulance call'),
    CANCELLED: t('Cancelled'),
  })[s];

export const vehicleStatusLabel = (s: VehicleStatus) =>
  ({
    AVAILABLE: t('Available|vehicle'),
    DISPATCHED: t('Dispatched'),
    ON_SCENE: t('On scene'),
    TRANSPORTING: t('Transporting'),
    AT_HOSPITAL: t('At hospital'),
    OUT_OF_SERVICE: t('Out of service'),
  })[s];

export const outcomeLabel = (o: EmsOutcome) =>
  ({
    TRANSPORTED: t('Taken to hospital'),
    TREATED_ON_SCENE: t('Treated on scene'),
    REFUSED_TRANSPORT: t('Refused transport'),
    DECEASED_ON_SCENE: t('Died on scene'),
    NO_PATIENT: t('No patient found'),
    CANCELLED: t('Cancelled'),
  })[o];

export const ageBandLabel = (b: IncomingAmbulance['ageBand']) =>
  b
    ? {
        INFANT: t('Infant'),
        CHILD: t('Child'),
        ADULT: t('Adult'),
        OLDER_ADULT: t('Older adult (65+)'),
      }[b]
    : t('Age unknown');

/* ------------------------------------------------------------------ queries ------------- */

export const useEmsServices = () =>
  useQuery({ queryKey: ['ems', 'services'], queryFn: () => api<EmsServices>('/ems/services') });

export const useEmsBoard = (serviceId: string | undefined) =>
  useQuery({
    queryKey: ['ems', 'board', serviceId ?? ''],
    queryFn: () =>
      api<{
        items: BoardItem[];
        vehicles: Vehicle[];
        now: string;
        service: { id: string; name: string };
      }>('/ems/board', { query: { serviceId } }),
    enabled: Boolean(serviceId),
    refetchInterval: 15_000,
  });

export const useIncident = (id: string | null) =>
  useQuery({
    queryKey: ['ems', 'incident', id ?? ''],
    queryFn: () => api<IncidentDetail>(`/ems/incidents/${id}`),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });

/** A patient's ambulance calls, for the chart (without the caller's details). */
export const usePatientCalls = (patientId: string) =>
  useQuery({
    queryKey: ['patient', patientId, 'ambulance-calls'],
    queryFn: () => api<{ items: EmsIncident[] }>(`/ems/patients/${patientId}`).then((r) => r.items),
  });

export const useDestinations = (enabled: boolean) =>
  useQuery({
    queryKey: ['ems', 'destinations'],
    queryFn: () =>
      api<{ items: { id: string; name: string; code: string; municipality: string | null }[] }>(
        '/ems/destinations',
      ),
    enabled,
  });

export const useIncoming = (enabled: boolean) =>
  useQuery({
    queryKey: ['ems', 'incoming'],
    queryFn: () => api<{ items: IncomingAmbulance[]; canTakeHandover: boolean }>('/ems/incoming'),
    enabled,
    refetchInterval: 15_000,
    retry: false,
  });

export const useEmsStats = (enabled: boolean) =>
  useQuery({
    queryKey: ['ems', 'stats'],
    queryFn: () => api<EmsStats>('/ems/stats'),
    enabled,
  });

/** POST to an incident action; refreshes the board, the incident and the ED strip. */
export function useIncidentAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      action,
      body,
    }: {
      id: string;
      action: string;
      body?: Record<string, unknown>;
    }) =>
      api<IncidentDetail>(`/ems/incidents/${id}/${action}`, { method: 'POST', body: body ?? {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ems'] }),
  });
}

export function useCreateCall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<EmsIncident & { computedPriority: EmsPriority }>('/ems/incidents', {
        method: 'POST',
        body,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ems'] }),
  });
}

export function useVehicleStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'AVAILABLE' | 'OUT_OF_SERVICE' }) =>
      api<Vehicle>(`/ems/vehicles/${id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ems'] }),
  });
}

export function useAddVehicle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { serviceId: string; callSign: string; level: 'BLS' | 'ALS' }) =>
      api<Vehicle>('/ems/vehicles', { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ems'] }),
  });
}
