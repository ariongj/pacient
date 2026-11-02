import { t } from '../../../i18n';
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

export const columnLabel = (c: string) => t(COLUMN_LABELS[c] ?? c);
export const isTextColumn = (c: string) =>
  ['code', 'name', 'region', 'icd10Code', 'description', 'medication', 'vaccine'].includes(c);

/** Formats a cell for display; returns null for suppressed cells (rendered as "<5"). */
export function formatCell(column: string, value: unknown): string | null {
  if (value === null || value === undefined) return SUPPRESSIBLE.has(column) ? null : '—';
  if (column.endsWith('Pct')) return `${value}%`;
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
];

export const reportDef = (name: ReportName) => REPORT_DEFS.find((d) => d.name === name)!;
