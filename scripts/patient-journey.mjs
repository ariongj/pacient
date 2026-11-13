#!/usr/bin/env node
/* global document, window */
/**
 * Walks the whole patient cycle through the real user interface, as each role would:
 * the front desk registers a new patient and books and checks in an appointment; the doctor sees
 * the patient waiting, joins the care team, writes the visit, orders a test and an X-ray and
 * prescribes; the ward nurse takes the sample; the laboratory receives it, enters the result and
 * a second person validates it; the radiologist reports the X-ray; the doctor releases both; the
 * pharmacist verifies and dispenses from stock; the nurse vaccinates; the doctor issues a
 * certificate (checked publicly) and refers to another hospital, which accepts; the patient is
 * admitted, given a dose by scanning wristband and pack (a wrong pack is stopped) and discharged;
 * a letter is shared and a follow-up task done; the front desk takes the co-payment; and the
 * patient activates the portal, finds all of it in their own record and writes to the doctor.
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
  certificateCode: '',
};
/** Pack barcodes from the national catalogue: the prescribed medicine and a wrong one. */
const packs = { azithromycin: '', amoxicillin: '' };
/** A minimal synthetic PDF (the server checks the file signature). */
const LETTER = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);

const browser = await chromium.launch();
const results = [];
const apiErrors = [];
/** Denials a step expects, e.g. a record that is closed until a referral is accepted. */
let expectedDenials = [];

/** A browser of someone who is not signed in, with the interface in English. */
async function visitor() {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('pacient.locale', 'en');
      sessionStorage.setItem('pacient.localeChosen', '1');
    } catch {
      /* storage unavailable */
    }
  });
  return { ctx, page: await ctx.newPage() };
}

/** Signs in and returns a page that records failed API calls (expected denials aside). */
async function signIn(email, password = PASSWORD) {
  const { ctx, page } = await visitor();
  // A missing button should fail the step quickly, not hold the whole walk up.
  page.setDefaultTimeout(12_000);
  page.on('pageerror', (e) => apiErrors.push(`${email}: page error: ${e.message}`));
  page.on('response', (r) => {
    const path = r.url().replace(/^.*\/api\/v1/, '');
    // 401 before sign-in and the 403 that precedes "Join care team" are part of the design.
    const expected =
      r.status() === 401 ||
      (r.status() === 403 &&
        (/\/summary$/.test(path) || expectedDenials.some((re) => re.test(path))));
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

/** Chooses the option matching `pattern`, once the list has loaded. */
async function pick(select, pattern) {
  const option = select.locator('option').filter({ hasText: pattern }).first();
  await option.waitFor({ state: 'attached' });
  await select.selectOption({ label: (await option.innerText()).trim() });
}

/** Chooses the first real option (after the placeholder) of a list that loads from the server. */
async function pickFirst(select) {
  await select.locator('option').nth(1).waitFor({ state: 'attached' });
  await select.selectOption({ index: 1 });
}
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
  expectedDenials = [];
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
    await pick(d.getByLabel('Doctor'), /Gentiana Bytyqi/);
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
    await pickFirst(d.getByLabel('Test'));
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

await as('doctor@pacient.local', 'Doctor orders a chest X-ray', async (page) => {
  const d = dialog(page);
  await page.goto(chart('doctor', 'imaging'));
  await settle(page);
  await page.getByRole('button', { name: 'Order imaging' }).click();
  await d.getByLabel('Modality').selectOption({ index: 0 });
  await d.getByLabel('Body part / examination').fill('Chest PA');
  await d.getByLabel('Clinical question').fill('Pneumonia? Extent of the consolidation.');
  // Asked before any radiation for women who could be pregnant.
  const pregnant = d.getByLabel('Could the patient be pregnant?');
  if (await pregnant.count()) await pregnant.selectOption({ label: 'No' });
  await d.locator('button[type=submit]').click();
  await expectClosed(page, 'imaging order');
});

/* ------------------------------------------------------------------ laboratory ----------- */

await as(
  'nurse@pacient.local',
  'Ward nurse opens the chart from a doctor link and takes the sample',
  async (page) => {
    await page.goto(chart('doctor', 'results'));
    await settle(page);
    if (!page.url().includes('/nurse/patients/')) throw new Error(`not redirected: ${page.url()}`);
    // Offered either because the record is closed, or – for a nurse who also works in radiology
    // while the X-ray is open – as "Temporary access", which would end with the X-ray.
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

/* ------------------------------------------------------------------ radiology ------------ */

await as(
  'radiologist@pacient.local',
  'Radiologist performs the X-ray, writes and signs the report',
  async (page) => {
    const d = dialog(page);
    await page.goto(`${BASE}/imaging`);
    await settle(page);
    const row = () => page.locator('tr', { hasText: patient.lastName }).first();
    await row().getByRole('button', { name: 'Mark performed' }).click();
    await settle(page);
    if (await d.count()) {
      await d.locator('button[type=submit], .btn-primary').last().click();
      await settle(page);
    }
    await row()
      .getByRole('button', { name: /Write report/ })
      .click();
    await d
      .getByLabel('Findings')
      .fill('Consolidation in the right lower lobe. No pleural effusion.');
    await d.getByLabel('Impression').fill('Right lower lobe pneumonia.');
    await d.getByRole('button', { name: 'Review and sign' }).click();
    await page
      .getByRole('dialog')
      .last()
      .getByRole('button', { name: /^Sign report/ })
      .click();
    await expectClosed(page, 'imaging report');
  },
);

await as(
  'doctor@pacient.local',
  'Doctor reviews the X-ray report from the worklist and releases it',
  async (page) => {
    const card = page.locator('.card', { hasText: 'Imaging reports to review' });
    if (!(await card.getByText(patient.lastName).count())) {
      throw new Error('the signed report is not on the doctor’s worklist');
    }
    await page.goto(chart('doctor', 'imaging'));
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
    if (await dialog(page).count()) {
      await dialog(page).locator('button[type=submit], .btn-primary').last().click();
      await settle(page);
    }
    if (!/Released to patient/.test(await text(panel(page))))
      throw new Error('the report is not released');
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

await as('nurse@pacient.local', 'Nurse gives and records a flu vaccine', async (page) => {
  const d = dialog(page);
  await page.goto(chart('nurse', 'vaccinations'));
  await settle(page);
  await page.getByRole('button', { name: 'Record vaccination' }).first().click();
  await d.getByLabel('Vaccine').fill('Influenza (seasonal)');
  await d.getByLabel('Lot number').fill(`FLU-${stamp.slice(-4)}`);
  await d.getByLabel('Site').fill('Left deltoid');
  await d.getByRole('button', { name: 'Save' }).click();
  await expectClosed(page, 'vaccination');
  if (!/Influenza/.test(await text(panel(page)))) throw new Error('the vaccination is not listed');
});

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

await as('doctor@pacient.local', 'Doctor issues a sick-leave certificate', async (page) => {
  const d = dialog(page);
  await page.goto(chart('doctor', 'certificates'));
  await settle(page);
  await page.getByRole('button', { name: 'Issue a certificate' }).click();
  const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  await d.getByLabel(/^From/).fill(day(0));
  await d.getByLabel(/^Until/).fill(day(4));
  await d.getByLabel(/^Diagnosis/).fill('J18.9');
  await d.getByRole('button', { name: 'Issue certificate' }).click();
  await expectClosed(page, 'certificate');
  await panel(page).getByRole('button', { name: 'Show and print' }).first().click();
  await settle(page);
  patient.certificateCode = (await d.locator('.cs-qr > div').last().innerText()).trim();
  if (!patient.certificateCode) throw new Error('the printed certificate has no verification code');
});

await step('An employer verifies the certificate without signing in', async () => {
  const { ctx, page } = await visitor();
  await page.goto(`${BASE}/verify/${patient.certificateCode}`);
  await settle(page, 800);
  const shown = await text(page.locator('body'));
  await ctx.close();
  if (!/valid/i.test(shown) || /No certificate matches/.test(shown))
    throw new Error('the certificate is not shown as valid');
  // Only initials and the birth year are public – never the name or the diagnosis.
  if (shown.includes(patient.lastName) || shown.includes('J18'))
    throw new Error('the public check shows the name or the diagnosis');
});

/* ------------------------------------------------------------------ referral ------------- */

await as('doctor@pacient.local', 'Doctor refers the patient to Prizren', async (page) => {
  const d = dialog(page);
  await page.goto(chart('doctor', 'summary'));
  await settle(page);
  await page.getByRole('button', { name: 'Refer', exact: true }).click();
  await pick(d.getByLabel(/^Receiving facility/), /Prizren/);
  await d.getByLabel(/^Specialty/).fill('Pulmonology');
  await d.getByLabel(/^Reason/).fill('Slow recovery after pneumonia');
  const summary = d.getByLabel(/^Clinical summary/);
  if (!(await summary.inputValue()).trim())
    await summary.fill('Pneumonia treated with azithromycin; cough persists.');
  await d.getByRole('button', { name: 'Send referral' }).click();
  await settle(page);
  if (!/Referral sent/.test(await text(d))) throw new Error('the referral was not sent');
  await d.locator('.form-actions').getByRole('button', { name: 'Close' }).click();
});

await as(
  'doctor5@pacient.local',
  'Receiving doctor in Prizren accepts the referral and opens the record',
  async (page) => {
    // Before accepting, the receiving doctor sees the referral summary but not the record.
    expectedDenials = [new RegExp(`^/patients/${patient.id}$`)];
    await page.goto(chart('doctor', 'summary'));
    await settle(page);
    if (await page.locator('.area-tab').count())
      throw new Error('the record was open before the referral was accepted');
    await page.goto(`${BASE}/doctor/referrals`);
    await settle(page);
    const item = page.locator('main li').filter({ hasText: patient.lastName }).first();
    await item.getByRole('button', { name: /^Accept/ }).click();
    await settle(page);
    if (await dialog(page).count()) {
      await dialog(page).locator('button[type=submit], .btn-primary').last().click();
      await settle(page);
    }
    await item.getByRole('link', { name: /Open patient record/ }).click();
    await settle(page);
    if ((await page.locator('.area-tab').count()) < 6)
      throw new Error('the record did not open after acceptance');
  },
);

/* ------------------------------------------------------------------ hospital stay -------- */

await as('doctor@pacient.local', 'Doctor admits the patient to the ward', async (page) => {
  const d = dialog(page);
  await page.goto(chart('doctor', 'admissions'));
  await settle(page);
  await page.getByRole('button', { name: 'Admit to hospital' }).click();
  await page.waitForTimeout(800);
  await pickFirst(d.getByLabel('Ward'));
  await page.waitForTimeout(600);
  // A full ward still admits: the patient waits for a bed and is listed on the bed board.
  const bed = d.getByLabel('Bed');
  if ((await bed.locator('option').count()) > 1) await bed.selectOption({ index: 1 });
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

await as(
  'minister@pacient.local',
  'The national medicine catalogue holds each pack’s barcode',
  async (page) => {
    await page.goto(`${BASE}/ministry/catalogue`);
    await settle(page);
    const main = page.locator('main');
    for (const [key, name, form] of [
      ['azithromycin', 'Azithromycin', 'tablet'],
      ['amoxicillin', 'Amoxicillin', 'capsule'],
    ]) {
      await main.getByLabel('Search').fill(name);
      await page.keyboard.press('Enter');
      await settle(page);
      const row = main
        .locator('tbody tr')
        .filter({ hasText: new RegExp(`^${name}\\b`) })
        .filter({ hasText: form })
        .first();
      packs[key] = (await row.locator('td').nth(3).innerText()).trim();
      if (!/^\d{8,14}$/.test(packs[key])) throw new Error(`${name} has no pack barcode`);
    }
  },
);

await as(
  'nurse@pacient.local',
  'Nurse prints the wristband and gives a dose by scanning (a wrong pack is stopped)',
  async (page) => {
    const d = dialog(page);
    await page.addInitScript(() => {
      window.print = () => {};
    });
    await page.goto(`${BASE}/wristband/${patient.id}`);
    await settle(page);
    const [created] = await Promise.all([
      page.waitForResponse((r) => /wristband/.test(r.url()) && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create and print wristband' }).click(),
    ]);
    // What the wristband's QR code holds, as a handheld scanner would type it.
    const { token } = await created.json();

    await page.goto(chart('nurse', 'mar'));
    await settle(page);
    await panel(page)
      .locator('li', { hasText: 'Azithromycin' })
      .getByRole('button', { name: 'Scan to give' })
      .click();
    const scan = async (code) => {
      await d.locator('.barcode-scanner input').fill(code);
      await d.getByRole('button', { name: 'Enter code' }).click();
      await settle(page, 200);
    };
    await scan(token);
    await scan(packs.amoxicillin);
    if (!/STOP – do not give/.test(await text(d)))
      throw new Error('the wrong medicine pack was not stopped');
    await scan(packs.azithromycin);
    if (!/Medicine: Azithromycin/.test(await text(d)))
      throw new Error(`the right pack was not confirmed: ${(await text(d)).slice(0, 300)}`);
    await d.getByRole('button', { name: 'Confirm dose given' }).click();
    await expectClosed(page, 'administration');
    const record = await text(panel(page));
    if (!/Given .*Scanned/.test(record.slice(record.indexOf('Administration record'))))
      throw new Error('the dose is not recorded as given with both scans');
  },
);

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

await as(
  'doctor@pacient.local',
  'Doctor shares a letter with the patient and asks the nurses for a follow-up call',
  async (page) => {
    const d = dialog(page);
    await page.goto(chart('doctor', 'documents'));
    await settle(page);
    await page.getByRole('button', { name: 'Upload document' }).first().click();
    await d
      .locator('input[type=file]')
      .setInputFiles({ name: 'letter.pdf', mimeType: 'application/pdf', buffer: LETTER });
    await d.getByLabel('Title').fill('Letter for the employer');
    await d.getByLabel('Category').selectOption({ index: 1 });
    await d.locator('input[name=visibleToPatient]').check();
    await d.locator('button[type=submit]').click();
    await expectClosed(page, 'document upload');
    if (!/Letter for the employer/.test(await text(panel(page))))
      throw new Error('the document is not listed');

    await page.goto(chart('doctor', 'tasks'));
    await settle(page);
    await page.getByRole('button', { name: 'New task' }).click();
    await d.getByLabel('Task').fill(`Phone ${patient.lastName} in three days about the cough`);
    await d.getByRole('button', { name: 'Create task' }).click();
    await expectClosed(page, 'care task');
  },
);

await as('nurse@pacient.local', 'Nurse makes the call and completes the task', async (page) => {
  await page.goto(`${BASE}/tasks`);
  await settle(page);
  const row = () =>
    page.locator('li, tr, article', { hasText: `Phone ${patient.lastName}` }).first();
  await row()
    .getByRole('button', { name: /^(Complete|Done)/ })
    .first()
    .click();
  await settle(page);
  if (await dialog(page).count()) {
    await dialog(page).locator('button[type=submit], .btn-primary').last().click();
    await settle(page);
  }
  if ((await row().count()) && !/Done|Completed/.test(await text(row())))
    throw new Error('the task is still open');
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
  const { ctx, page } = await visitor();
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
  'Patient finds everything the cycle produced in their own record',
  async (page) => {
    for (const [path, needle] of [
      ['/portal/history', /Pneumonia|J18\.9|Cough/],
      ['/portal/results', /Haemoglobin/],
      ['/portal/imaging', /Right lower lobe pneumonia/],
      ['/portal/appointments', /Bytyqi/],
      ['/portal/vaccinations', /Influenza/],
      ['/portal/certificates', /Sick leave/i],
      ['/portal/referrals', /Prizren/],
      ['/portal/stays', /pneumonia/i],
      ['/portal/documents', /Letter for the employer/],
      ['/portal/billing', /Haemoglobin|€/],
      ['/portal/access-log', /Bytyqi/],
    ]) {
      await page.goto(BASE + path);
      await settle(page);
      if (!needle.test(await page.locator('main').innerText())) {
        throw new Error(`${path} does not show what the cycle produced`);
      }
    }
  },
  PORTAL_PASSWORD,
);

/* ------------------------------------------------------------------ messages ------------- */

const SUBJECT = `Cough after the antibiotics (${patient.lastName})`;
const ANSWER = 'Come on Friday morning for a short check – no appointment needed.';

await as(
  patient.email,
  'Patient writes to the doctor',
  async (page) => {
    const d = dialog(page);
    await page.goto(`${BASE}/portal/messages`);
    await settle(page);
    await page.getByRole('button', { name: 'New message' }).click();
    // Only doctors of the patient's care team can be written to.
    await pick(d.getByLabel('Doctor'), /Bytyqi/);
    await d.getByLabel('Subject').fill(SUBJECT);
    await d.getByLabel('Message').fill('The cough is better but not gone. Should I come back?');
    await d.getByRole('button', { name: 'Send' }).click();
    await expectClosed(page, 'message');
  },
  PORTAL_PASSWORD,
);

await as('doctor@pacient.local', 'Doctor answers the message', async (page) => {
  await page.goto(`${BASE}/messages`);
  await settle(page);
  await page.locator('li, tr, a, button', { hasText: SUBJECT }).first().click();
  await settle(page);
  await page.locator('main textarea[name=reply]').fill(ANSWER);
  await page.getByRole('button', { name: 'Send' }).last().click();
  await settle(page);
  if (!(await page.locator('main').innerText()).includes(ANSWER))
    throw new Error('the answer is not in the conversation');
});

await as(
  patient.email,
  'Patient reads the answer',
  async (page) => {
    await page.goto(`${BASE}/portal/messages`);
    await settle(page);
    await page.locator('li, tr, a, button', { hasText: SUBJECT }).first().click();
    await settle(page);
    if (!(await page.locator('main').innerText()).includes(ANSWER))
      throw new Error('the patient does not see the answer');
  },
  PORTAL_PASSWORD,
);

/* ------------------------------------------------------------------ emergency ------------ */
// A man collapses in the street: 112 call, ambulance, handover of an unidentified patient, triage,
// treatment, admission and identification. Then the patient of the cycle above comes to the
// emergency department with a cut hand, is sent home, and finds the advice in the portal.

const ems = { complaint: `Collapsed in the street ${stamp}`, patientId: '' };
const callPanel = (page) => page.getByRole('dialog').first();
const subDialog = (page) => page.getByRole('dialog').last();
async function openCall(page) {
  if (await page.getByRole('dialog').count()) return;
  await page.goto(`${BASE}/ems`);
  await settle(page);
  await page
    .locator('tr', { hasText: ems.complaint })
    .first()
    .getByRole('button', { name: /Open/ })
    .click();
  await settle(page);
}
async function crewStep(page, name) {
  await openCall(page);
  await callPanel(page).getByRole('button', { name, exact: true }).click();
  await settle(page);
}
async function addCare(page, kind, fill) {
  await openCall(page);
  const d = callPanel(page);
  await d.locator('select[name=kind]').selectOption({ label: kind });
  await fill(d);
  await d.getByRole('button', { name: 'Add to the record' }).click();
  await settle(page);
}
const edCard = (page, text) => page.locator('main article.ed-card', { hasText: text }).first();

await as(
  'nurse@pacient.local',
  'Ambulance service takes a 112 call and dispatches a vehicle',
  async (page) => {
    await page.goto(`${BASE}/ems`);
    await settle(page);
    await page.getByRole('button', { name: 'New emergency call' }).click();
    const d = dialog(page);
    await d.getByLabel('Caller', { exact: true }).fill('Passer-by');
    await d.getByLabel('Caller’s phone').fill('+38344000111');
    await d.getByLabel(/^Address/).fill(`Rr. Nëna Terezë ${stamp.slice(-3)}, Prishtinë`);
    await d.getByLabel('Municipality').fill('Prishtinë');
    await d.getByLabel(/^What happened/).fill(ems.complaint);
    await d.getByLabel(/^Description of the person/).fill('Man about 50, blue jacket');
    await d.getByLabel('Is the person conscious?').check();
    await d.getByLabel('Are they breathing normally?').check();
    await d.getByLabel('Chest pain?').check();
    await d.getByRole('button', { name: 'Record the call' }).click();
    await settle(page);
    await openCall(page);
    await callPanel(page).getByRole('button', { name: 'Dispatch a vehicle' }).click();
    await subDialog(page).getByRole('button', { name: 'Dispatch', exact: true }).click();
    await settle(page);
    await openCall(page);
    if (!/Dispatched/.test(await text(callPanel(page)))) throw new Error('no vehicle dispatched');
  },
);

await as(
  'nurse@pacient.local',
  'Crew on scene: observations, aspirin, leaves for hospital with an arrival time',
  async (page) => {
    await crewStep(page, 'Arrived on scene');
    await addCare(page, 'Observations', async (d) => {
      for (const [name, value] of [
        ['systolic', '92'],
        ['diastolic', '58'],
        ['heartRate', '118'],
        ['respiratoryRate', '24'],
        ['spo2', '91'],
        ['gcs', '14'],
        ['temperature', '36.4'],
      ]) {
        await d.locator(`input[name=${name}]`).fill(value);
      }
      await d.locator('select[name=onOxygen]').selectOption({ label: 'Air' });
    });
    await addCare(page, 'Medicine given', async (d) => {
      await d.locator('input[name=medication]').fill('Aspirin');
      await d.locator('input[name=dose]').fill('300 mg');
      await d.locator('input[name=route]').fill('chewed');
    });
    await crewStep(page, 'Leave for hospital');
    await pickFirst(subDialog(page).locator('select[name=destination]'));
    await subDialog(page).locator('input[name=eta]').fill('8');
    await subDialog(page).getByRole('button', { name: 'Leave and alert the hospital' }).click();
    await settle(page);
    await openCall(page);
    if (!/Transporting/.test(await text(callPanel(page)))) throw new Error('not transporting');
  },
);

await as(
  'doctor@pacient.local',
  'Emergency department sees the ambulance coming and when it will arrive',
  async (page) => {
    await page.goto(`${BASE}/ed`);
    await settle(page);
    const card = page.locator('li', { hasText: ems.complaint }).first();
    const shown = await text(card);
    if (!/Expected \d{1,2}:\d{2} · in [78] min/.test(shown))
      throw new Error(`no expected arrival time: ${shown.slice(0, 200)}`);
    if (!/NEWS2 \d+/.test(shown)) throw new Error('no early warning score from the crew');
  },
);

await as(
  'nurse@pacient.local',
  'Crew arrives; the emergency nurse takes the handover of the unidentified man',
  async (page) => {
    await crewStep(page, 'Arrived at hospital');
    await page.goto(`${BASE}/ed`);
    await settle(page);
    await page
      .locator('li', { hasText: ems.complaint })
      .first()
      .getByRole('button', { name: /Take handover/ })
      .click();
    await subDialog(page).getByLabel(/^Sex/).selectOption('MALE');
    await subDialog(page)
      .getByLabel(/^Estimated age/)
      .fill('50');
    await subDialog(page).getByRole('button', { name: 'Take handover' }).click();
    await settle(page);
    if (!/Unknown patient TMP\d+/.test(await text(edCard(page, ems.complaint))))
      throw new Error('no temporary record on the board');
  },
);

await as(
  'nurse@pacient.local',
  'Crew closes the call; the ambulance is available again',
  async (page) => {
    await crewStep(page, 'Close the call and make the vehicle available');
    await page.goto(`${BASE}/ems`);
    await settle(page);
    if (await page.locator('tr', { hasText: ems.complaint }).count())
      throw new Error('the call is still open');
  },
);

await as('nurse@pacient.local', 'Triage shows what the crew measured and gave', async (page) => {
  await page.goto(`${BASE}/ed`);
  await settle(page);
  await edCard(page, ems.complaint)
    .getByRole('button', { name: /^Triage/ })
    .click();
  const d = subDialog(page);
  await d.locator('.prehospital').waitFor();
  const crew = await text(d.locator('.prehospital'));
  if (!/BP 92\/58/.test(crew) || !/Aspirin 300 mg/.test(crew))
    throw new Error(`the crew's record is not shown: ${crew.slice(0, 200)}`);
  await d.getByLabel(/^2 · Very urgent/).check();
  for (const [name, value] of [
    ['systolic', '95'],
    ['diastolic', '60'],
    ['heartRate', '115'],
    ['respiratoryRate', '22'],
    ['spo2', '93'],
    ['painScore', '6'],
  ]) {
    await d.locator(`input[name=${name}]`).fill(value);
  }
  await d.locator('textarea[name=note]').fill('Chest pain, sweaty, pale.');
  await d.getByRole('button', { name: 'Save triage' }).click();
  await expectClosed(page, 'triage');
});

await as(
  'doctor@pacient.local',
  'Emergency doctor treats; the chart keeps the ambulance record',
  async (page) => {
    await page.goto(`${BASE}/ed`);
    await settle(page);
    await edCard(page, ems.complaint)
      .getByRole('button', { name: /^Start treatment/ })
      .click();
    await pick(subDialog(page).getByLabel(/^Treating doctor/), /Bytyqi/);
    await subDialog(page).locator('button[type=submit]').click();
    await expectClosed(page, 'start of treatment');
    await edCard(page, ems.complaint)
      .getByRole('link', { name: /Open record/ })
      .click();
    await page.waitForURL(/\/doctor\/patients\//);
    await settle(page);
    ems.patientId = page.url().split('/patients/')[1].split(/[?#]/)[0];
    const tab = await text(panel(page));
    if (!/Ambulance calls/.test(tab) || !/Aspirin 300 mg/.test(tab))
      throw new Error('the chart does not show the ambulance record');
  },
);

await as('doctor@pacient.local', 'Emergency doctor admits him to a ward', async (page) => {
  await page.goto(`${BASE}/ed`);
  await settle(page);
  await edCard(page, ems.complaint)
    .getByRole('button', { name: /^Admit/ })
    .click();
  const d = subDialog(page);
  // A ward with a free bed (the admission itself also works without one).
  await pick(d.getByLabel(/^Ward/), /– [1-9]\d* of \d+ beds free/);
  await page.waitForTimeout(600);
  const bed = d.getByLabel(/^Bed/);
  if ((await bed.locator('option').count()) > 1) await bed.selectOption({ index: 1 });
  await d.getByLabel(/^Reason for admission/).fill('Suspected acute coronary syndrome');
  await d.locator('button[type=submit]').last().click();
  await expectClosed(page, 'admission from the emergency department');
  const left = await text(page.locator('main'));
  if (!new RegExp(`Unknown patient TMP\\d+[^|]*?Admitted`).test(left.replace(/\s+/g, ' ')))
    throw new Error('not listed as admitted');
});

await as(
  'nurse@pacient.local',
  'Nurse confirms his identity when the family arrives',
  async (page) => {
    await page.goto(`${BASE}/nurse/patients/${ems.patientId}`);
    await settle(page);
    await page
      .getByRole('button', { name: /Confirm identity/ })
      .first()
      .click();
    const d = subDialog(page);
    await d.getByLabel(/^National ID/).fill(`1975${stamp.slice(-6)}`);
    await d.getByLabel(/^Sex/).selectOption('MALE');
    await d.getByLabel(/^First name/).fill('Besnik');
    await d.getByLabel(/^Last name/).fill(`Emergency${stamp.slice(-5)}`);
    await d.getByLabel(/^Date of birth/).fill('1975-06-02');
    await d.getByRole('button', { name: 'Confirm identity' }).click();
    await expectClosed(page, 'identity');
    if (!(await text(page.locator('.patient-banner'))).includes(`Emergency${stamp.slice(-5)}`))
      throw new Error('the record still shows the temporary identity');
  },
);

const CUT = `Cut on the left hand ${stamp.slice(-4)}`;
const ADVICE = 'Four sutures. Have them removed in 10 days at your family doctor.';

await as(
  'reception@pacient.local',
  'Walk-in: the patient comes back with a cut hand and the front desk registers the arrival',
  async (page) => {
    await page.goto(`${BASE}/ed`);
    await settle(page);
    await page.getByRole('button', { name: 'Register arrival' }).click();
    const d = dialog(page);
    await d.getByLabel(/^Find patient/).fill(patient.nationalId);
    await d.getByRole('button', { name: 'Search' }).click();
    await d.getByRole('radio', { name: new RegExp(patient.lastName) }).check();
    await d.locator('textarea[name=chiefComplaint]').fill(CUT);
    await d.getByRole('button', { name: 'Register arrival' }).click();
    await expectClosed(page, 'arrival');
  },
);

await as('nurse@pacient.local', 'Nurse triages the cut hand', async (page) => {
  await page.goto(`${BASE}/ed`);
  await settle(page);
  await edCard(page, CUT)
    .getByRole('button', { name: /^Triage/ })
    .click();
  await subDialog(page)
    .getByLabel(/^4 · Standard/)
    .check();
  await subDialog(page).locator('input[name=painScore]').fill('4');
  await subDialog(page).getByRole('button', { name: 'Save triage' }).click();
  await expectClosed(page, 'triage');
});

await as(
  'doctor2@pacient.local',
  'Emergency doctor sutures and sends the patient home with advice',
  async (page) => {
    await page.goto(`${BASE}/ed`);
    await settle(page);
    await edCard(page, CUT)
      .getByRole('button', { name: /^Start treatment/ })
      .click();
    await pick(subDialog(page).getByLabel(/^Treating doctor/), /Musliu/);
    await subDialog(page).locator('button[type=submit]').click();
    await expectClosed(page, 'start of treatment');
    await edCard(page, CUT)
      .getByRole('button', { name: /^Departure/ })
      .click();
    await subDialog(page)
      .getByLabel(/^Outcome/)
      .selectOption('DISCHARGED');
    await subDialog(page).locator('textarea').first().fill(ADVICE);
    await subDialog(page).getByRole('button', { name: 'Confirm departure' }).click();
    await expectClosed(page, 'departure');
  },
);

await as(
  'doctor@pacient.local',
  'The family doctor is told about the emergency visit',
  async (page) => {
    await page.goto(`${BASE}/notifications`);
    await settle(page);
    const item = page
      .locator('main li', { hasText: 'A patient in your care attended the emergency department' })
      .first();
    await item.waitFor();
    await page.goto(chart('doctor', 'emergency'));
    await settle(page);
    if (!(await text(panel(page))).includes(ADVICE)) throw new Error('no advice in the chart');
  },
);

await as(
  patient.email,
  'Patient finds the emergency visit and the advice in the portal',
  async (page) => {
    await page.goto(`${BASE}/portal/emergency`);
    await settle(page);
    const main = await text(page.locator('main'));
    if (!main.includes(CUT) || !main.includes(ADVICE))
      throw new Error('the emergency visit or the advice is missing');
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
