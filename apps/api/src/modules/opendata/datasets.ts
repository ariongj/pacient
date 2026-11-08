import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { chapterOf, deathsForStats } from '../deaths/deaths.service.js';
import { coverage } from '../screening/screening.service.js';
import { casesForStats, isoWeek, lastWeeks } from '../surveillance/surveillance.service.js';
import { activeSchedule } from '../vaccination/vaccination.service.js';
import { COHORTS as VACCINE_COHORTS } from '../vaccination/vaccination.routes.js';
import { kosovoDate, WAIT_DAYS_SQL } from '../waiting/waiting.service.js';
import {
  ALL,
  ALL_CAUSES,
  CHAPTERS,
  COHORTS,
  FACILITY_TYPES,
  NOT_RECORDED,
  PROGRAMMES,
  SPECIALTIES,
  WAIT_KINDS,
  type L,
} from './labels.js';
import { isSmall, pct, suppressGroup, THRESHOLD } from './suppression.js';

/**
 * Public datasets: aggregate figures only. Every builder returns rows whose cells are numbers,
 * text, booleans, translated labels (L) or null (suppressed); `suppressed` marks rows with a
 * hidden cell. No row ever carries a patient, a staff member or a free-text field written about
 * a person.
 */
export type Cell = string | number | boolean | null | L;
export type Row = Record<string, Cell> & { suppressed: boolean };
export type ColumnType = 'text' | 'count' | 'number' | 'percent' | 'boolean';
export interface Column {
  key: string;
  type: ColumnType;
  label: L;
}
export interface Built {
  period: { from: string; to: string } | null;
  rows: Row[];
}
export interface Dataset {
  id: string;
  title: L;
  description: L;
  methodology: L;
  columns: Column[];
  build: (now: Date) => Promise<Built>;
}

const col = (key: string, type: ColumnType, en: string, sq: string, sr: string): Column => ({
  key,
  type,
  label: { en, sq, sr },
});
const SUPPRESSION_NOTE: L = {
  en: `Counts from 1 to ${THRESHOLD - 1} are not published, nor are values worked out from them; where a single hidden count could be calculated from a total, a second count is hidden too.`,
  sq: `Numrat nga 1 deri në ${THRESHOLD - 1} nuk publikohen, as vlerat që llogariten prej tyre; kur një numër i fshehur mund të nxirret nga totali, fshihet edhe një numër tjetër.`,
  sr: `Brojevi od 1 do ${THRESHOLD - 1} se ne objavljuju, kao ni vrednosti izračunate iz njih; kada bi se jedan skriveni broj mogao izračunati iz ukupnog, skriva se i drugi broj.`,
};
const methodology = (en: string, sq: string, sr: string): L => ({
  en: `${en} ${SUPPRESSION_NOTE.en}`,
  sq: `${sq} ${SUPPRESSION_NOTE.sq}`,
  sr: `${sr} ${SUPPRESSION_NOTE.sr}`,
});
const day = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => Number(v ?? 0);
const hideIf = (hidden: boolean, n: number) => (hidden ? null : n);

/* ------------------------------------------------------------------ 1. facilities --------- */

const SERVICE_COLUMNS: [string, string, string, string, string][] = [
  ['emergency', 'EMERGENCY', 'Emergency department', 'Urgjenca', 'Hitna pomoć'],
  ['maternity', 'MATERNITY', 'Maternity', 'Materniteti', 'Porodilište'],
  ['icu', 'ICU', 'Intensive care', 'Kujdesi intensiv', 'Intenzivna nega'],
  [
    'operatingTheatre',
    'OPERATING_THEATRE',
    'Operating theatres',
    'Sallat e operacionit',
    'Operacione sale',
  ],
  ['paediatrics', 'PAEDIATRIC', 'Paediatrics', 'Pediatria', 'Pedijatrija'],
  ['dialysis', 'DIALYSIS', 'Dialysis', 'Dializa', 'Dijaliza'],
  ['psychiatry', 'PSYCHIATRIC', 'Psychiatry', 'Psikiatria', 'Psihijatrija'],
  [
    'ambulance',
    'AMBULANCE_SERVICE',
    'Ambulance service',
    'Shërbimi i ambulancës',
    'Služba hitne pomoći',
  ],
];

const facilitiesDataset: Dataset = {
  id: 'facilities',
  title: { en: 'Health facilities', sq: 'Institucionet shëndetësore', sr: 'Zdravstvene ustanove' },
  description: {
    en: 'Public health facilities with their type, location and main services.',
    sq: 'Institucionet shëndetësore publike me llojin, vendndodhjen dhe shërbimet kryesore.',
    sr: 'Javne zdravstvene ustanove sa vrstom, lokacijom i glavnim uslugama.',
  },
  methodology: {
    en: 'Active facilities registered in Pacient; a service is listed when the facility has an active unit of that kind.',
    sq: 'Institucionet aktive të regjistruara në Pacient; një shërbim shfaqet kur institucioni ka një njësi aktive të atij lloji.',
    sr: 'Aktivne ustanove registrovane u Pacientu; usluga je navedena kada ustanova ima aktivnu jedinicu te vrste.',
  },
  columns: [
    col('code', 'text', 'Code', 'Kodi', 'Šifra'),
    col('name', 'text', 'Facility', 'Institucioni', 'Ustanova'),
    col('type', 'text', 'Type', 'Lloji', 'Vrsta'),
    col('region', 'text', 'Region', 'Rajoni', 'Region'),
    col('municipality', 'text', 'Municipality', 'Komuna', 'Opština'),
    col('address', 'text', 'Address', 'Adresa', 'Adresa'),
    col('phone', 'text', 'Phone', 'Telefoni', 'Telefon'),
    ...SERVICE_COLUMNS.map(([key, , en, sq, sr]) => col(key, 'boolean', en, sq, sr)),
  ],
  async build() {
    const result = await db.execute<Record<string, unknown>>(sql`
      SELECT f.code, f.name, f.type::text AS type, f.region, f.municipality, f.address, f.phone,
        coalesce(array_agg(DISTINCT cu.type::text) FILTER (WHERE cu.is_active), '{}') AS unit_types
      FROM facilities f
      LEFT JOIN care_units cu ON cu.facility_id = f.id
      WHERE f.is_active
      GROUP BY f.id
      ORDER BY f.name`);
    return {
      period: null,
      rows: result.rows.map((r) => {
        const types = new Set((r.unit_types as string[] | null) ?? []);
        const row: Row = {
          code: String(r.code),
          name: String(r.name),
          type: FACILITY_TYPES[String(r.type)] ?? String(r.type),
          region: String(r.region),
          municipality: String(r.municipality),
          address: r.address ? String(r.address) : null,
          phone: r.phone ? String(r.phone) : null,
          suppressed: false,
        };
        for (const [key, unitType] of SERVICE_COLUMNS) row[key] = types.has(unitType);
        return row;
      }),
    };
  },
};

/* ------------------------------------------------------------------ 2. waiting times ------ */

const waitingDataset: Dataset = {
  id: 'waiting-times',
  title: {
    en: 'Waiting times for planned care',
    sq: 'Kohët e pritjes për kujdesin e planifikuar',
    sr: 'Vreme čekanja na planiranu negu',
  },
  description: {
    en: 'Median and 90th percentile waits of patients treated from the elective waiting lists in the last 12 months, by facility and specialty.',
    sq: 'Pritja mesatare (mediana) dhe percentili i 90-të i pacientëve të trajtuar nga listat e pritjes në 12 muajt e fundit, sipas institucionit dhe specialitetit.',
    sr: 'Medijana i 90. percentil čekanja pacijenata lečenih sa lista čekanja u poslednjih 12 meseci, po ustanovi i specijalnosti.',
  },
  methodology: methodology(
    'Waiting time runs from the day the patient was added to the list until treatment, minus periods the patient asked to postpone.',
    'Koha e pritjes llogaritet nga dita kur pacienti u shtua në listë deri në trajtim, pa periudhat që pacienti kërkoi t’i shtyjë.',
    'Vreme čekanja računa se od dana kada je pacijent dodat na listu do lečenja, bez perioda koje je pacijent tražio da odloži.',
  ),
  columns: [
    col('facility', 'text', 'Facility', 'Institucioni', 'Ustanova'),
    col('municipality', 'text', 'Municipality', 'Komuna', 'Opština'),
    col('specialty', 'text', 'Specialty', 'Specialiteti', 'Specijalnost'),
    col('kind', 'text', 'Type of wait', 'Lloji i pritjes', 'Vrsta čekanja'),
    col('treated', 'count', 'Patients treated', 'Pacientë të trajtuar', 'Lečeni pacijenti'),
    col(
      'medianDays',
      'number',
      'Median wait (days)',
      'Pritja mediane (ditë)',
      'Medijana čekanja (dani)',
    ),
    col(
      'p90Days',
      'number',
      '90% treated within (days)',
      '90% të trajtuar brenda (ditë)',
      '90% lečeno u roku od (dani)',
    ),
  ],
  async build(now) {
    const since = new Date(now.getTime() - 365 * 86_400_000);
    const result = await db.execute<Record<string, unknown>>(sql`
      SELECT f.name AS facility, f.municipality, waiting_list_entries.specialty, waiting_list_entries.kind, count(*)::int AS n,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ${WAIT_DAYS_SQL}) AS median,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY ${WAIT_DAYS_SQL}) AS p90
      FROM waiting_list_entries
      JOIN facilities f ON f.id = waiting_list_entries.facility_id
      WHERE waiting_list_entries.status = 'COMPLETED' AND waiting_list_entries.completed_at >= ${since}
      GROUP BY f.name, f.municipality, waiting_list_entries.specialty, waiting_list_entries.kind
      ORDER BY f.name, waiting_list_entries.specialty`);
    return {
      period: { from: day(since), to: day(now) },
      rows: result.rows.map((r) => {
        const hidden = isSmall(num(r.n));
        return {
          facility: String(r.facility),
          municipality: String(r.municipality),
          specialty: SPECIALTIES[String(r.specialty)] ?? String(r.specialty),
          kind: WAIT_KINDS[String(r.kind)] ?? String(r.kind),
          treated: hideIf(hidden, num(r.n)),
          medianDays: hidden ? null : Math.round(num(r.median)),
          p90Days: hidden ? null : Math.round(num(r.p90)),
          suppressed: hidden,
        };
      }),
    };
  },
};

/* ------------------------------------------------------------------ 3. vaccination -------- */

const vaccinationDataset: Dataset = {
  id: 'vaccination-coverage',
  title: {
    en: 'Childhood vaccination coverage',
    sq: 'Mbulimi me vaksinim i fëmijëve',
    sr: 'Obuhvat dece vakcinacijom',
  },
  description: {
    en: 'Children of each age group who have received all doses due for their age, by municipality of residence.',
    sq: 'Fëmijët e secilës grupmoshë që kanë marrë të gjitha dozat për moshën e tyre, sipas komunës së banimit.',
    sr: 'Deca svake uzrasne grupe koja su primila sve doze za svoj uzrast, po opštini stanovanja.',
  },
  methodology: methodology(
    'Age groups follow the national calendar (12–23 months: hexavalent 3, pneumococcal 3, MMR 1; 24–35 months: hexavalent 3, MMR 1, first booster; 6–7 years: MMR 2, second booster). Age is counted on the day of publication.',
    'Grupmoshat ndjekin kalendarin kombëtar (12–23 muaj: heksavalente 3, pneumokoku 3, MMR 1; 24–35 muaj: heksavalente 3, MMR 1, përforcuesi i parë; 6–7 vjeç: MMR 2, përforcuesi i dytë). Mosha llogaritet në ditën e publikimit.',
    'Uzrasne grupe prate nacionalni kalendar (12–23 meseca: heksavalentna 3, pneumokokna 3, MMR 1; 24–35 meseci: heksavalentna 3, MMR 1, prva revakcina; 6–7 godina: MMR 2, druga revakcina). Uzrast se računa na dan objavljivanja.',
  ),
  columns: [
    col('ageGroup', 'text', 'Age group', 'Grupmosha', 'Uzrasna grupa'),
    col('municipality', 'text', 'Municipality', 'Komuna', 'Opština'),
    col('children', 'count', 'Children', 'Fëmijë', 'Deca'),
    col(
      'fullyVaccinated',
      'count',
      'Fully vaccinated',
      'Të vaksinuar plotësisht',
      'Potpuno vakcinisani',
    ),
    col('coveragePct', 'percent', 'Coverage (%)', 'Mbulimi (%)', 'Obuhvat (%)'),
  ],
  async build(now) {
    const today = day(now);
    const schedule = await activeSchedule();
    const rows: Row[] = [];
    for (const [key, cohort] of Object.entries(VACCINE_COHORTS)) {
      const doses = schedule.filter((s) => (cohort.doses as readonly string[]).includes(s.code));
      const allDoses: SQL = doses.length
        ? sql.join(
            doses.map(
              (s) => sql`EXISTS (SELECT 1 FROM immunizations i WHERE i.patient_id = p.id
                AND (i.schedule_item_id = ${s.id}
                     OR (i.schedule_item_id IS NULL AND lower(trim(i.vaccine)) = lower(trim(${s.vaccine}))
                         AND coalesce(i.dose_number, 1) = ${s.doseNumber})))`,
            ),
            sql` AND `,
          )
        : sql`false`;
      const result = await db.execute<{
        municipality: string | null;
        children: number;
        full: number;
      }>(sql`
        SELECT nullif(p.municipality, '') AS municipality, count(*)::int AS children,
          count(*) FILTER (WHERE ${allDoses})::int AS full
        FROM patients p
        WHERE p.merged_into_id IS NULL AND p.deceased_at IS NULL
          AND (${today}::date - p.date_of_birth) BETWEEN ${cohort.minDays} AND ${cohort.maxDays}
        GROUP BY 1 ORDER BY 1`);
      const cells = result.rows;
      const totalChildren = cells.reduce((a, r) => a + num(r.children), 0);
      const totalFull = cells.reduce((a, r) => a + num(r.full), 0);
      const c = suppressGroup(
        cells.map((r) => num(r.children)),
        totalChildren,
      );
      const f = suppressGroup(
        cells.map((r) => num(r.full)),
        totalFull,
      );
      const shape = (
        municipality: L | string,
        children: number,
        full: number,
        hideChildren: boolean,
        hideFull: boolean,
      ): Row => {
        const shownChildren = hideIf(hideChildren, children);
        const shownFull = hideIf(hideFull || hideChildren, full);
        return {
          ageGroup: COHORTS[key] ?? key,
          municipality,
          children: shownChildren,
          fullyVaccinated: shownFull,
          coveragePct: pct(shownFull, shownChildren),
          suppressed: hideChildren || hideFull,
        };
      };
      rows.push(shape(ALL, totalChildren, totalFull, c.totalHidden, f.totalHidden));
      cells.forEach((r, i) =>
        rows.push(
          shape(
            r.municipality ?? NOT_RECORDED,
            num(r.children),
            num(r.full),
            c.hidden[i]!,
            f.hidden[i]!,
          ),
        ),
      );
    }
    return { period: { from: today, to: today }, rows };
  },
};

/* ------------------------------------------------------------------ 4–5. notifiable ------- */

const WEEKS = 12;
const caseWindow = (now: Date) => new Date(now.getTime() - (WEEKS * 7 + 7) * 86_400_000);
const publicCases = (now: Date) =>
  casesForStats({ from: caseWindow(now), statuses: ['SUBMITTED', 'REVIEWED'] });

const diseasesWeeklyDataset: Dataset = {
  id: 'notifiable-diseases',
  title: {
    en: 'Notifiable diseases by week',
    sq: 'Sëmundjet ngjitëse të lajmërueshme sipas javës',
    sr: 'Prijavljive bolesti po nedelji',
  },
  description: {
    en: `Cases of notifiable infectious diseases reported in the last ${WEEKS} weeks, by ISO week (Kosovo total).`,
    sq: `Rastet e sëmundjeve ngjitëse të lajmërueshme të raportuara në ${WEEKS} javët e fundit, sipas javës ISO (gjithsej për Kosovën).`,
    sr: `Slučajevi prijavljivih zaraznih bolesti prijavljeni u poslednjih ${WEEKS} nedelja, po ISO nedelji (ukupno za Kosovo).`,
  },
  methodology: methodology(
    'Case reports submitted to public health, by date of onset (or of the report when onset is unknown); discarded cases are excluded. Recent weeks may still change.',
    'Raportet e rasteve të dërguara te shëndetësia publike, sipas datës së fillimit të sëmundjes (ose të raportit kur kjo nuk dihet); rastet e hedhura poshtë përjashtohen. Javët e fundit mund të ndryshojnë ende.',
    'Prijave slučajeva poslate javnom zdravlju, po datumu početka bolesti (ili prijave kada on nije poznat); odbačeni slučajevi su isključeni. Poslednje nedelje se još mogu menjati.',
  ),
  columns: [
    col('week', 'text', 'Week', 'Java', 'Nedelja'),
    col('diseaseCode', 'text', 'Disease code', 'Kodi i sëmundjes', 'Šifra bolesti'),
    col('disease', 'text', 'Disease', 'Sëmundja', 'Bolest'),
    col('cases', 'count', 'Cases', 'Raste', 'Slučajevi'),
  ],
  async build(now) {
    const cases = await publicCases(now);
    const weeks = lastWeeks(now, WEEKS);
    const diseases = new Map<string, string>();
    for (const c of cases) diseases.set(c.diseaseCode, c.diseaseName);
    // The municipality dataset publishes each disease's total over the same weeks, so the
    // weeks of one disease form a group for secondary suppression.
    const byWeek = new Map<string, number[]>();
    for (const [code] of diseases) {
      byWeek.set(
        code,
        weeks.map(
          (week) =>
            cases.filter((c) => c.diseaseCode === code && isoWeek(c.caseDate) === week).length,
        ),
      );
    }
    const hidden = new Map(
      [...byWeek].map(([code, counts]) => [
        code,
        suppressGroup(
          counts,
          counts.reduce((a, n) => a + n, 0),
        ).hidden,
      ]),
    );
    const sorted = [...diseases].sort((a, b) => a[1].localeCompare(b[1]));
    const rows: Row[] = [];
    weeks.forEach((week, w) => {
      for (const [code, name] of sorted) {
        const n = byWeek.get(code)![w]!;
        const h = hidden.get(code)![w]!;
        rows.push({ week, diseaseCode: code, disease: name, cases: hideIf(h, n), suppressed: h });
      }
    });
    return { period: { from: weeks[0]!, to: weeks[weeks.length - 1]! }, rows };
  },
};

const diseasesMunicipalityDataset: Dataset = {
  id: 'notifiable-diseases-municipality',
  title: {
    en: 'Notifiable diseases by municipality',
    sq: 'Sëmundjet ngjitëse të lajmërueshme sipas komunës',
    sr: 'Prijavljive bolesti po opštini',
  },
  description: {
    en: `Cases of notifiable infectious diseases in the last ${WEEKS} weeks, by municipality of residence.`,
    sq: `Rastet e sëmundjeve ngjitëse të lajmërueshme në ${WEEKS} javët e fundit, sipas komunës së banimit.`,
    sr: `Slučajevi prijavljivih zaraznih bolesti u poslednjih ${WEEKS} nedelja, po opštini stanovanja.`,
  },
  methodology: diseasesWeeklyDataset.methodology,
  columns: [
    col('diseaseCode', 'text', 'Disease code', 'Kodi i sëmundjes', 'Šifra bolesti'),
    col('disease', 'text', 'Disease', 'Sëmundja', 'Bolest'),
    col('municipality', 'text', 'Municipality', 'Komuna', 'Opština'),
    col('cases', 'count', 'Cases', 'Raste', 'Slučajevi'),
  ],
  async build(now) {
    const weeks = new Set(lastWeeks(now, WEEKS));
    const cases = (await publicCases(now)).filter((c) => weeks.has(isoWeek(c.caseDate)));
    const byDisease = new Map<string, { name: string; byMunicipality: Map<string, number> }>();
    for (const c of cases) {
      const d = byDisease.get(c.diseaseCode) ?? { name: c.diseaseName, byMunicipality: new Map() };
      const m = c.municipality || '';
      d.byMunicipality.set(m, (d.byMunicipality.get(m) ?? 0) + 1);
      byDisease.set(c.diseaseCode, d);
    }
    const rows: Row[] = [];
    for (const [code, d] of [...byDisease].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      const cells = [...d.byMunicipality].sort((a, b) => a[0].localeCompare(b[0]));
      const total = cells.reduce((a, [, n]) => a + n, 0);
      const s = suppressGroup(
        cells.map(([, n]) => n),
        total,
      );
      rows.push({
        diseaseCode: code,
        disease: d.name,
        municipality: ALL,
        cases: hideIf(s.totalHidden, total),
        suppressed: s.totalHidden,
      });
      cells.forEach(([m, n], i) =>
        rows.push({
          diseaseCode: code,
          disease: d.name,
          municipality: m || NOT_RECORDED,
          cases: hideIf(s.hidden[i]!, n),
          suppressed: s.hidden[i]!,
        }),
      );
    }
    const list = [...weeks];
    return { period: { from: list[0]!, to: list[list.length - 1]! }, rows };
  },
};

/* ------------------------------------------------------------------ 6. mortality ---------- */

const mortalityDataset: Dataset = {
  id: 'mortality',
  title: {
    en: 'Deaths by month and cause',
    sq: 'Vdekjet sipas muajit dhe shkakut',
    sr: 'Smrtni slučajevi po mesecu i uzroku',
  },
  description: {
    en: 'Deaths certified in the last 12 complete months, by month and ICD-10 chapter of the underlying cause.',
    sq: 'Vdekjet e certifikuara në 12 muajt e fundit të plotë, sipas muajit dhe kapitullit ICD-10 të shkakut themelor.',
    sr: 'Smrtni slučajevi potvrđeni u poslednjih 12 punih meseci, po mesecu i poglavlju MKB-10 osnovnog uzroka.',
  },
  methodology: methodology(
    'Signed medical certificates of cause of death (WHO form), with corrections applied; certificates withdrawn in error are excluded. Deaths not certified in Pacient are not included.',
    'Certifikatat mjekësore të nënshkruara të shkakut të vdekjes (formulari i OBSH-së), me korrigjimet e zbatuara; certifikatat e tërhequra si të gabuara përjashtohen. Vdekjet e pacertifikuara në Pacient nuk përfshihen.',
    'Potpisane lekarske potvrde o uzroku smrti (obrazac SZO), sa primenjenim ispravkama; potvrde povučene kao greške su isključene. Smrtni slučajevi koji nisu potvrđeni u Pacientu nisu uključeni.',
  ),
  columns: [
    col('month', 'text', 'Month', 'Muaji', 'Mesec'),
    col('chapter', 'text', 'ICD-10 chapter', 'Kapitulli ICD-10', 'Poglavlje MKB-10'),
    col('cause', 'text', 'Cause group', 'Grupi i shkaqeve', 'Grupa uzroka'),
    col('deaths', 'count', 'Deaths', 'Vdekje', 'Smrtni slučajevi'),
  ],
  async build(now) {
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 12, 1));
    const deaths = await deathsForStats({ from, to });
    const chapterOfDeath = (icd: string) => chapterOf(icd)?.chapter ?? '?';
    const chapters = [...new Set(deaths.map((d) => chapterOfDeath(d.underlyingCauseIcd10)))].sort(
      (a, b) => Object.keys(CHAPTERS).indexOf(a) - Object.keys(CHAPTERS).indexOf(b),
    );
    const rows: Row[] = [];
    for (
      let m = new Date(from);
      m < to;
      m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))
    ) {
      const month = m.toISOString().slice(0, 7);
      const inMonth = deaths.filter((d) => kosovoDate(d.diedAt).slice(0, 7) === month);
      const counts = chapters.map(
        (ch) => inMonth.filter((d) => chapterOfDeath(d.underlyingCauseIcd10) === ch).length,
      );
      const s = suppressGroup(counts, inMonth.length);
      rows.push({
        month,
        chapter: '',
        cause: ALL_CAUSES,
        deaths: hideIf(s.totalHidden, inMonth.length),
        suppressed: s.totalHidden,
      });
      chapters.forEach((ch, i) =>
        rows.push({
          month,
          chapter: ch === '?' ? '' : ch,
          cause: CHAPTERS[ch] ?? ch,
          deaths: hideIf(s.hidden[i]!, counts[i]!),
          suppressed: s.hidden[i]!,
        }),
      );
    }
    return { period: { from: day(from), to: day(new Date(to.getTime() - 86_400_000)) }, rows };
  },
};

/* ------------------------------------------------------------------ 7. bed occupancy ------ */

const occupancyDataset: Dataset = {
  id: 'bed-occupancy',
  title: {
    en: 'Hospital bed occupancy',
    sq: 'Zënia e shtretërve spitalorë',
    sr: 'Popunjenost bolničkih kreveta',
  },
  description: {
    en: 'Beds in service and patients in a bed at midnight at the end of yesterday, by facility.',
    sq: 'Shtretërit në shërbim dhe pacientët në shtrat në mesnatën e djeshme, sipas institucionit.',
    sr: 'Kreveti u upotrebi i pacijenti u krevetu u ponoć na kraju jučerašnjeg dana, po ustanovi.',
  },
  methodology: methodology(
    'Beds: beds not out of service today. Occupied: hospital stays with a bed that had started and not ended at midnight (Kosovo time).',
    'Shtretërit: shtretërit që sot nuk janë jashtë shërbimit. Të zënë: qëndrimet spitalore me shtrat që kishin filluar dhe nuk kishin përfunduar në mesnatë (ora e Kosovës).',
    'Kreveti: kreveti koji danas nisu van upotrebe. Zauzeti: bolnički boravci sa krevetom koji su počeli, a nisu završeni u ponoć (kosovsko vreme).',
  ),
  columns: [
    col('facility', 'text', 'Facility', 'Institucioni', 'Ustanova'),
    col('municipality', 'text', 'Municipality', 'Komuna', 'Opština'),
    col('beds', 'count', 'Beds in service', 'Shtretër në shërbim', 'Kreveti u upotrebi'),
    col('occupied', 'count', 'Occupied', 'Të zënë', 'Zauzeti'),
    col('occupancyPct', 'percent', 'Occupancy (%)', 'Zënia (%)', 'Popunjenost (%)'),
  ],
  async build(now) {
    const result = await db.execute<{
      facility: string;
      municipality: string;
      beds: number;
      occupied: number;
      at: Date;
    }>(sql`
      WITH midnight AS (
        SELECT (date_trunc('day', ${now}::timestamptz AT TIME ZONE 'Europe/Belgrade')
                AT TIME ZONE 'Europe/Belgrade') AS at
      ), cap AS (
        SELECT cu.facility_id, count(b.id) FILTER (WHERE b.status <> 'OUT_OF_SERVICE')::int AS beds
        FROM care_units cu JOIN beds b ON b.unit_id = cu.id
        WHERE cu.is_active
        GROUP BY cu.facility_id
      ), occ AS (
        SELECT a.facility_id, count(*)::int AS occupied
        FROM admissions a, midnight
        WHERE a.bed_id IS NOT NULL AND a.status <> 'CANCELLED'
          AND a.admitted_at <= midnight.at
          AND (a.discharged_at IS NULL OR a.discharged_at > midnight.at)
        GROUP BY a.facility_id
      )
      SELECT f.name AS facility, f.municipality, cap.beds, coalesce(occ.occupied, 0)::int AS occupied,
        (SELECT at FROM midnight) AS at
      FROM facilities f
      JOIN cap ON cap.facility_id = f.id
      LEFT JOIN occ ON occ.facility_id = f.id
      WHERE f.is_active AND cap.beds > 0
      ORDER BY f.name`);
    const yesterday = day(new Date(now.getTime() - 86_400_000));
    return {
      period: { from: yesterday, to: yesterday },
      rows: result.rows.map((r) => {
        const hidden = isSmall(num(r.occupied));
        const occupied = hideIf(hidden, num(r.occupied));
        return {
          facility: r.facility,
          municipality: r.municipality,
          beds: num(r.beds),
          occupied,
          occupancyPct: pct(occupied, num(r.beds)),
          suppressed: hidden,
        };
      }),
    };
  },
};

/* ------------------------------------------------------------------ 8. emergency waits ---- */

const edDataset: Dataset = {
  id: 'emergency-waiting',
  title: {
    en: 'Emergency department waiting times',
    sq: 'Kohët e pritjes në urgjencë',
    sr: 'Vreme čekanja u hitnoj službi',
  },
  description: {
    en: 'Attendances in the last 30 days and the time from arrival until first seen by a clinician, by facility.',
    sq: 'Paraqitjet në 30 ditët e fundit dhe koha nga mbërritja deri te ekzaminimi i parë nga klinicisti, sipas institucionit.',
    sr: 'Dolasci u poslednjih 30 dana i vreme od dolaska do prvog pregleda kod lekara, po ustanovi.',
  },
  methodology: methodology(
    'Emergency department attendances recorded in Pacient; waiting time is measured from registration of arrival to the first assessment by a doctor or nurse after triage.',
    'Paraqitjet në urgjencë të regjistruara në Pacient; koha e pritjes matet nga regjistrimi i mbërritjes deri te vlerësimi i parë nga mjeku ose infermieri pas triazhit.',
    'Dolasci u hitnu službu evidentirani u Pacientu; vreme čekanja meri se od evidentiranja dolaska do prve procene lekara ili medicinske sestre posle trijaže.',
  ),
  columns: [
    col('facility', 'text', 'Facility', 'Institucioni', 'Ustanova'),
    col('municipality', 'text', 'Municipality', 'Komuna', 'Opština'),
    col('attendances', 'count', 'Attendances', 'Paraqitje', 'Dolasci'),
    col(
      'medianMinutes',
      'number',
      'Median wait (minutes)',
      'Pritja mediane (minuta)',
      'Medijana čekanja (minuti)',
    ),
    col(
      'p90Minutes',
      'number',
      '90% seen within (minutes)',
      '90% të ekzaminuar brenda (minutash)',
      '90% pregledano u roku od (minuta)',
    ),
    col(
      'leftWithoutBeingSeen',
      'count',
      'Left without being seen',
      'U larguan pa u ekzaminuar',
      'Otišli bez pregleda',
    ),
  ],
  async build(now) {
    const since = new Date(now.getTime() - 30 * 86_400_000);
    const result = await db.execute<Record<string, unknown>>(sql`
      SELECT f.name AS facility, f.municipality, count(*)::int AS attendances,
        count(e.seen_at)::int AS seen,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.seen_at - e.arrived_at) / 60)
          FILTER (WHERE e.seen_at IS NOT NULL) AS median,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM e.seen_at - e.arrived_at) / 60)
          FILTER (WHERE e.seen_at IS NOT NULL) AS p90,
        count(*) FILTER (WHERE e.status = 'LEFT_WITHOUT_BEING_SEEN')::int AS lwbs
      FROM ed_visits e
      JOIN facilities f ON f.id = e.facility_id
      WHERE e.arrived_at >= ${since}
      GROUP BY f.name, f.municipality
      ORDER BY f.name`);
    return {
      period: { from: day(since), to: day(now) },
      rows: result.rows.map((r) => {
        const hideAll = isSmall(num(r.attendances));
        const hideTimes = hideAll || isSmall(num(r.seen)) || num(r.seen) === 0;
        const hideLwbs = hideAll || isSmall(num(r.lwbs));
        return {
          facility: String(r.facility),
          municipality: String(r.municipality),
          attendances: hideIf(hideAll, num(r.attendances)),
          medianMinutes: hideTimes ? null : Math.round(num(r.median)),
          p90Minutes: hideTimes ? null : Math.round(num(r.p90)),
          leftWithoutBeingSeen: hideIf(hideLwbs, num(r.lwbs)),
          suppressed: hideAll || hideLwbs || (hideTimes && num(r.seen) > 0),
        };
      }),
    };
  },
};

/* ------------------------------------------------------------------ 9. screening ---------- */

const screeningDataset: Dataset = {
  id: 'screening-coverage',
  title: {
    en: 'Cancer screening coverage',
    sq: 'Mbulimi me depistim të kancerit',
    sr: 'Obuhvat skriningom raka',
  },
  description: {
    en: 'People in the age range of each screening programme and those screened within the routine interval, by municipality.',
    sq: 'Personat në grupmoshën e secilit program depistimi dhe ata të depistuar brenda intervalit të rregullt, sipas komunës.',
    sr: 'Osobe u uzrastu svakog programa skrininga i one pregledane u redovnom intervalu, po opštini.',
  },
  methodology: methodology(
    'Programmes, age ranges and intervals are illustrative until confirmed by the national cancer control programme. Population: living people registered in Pacient in the age and sex range.',
    'Programet, grupmoshat dhe intervalet janë ilustruese derisa t’i konfirmojë programi kombëtar për kontrollin e kancerit. Popullsia: personat e gjallë të regjistruar në Pacient në grupmoshën dhe gjininë përkatëse.',
    'Programi, uzrasne grupe i intervali su ilustrativni dok ih ne potvrdi nacionalni program kontrole raka. Populacija: žive osobe registrovane u Pacientu u odgovarajućem uzrastu i polu.',
  ),
  columns: [
    col('programme', 'text', 'Programme', 'Programi', 'Program'),
    col('municipality', 'text', 'Municipality', 'Komuna', 'Opština'),
    col(
      'population',
      'count',
      'Eligible people',
      'Persona të përshtatshëm',
      'Osobe obuhvaćene programom',
    ),
    col(
      'screened',
      'count',
      'Screened within interval',
      'Të depistuar brenda intervalit',
      'Pregledani u intervalu',
    ),
    col('coveragePct', 'percent', 'Coverage (%)', 'Mbulimi (%)', 'Obuhvat (%)'),
  ],
  async build(now) {
    // Raw counts come back already suppressed by the screening module; recompute exact groups
    // here from its unsuppressed national rows is not possible, so use the published values and
    // add secondary suppression across municipalities.
    const [byMunicipality, national] = await Promise.all([
      coverage({ facilityId: null, groupBy: 'MUNICIPALITY', now }),
      coverage({ facilityId: null, groupBy: 'NONE', now }),
    ]);
    const rows: Row[] = [];
    for (const programme of Object.keys(PROGRAMMES)) {
      const total = national.find((r) => r.programme === programme);
      const cells = byMunicipality.filter((r) => r.programme === programme);
      // A null cell from the screening module is a small count: treat it as 1 for grouping.
      const asCount = (n: number | null) => (n === null ? 1 : n);
      const p = suppressGroup(
        cells.map((r) => asCount(r.population)),
        total?.population ?? undefined,
      );
      const s = suppressGroup(
        cells.map((r) => asCount(r.screenedInInterval)),
        total?.screenedInInterval ?? undefined,
      );
      const shape = (
        municipality: L | string,
        population: number | null,
        screened: number | null,
        hideP: boolean,
        hideS: boolean,
      ): Row => {
        const pop = hideP ? null : population;
        const scr = hideS || hideP ? null : screened;
        return {
          programme: PROGRAMMES[programme]!,
          municipality,
          population: pop,
          screened: scr,
          coveragePct: pct(scr, pop),
          suppressed: pop === null || scr === null,
        };
      };
      if (total) {
        rows.push(
          shape(ALL, total.population, total.screenedInInterval, p.totalHidden, s.totalHidden),
        );
      }
      cells.forEach((r, i) =>
        rows.push(
          shape(
            r.group || NOT_RECORDED,
            r.population,
            r.screenedInInterval,
            p.hidden[i]! || r.population === null,
            s.hidden[i]! || r.screenedInInterval === null,
          ),
        ),
      );
    }
    return { period: { from: day(now), to: day(now) }, rows };
  },
};

export const DATASETS: Dataset[] = [
  facilitiesDataset,
  waitingDataset,
  vaccinationDataset,
  diseasesWeeklyDataset,
  diseasesMunicipalityDataset,
  mortalityDataset,
  occupancyDataset,
  edDataset,
  screeningDataset,
];
