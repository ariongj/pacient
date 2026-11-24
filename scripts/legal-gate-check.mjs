#!/usr/bin/env node
/**
 * Browser check of the legal gate (hazard H75: accepting the terms of use or the privacy notice
 * never locks anyone out of their workspace). It drives the real web app in Chromium with the API
 * stubbed inside the browser, so it needs no database and no API server: it starts its own Vite
 * dev server on a free port (never 5173 or 4000) and stops it at the end. Usage:
 *
 *   npm run check:legal-gate            (Playwright with Chromium, as for npm run a11y)
 *
 * Scenarios: accepting opens the workspace; a slow or failing status check opens it; a server
 * error, a network failure or no answer within the time limit on accepting offers Continue; a
 * conflict (409) that asking again does not resolve offers Continue, after the status still shows
 * the same version or after a second conflict, while a newer version replaces the text; the
 * opened workspace stays open after leaving it for a public page and coming back; signing out and
 * in again asks again. Exits with 1 if any scenario fails. Run before each release
 * (docs/GO-LIVE.md); the API side is covered by apps/api/test/platform.test.ts.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const webDir = join(root, 'apps/web');
/** Ports the developer's own servers use: never taken here. */
const RESERVED = new Set([5173, 4000]);

/** The client gives up on recording an acceptance after this long (ACCEPT_TIMEOUT_MS). */
const ACCEPT_TIMEOUT_MS = 10_000;
/** The gate opens the workspace when the status check takes longer than this (WAIT_MS). */
const STATUS_WAIT_MS = 1_500;

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const { port: p } = srv.address();
        srv.close(() => resolve(p));
      });
    });
    if (!RESERVED.has(port)) return port;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startVite(port) {
  const vitePackage = createRequire(join(webDir, 'package.json')).resolve('vite/package.json');
  const viteBin = join(dirname(vitePackage), 'bin/vite.js');
  const child = spawn(
    process.execPath,
    [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: webDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none' } },
  );
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite stopped:\n${output}`);
    try {
      if ((await fetch(`${base}/login`)).ok) return { child, base };
    } catch {
      /* not listening yet */
    }
    await sleep(300);
  }
  child.kill('SIGTERM');
  throw new Error(`Vite did not start on port ${port}:\n${output}`);
}

/* ------------------------------------------------------------------ the stubbed API --------- */

const PROFILE = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'support@gate.test',
  fullName: 'Gate Check',
  role: 'IT_SUPPORT',
  specialty: null,
  lastLoginAt: null,
  facility: null,
  patientId: null,
  mfaEnabled: true,
  mfaRequired: false,
  emailNotifications: 'ALL',
  smsNotifications: 'OFF',
  locale: 'en',
  phone: null,
};

const doc = (version, title = `Terms of use ${version}`) => ({
  id: `00000000-0000-4000-8000-0000000000${version.replace(/\D/g, '').padStart(2, '0')}`,
  kind: 'TERMS',
  version,
  locale: 'en',
  title,
  body: '# Use of the service\n\nA synthetic text for the browser check of the legal gate.',
  publishedAt: '2026-01-01T00:00:00.000Z',
  requiresAcceptance: true,
});

/**
 * One browser context per scenario (a fresh page load, so the gate starts from nothing). `api`
 * holds the scenario's answers for the gate's two requests and can be changed while it runs.
 */
async function openApp(browser, base, api) {
  const context = await browser.newContext({ locale: 'en-GB' });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('pacient.locale', 'en');
    } catch {
      /* storage unavailable */
    }
  });
  const page = await context.newPage();
  let signedIn = false;
  const json = (route, status, body) =>
    route
      .fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
      .catch(() => {}); // the page gave up on it (a timeout) or was closed
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/v1/, '');
    if (path === '/auth/refresh') {
      return signedIn
        ? json(route, 200, { accessToken: 'token' })
        : json(route, 401, { error: { code: 'UNAUTHORIZED', message: 'Not signed in' } });
    }
    if (path === '/auth/login') {
      signedIn = true;
      return json(route, 200, { accessToken: 'token' });
    }
    if (path === '/auth/logout') {
      signedIn = false;
      return route.fulfill({ status: 204 }).catch(() => {});
    }
    if (path === '/auth/me') return json(route, 200, PROFILE);
    if (path === '/legal/status') return api.status(route, json);
    if (path === '/legal/accept') return api.accept(route, json);
    if (path === '/legal/terms' || path === '/legal/privacy') {
      return json(route, 200, {
        ...doc('1.0'),
        operator: { name: 'Operator', address: null, supportEmail: null, privacyEmail: null },
      });
    }
    if (path === '/platform/info') {
      return json(route, 200, {
        operatorName: 'Operator',
        operatorAddress: null,
        supportEmail: null,
        supportPhone: null,
        privacyEmail: null,
        notice: null,
      });
    }
    // Everything else the workspace asks for: not part of this check.
    return json(route, 404, { error: { code: 'NOT_FOUND', message: 'Not stubbed' } });
  });
  return { context, page };
}

const ok = (pending = []) => ({ status: 200, body: { pending } });
/** Answers after `ms` (the page may have stopped waiting). */
const after = (ms, status, body) => async (route, json) => {
  await sleep(ms);
  return json(route, status, body);
};
const answer = (status, body) => (route, json) => json(route, status, body);
const conflict = answer(409, {
  error: {
    code: 'CONFLICT',
    message: 'This is not the current version. Reload the page and read the current text.',
  },
});

/* ------------------------------------------------------------------ page helpers ------------ */

const acceptButton = (page) =>
  page.getByRole('button', { name: 'Accept and continue', exact: true });
const continueButton = (page) =>
  page.getByRole('button', { name: 'Continue – you will be asked again next time' });

async function signIn(page, base) {
  if (!new URL(page.url()).pathname.startsWith('/login')) {
    await page.goto(`${base}/login`, { timeout: 60_000 });
  }
  await page.getByLabel('Email').fill(PROFILE.email);
  await page.getByLabel('Password').fill('a-synthetic-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** The workspace is open: the role's home page, no acceptance card. */
async function expectWorkspace(page, timeout = 10_000) {
  await page.waitForURL(/\/support(\?|$)/, { timeout });
  await page.locator('#main h1').first().waitFor({ state: 'visible', timeout });
  if (await acceptButton(page).isVisible()) throw new Error('the acceptance card is still shown');
}

async function expectCard(page, title, timeout = 10_000) {
  await acceptButton(page).waitFor({ state: 'visible', timeout });
  if (title) await page.getByRole('heading', { name: title }).waitFor({ timeout });
}

async function tickAndAccept(page) {
  await page.getByLabel('I have read and accept this text').check();
  await acceptButton(page).click();
}

async function expectNoContinueFor(page, ms) {
  await sleep(ms);
  if (await continueButton(page).isVisible()) throw new Error('Continue was offered too early');
}

/* ------------------------------------------------------------------ scenarios --------------- */

const SCENARIOS = [
  {
    name: 'accepting records it and opens the workspace',
    api: () => {
      let accepted = false;
      return {
        status: (route, json) => json(route, 200, accepted ? ok().body : ok([doc('1.0')]).body),
        accept: (route, json) => {
          accepted = true;
          return json(route, 200, { accepted: true, pending: [] });
        },
      };
    },
    run: async (page, base) => {
      await signIn(page, base);
      await expectCard(page, 'Terms of use 1.0', 60_000);
      await tickAndAccept(page);
      await expectWorkspace(page);
    },
  },
  {
    name: 'a slow status check opens the workspace without waiting for it',
    api: () => ({ status: after(8_000, 200, ok([doc('1.0')]).body), accept: answer(200, {}) }),
    run: async (page, base) => {
      await signIn(page, base);
      const started = Date.now();
      await expectWorkspace(page, 7_000);
      if (Date.now() - started < STATUS_WAIT_MS - 200) throw new Error('opened before the wait');
      // The late answer does not replace the open workspace.
      await sleep(8_500 - (Date.now() - started));
      await expectWorkspace(page, 1_000);
    },
  },
  {
    name: 'a failing status check (500) opens the workspace',
    api: () => ({
      status: answer(500, { error: { code: 'INTERNAL', message: 'Boom' } }),
      accept: answer(200, {}),
    }),
    run: async (page, base) => {
      await signIn(page, base);
      await expectWorkspace(page);
    },
  },
  {
    name: 'a server error on accepting offers Continue, which opens the workspace',
    api: () => ({
      status: answer(200, ok([doc('1.0')]).body),
      accept: answer(500, { error: { code: 'INTERNAL', message: 'Boom' } }),
    }),
    run: async (page, base) => {
      await signIn(page, base);
      await expectCard(page);
      await tickAndAccept(page);
      await continueButton(page).click({ timeout: 5_000 });
      await expectWorkspace(page);
    },
  },
  {
    name: 'a network failure on accepting offers Continue',
    api: () => ({
      status: answer(200, ok([doc('1.0')]).body),
      accept: (route) => route.abort('failed'),
    }),
    run: async (page, base) => {
      await signIn(page, base);
      await expectCard(page);
      await tickAndAccept(page);
      await continueButton(page).click({ timeout: 5_000 });
      await expectWorkspace(page);
    },
  },
  {
    name: 'no answer on accepting offers Continue after the time limit',
    api: () => ({
      status: answer(200, ok([doc('1.0')]).body),
      accept: after(ACCEPT_TIMEOUT_MS + 20_000, 200, { accepted: true, pending: [] }),
    }),
    run: async (page, base) => {
      await signIn(page, base);
      await expectCard(page);
      const started = Date.now();
      await tickAndAccept(page);
      await expectNoContinueFor(page, 2_000);
      await continueButton(page).waitFor({ timeout: ACCEPT_TIMEOUT_MS + 5_000 });
      const waited = Date.now() - started;
      if (waited < ACCEPT_TIMEOUT_MS - 500) throw new Error(`Continue after ${waited} ms`);
      await page.getByText('The server did not answer in time.').waitFor({ timeout: 1_000 });
      await continueButton(page).click();
      await expectWorkspace(page);
    },
  },
  {
    name: 'a conflict (409) whose status check still shows the same version offers Continue',
    api: () => ({ status: answer(200, ok([doc('1.0')]).body), accept: conflict }),
    run: async (page, base) => {
      await signIn(page, base);
      await expectCard(page);
      await tickAndAccept(page);
      await continueButton(page).click({ timeout: 5_000 });
      await expectWorkspace(page);
    },
  },
  {
    name: 'a second conflict (409) offers Continue while the status check hangs',
    api: () => {
      let calls = 0;
      return {
        status: (route, json) =>
          ++calls === 1
            ? json(route, 200, ok([doc('1.0')]).body)
            : after(60_000, 200, ok([doc('1.0')]).body)(route, json),
        accept: conflict,
      };
    },
    run: async (page, base) => {
      await signIn(page, base);
      await expectCard(page);
      await tickAndAccept(page);
      await page.getByText('This is not the current version').waitFor({ timeout: 5_000 });
      await expectNoContinueFor(page, 1_000);
      await acceptButton(page).click();
      await continueButton(page).click({ timeout: 5_000 });
      await expectWorkspace(page);
    },
  },
  {
    name: 'a conflict (409) because a newer version was published shows the newer text',
    api: () => {
      let published = false;
      return {
        status: (route, json) => json(route, 200, ok([published ? doc('2.0') : doc('1.0')]).body),
        accept: (route, json) => {
          published = true;
          return conflict(route, json);
        },
      };
    },
    run: async (page, base) => {
      await signIn(page, base);
      await expectCard(page, 'Terms of use 1.0');
      await tickAndAccept(page);
      await expectCard(page, 'Terms of use 2.0', 5_000);
      if (await continueButton(page).isVisible()) throw new Error('Continue offered for 2.0');
    },
  },
  {
    name: 'the opened workspace stays open after a public page; signing out asks again',
    api: () => ({
      status: answer(500, { error: { code: 'INTERNAL', message: 'Boom' } }),
      accept: answer(200, { accepted: true, pending: [] }),
    }),
    run: async (page, base, api) => {
      await signIn(page, base);
      await expectWorkspace(page);
      // A newer version is now pending: the open workspace is not replaced by it.
      api.status = answer(200, ok([doc('3.0')]).body);
      await page.locator('footer').getByRole('link', { name: 'Terms of use', exact: true }).click();
      await page.waitForURL(/\/legal\/terms$/);
      await page.getByRole('link', { name: 'Back to Pacient', exact: true }).click();
      await expectWorkspace(page);
      await sleep(1_000);
      await expectWorkspace(page, 1_000);
      // After signing out, the next sign-in asks again.
      await page.locator('header button[aria-label="Sign out"]').click();
      await page.waitForURL(/\/login/);
      await signIn(page, base);
      await expectCard(page, 'Terms of use 3.0');
    },
  },
];

/* ------------------------------------------------------------------ run --------------------- */

const port = await freePort();
const { child, base } = await startVite(port);
const stop = () => {
  if (child.exitCode === null) child.kill('SIGTERM');
};
process.on('exit', stop);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stop();
    process.exit(130);
  });
}

let failed = 0;
const browser = await chromium.launch();
try {
  console.log(`Legal gate check against ${base} (API stubbed in the browser)`);
  for (const scenario of SCENARIOS) {
    const api = scenario.api();
    const { context, page } = await openApp(browser, base, api);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await scenario.run(page, base, api);
      if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
      console.log(`  ok    ${scenario.name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${scenario.name}\n        ${String(err.message).split('\n')[0]}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  stop();
}
console.log(failed ? `${failed} scenario(s) failed.` : 'All scenarios passed.');
process.exit(failed ? 1 : 0);
