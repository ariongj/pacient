import { HttpError } from '../../lib/errors.js';
import type { ImageSeries, RenderedImage, WindowSetting } from './types.js';

/**
 * Minimal DICOMweb client (QIDO-RS for search, WADO-RS /rendered for display images). The PACS
 * is only ever called from the API, so its address and credentials never reach a browser.
 */
export interface DicomWebConfig {
  baseUrl: string;
  authHeader?: string;
  timeoutMs: number;
}

/** 502 with a clear message whenever the archive cannot be reached or answers with an error. */
export const pacsUnavailable = (detail?: string) =>
  new HttpError(
    502,
    'PACS_UNAVAILABLE',
    'The image archive (PACS) is not reachable at the moment. Try again later.',
    detail ? { detail } : undefined,
  );

type DicomJson = Record<string, { vr?: string; Value?: unknown[] }>;
const tag = (o: DicomJson, t: string): unknown => o[t]?.Value?.[0];
const str = (o: DicomJson, t: string) => {
  const v = tag(o, t);
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
};
const num = (o: DicomJson, t: string) => Number(tag(o, t) ?? 0) || 0;

const UID = /^[0-9]+(\.[0-9]+)*$/;
export const isUid = (v: string) => v.length <= 64 && UID.test(v);

export class DicomWebClient {
  constructor(private readonly cfg: DicomWebConfig) {}

  private async request(path: string, accept: string): Promise<Response> {
    const url = `${this.cfg.baseUrl.replace(/\/$/, '')}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Accept: accept,
          ...(this.cfg.authHeader ? { Authorization: this.cfg.authHeader } : {}),
        },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err) {
      throw pacsUnavailable(err instanceof Error ? err.name : undefined);
    }
    if (res.status === 204) return res;
    if (res.status === 404) throw new HttpError(404, 'NOT_FOUND', 'Images not found in the PACS');
    if (!res.ok) throw pacsUnavailable(`HTTP ${res.status}`);
    return res;
  }

  private async json(path: string): Promise<DicomJson[]> {
    const res = await this.request(path, 'application/dicom+json');
    if (res.status === 204) return [];
    const text = await res.text();
    if (!text.trim()) return [];
    try {
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? (parsed as DicomJson[]) : [];
    } catch {
      throw pacsUnavailable('Invalid DICOM JSON');
    }
  }

  /** Study Instance UIDs for an accession number (newest first if the PACS sorts). */
  async findStudiesByAccession(accessionNumber: string): Promise<string[]> {
    const rows = await this.json(
      `/studies?AccessionNumber=${encodeURIComponent(accessionNumber)}&includefield=0020000D`,
    );
    return rows.map((r) => str(r, '0020000D')).filter(isUid);
  }

  async studyExists(studyUid: string): Promise<boolean> {
    const rows = await this.json(`/studies?StudyInstanceUID=${encodeURIComponent(studyUid)}`);
    return rows.length > 0;
  }

  async listSeries(studyUid: string): Promise<ImageSeries[]> {
    const series = await this.json(`/studies/${studyUid}/series`);
    const out: ImageSeries[] = [];
    for (const s of series) {
      const uid = str(s, '0020000E');
      if (!isUid(uid)) continue;
      const instances = await this.json(`/studies/${studyUid}/series/${uid}/instances`);
      out.push({
        uid,
        number: num(s, '00200011'),
        description: str(s, '0008103E'),
        modality: str(s, '00080060'),
        instances: instances
          .map((i) => ({ uid: str(i, '00080018'), number: num(i, '00200013') }))
          .filter((i) => isUid(i.uid))
          .sort((a, b) => a.number - b.number),
      });
    }
    return out.sort((a, b) => a.number - b.number);
  }

  async rendered(
    studyUid: string,
    seriesUid: string,
    instanceUid: string,
    window?: WindowSetting,
  ): Promise<RenderedImage> {
    // DICOM PS3.18: window=<center>,<width>,<function>
    const q = window ? `?window=${window.level},${window.width},linear` : '';
    const res = await this.request(
      `/studies/${studyUid}/series/${seriesUid}/instances/${instanceUid}/rendered${q}`,
      'image/png, image/jpeg;q=0.9',
    );
    const contentType = res.headers.get('content-type')?.split(';')[0]?.trim() ?? 'image/jpeg';
    if (!/^image\/(png|jpeg)$/.test(contentType)) throw pacsUnavailable('Unexpected image type');
    return { contentType, body: Buffer.from(await res.arrayBuffer()) };
  }
}
