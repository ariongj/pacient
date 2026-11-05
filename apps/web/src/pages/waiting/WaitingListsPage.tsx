import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  priorityLabel,
  specialtyLabel,
  useNationalWaiting,
  usePublicWaitingTimes,
  useWaitingDashboard,
  useWaitingList,
  useWaitingReference,
  waitingStatusLabel,
  type WaitingPriority,
  type WaitingStatus,
  type WaitStats,
} from '../../api/waiting';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  Pagination,
  QueryView,
  SelectField,
  Stat,
  TabPanel,
  Table,
  Tabs,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime, formatNumber } from '../../format';
import { t } from '../../i18n';
import {
  PriorityBadge,
  WaitBadge,
  WaitingEntryDialog,
  WaitingStatusBadge,
} from './WaitingComponents';

type TabId = 'list' | 'dashboard' | 'national' | 'public';

const STATUS_FILTERS: (WaitingStatus | 'ACTIVE')[] = [
  'ACTIVE',
  'WAITING',
  'SCHEDULED',
  'SUSPENDED',
  'COMPLETED',
  'REMOVED',
];
const PRIORITY_FILTERS: WaitingPriority[] = ['URGENT', 'PRIORITY', 'ROUTINE'];

const days = (n: number | null) => (n === null ? '—' : t('{days} d', { days: n }));
const cell = (n: number | null) => (n === null ? '—' : formatNumber(n));

/**
 * Elective waiting lists: the facility list (doctors, reception, directors), the facility
 * dashboard (directors, doctors), the national view (Ministry) and the published waiting times.
 */
export function WaitingListsPage() {
  const user = useUser();
  const tabs: { id: TabId; label: string }[] =
    user.role === 'MINISTRY'
      ? [
          { id: 'national', label: t('National waiting times') },
          { id: 'public', label: t('Published waiting times') },
        ]
      : [
          { id: 'list', label: t('Waiting list') },
          ...(user.role === 'DIRECTOR' || user.role === 'DOCTOR'
            ? [{ id: 'dashboard' as const, label: t('Dashboard') }]
            : []),
          { id: 'public', label: t('Published waiting times') },
        ];
  const [tab, setTab] = useState<TabId>(
    user.role === 'MINISTRY' ? 'national' : user.role === 'DIRECTOR' ? 'dashboard' : 'list',
  );
  return (
    <>
      <PageHeader
        title={t('Waiting lists')}
        subtitle={t(
          'Planned operations and first specialist appointments. Maximum waiting times: urgent 30 days, priority 90 days, routine 180 days.',
        )}
      />
      <Tabs tabs={tabs} active={tab} onChange={setTab} label={t('Waiting lists')} />
      <TabPanel id={tab}>
        {tab === 'list' && <ListTab />}
        {tab === 'dashboard' && <DashboardTab />}
        {tab === 'national' && <NationalTab />}
        {tab === 'public' && <PublicTab />}
      </TabPanel>
    </>
  );
}

function ListTab() {
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const ref = useWaitingReference();
  const [filters, setFilters] = useState({
    specialty: '',
    status: 'ACTIVE',
    priority: '',
    breached: '',
    q: '',
  });
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const list = useWaitingList({
    page,
    specialty: filters.specialty || undefined,
    status: filters.status,
    priority: filters.priority || undefined,
    breached: filters.breached || undefined,
    q: filters.q || undefined,
  });
  const openId = params.get('entry');
  const setOpen = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('entry', id);
    else next.delete('entry');
    setParams(next, { replace: true });
  };
  const set = (k: keyof typeof filters) => (v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };
  return (
    <Card>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          set('q')(search.trim());
        }}
      >
        <SelectField
          label={t('Specialty')}
          value={filters.specialty}
          onChange={(e) => set('specialty')(e.target.value)}
          placeholder={t('All specialties')}
          options={(ref.data?.specialties ?? [])
            .map((s) => ({ value: s.code, label: specialtyLabel(s.code) }))
            .sort((a, b) => a.label.localeCompare(b.label))}
        />
        <SelectField
          label={t('Status')}
          value={filters.status}
          onChange={(e) => set('status')(e.target.value)}
          options={STATUS_FILTERS.map((s) => ({
            value: s,
            label: s === 'ACTIVE' ? t('Active (not yet treated)') : waitingStatusLabel(s),
          }))}
        />
        <SelectField
          label={t('Priority')}
          value={filters.priority}
          onChange={(e) => set('priority')(e.target.value)}
          placeholder={t('All priorities')}
          options={PRIORITY_FILTERS.map((p) => ({ value: p, label: priorityLabel(p) }))}
        />
        <SelectField
          label={t('Maximum wait')}
          value={filters.breached}
          onChange={(e) => set('breached')(e.target.value)}
          placeholder={t('All')}
          options={[
            { value: 'true', label: t('Over the maximum wait') },
            { value: 'false', label: t('Within the maximum wait') },
          ]}
        />
        <TextField
          label={t('Search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('Name, national ID or procedure')}
          type="search"
        />
        <div className="form-actions" style={{ alignSelf: 'end' }}>
          <Button type="submit" variant="secondary">
            {t('Search')}
          </Button>
        </div>
      </form>
      <QueryView query={list}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No patients on this list')}>
              {t('Doctors add patients from the patient’s chart (tab “Waiting lists”).')}
            </EmptyState>
          ) : (
            <>
              <p className="muted">{t('{count} entries', { count: data.total })}</p>
              <Table caption={t('Waiting list')}>
                <thead>
                  <tr>
                    <th>{t('Patient')}</th>
                    <th>{t('Procedure')}</th>
                    <th>{t('Priority')}</th>
                    <th>{t('Added')}</th>
                    <th>{t('Waiting time')}</th>
                    <th>{t('Target date')}</th>
                    <th>{t('Status')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((e) => (
                    <tr key={e.id}>
                      <td>
                        {user.role === 'DOCTOR' && e.patient ? (
                          <Link to={`/doctor/patients/${e.patientId}?tab=waiting`}>
                            {e.patient.name}
                          </Link>
                        ) : (
                          e.patient?.name
                        )}
                        <div className="muted mono">{e.patient?.nationalId}</div>
                      </td>
                      <td>
                        {e.procedureName}
                        <div className="muted">{specialtyLabel(e.specialty)}</div>
                      </td>
                      <td>
                        <PriorityBadge priority={e.priority} />
                      </td>
                      <td>{formatDate(e.addedAt)}</td>
                      <td>
                        <WaitBadge e={e} />
                      </td>
                      <td>{formatDate(e.targetDate)}</td>
                      <td>
                        <WaitingStatusBadge status={e.status} />
                        {e.scheduledFor && (
                          <div className="muted">{formatDateTime(e.scheduledFor)}</div>
                        )}
                      </td>
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => setOpen(e.id)}>
                          {t('Open')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <Pagination page={data.page} totalPages={data.totalPages} onChange={setPage} />
            </>
          )
        }
      </QueryView>
      <WaitingEntryDialog id={openId} onClose={() => setOpen(null)} />
    </Card>
  );
}

function DashboardTab() {
  const dash = useWaitingDashboard();
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <QueryView query={dash}>
      {(d) => (
        <div className="stack">
          <Grid>
            <Stat label={t('Patients waiting')} value={cell(d.totals?.count ?? 0)} />
            <Stat
              label={t('Over the maximum wait')}
              value={cell(d.totals?.breaches ?? 0)}
              tone={(d.totals?.breaches ?? 0) > 0 ? 'danger' : undefined}
            />
            <Stat label={t('Median wait')} value={days(d.totals?.medianDays ?? null)} />
            <Stat
              label={t('Treated within the maximum wait')}
              value={
                d.completedLast12Months.withinTargetPct === null
                  ? '—'
                  : `${d.completedLast12Months.withinTargetPct}%`
              }
              hint={t('{count} treated in the last 12 months', {
                count: d.completedLast12Months.count,
              })}
            />
          </Grid>
          <Card title={t('By specialty')}>
            {d.bySpecialty.length === 0 ? (
              <EmptyState title={t('No patients on this list')} />
            ) : (
              <Table caption={t('By specialty')}>
                <thead>
                  <tr>
                    <th>{t('Specialty')}</th>
                    <th>{t('Waiting')}</th>
                    <th>{t('Urgent')}</th>
                    <th>{t('Scheduled')}</th>
                    <th>{t('Postponed')}</th>
                    <th>{t('Median wait')}</th>
                    <th>{t('90th percentile')}</th>
                    <th>{t('Longest wait')}</th>
                    <th>{t('Over the maximum wait')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.bySpecialty.map((r) => (
                    <tr key={r.specialty}>
                      <td>{specialtyLabel(r.specialty)}</td>
                      <td>{cell(r.count)}</td>
                      <td>{cell(r.urgent)}</td>
                      <td>{cell(r.scheduled)}</td>
                      <td>{cell(r.suspended)}</td>
                      <td>{days(r.medianDays)}</td>
                      <td>{days(r.p90Days)}</td>
                      <td>{days(r.longestDays)}</td>
                      <td>{cell(r.breaches)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title={t('Longest waits (relative to the maximum)')}>
            {d.longestWaits.length === 0 ? (
              <EmptyState title={t('No patients on this list')} />
            ) : (
              <Table caption={t('Longest waits (relative to the maximum)')}>
                <thead>
                  <tr>
                    <th>{t('Patient')}</th>
                    <th>{t('Procedure')}</th>
                    <th>{t('Priority')}</th>
                    <th>{t('Waiting time')}</th>
                    <th>{t('Status')}</th>
                    <th>
                      <span className="sr-only">{t('Actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.longestWaits.map((e) => (
                    <tr key={e.id}>
                      <td>{e.patient?.name ?? '—'}</td>
                      <td>
                        {e.procedureName}
                        <div className="muted">{specialtyLabel(e.specialty)}</div>
                      </td>
                      <td>
                        <PriorityBadge priority={e.priority} />
                      </td>
                      <td>
                        <WaitBadge e={e} />
                      </td>
                      <td>
                        <WaitingStatusBadge status={e.status} />
                      </td>
                      <td>
                        <Button size="sm" variant="secondary" onClick={() => setOpenId(e.id)}>
                          {t('Open')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <WaitingEntryDialog id={openId} onClose={() => setOpenId(null)} />
        </div>
      )}
    </QueryView>
  );
}

function StatsCells({ r, threshold }: { r: WaitStats; threshold: number }) {
  return (
    <>
      <td>{r.suppressed ? t('fewer than {n}', { n: threshold }) : cell(r.count)}</td>
      <td>{days(r.medianDays)}</td>
      <td>{days(r.p90Days)}</td>
      <td>{cell(r.breaches)}</td>
    </>
  );
}

function NationalTab() {
  const national = useNationalWaiting();
  return (
    <QueryView query={national}>
      {(n) => (
        <div className="stack">
          <Alert tone="info">
            {t(
              'Aggregate figures only. Groups with fewer than {n} patients are suppressed to protect privacy.',
              { n: n.smallCellThreshold },
            )}
          </Alert>
          <Grid>
            <Stat label={t('Patients waiting')} value={cell(n.totals?.count ?? null)} />
            <Stat label={t('Median wait')} value={days(n.totals?.medianDays ?? null)} />
            <Stat label={t('90th percentile')} value={days(n.totals?.p90Days ?? null)} />
            <Stat
              label={t('Over the maximum wait')}
              value={cell(n.totals?.breaches ?? null)}
              tone={(n.totals?.breaches ?? 0) > 0 ? 'danger' : undefined}
            />
          </Grid>
          <Card title={t('By specialty')}>
            <Table caption={t('By specialty')}>
              <thead>
                <tr>
                  <th>{t('Specialty')}</th>
                  <th>{t('Waiting')}</th>
                  <th>{t('Median wait')}</th>
                  <th>{t('90th percentile')}</th>
                  <th>{t('Over the maximum wait')}</th>
                </tr>
              </thead>
              <tbody>
                {n.bySpecialty.map((r) => (
                  <tr key={r.specialty}>
                    <td>{specialtyLabel(r.specialty)}</td>
                    <StatsCells r={r} threshold={n.smallCellThreshold} />
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Card title={t('By facility and specialty')}>
            <Table caption={t('By facility and specialty')}>
              <thead>
                <tr>
                  <th>{t('Facility')}</th>
                  <th>{t('Specialty')}</th>
                  <th>{t('Waiting')}</th>
                  <th>{t('Median wait')}</th>
                  <th>{t('90th percentile')}</th>
                  <th>{t('Over the maximum wait')}</th>
                </tr>
              </thead>
              <tbody>
                {n.byFacility.map((r) => (
                  <tr key={`${r.facilityId}-${r.specialty}`}>
                    <td>{r.facilityName}</td>
                    <td>{specialtyLabel(r.specialty)}</td>
                    <StatsCells r={r} threshold={n.smallCellThreshold} />
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      )}
    </QueryView>
  );
}

function PublicTab() {
  const times = usePublicWaitingTimes();
  return (
    <Card title={t('Published waiting times')}>
      <p className="muted">
        {t(
          'These figures are public (no sign-in needed, endpoint /api/v1/waiting-lists/public/times): days waited by patients treated in the last 12 months. No personal data; small groups are not shown.',
        )}
      </p>
      <QueryView query={times}>
        {(p) =>
          p.items.length === 0 ? (
            <EmptyState title={t('No published waiting times yet')} />
          ) : (
            <Table caption={t('Published waiting times')}>
              <thead>
                <tr>
                  <th>{t('Facility')}</th>
                  <th>{t('Specialty')}</th>
                  <th>{t('Treated')}</th>
                  <th>{t('Median wait')}</th>
                  <th>{t('90th percentile')}</th>
                </tr>
              </thead>
              <tbody>
                {p.items.map((r) => (
                  <tr key={`${r.facilityName}-${r.specialty}-${r.kind}`}>
                    <td>
                      {r.facilityName}
                      {r.municipality && <div className="muted">{r.municipality}</div>}
                    </td>
                    <td>{specialtyLabel(r.specialty)}</td>
                    <td>
                      {r.suppressed
                        ? t('fewer than {n}', { n: p.smallCellThreshold })
                        : cell(r.completed)}
                    </td>
                    <td>{days(r.medianDays)}</td>
                    <td>{days(r.p90Days)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
    </Card>
  );
}
