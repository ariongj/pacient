import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  addDays,
  downloadMyCalendar,
  KIND_SHORT,
  kindLabel,
  mondayOf,
  noon,
  specialtyLabel,
  useBulk,
  useCancelShift,
  useMyShifts,
  useOnCall,
  usePublish,
  useRosterMeta,
  useRosterStaff,
  useSaveShift,
  useStaffing,
  useWeek,
  warningsOf,
  warningText,
  type Gap,
  type RosterMeta,
  type Shift,
  type ShiftKind,
  type StaffMember,
  type WarningCode,
  type Week,
} from '../../api/rosters';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  Table,
  TabPanel,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { formatDayHeading, formatTime } from '../../format';
import { t } from '../../i18n';

type TabId = 'oncall' | 'week' | 'mine' | 'staffing';

const KIND_TONE: Record<ShiftKind, 'info' | 'success' | 'warning' | 'neutral'> = {
  DAY: 'success',
  LATE: 'info',
  NIGHT: 'neutral',
  ON_CALL: 'warning',
};

function ShiftChip({ shift }: { shift: Shift }) {
  const label = `${t(KIND_SHORT[shift.kind])} ${shift.startTime}–${shift.endTime}`;
  return (
    <span title={`${kindLabel(shift.kind)} ${specialtyLabel(shift.specialty)}`}>
      <Badge tone={shift.status === 'CANCELLED' ? 'neutral' : KIND_TONE[shift.kind]}>
        {shift.status === 'CANCELLED' ? <s>{label}</s> : label}
      </Badge>
      {shift.specialty && <span className="muted"> {specialtyLabel(shift.specialty)}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ on call ------------- */

function OnCallSection() {
  const query = useOnCall();
  return (
    <Card title={t('Who is on call now')}>
      <QueryView query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('No on-call rota at your facility')} />
          ) : (
            <Table caption={t('Who is on call now')}>
              <thead>
                <tr>
                  <th scope="col">{t('Specialty')}</th>
                  <th scope="col">{t('On call now')}</th>
                  <th scope="col">{t('Next')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.specialty}>
                    <th scope="row">{specialtyLabel(i.specialty)}</th>
                    <td>
                      {i.current.length ? (
                        i.current.map((c) => (
                          <div key={c.shiftId}>
                            <strong>{c.name}</strong>{' '}
                            <span className="muted">
                              {t('until {time}', { time: formatTime(c.endsAt) })}
                            </span>
                          </div>
                        ))
                      ) : (
                        <Badge tone="danger">{t('Nobody on call – call the switchboard')}</Badge>
                      )}
                    </td>
                    <td>
                      {i.next ? (
                        <>
                          {i.next.name}{' '}
                          <span className="muted">
                            {t('from {time}', {
                              time: `${formatDayHeading(new Date(i.next.startsAt))} ${formatTime(i.next.startsAt)}`,
                            })}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
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

/* ------------------------------------------------------------------ shift dialog -------- */

function WarningsBox({
  warnings,
  reason,
  setReason,
}: {
  warnings: ReturnType<typeof warningsOf>;
  reason: string;
  setReason: (v: string) => void;
}) {
  if (!warnings) return null;
  return (
    <Alert tone="warning" title={t('Working-time rules')}>
      <ul>
        {warnings.map((w, i) => (
          <li key={i}>
            {warningText(w)}
            {w.date ? ` – ${formatDayHeading(noon(w.date))}` : ''}
          </li>
        ))}
      </ul>
      <p className="muted">
        {t(
          'These limits follow the EU Working Time Directive and are illustrative until local agreements are confirmed. To continue, give a reason.',
        )}
      </p>
      <TextAreaField
        label={t('Reason for the exception')}
        name="overrideReason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        minLength={10}
        maxLength={300}
        rows={2}
        required
      />
    </Alert>
  );
}

function ShiftDialog({
  meta,
  staff,
  units,
  initial,
  onClose,
}: {
  meta: RosterMeta;
  staff: StaffMember[];
  units: Week['units'];
  initial: Partial<Shift> & { date: string };
  onClose: () => void;
}) {
  const save = useSaveShift();
  const cancel = useCancelShift();
  const [form, setForm] = useState({
    userId: initial.userId ?? '',
    unitId: initial.unitId ?? '',
    kind: (initial.kind ?? 'DAY') as ShiftKind,
    specialty: initial.specialty ?? '',
    date: initial.date,
    startTime: initial.startTime ?? meta.defaultTimes[initial.kind ?? 'DAY'].start,
    endTime: initial.endTime ?? meta.defaultTimes[initial.kind ?? 'DAY'].end,
    note: initial.note ?? '',
  });
  const [reason, setReason] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const warnings = warningsOf(save.error);
  const set = (k: keyof typeof form, v: string) =>
    setForm((f) =>
      k === 'kind'
        ? {
            ...f,
            kind: v as ShiftKind,
            startTime: meta.defaultTimes[v as ShiftKind].start,
            endTime: meta.defaultTimes[v as ShiftKind].end,
            specialty: v === 'ON_CALL' ? f.specialty : '',
          }
        : { ...f, [k]: v },
    );
  const people = staff.filter((s) => form.kind !== 'ON_CALL' || s.role === 'DOCTOR');

  function submit(e: FormEvent) {
    e.preventDefault();
    const body = {
      ...(initial.id ? {} : { userId: form.userId }),
      unitId: form.unitId || null,
      kind: form.kind,
      specialty: form.kind === 'ON_CALL' ? form.specialty : null,
      date: form.date,
      startTime: form.startTime,
      endTime: form.endTime,
      note: form.note || null,
      ...(warnings
        ? {
            acknowledgedWarnings: warnings.map((w) => w.code) as WarningCode[],
            overrideReason: reason,
          }
        : {}),
    };
    save.mutate({ id: initial.id, body }, { onSuccess: onClose });
  }

  return (
    <Dialog open onClose={onClose} title={initial.id ? t('Change shift') : t('Plan a shift')} wide>
      <form onSubmit={submit} className="stack">
        <div className="form-grid">
          {initial.id ? (
            <TextField
              label={t('Staff member')}
              name="person"
              value={initial.userName ?? ''}
              disabled
            />
          ) : (
            <SelectField
              label={t('Staff member')}
              name="userId"
              value={form.userId}
              onChange={(e) => set('userId', e.target.value)}
              placeholder={t('Choose…')}
              required
              options={people.map((p) => ({
                value: p.id,
                label: `${p.fullName} (${t(roleLabel(p.role))})`,
              }))}
            />
          )}
          <SelectField
            label={t('Shift')}
            name="kind"
            value={form.kind}
            onChange={(e) => set('kind', e.target.value)}
            options={meta.kinds.map((k) => ({ value: k, label: kindLabel(k) }))}
          />
          {form.kind === 'ON_CALL' && (
            <SelectField
              label={t('Specialty')}
              name="specialty"
              value={form.specialty}
              onChange={(e) => set('specialty', e.target.value)}
              placeholder={t('Choose…')}
              required
              options={meta.specialties.map((s) => ({ value: s, label: specialtyLabel(s) }))}
            />
          )}
          <SelectField
            label={t('Unit')}
            name="unitId"
            value={form.unitId}
            onChange={(e) => set('unitId', e.target.value)}
            placeholder={t('No unit')}
            options={units.map((u) => ({ value: u.id, label: u.name }))}
          />
          <TextField
            label={t('Date')}
            name="date"
            type="date"
            value={form.date}
            onChange={(e) => set('date', e.target.value)}
            required
          />
          <TextField
            label={t('From')}
            name="startTime"
            type="time"
            value={form.startTime}
            onChange={(e) => set('startTime', e.target.value)}
            required
          />
          <TextField
            label={t('Until')}
            name="endTime"
            type="time"
            value={form.endTime}
            onChange={(e) => set('endTime', e.target.value)}
            hint={t('An earlier time means the next day.')}
            required
          />
        </div>
        <TextField
          label={t('Note')}
          name="note"
          value={form.note}
          onChange={(e) => set('note', e.target.value)}
          maxLength={300}
        />
        <WarningsBox warnings={warnings} reason={reason} setReason={setReason} />
        {!warnings && <ErrorAlert error={save.error} />}
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Close')}
          </Button>
          <Button type="submit" loading={save.isPending}>
            {warnings ? t('Save anyway') : t('Save')}
          </Button>
        </div>
      </form>
      {initial.id && initial.status === 'PLANNED' && (
        <form
          className="stack"
          style={{ marginTop: '1rem' }}
          onSubmit={(e) => {
            e.preventDefault();
            cancel.mutate({ id: initial.id!, reason: cancelReason }, { onSuccess: onClose });
          }}
        >
          <TextField
            label={t('Reason for cancelling')}
            name="cancelReason"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            minLength={3}
            maxLength={300}
            required
          />
          <ErrorAlert error={cancel.error} />
          <div>
            <Button type="submit" variant="danger" loading={cancel.isPending}>
              {t('Cancel shift')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

const roleLabel = (role: string) =>
  ({
    DOCTOR: 'Doctor',
    NURSE: 'Nurse',
    PHARMACIST: 'Pharmacist',
    RECEPTION: 'Reception',
    DIRECTOR: 'Director',
  })[role] ?? role;

function PatternDialog({
  meta,
  staff,
  units,
  weekStart,
  onClose,
}: {
  meta: RosterMeta;
  staff: StaffMember[];
  units: Week['units'];
  weekStart: string;
  onClose: () => void;
}) {
  const bulk = useBulk();
  const [userId, setUserId] = useState('');
  const [unitId, setUnitId] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [pattern, setPattern] = useState<(ShiftKind | '')[]>([
    'DAY',
    'DAY',
    'LATE',
    'LATE',
    'NIGHT',
    'NIGHT',
    '',
  ]);
  const [reason, setReason] = useState('');
  const warnings = warningsOf(bulk.error);
  return (
    <Dialog open onClose={onClose} title={t('Week from a pattern')} wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          bulk.mutate(
            {
              mode: 'PATTERN',
              userId,
              unitId: unitId || null,
              weekStart,
              pattern: pattern.map((p) => p || null),
              specialty: pattern.includes('ON_CALL') ? specialty : null,
              ...(warnings
                ? {
                    acknowledgedWarnings: warnings.map((w) => w.code) as WarningCode[],
                    overrideReason: reason,
                  }
                : {}),
            },
            { onSuccess: onClose },
          );
        }}
      >
        <div className="form-grid">
          <SelectField
            label={t('Staff member')}
            name="userId"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder={t('Choose…')}
            required
            options={staff.map((p) => ({
              value: p.id,
              label: `${p.fullName} (${t(roleLabel(p.role))})`,
            }))}
          />
          <SelectField
            label={t('Unit')}
            name="unitId"
            value={unitId}
            onChange={(e) => setUnitId(e.target.value)}
            placeholder={t('No unit')}
            options={units.map((u) => ({ value: u.id, label: u.name }))}
          />
          {pattern.includes('ON_CALL') && (
            <SelectField
              label={t('Specialty')}
              name="specialty"
              value={specialty}
              onChange={(e) => setSpecialty(e.target.value)}
              placeholder={t('Choose…')}
              required
              options={meta.specialties.map((s) => ({ value: s, label: specialtyLabel(s) }))}
            />
          )}
        </div>
        <div className="form-grid">
          {pattern.map((p, i) => (
            <SelectField
              key={i}
              label={formatDayHeading(noon(addDays(weekStart, i)))}
              name={`day${i}`}
              value={p}
              onChange={(e) =>
                setPattern((old) =>
                  old.map((x, j) => (j === i ? (e.target.value as ShiftKind | '') : x)),
                )
              }
              placeholder={t('Day off')}
              options={meta.kinds.map((k) => ({ value: k, label: kindLabel(k) }))}
            />
          ))}
        </div>
        <WarningsBox warnings={warnings} reason={reason} setReason={setReason} />
        {!warnings && <ErrorAlert error={bulk.error} />}
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Close')}
          </Button>
          <Button type="submit" loading={bulk.isPending}>
            {warnings ? t('Create anyway') : t('Create shifts')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ week ---------------- */

function WeekSection({
  meta,
  start,
  setStart,
}: {
  meta: RosterMeta;
  start: string;
  setStart: (s: string) => void;
}) {
  const [unitId, setUnitId] = useState('');
  const week = useWeek(start, unitId);
  const staffQuery = useRosterStaff(meta.canManage);
  const publish = usePublish();
  const copy = useBulk();
  const [editing, setEditing] = useState<(Partial<Shift> & { date: string }) | null>(null);
  const [patternOpen, setPatternOpen] = useState(false);
  const [copyReason, setCopyReason] = useState('');
  const copyWarnings = warningsOf(copy.error);

  return (
    <Card
      title={t('Week of {date}', { date: formatDayHeading(noon(start)) })}
      actions={
        <div className="no-print" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Button size="sm" variant="secondary" onClick={() => setStart(addDays(start, -7))}>
            {t('Previous week')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setStart(mondayOf(meta.today))}>
            {t('This week')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setStart(addDays(start, 7))}>
            {t('Next week')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => window.print()}>
            {t('Print')}
          </Button>
        </div>
      }
    >
      <QueryView query={week}>
        {(w) => {
          const people = [...new Map(w.shifts.map((s) => [s.userId, s])).values()].sort((a, b) =>
            a.userName.localeCompare(b.userName),
          );
          const published = w.publications.filter(
            (p) => !unitId || !p.unitId || p.unitId === unitId,
          );
          return (
            <div className="stack">
              <div className="no-print form-grid">
                <SelectField
                  label={t('Unit')}
                  name="unitFilter"
                  value={unitId}
                  onChange={(e) => setUnitId(e.target.value)}
                  placeholder={t('All units')}
                  options={w.units.map((u) => ({ value: u.id, label: u.name }))}
                />
              </div>
              <p className="muted">
                {published.length
                  ? t('Published to staff.')
                  : t('Not published yet – staff are told when you publish the week.')}
              </p>
              {meta.canManage && staffQuery.data && (
                <div
                  className="no-print"
                  style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
                >
                  <Button size="sm" onClick={() => setEditing({ date: start })}>
                    {t('Plan a shift')}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setPatternOpen(true)}>
                    {t('Week from a pattern')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={copy.isPending}
                    onClick={() =>
                      copy.mutate({
                        mode: 'COPY',
                        fromWeekStart: addDays(start, -7),
                        weekStart: start,
                        unitId: unitId || null,
                        ...(copyWarnings
                          ? {
                              acknowledgedWarnings: copyWarnings.map(
                                (x) => x.code,
                              ) as WarningCode[],
                              overrideReason: copyReason,
                            }
                          : {}),
                      })
                    }
                  >
                    {copyWarnings ? t('Copy anyway') : t('Copy last week')}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={publish.isPending}
                    onClick={() => publish.mutate({ weekStart: start, unitId: unitId || null })}
                  >
                    {t('Publish week')}
                  </Button>
                </div>
              )}
              {copyWarnings && (
                <WarningsBox
                  warnings={copyWarnings}
                  reason={copyReason}
                  setReason={setCopyReason}
                />
              )}
              {!copyWarnings && <ErrorAlert error={copy.error} />}
              {copy.isSuccess && (
                <Alert
                  tone="success"
                  title={t('{count} shifts copied', { count: copy.data.created })}
                />
              )}
              {publish.isSuccess && (
                <Alert
                  tone="success"
                  title={t('Published: {people} people notified about {shifts} shifts', {
                    people: publish.data.notified,
                    shifts: publish.data.shifts,
                  })}
                />
              )}
              <ErrorAlert error={publish.error} />
              {people.length === 0 ? (
                <EmptyState title={t('No shifts this week')} />
              ) : (
                <Table caption={t('Roster')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Staff member')}</th>
                      {w.days.map((d) => (
                        <th scope="col" key={d}>
                          {formatDayHeading(noon(d))}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={p.userId}>
                        <th scope="row">
                          {p.userName}
                          <div className="muted">{t(roleLabel(p.userRole))}</div>
                        </th>
                        {w.days.map((d) => (
                          <td key={d}>
                            {w.shifts
                              .filter((s) => s.userId === p.userId && s.date === d)
                              .map((s) =>
                                meta.canManage && s.status === 'PLANNED' ? (
                                  <Button
                                    key={s.id}
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => setEditing(s)}
                                  >
                                    <ShiftChip shift={s} />
                                    <span className="sr-only">
                                      {' '}
                                      {t('Change shift')}: {p.userName}
                                    </span>
                                  </Button>
                                ) : (
                                  <div key={s.id}>
                                    <ShiftChip shift={s} />
                                  </div>
                                ),
                              )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {editing && staffQuery.data && (
                <ShiftDialog
                  meta={meta}
                  staff={staffQuery.data.staff}
                  units={staffQuery.data.units}
                  initial={editing}
                  onClose={() => setEditing(null)}
                />
              )}
              {patternOpen && staffQuery.data && (
                <PatternDialog
                  meta={meta}
                  staff={staffQuery.data.staff}
                  units={staffQuery.data.units}
                  weekStart={start}
                  onClose={() => setPatternOpen(false)}
                />
              )}
            </div>
          );
        }}
      </QueryView>
    </Card>
  );
}

/* ------------------------------------------------------------------ my shifts ----------- */

function MineSection() {
  const query = useMyShifts();
  const [error, setError] = useState<unknown>(null);
  return (
    <Card
      title={t('My shifts')}
      actions={
        <Button size="sm" variant="secondary" onClick={() => downloadMyCalendar().catch(setError)}>
          {t('Add to my calendar (.ics)')}
        </Button>
      }
    >
      <ErrorAlert error={error} />
      <QueryView query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState title={t('You have no shifts in this period')} />
          ) : (
            <Table caption={t('My shifts')}>
              <thead>
                <tr>
                  <th scope="col">{t('Date')}</th>
                  <th scope="col">{t('Shift')}</th>
                  <th scope="col">{t('Time')}</th>
                  <th scope="col">{t('Unit')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((s) => (
                  <tr key={s.id}>
                    <td>{formatDayHeading(noon(s.date))}</td>
                    <td>
                      {s.status === 'CANCELLED' ? (
                        <Badge tone="neutral">{t('Cancelled')}</Badge>
                      ) : (
                        kindLabel(s.kind)
                      )}{' '}
                      {specialtyLabel(s.specialty)}
                    </td>
                    <td>
                      {s.startTime}–{s.endTime}
                    </td>
                    <td>{s.unitName ?? '—'}</td>
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

/* ------------------------------------------------------------------ staffing ------------ */

function gapText(g: Gap): string {
  switch (g.type) {
    case 'NO_NIGHT_NURSE':
      return t('{unit}: no night nurse on {date}', {
        unit: g.unitName,
        date: formatDayHeading(noon(g.date)),
      });
    case 'NO_ON_CALL':
      return t('{specialty}: nobody on call on the night of {date}', {
        specialty: specialtyLabel(g.specialty),
        date: formatDayHeading(noon(g.date)),
      });
    case 'WARD_NOT_ROSTERED':
      return t('{unit}: nurses are not rostered in Pacient', { unit: g.unitName });
  }
}

function StaffingSection({ meta }: { meta: RosterMeta }) {
  const [date, setDate] = useState(meta.today);
  const [general, setGeneral] = useState(meta.defaultRatio.general);
  const [intensive, setIntensive] = useState(meta.defaultRatio.intensive);
  const query = useStaffing(date, general, intensive, meta.canManage);
  return (
    <div className="stack">
      <Card title={t('Nurse staffing')}>
        <div className="form-grid no-print">
          <TextField
            label={t('Date')}
            name="staffingDate"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <TextField
            label={t('Patients per nurse – wards')}
            name="ratioGeneral"
            type="number"
            min={1}
            max={30}
            value={String(general)}
            onChange={(e) => setGeneral(Number(e.target.value) || meta.defaultRatio.general)}
          />
          <TextField
            label={t('Patients per nurse – intensive care')}
            name="ratioIntensive"
            type="number"
            min={1}
            max={10}
            value={String(intensive)}
            onChange={(e) => setIntensive(Number(e.target.value) || meta.defaultRatio.intensive)}
          />
        </div>
        <p className="muted">
          {t(
            'Occupied beds now against nurses rostered on each shift of the day. The limits are illustrative; set your own.',
          )}
        </p>
        <QueryView query={query}>
          {(s) => (
            <Table caption={t('Nurse staffing')}>
              <thead>
                <tr>
                  <th scope="col">{t('Ward')}</th>
                  <th scope="col">{t('Occupied beds')}</th>
                  {(['DAY', 'LATE', 'NIGHT'] as const).map((k) => (
                    <th scope="col" key={k}>
                      {kindLabel(k)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {s.wards.map((w) => (
                  <tr key={w.unitId}>
                    <th scope="row">{w.unitName}</th>
                    <td>
                      {w.occupied} / {w.beds}
                    </td>
                    {(['DAY', 'LATE', 'NIGHT'] as const).map((k) => {
                      const c = w.shifts[k];
                      return (
                        <td key={k}>
                          {t('{count} nurses', { count: c.nurses })}
                          {c.ratio !== null && (
                            <div className="muted">
                              {t('{ratio} patients per nurse', { ratio: c.ratio })}
                            </div>
                          )}
                          {c.over && (
                            <div>
                              <Badge tone="danger">
                                {c.nurses === 0
                                  ? t('No nurse rostered')
                                  : t('Above {limit} per nurse', { limit: w.threshold })}
                              </Badge>
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </QueryView>
      </Card>
      <Card title={t('Gaps in the next 7 days')}>
        <QueryView query={query}>
          {(s) =>
            s.gaps.length === 0 ? (
              <EmptyState title={t('No gaps')} />
            ) : (
              <ul>
                {s.gaps.map((g, i) => (
                  <li key={i}>{gapText(g)}</li>
                ))}
              </ul>
            )
          }
        </QueryView>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ page ---------------- */

export function RostersPage() {
  const meta = useRosterMeta();
  const [params, setParams] = useSearchParams();
  const requested = params.get('week');
  const [tab, setTab] = useState<TabId>(requested ? 'week' : 'oncall');
  const [start, setStartState] = useState<string | null>(
    requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? mondayOf(requested) : null,
  );
  const setStart = (s: string) => {
    setStartState(s);
    setParams({ week: s }, { replace: true });
  };
  return (
    <>
      <PageHeader
        title={t('Rosters and on-call')}
        subtitle={t('Shifts, the on-call rota and who to call now.')}
      />
      <QueryView query={meta}>
        {(m) => (
          <>
            <Tabs
              label={t('Rosters and on-call')}
              active={tab}
              onChange={setTab}
              tabs={[
                { id: 'oncall', label: t('On call now') },
                { id: 'week', label: t('Roster') },
                { id: 'mine', label: t('My shifts') },
                ...(m.canManage ? [{ id: 'staffing' as const, label: t('Staffing') }] : []),
              ]}
            />
            <TabPanel id={tab}>
              {tab === 'oncall' && <OnCallSection />}
              {tab === 'week' && (
                <WeekSection meta={m} start={start ?? mondayOf(m.today)} setStart={setStart} />
              )}
              {tab === 'mine' && <MineSection />}
              {tab === 'staffing' && m.canManage && <StaffingSection meta={m} />}
            </TabPanel>
          </>
        )}
      </QueryView>
    </>
  );
}
