import { useQuery } from '@tanstack/react-query';
import { api } from './client';
import type { AppointmentWithChannel } from './scheduling';

/** Video visits: the room opens 15 minutes before and stays open until 2 hours after the start. */
export const JOIN_OPENS_BEFORE_MS = 15 * 60_000;
export const JOIN_CLOSES_AFTER_MS = 2 * 3_600_000;

export type AppointmentMode = 'IN_PERSON' | 'VIDEO';
export type AppointmentWithMode = AppointmentWithChannel & { mode?: AppointmentMode };

export type Side = 'doctor' | 'patient';
export type SignalKind = 'ready' | 'offer' | 'answer' | 'candidate' | 'bye';

export interface VideoInfo {
  appointment: {
    id: string;
    scheduledAt: string;
    durationMinutes: number;
    mode: AppointmentMode;
    status: string;
    doctorName: string;
    patientName: string;
    patientId?: string;
  };
  side: Side;
  window: { opensAt: string; closesAt: string; open: boolean };
  session: { id: string; status: 'WAITING' | 'ACTIVE' | 'ENDED' } | null;
}

export interface JoinResult {
  sessionId: string;
  role: Side;
  status: 'WAITING' | 'ACTIVE' | 'ENDED';
  peerPresent: boolean;
  iceServers: RTCIceServer[];
}

export interface SignalMessage {
  id: number;
  from: Side;
  kind: SignalKind;
  payload: unknown;
}

export interface WaitingPatient {
  sessionId: string;
  appointmentId: string;
  scheduledAt: string;
  patientName: string;
  doctorPresent: boolean;
}

/** Whether "Join video visit" should be offered for this appointment now. */
export function canJoinNow(
  a: { mode?: string; status: string; scheduledAt: string },
  now = Date.now(),
) {
  if (a.mode !== 'VIDEO' || (a.status !== 'CONFIRMED' && a.status !== 'CHECKED_IN')) return false;
  const start = new Date(a.scheduledAt).getTime();
  return now >= start - JOIN_OPENS_BEFORE_MS && now <= start + JOIN_CLOSES_AFTER_MS;
}

export const videoInfo = (appointmentId: string) =>
  api<VideoInfo>(`/video/appointments/${appointmentId}`);
export const joinVideo = (appointmentId: string) =>
  api<JoinResult>(`/video/appointments/${appointmentId}/join`, { method: 'POST' });
export const sendSignal = (sessionId: string, kind: SignalKind, payload?: unknown) =>
  api<{ id: number }>(`/video/sessions/${sessionId}/signal`, {
    method: 'POST',
    body: { kind, payload },
  });
export const fetchSignals = (sessionId: string, after: number) =>
  api<{ items: SignalMessage[]; status: string; peerPresent: boolean }>(
    `/video/sessions/${sessionId}/signals`,
    { query: { after } },
  );
export const endVideo = (sessionId: string) =>
  api<{ status: 'ENDED'; chartPath?: string }>(`/video/sessions/${sessionId}/end`, {
    method: 'POST',
  });
export const setAppointmentMode = (appointmentId: string, mode: AppointmentMode) =>
  api(`/appointments/${appointmentId}/mode`, { method: 'PATCH', body: { mode } });

/** Doctor: patients currently in a waiting room. Refreshes on live video events. */
export function useWaitingPatients(enabled = true) {
  return useQuery({
    queryKey: ['video', 'waiting'],
    queryFn: () => api<{ items: WaitingPatient[] }>('/video/waiting').then((r) => r.items),
    enabled,
    refetchInterval: 15_000,
  });
}
