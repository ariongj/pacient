import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  admissions,
  allergies,
  appointments,
  beds,
  careUnits,
  earlyWarningScores,
  edVisits,
  facilities,
  medicationAdministrations,
  patients,
  prescriptions,
  surgicalCases,
  users,
  vitalSigns,
} from '../../db/schema.js';
import { tr, type Locale } from '../../i18n/index.js';
import { currentBloodGroup } from '../bloodbank/bloodbank.service.js';
import { dietLines } from '../nutrition/nutrition.service.js';
import { addDays, localDate, localTime, zonedToUtc } from '../scheduling/time.js';

/**
 * Downtime pack: everything a ward needs to keep caring for patients on paper for a few hours –
 * who is in which bed, allergies, medicines due in the next 12 hours, last observations and early
 * warning score, diet and fasting, blood group – plus the emergency department board, today's
 * theatre list and today's outpatient appointments.
 *
 * The output is ONE self-contained HTML document (inline CSS, no scripts, no external assets) so
 * it can be opened and printed on any offline computer.
 */

export const PACK_WINDOW_HOURS = 12;

/** Standard administration times (local) for structured frequency codes. */
const FREQUENCY_HOURS: Record<string, number[]> = {
  QD: [8],
  OD: [8],
  BID: [8, 20],
  TID: [8, 14, 20],
  QID: [8, 12, 16, 20],
  Q4H: [0, 4, 8, 12, 16, 20],
  Q6H: [0, 6, 12, 18],
  Q8H: [6, 14, 22],
  Q12H: [8, 20],
  QHS: [22],
};

/** Best-effort reading of free-text frequencies in English, Albanian and Serbian. */
export function frequencyHours(code: string | null, text: string | null): number[] | null {
  if (code && FREQUENCY_HOURS[code.toUpperCase()]) return FREQUENCY_HOURS[code.toUpperCase()]!;
  const f = (text ?? '').toLowerCase();
  if (!f) return null;
  const every = /(?:every|çdo|svakih|na)\s*(\d{1,2})\s*(?:h|hours|hour|orë|ore|sati|č)/.exec(f);
  if (every) {
    const n = Number(every[1]);
    if (n === 4) return FREQUENCY_HOURS.Q4H!;
    if (n === 6) return FREQUENCY_HOURS.Q6H!;
    if (n === 8) return FREQUENCY_HOURS.Q8H!;
    if (n === 12) return FREQUENCY_HOURS.Q12H!;
    if (n === 24) return FREQUENCY_HOURS.QD!;
  }
  if (/(four times|katër herë|četiri puta|4\s*x)/.test(f)) return FREQUENCY_HOURS.QID!;
  if (/(three times|tri herë|tre herë|tri puta|3\s*x)/.test(f)) return FREQUENCY_HOURS.TID!;
  if (/(twice|two times|dy herë|dva puta|2\s*x)/.test(f)) return FREQUENCY_HOURS.BID!;
  if (/(at night|bedtime|në mbrëmje|para gjumit|uveče|pred spavanje)/.test(f))
    return FREQUENCY_HOURS.QHS!;
  if (/(once|një herë|jednom|daily|në ditë|dnevno|1\s*x)/.test(f)) return FREQUENCY_HOURS.QD!;
  return null;
}

/** Due times (UTC instants) within [from, from + hours) for a prescription's schedule. */
export function dueTimes(
  hours: number[],
  from: Date,
  windowHours = PACK_WINDOW_HOURS,
  startDate?: string | null,
  endDate?: string | null,
): Date[] {
  const to = from.getTime() + windowHours * 3_600_000;
  const out: Date[] = [];
  const day0 = localDate(from);
  for (const day of [addDays(day0, -1), day0, addDays(day0, 1)]) {
    if (startDate && day < startDate) continue;
    if (endDate && day > endDate) continue;
    for (const h of hours) {
      const at = zonedToUtc(day, `${String(h).padStart(2, '0')}:00`);
      if (at && at.getTime() >= from.getTime() && at.getTime() < to) out.push(at);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function ageYears(dob: string, at: Date): number {
  const d = new Date(`${dob}T00:00:00Z`);
  let a = at.getUTCFullYear() - d.getUTCFullYear();
  const m = at.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) a--;
  return Math.max(0, a);
}

export interface PackPatient {
  admissionId: string;
  patientId: string;
  unitName: string;
  bed: string | null;
  name: string;
  nationalId: string;
  temporary: boolean;
  dateOfBirth: string;
  age: number;
  sex: string;
  attending: string;
  admittedAt: Date;
  allergies: { substance: string; severity: string; reaction: string | null }[];
  bloodGroup: string | null;
  bloodGroupConfirmed: boolean;
  diet: string;
  npo: string | null;
  vitals: {
    at: Date;
    bp: string | null;
    hr: number | null;
    rr: number | null;
    temp: string | null;
    spo2: number | null;
    acvpu: string | null;
    oxygen: boolean | null;
  } | null;
  ews: { scale: string; score: number; risk: string; at: Date } | null;
  medications: {
    name: string;
    dose: string;
    route: string;
    frequency: string;
    asNeeded: boolean;
    due: Date[];
    lastGiven: Date | null;
  }[];
}

export interface PackData {
  facility: { id: string; name: string; code: string };
  generatedAt: Date;
  locale: Locale;
  patients: PackPatient[];
  ed: {
    name: string;
    nationalId: string;
    arrivedAt: Date;
    triageLevel: number | null;
    status: string;
    complaint: string;
  }[];
  theatre: {
    start: Date | null;
    theatre: string | null;
    name: string;
    procedure: string;
    laterality: string;
    surgeon: string;
    status: string;
  }[];
  appointments: {
    at: Date;
    name: string;
    nationalId: string;
    doctor: string;
    status: string;
    mode: string;
  }[];
}

/** Gathers the pack's data for one facility at `now`. */
export async function collectPackData(
  facilityId: string,
  now: Date,
  locale: Locale,
): Promise<PackData> {
  const [facility] = await db
    .select({ id: facilities.id, name: facilities.name, code: facilities.code })
    .from(facilities)
    .where(eq(facilities.id, facilityId));
  if (!facility) throw new Error(`Facility ${facilityId} not found`);

  const attending = users;
  const stays = await db
    .select({
      admissionId: admissions.id,
      patientId: admissions.patientId,
      admittedAt: admissions.admittedAt,
      unitName: careUnits.name,
      bed: beds.label,
      firstName: patients.firstName,
      lastName: patients.lastName,
      nationalId: patients.nationalId,
      temporaryIdentity: patients.temporaryIdentity,
      dateOfBirth: patients.dateOfBirth,
      sex: patients.sex,
      attending: attending.fullName,
    })
    .from(admissions)
    .innerJoin(careUnits, eq(careUnits.id, admissions.unitId))
    .innerJoin(patients, eq(patients.id, admissions.patientId))
    .innerJoin(attending, eq(attending.id, admissions.attendingDoctorId))
    .leftJoin(beds, eq(beds.id, admissions.bedId))
    .where(and(eq(admissions.facilityId, facilityId), eq(admissions.status, 'ADMITTED')))
    .orderBy(asc(careUnits.name), sql`${beds.label} NULLS LAST`, asc(patients.lastName));

  const patientIds = [...new Set(stays.map((s) => s.patientId))];
  const none = ['00000000-0000-0000-0000-000000000000'];
  const ids = patientIds.length ? patientIds : none;

  const [allergyRows, rxRows, vitalRows, ewsRows, diets] = await Promise.all([
    db
      .select({
        patientId: allergies.patientId,
        substance: allergies.substance,
        severity: allergies.severity,
        reaction: allergies.reaction,
      })
      .from(allergies)
      .where(
        and(
          inArray(allergies.patientId, ids),
          notInArray(allergies.verificationStatus, ['REFUTED', 'ENTERED_IN_ERROR']),
        ),
      ),
    db
      .select({
        id: prescriptions.id,
        patientId: prescriptions.patientId,
        medication: prescriptions.medication,
        dosage: prescriptions.dosage,
        doseAmount: prescriptions.doseAmount,
        doseUnit: prescriptions.doseUnit,
        route: prescriptions.route,
        frequency: prescriptions.frequency,
        frequencyCode: prescriptions.frequencyCode,
        asNeeded: prescriptions.asNeeded,
        startDate: prescriptions.startDate,
        endDate: prescriptions.endDate,
        lastGiven: sql<Date | null>`(
          SELECT max(${medicationAdministrations.administeredAt}) FROM ${medicationAdministrations}
          WHERE ${medicationAdministrations.prescriptionId} = ${prescriptions.id}
            AND ${medicationAdministrations.status} = 'GIVEN')`,
      })
      .from(prescriptions)
      .where(and(inArray(prescriptions.patientId, ids), eq(prescriptions.status, 'ACTIVE')))
      .orderBy(asc(prescriptions.medication)),
    db
      .selectDistinctOn([vitalSigns.patientId])
      .from(vitalSigns)
      .where(inArray(vitalSigns.patientId, ids))
      .orderBy(vitalSigns.patientId, desc(vitalSigns.recordedAt)),
    db
      .selectDistinctOn([earlyWarningScores.patientId], {
        patientId: earlyWarningScores.patientId,
        scale: earlyWarningScores.scale,
        score: earlyWarningScores.score,
        risk: earlyWarningScores.risk,
        at: earlyWarningScores.computedAt,
      })
      .from(earlyWarningScores)
      .where(inArray(earlyWarningScores.patientId, ids))
      .orderBy(earlyWarningScores.patientId, desc(earlyWarningScores.computedAt)),
    dietLines(facilityId, now),
  ]);

  const groups = new Map<string, { group: string | null; confirmed: boolean }>();
  for (const id of patientIds) {
    const g = await currentBloodGroup(id);
    groups.set(id, {
      group: g.group ? `${g.group.abo} ${g.group.rhD === 'POS' ? 'RhD+' : 'RhD−'}` : null,
      confirmed: g.confirmed,
    });
  }
  const dietByAdmission = new Map(diets.map((d) => [d.admissionId, d]));

  const result: PackPatient[] = stays.map((s) => {
    const v = vitalRows.find((r) => r.patientId === s.patientId);
    const e = ewsRows.find((r) => r.patientId === s.patientId);
    const d = dietByAdmission.get(s.admissionId);
    return {
      admissionId: s.admissionId,
      patientId: s.patientId,
      unitName: s.unitName,
      bed: s.bed,
      name:
        s.temporaryIdentity === 'UNIDENTIFIED'
          ? tr(locale, 'Unknown patient {code}', { code: s.lastName })
          : `${s.firstName} ${s.lastName}`,
      nationalId: s.nationalId,
      temporary: Boolean(s.temporaryIdentity),
      dateOfBirth: s.dateOfBirth,
      age: ageYears(s.dateOfBirth, now),
      sex: s.sex,
      attending: s.attending,
      admittedAt: s.admittedAt,
      allergies: allergyRows
        .filter((a) => a.patientId === s.patientId)
        .map((a) => ({ substance: a.substance, severity: a.severity, reaction: a.reaction })),
      bloodGroup: groups.get(s.patientId)?.group ?? null,
      bloodGroupConfirmed: groups.get(s.patientId)?.confirmed ?? false,
      diet: d?.dietType ?? 'NORMAL',
      npo: d?.npo
        ? d.npo.level === 'FULL'
          ? tr(locale, 'Nil by mouth (operation at {time})', {
              time: localTime(new Date(d.npo.operationAt)),
            })
          : tr(locale, 'No food from {solids}, no fluids from {fluids}', {
              solids: d.npo.solidsFromLocal,
              fluids: d.npo.fluidsFromLocal,
            })
        : null,
      vitals: v
        ? {
            at: v.recordedAt,
            bp: v.systolic && v.diastolic ? `${v.systolic}/${v.diastolic}` : null,
            hr: v.heartRate,
            rr: v.respiratoryRate,
            temp: v.temperatureC,
            spo2: v.oxygenSaturation,
            acvpu: v.consciousness,
            oxygen: v.onSupplementalOxygen,
          }
        : null,
      ews: e ? { scale: e.scale, score: e.score, risk: e.risk, at: e.at } : null,
      medications: rxRows
        .filter((r) => r.patientId === s.patientId)
        .map((r) => {
          const hours = r.asNeeded ? null : frequencyHours(r.frequencyCode, r.frequency);
          return {
            name: r.medication,
            dose: r.doseAmount ? `${Number(r.doseAmount)} ${r.doseUnit ?? ''}`.trim() : r.dosage,
            route: r.route,
            frequency: r.frequencyCode ?? r.frequency,
            asNeeded: r.asNeeded,
            due: hours ? dueTimes(hours, now, PACK_WINDOW_HOURS, r.startDate, r.endDate) : [],
            lastGiven: r.lastGiven ? new Date(r.lastGiven) : null,
          };
        }),
    };
  });

  const today = localDate(now);
  const dayStart = zonedToUtc(today, '00:00') ?? now;
  const dayEnd = zonedToUtc(addDays(today, 1), '00:00') ?? new Date(now.getTime() + 86_400_000);

  const edRows = await db
    .select({
      firstName: patients.firstName,
      lastName: patients.lastName,
      temporaryIdentity: patients.temporaryIdentity,
      nationalId: patients.nationalId,
      arrivedAt: edVisits.arrivedAt,
      triageLevel: edVisits.triageLevel,
      status: edVisits.status,
      complaint: edVisits.chiefComplaint,
    })
    .from(edVisits)
    .innerJoin(patients, eq(patients.id, edVisits.patientId))
    .where(
      and(
        eq(edVisits.facilityId, facilityId),
        inArray(edVisits.status, ['WAITING', 'IN_TREATMENT']),
      ),
    )
    .orderBy(sql`${edVisits.triageLevel} NULLS FIRST`, asc(edVisits.arrivedAt));

  const surgeon = users;
  const theatreRows = await db
    .select({
      start: surgicalCases.scheduledStart,
      theatre: careUnits.name,
      firstName: patients.firstName,
      lastName: patients.lastName,
      temporaryIdentity: patients.temporaryIdentity,
      procedure: surgicalCases.procedure,
      laterality: surgicalCases.laterality,
      surgeon: surgeon.fullName,
      status: surgicalCases.status,
    })
    .from(surgicalCases)
    .innerJoin(patients, eq(patients.id, surgicalCases.patientId))
    .innerJoin(surgeon, eq(surgeon.id, surgicalCases.primarySurgeonId))
    .leftJoin(careUnits, eq(careUnits.id, surgicalCases.theatreUnitId))
    .where(
      and(
        eq(surgicalCases.facilityId, facilityId),
        gte(surgicalCases.scheduledStart, dayStart),
        lt(surgicalCases.scheduledStart, dayEnd),
        ne(surgicalCases.status, 'CANCELLED'),
      ),
    )
    .orderBy(asc(careUnits.name), asc(surgicalCases.scheduledStart));

  const doctor = users;
  const apptRows = await db
    .select({
      at: appointments.scheduledAt,
      firstName: patients.firstName,
      lastName: patients.lastName,
      temporaryIdentity: patients.temporaryIdentity,
      nationalId: patients.nationalId,
      doctor: doctor.fullName,
      status: appointments.status,
      mode: appointments.mode,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .innerJoin(doctor, eq(doctor.id, appointments.doctorId))
    .where(
      and(
        eq(appointments.facilityId, facilityId),
        gte(appointments.scheduledAt, dayStart),
        lt(appointments.scheduledAt, dayEnd),
        inArray(appointments.status, ['REQUESTED', 'CONFIRMED', 'CHECKED_IN']),
        isNull(patients.mergedIntoId),
      ),
    )
    .orderBy(asc(appointments.scheduledAt));

  const displayName = (r: {
    firstName: string;
    lastName: string;
    temporaryIdentity: string | null;
  }) =>
    r.temporaryIdentity === 'UNIDENTIFIED'
      ? tr(locale, 'Unknown patient {code}', { code: r.lastName })
      : `${r.firstName} ${r.lastName}`;

  return {
    facility,
    generatedAt: now,
    locale,
    patients: result,
    ed: edRows.map((r) => ({
      name: displayName(r),
      nationalId: r.nationalId,
      arrivedAt: r.arrivedAt,
      triageLevel: r.triageLevel,
      status: r.status,
      complaint: r.complaint,
    })),
    theatre: theatreRows.map((r) => ({
      start: r.start,
      theatre: r.theatre,
      name: displayName(r),
      procedure: r.procedure,
      laterality: r.laterality,
      surgeon: r.surgeon,
      status: r.status,
    })),
    appointments: apptRows.map((r) => ({
      at: r.at,
      name: displayName(r),
      nationalId: r.nationalId,
      doctor: r.doctor,
      status: r.status,
      mode: r.mode,
    })),
  };
}

/* ------------------------------------------------------------------ rendering */

const DIET_LABEL: Record<string, string> = {
  NORMAL: 'Normal diet',
  NIL_BY_MOUTH: 'Nil by mouth',
  CLEAR_FLUIDS: 'Clear fluids',
  FULL_FLUIDS: 'Full fluids',
  SOFT: 'Soft',
  PUREED: 'Pureed',
  DIABETIC: 'Diabetic',
  LOW_SALT: 'Low salt',
  RENAL: 'Renal',
  LOW_FAT: 'Low fat',
  HIGH_PROTEIN: 'High protein',
  GLUTEN_FREE: 'Gluten free',
  VEGETARIAN: 'Vegetarian',
  ENTERAL_TUBE: 'Enteral tube feeding',
};
const RISK_LABEL: Record<string, string> = {
  LOW: 'Low',
  LOW_MEDIUM: 'Low–medium',
  MEDIUM: 'Medium',
  HIGH: 'High',
};
const SEVERITY_LABEL: Record<string, string> = {
  MILD: 'Mild',
  MODERATE: 'Moderate',
  SEVERE: 'Severe',
  LIFE_THREATENING: 'Life-threatening',
};
const STATUS_LABEL: Record<string, string> = {
  WAITING: 'Waiting',
  IN_TREATMENT: 'In treatment',
  REQUESTED: 'Requested',
  CONFIRMED: 'Confirmed',
  CHECKED_IN: 'Checked in',
  SCHEDULED: 'Scheduled',
  IN_THEATRE: 'In theatre',
  COMPLETED: 'Completed',
  POSTPONED: 'Postponed',
};
const SIDE_LABEL: Record<string, string> = {
  LEFT: 'Left',
  RIGHT: 'Right',
  BILATERAL: 'Bilateral',
  NOT_APPLICABLE: '',
};

const CSS = `
*{box-sizing:border-box}
body{font:11px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#111;margin:16px}
h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:18px 0 6px;padding-top:6px;border-top:2px solid #111}
.warn{border:2px solid #b91c1c;color:#7f1d1d;padding:6px 8px;margin:8px 0;font-weight:600}
.meta{color:#333;margin:0 0 6px}
table{width:100%;border-collapse:collapse;margin:4px 0 10px;page-break-inside:auto}
th,td{border:1px solid #555;padding:3px 4px;vertical-align:top;text-align:left}
th{background:#e5e7eb}tr{page-break-inside:avoid}
.allergy{color:#7f1d1d;font-weight:700}.none{color:#555}
.ews-HIGH{font-weight:700;color:#7f1d1d}.ews-MEDIUM{font-weight:700;color:#92400e}
.due{white-space:nowrap}.paper{min-width:90px}
.ward{page-break-before:always}.ward:first-of-type{page-break-before:auto}
ul{margin:0;padding-left:14px}
@media print{body{margin:8mm}.warn{border-width:1px}}
`;

export function renderPackHtml(data: PackData): string {
  const L = data.locale;
  const T = (text: string, vars?: Record<string, string | number>) => tr(L, text, vars);
  const time = (d: Date | null | undefined) => (d ? localTime(d) : '—');
  const dateTime = (d: Date | null | undefined) => (d ? `${localDate(d)} ${localTime(d)}` : '—');

  const wards = new Map<string, PackPatient[]>();
  for (const p of data.patients) wards.set(p.unitName, [...(wards.get(p.unitName) ?? []), p]);

  const wardSections = [...wards.entries()]
    .map(([unit, list]) => {
      const rows = list
        .map((p) => {
          const allergyCell = p.allergies.length
            ? `<span class="allergy">${p.allergies
                .map(
                  (a) =>
                    `${esc(a.substance)} (${esc(T(SEVERITY_LABEL[a.severity] ?? a.severity))})`,
                )
                .join(', ')}</span>`
            : `<span class="none">${esc(T('No known allergies recorded'))}</span>`;
          const vit = p.vitals
            ? `${esc(time(p.vitals.at))}: ${[
                p.vitals.bp && `${esc(T('BP'))} ${esc(p.vitals.bp)}`,
                p.vitals.hr != null && `${esc(T('HR'))} ${p.vitals.hr}`,
                p.vitals.rr != null && `${esc(T('RR'))} ${p.vitals.rr}`,
                p.vitals.temp != null && `${esc(p.vitals.temp)} °C`,
                p.vitals.spo2 != null && `SpO₂ ${p.vitals.spo2}%`,
                p.vitals.acvpu && `ACVPU ${esc(p.vitals.acvpu)}`,
                p.vitals.oxygen && esc(T('on oxygen')),
              ]
                .filter(Boolean)
                .join(', ')}`
            : `<span class="none">${esc(T('No observations recorded'))}</span>`;
          const ews = p.ews
            ? `<div class="ews-${esc(p.ews.risk)}">${esc(p.ews.scale)} ${p.ews.score} – ${esc(
                T(RISK_LABEL[p.ews.risk] ?? p.ews.risk),
              )}</div>`
            : '';
          const meds = p.medications.length
            ? `<ul>${p.medications
                .map(
                  (m) =>
                    `<li><strong>${esc(m.name)}</strong> ${esc(m.dose)} ${esc(m.route)} · ${esc(
                      m.frequency,
                    )}${
                      m.asNeeded
                        ? ` · <em>${esc(T('as needed'))}</em>`
                        : m.due.length
                          ? ` · <span class="due">${esc(T('due'))}: ${m.due.map((d) => esc(time(d))).join(', ')}</span>`
                          : ` · <em>${esc(T('check schedule'))}</em>`
                    }${m.lastGiven ? ` <span class="none">(${esc(T('last given {time}', { time: dateTime(m.lastGiven) }))})</span>` : ''}</li>`,
                )
                .join('')}</ul>`
            : `<span class="none">${esc(T('No active medicines'))}</span>`;
          return `<tr>
<td><strong>${esc(p.bed ?? T('no bed'))}</strong></td>
<td><strong>${esc(p.name)}</strong><br>${esc(p.temporary ? T('Temporary number') : T('National ID'))}: ${esc(
            p.nationalId,
          )}<br>${esc(T('Born {date} ({age} y)', { date: p.dateOfBirth, age: p.age }))}<br>${esc(
            T('Attending: {name}', { name: p.attending }),
          )}</td>
<td>${allergyCell}</td>
<td>${esc(p.bloodGroup ?? T('not tested'))}${
            p.bloodGroup && !p.bloodGroupConfirmed ? `<br><em>${esc(T('not confirmed'))}</em>` : ''
          }</td>
<td>${esc(T(DIET_LABEL[p.diet] ?? p.diet))}${p.npo ? `<br><strong>${esc(p.npo)}</strong>` : ''}</td>
<td>${vit}${ews}</td>
<td>${meds}</td>
<td class="paper"></td>
</tr>`;
        })
        .join('\n');
      return `<section class="ward"><h2>${esc(unit)} · ${esc(
        T('{count} patients', { count: list.length }),
      )}</h2>
<table><thead><tr><th>${esc(T('Bed'))}</th><th>${esc(T('Patient'))}</th><th>${esc(
        T('Allergies'),
      )}</th><th>${esc(T('Blood group'))}</th><th>${esc(T('Diet'))}</th><th>${esc(
        T('Last observations'),
      )}</th><th>${esc(T('Medicines – next {hours} hours', { hours: PACK_WINDOW_HOURS }))}</th><th>${esc(
        T('Paper notes'),
      )}</th></tr></thead><tbody>
${rows}
</tbody></table></section>`;
    })
    .join('\n');

  const ed = data.ed.length
    ? `<table><thead><tr><th>${esc(T('Arrived'))}</th><th>${esc(T('Patient'))}</th><th>${esc(
        T('Triage'),
      )}</th><th>${esc(T('Status'))}</th><th>${esc(T('Main complaint'))}</th></tr></thead><tbody>${data.ed
        .map(
          (e) =>
            `<tr><td>${esc(time(e.arrivedAt))}</td><td>${esc(e.name)}<br>${esc(e.nationalId)}</td><td>${
              e.triageLevel ?? esc(T('awaiting triage'))
            }</td><td>${esc(T(STATUS_LABEL[e.status] ?? e.status))}</td><td>${esc(e.complaint)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<p class="none">${esc(T('Nobody in the emergency department.'))}</p>`;

  const theatre = data.theatre.length
    ? `<table><thead><tr><th>${esc(T('Time'))}</th><th>${esc(T('Theatre'))}</th><th>${esc(
        T('Patient'),
      )}</th><th>${esc(T('Procedure'))}</th><th>${esc(T('Surgeon'))}</th><th>${esc(
        T('Status'),
      )}</th></tr></thead><tbody>${data.theatre
        .map(
          (c) =>
            `<tr><td>${esc(time(c.start))}</td><td>${esc(c.theatre ?? '—')}</td><td>${esc(
              c.name,
            )}</td><td>${esc(c.procedure)}${
              SIDE_LABEL[c.laterality]
                ? ` – <strong>${esc(T(SIDE_LABEL[c.laterality]!))}</strong>`
                : ''
            }</td><td>${esc(c.surgeon)}</td><td>${esc(T(STATUS_LABEL[c.status] ?? c.status))}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<p class="none">${esc(T('No operations scheduled today.'))}</p>`;

  const appts = data.appointments.length
    ? `<table><thead><tr><th>${esc(T('Time'))}</th><th>${esc(T('Patient'))}</th><th>${esc(
        T('Doctor'),
      )}</th><th>${esc(T('Status'))}</th></tr></thead><tbody>${data.appointments
        .map(
          (a) =>
            `<tr><td>${esc(time(a.at))}</td><td>${esc(a.name)}<br>${esc(a.nationalId)}</td><td>${esc(
              a.doctor,
            )}${a.mode === 'VIDEO' ? ` (${esc(T('video'))})` : ''}</td><td>${esc(
              T(STATUS_LABEL[a.status] ?? a.status),
            )}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<p class="none">${esc(T('No appointments today.'))}</p>`;

  return `<!doctype html>
<html lang="${esc(L)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(T('Downtime pack – {facility}', { facility: data.facility.name }))}</title>
<style>${CSS}</style></head><body>
<h1>${esc(T('Downtime pack – {facility}', { facility: data.facility.name }))}</h1>
<p class="meta">${esc(
    T('Generated {time} · {count} inpatients', {
      time: dateTime(data.generatedAt),
      count: data.patients.length,
    }),
  )}</p>
<div class="warn">${esc(
    T(
      'Confidential patient information. Use only during a system outage, keep it secure and shred it afterwards. Information is as of the time above – check with the patient and the paper record before acting.',
    ),
  )}</div>
<p>${esc(
    T(
      'Record everything you do on paper (medicine chart, observation chart). When the system is back, enter it with the real time it happened and the note "back-entered after downtime".',
    ),
  )}</p>
${wardSections || `<p class="none">${esc(T('No inpatients.'))}</p>`}
<h2>${esc(T('Emergency department'))}</h2>
${ed}
<h2>${esc(T("Today's operating list"))}</h2>
${theatre}
<h2>${esc(T("Today's outpatient appointments"))}</h2>
${appts}
</body></html>`;
}
