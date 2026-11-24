import { t } from '../i18n';
/**
 * Minimal API client.
 *
 * - The access token lives only in memory (never localStorage), so XSS cannot read a persisted token.
 * - The refresh token is an httpOnly cookie scoped to /api/v1/auth; the browser sends it automatically.
 * - On a 401 the client refreshes once (single-flight, so parallel requests share one refresh) and
 *   retries. Concurrent refreshes would otherwise trip the server's token-reuse detection.
 * - A 401 with code REAUTH_REQUIRED (a sensitive action needs the password again) opens the
 *   shared ReauthDialog instead; the request is sent once more with the password in the
 *   X-Reauth-Password header, which is never stored.
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

/** Header that carries the password, once, for an action the server wants re-confirmed. */
export const REAUTH_HEADER = 'X-Reauth-Password';

/**
 * What the shared ReauthDialog does when the server answers 401 REAUTH_REQUIRED: ask for the
 * password, call `retry(password)` (the same request once more, with the password), and resolve
 * with the response to use. Cancelling resolves with `refused`, the original answer, so the
 * caller sees REAUTH_REQUIRED as an ordinary error.
 */
export type ReauthHandler = (request: {
  retry: (password: string) => Promise<Response>;
  refused: Response;
}) => Promise<Response>;
let reauthHandler: ReauthHandler | null = null;

/** Registered by the ReauthDialog (mounted once in App); null when it unmounts. */
export function setReauthHandler(handler: ReauthHandler | null) {
  reauthHandler = handler;
}

/** The error code of a failed response, without consuming its body. */
export async function errorCodeOf(res: Response): Promise<string | undefined> {
  try {
    return ((await res.clone().json()) as { error?: { code?: string } }).error?.code;
  } catch {
    return undefined;
  }
}

const needsReauth = async (res: Response) =>
  res.status === 401 && (await errorCodeOf(res)) === 'REAUTH_REQUIRED';

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
  /**
   * Give up after this many milliseconds – one deadline for the whole request: the first attempt,
   * a session refresh after a 401, the retry and the response body. The request then fails like
   * one that could not reach the server, with a message saying it timed out.
   */
  timeoutMs?: number;
}

/** A request that ran out of time fails like an unreachable server (a plain Error). */
function timedOut(err: unknown): unknown {
  return err instanceof DOMException && err.name === 'TimeoutError'
    ? new Error(t('The server did not answer in time.'))
    : err;
}

function buildUrl(path: string, query?: Query) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

/** Settles like `promise`, or fails like a timed-out request once `signal` aborts first. */
function withinDeadline<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(timedOut(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(timedOut(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

async function send(
  path: string,
  opts: RequestOptions,
  signal?: AbortSignal,
  extra?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extra };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (actingFor) headers['X-Acting-For'] = actingFor;
  return fetch(buildUrl(path, opts.query), {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal,
  }).catch((err: unknown) => {
    throw timedOut(err);
  });
}

/** Sends a request, refreshing the session once if the access token has expired. */
async function sendWithSession(
  path: string,
  opts: RequestOptions,
  signal?: AbortSignal,
  extra?: Record<string, string>,
): Promise<Response> {
  let res = await send(path, opts, signal, extra);
  if (res.status === 401 && !path.startsWith('/auth/') && !(await needsReauth(res))) {
    // The refresh is shared with other requests and keeps running; only this request gives up.
    if (await withinDeadline(refreshSession(), signal)) {
      res = await send(path, opts, signal, extra);
    } else {
      onSessionExpired?.();
    }
  }
  return res;
}

export async function apiRaw(path: string, opts: RequestOptions = {}): Promise<Response> {
  const signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  let res = await sendWithSession(path, opts, signal);
  if (reauthHandler && (await needsReauth(res))) {
    res = await reauthHandler({
      retry: (password) => sendWithSession(path, opts, signal, { [REAUTH_HEADER]: password }),
      refused: res,
    });
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
      payload.error?.message ?? t('Request failed ({status})', { status: res.status }),
      payload.error?.details,
    );
  }
  return res;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiRaw(path, opts);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw timedOut(err);
  }
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
          ? t('The file is too large (maximum 10 MB)')
          : t('Upload failed ({status})', { status: res.status })),
      payload.error?.details,
    );
  }
  return (await res.json()) as T;
}
