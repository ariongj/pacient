import { useQuery } from '@tanstack/react-query';
import { api, apiRaw } from './client';
import { t } from '../i18n';

export interface WindowSetting {
  width: number;
  level: number;
}

export interface ImageSeries {
  uid: string;
  number: number;
  description: string;
  modality: string;
  instances: { uid: string; number: number }[];
}

export interface StudyImages {
  order: {
    id: string;
    patientId: string;
    accessionNumber: string;
    modality: string;
    bodyPart: string;
    status: string;
    performedAt: string | null;
    reportedAt: string | null;
    impression: string | null;
    critical?: boolean;
  };
  patient: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    sex: string;
    temporaryIdentity: string | null;
  } | null;
  mode: 'off' | 'demo' | 'dicomweb';
  presets: { key: string; window: WindowSetting }[];
  series: ImageSeries[];
}

/** Whether an order (or report) has images to view. */
export const hasImages = (o: object) =>
  Boolean((o as { imagesAvailableAt?: string | null }).imagesAvailableAt);

export const viewerPath = (orderId: string) => `/imaging/viewer/${orderId}`;

export function useStudyImages(orderId: string) {
  return useQuery({
    queryKey: ['imaging', 'images', orderId],
    queryFn: () => api<StudyImages>(`/imaging/orders/${orderId}/images`),
    staleTime: 5 * 60_000,
  });
}

export function presetLabel(key: string): string {
  switch (key) {
    case 'soft-tissue':
      return t('Soft tissue');
    case 'lung':
      return t('Lung');
    case 'bone':
      return t('Bone');
    case 'brain':
      return t('Brain');
    case 'high-contrast':
      return t('High contrast');
    default:
      return t('Default');
  }
}

/*
 * Images are fetched with the session token (an <img src> cannot send it) and kept as object
 * URLs in a small cache, so scrolling back and forth through a stack is instant.
 */
const urlCache = new Map<string, Promise<string>>();
const CACHE_MAX = 160;

export function imageUrl(
  orderId: string,
  seriesUid: string,
  instanceUid: string,
  window?: WindowSetting,
): Promise<string> {
  const query = window ? `?window=${window.width}&level=${window.level}` : '';
  const path = `/imaging/orders/${orderId}/images/${seriesUid}/${instanceUid}/rendered${query}`;
  const cached = urlCache.get(path);
  if (cached) {
    urlCache.delete(path);
    urlCache.set(path, cached);
    return cached;
  }
  const p = apiRaw(path)
    .then((res) => res.blob())
    .then((blob) => URL.createObjectURL(blob));
  p.catch(() => urlCache.delete(path));
  urlCache.set(path, p);
  if (urlCache.size > CACHE_MAX) {
    const [oldest, url] = urlCache.entries().next().value as [string, Promise<string>];
    urlCache.delete(oldest);
    void url.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  }
  return p;
}

/** Releases every cached image (e.g. when leaving the viewer). */
export function clearImageCache() {
  for (const p of urlCache.values()) void p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
  urlCache.clear();
}
