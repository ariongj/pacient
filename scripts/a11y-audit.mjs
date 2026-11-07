#!/usr/bin/env node
/* global document, axe */
/**
 * Automated accessibility audit (WCAG 2.2 A/AA rules of axe-core) of every workspace page.
 * Needs the app running with demo data: `npm run dev` (web on 5173). Usage:
 *
 *   node scripts/a11y-audit.mjs [--base http://localhost:5173] [--locale sq|sr|en] [--json out.json]
 *
 * Automated checks find roughly a third of accessibility problems; a manual review with a screen
 * reader and keyboard is still required before go-live.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://localhost:5173');
const LOCALE = arg('locale', 'en');
const PASSWORD = 'Pacient-Demo-2026';
const PAGES = {
  'patient@pacient.local': [
    '/portal',
    '/portal/history',
    '/portal/results',
    '/portal/appointments',
    '/portal/vaccinations',
    '/portal/billing',
    '/portal/documents',
    '/portal/consents',
    '/portal/access-log',
    '/portal/account',
    '/account/security',
    '/portal/certificates',
    '/portal/waiting-lists',
    '/portal/e-prescriptions',
    '/portal/screening',
    '/portal/pregnancy',
    '/portal/wishes',
    '/portal/complaints',
  ],
  'doctor@pacient.local': [
    '/doctor',
    '/doctor/patients',
    '/doctor/schedule',
    '/doctor/availability',
    '/wards',
    '/wards/early-warning',
    '/ed',
    '/theatre',
    '/blood-bank',
    '/tools/interactions',
    '/surveillance',
    '/messages',
    '/channels',
    '/certificates',
    '/registers',
    '/waiting-lists',
    '/deaths',
    '/incidents',
    '/maternity',
    '/screening',
    '/e-prescriptions',
  ],
  'nurse@pacient.local': [
    '/nurse',
    '/downtime',
    '/nutrition',
    '/vaccinations/due',
    '/births',
    '/identities',
  ],
  'pharmacist@pacient.local': ['/pharmacy', '/pharmacy/stock', '/e-prescriptions'],
  'reception@pacient.local': ['/reception', '/reception/patients', '/billing', '/complaints'],
  'director@pacient.local': [
    '/director',
    '/director/reports',
    '/director/staff',
    '/director/units',
    '/director/duplicates',
    '/director/integrations',
    '/downtime',
    '/privacy',
    '/waiting-lists',
    '/registers',
    '/deaths',
    '/incidents',
    '/complaints',
    '/licences',
  ],
  'minister@pacient.local': [
    '/ministry',
    '/ministry/reports',
    '/ministry/facilities',
    '/ministry/partners',
    '/ministry/stock',
    '/ministry/vaccination',
    '/developers',
    '/privacy',
    '/ministry/system',
    '/deaths',
    '/registers',
    '/waiting-lists',
    '/incidents',
    '/organ-donation',
    '/licences',
    '/complaints',
  ],
};

const browser = await chromium.launch();
const results = [];
for (const [email, paths] of Object.entries(PAGES)) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((l) => {
    try {
      localStorage.setItem('pacient.locale', l);
      sessionStorage.setItem('pacient.localeChosen', '1');
    } catch {
      /* ignore */
    }
  }, LOCALE);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.locator('button[type=submit]').click();
  try {
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
  } catch {
    const alert = await page.locator('.alert').allInnerTexts();
    console.log(`${email}: sign-in failed ${alert.join(' | ')}`);
    results.push({ email, path: '/login', violations: [], signInFailed: true });
    await ctx.close();
    continue;
  }
  for (const path of ['/login', ...paths]) {
    if (path === '/login') continue;
    await page.goto(BASE + path);
    await page.waitForLoadState('load');
    await page
      .waitForFunction(() => !document.querySelector('.loading'), null, { timeout: 15000 })
      .catch(() => {});
    await page.waitForTimeout(400);
    await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(async () => {
      const r = await axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      });
      return r.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes
          .slice(0, 3)
          .map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 160) })),
        count: v.nodes.length,
      }));
    });
    results.push({ email, path, violations: res });
    const summary = res.map((v) => `${v.id}(${v.count})`).join(' ') || 'OK';
    console.log(`${email.split('@')[0].padEnd(11)} ${path.padEnd(26)} ${summary}`);
  }
  await ctx.close();
}
await browser.close();

const byRule = new Map();
for (const r of results)
  for (const v of r.violations) {
    const e = byRule.get(v.id) ?? {
      id: v.id,
      impact: v.impact,
      help: v.help,
      pages: 0,
      nodes: 0,
      example: v.nodes[0],
    };
    e.pages++;
    e.nodes += v.count;
    byRule.set(v.id, e);
  }
console.log('\nSummary by rule:');
for (const e of [...byRule.values()].sort((a, b) => b.nodes - a.nodes))
  console.log(
    `  ${e.id} [${e.impact}] ${e.pages} pages, ${e.nodes} elements – ${e.help}\n    e.g. ${e.example?.target} ${e.example?.html}`,
  );
const out = arg('json');
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
process.exitCode = byRule.size ? 1 : 0;
