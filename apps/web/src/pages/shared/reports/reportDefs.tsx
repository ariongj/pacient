import type { ReactNode } from 'react';
import type { GenericReport, ReportName } from '../../../api/types';
import { BarChart, Donut, RankedBars, StackedBars } from '../../../components/charts';
import { formatNumber } from '../../../format';

export type Row = GenericReport['rows'][number];

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
export const SUPPRESSIBLE = new Set(['patients', 'people', 'uniquePatients']);

export const COLUMN_LABELS: Record<string, string> = {
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
};

export const columnLabel = (c: string) => COLUMN_LABELS[c] ?? c;
export const isTextColumn = (c: string) =>
  ['code', 'name', 'region', 'icd10Code', 'description', 'medication', 'vaccine'].includes(c);

/** Formats a cell for display; returns null for suppressed cells (rendered as "<5"). */
export function formatCell(column: string, value: unknown): string | null {
  if (value === null || value === undefined) return SUPPRESSIBLE.has(column) ? null : '—';
  if (column.endsWith('Pct')) return `${value}%`;
  if (column.startsWith('avgHours')) return `${value} h`;
  if (column === 'avgLeadDays') return `${value} d`;
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
  name: ReportName;
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
      { label: 'Encounters', value: formatNumber(sum(rows, 'encounters')) },
      { label: 'Appointments completed', value: formatNumber(sum(rows, 'appointmentsCompleted')) },
      {
        label: 'No-shows',
        value: formatNumber(sum(rows, 'noShows')),
        hint: `${pct(sum(rows, 'noShows'), sum(rows, 'noShows') + sum(rows, 'appointmentsCompleted'))} of attended + missed`,
      },
      { label: 'Referrals sent', value: formatNumber(sum(rows, 'referralsSent')) },
      { label: 'Vaccinations', value: formatNumber(sum(rows, 'vaccinations')) },
      {
        label: 'Emergency access',
        value: formatNumber(sum(rows, 'emergencyAccess')),
        tone: sum(rows, 'emergencyAccess') > 0 ? 'warning' : undefined,
      },
    ],
    charts: (rows) => [
      {
        title: 'Encounters by facility',
        node: (
          <RankedBars
            label="Encounters by facility"
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
        title: 'Referral flow by facility',
        node: (
          <StackedBars
            title="Referrals sent and received by facility"
            series={[
              { key: 'referralsSent', label: 'Sent', color: 'var(--primary)' },
              { key: 'referralsReceived', label: 'Received', color: 'var(--info)' },
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
      { label: 'Diagnosis codes', value: formatNumber(new Set(rows.map((r) => r.icd10Code)).size) },
      { label: 'Regions', value: formatNumber(new Set(rows.map((r) => r.region)).size) },
      {
        label: 'Suppressed cells',
        value: formatNumber(rows.filter((r) => r.suppressed).length),
        hint: 'Hidden to protect privacy',
      },
    ],
    charts: (rows) => [
      {
        title: 'Most common diagnoses',
        node: (
          <RankedBars
            label="Most common diagnoses by region"
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
        { label: 'Prescriptions', value: formatNumber(sum(rows, 'prescriptions')) },
        {
          label: 'Distinct medicines',
          value: formatNumber(new Set(rows.map((r) => r.medication)).size),
        },
        {
          label: 'Most prescribed',
          value: top ? top[0] : '—',
          hint: top ? `${formatNumber(top[1])} prescriptions` : undefined,
        },
      ];
    },
    charts: (rows) => [
      {
        title: 'Top medicines',
        node: (
          <RankedBars
            label="Top medicines by prescriptions"
            rows={topN(rows, 'medication', 'prescriptions').map(([k, v]) => ({
              key: k,
              label: k,
              value: v,
            }))}
          />
        ),
      },
      {
        title: 'Prescriptions by region',
        node: (
          <Donut
            title="Prescriptions by region"
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
        { label: 'Prescriptions', value: formatNumber(sum(rows, 'prescriptions')) },
        {
          label: 'Awaiting verification',
          value: formatNumber(sum(rows, 'awaitingVerification')),
          tone: sum(rows, 'awaitingVerification') > 0 ? 'warning' : undefined,
        },
        { label: 'Return rate', value: pct(sum(rows, 'returned'), sum(rows, 'prescriptions')) },
        { label: 'Avg. time to verify', value: verifyAvg === null ? '—' : `${verifyAvg} h` },
        { label: 'Dispensed', value: formatNumber(sum(rows, 'dispensed')), tone: 'success' },
      ];
    },
    charts: (rows) => [
      {
        title: 'Pharmacy status by facility',
        node: (
          <StackedBars
            title="Prescription status by facility"
            percent
            series={[
              { key: 'dispensed', label: 'Dispensed', color: 'var(--success)' },
              { key: 'verifiedOnly', label: 'Verified, not dispensed', color: 'var(--info)' },
              { key: 'awaiting', label: 'Awaiting verification', color: 'var(--warning)' },
              { key: 'returned', label: 'Returned', color: 'var(--danger)' },
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
        title: 'Average hours to verify',
        node: (
          <BarChart
            title="Average hours from prescription to verification, by facility"
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
      { label: 'Doses given', value: formatNumber(sum(rows, 'doses')), tone: 'success' },
      { label: 'Vaccines', value: formatNumber(new Set(rows.map((r) => r.vaccine)).size) },
      { label: 'Regions reporting', value: formatNumber(new Set(rows.map((r) => r.region)).size) },
    ],
    charts: (rows) => [
      {
        title: 'Doses by vaccine',
        node: (
          <Donut
            title="Doses by vaccine"
            data={topN(rows, 'vaccine', 'doses', 6).map(([k, v]) => ({ label: k, value: v }))}
          />
        ),
      },
      {
        title: 'Doses by region',
        node: (
          <RankedBars
            label="Doses by region"
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
        { label: 'Received', value: formatNumber(sum(rows, 'received')) },
        {
          label: 'Urgent',
          value: formatNumber(sum(rows, 'urgent')),
          tone: sum(rows, 'urgent') ? 'warning' : undefined,
        },
        {
          label: 'Pending',
          value: formatNumber(sum(rows, 'pending')),
          tone: sum(rows, 'pending') ? 'warning' : undefined,
        },
        { label: 'Acceptance rate', value: pct(accepted, accepted + declined) },
        { label: 'Avg. response time', value: response === null ? '—' : `${response} h` },
      ];
    },
    charts: (rows) => [
      {
        title: 'Outcomes by receiving facility',
        node: (
          <StackedBars
            title="Referral outcomes by receiving facility"
            series={[
              { key: 'completed', label: 'Completed', color: 'var(--success)' },
              { key: 'acceptedOpen', label: 'Accepted, in progress', color: 'var(--info)' },
              { key: 'pending', label: 'Pending', color: 'var(--warning)' },
              { key: 'declined', label: 'Declined', color: 'var(--danger)' },
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
        { label: 'Booked', value: formatNumber(sum(rows, 'booked')) },
        { label: 'Completed', value: formatNumber(sum(rows, 'completed')), tone: 'success' },
        {
          label: 'No-show rate',
          value: pct(sum(rows, 'noShows'), sum(rows, 'noShows') + sum(rows, 'completed')),
          tone: sum(rows, 'noShows') ? 'warning' : undefined,
        },
        { label: 'Cancelled', value: formatNumber(sum(rows, 'cancelled')) },
        { label: 'Avg. lead time', value: lead === null ? '—' : `${lead} days` },
      ];
    },
    charts: (rows) => [
      {
        title: 'Appointment outcomes by facility',
        node: (
          <StackedBars
            title="Appointment outcomes by facility"
            series={[
              { key: 'completed', label: 'Completed', color: 'var(--success)' },
              { key: 'open', label: 'Open', color: 'var(--info)' },
              { key: 'noShows', label: 'No-show', color: 'var(--danger)' },
              { key: 'cancelled', label: 'Cancelled', color: 'var(--text-muted)' },
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
        { label: 'Active staff', value: formatNumber(staff) },
        { label: 'Doctors', value: formatNumber(sum(rows, 'doctors')) },
        { label: 'Nurses', value: formatNumber(sum(rows, 'nurses')) },
        {
          label: 'Two-step sign-in',
          value: `${adoption}%`,
          tone: adoption >= 95 ? 'success' : adoption >= 60 ? 'warning' : 'danger',
          hint: 'Share of active staff enrolled',
        },
        {
          label: 'Pending invitations',
          value: formatNumber(sum(rows, 'pendingInvitations')),
        },
        {
          label: 'Overdue care tasks',
          value: formatNumber(sum(rows, 'overdueCareTasks')),
          tone: sum(rows, 'overdueCareTasks') ? 'danger' : undefined,
        },
      ];
    },
    charts: (rows) => [
      {
        title: 'Staff by role',
        node: (
          <Donut
            title="Active staff by role"
            data={[
              { label: 'Doctors', value: sum(rows, 'doctors') },
              { label: 'Nurses', value: sum(rows, 'nurses') },
              { label: 'Pharmacists', value: sum(rows, 'pharmacists') },
              { label: 'Reception', value: sum(rows, 'reception') },
              { label: 'Directors', value: sum(rows, 'directors') },
            ]}
          />
        ),
      },
      {
        title: 'Team composition by facility',
        node: (
          <StackedBars
            title="Staff by role and facility"
            series={[
              { key: 'doctors', label: 'Doctors' },
              { key: 'nurses', label: 'Nurses' },
              { key: 'pharmacists', label: 'Pharmacists' },
              { key: 'reception', label: 'Reception' },
              { key: 'directors', label: 'Directors' },
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
];

export const reportDef = (name: ReportName) => REPORT_DEFS.find((d) => d.name === name)!;
