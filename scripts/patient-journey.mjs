#!/usr/bin/env node
/* global document */
/**
 * Walks the whole patient cycle through the real user interface, as each role would:
 * the front desk registers a new patient and books and checks in an appointment; the doctor sees
 * the patient waiting, joins the care team, writes the visit, orders a test and prescribes; the
 * ward nurse takes the sample; the laboratory receives it, enters the result and a second person
 * validates it; the doctor releases it; the pharmacist verifies and dispenses from stock; the
 * patient is admitted and discharged; the front desk takes the co-payment; and the patient
 * activates the portal and finds all of it in their own record.
 *
 * Needs the app running with demo data (`npm run dev`, web on 5173). Every run registers a new
 * synthetic patient. Usage:
 *
 *   node scripts/patient-journey.mjs [--base http://localhost:5173] [--shots <dir>]
 *
 * Exits with 1 if any step fails. The same cycle is covered at API level by
 * apps/api/test/journey.test.ts; docs/PATIENT-JOURNEY.md maps every step to its page.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://localhost:5173');
const SHOTS = arg('shots', null);
const PASSWORD = 'Pacient-Demo-2026';
const PORTAL_PASSWORD = 'Journey-Portal-2026!';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const stamp = String(Date.now()).slice(-8);
const patient = {
  nationalId: `19${stamp}`,
  firstName: 'Journey',
  lastName: `Test${stamp.slice(-5)}`,
  email: `journey${stamp}@example.test`,
  id: '',
  activation: '',
  orderNumber: '',
};

const browser = await chromium.launch();
const results = [];
const apiErrors = [];

/** Signs in and returns a page that records failed API calls (expected denials aside). */
async function signIn(email, password = PASSWORD) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('pacient.locale', 'en');
      sessionStorage.setItem('pacient.localeChosen', '1');
    } catch {
      /* storage unavailable */
    }
  });
  const page = await ctx.newPage();
  // A missing button should fail the step quickly, not hold the whole walk up.
  page.setDefaultTimeout(12_000);
  page.on('pageerror', (e) => apiErrors.push(`${email}: page error: ${e.message}`));
  page.on('response', (r) => {
    const path = r.url().replace(/^.*\/api\/v1/, '');
    // 401 before sign-in and the 403 that precedes "Join care team" are part of the design.
    const expected = r.status() === 401 || (r.status() === 403 && /\/summary$/.test(path));
    if (r.url().includes('/api/') && r.status() >= 400 && !expected) {
      apiErrors.push(`${email}: ${r.status()} ${r.request().method()} ${path}`);
    }
  });
  await page.goto(`${BASE}/login`);
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill(password);
  await page.locator('button[type=submit]').click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await settle(page);
  return { ctx, page };
}

/**
 * Waits until lazy pages and queries have settled. (Not "network idle": the live-updates stream
 * keeps a connection open for as long as the user is signed in.)
 */
async function settle(page, ms = 400) {
  await page.waitForTimeout(350);
  await page
    .waitForFunction(() => !document.querySelector('.loading, [aria-busy="true"]'), null, {
      timeout: 15_000,
    })
    .catch(() => {});
  await page.waitForTimeout(ms);
}

const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ');
const dialog = (page) => page.getByRole('dialog');
const panel = (page) => page.locator('main [role=tabpanel]');
const chart = (role, tab) => `${BASE}/${role}/patients/${patient.id}?tab=${tab}`;

async function expectClosed(page, what) {
  await settle(page);
  if (await dialog(page).count()) {
    throw new Error(
      `${what}: the dialog did not close – ${(await text(dialog(page))).slice(-300)}`,
    );
  }
}

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`OK    ${name}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${String(e.message).split('\n')[0].slice(0, 400)}`);
  }
}

/** Runs `fn` signed in as `email`; takes a screenshot at the end when --shots is given. */
async function as(email, name, fn, password) {
  await step(name, async () => {
    const { ctx, page } = await signIn(email, password);
    try {
      await fn(page);
    } finally {
      if (SHOTS) {
        const file = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 60);
        await page.screenshot({
          path: `${SHOTS}/${String(results.length + 1).padStart(2, '0')}-${file}.png`,
        });
      }
      await ctx.close();
    }
  });
}

/* ------------------------------------------------------------------ front desk ----------- */

await as(
  'reception@pacient.local',
  'Front desk registers the patient and books a visit',
  async (page) => {
    await page.goto(`${BASE}/reception/patients/new`);
    await settle(page);
    await page.getByLabel('National ID').fill(patient.nationalId);
    await page.getByLabel('First name').fill(patient.firstName);
    await page.getByLabel('Last name').fill(patient.lastName);
    await page.getByLabel('Date of birth').fill('1988-03-14');
    await page.getByLabel('Sex').selectOption({ index: 1 });
    await page.getByLabel('Phone', { exact: true }).fill('+38344111222');
    await page.getByRole('textbox', { name: 'Email' }).fill(patient.email);
    await page.getByRole('checkbox', { name: /Invite the patient to the portal/ }).check();
    await page.getByRole('button', { name: 'Register patient' }).click();
    await settle(page);
    const main = await page.locator('main').innerText();
    if (!main.includes('has been registered'))
      throw new Error(`not registered: ${main.slice(0, 300)}`);
    patient.activation = (main.match(/https?:\/\/\S+activate\S+/) ?? [''])[0];
    if (!patient.activation) throw new Error('no portal activation link was shown');

    // The natural next step is offered right there.
    await page.getByRole('button', { name: 'Book appointment' }).click();
    const d = dialog(page);
    const doctor = d.getByLabel('Doctor');
    const options = await doctor.locator('option').allInnerTexts();
    await doctor.selectOption({ label: options.find((o) => /Gentiana Bytyqi/.test(o)) });
    await d.getByRole('button', { name: 'Other time' }).click();
    const at = new Date(Date.now() + 15 * 60_000);
    const pad = (n) => String(n).padStart(2, '0');
    await d
      .getByLabel('Date and time')
      .fill(
        `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`,
      );
    await d.getByLabel('Reason for the visit').fill('Cough and fever for three days');
    await d.getByRole('button', { name: 'Book appointment' }).click();
    await expectClosed(page, 'booking');
  },
);

await as('reception@pacient.local', 'Front desk checks the patient in on arrival', async (page) => {
  const row = page.locator('tr', { hasText: patient.lastName }).first();
  await row.getByRole('button', { name: 'Check in' }).click();
  await settle(page);
  if (!/Checked in/.test(await text(row))) throw new Error('the appointment is not checked in');
});

/* ------------------------------------------------------------------ the visit ------------ */

await as(
  'doctor@pacient.local',
  'Doctor sees the patient waiting and opens the chart',
  async (page) => {
    const card = page.locator('.card', { hasText: 'Patients waiting' });
    await card
      .locator('li', { hasText: patient.lastName })
      .getByRole('link', { name: /Open chart/ })
      .click();
    await page.waitForURL(/\/doctor\/patients\//);
    await settle(page);
    patient.id = page.url().split('/patients/')[1].split(/[?#]/)[0];
    await page.getByRole('button', { name: 'Join care team' }).click();
    await settle(page);
    if ((await page.locator('.area-tab').count()) < 6) throw new Error('the chart did not open');
  },
);

await as(
  'doctor@pacient.local',
  'Doctor records the visit: note, diagnosis, allergy, vital signs',
  async (page) => {
    const d = dialog(page);
    await page.goto(chart('doctor', 'visits'));
    await settle(page);
    await page.getByRole('button', { name: 'New visit' }).click();
    await d.getByLabel('Visit type').selectOption({ index: 1 });
    await d.getByLabel('Reason for visit').fill('Cough and fever for three days');
    await d
      .getByLabel('Clinical note')
      .fill('Productive cough, temperature 38.4. Crackles at the right base.');
    await d.getByRole('button', { name: 'Save draft' }).click();
    await expectClosed(page, 'visit');

    await page.goto(chart('doctor', 'problems'));
    await settle(page);
    await page.getByRole('button', { name: 'Add diagnosis' }).click();
    await d.getByLabel('ICD-10 code').fill('J18.9');
    await d.getByLabel('Description').fill('Pneumonia, unspecified');
    await d.locator('button[type=submit]').click();
    await expectClosed(page, 'diagnosis');

    await page.goto(chart('doctor', 'allergies'));
    await settle(page);
    await page.getByRole('button', { name: 'Add allergy' }).click();
    await d.getByLabel('Substance').fill('Penicillin');
    await d.getByLabel('Reaction').fill('Rash');
    await d.getByLabel('Severity').selectOption('MODERATE');
    await d.locator('button[type=submit]').click();
    await expectClosed(page, 'allergy');

    await page.goto(chart('doctor', 'vitals'));
    await settle(page);
    await page
      .getByRole('button', { name: /Record vital/ })
      .first()
      .click();
    await d.getByLabel('Systolic (mmHg)').fill('128');
    await d.getByLabel('Diastolic (mmHg)').fill('82');
    await d.getByLabel('Heart rate (bpm)').fill('104');
    await d.getByLabel('Temperature (°C)').fill('38.4');
    await d.getByLabel('Respiratory rate').fill('22');
    await d.getByLabel('SpO₂ (%)').fill('94');
    await d.getByLabel('Weight (kg)').fill('68');
    await d.locator('button[type=submit]').click();
    await expectClosed(page, 'vital signs');
    if (!/128\/82/.test(await text(panel(page)))) throw new Error('the vital signs are not listed');
  },
);

await as(
  'doctor@pacient.local',
  'Doctor orders a test and prescribes (allergy check stops penicillin)',
  async (page) => {
    const d = dialog(page);
    await page.goto(chart('doctor', 'results'));
    await settle(page);
    await page.getByRole('button', { name: 'Order test' }).click();
    await d.getByLabel('Test').selectOption({ index: 1 });
    await d.getByLabel('Clinical information for the laboratory').fill('Suspected pneumonia');
    await d.getByRole('button', { name: 'Send order' }).click();
    await expectClosed(page, 'laboratory order');
    patient.orderNumber = (await panel(page).locator('tr .mono').first().innerText()).trim();

    await page.goto(chart('doctor', 'medications'));
    await settle(page);
    await page.getByRole('button', { name: 'Prescribe', exact: true }).click();
    const medication = d.locator('input[name=medication]');
    await medication.fill('Amoxicillin 500 mg');
    await page.waitForTimeout(1800);
    if (!/Recorded allergy to Penicillin/.test(await text(d))) {
      throw new Error('no allergy alert for amoxicillin in a patient allergic to penicillin');
    }
    await medication.fill('Azithromycin 500 mg');
    await page.waitForTimeout(1800);
    await d.getByLabel(/^Dose amount/).fill('500');
    await d.getByLabel('Frequency').selectOption({ index: 0 });
    await d.getByLabel('Duration (days)').fill('3');
    await d.locator('[name=instructions]').fill('Take after food.');
    await d.locator('button[type=submit]').last().click();
    await expectClosed(page, 'prescription');

    await page.goto(chart('doctor', 'visits'));
    await settle(page);
    await page.getByRole('button', { name: 'Sign note' }).first().click();
    await settle(page);
    if (await d.count()) {
      await d.locator('button').last().click();
      await settle(page);
    }
    if (!/signed/i.test(await text(panel(page)))) throw new Error('the note is not signed');
  },
);

/* ------------------------------------------------------------------ laboratory ----------- */

await as(
  'nurse@pacient.local',
  'Ward nurse opens the chart from a doctor link and takes the sample',
  async (page) => {
    await page.goto(chart('doctor', 'results'));
    await settle(page);
    if (!page.url().includes('/nurse/patients/')) throw new Error(`not redirected: ${page.url()}`);
    await page.getByRole('button', { name: 'Join care team' }).click();
    await settle(page);
    const row = page.locator('tr', { hasText: patient.orderNumber }).first();
    await row.getByRole('button', { name: /Specimen taken/ }).click();
    await settle(page);
    if (!/Specimen taken \d/.test(await text(row)))
      throw new Error('the sample is not marked as taken');
  },
);

await as(
  'lab@pacient.local',
  'Laboratory receives the sample and enters the result',
  async (page) => {
    const d = dialog(page);
    let row = page.locator('tr', { hasText: patient.orderNumber }).first();
    await row.getByRole('button', { name: /^Receive/ }).click();
    await d.locator('input').first().fill(patient.orderNumber);
    await d.getByRole('button', { name: 'Enter code' }).click();
    await settle(page);
    row = page.locator('tr', { hasText: patient.orderNumber }).first();
    await row.getByRole('button', { name: /^Enter result/ }).click();
    await d.locator('input[name=value]').fill('128');
    await d.getByRole('button', { name: /Save preliminary result/ }).click();
    await settle(page);
  },
);

await as(
  'lab2@pacient.local',
  'A second laboratory technician validates the result',
  async (page) => {
    await page.getByRole('tab', { name: /To validate/ }).click();
    await settle(page);
    await page
      .locator('tr', { hasText: patient.orderNumber })
      .first()
      .getByRole('button', { name: /^Validate/ })
      .click();
    await settle(page);
    const d = dialog(page);
    if (await d.count()) {
      await d.locator('button[type=submit], button.btn-primary').last().click();
      await settle(page);
    }
  },
);

await as(
  'doctor@pacient.local',
  'Doctor acknowledges the result and releases it to the patient',
  async (page) => {
    await page.goto(chart('doctor', 'results'));
    await settle(page);
    await panel(page)
      .getByRole('button', { name: /^Acknowledge/ })
      .first()
      .click();
    await settle(page);
    await panel(page)
      .getByRole('button', { name: /^Release to patient/ })
      .first()
      .click();
    await settle(page);
    if (!/Released to patient/.test(await text(panel(page))))
      throw new Error('the result is not released');
  },
);

/* ------------------------------------------------------------------ pharmacy ------------- */

await as(
  'pharmacist@pacient.local',
  'Pharmacist verifies, receives stock and dispenses',
  async (page) => {
    const d = dialog(page);
    const row = () =>
      page.locator('tr', { hasText: 'Azithromycin' }).filter({ hasText: patient.lastName }).first();
    const detail = page.locator('.split > :nth-child(2)');
    await row().click();
    await settle(page);
    await detail.getByRole('button', { name: /^Verify/ }).click();
    await d.locator('button[type=submit]').click();
    await expectClosed(page, 'verification');

    await page.goto(`${BASE}/pharmacy/stock`);
    await settle(page);
    await page.getByRole('tab', { name: 'Receive delivery' }).click();
    await settle(page);
    const form = panel(page);
    await form.getByLabel('Supplier').fill('Demo wholesaler');
    await form.getByLabel(/^Medicine/).fill('Azithro');
    await page.waitForTimeout(1500);
    await form
      .getByRole('button', { name: /Azithromycin 500 mg tablet/ })
      .first()
      .click();
    await form.getByLabel('Batch number').fill(`AZ-${stamp.slice(-5)}`);
    await form.getByLabel('Expiry date').fill(`${new Date().getFullYear() + 2}-06-30`);
    await form.getByLabel(/^Quantity/).fill('10');
    await form.getByRole('button', { name: /^Receive \d+ line/ }).click();
    await settle(page);

    await page.goto(`${BASE}/pharmacy`);
    await settle(page);
    await page.getByRole('tab', { name: /Ready to dispense/ }).click();
    await settle(page);
    await row().click();
    await settle(page);
    await detail.getByRole('button', { name: /^Dispense/ }).click();
    await d.getByRole('button', { name: /Azithromycin 500 mg tablet/ }).click();
    await page.waitForTimeout(800);
    await d.getByRole('button', { name: 'Dispense', exact: true }).click();
    await expectClosed(page, 'dispensing');
  },
);

/* ------------------------------------------------------------------ closing the visit ---- */

await as('doctor@pacient.local', 'Doctor completes the appointment', async (page) => {
  await page.goto(`${BASE}/doctor/schedule`);
  await settle(page);
  const row = () => page.locator('li', { hasText: patient.lastName }).first();
  await row()
    .getByRole('button', { name: /^Complete/ })
    .click();
  await settle(page);
  if (!/Completed/.test(await text(row()))) throw new Error('the appointment is not completed');
});

/* ------------------------------------------------------------------ hospital stay -------- */

await as('doctor@pacient.local', 'Doctor admits the patient to a bed', async (page) => {
  const d = dialog(page);
  await page.goto(chart('doctor', 'admissions'));
  await settle(page);
  await page.getByRole('button', { name: 'Admit to hospital' }).click();
  await page.waitForTimeout(800);
  await d.getByLabel('Ward').selectOption({ index: 1 });
  await page.waitForTimeout(600);
  await d.getByLabel('Bed').selectOption({ index: 1 });
  await d
    .getByLabel('Reason for admission')
    .fill('Community-acquired pneumonia, needs IV antibiotics');
  await d.locator('button[type=submit]').click();
  await settle(page);
  if (!/has been admitted/.test(await text(d)))
    throw new Error(`not admitted: ${(await text(d)).slice(-300)}`);
  await d.getByRole('button', { name: 'Later' }).click();
});

await as('nurse@pacient.local', 'Nurse finds the patient on the bed board', async (page) => {
  await page.goto(`${BASE}/wards`);
  await settle(page);
  if (!(await page.getByText(patient.lastName).count())) throw new Error('not on the bed board');
});

await as('doctor@pacient.local', 'Doctor discharges with a signed summary', async (page) => {
  const d = dialog(page);
  await page.goto(chart('doctor', 'admissions'));
  await settle(page);
  await page
    .getByRole('button', { name: /^Discharge/ })
    .first()
    .click();
  await settle(page, 1200);
  const summary = d.getByLabel(/^Discharge summary/);
  if (!(await summary.inputValue()).trim()) {
    await summary.fill(
      'Admitted with pneumonia, treated with antibiotics, improved. Discharged home.',
    );
  }
  await d.locator('button[type=submit]').click();
  await page.waitForTimeout(600);
  await d
    .getByRole('button', { name: /Sign and discharge/ })
    .last()
    .click();
  await expectClosed(page, 'discharge');
  if (!/Discharged/.test(await text(panel(page)))) throw new Error('the stay is not discharged');
});

/* ------------------------------------------------------------------ billing -------------- */

await as(
  'reception@pacient.local',
  'Front desk takes the co-payment and gives a receipt',
  async (page) => {
    await page.goto(`${BASE}/billing`);
    await settle(page);
    const main = page.locator('main');
    await main.getByLabel('Name or national ID').fill(patient.nationalId);
    await page.keyboard.press('Enter');
    await settle(page);
    await main
      .getByRole('button', { name: /Open account/ })
      .first()
      .click();
    await settle(page);
    await main.getByRole('button', { name: 'Select all to pay' }).click();
    await main.getByRole('button', { name: 'Take payment' }).click();
    await dialog(page).getByRole('button', { name: 'Confirm payment' }).click();
    await settle(page);
    if (!/Receipt no\./.test(await text(dialog(page)))) throw new Error('no receipt was shown');
  },
);

/* ------------------------------------------------------------------ the patient ---------- */

await step('Patient activates the portal account', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('pacient.locale', 'en');
      sessionStorage.setItem('pacient.localeChosen', '1');
    } catch {
      /* storage unavailable */
    }
  });
  const page = await ctx.newPage();
  await page.goto(patient.activation);
  await settle(page);
  const pw = page.locator('input[type=password]');
  await pw.nth(0).fill(PORTAL_PASSWORD);
  await pw.nth(1).fill(PORTAL_PASSWORD);
  await page.locator('button[type=submit]').click();
  await settle(page);
  if (!/Your account is ready/.test(await page.locator('body').innerText())) {
    throw new Error('the account was not activated');
  }
  await ctx.close();
});

await as(
  patient.email,
  'Patient finds the visit, result, appointment and who viewed the record',
  async (page) => {
    for (const [path, needle] of [
      ['/portal/history', /Pneumonia|J18\.9|Cough/],
      ['/portal/results', /Haemoglobin/],
      ['/portal/appointments', /Bytyqi/],
      ['/portal/stays', /pneumonia/i],
      ['/portal/billing', /Haemoglobin|€/],
      ['/portal/access-log', /Bytyqi/],
    ]) {
      await page.goto(BASE + path);
      await settle(page);
      if (!needle.test(await page.locator('main').innerText())) {
        throw new Error(`${path} does not show what the visit produced`);
      }
    }
  },
  PORTAL_PASSWORD,
);

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length} of ${results.length} steps passed for ${patient.firstName} ${patient.lastName} (${patient.nationalId}).`,
);
if (apiErrors.length) console.log(`Unexpected errors:\n  ${apiErrors.join('\n  ')}`);
process.exit(failed.length || apiErrors.length ? 1 : 0);
