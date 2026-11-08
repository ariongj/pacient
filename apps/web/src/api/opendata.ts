import { useQuery } from '@tanstack/react-query';
import { API_BASE, api } from './client';
import type { Locale } from '../i18n';

/** API client and types for open data (public, no sign-in). */

export type Translated = Record<Locale, string>;
export type ColumnType = 'text' | 'count' | 'number' | 'percent' | 'boolean';

export interface OpenDataIndex {
  title: Translated;
  licence: { name: string; url: string; note: Translated };
  smallCellThreshold: number;
  languages: Locale[];
  formats: string[];
  datasets: {
    id: string;
    title: Translated;
    description: Translated;
    methodology: Translated;
    columns: { key: string; type: ColumnType; label: Translated }[];
  }[];
}

export type CellValue = string | number | boolean | null;
export type DataRow = Record<string, CellValue> & { suppressed: boolean };

export interface OpenDataset {
  dataset: string;
  lang: Locale;
  title: string;
  description: string;
  methodology: string;
  columns: { key: string; type: ColumnType; label: string }[];
  generatedAt: string;
  period: { from: string; to: string } | null;
  smallCellThreshold: number;
  licence: { name: string; url: string; note: string };
  rows: DataRow[];
}

export const useOpenDataIndex = () =>
  useQuery({
    queryKey: ['open-data'],
    queryFn: () => api<OpenDataIndex>('/open-data'),
    staleTime: 10 * 60_000,
  });

export const useOpenDataset = (id: string | null, lang: Locale) =>
  useQuery({
    queryKey: ['open-data', id, lang],
    queryFn: () => api<OpenDataset>(`/open-data/${id}`, { query: { lang } }),
    enabled: !!id,
    staleTime: 10 * 60_000,
  });

/** Links for downloads (served directly by the API; CSV headers in the chosen language). */
export const openDataUrl = (id: string, format: 'csv' | 'json', lang: Locale) =>
  `${API_BASE}/open-data/${id}?format=${format}&lang=${lang}`;
export const openDataIndexUrl = () => `${API_BASE}/open-data`;
