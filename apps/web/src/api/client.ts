/**
 * Minimal API client.
 *
 * - The access token lives only in memory (never localStorage), so XSS cannot read a persisted token.
 * - The refresh token is an httpOnly cookie scoped to /api/v1/auth; the browser sends it automatically.
 * - On a 401 the client refreshes once (single-flight, so parallel requests share one refresh) and
 *   retries. Concurrent refreshes would otherwise trip the server's token-reuse detection.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
/** When a guardian acts for a child, every request carries the child's patient id. */
let actingFor: string | null = null;

export function setActingFor(patientId: string | null) {
  actingFor = patientId;
}
let refreshInFlight: Promise<boolean> | null = null;
let onSessionExpired: (() => void) | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}
export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler;
}

export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) {
        accessToken = null;
        return false;
      }
      accessToken = ((await res.json()) as { accessToken: string }).accessToken;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Query;
}

function buildUrl(path: string, query?: Query) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

async function send(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (actingFor) headers['X-Acting-For'] = actingFor;
  return fetch(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

export async function apiRaw(path: string, opts: RequestOptions = {}): Promise<Response> {
  let res = await send(path, opts);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) {
      res = await send(path, opts);
    } else {
      onSessionExpired?.();
    }
  }
  if (!res.ok) {
    let payload: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(
      res.status,
      payload.error?.code ?? 'ERROR',
      payload.error?.message ?? `Request failed (${res.status})`,
      payload.error?.details,
    );
  }
  return res;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiRaw(path, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Download an authenticated response as a file (record export, CSV reports). */
export async function downloadFile(path: string, filename: string, query?: Query) {
  const res = await apiRaw(path, { query });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** @deprecated use downloadFile */
export const downloadJson = (path: string, filename: string) => downloadFile(path, filename);

/**
 * Upload a file as the raw request body (documents). Same authentication, refresh and guardian
 * handling as `api()`; metadata goes in the query string and the file name in X-File-Name.
 */
export async function apiUpload<T>(path: string, file: Blob, fileName: string, query?: Query) {
  const sendFile = () => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': file.type,
      'X-File-Name': encodeURIComponent(fileName),
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    if (actingFor) headers['X-Acting-For'] = actingFor;
    return fetch(buildUrl(path, query), {
      method: 'POST',
      headers,
      credentials: 'include',
      body: file,
    });
  };
  let res = await sendFile();
  if (res.status === 401) {
    if (await refreshSession()) res = await sendFile();
    else onSessionExpired?.();
  }
  if (!res.ok) {
    let payload: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(
      res.status,
      payload.error?.code ?? 'ERROR',
      payload.error?.message ??
        (res.status === 413
          ? 'The file is too large (maximum 10 MB)'
          : `Upload failed (${res.status})`),
      payload.error?.details,
    );
  }
  return (await res.json()) as T;
}
