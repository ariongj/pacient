import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { demoSeries, demoStudyUid, renderDemoImage, windowPresets } from './demo.js';
import { DicomWebClient, isUid } from './dicomweb.js';
import type { ImageSeries, RenderedImage, WindowSetting } from './types.js';

export type { ImageSeries, RenderedImage, WindowSetting } from './types.js';
export { isUid, pacsUnavailable } from './dicomweb.js';
export { demoStudyUid, windowPresets } from './demo.js';

export interface PacsConfig {
  mode: 'off' | 'demo' | 'dicomweb';
  baseUrl?: string;
  authHeader?: string;
  timeoutMs: number;
}

let config: PacsConfig = {
  mode: env.PACS_MODE,
  baseUrl: env.PACS_DICOMWEB_URL,
  authHeader: env.PACS_AUTH_HEADER,
  timeoutMs: env.PACS_TIMEOUT_MS,
};

export const pacsConfig = () => config;
/** Tests switch between demo and a fake DICOMweb server. */
export function setPacsConfigForTests(next: Partial<PacsConfig>) {
  config = { ...config, ...next };
  seriesCache.clear();
  imageCache.clear();
}

const client = () => {
  if (config.mode !== 'dicomweb' || !config.baseUrl) throw pacsOff();
  return new DicomWebClient({
    baseUrl: config.baseUrl,
    authHeader: config.authHeader,
    timeoutMs: config.timeoutMs,
  });
};

const pacsOff = () =>
  new HttpError(503, 'PACS_OFF', 'No image archive (PACS) is connected to this system');

export interface StudyRef {
  studyInstanceUid: string;
  accessionNumber: string;
  modality: string;
  bodyPart: string;
}

/* Small in-memory caches: series lists for 5 minutes, rendered images (bounded LRU). */
const seriesCache = new Map<string, { at: number; series: ImageSeries[] }>();
const imageCache = new Map<string, RenderedImage>();
const IMAGE_CACHE_MAX = 300;

export async function findStudyByAccession(accessionNumber: string): Promise<string | null> {
  if (config.mode === 'demo') return demoStudyUid(accessionNumber);
  const uids = await client().findStudiesByAccession(accessionNumber);
  return uids[0] ?? null;
}

export async function studyExists(studyUid: string): Promise<boolean> {
  if (config.mode === 'demo') return true;
  return client().studyExists(studyUid);
}

export async function listSeries(study: StudyRef): Promise<ImageSeries[]> {
  if (config.mode === 'off') throw pacsOff();
  const cached = seriesCache.get(study.studyInstanceUid);
  if (cached && cached.at > Date.now() - 5 * 60_000) return cached.series;
  const series =
    config.mode === 'demo'
      ? demoSeries(study.studyInstanceUid, study.modality, study.bodyPart)
      : await client().listSeries(study.studyInstanceUid);
  seriesCache.set(study.studyInstanceUid, { at: Date.now(), series });
  if (seriesCache.size > 500) seriesCache.clear();
  return series;
}

/** Renders one image of the study; series and instance must belong to it. */
export async function renderImage(
  study: StudyRef,
  seriesUid: string,
  instanceUid: string,
  window?: WindowSetting,
): Promise<RenderedImage> {
  if (!isUid(seriesUid) || !isUid(instanceUid)) {
    throw new HttpError(400, 'BAD_REQUEST', 'Invalid image identifier');
  }
  const series = await listSeries(study);
  const sIndex = series.findIndex((s) => s.uid === seriesUid);
  const s = series[sIndex];
  const iIndex = s ? s.instances.findIndex((i) => i.uid === instanceUid) : -1;
  if (!s || iIndex < 0) throw new HttpError(404, 'NOT_FOUND', 'Image not found in this study');

  const effective = window ?? windowPresets(study.modality)[0]!.window;
  const key = `${config.mode}|${instanceUid}|${effective.width}|${effective.level}`;
  const hit = imageCache.get(key);
  if (hit) {
    imageCache.delete(key);
    imageCache.set(key, hit);
    return hit;
  }
  const image: RenderedImage =
    config.mode === 'demo'
      ? {
          contentType: 'image/png',
          body: renderDemoImage({
            studyUid: study.studyInstanceUid,
            modality: study.modality,
            bodyPart: study.bodyPart,
            seriesIndex: sIndex,
            instanceIndex: iIndex,
            instanceCount: s.instances.length,
            seriesDescription: s.description,
            window: effective,
          }),
        }
      : await client().rendered(study.studyInstanceUid, seriesUid, instanceUid, window);
  imageCache.set(key, image);
  if (imageCache.size > IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value!);
  return image;
}
