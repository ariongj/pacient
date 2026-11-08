import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  admissions,
  beds,
  careUnits,
  caseReports,
  edVisits,
  notifiableDiseases,
  patients,
  waitingListEntries,
} from '../src/db/schema.js';
import { DATASETS } from '../src/modules/opendata/datasets.js';
import {
  clearOpenDataCache,
  openDataLimiter,
  setOpenDataRateLimit,
} from '../src/modules/opendata/opendata.routes.js';
import { suppressGroup, THRESHOLD } from '../src/modules/opendata/suppression.js';
import { OPENDATA_DATASET_IDS } from '../src/openapi/opendata.js';
import { api, createFacility, createPatient, createUser } from './helpers.js';

const BASE = '/api/v1/open-data';
const DAY = 86_400_000;
const tag = Math.random().toString(36).slice(2, 8);
const FACILITY = `Open Data Hospital ${tag}`;
const DISEASE = `OD_${tag}`.toUpperCase();
const DISEASE2 = `OD2_${tag}`.toUpperCase();
const PERSONAL = [
  'nationalId',
  'firstName',
  'lastName',
  'dateOfBirth',
  'patientId',
  'userId',
  'email',
  'sex',
  'chiefComplaint',
  'reason',
  'clinicalReason',
  'details',
];

let patientMarkers: string[] = [];

beforeAll(async () => {
  clearOpenDataCache();
  const facility = await createFacility({
    name: FACILITY,
    municipality: 'Gjakovë',
    phone: '+383 390 000 000',
  });
  const doctor = await createUser('DOCTOR', facility.id);
  const [ward] = await db
    .insert(careUnits)
    .values({ facilityId: facility.id, name: 'Ward', code: `W${tag}`, type: 'GENERAL_WARD' })
    .returning();
  const [ed] = await db
    .insert(careUnits)
    .values({ facilityId: facility.id, name: 'ED', code: `E${tag}`, type: 'EMERGENCY' })
    .returning();
  await db.insert(careUnits).values({
    facilityId: facility.id,
    name: 'Old ICU',
    code: `I${tag}`,
    type: 'ICU',
    isActive: false,
  });
  const bedRows = await db
    .insert(beds)
    .values(
      Array.from({ length: 12 }, (_, i) => ({
        unitId: ward!.id,
        label: `B${i}`,
        status: i >= 10 ? ('OUT_OF_SERVICE' as const) : ('AVAILABLE' as const),
      })),
    )
    .returning();

  // Patients across three municipalities (6, 2 and 7 people).
  const people: (typeof patients.$inferSelect)[] = [];
  for (const [municipality, n] of [
    ['Pejë', 6],
    ['Prizren', 2],
    ['Ferizaj', 7],
  ] as const) {
    for (let i = 0; i < n; i++) {
      const p = await createPatient(facility.id);
      await db.update(patients).set({ municipality }).where(eq(patients.id, p.id));
      people.push({ ...p, municipality });
    }
  }
  patientMarkers = people.flatMap((p) => [p.nationalId, p.lastName]);

  // Bed occupancy: 6 patients in a bed since 2 days ago, 1 discharged before midnight, 1 cancelled.
  const twoDaysAgo = new Date(Date.now() - 2 * DAY);
  await db.insert(admissions).values([
    ...people.slice(0, 6).map((p, i) => ({
      patientId: p.id,
      facilityId: facility.id,
      unitId: ward!.id,
      bedId: bedRows[i]!.id,
      admittingDoctorId: doctor.id,
      attendingDoctorId: doctor.id,
      source: 'EMERGENCY' as const,
      reason: 'Private reason text',
      admittedAt: twoDaysAgo,
    })),
    {
      patientId: people[6]!.id,
      facilityId: facility.id,
      unitId: ward!.id,
      bedId: bedRows[6]!.id,
      admittingDoctorId: doctor.id,
      attendingDoctorId: doctor.id,
      source: 'ELECTIVE' as const,
      reason: 'x',
      admittedAt: twoDaysAgo,
      dischargedAt: new Date(twoDaysAgo.getTime() + 3_600_000),
      status: 'DISCHARGED' as const,
      disposition: 'HOME' as const,
    },
    {
      patientId: people[7]!.id,
      facilityId: facility.id,
      unitId: ward!.id,
      bedId: bedRows[7]!.id,
      admittingDoctorId: doctor.id,
      attendingDoctorId: doctor.id,
      source: 'ELECTIVE' as const,
      reason: 'x',
      admittedAt: twoDaysAgo,
      status: 'CANCELLED' as const,
    },
  ]);

  // ED: 8 seen after 10..80 minutes, 3 left without being seen.
  const arrived = new Date(Date.now() - 3 * DAY);
  await db.insert(edVisits).values([
    ...Array.from({ length: 8 }, (_, i) => ({
      patientId: people[i]!.id,
      facilityId: facility.id,
      unitId: ed!.id,
      arrivedAt: arrived,
      seenAt: new Date(arrived.getTime() + (i + 1) * 10 * 60_000),
      arrivalMode: 'WALK_IN' as const,
      chiefComplaint: 'Private complaint',
      registeredById: doctor.id,
      status: 'DISCHARGED' as const,
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      patientId: people[8 + i]!.id,
      facilityId: facility.id,
      unitId: ed!.id,
      arrivedAt: arrived,
      arrivalMode: 'WALK_IN' as const,
      chiefComplaint: 'Private complaint',
      registeredById: doctor.id,
      status: 'LEFT_WITHOUT_BEING_SEEN' as const,
    })),
  ]);

  // Waiting list: 6 orthopaedic operations (20 days each), 2 eye operations.
  const added = new Date(Date.now() - 30 * DAY);
  const done = new Date(Date.now() - 10 * DAY);
  await db.insert(waitingListEntries).values(
    [...Array(6).fill('ORTHOPAEDICS'), ...Array(2).fill('OPHTHALMOLOGY')].map((specialty, i) => ({
      patientId: people[i]!.id,
      facilityId: facility.id,
      specialty,
      procedureName: 'Private procedure',
      priority: 'ROUTINE',
      addedById: doctor.id,
      addedAt: added,
      targetDate: '2030-01-01',
      status: 'COMPLETED',
      completedAt: done,
    })),
  );

  // Notifiable disease: Pejë 6, Prizren 2, Ferizaj 7 cases (submitted), plus drafts not counted.
  const [disease] = await db
    .insert(notifiableDiseases)
    .values({
      code: DISEASE,
      name: `Open data fever ${tag}`,
      icd10Prefixes: ['A99'],
      urgency: 'WEEKLY',
    })
    .returning();
  const onset = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
  await db.insert(caseReports).values([
    ...people.map((p) => ({
      patientId: p.id,
      diseaseId: disease!.id,
      facilityId: facility.id,
      status: 'SUBMITTED',
      onsetDate: onset,
      details: { note: 'Private details' },
    })),
    ...people.slice(0, 3).map((p) => ({
      patientId: p.id,
      diseaseId: disease!.id,
      facilityId: facility.id,
      status: 'DRAFT',
      onsetDate: onset,
    })),
  ]);

  // A second disease: 3 cases one week and 6 two weeks earlier, all in Ferizaj.
  const [disease2] = await db
    .insert(notifiableDiseases)
    .values({
      code: DISEASE2,
      name: `Open data cough ${tag}`,
      icd10Prefixes: ['A98'],
      urgency: 'WEEKLY',
    })
    .returning();
  const earlier = new Date(Date.now() - 21 * DAY).toISOString().slice(0, 10);
  const ferizaj = people.filter((p) => p.municipality === 'Ferizaj');
  await db.insert(caseReports).values([
    ...ferizaj.slice(0, 3).map((p) => ({
      patientId: p.id,
      diseaseId: disease2!.id,
      facilityId: facility.id,
      status: 'REVIEWED',
      onsetDate: onset,
    })),
    ...ferizaj.slice(0, 6).map((p) => ({
      patientId: p.id,
      diseaseId: disease2!.id,
      facilityId: facility.id,
      status: 'SUBMITTED',
      onsetDate: earlier,
    })),
  ]);
});

afterAll(() => {
  setOpenDataRateLimit(null);
  clearOpenDataCache();
});

const get = async (dataset: string, query = '') => {
  const res = await api().get(`${BASE}/${dataset}${query}`);
  expect(res.status).toBe(200);
  return res;
};

describe('small-cell suppression', () => {
  it('hides small counts and, when one hidden cell could be worked out from a total, another one', () => {
    expect(THRESHOLD).toBe(5);
    // With a published total, the 3 could be worked out (33 - 10 - 20): the 10 is hidden too.
    expect(suppressGroup([10, 3, 20], 33)).toEqual({
      hidden: [true, true, false],
      totalHidden: false,
    });
    expect(suppressGroup([10, 3, 20]).hidden).toEqual([false, true, false]);
    // Zero is published: it reveals nothing about anybody.
    expect(suppressGroup([0, 12], 12)).toEqual({ hidden: [false, false], totalHidden: false });
    // Two hidden cells already protect each other.
    expect(suppressGroup([2, 3, 30], 35).hidden).toEqual([true, true, false]);
    // No other cell to hide: the total goes instead.
    expect(suppressGroup([3, 0], 3)).toEqual({ hidden: [true, false], totalHidden: true });
    expect(suppressGroup([3, 0, 0], 3).totalHidden).toBe(true);
  });
});

describe('open data API', () => {
  it('needs no sign-in and lists every dataset in three languages with the licence', async () => {
    const res = await api().get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.licence.name).toBe('CC BY 4.0');
    expect(res.body.licence.note.en).toMatch(/Ministry/);
    expect(res.body.smallCellThreshold).toBe(5);
    const ids = res.body.datasets.map((d: { id: string }) => d.id);
    expect(ids).toEqual(DATASETS.map((d) => d.id));
    expect(ids).toEqual(OPENDATA_DATASET_IDS);
    expect(ids).toHaveLength(9);
    for (const d of res.body.datasets) {
      for (const field of ['title', 'description', 'methodology']) {
        for (const lang of ['en', 'sq', 'sr']) expect(d[field][lang]).toBeTruthy();
        expect(d[field].sq).not.toBe(d[field].en);
        expect(d[field].sr).not.toBe(d[field].en);
      }
      for (const c of d.columns)
        for (const lang of ['en', 'sq', 'sr']) expect(c.label[lang]).toBeTruthy();
      expect(d.links.csv).toBe(`${BASE}/${d.id}?format=csv`);
    }
  });

  it('never returns personal data', async () => {
    clearOpenDataCache();
    for (const d of DATASETS) {
      const res = await get(d.id);
      const allowed = new Set([...d.columns.map((c) => c.key), 'suppressed']);
      for (const row of res.body.rows) {
        for (const key of Object.keys(row)) {
          expect(allowed.has(key), `${d.id}.${key}`).toBe(true);
          expect(PERSONAL).not.toContain(key);
        }
      }
      expect(res.body.generatedAt).toBeTruthy();
      expect(res.body.methodology).toBeTruthy();
      const text = JSON.stringify(res.body);
      for (const marker of patientMarkers) expect(text).not.toContain(marker);
      expect(text).not.toMatch(/Private (reason|complaint|procedure|details)/);
    }
  });

  it('publishes facilities with their services from active units', async () => {
    const res = await get('facilities', '?lang=sq');
    const row = res.body.rows.find((r: { name: string }) => r.name === FACILITY);
    expect(row).toMatchObject({
      municipality: 'Gjakovë',
      type: 'Spital rajonal',
      emergency: true,
      icu: false,
      maternity: false,
      suppressed: false,
    });
  });

  it('suppresses small waiting-time groups', async () => {
    const res = await get('waiting-times');
    const rows = res.body.rows.filter((r: { facility: string }) => r.facility === FACILITY);
    const ortho = rows.find((r: { specialty: string }) => r.specialty === 'Orthopaedics');
    const eye = rows.find((r: { specialty: string }) => r.specialty === 'Ophthalmology');
    expect(ortho).toMatchObject({ treated: 6, medianDays: 20, p90Days: 20, suppressed: false });
    expect(eye).toMatchObject({ treated: null, medianDays: null, p90Days: null, suppressed: true });
  });

  it('reports bed occupancy at midnight and emergency waits', async () => {
    const beds = (await get('bed-occupancy')).body.rows.find(
      (r: { facility: string }) => r.facility === FACILITY,
    );
    expect(beds).toMatchObject({ beds: 10, occupied: 6, occupancyPct: 60, suppressed: false });

    const ed = (await get('emergency-waiting')).body.rows.find(
      (r: { facility: string }) => r.facility === FACILITY,
    );
    expect(ed).toMatchObject({
      attendances: 11,
      medianMinutes: 45,
      leftWithoutBeingSeen: null,
      suppressed: true,
    });
    expect(ed.p90Minutes).toBeGreaterThanOrEqual(70);
  });

  it('applies secondary suppression to notifiable diseases by municipality', async () => {
    const rows = (await get('notifiable-diseases-municipality')).body.rows.filter(
      (r: { diseaseCode: string }) => r.diseaseCode === DISEASE,
    );
    const by = Object.fromEntries(
      rows.map((r: { municipality: string; cases: number | null }) => [r.municipality, r.cases]),
    );
    // Prizren (2) is hidden; Pejë (6, the smallest other) too, so Prizren cannot be worked out.
    expect(by).toEqual({ 'All (Kosovo)': 15, Ferizaj: 7, Pejë: null, Prizren: null });

    const weekly = (await get('notifiable-diseases')).body.rows.filter(
      (r: { diseaseCode: string }) => r.diseaseCode === DISEASE,
    );
    expect(weekly).toHaveLength(12);
    expect(weekly.reduce((a: number, r: { cases: number | null }) => a + (r.cases ?? 0), 0)).toBe(
      15,
    );

    // The 12-week total (9) is published by municipality, so the week with 3 cases could be
    // worked out from the week with 6: both are hidden.
    const second = (await get('notifiable-diseases')).body.rows.filter(
      (r: { diseaseCode: string }) => r.diseaseCode === DISEASE2,
    );
    expect(second.filter((r: { suppressed: boolean }) => r.suppressed)).toHaveLength(2);
    expect(second.every((r: { cases: number | null }) => r.cases === 0 || r.cases === null)).toBe(
      true,
    );
    const total = (await get('notifiable-diseases-municipality')).body.rows.filter(
      (r: { diseaseCode: string }) => r.diseaseCode === DISEASE2,
    );
    expect(total).toEqual([
      expect.objectContaining({ municipality: 'All (Kosovo)', cases: 9 }),
      expect.objectContaining({ municipality: 'Ferizaj', cases: 9 }),
    ]);
  });

  it('returns translated labels and methodology', async () => {
    const sr = (await get('bed-occupancy', '?lang=sr')).body;
    expect(sr.title).toBe('Popunjenost bolničkih kreveta');
    expect(sr.columns.map((c: { label: string }) => c.label)).toContain('Zauzeti');
    expect(sr.methodology).toMatch(/Brojevi od 1 do 4/);
    expect((await get('bed-occupancy', '?lang=sq')).body.title).toBe(
      'Zënia e shtretërve spitalorë',
    );
    expect((await api().get(`${BASE}/bed-occupancy?lang=de`)).status).toBe(400);
    expect((await api().get(`${BASE}/no-such-dataset`)).status).toBe(404);
  });

  it('downloads CSV with a byte order mark and headers in the chosen language', async () => {
    const sq = await get('facilities', '?format=csv&lang=sq');
    expect(sq.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(sq.headers['content-disposition']).toMatch(
      /^attachment; filename="facilities-\d{4}-\d{2}-\d{2}-sq\.csv"$/,
    );
    expect(sq.text.charCodeAt(0)).toBe(0xfeff);
    const [header, ...lines] = sq.text.slice(1).split('\r\n');
    expect(header).toMatch(/^Kodi,Institucioni,Lloji,Rajoni,Komuna,Adresa,Telefoni,Urgjenca,/);
    expect(header).toMatch(/,E fshehur$/);
    const ours = lines.find((l) => l.includes(FACILITY))!;
    expect(ours).toContain(',Spital rajonal,');
    expect(ours).toMatch(/,po,jo,/);
    // A phone number starting with + is protected against spreadsheet formulas.
    expect(ours).toContain(",'+383 390 000 000,");

    const sr = await get('facilities', '?format=csv&lang=sr');
    expect(sr.text.slice(1).split('\r\n')[0]).toMatch(/^Šifra,Ustanova,Vrsta,/);
    const en = await get('waiting-times', '?format=csv');
    const enLines = en.text.slice(1).split('\r\n');
    expect(enLines[0]).toBe(
      'Facility,Municipality,Specialty,Type of wait,Patients treated,Median wait (days),90% treated within (days),Suppressed',
    );
    // Suppressed cells are empty.
    expect(enLines).toContain(`${FACILITY},Gjakovë,Ophthalmology,Procedure,,,,yes`);
  });

  it('is cacheable by browsers, answers conditional requests and caches builds in memory', async () => {
    clearOpenDataCache();
    const first = await get('waiting-times');
    expect(first.headers['cache-control']).toBe('public, max-age=3600');
    expect(first.headers.pragma).toBeUndefined();
    expect(first.headers['access-control-allow-origin']).toBe('*');
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[\w-]+"$/);

    const notModified = await api().get(`${BASE}/waiting-times`).set('If-None-Match', etag);
    expect(notModified.status).toBe(304);

    // New data does not show until the cached build expires.
    const facility = await createFacility({ name: `Late ${tag}` });
    const doctor = await createUser('DOCTOR', facility.id);
    const p = await createPatient(facility.id);
    await db.insert(waitingListEntries).values(
      Array.from({ length: 5 }, () => ({
        patientId: p.id,
        facilityId: facility.id,
        specialty: 'UROLOGY',
        procedureName: 'x',
        priority: 'ROUTINE',
        addedById: doctor.id,
        addedAt: new Date(Date.now() - 5 * DAY),
        targetDate: '2030-01-01',
        status: 'COMPLETED',
        completedAt: new Date(),
      })),
    );
    const second = await get('waiting-times');
    expect(second.body.generatedAt).toBe(first.body.generatedAt);
    expect(second.headers.etag).toBe(etag);
    expect(second.body.rows.some((r: { facility: string }) => r.facility === `Late ${tag}`)).toBe(
      false,
    );

    clearOpenDataCache();
    const third = await get('waiting-times');
    expect(third.body.rows.some((r: { facility: string }) => r.facility === `Late ${tag}`)).toBe(
      true,
    );
    expect(third.headers.etag).not.toBe(etag);

    const index = await api().get(BASE);
    expect(index.headers['cache-control']).toBe('public, max-age=3600');
  });

  it('limits requests per address', async () => {
    for (const ip of ['::ffff:127.0.0.1', '127.0.0.1', '::1'])
      await openDataLimiter.resetKey(`opendata:${ip}`);
    setOpenDataRateLimit(3);
    for (let i = 0; i < 3; i++) expect((await api().get(BASE)).status).toBe(200);
    const blocked = await api().get(BASE);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blocked.headers.ratelimit).toBeTruthy();
    setOpenDataRateLimit(null);
  });
});
