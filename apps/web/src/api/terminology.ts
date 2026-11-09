import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '../i18n';
import { api, apiUpload, downloadFile } from './client';

/** API client and types for terminology (code systems, versions, concepts and mappings). */

export type SystemKind = 'EXTERNAL' | 'LOCAL';
export type VersionStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED';
export type Equivalence = 'EQUIVALENT' | 'WIDER' | 'NARROWER' | 'RELATEDTO' | 'UNMATCHED';
export const EQUIVALENCES: Equivalence[] = [
  'EQUIVALENT',
  'WIDER',
  'NARROWER',
  'RELATEDTO',
  'UNMATCHED',
];

export interface CodeSystemSummary {
  id: string;
  code: string;
  name: string;
  url: string;
  publisher: string | null;
  kind: SystemKind;
  facilityId: string | null;
  description: string | null;
  activeVersion: { id: string; version: string; conceptCount: number } | null;
  drafts: number;
  canManage: boolean;
  updatedAt: string;
}

export interface SystemVersion {
  id: string;
  version: string;
  status: VersionStatus;
  conceptCount: number;
  notes: string | null;
  importedAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
}

export interface CodeSystemDetail extends CodeSystemSummary {
  versions: SystemVersion[];
}

export interface Concept {
  code: string;
  display: string;
  displaySq: string | null;
  displaySr: string | null;
  parentCode: string | null;
  active: boolean;
  properties: Record<string, unknown> | null;
}

export interface ConceptPage {
  version: { id: string; version: string; status: VersionStatus };
  items: Concept[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ConceptDetail {
  system: { id: string; code: string; url: string; name: string };
  version: { id: string; version: string; status: VersionStatus };
  concept: Concept;
  parent: Concept | null;
  children: { code: string; display: string; active: boolean }[];
  mappings: {
    mapId: string;
    map: string;
    name: string;
    direction: 'SOURCE' | 'TARGET';
    entries: {
      sourceCode: string;
      targetCode: string | null;
      equivalence: Equivalence;
      comment: string | null;
    }[];
  }[];
}

export interface DiffCounts {
  added: number;
  removed: number;
  displayChanged: number;
  inactivated: number;
  reactivated: number;
  parentChanged: number;
  unchanged: number;
}

export interface ConceptDiff {
  against: { versionId: string; version: string } | null;
  counts: DiffCounts;
  added: { code: string; display: string }[];
  removed: { code: string; display: string }[];
  displayChanged: {
    code: string;
    field: 'display' | 'displaySq' | 'displaySr';
    before: string | null;
    after: string | null;
  }[];
  inactivated: { code: string; display: string }[];
  reactivated: { code: string; display: string }[];
  parentChanged: { code: string; before: string | null; after: string | null }[];
  truncated: boolean;
}

export interface MapVersion {
  id: string;
  version: string;
  status: VersionStatus;
  entryCount: number;
  notes: string | null;
  importedAt: string;
  activatedAt: string | null;
}

export interface ConceptMapSummary {
  id: string;
  code: string;
  name: string;
  url: string;
  source: { id: string; code: string; name: string };
  target: { id: string; code: string; name: string };
  activeVersion: { id: string; version: string; entryCount: number } | null;
  versions: MapVersion[];
  canManage: boolean;
}

export interface MapEntry {
  sourceCode: string;
  sourceDisplay: string | null;
  targetCode: string | null;
  targetDisplay: string | null;
  equivalence: Equivalence;
  comment: string | null;
}

export interface MapImportReport {
  entryCount: number;
  byEquivalence: Record<Equivalence, number>;
  unmappedSourceCodes: { count: number; codes: string[] };
  warnings: { path: string; message: string }[];
  sourceVersion: string;
  targetVersion: string;
}

/* ------------------------------------------------------------------------------ labels -- */

export const statusLabel = (s: VersionStatus) =>
  ({ DRAFT: t('Draft|version'), ACTIVE: t('Active|version'), RETIRED: t('Retired|version') })[s];

export const statusTone = (s: VersionStatus) =>
  (({ DRAFT: 'warning', ACTIVE: 'success', RETIRED: 'neutral' }) as const)[s];

export const kindLabel = (k: SystemKind) =>
  k === 'EXTERNAL' ? t('National / international') : t('Local (facility)');

export const equivalenceLabel = (e: Equivalence) =>
  ({
    EQUIVALENT: t('Equivalent'),
    WIDER: t('Target is wider'),
    NARROWER: t('Target is narrower'),
    RELATEDTO: t('Related'),
    UNMATCHED: t('No match'),
  })[e];

export const fieldLabel = (f: 'display' | 'displaySq' | 'displaySr') =>
  ({
    display: t('Display (English)'),
    displaySq: t('Display (Albanian)'),
    displaySr: t('Display (Serbian)'),
  })[f];

/* ------------------------------------------------------------------------------- hooks -- */

const KEY = ['terminology'] as const;

export function useCodeSystems() {
  return useQuery({
    queryKey: [...KEY, 'systems'],
    queryFn: () => api<{ items: CodeSystemSummary[] }>('/terminology/systems').then((r) => r.items),
  });
}

export function useCodeSystem(id: string | null) {
  return useQuery({
    queryKey: [...KEY, 'system', id],
    queryFn: () => api<CodeSystemDetail>(`/terminology/systems/${id}`),
    enabled: Boolean(id),
  });
}

export function useConcepts(
  systemId: string | null,
  query: { q?: string; versionId?: string; page: number; activeOnly?: boolean },
) {
  return useQuery({
    queryKey: [...KEY, 'concepts', systemId, query],
    queryFn: () =>
      api<ConceptPage>(`/terminology/systems/${systemId}/concepts`, {
        query: {
          q: query.q || undefined,
          versionId: query.versionId,
          page: query.page,
          pageSize: 25,
          activeOnly: query.activeOnly ? 'true' : undefined,
        },
      }),
    enabled: Boolean(systemId),
    placeholderData: keepPreviousData,
  });
}

export function useConcept(systemId: string | null, code: string | null, versionId?: string) {
  return useQuery({
    queryKey: [...KEY, 'concept', systemId, code, versionId],
    queryFn: () =>
      api<ConceptDetail>(`/terminology/systems/${systemId}/concept`, {
        query: { code: code!, versionId },
      }),
    enabled: Boolean(systemId && code),
  });
}

export function useVersionDiff(versionId: string | null) {
  return useQuery({
    queryKey: [...KEY, 'diff', versionId],
    queryFn: () =>
      api<ConceptDiff & { version: { id: string; version: string; status: VersionStatus } }>(
        `/terminology/versions/${versionId}/diff`,
      ),
    enabled: Boolean(versionId),
  });
}

export function useConceptMaps() {
  return useQuery({
    queryKey: [...KEY, 'maps'],
    queryFn: () => api<{ items: ConceptMapSummary[] }>('/terminology/maps').then((r) => r.items),
  });
}

export function useMapEntries(
  mapId: string | null,
  query: { q?: string; versionId?: string; equivalence?: string; page: number },
) {
  return useQuery({
    queryKey: [...KEY, 'entries', mapId, query],
    queryFn: () =>
      api<{
        version: { id: string; version: string; status: VersionStatus };
        items: MapEntry[];
        page: number;
        totalPages: number;
        total: number;
      }>(`/terminology/maps/${mapId}/entries`, {
        query: {
          q: query.q || undefined,
          versionId: query.versionId,
          equivalence: query.equivalence || undefined,
          page: query.page,
          pageSize: 25,
        },
      }),
    enabled: Boolean(mapId),
    placeholderData: keepPreviousData,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: KEY });
}

export function useCreateSystem() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<CodeSystemSummary>('/terminology/systems', { method: 'POST', body }),
    onSuccess: done,
  });
}

export function useCreateMap() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<ConceptMapSummary>('/terminology/maps', { method: 'POST', body }),
    onSuccess: done,
  });
}

/** Upload a CSV as a new draft version (or only check it, with dryRun). */
export function useImportVersion(kind: 'system' | 'map') {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      file,
      version,
      notes,
      dryRun,
    }: {
      id: string;
      file: File;
      version: string;
      notes?: string;
      dryRun?: boolean;
    }) =>
      apiUpload<
        { dryRun?: boolean; id?: string; version?: string } & Partial<MapImportReport> & {
            conceptCount?: number;
            diff?: ConceptDiff;
          }
      >(
        `/terminology/${kind === 'system' ? 'systems' : 'maps'}/${id}/versions`,
        new Blob([file], { type: 'text/csv' }),
        file.name,
        { version, notes: notes || undefined, dryRun: dryRun ? 'true' : undefined },
      ),
    onSuccess: (r) => {
      if (!r.dryRun) done();
    },
  });
}

export function useVersionAction(kind: 'system' | 'map') {
  const done = useInvalidate();
  const base = kind === 'system' ? '/terminology/versions' : '/terminology/map-versions';
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'activate' | 'discard' }) =>
      action === 'activate'
        ? api(`${base}/${id}/activate`, { method: 'POST' })
        : api(`${base}/${id}`, { method: 'DELETE' }),
    onSuccess: done,
  });
}

export const exportVersion = (kind: 'system' | 'map', id: string, filename: string) =>
  downloadFile(
    kind === 'system'
      ? `/terminology/versions/${id}/export`
      : `/terminology/map-versions/${id}/export`,
    filename,
  );
