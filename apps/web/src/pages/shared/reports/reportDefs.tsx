import { t } from '../../../i18n';
import type { ReactNode } from 'react';
import type { GenericReport, ReportName } from '../../../api/types';
import { BarChart, Donut, RankedBars, StackedBars } from '../../../components/charts';
import { formatNumber } from '../../../format';
import { formatMoney } from '../../../api/billing';

export type Row = GenericReport['rows'][number];

/** Hospital reports (inpatient, emergency, births, imaging) in addition to the core reports. */
export type HospitalReportName =
  'occupancy' | 'admissions' | 'emergency' | 'births' | 'imaging' | 'theatre' | 'billing';
export type AnyReportName = ReportName | HospitalReportName;

const n = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
const sum = (rows: Row[], key: string) => rows.reduce((a, r) => a + n(r[key]), 0);
const pct = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 1000) / 10}%` : '—';
const avg = (rows: Row[], key: string) => {
  const vals = rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
};
const facilityLabel = (r: Row) => String(r.name ?? r.code ?? '');

/** Patient-count columns that can be suppressed (null) by the API. */
export const SUPPRESSIBLE = new Set([
  'patients',
  'people',
  'uniquePatients',
  'admissions',
  'discharges',
  'deaths',
  'fromEmergency',
  'currentInpatients',
  'attendances',
  'ambulance',
  'admitted',
  'births',
  'critical',
]);

export const COLUMN_LABELS: Record<string, string> = {
  month: 'Month',
  charges: 'Services billed',
  totalCents: 'Total value',
  insurerCents: 'Owed by the Fund',
  copayCents: 'Co-payments due',
  copayReceivedCents: 'Co-payments received',
  claimedCents: 'Claimed, awaiting payment',
  paidByFundCents: 'Paid by the Fund',
  rejectedCents: 'Rejected by the Fund',
  consultationCents: 'Consultations',
  emergencyCents: 'Emergency',
  laboratoryCents: 'Laboratory',
  imagingCents: 'Imaging',
  bedDayCents: 'Hospital days',
  surgeryCents: 'Operations',
  pharmacyCents: 'Pharmacy',
  code: 'Code',
  name: 'Facility',
  region: 'Region',
  encounters: 'Encounters',
  uniquePatients: 'Unique patients',
  appointmentsCompleted: 'Appointments completed',
  noShows: 'No-shows',
  referralsSent: 'Referrals sent',
  referralsReceived: 'Referrals received',
  vaccinations: 'Vaccinations',
  emergencyAccess: 'Emergency access',
  icd10Code: 'ICD-10',
  description: 'Diagnosis',
  patients: 'Patients',
  medication: 'Medicine',
  prescriptions: 'Prescriptions',
  awaitingVerification: 'Awaiting verification',
  verified: 'Verified',
  returned: 'Returned',
  returnRatePct: 'Return rate',
  dispensed: 'Dispensed',
  avgHoursToVerify: 'Avg. time to verify',
  avgHoursToDispense: 'Avg. time to dispense',
  vaccine: 'Vaccine',
  doses: 'Doses',
  people: 'People vaccinated',
  sent: 'Sent',
  received: 'Received',
  urgent: 'Urgent',
  pending: 'Pending',
  accepted: 'Accepted',
  declined: 'Declined',
  completed: 'Completed',
  acceptanceRatePct: 'Acceptance rate',
  avgHoursToRespond: 'Avg. response time',
  booked: 'Booked',
  noShowRatePct: 'No-show rate',
  cancelled: 'Cancelled',
  open: 'Open',
  avgLeadDays: 'Avg. lead time',
  directors: 'Directors',
  doctors: 'Doctors',
  nurses: 'Nurses',
  pharmacists: 'Pharmacists',
  reception: 'Reception',
  activeStaff: 'Active staff',
  twoStepPct: 'Two-step sign-in',
  pendingInvitations: 'Pending invitations',
  patientsPerDoctor: 'Patients per doctor',
  overdueCareTasks: 'Overdue care tasks',
  unitType: 'Unit type',
  beds: 'Beds',
  occupied: 'Occupied',
  available: 'Free',
  cleaning: 'Being cleaned',
  outOfService: 'Out of service',
  occupancyPct: 'Occupancy',
  admissions: 'Admissions',
  discharges: 'Discharges',
  fromEmergency: 'From emergency',
  deaths: 'Deaths',
  avgLengthOfStayDays: 'Avg. length of stay',
  currentInpatients: 'Current inpatients',
  attendances: 'Attendances',
  ambulance: 'By ambulance',
  admitted: 'Admitted',
  leftUnseenPct: 'Left without being seen',
  seenWithinTargetPct: 'Seen within target',
  medianWaitL1: 'Median wait – level 1',
  medianWaitL2: 'Median wait – level 2',
  medianWaitL3: 'Median wait – level 3',
  medianWaitL4: 'Median wait – level 4',
  medianWaitL5: 'Median wait – level 5',
  births: 'Births',
  caesareanPct: 'Caesarean',
  lowBirthWeightPct: 'Low birth weight',
  pretermPct: 'Preterm',
  lowApgar5Pct: 'Apgar < 7 at 5 min',
  modality: 'Modality',
  orders: 'Orders',
  reported: 'Reported',
  outstanding: 'Outstanding',
  critical: 'Critical findings',
  medianHoursToReport: 'Median time to report',
  theatres: 'Theatres',
  cases: 'Operations',
  elective: 'Elective',
  emergency: 'Emergency',
  cancellationPct: 'Cancellation rate',
  bookedMinutes: 'Booked minutes',
  availableMinutes: 'Available minutes',
  utilisationPct: 'Theatre utilisation',
  medianHoursToOperation: 'Median time to operation',
  checklistCompletePct: 'WHO checklist complete',
};

const UNIT_TYPE_LABELS: Record<string, string> = {
  GENERAL_WARD: 'General ward',
  SURGICAL_WARD: 'Surgical ward',
  ICU: 'Intensive care',
  MATERNITY: 'Maternity',
  PAEDIATRIC: 'Paediatrics',
  NEONATAL: 'Neonatal care',
};
const MODALITY_LABELS: Record<string, string> = {
  XRAY: 'X-ray',
  CT: 'CT',
  MRI: 'MRI',
  ULTRASOUND: 'Ultrasound',
  MAMMOGRAPHY: 'Mammography',
  FLUOROSCOPY: 'Fluoroscopy',
};

export const columnLabel = (c: string) => t(COLUMN_LABELS[c] ?? c);
export const isTextColumn = (c: string) =>
  [
    'month',
    'code',
    'name',
    'region',
    'icd10Code',
    'description',
    'medication',
    'vaccine',
    'unitType',
    'modality',
  ].includes(c);

/** Formats a cell for display; returns null for suppressed cells (rendered as "<5"). */
export function formatCell(column: string, value: unknown): string | null {
  if (value === null || value === undefined) return SUPPRESSIBLE.has(column) ? null : '—';
  if (column.endsWith('Pct')) return `${value}%`;
  if (column.endsWith('Cents')) return formatMoney(Number(value));
  if (column === 'unitType') return t(UNIT_TYPE_LABELS[String(value)] ?? String(value));
  if (column === 'modality') return t(MODALITY_LABELS[String(value)] ?? String(value));
  if (column.startsWith('medianWait')) return t('{count} min', { count: String(value) });
  if (column === 'avgLengthOfStayDays') return t('{count} d', { count: String(value) });
  if (column === 'medianHoursToReport' || column === 'medianHoursToOperation')
    return t('{count} h', { count: String(value) });
  if (column.startsWith('avgHours')) return t('{count} h', { count: String(value) });
  if (column === 'avgLeadDays') return t('{count} d', { count: String(value) });
  if (typeof value === 'number') return formatNumber(value);
  return String(value);
}

export interface Kpi {
  label: string;
  value: string;
  hint?: string;
  tone?: 'warning' | 'danger' | 'success' | 'info';
}

export interface ReportDef {
  name: AnyReportName;
  title: string;
  description: string;
  /** Point-in-time reports ignore the period filter. */
  pointInTime?: boolean;
  kpis: (rows: Row[]) => Kpi[];
  charts: (rows: Row[]) => { title: string; node: ReactNode }[];
}

const topN = (rows: Row[], groupKey: string, valueKey: string, limit = 10) => {
  const map = new Map<string, number>();
  for (const r of rows)
    map.set(String(r[groupKey]), (map.get(String(r[groupKey])) ?? 0) + n(r[valueKey]));
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
};

export const REPORT_DEFS: ReportDef[] = [
  {
    name: 'activity',
    title: 'Facility activity',
    description:
      'Encounters, appointments, referrals, vaccinations and emergency access per facility.',
    kpis: (rows) => [
      { label: t('Encounters'), value: formatNumber(sum(rows, 'encounters')) },
      {
        label: t('Appointments completed'),
        value: formatNumber(sum(rows, 'appointmentsCompleted')),
      },
      {
        label: t('No-shows'),
        value: formatNumber(sum(rows, 'noShows')),
        hint: t('{pct} of attended + missed', {
          pct: pct(sum(rows, 'noShows'), sum(rows, 'noShows') + sum(rows, 'appointmentsCompleted')),
        }),
      },
      { label: t('Referrals sent'), value: formatNumber(sum(rows, 'referralsSent')) },
      { label: t('Vaccinations'), value: formatNumber(sum(rows, 'vaccinations')) },
      {
        label: t('Emergency access'),
        value: formatNumber(sum(rows, 'emergencyAccess')),
        tone: sum(rows, 'emergencyAccess') > 0 ? 'warning' : undefined,
      },
    ],
    charts: (rows) => [
      {
        title: t('Encounters by facility'),
        node: (
          <RankedBars
            label={t('Encounters by facility')}
            rows={[...rows]
              .sort((a, b) => n(b.encounters) - n(a.encounters))
              .map((r) => ({
                key: String(r.code),
                label: facilityLabel(r),
                value: n(r.encounters),
              }))}
          />
        ),
      },
      {
        title: t('Referral flow by facility'),
        node: (
          <StackedBars
            title={t('Referrals sent and received by facility')}
            series={[
              { key: 'referralsSent', label: t('Sent'), color: 'var(--primary)' },
              { key: 'referralsReceived', label: t('Received'), color: 'var(--info)' },
            ]}
            rows={rows.map((r) => ({
              label: facilityLabel(r),
              values: {
                referralsSent: n(r.referralsSent),
                referralsReceived: n(r.referralsReceived),
              },
            }))}
          />
        ),
      },
    ],
  },
  {
    name: 'diagnoses',
    title: 'Diagnoses by region',
    description: 'Patients diagnosed per ICD-10 code and region – the core disease-burden view.',
    kpis: (rows) => [
      {
        label: t('Diagnosis codes'),
        value: formatNumber(new Set(rows.map((r) => r.icd10Code)).size),
      },
      { label: t('Regions'), value: formatNumber(new Set(rows.map((r) => r.region)).size) },
      {
        label: t('Suppressed cells'),
        value: formatNumber(rows.filter((r) => r.suppressed).length),
        hint: t('Hidden to protect privacy'),
      },
    ],
    charts: (rows) => [
      {
        title: t('Most common diagnoses'),
        node: (
          <RankedBars
            label={t('Most common diagnoses by region')}
            rows={rows.slice(0, 10).map((r, i) => ({
              key: `${r.icd10Code}-${r.region}-${i}`,
              label: `${r.description} · ${r.region}`,
              sublabel: String(r.icd10Code),
              value: r.patients === null ? null : n(r.patients),
              suppressed: Boolean(r.suppressed),
            }))}
          />
        ),
      },
    ],
  },
  {
    name: 'medications',
    title: 'Medicines prescribed',
    description: 'Prescribing volume by active ingredient and region.',
    kpis: (rows) => {
      const top = topN(rows, 'medication', 'prescriptions', 1)[0];
      return [
        { label: t('Prescriptions'), value: formatNumber(sum(rows, 'prescriptions')) },
        {
          label: t('Distinct medicines'),
          value: formatNumber(new Set(rows.map((r) => r.medication)).size),
        },
        {
          label: t('Most prescribed'),
          value: top ? top[0] : '—',
          hint: top ? t('{count} prescriptions', { count: formatNumber(top[1]) }) : undefined,
        },
      ];
    },
    charts: (rows) => [
      {
        title: t('Top medicines'),
        node: (
          <RankedBars
            label={t('Top medicines by prescriptions')}
            rows={topN(rows, 'medication', 'prescriptions').map(([k, v]) => ({
              key: k,
              label: k,
              value: v,
            }))}
          />
        ),
      },
      {
        title: t('Prescriptions by region'),
        node: (
          <Donut
            title={t('Prescriptions by region')}
            data={topN(rows, 'region', 'prescriptions', 6).map(([k, v]) => ({
              label: k,
              value: v,
            }))}
          />
        ),
      },
    ],
  },
  {
    name: 'pharmacy',
    title: 'Pharmacy performance',
    description: 'Verification queue, returns to prescribers and turnaround per facility.',
    kpis: (rows) => {
      const verifyAvg = avg(rows, 'avgHoursToVerify');
      return [
        { label: t('Prescriptions'), value: formatNumber(sum(rows, 'prescriptions')) },
        {
          label: t('Awaiting verification'),
          value: formatNumber(sum(rows, 'awaitingVerification')),
          tone: sum(rows, 'awaitingVerification') > 0 ? 'warning' : undefined,
        },
        { label: t('Return rate'), value: pct(sum(rows, 'returned'), sum(rows, 'prescriptions')) },
        {
          label: t('Avg. time to verify'),
          value: verifyAvg === null ? '—' : t('{count} h', { count: verifyAvg }),
        },
        { label: t('Dispensed'), value: formatNumber(sum(rows, 'dispensed')), tone: 'success' },
      ];
    },
    charts: (rows) => [
      {
        title: t('Pharmacy status by facility'),
        node: (
          <StackedBars
            title={t('Prescription status by facility')}
            percent
            series={[
              { key: 'dispensed', label: t('Dispensed'), color: 'var(--success)' },
              { key: 'verifiedOnly', label: t('Verified, not dispensed'), color: 'var(--info)' },
              { key: 'awaiting', label: t('Awaiting verification'), color: 'var(--warning)' },
              { key: 'returned', label: t('Returned'), color: 'var(--danger)' },
            ]}
            rows={rows.map((r) => ({
              label: facilityLabel(r),
              values: {
                dispensed: n(r.dispensed),
                verifiedOnly: Math.max(0, n(r.verified) - n(r.dispensed)),
                awaiting: n(r.awaitingVerification),
                returned: n(r.returned),
              },
            }))}
          />
        ),
      },
      {
        title: t('Average hours to verify'),
        node: (
          <BarChart
            title={t('Average hours from prescription to verification, by facility')}
            data={rows.map((r) => ({ label: String(r.code), value: n(r.avgHoursToVerify) }))}
          />
        ),
      },
    ],
  },
  {
    name: 'vaccinations',
    title: 'Vaccinations',
    description: 'Doses given and people vaccinated, by vaccine and region.',
    kpis: (rows) => [
      { label: t('Doses given'), value: formatNumber(sum(rows, 'doses')), tone: 'success' },
      { label: t('Vaccines'), value: formatNumber(new Set(rows.map((r) => r.vaccine)).size) },
      {
        label: t('Regions reporting'),
        value: formatNumber(new Set(rows.map((r) => r.region)).size),
      },
    ],
    charts: (rows) => [
      {
        title: t('Doses by vaccine'),
        node: (
          <Donut
            title={t('Doses by vaccine')}
            data={topN(rows, 'vaccine', 'doses', 6).map(([k, v]) => ({ label: k, value: v }))}
          />
        ),
      },
      {
        title: t('Doses by region'),
        node: (
          <RankedBars
            label={t('Doses by region')}
            rows={topN(rows, 'region', 'doses').map(([k, v]) => ({ key: k, label: k, value: v }))}
          />
        ),
      },
    ],
  },
  {
    name: 'referrals',
    title: 'Referral flow',
    description: 'Referrals sent and received, outcomes, acceptance rate and response time.',
    kpis: (rows) => {
      const accepted = sum(rows, 'accepted');
      const declined = sum(rows, 'declined');
      const response = avg(rows, 'avgHoursToRespond');
      return [
        { label: t('Received'), value: formatNumber(sum(rows, 'received')) },
        {
          label: t('Urgent'),
          value: formatNumber(sum(rows, 'urgent')),
          tone: sum(rows, 'urgent') ? 'warning' : undefined,
        },
        {
          label: t('Pending'),
          value: formatNumber(sum(rows, 'pending')),
          tone: sum(rows, 'pending') ? 'warning' : undefined,
        },
        { label: t('Acceptance rate'), value: pct(accepted, accepted + declined) },
        {
          label: t('Avg. response time'),
          value: response === null ? '—' : t('{count} h', { count: response }),
        },
      ];
    },
    charts: (rows) => [
      {
        title: t('Outcomes by receiving facility'),
        node: (
          <StackedBars
            title={t('Referral outcomes by receiving facility')}
            series={[
              { key: 'completed', label: t('Completed'), color: 'var(--success)' },
              { key: 'acceptedOpen', label: t('Accepted, in progress'), color: 'var(--info)' },
              { key: 'pending', label: t('Pending'), color: 'var(--warning)' },
              { key: 'declined', label: t('Declined'), color: 'var(--danger)' },
            ]}
            rows={rows.map((r) => ({
              label: facilityLabel(r),
              values: {
                completed: n(r.completed),
                acceptedOpen: Math.max(0, n(r.accepted) - n(r.completed)),
                pending: n(r.pending),
                declined: n(r.declined),
              },
            }))}
          />
        ),
      },
    ],
  },
  {
    name: 'appointments',
    title: 'Appointments & no-shows',
    description:
      'Booked, completed, missed and cancelled appointments, with no-show rate and lead time.',
    kpis: (rows) => {
      const lead = avg(rows, 'avgLeadDays');
      return [
        { label: t('Booked'), value: formatNumber(sum(rows, 'booked')) },
        { label: t('Completed'), value: formatNumber(sum(rows, 'completed')), tone: 'success' },
        {
          label: t('No-show rate'),
          value: pct(sum(rows, 'noShows'), sum(rows, 'noShows') + sum(rows, 'completed')),
          tone: sum(rows, 'noShows') ? 'warning' : undefined,
        },
        { label: t('Cancelled'), value: formatNumber(sum(rows, 'cancelled')) },
        {
          label: t('Avg. lead time'),
          value: lead === null ? '—' : t('{count} days', { count: lead }),
        },
      ];
    },
    charts: (rows) => [
      {
        title: t('Appointment outcomes by facility'),
        node: (
          <StackedBars
            title={t('Appointment outcomes by facility')}
            series={[
              { key: 'completed', label: t('Completed'), color: 'var(--success)' },
              { key: 'open', label: t('Open'), color: 'var(--info)' },
              { key: 'noShows', label: t('No-show'), color: 'var(--danger)' },
              { key: 'cancelled', label: t('Cancelled'), color: 'var(--text-muted)' },
            ]}
            rows={rows.map((r) => ({
              label: facilityLabel(r),
              values: {
                completed: n(r.completed),
                open: n(r.open),
                noShows: n(r.noShows),
                cancelled: n(r.cancelled),
              },
            }))}
          />
        ),
      },
    ],
  },
  {
    name: 'workforce',
    title: 'Workforce & security',
    description:
      'Staff by role, two-step sign-in adoption, pending invitations and overdue care tasks.',
    pointInTime: true,
    kpis: (rows) => {
      const staff = sum(rows, 'activeStaff');
      const twoStep = rows.reduce((a, r) => a + (n(r.twoStepPct) / 100) * n(r.activeStaff), 0);
      const adoption = staff ? Math.round((twoStep / staff) * 100) : 0;
      return [
        { label: t('Active staff'), value: formatNumber(staff) },
        { label: t('Doctors'), value: formatNumber(sum(rows, 'doctors')) },
        { label: t('Nurses'), value: formatNumber(sum(rows, 'nurses')) },
        {
          label: t('Two-step sign-in'),
          value: `${adoption}%`,
          tone: adoption >= 95 ? 'success' : adoption >= 60 ? 'warning' : 'danger',
          hint: t('Share of active staff enrolled'),
        },
        {
          label: t('Pending invitations'),
          value: formatNumber(sum(rows, 'pendingInvitations')),
        },
        {
          label: t('Overdue care tasks'),
          value: formatNumber(sum(rows, 'overdueCareTasks')),
          tone: sum(rows, 'overdueCareTasks') ? 'danger' : undefined,
        },
      ];
    },
    charts: (rows) => [
      {
        title: t('Staff by role'),
        node: (
          <Donut
            title={t('Active staff by role')}
            data={[
              { label: t('Doctors'), value: sum(rows, 'doctors') },
              { label: t('Nurses'), value: sum(rows, 'nurses') },
              { label: t('Pharmacists'), value: sum(rows, 'pharmacists') },
              { label: t('Reception'), value: sum(rows, 'reception') },
              { label: t('Directors'), value: sum(rows, 'directors') },
            ]}
          />
        ),
      },
      {
        title: t('Team composition by facility'),
        node: (
          <StackedBars
            title={t('Staff by role and facility')}
            series={[
              { key: 'doctors', label: t('Doctors') },
              { key: 'nurses', label: t('Nurses') },
              { key: 'pharmacists', label: t('Pharmacists') },
              { key: 'reception', label: t('Reception') },
              { key: 'directors', label: t('Directors') },
            ]}
            rows={rows.map((r) => ({
              label: facilityLabel(r),
              values: {
                doctors: n(r.doctors),
                nurses: n(r.nurses),
                pharmacists: n(r.pharmacists),
                reception: n(r.reception),
                directors: n(r.directors),
              },
            }))}
          />
        ),
      },
    ],
  },
  {
    name: 'occupancy',
    title: 'Bed occupancy',
    description:
      'Beds, occupied, free, being cleaned and out of service, by facility and unit type.',
    pointInTime: true,
    kpis: (rows) => {
      const beds = sum(rows, 'beds') - sum(rows, 'outOfService');
      const occupied = sum(rows, 'occupied');
      const rate = beds ? Math.round((occupied / beds) * 100) : 0;
      return [
        {
          label: t('Occupancy'),
          value: `${rate}%`,
          tone: rate >= 90 ? 'danger' : rate >= 80 ? 'warning' : 'success',
          hint: t('{occupied} of {total} beds in service', {
            occupied: formatNumber(occupied),
            total: formatNumber(beds),
          }),
        },
        { label: t('Free beds'), value: formatNumber(sum(rows, 'available')) },
        { label: t('Being cleaned'), value: formatNumber(sum(rows, 'cleaning')) },
        {
          label: t('Out of service'),
          value: formatNumber(sum(rows, 'outOfService')),
          tone: sum(rows, 'outOfService') ? 'warning' : undefined,
        },
      ];
    },
    charts: (rows) => {
      const byType = new Map<string, Record<string, number>>();
      for (const r of rows) {
        const key = String(r.unitType);
        const cur = byType.get(key) ?? { occupied: 0, available: 0, cleaning: 0, outOfService: 0 };
        for (const k of Object.keys(cur)) cur[k]! += n(r[k]);
        byType.set(key, cur);
      }
      return [
        {
          title: t('Beds by unit type'),
          node: (
            <StackedBars
              title={t('Bed status by unit type')}
              series={[
                { key: 'occupied', label: t('Occupied'), color: 'var(--primary)' },
                { key: 'available', label: t('Free'), color: 'var(--success)' },
                { key: 'cleaning', label: t('Being cleaned'), color: 'var(--warning)' },
                { key: 'outOfService', label: t('Out of service'), color: 'var(--text-muted)' },
              ]}
              rows={[...byType.entries()].map(([type, values]) => ({
                label: t(UNIT_TYPE_LABELS[type] ?? type),
                values,
              }))}
            />
          ),
        },
        {
          title: t('Occupancy by facility'),
          node: (
            <RankedBars
              label={t('Occupancy by facility')}
              rows={topN(rows, 'name', 'occupied').map(([name, occupied]) => {
                const beds = rows
                  .filter((r) => r.name === name)
                  .reduce((a, r) => a + n(r.beds) - n(r.outOfService), 0);
                return {
                  key: name,
                  label: name,
                  sublabel: beds ? `${Math.round((occupied / beds) * 100)}%` : undefined,
                  value: occupied,
                };
              })}
            />
          ),
        },
      ];
    },
  },
  {
    name: 'admissions',
    title: 'Admissions & length of stay',
    description:
      'Admissions, discharges, admissions from emergency and average length of stay by unit type.',
    kpis: (rows) => [
      { label: t('Admissions'), value: formatNumber(sum(rows, 'admissions')) },
      { label: t('Discharges'), value: formatNumber(sum(rows, 'discharges')) },
      {
        label: t('From emergency'),
        value: formatNumber(sum(rows, 'fromEmergency')),
        hint: t('{pct} of admissions', {
          pct: pct(sum(rows, 'fromEmergency'), sum(rows, 'admissions')),
        }),
      },
      {
        label: t('Avg. length of stay'),
        value:
          avg(rows, 'avgLengthOfStayDays') === null
            ? '—'
            : t('{count} d', { count: String(avg(rows, 'avgLengthOfStayDays')) }),
      },
      { label: t('Current inpatients'), value: formatNumber(sum(rows, 'currentInpatients')) },
    ],
    charts: (rows) => [
      {
        title: t('Admissions by unit type'),
        node: (
          <BarChart
            title={t('Admissions by unit type')}
            data={topN(rows, 'unitType', 'admissions').map(([type, value]) => ({
              label: t(UNIT_TYPE_LABELS[type] ?? type),
              value,
            }))}
          />
        ),
      },
    ],
  },
  {
    name: 'emergency',
    title: 'Emergency department',
    description:
      'Attendances, median wait to be seen by triage level, share seen within target and left without being seen.',
    kpis: (rows) => [
      { label: t('Attendances'), value: formatNumber(sum(rows, 'attendances')) },
      { label: t('By ambulance'), value: formatNumber(sum(rows, 'ambulance')) },
      { label: t('Admitted'), value: formatNumber(sum(rows, 'admitted')) },
      {
        label: t('Seen within target'),
        value:
          avg(rows, 'seenWithinTargetPct') === null ? '—' : `${avg(rows, 'seenWithinTargetPct')}%`,
        hint: t(
          'Targets: level 1 at once, 2 within 10 min, 3 within 60, 4 within 120, 5 within 240',
        ),
      },
      {
        label: t('Left without being seen'),
        value: avg(rows, 'leftUnseenPct') === null ? '—' : `${avg(rows, 'leftUnseenPct')}%`,
        tone: n(avg(rows, 'leftUnseenPct')) > 5 ? 'warning' : undefined,
      },
    ],
    charts: (rows) => [
      {
        title: t('Median wait to be seen by triage level (minutes)'),
        node: (
          <BarChart
            title={t('Median wait by triage level')}
            data={[1, 2, 3, 4, 5].map((level) => ({
              label: t('Level {level}', { level }),
              value: n(avg(rows, `medianWaitL${level}`)),
            }))}
          />
        ),
      },
    ],
  },
  {
    name: 'births',
    title: 'Births',
    description:
      'Births per facility with caesarean, low birth weight (< 2500 g), preterm (< 37 weeks) and low Apgar rates.',
    kpis: (rows) => [
      { label: t('Births'), value: formatNumber(sum(rows, 'births')) },
      {
        label: t('Caesarean'),
        value: avg(rows, 'caesareanPct') === null ? '—' : `${avg(rows, 'caesareanPct')}%`,
      },
      {
        label: t('Low birth weight'),
        value: avg(rows, 'lowBirthWeightPct') === null ? '—' : `${avg(rows, 'lowBirthWeightPct')}%`,
      },
      {
        label: t('Preterm'),
        value: avg(rows, 'pretermPct') === null ? '—' : `${avg(rows, 'pretermPct')}%`,
      },
    ],
    charts: (rows) => [
      {
        title: t('Births by facility'),
        node: (
          <RankedBars
            label={t('Births by facility')}
            rows={rows.map((r) => ({
              key: String(r.code),
              label: facilityLabel(r),
              value: r.births === null ? null : n(r.births),
              suppressed: r.births === null,
            }))}
          />
        ),
      },
    ],
  },
  {
    name: 'imaging',
    title: 'Imaging',
    description: 'Examinations by modality, outstanding work and median time from order to report.',
    kpis: (rows) => [
      { label: t('Orders'), value: formatNumber(sum(rows, 'orders')) },
      { label: t('Reported'), value: formatNumber(sum(rows, 'reported')) },
      {
        label: t('Outstanding'),
        value: formatNumber(sum(rows, 'outstanding')),
        tone: sum(rows, 'outstanding') ? 'warning' : undefined,
      },
      {
        label: t('Median time to report'),
        value:
          avg(rows, 'medianHoursToReport') === null
            ? '—'
            : t('{count} h', { count: String(avg(rows, 'medianHoursToReport')) }),
      },
    ],
    charts: (rows) => [
      {
        title: t('Examinations by modality'),
        node: (
          <Donut
            title={t('Examinations by modality')}
            data={topN(rows, 'modality', 'orders').map(([m, value]) => ({
              label: t(MODALITY_LABELS[m] ?? m),
              value,
            }))}
          />
        ),
      },
    ],
  },
  {
    name: 'theatre',
    title: 'Operating theatres',
    description:
      'Booked theatre time against 8 hours per theatre per weekday, operations by priority, cancellations, time from request to operation and WHO checklist completion.',
    kpis: (rows) => {
      const booked = sum(rows, 'bookedMinutes');
      const available = sum(rows, 'availableMinutes');
      const completed = sum(rows, 'completed');
      const checklistRows = rows.filter((r) => typeof r.checklistCompletePct === 'number');
      return [
        { label: t('Operations'), value: formatNumber(sum(rows, 'cases')) },
        {
          label: t('Theatre utilisation'),
          value: pct(booked, available),
          tone: available && booked / available < 0.5 ? 'warning' : undefined,
        },
        {
          label: t('Cancellation rate'),
          value: pct(sum(rows, 'cancelled'), sum(rows, 'cases')),
        },
        {
          label: t('WHO checklist complete'),
          value: checklistRows.length
            ? `${avg(checklistRows, 'checklistCompletePct')}%`
            : completed
              ? '—'
              : '—',
          tone:
            checklistRows.length && (avg(checklistRows, 'checklistCompletePct') ?? 100) < 100
              ? 'warning'
              : undefined,
        },
      ];
    },
    charts: (rows) => [
      {
        title: t('Operations by priority'),
        node: (
          <Donut
            title={t('Operations by priority')}
            data={[
              { label: t('Elective'), value: sum(rows, 'elective') },
              { label: t('Urgent'), value: sum(rows, 'urgent') },
              { label: t('Emergency'), value: sum(rows, 'emergency') },
            ]}
          />
        ),
      },
    ],
  },
  {
    name: 'billing',
    title: 'Billing and insurance claims',
    description:
      'What care produced per month (demo national tariff), the part owed by the Health Insurance Fund and by patients, co-payments received and the state of claims. No patient data.',
    kpis: (rows) => [
      { label: t('Total value'), value: formatMoney(sum(rows, 'totalCents')) },
      { label: t('Owed by the Fund'), value: formatMoney(sum(rows, 'insurerCents')) },
      { label: t('Paid by the Fund'), value: formatMoney(sum(rows, 'paidByFundCents')) },
      {
        label: t('Co-payments received'),
        value: formatMoney(sum(rows, 'copayReceivedCents')),
        hint: t('of {amount} due', { amount: formatMoney(sum(rows, 'copayCents')) }),
      },
      {
        label: t('Rejected by the Fund'),
        value: formatMoney(sum(rows, 'rejectedCents')),
        tone: sum(rows, 'rejectedCents') > 0 ? 'warning' : undefined,
      },
    ],
    charts: (rows) => [
      {
        title: t('Value by category'),
        node: (
          <Donut
            title={t('Value by category')}
            data={[
              ['consultationCents', 'Consultations'],
              ['emergencyCents', 'Emergency'],
              ['laboratoryCents', 'Laboratory'],
              ['imagingCents', 'Imaging'],
              ['bedDayCents', 'Hospital days'],
              ['surgeryCents', 'Operations'],
              ['pharmacyCents', 'Pharmacy'],
            ].map(([key, label]) => ({
              label: t(label!),
              value: Math.round(sum(rows, key!) / 100),
            }))}
          />
        ),
      },
    ],
  },
];

export const reportDef = (name: AnyReportName) => REPORT_DEFS.find((d) => d.name === name)!;
