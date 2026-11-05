import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal S3 client (PUT, GET and HEAD object) for S3-compatible object storage – AWS S3, MinIO,
 * Ceph RGW and others – signed with AWS Signature Version 4. The payload is always hashed and
 * signed (never UNSIGNED-PAYLOAD), so the store can reject anything altered in transit.
 */
export interface S3Config {
  /** e.g. https://s3.eu-central-1.amazonaws.com or http://minio:9000 */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** endpoint/bucket/key instead of bucket.endpoint/key */
  forcePathStyle: boolean;
  /** Optional server-side encryption header (on top of the application's own encryption). */
  serverSideEncryption?: 'AES256' | 'aws:kms';
  timeoutMs?: number;
}

export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'S3Error';
  }
}

export const sha256Hex = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 requires (unreserved characters stay, everything else is %XX). */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const c = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(c) || (c === '/' && !encodeSlash)) out += c;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** 20130524T000000Z */
export const amzDate = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

export interface SignInput {
  method: string;
  /** Full request URL (host, path and query are signed). */
  url: URL;
  /** Headers to sign besides host (names any case). */
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}

/**
 * Signs a request (AWS Signature Version 4, header-based). Returns the headers to send, including
 * Authorization, x-amz-date and x-amz-content-sha256.
 */
export function signV4(input: SignInput): Record<string, string> {
  const service = input.service ?? 's3';
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v;
  headers['host'] = input.url.host;
  headers['x-amz-date'] = stamp;
  headers['x-amz-content-sha256'] = input.payloadHash;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = names.join(';');
  const query = [...input.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  // The URL pathname is already percent-encoded by buildUrl(); decode and re-encode canonically.
  const path = uriEncode(decodeURIComponent(input.url.pathname), false) || '/';
  const canonicalRequest = [
    input.method.toUpperCase(),
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const out: Record<string, string> = {};
  for (const n of names) if (n !== 'host') out[n] = headers[n]!;
  out['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

export class S3Client {
  constructor(private readonly config: S3Config) {}

  /** URL of an object, path-style or virtual-hosted style. */
  objectUrl(key: string): URL {
    const base = new URL(this.config.endpoint);
    const prefix = base.pathname.replace(/\/+$/, '');
    const encodedKey = uriEncode(key, false);
    if (this.config.forcePathStyle) {
      base.pathname = `${prefix}/${this.config.bucket}/${encodedKey}`;
    } else {
      base.hostname = `${this.config.bucket}.${base.hostname}`;
      base.pathname = `${prefix}/${encodedKey}`;
    }
    return base;
  }

  private async send(
    method: 'PUT' | 'GET' | 'HEAD',
    key: string,
    body?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = this.objectUrl(key);
    const payload = body ?? Buffer.alloc(0);
    const headers = signV4({
      method,
      url,
      headers: extraHeaders,
      payloadHash: sha256Hex(payload),
      region: this.config.region,
      accessKeyId: this.config.accessKeyId,
      secretAccessKey: this.config.secretAccessKey,
      date: new Date(),
    });
    try {
      return await fetch(url, {
        method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15000),
        redirect: 'error',
      });
    } catch (err) {
      throw new S3Error(`Object storage unreachable: ${(err as Error).message}`, 0);
    }
  }

  private async fail(res: Response, what: string): Promise<never> {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw new S3Error(
      `${what} failed with HTTP ${res.status}${code ? ` (${code})` : ''}`,
      res.status,
      code,
    );
  }

  async putObject(key: string, body: Buffer, contentType = 'application/octet-stream') {
    // Content-Length is set by fetch; the signed payload hash already binds the exact bytes.
    const headers: Record<string, string> = { 'content-type': contentType };
    if (this.config.serverSideEncryption) {
      headers['x-amz-server-side-encryption'] = this.config.serverSideEncryption;
    }
    const res = await this.send('PUT', key, body, headers);
    if (!res.ok) await this.fail(res, 'PUT object');
    await res.arrayBuffer();
  }

  /** The object's bytes, or null when it does not exist. */
  async getObject(key: string): Promise<Buffer | null> {
    const res = await this.send('GET', key);
    if (res.status === 404) {
      await res.arrayBuffer();
      return null;
    }
    if (!res.ok) await this.fail(res, 'GET object');
    return Buffer.from(await res.arrayBuffer());
  }

  /** Size of the object, or null when it does not exist. */
  async headObject(key: string): Promise<{ size: number } | null> {
    const res = await this.send('HEAD', key);
    if (res.status === 404) return null;
    if (!res.ok) throw new S3Error(`HEAD object failed with HTTP ${res.status}`, res.status);
    return { size: Number(res.headers.get('content-length') ?? '0') };
  }
}
