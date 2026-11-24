#!/usr/bin/env node
/**
 * Checks a live installation from outside, after go-live or after any change:
 *
 *   node deploy/smoke-test.mjs --web https://pacienti.itdks.tech --api https://pacienti-api.itdks.tech
 *   node deploy/smoke-test.mjs --web … --api … --mail-domain pacienti.itdks.tech
 *   node deploy/smoke-test.mjs --mail-domain pacienti.itdks.tech     (the e-mail records only)
 *
 * API: reachable over HTTPS and ready; CORS answers the frontend's origin only, with credentials;
 * security headers; sign-in endpoint and live updates reachable through the proxy; /metrics not
 * public. Frontend: served over HTTPS, built for this API, links opened directly still load the
 * app, the app manifest and offline support are present, no source maps. E-mail (--mail-domain,
 * the domain of EMAIL_FROM): exactly one SPF record that does not allow everyone, and a DMARC
 * record with a policy – without them activation and reset e-mails land in spam or are refused.
 * DKIM needs the provider's selector and is checked with a test e-mail (docs/GO-LIVE.md, E-mail).
 * Touches no data and signs nobody in. Exits with 1 if anything fails. Needs Node 18 or newer.
 */
import { Resolver } from 'node:dns/promises';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const WEB = arg('web')?.replace(/\/$/, '');
const API = arg('api')?.replace(/\/$/, '');
const MAIL_DOMAIN = arg('mail-domain')?.trim().toLowerCase().replace(/\.$/, '');
if (Boolean(WEB) !== Boolean(API) || (!WEB && !MAIL_DOMAIN)) {
  console.error(
    'Usage: node deploy/smoke-test.mjs --web https://… --api https://… [--mail-domain example.org]',
  );
  process.exit(2);
}

let failures = 0;
const check = async (name, fn) => {
  try {
    const note = await fn();
    console.log(`OK    ${name}${note ? ` – ${note}` : ''}`);
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name} – ${e.message}`);
  }
};
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};
const get = (url, init = {}) =>
  fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000), ...init });
const finish = () => {
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
};

/* ------------------------------------------------------------------ e-mail ----------------- */

if (MAIL_DOMAIN) {
  const resolver = new Resolver({ timeout: 5_000, tries: 2 });
  /**
   * TXT records of a name (each joined from its strings): none when the name has none, null when
   * the name does not exist at all.
   */
  const txt = async (name) => {
    try {
      return (await resolver.resolveTxt(name)).map((parts) => parts.join(''));
    } catch (e) {
      if (e.code === 'ENODATA') return [];
      if (e.code === 'ENOTFOUND') return null;
      throw new Error(`DNS lookup of ${name} failed (${e.code ?? e.message})`);
    }
  };
  await check(`SPF record of ${MAIL_DOMAIN}`, async () => {
    const records = await txt(MAIL_DOMAIN);
    expect(records, 'the domain does not resolve (no such domain, or no DNS from this computer)');
    const spf = records.filter((r) => /^v=spf1(\s|$)/i.test(r));
    expect(spf.length, 'no TXT record "v=spf1 …" – add the one your mail provider gives you');
    expect(spf.length === 1, `${spf.length} SPF records – merge them into exactly one`);
    expect(!/(^|\s)\+?all(\s|$)/i.test(spf[0]), 'it ends in "+all": anyone may send as you');
    return spf[0].length > 80 ? `${spf[0].slice(0, 77)}…` : spf[0];
  });
  await check(`DMARC record of ${MAIL_DOMAIN}`, async () => {
    // A domain without DMARC usually has no _dmarc name at all.
    const records = (await txt(`_dmarc.${MAIL_DOMAIN}`)) ?? [];
    const dmarc = records.filter((r) => /^v=DMARC1\s*(;|$)/i.test(r));
    expect(dmarc.length, `no TXT record "v=DMARC1; p=…" at _dmarc.${MAIL_DOMAIN}`);
    expect(dmarc.length === 1, `${dmarc.length} DMARC records – keep exactly one`);
    const policy = /(?:^|;)\s*p\s*=\s*(\w+)/i.exec(dmarc[0])?.[1]?.toLowerCase();
    expect(
      ['none', 'quarantine', 'reject'].includes(policy),
      'no valid policy (p=none, quarantine or reject)',
    );
    return policy === 'none'
      ? 'p=none: reports only; move to quarantine once the reports are clean'
      : `p=${policy}`;
  });
}
if (!WEB) finish();
const origin = new URL(WEB).origin;

await check('Both addresses use HTTPS', () => {
  expect(WEB.startsWith('https://') && API.startsWith('https://'), 'use https:// for both');
});
await check('Frontend and API are the same site (for the sign-in cookie)', () => {
  const site = (u) => new URL(u).hostname.split('.').slice(-2).join('.');
  expect(site(WEB) === site(API), `${site(WEB)} ≠ ${site(API)}`);
});

/* ------------------------------------------------------------------ API -------------------- */

await check('API is ready', async () => {
  const r = await get(`${API}/health/ready`);
  expect(r.status === 200, `status ${r.status}`);
});
await check('API sends security headers', async () => {
  const r = await get(`${API}/health/live`);
  const missing = [
    'strict-transport-security',
    'x-content-type-options',
    'content-security-policy',
  ].filter((h) => !r.headers.get(h));
  expect(!missing.length, `missing ${missing.join(', ')}`);
});
await check('CORS allows the frontend, with credentials', async () => {
  const r = await get(`${API}/api/v1/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });
  expect(r.headers.get('access-control-allow-origin') === origin, 'origin not allowed');
  expect(r.headers.get('access-control-allow-credentials') === 'true', 'no credentials');
});
await check('CORS refuses other sites', async () => {
  const r = await get(`${API}/api/v1/auth/login`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST' },
  });
  expect(!r.headers.get('access-control-allow-origin'), 'another site is allowed');
});
await check('Sign-in endpoint answers through the proxy', async () => {
  const r = await get(`${API}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email: 'smoke-test@example.invalid', password: 'not-a-password-1' }),
  });
  expect(r.status === 401, `status ${r.status} (expected 401)`);
});
await check('Live updates are reachable (a ticket is required)', async () => {
  const r = await get(`${API}/api/v1/events?ticket=${'x'.repeat(32)}`);
  expect(r.status === 401, `status ${r.status} (expected 401)`);
});
await check('Metrics are not public', async () => {
  const r = await get(`${API}/metrics`);
  expect(r.status === 404 || r.status === 403 || r.status === 401, `status ${r.status}`);
});

/* ------------------------------------------------------------------ frontend --------------- */

let html = '';
await check('Frontend loads', async () => {
  const r = await get(`${WEB}/`);
  expect(r.status === 200, `status ${r.status}`);
  html = await r.text();
  expect(html.includes('id="root"'), 'not the Pacient app');
});
await check('Frontend is built for this API', async () => {
  const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map((m) => new URL(m[1], `${WEB}/`));
  expect(scripts.length, 'no script in the page');
  for (const s of scripts) {
    if ((await (await get(s)).text()).includes(`${API}/api/v1`)) return s.pathname;
  }
  throw new Error(`no script refers to ${API}/api/v1 – check PACIENTI_API_BASE_URL`);
});
await check('A link opened directly still loads the app', async () => {
  const r = await get(`${WEB}/doctor/patients`);
  expect((await r.text()).includes('id="root"'), `status ${r.status}, not the app`);
});
await check('App manifest and offline support are served', async () => {
  for (const path of ['/manifest.webmanifest', '/sw.js', '/offline.html']) {
    const r = await get(`${WEB}${path}`);
    expect(r.status === 200, `${path}: status ${r.status}`);
  }
});
await check('No source maps are published', async () => {
  expect(!/sourceMappingURL=/.test(html), 'the page refers to a source map');
});

finish();
