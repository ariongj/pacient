#!/usr/bin/env node
/**
 * Downtime PC sync – keeps the latest downtime pack on a protected ward computer so it can be
 * opened and printed when the hospital system is unavailable. See docs/DOWNTIME.md.
 *
 * Security model
 * - The server only ever hands this script the age-encrypted copy of the pack. The matching private
 *   key ("identity") lives on the downtime PC only, so the files on disk and in transit are useless
 *   without it. Protect the identity with the PC's disk encryption and OS account.
 * - The script authenticates with a facility-bound sync key (dts_…). The server stores only its
 *   SHA-256 hash (DOWNTIME_SYNC_KEYS) and the key can do nothing but fetch that facility's latest
 *   encrypted pack. Every fetch is audited.
 *
 * Usage
 *   node downtime-sync.mjs new-key <FACILITY_CODE>
 *       Prints a new sync key (put it on the PC) and the DOWNTIME_SYNC_KEYS entry (put it on the server).
 *   PACIENT_URL=https://pacient.example DOWNTIME_SYNC_KEY_FILE=/etc/pacient/sync.key \
 *   DOWNTIME_OUT_DIR=/var/lib/pacient-downtime node downtime-sync.mjs sync
 *       Downloads the latest pack (run hourly, e.g. cron / Task Scheduler). Exit code 0 on success.
 *   DOWNTIME_OUT_DIR=… node downtime-sync.mjs open --identity /path/to/identity.txt
 *       During an outage: decrypts the newest pack with `age` and prints the HTML file path to open
 *       and print. Delete the decrypted file afterwards.
 *   DOWNTIME_OUT_DIR=… node downtime-sync.mjs check [--max-age-minutes 90]
 *       Exit code 1 if the newest pack is older than the limit (for monitoring the PC).
 *
 * Environment: PACIENT_URL, DOWNTIME_SYNC_KEY or DOWNTIME_SYNC_KEY_FILE, DOWNTIME_OUT_DIR,
 * DOWNTIME_KEEP (number of packs kept locally, default 24).
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [, , command = 'sync', ...args] = process.argv;
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (msg, code = 1) => {
  console.error(`downtime-sync: ${msg}`);
  process.exit(code);
};
const outDir = () => {
  const dir = process.env.DOWNTIME_OUT_DIR;
  if (!dir) fail('DOWNTIME_OUT_DIR is not set');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};
const packs = (dir) =>
  readdirSync(dir)
    .filter((f) => /^pack-.+\.html\.age$/.test(f))
    .sort()
    .reverse();
const readStatus = (dir) => {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'status.json'), 'utf8'));
  } catch {
    return null;
  }
};

async function sync() {
  const base = (process.env.PACIENT_URL ?? '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) {
    fail('PACIENT_URL must be an https:// address (http only for localhost)');
  }
  const key = (
    process.env.DOWNTIME_SYNC_KEY ??
    (process.env.DOWNTIME_SYNC_KEY_FILE ? readFileSync(process.env.DOWNTIME_SYNC_KEY_FILE, 'utf8') : '')
  ).trim();
  if (!key.startsWith('dts_')) fail('DOWNTIME_SYNC_KEY / DOWNTIME_SYNC_KEY_FILE is missing or invalid');
  const dir = outDir();

  const res = await fetch(`${base}/api/v1/downtime/sync/latest`, {
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'pacient-downtime-sync/1' },
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    let message = '';
    try {
      message = (await res.json()).error?.message ?? '';
    } catch {
      /* ignore */
    }
    fail(`server answered ${res.status} ${message}`.trim());
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.subarray(0, 21).equals(Buffer.from('age-encryption.org/v1'))) {
    fail('response is not an age-encrypted file – refusing to store it');
  }
  const generatedAt = res.headers.get('x-pack-generated-at') ?? new Date().toISOString();
  const sha256 = res.headers.get('x-pack-sha256') ?? '';
  const name = `pack-${generatedAt.replace(/[:.]/g, '-')}.html.age`;
  const tmp = path.join(dir, `.${name}.tmp`);
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path.join(dir, name));
  writeFileSync(
    path.join(dir, 'status.json'),
    JSON.stringify({ latest: name, generatedAt, sha256, syncedAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  const keep = Math.max(1, Number(process.env.DOWNTIME_KEEP ?? 24));
  for (const old of packs(dir).slice(keep)) rmSync(path.join(dir, old), { force: true });
  console.log(`downtime-sync: stored ${name} (generated ${generatedAt})`);
}

function open() {
  const dir = outDir();
  const identity = flag('--identity') ?? process.env.DOWNTIME_AGE_IDENTITY;
  if (!identity || !existsSync(identity)) fail('pass --identity <age identity file>');
  const latest = packs(dir)[0];
  if (!latest) fail('no pack has been synchronised yet');
  const status = readStatus(dir);
  const target = path.join(dir, latest.replace(/\.age$/, ''));
  const r = spawnSync('age', ['-d', '-i', identity, '-o', target, path.join(dir, latest)], {
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  if (r.error) fail(`could not run age (${r.error.message}) – install it from https://age-encryption.org`);
  if (r.status !== 0) fail('decryption failed');
  chmodSync(target, 0o600);
  if (status?.latest === latest && status.sha256) {
    const actual = createHash('sha256').update(readFileSync(target)).digest('hex');
    if (actual !== status.sha256) {
      rmSync(target, { force: true });
      fail('integrity check failed – the decrypted pack does not match the server checksum');
    }
  }
  console.log(target);
  console.error('Open this file in a browser and print it. Delete it when the outage is over.');
}

function check() {
  const dir = outDir();
  const maxAge = Number(flag('--max-age-minutes') ?? 90);
  const status = readStatus(dir);
  if (!status?.generatedAt) fail('no pack has been synchronised yet');
  const ageMinutes = (Date.now() - new Date(status.generatedAt).getTime()) / 60_000;
  if (!(ageMinutes <= maxAge)) fail(`newest pack is ${Math.round(ageMinutes)} minutes old`);
  console.log(`downtime-sync: newest pack is ${Math.round(ageMinutes)} minutes old`);
}

function newKey() {
  const code = args[0];
  if (!code || !/^[A-Za-z0-9_-]{1,32}$/.test(code)) fail('usage: new-key <FACILITY_CODE>');
  const key = `dts_${randomBytes(32).toString('base64url')}`;
  const hash = createHash('sha256').update(key).digest('hex');
  console.log(`Sync key (store on the downtime PC only, file mode 600):\n  ${key}\n`);
  console.log(`Server entry (append to DOWNTIME_SYNC_KEYS, comma-separated):\n  ${code}:${hash}`);
}

const commands = { sync, open, check, 'new-key': newKey };
if (!commands[command]) fail(`unknown command "${command}" (sync, open, check, new-key)`, 2);
await Promise.resolve(commands[command]()).catch((err) => fail(err?.message ?? String(err)));
