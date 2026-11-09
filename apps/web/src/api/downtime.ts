import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from './types';
import { api, downloadFile } from './client';

export interface DowntimeStatus {
  facilityId: string;
  facilityName: string;
  active: boolean;
  since: string | null;
  note: string | null;
  latestPack: { id: string; generatedAt: string; patientCount: number; sha256: string } | null;
  lastWindow: { since: string; endedAt: string } | null;
}

export interface DowntimePack {
  id: string;
  kind: 'HTML_AES' | 'HTML_AGE';
  fileName: string;
  sha256: string;
  sizeBytes: number;
  patientCount: number;
  generatedAt: string;
}

export interface BackEntryPatient {
  admissionId: string;
  patientId: string;
  firstName: string;
  lastName: string;
  nationalId: string;
  unitName: string;
  bed: string | null;
  status: string;
  administrations: number;
  administrationsBackEntered: number;
  observations: number;
}

export interface BackEntryChecklist {
  window: { since: string; endedAt: string | null; active: boolean } | null;
  patients: BackEntryPatient[];
}

/** Roles that see the downtime banner (staff attached to a facility). */
export const DOWNTIME_STATUS_ROLES: Role[] = [
  'DIRECTOR',
  'DOCTOR',
  'NURSE',
  'PHARMACIST',
  'RECEPTION',
  'LAB_TECHNICIAN',
  'IT_SUPPORT',
];

const keys = {
  status: ['downtime', 'status'] as const,
  packs: ['downtime', 'packs'] as const,
  backEntry: ['downtime', 'back-entry'] as const,
};

export function useDowntimeStatus(enabled = true) {
  return useQuery({
    queryKey: keys.status,
    queryFn: () => api<DowntimeStatus>('/downtime/status'),
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useDowntimePacks(enabled = true) {
  return useQuery({
    queryKey: keys.packs,
    queryFn: () => api<{ data: DowntimePack[]; ageEnabled: boolean }>('/downtime/packs'),
    enabled,
  });
}

export function useBackEntry(enabled = true) {
  return useQuery({
    queryKey: keys.backEntry,
    queryFn: () => api<BackEntryChecklist>('/downtime/back-entry'),
    enabled,
  });
}

function useInvalidateDowntime() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['downtime'] });
}

export function useStartDowntime() {
  const invalidate = useInvalidateDowntime();
  return useMutation({
    mutationFn: (note: string) =>
      api<DowntimeStatus>('/downtime/start', {
        method: 'POST',
        body: note ? { note } : {},
      }),
    onSuccess: invalidate,
  });
}

export function useEndDowntime() {
  const invalidate = useInvalidateDowntime();
  return useMutation({
    mutationFn: () => api<DowntimeStatus>('/downtime/end', { method: 'POST' }),
    onSuccess: invalidate,
  });
}

export function useGeneratePack() {
  const invalidate = useInvalidateDowntime();
  return useMutation({
    mutationFn: (locale?: 'sq' | 'sr' | 'en') =>
      api<{ data: DowntimePack[] }>('/downtime/packs/generate', {
        method: 'POST',
        body: locale ? { locale } : {},
      }),
    onSuccess: invalidate,
  });
}

export function downloadPack(pack: DowntimePack) {
  const stamp = pack.generatedAt.slice(0, 16).replace(/[:T]/g, '-');
  return downloadFile(`/downtime/packs/${pack.id}/download`, `downtime-pack-${stamp}.html`);
}
