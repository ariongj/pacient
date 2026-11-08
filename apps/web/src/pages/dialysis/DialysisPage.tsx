import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  accessLabel,
  complicationLabel,
  DAYS,
  dayLabel,
  SHIFTS,
  shiftLabel,
  useDialysisBoard,
  useDialysisPatients,
  useDialysisStats,
  useDialysisUnits,
  type BoardSession,
  type DialysisStats,
  type DialysisUnit,
} from '../../api/dialysis';
import { useUser } from '../../auth/AuthContext';
import { StackedBars } from '../../components/charts';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Grid,
  PageHeader,
  QueryView,
  SelectField,
  Stat,
  Table,
  TabPanel,
  Tabs,
  TextField,
} from '../../components/ui';
import { formatDate, formatMonth, formatNumber, formatTime, fullName } from '../../format';
import { t } from '../../i18n';
import {
  AdequacyText,
  bp,
  kg,
  scheduleText,
  SessionDialog,
  SessionStatusBadge,
  WarningList,
  type SessionDialogKind,
} from './DialysisComponents';

/**
 * Haemodialysis. Unit staff see the day's sessions per shift (stations, weights, blood pressure,
 * warnings) and the unit's patients; directors and the Ministry see aggregates without names.
 */
export function DialysisPage() {
  const user = useUser();
  if (user.role === 'DIRECTOR' || user.role === 'MINISTRY') {
    return (
      <>
        <PageHeader
          title={t('Dialysis')}
          subtitle={
            user.role === 'MINISTRY'
              ? t('Haemodialysis across Kosovo: aggregates only, counts of 1–4 hidden.')
              : t('Haemodialysis units of your facility: activity without patient names.')
          }
        />
        {user.role === 'DIRECTOR' && <UnitLoad />}
        <StatsView />
      </>
    );
  }
  return <UnitBoard />;
}

const kosovoToday = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Belgrade',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const chartLink = (role: string, patientId: string) =>
  `${role === 'NURSE' ? '/nurse' : '/doctor'}/patients/${patientId}?tab=dialysis`;

/* --------------------------------------------------------------------- unit board ---- */

function UnitBoard() {
  const units = useDialysisUnits();
  const [unitId, setUnitId] = useState<string | undefined>();
  return (
    <>
      <PageHeader
        title={t('Dialysis')}
        subtitle={t('Sessions of the day by shift, and the unit’s patients.')}
      />
      <QueryView query={units}>
        {(data) => {
          const mine = data.items.filter((u) => u.isStaff);
          const current = mine.find((u) => u.id === unitId) ?? mine[0];
          if (!current) {
            return (
              <Card>
                <EmptyState title={t('You are not on the staff of a dialysis unit')}>
                  {t(
                    'Doctors start dialysis from the patient’s chart (Dialysis tab). Directors add staff to the unit under Wards & units.',
                  )}
                </EmptyState>
              </Card>
            );
          }
          return (
            <>
              {mine.length > 1 && (
                <div className="search-bar">
                  <SelectField
                    label={t('Dialysis unit')}
                    value={current.id}
                    onChange={(e) => setUnitId(e.target.value)}
                    options={mine.map((u) => ({ value: u.id, label: u.name }))}
                  />
                </div>
              )}
              <UnitView unit={current} />
            </>
          );
        }}
      </QueryView>
    </>
  );
}

function UnitView({ unit }: { unit: DialysisUnit }) {
  const [tab, setTab] = useState<'day' | 'patients' | 'load'>('day');
  return (
    <>
      <Tabs
        label={t('Dialysis')}
        active={tab}
        onChange={setTab}
        tabs={[
          { id: 'day', label: t('Day board') },
          { id: 'patients', label: t('Patients'), count: unit.activePatients },
          { id: 'load', label: t('Shift occupancy') },
        ]}
      />
      <TabPanel id={tab}>
        {tab === 'day' && <DayBoard unit={unit} />}
        {tab === 'patients' && <PatientList unit={unit} />}
        {tab === 'load' && <LoadTable unit={unit} />}
      </TabPanel>
    </>
  );
}

function DayBoard({ unit }: { unit: DialysisUnit }) {
  const user = useUser();
  const [date, setDate] = useState(kosovoToday());
  const board = useDialysisBoard(unit.id, date);
  const [dialog, setDialog] = useState<{ kind: SessionDialogKind; session: BoardSession } | null>(
    null,
  );
  const isToday = date === kosovoToday();
  const isPast = date < kosovoToday();
  return (
    <>
      <div className="search-bar">
        <TextField
          label={t('Day')}
          type="date"
          value={date}
          onChange={(e) => e.target.value && setDate(e.target.value)}
        />
        <Button variant="secondary" onClick={() => setDate(kosovoToday())}>
          {t('Today')}
        </Button>
      </div>
      <QueryView query={board}>
        {(b) => {
          const all = b.shifts.flatMap((s) => s.items);
          const flagged = all.filter((s) => s.warnings.length > 0);
          return (
            <>
              <Grid min={170}>
                <Stat label={t('Stations')} value={formatNumber(unit.stations)} />
                <Stat label={t('Sessions')} value={formatNumber(all.length)} />
                <Stat
                  label={t('On dialysis now')}
                  value={formatNumber(all.filter((s) => s.status === 'IN_PROGRESS').length)}
                  tone="info"
                />
                <Stat
                  label={t('Completed|dialysis')}
                  value={formatNumber(all.filter((s) => s.status === 'COMPLETED').length)}
                  tone="success"
                />
                <Stat
                  label={t('Missed|dialysis')}
                  value={formatNumber(all.filter((s) => s.status === 'MISSED').length)}
                  tone={all.some((s) => s.status === 'MISSED') ? 'danger' : undefined}
                />
              </Grid>
              {flagged.length > 0 && (
                <Alert tone="warning" title={t('Sessions with warnings')}>
                  <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
                    {flagged.map((s) => (
                      <li key={s.id}>
                        {fullName(s.patient)} ({shiftLabel(s.shift ?? 'MORNING')}):{' '}
                        <WarningList warnings={s.warnings} />
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}
              {b.shifts
                .filter((s) => s.items.length > 0 || s.shift !== 'EVENING')
                .map((shift) => (
                  <Card
                    key={shift.shift}
                    title={`${shiftLabel(shift.shift)} · ${t('{used} of {stations} stations', {
                      used: shift.items.filter((s) => s.status !== 'CANCELLED').length,
                      stations: shift.stations,
                    })}`}
                  >
                    {shift.items.length === 0 ? (
                      <EmptyState title={t('No sessions in this shift')} />
                    ) : (
                      <Table caption={shiftLabel(shift.shift)}>
                        <thead>
                          <tr>
                            <th>{t('Patient')}</th>
                            <th>{t('Station')}</th>
                            <th>{t('Status')}</th>
                            <th>{t('Weight before / after')}</th>
                            <th>{t('Blood pressure before / after')}</th>
                            <th>{t('Warnings')}</th>
                            <th>
                              <span className="sr-only">{t('Actions')}</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {shift.items.map((s) => (
                            <tr key={s.id}>
                              <td>
                                <Link to={chartLink(user.role, s.patient.id)}>
                                  {fullName(s.patient)}
                                </Link>
                                <div className="muted">
                                  {s.vascularAccess ? accessLabel(s.vascularAccess) : ''}
                                  {s.targetWeightKg !== null &&
                                    ` · ${t('target {kg}', { kg: kg(s.targetWeightKg) })}`}
                                </div>
                              </td>
                              <td>{s.machine ?? '—'}</td>
                              <td>
                                <SessionStatusBadge status={s.status} />
                                {s.startedAt && (
                                  <div className="muted">
                                    {formatTime(s.startedAt)}
                                    {s.endedAt && `–${formatTime(s.endedAt)}`}
                                  </div>
                                )}
                                {s.missedReason && <div className="muted">{s.missedReason}</div>}
                              </td>
                              <td>
                                {kg(s.preWeightKg)} / {kg(s.postWeightKg)}
                                {s.interdialyticGainKg !== null && (
                                  <div className="muted">
                                    {t('gain {kg} kg', {
                                      kg: formatNumber(s.interdialyticGainKg),
                                    })}
                                  </div>
                                )}
                              </td>
                              <td>
                                {bp(s.preSystolic, s.preDiastolic)} /{' '}
                                {bp(s.postSystolic, s.postDiastolic)}
                              </td>
                              <td>
                                <WarningList warnings={s.warnings} />
                                {s.complications.length > 0 && (
                                  <div className="muted">
                                    {s.complications.map(complicationLabel).join(', ')}
                                  </div>
                                )}
                              </td>
                              <td>
                                <SessionButtons
                                  session={s}
                                  canAct={isToday || isPast}
                                  onAction={(kind) => setDialog({ kind, session: s })}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </Table>
                    )}
                  </Card>
                ))}
            </>
          );
        }}
      </QueryView>
      <SessionDialog
        session={dialog?.session ?? null}
        kind={dialog?.kind ?? null}
        patientName={dialog ? fullName(dialog.session.patient) : undefined}
        onClose={() => setDialog(null)}
      />
    </>
  );
}

function SessionButtons({
  session,
  canAct,
  onAction,
}: {
  session: BoardSession;
  canAct: boolean;
  onAction: (kind: SessionDialogKind) => void;
}) {
  if (!canAct) return null;
  return (
    <span style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
      {session.status === 'PLANNED' && (
        <>
          <Button size="sm" onClick={() => onAction('start')}>
            {t('Start|dialysis session')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => onAction('missed')}>
            {t('Missed|action')}
          </Button>
        </>
      )}
      {session.status === 'IN_PROGRESS' && (
        <Button size="sm" onClick={() => onAction('end')}>
          {t('End|dialysis session')}
        </Button>
      )}
      {session.status === 'COMPLETED' && session.preUrea === null && (
        <Button size="sm" variant="secondary" onClick={() => onAction('urea')}>
          {t('Add urea')}
        </Button>
      )}
    </span>
  );
}

function PatientList({ unit }: { unit: DialysisUnit }) {
  const user = useUser();
  const list = useDialysisPatients(unit.id);
  return (
    <QueryView query={list}>
      {(data) => (
        <Card title={t('Patients on dialysis')}>
          {data.items.length === 0 ? (
            <EmptyState title={t('No patients on dialysis in this unit')} />
          ) : (
            <Table caption={t('Patients on dialysis')}>
              <thead>
                <tr>
                  <th>{t('Patient')}</th>
                  <th>{t('Schedule')}</th>
                  <th>{t('Vascular access')}</th>
                  <th>{t('Target weight')}</th>
                  <th>{t('Last 30 days')}</th>
                  <th>{t('Last adequacy')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.patient.id}>
                    <td>
                      <Link to={chartLink(user.role, p.patient.id)}>{fullName(p.patient)}</Link>
                      <div className="muted">{p.patient.nationalId}</div>
                    </td>
                    <td>{scheduleText(p.schedule)}</td>
                    <td>{accessLabel(p.schedule.vascularAccess)}</td>
                    <td>{kg(p.schedule.targetWeightKg)}</td>
                    <td>
                      {t('{completed} done, {missed} missed', {
                        completed: p.completed30,
                        missed: p.missed30,
                      })}
                      {p.lastSessionDate && (
                        <div className="muted">
                          {t('last {date}', { date: formatDate(p.lastSessionDate) })}
                        </div>
                      )}
                    </td>
                    <td>
                      <AdequacyText a={p.lastAdequacy} targets={data.targets} />
                      {p.lastAdequacy && (
                        <div className="muted">{formatDate(p.lastAdequacy.sessionDate)}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </QueryView>
  );
}

function LoadTable({ unit }: { unit: DialysisUnit }) {
  return (
    <Card title={t('Places taken per shift and weekday')}>
      <p className="muted">
        {t('Each station takes one patient per shift. A full shift refuses new schedules.')}
      </p>
      <Table caption={t('Places taken per shift and weekday')}>
        <thead>
          <tr>
            <th>{t('Shift')}</th>
            {DAYS.map((d) => (
              <th key={d}>{dayLabel(d)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SHIFTS.map((s) => (
            <tr key={s}>
              <th scope="row">{shiftLabel(s)}</th>
              {DAYS.map((d) => {
                const n = unit.load[s]?.[d] ?? 0;
                return (
                  <td key={d}>
                    {n}/{unit.stations}
                    {n >= unit.stations && <span className="muted"> · {t('full|shift')}</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

/* ---------------------------------------------------------------------- oversight ---- */

function UnitLoad() {
  const units = useDialysisUnits();
  return (
    <QueryView query={units}>
      {(data) =>
        data.items.length === 0 ? null : (
          <>
            {data.items.map((u) => (
              <LoadTable key={u.id} unit={u} />
            ))}
          </>
        )
      }
    </QueryView>
  );
}

const pct = (v: number | null) => (v === null ? t('hidden') : `${formatNumber(v)}%`);
const count = (v: number | null) => (v === null ? t('hidden') : formatNumber(v));

function StatsView() {
  const stats = useDialysisStats();
  return (
    <QueryView query={stats}>
      {(s) =>
        s.items.length === 0 ? (
          <Card>
            <EmptyState title={t('No dialysis units')}>
              {t('Create a unit of the type “Dialysis” under Wards & units.')}
            </EmptyState>
          </Card>
        ) : (
          <StatsBody s={s} />
        )
      }
    </QueryView>
  );
}

function StatsBody({ s }: { s: DialysisStats }) {
  const total = s.items.reduce((x, i) => x + (i.patientsOnDialysis ?? 0), 0);
  const months = [...new Set(s.items.flatMap((i) => i.sessionsByMonth.map((m) => m.month)))].sort();
  return (
    <>
      <Grid min={200}>
        <Stat label={t('Patients on dialysis')} value={formatNumber(total)} />
        <Stat
          label={t('Adequacy target')}
          value={`Kt/V ≥ ${formatNumber(s.targets.ktv)}`}
          hint={t('or URR ≥ {urr}% when Kt/V cannot be computed', { urr: s.targets.urr })}
        />
      </Grid>
      {months.length > 0 && (
        <Card title={t('Sessions per month')}>
          <StackedBars
            title={t('Sessions per month')}
            series={[
              { key: 'completed', label: t('Completed|dialysis'), color: 'var(--success)' },
              { key: 'missed', label: t('Missed|dialysis'), color: 'var(--danger)' },
            ]}
            rows={months.map((m) => ({
              label: formatMonth(m),
              values: {
                completed: s.items.reduce(
                  (x, i) => x + (i.sessionsByMonth.find((r) => r.month === m)?.completed ?? 0),
                  0,
                ),
                missed: s.items.reduce(
                  (x, i) => x + (i.sessionsByMonth.find((r) => r.month === m)?.missed ?? 0),
                  0,
                ),
              },
            }))}
          />
        </Card>
      )}
      <Card title={t('By facility – last 90 days')}>
        <Table caption={t('By facility – last 90 days')}>
          <thead>
            <tr>
              <th>{t('Facility')}</th>
              <th>{t('Patients on dialysis')}</th>
              <th>{t('Sessions completed')}</th>
              <th>{t('Sessions with urea measured')}</th>
              <th>{t('Measured sessions reaching the target')}</th>
              <th>{t('Sessions missed')}</th>
            </tr>
          </thead>
          <tbody>
            {s.items.map((i) => (
              <tr key={i.facilityId}>
                <th scope="row">{i.facilityName}</th>
                <td>{count(i.patientsOnDialysis)}</td>
                <td>{count(i.completed90)}</td>
                <td>{pct(i.measuredPercent)}</td>
                <td>{pct(i.meetingTargetPercent)}</td>
                <td>{pct(i.missedPercent)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        {s.smallCellThreshold !== null && (
          <p className="muted">
            {t('Counts below {n} are hidden, and percentages based on fewer than {n} sessions.', {
              n: s.smallCellThreshold,
            })}
          </p>
        )}
      </Card>
    </>
  );
}
