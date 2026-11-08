import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api } from './client';
import type { Tone } from '../components/ui';

/** API client and types for the medical equipment register. */

export type EquipmentCategory =
  | 'VENTILATOR'
  | 'MONITOR'
  | 'DEFIBRILLATOR'
  | 'INFUSION_PUMP'
  | 'IMAGING'
  | 'LAB_ANALYSER'
  | 'DIALYSIS'
  | 'OTHER';
export type Criticality = 'HIGH' | 'MEDIUM' | 'LOW';
export type EquipmentStatus = 'IN_SERVICE' | 'OUT_OF_SERVICE' | 'IN_MAINTENANCE' | 'RETIRED';
export type EventKind = 'SERVICE' | 'FAULT' | 'REPAIR' | 'STATUS';
export type MaintenanceState = 'OVERDUE' | 'DUE_SOON' | 'OK' | 'NONE';

export interface EquipmentMeta {
  categories: EquipmentCategory[];
  criticalities: Criticality[];
  statuses: EquipmentStatus[];
  eventKinds: EventKind[];
  criticalCategories: EquipmentCategory[];
  csvColumns: string[];
  dueSoonDays: number;
  units: { id: string; name: string; code: string; type: string }[];
  canManage: boolean;
  canReportFault: boolean;
  isMinistry: boolean;
}

export interface EquipmentItem {
  id: string;
  assetTag: string;
  category: EquipmentCategory;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  criticality: Criticality;
  status: EquipmentStatus;
  unitId: string | null;
  unitName: string | null;
  serviceIntervalDays: number | null;
  lastServiceAt: string | null;
  nextServiceDue: string | null;
  commissionedOn: string | null;
  maintenance: MaintenanceState;
  updatedAt: string;
}

export interface EquipmentEvent {
  id: string;
  kind: EventKind;
  occurredAt: string;
  description: string;
  status: EquipmentStatus | null;
  recordedBy: string;
  incidentId: string | null;
  incidentReference: string | null;
  createdAt: string;
}

export interface EquipmentDetail extends EquipmentItem {
  events: EquipmentEvent[];
}

export interface EquipmentList {
  items: EquipmentItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface MaintenanceLists {
  today: string;
  dueSoonDays: number;
  overdue: EquipmentItem[];
  dueSoon: EquipmentItem[];
  outOfService: EquipmentItem[];
}

export interface Availability {
  criticalCategories: EquipmentCategory[];
  units: {
    unitId: string | null;
    unitName: string | null;
    categories: Partial<
      Record<EquipmentCategory, { total: number; inService: number; overdue: number }>
    >;
  }[];
  totals: {
    total: number;
    inService: number;
    outOfService: number;
    overdue: number;
    dueSoon: number;
  };
}

export interface NationalEquipment {
  categories: EquipmentCategory[];
  byFacility: {
    facilityId: string;
    facility: string;
    code: string;
    municipality: string;
    categories: Partial<Record<EquipmentCategory, { total: number; inService: number }>>;
  }[];
  byMunicipality: {
    municipality: string;
    categories: Partial<Record<EquipmentCategory, { total: number; inService: number }>>;
  }[];
  maintenance: {
    facilityId: string;
    facility: string;
    municipality: string;
    total: number;
    overdue: number;
    outOfService: number;
    overduePct: number | null;
  }[];
  overduePct: number | null;
  faultsByMonth: { month: string; count: number }[];
}

export interface ImportResult {
  dryRun: boolean;
  applied: boolean;
  total: number;
  valid: number;
  toCreate: number;
  toUpdate: number;
  errors: { line: number; message: string }[];
}

export interface ItemInput {
  assetTag?: string;
  category?: EquipmentCategory;
  name?: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  unitId?: string | null;
  criticality?: Criticality;
  serviceIntervalDays?: number | null;
  commissionedOn?: string | null;
  lastServiceAt?: string | null;
}

export interface EventInput {
  kind: EventKind;
  description: string;
  occurredAt?: string;
  status?: Exclude<EquipmentStatus, 'RETIRED'>;
  incidentReference?: string;
}

export interface ListFilters {
  unitId?: string;
  category?: string;
  status?: string;
  maintenance?: string;
  q?: string;
  page?: number;
}

/* ------------------------------------------------------------------------------ labels ---- */

export const categoryLabel = (c: string): string =>
  ({
    VENTILATOR: t('Ventilator|equipment'),
    MONITOR: t('Patient monitor|equipment'),
    DEFIBRILLATOR: t('Defibrillator|equipment'),
    INFUSION_PUMP: t('Infusion pump|equipment'),
    IMAGING: t('Imaging equipment'),
    LAB_ANALYSER: t('Laboratory analyser'),
    DIALYSIS: t('Dialysis machine|equipment'),
    OTHER: t('Other equipment'),
  })[c] ?? c;

export const criticalityLabel = (c: string): string =>
  ({
    HIGH: t('High (life support)'),
    MEDIUM: t('Medium|criticality'),
    LOW: t('Low|criticality'),
  })[c] ?? c;

export const equipmentStatusLabel = (s: string): string =>
  ({
    IN_SERVICE: t('In service|equipment'),
    OUT_OF_SERVICE: t('Out of service|equipment'),
    IN_MAINTENANCE: t('In maintenance|equipment'),
    RETIRED: t('Retired|equipment'),
  })[s] ?? s;

export const equipmentStatusTone = (s: string): Tone =>
  s === 'IN_SERVICE'
    ? 'success'
    : s === 'OUT_OF_SERVICE'
      ? 'danger'
      : s === 'IN_MAINTENANCE'
        ? 'warning'
        : 'neutral';

export const maintenanceLabel = (m: MaintenanceState): string =>
  ({
    OVERDUE: t('Service overdue'),
    DUE_SOON: t('Service due soon'),
    OK: t('Service up to date'),
    NONE: t('No service schedule'),
  })[m];

export const maintenanceTone = (m: MaintenanceState): Tone =>
  m === 'OVERDUE' ? 'danger' : m === 'DUE_SOON' ? 'warning' : m === 'OK' ? 'success' : 'neutral';

export const eventKindLabel = (k: string): string =>
  ({
    SERVICE: t('Service|equipment'),
    FAULT: t('Fault|equipment'),
    REPAIR: t('Repair|equipment'),
    STATUS: t('Status change|equipment'),
  })[k] ?? k;

/* ------------------------------------------------------------------------------- hooks ---- */

export const useEquipmentMeta = () =>
  useQuery({
    queryKey: ['equipment', 'meta'],
    queryFn: () => api<EquipmentMeta>('/equipment/meta'),
    staleTime: 5 * 60_000,
  });

export const useEquipmentList = (filters: ListFilters, enabled = true) =>
  useQuery({
    queryKey: ['equipment', 'items', filters],
    queryFn: () =>
      api<EquipmentList>('/equipment/items', {
        query: { ...filters, pageSize: 50 } as Record<string, string | number | undefined>,
      }),
    enabled,
  });

export const useEquipmentItem = (id: string | null) =>
  useQuery({
    queryKey: ['equipment', 'item', id],
    queryFn: () => api<EquipmentDetail>(`/equipment/items/${id}`),
    enabled: Boolean(id),
  });

export const useMaintenance = (unitId?: string, enabled = true) =>
  useQuery({
    queryKey: ['equipment', 'maintenance', unitId ?? 'all'],
    queryFn: () => api<MaintenanceLists>('/equipment/maintenance', { query: { unitId } }),
    enabled,
  });

export const useAvailability = (enabled = true) =>
  useQuery({
    queryKey: ['equipment', 'availability'],
    queryFn: () => api<Availability>('/equipment/availability'),
    enabled,
  });

export const useNationalEquipment = (enabled = true) =>
  useQuery({
    queryKey: ['equipment', 'national'],
    queryFn: () => api<NationalEquipment>('/equipment/national'),
    enabled,
  });

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ['equipment'] });
}

export function useSaveEquipment() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: ItemInput }) =>
      id
        ? api<EquipmentItem>(`/equipment/items/${id}`, { method: 'PATCH', body })
        : api<EquipmentItem>('/equipment/items', { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useRetireEquipment() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<EquipmentItem>(`/equipment/items/${id}/retire`, { method: 'POST', body: { reason } }),
    onSuccess: done,
  });
}

export function useRecordEquipmentEvent() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: EventInput }) =>
      api<{ event: EquipmentEvent; item: EquipmentItem }>(`/equipment/items/${id}/events`, {
        method: 'POST',
        body,
      }),
    onSuccess: done,
  });
}

export function useImportEquipment() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (body: { csv: string; dryRun: boolean }) =>
      api<ImportResult>('/equipment/import', { method: 'POST', body }),
    onSuccess: (r) => {
      if (r.applied) done();
    },
  });
}
