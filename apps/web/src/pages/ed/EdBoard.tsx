import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import {
  ARRIVAL_MODES,
  arrivalModeLabel,
  edPatientInitials,
  edPatientName,
  edStatusLabel,
  formatMinutes,
  TRIAGE,
  TRIAGE_GUIDANCE,
  TRIAGE_LEVELS,
  useEdBoard,
  useEdMutation,
  type ArrivalMode,
  type EdBoard as Board,
  type EdBoardItem,
  type EdPatient,
  type TriageLevel,
} from '../../api/ed';
import { useUser } from '../../auth/AuthContext';
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
  TextAreaField,
  TextField,
} from '../../components/ui';
import { age, formatTime, humanize } from '../../format';
import { t, tn } from '../../i18n';
import './ed.css';

/** Ticks every 30 s so waiting times stay current between refreshes. */
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const minutesSince = (iso: string, now: number) =>
  Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));

function LevelLabel({ level }: { level: TriageLevel | null }) {
  if (!level) {
    return (
      <span className="ed-level">
        <span className="ed-dot" aria-hidden="true" />
        {t('Awaiting triage')}
      </span>
    );
  }
  return (
    <span className={`ed-level ed-level-${level}`}>
      <span className="ed-dot" aria-hidden="true" />
      {t('{level} · {name}', { level, name: TRIAGE[level].name() })}
    </span>
  );
}

function patientLine(p: EdPatient) {
  const years = age(p.dateOfBirth);
  return t('{age} y · {sex}', { age: years, sex: humanize(p.sex) });
}

/* ------------------------------------------------------------------ page ----------------------- */

export function EdBoard() {
  const user = useUser();
  const board = useEdBoard();
  const now = useNow();
  const [big, setBig] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [triaging, setTriaging] = useState<EdBoardItem | null>(null);
  const [starting, setStarting] = useState<EdBoardItem | null>(null);
  const [admitting, setAdmitting] = useState<EdBoardItem | null>(null);
  const [departing, setDeparting] = useState<EdBoardItem | null>(null);

  return (
    <div className={`ed ${big ? 'ed-big' : ''}`}>
      <PageHeader
        title={t('Emergency department')}
        subtitle={
          board.data
            ? t('{unit} · updated {time}', {
                unit: board.data.unit.name,
                time: formatTime(board.data.generatedAt),
              })
            : undefined
        }
        actions={
          <>
            <Button variant="secondary" onClick={() => setBig((b) => !b)} aria-pressed={big}>
              {big ? t('Normal view') : t('Big screen')}
            </Button>
            {!big && <Button onClick={() => setRegistering(true)}>{t('Register arrival')}</Button>}
          </>
        }
      />
      <QueryView query={board}>
        {(b) => (
          <>
            {big && (
              <Alert tone="info">
                {t('Big-screen mode shows initials only, for screens other people can see.')}
              </Alert>
            )}
            <Counts board={b} />
            <Section
              title={t('Awaiting triage')}
              items={b.items.filter((i) => !i.triageLevel)}
              {...{ b, now, big, user }}
              actions={{ setTriaging, setStarting, setAdmitting, setDeparting }}
            />
            <Section
              title={t('Waiting to be seen')}
              items={b.items.filter((i) => i.triageLevel && i.status === 'WAITING')}
              {...{ b, now, big, user }}
              actions={{ setTriaging, setStarting, setAdmitting, setDeparting }}
            />
            <Section
              title={t('In treatment')}
              items={b.items.filter((i) => i.status === 'IN_TREATMENT')}
              {...{ b, now, big, user }}
              actions={{ setTriaging, setStarting, setAdmitting, setDeparting }}
            />
            {!big && <Departed board={b} />}
            <TriageDialog item={triaging} onClose={() => setTriaging(null)} />
            <StartDialog item={starting} board={b} onClose={() => setStarting(null)} />
            <AdmitDialog item={admitting} onClose={() => setAdmitting(null)} />
            <DepartDialog item={departing} onClose={() => setDeparting(null)} />
          </>
        )}
      </QueryView>
      <RegisterArrivalDialog open={registering} onClose={() => setRegistering(false)} />
    </div>
  );
}

function Counts({ board }: { board: Board }) {
  const c = board.counts;
  return (
    <ul className="ed-counts" aria-label={t('Patients by triage level')}>
      <li className="ed-count">
        <span className="ed-dot" aria-hidden="true" />
        {t('Awaiting triage')} <strong>{c.awaitingTriage}</strong>
      </li>
      {TRIAGE_LEVELS.map((l) => (
        <li key={l} className={`ed-count ed-level-${l}`}>
          <span className="ed-dot" aria-hidden="true" />
          {t('{level} · {name}', { level: l, name: TRIAGE[l].name() })} <strong>{c[l]}</strong>
        </li>
      ))}
      <li className="ed-count">
        {t('Waiting')} <strong>{c.waiting}</strong>
      </li>
      <li className="ed-count">
        {t('In treatment')} <strong>{c.inTreatment}</strong>
      </li>
    </ul>
  );
}

interface Actions {
  setTriaging: (i: EdBoardItem) => void;
  setStarting: (i: EdBoardItem) => void;
  setAdmitting: (i: EdBoardItem) => void;
  setDeparting: (i: EdBoardItem) => void;
}

function Section({
  title,
  items,
  b,
  now,
  big,
  user,
  actions,
}: {
  title: string;
  items: EdBoardItem[];
  b: Board;
  now: number;
  big: boolean;
  user: ReturnType<typeof useUser>;
  actions: Actions;
}) {
  return (
    <section className="ed-section" aria-label={title}>
      <h2>
        {title} <Badge tone="neutral">{items.length}</Badge>
      </h2>
      {items.length === 0 ? (
        <p className="muted">{t('Nobody here.')}</p>
      ) : (
        <div className="ed-cards">
          {items.map((i) => (
            <VisitCard
              key={i.id}
              item={i}
              b={b}
              now={now}
              big={big}
              user={user}
              actions={actions}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function VisitCard({
  item: i,
  b,
  now,
  big,
  user,
  actions,
}: {
  item: EdBoardItem;
  b: Board;
  now: number;
  big: boolean;
  user: ReturnType<typeof useUser>;
  actions: Actions;
}) {
  // Waiting times tick locally between refreshes.
  const waited = i.seenAt
    ? i.minutesWaiting
    : Math.max(i.minutesWaiting, minutesSince(i.arrivedAt, now));
  const breached = i.status === 'WAITING' && waited > i.targetMinutes;
  const chartBase =
    user.role === 'DOCTOR' ? '/doctor/patients' : user.role === 'NURSE' ? '/nurse/patients' : null;
  const v = i.vitals;
  return (
    <article
      className={`ed-card ${i.triageLevel ? `ed-level-${i.triageLevel}` : ''} ${breached ? 'ed-breached' : ''}`}
    >
      <div className="ed-card-head">
        <div>
          <div className="ed-patient">
            {big ? edPatientInitials(i.patient) : edPatientName(i.patient)}
          </div>
          {!big && <div className="muted">{patientLine(i.patient)}</div>}
        </div>
        <LevelLabel level={i.triageLevel} />
      </div>
      {!big && <p className="ed-complaint">{i.chiefComplaint}</p>}
      <div className="ed-meta">
        <span>
          {i.status === 'WAITING' ? t('Waiting') : t('Waited')}{' '}
          <span className="ed-wait">{formatMinutes(waited)}</span>
        </span>
        <span>
          {i.triageLevel
            ? t('target {time}', { time: formatMinutes(i.targetMinutes) })
            : t('triage within {time}', { time: formatMinutes(i.targetMinutes) })}
        </span>
        {breached && <Badge tone="danger">{t('Over target')}</Badge>}
        <span>
          {t('Arrived {time}', { time: formatTime(i.arrivedAt) })} ·{' '}
          {arrivalModeLabel(i.arrivalMode)}
        </span>
        {i.assignedDoctor && <span>{t('With {name}', { name: i.assignedDoctor.fullName })}</span>}
      </div>
      {!big && v && (
        <div className="ed-vitals">
          {[
            v.systolic && v.diastolic ? t('BP {s}/{d}', { s: v.systolic, d: v.diastolic }) : null,
            v.heartRate ? t('HR {n}', { n: v.heartRate }) : null,
            v.respiratoryRate ? t('RR {n}', { n: v.respiratoryRate }) : null,
            v.spo2 ? `SpO₂ ${v.spo2}%` : null,
            v.temperature ? `${v.temperature} °C` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      {!big && i.triageNote && <p className="muted ed-complaint">{i.triageNote}</p>}
      {!big && b.canTreat && (
        <div className="ed-actions">
          <Button
            size="sm"
            variant={i.triageLevel ? 'secondary' : 'primary'}
            onClick={() => actions.setTriaging(i)}
          >
            {i.triageLevel ? t('Re-triage') : t('Triage')}
          </Button>
          {i.status === 'WAITING' && (
            <Button size="sm" onClick={() => actions.setStarting(i)}>
              {t('Start treatment')}
            </Button>
          )}
          {user.role === 'DOCTOR' && (
            <Button size="sm" variant="secondary" onClick={() => actions.setAdmitting(i)}>
              {t('Admit')}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => actions.setDeparting(i)}>
            {t('Departure')}
          </Button>
          {chartBase && (
            <Link
              className="btn btn-ghost btn-sm"
              to={`${chartBase}/${i.patient.id}?tab=emergency`}
            >
              {t('Open record')}
            </Link>
          )}
        </div>
      )}
    </article>
  );
}

function Departed({ board }: { board: Board }) {
  return (
    <Card title={t('Left the department (last 12 hours)')}>
      {board.departed.length === 0 ? (
        <EmptyState title={t('No departures yet')} />
      ) : (
        <Table caption={t('Left the department (last 12 hours)')}>
          <thead>
            <tr>
              <th>{t('Patient')}</th>
              <th>{t('Triage')}</th>
              <th>{t('Arrived')}</th>
              <th>{t('Left')}</th>
              <th>{t('Outcome')}</th>
            </tr>
          </thead>
          <tbody>
            {board.departed.map((d) => (
              <tr key={d.id}>
                <td>{edPatientName(d.patient)}</td>
                <td>
                  <LevelLabel level={d.triageLevel} />
                </td>
                <td>{formatTime(d.arrivedAt)}</td>
                <td>{formatTime(d.departedAt)}</td>
                <td>
                  <Badge tone={d.status === 'LEFT_WITHOUT_BEING_SEEN' ? 'warning' : 'neutral'}>
                    {edStatusLabel(d.status)}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ dialogs --------------------- */

interface SearchPatient {
  id: string;
  nationalId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: string;
}

function RegisterArrivalDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [patientId, setPatientId] = useState('');
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const results = useQuery({
    queryKey: ['patients', 'ed-search', submitted],
    queryFn: () =>
      api<{ items: SearchPatient[] }>('/patients', {
        query: { search: submitted, scope: 'facility', pageSize: 20 },
      }).then((r) => r.items),
    enabled: open && submitted.length >= 2,
  });
  const arrive = useEdMutation((body: Record<string, unknown>) => ({ path: '/ed/arrivals', body }));

  function close() {
    setSearch('');
    setSubmitted('');
    setPatientId('');
    setUnknown(false);
    setError(null);
    onClose();
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    setBusy(true);
    try {
      let id = patientId;
      if (unknown) {
        const estimated = String(f.get('estimatedAge') ?? '').trim();
        const created = await api<{ id: string }>('/identity/temporary', {
          method: 'POST',
          body: {
            sex: f.get('sex'),
            ...(estimated ? { estimatedAge: Number(estimated) } : {}),
            identityNote: String(f.get('identityNote') ?? '').trim(),
          },
        });
        id = created.id;
      }
      if (!id) throw new Error(t('Choose a patient, or register an unknown patient'));
      await arrive.mutateAsync({
        patientId: id,
        arrivalMode: f.get('arrivalMode') as ArrivalMode,
        chiefComplaint: String(f.get('chiefComplaint') ?? '').trim(),
      });
      close();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={close} title={t('Register arrival')} wide>
      <form onSubmit={onSubmit}>
        <label className="checkbox">
          <input type="checkbox" checked={unknown} onChange={(e) => setUnknown(e.target.checked)} />
          <span>{t('Unknown patient (identity not known yet)')}</span>
        </label>
        {unknown ? (
          <div className="form-grid">
            <SelectField
              label={t('Sex')}
              name="sex"
              required
              defaultValue="UNKNOWN"
              options={['FEMALE', 'MALE', 'OTHER', 'UNKNOWN'].map((s) => ({
                value: s,
                label: humanize(s),
              }))}
            />
            <TextField
              label={t('Estimated age (years)')}
              name="estimatedAge"
              type="number"
              min={0}
              max={120}
            />
            <TextAreaField
              label={t('Description')}
              name="identityNote"
              required
              minLength={3}
              maxLength={300}
              rows={2}
              hint={t('What helps to identify the person later, e.g. clothing, where found.')}
            />
          </div>
        ) : (
          <>
            <div className="search-bar">
              <TextField
                label={t('Find patient')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('Name or national ID')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    setSubmitted(search.trim());
                  }
                }}
              />
              <Button variant="secondary" onClick={() => setSubmitted(search.trim())}>
                {t('Search')}
              </Button>
            </div>
            {submitted.length >= 2 && (
              <QueryView query={results}>
                {(items) =>
                  items.length === 0 ? (
                    <p className="muted">
                      {t('No patient found. Register them first, or use “Unknown patient”.')}
                    </p>
                  ) : (
                    <ul className="ed-results" aria-label={t('Search results')}>
                      {items.map((p) => (
                        <li key={p.id}>
                          <label>
                            <input
                              type="radio"
                              name="patient"
                              checked={patientId === p.id}
                              onChange={() => setPatientId(p.id)}
                            />
                            <span>
                              <strong>
                                {p.firstName} {p.lastName}
                              </strong>{' '}
                              <span className="muted">
                                {t('{age} y', { age: age(p.dateOfBirth) })} · {p.nationalId}
                              </span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )
                }
              </QueryView>
            )}
          </>
        )}
        <div className="form-grid">
          <SelectField
            label={t('Arrival')}
            name="arrivalMode"
            required
            defaultValue="WALK_IN"
            options={ARRIVAL_MODES.map((m) => ({ value: m, label: arrivalModeLabel(m) }))}
          />
        </div>
        <TextAreaField
          label={t('Main complaint')}
          name="chiefComplaint"
          required
          minLength={3}
          maxLength={300}
          rows={2}
        />
        <ErrorAlert error={error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={close}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={busy}>
            {t('Register arrival')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function num(f: FormData, key: string) {
  const v = String(f.get(key) ?? '').trim();
  return v === '' ? undefined : Number(v);
}

function TriageDialog({ item, onClose }: { item: EdBoardItem | null; onClose: () => void }) {
  const triage = useEdMutation(
    (body: Record<string, unknown>) => ({ path: `/ed/visits/${item!.id}/triage`, body }),
    onClose,
  );
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const vitals = Object.fromEntries(
      ['systolic', 'diastolic', 'heartRate', 'respiratoryRate', 'temperature', 'spo2', 'painScore']
        .map((k) => [k, num(f, k)])
        .filter(([, v]) => v !== undefined),
    );
    triage.mutate({
      level: Number(f.get('level')),
      note: String(f.get('note') ?? '').trim() || null,
      ...(Object.keys(vitals).length ? { vitals } : {}),
    });
  }
  return (
    <Dialog open={Boolean(item)} onClose={onClose} title={t('Triage')} wide>
      {item && (
        <form onSubmit={onSubmit}>
          <p>
            <strong>{edPatientName(item.patient)}</strong> · {item.chiefComplaint}
          </p>
          <fieldset className="ed-levels">
            <legend>{t('Triage level')}</legend>
            {TRIAGE_LEVELS.map((l) => (
              <label key={l} className={`ed-level-option ed-level-${l}`}>
                <input
                  type="radio"
                  name="level"
                  value={l}
                  required
                  defaultChecked={item.triageLevel === l}
                />
                <span>
                  <span className="ed-level">
                    <span className="ed-dot" aria-hidden="true" />
                    {t('{level} · {name}', { level: l, name: TRIAGE[l].name() })} —{' '}
                    {l === 1
                      ? t('immediately')
                      : t('seen within {time}', {
                          time: formatMinutes([0, 0, 10, 60, 120, 240][l]!),
                        })}
                  </span>
                  <span className="muted">{TRIAGE_GUIDANCE[l]()}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <h3>{t('Vital signs')}</h3>
          <div className="ed-vitals-grid">
            <TextField
              label={t('Systolic (mmHg)')}
              name="systolic"
              type="number"
              min={40}
              max={300}
            />
            <TextField
              label={t('Diastolic (mmHg)')}
              name="diastolic"
              type="number"
              min={20}
              max={200}
            />
            <TextField
              label={t('Heart rate (/min)')}
              name="heartRate"
              type="number"
              min={20}
              max={300}
            />
            <TextField
              label={t('Respiratory rate (/min)')}
              name="respiratoryRate"
              type="number"
              min={4}
              max={80}
            />
            <TextField
              label={t('Temperature (°C)')}
              name="temperature"
              type="number"
              step="0.1"
              min={25}
              max={45}
            />
            <TextField label="SpO₂ (%)" name="spo2" type="number" min={30} max={100} />
            <TextField label={t('Pain (0–10)')} name="painScore" type="number" min={0} max={10} />
          </div>
          <TextAreaField label={t('Triage note')} name="note" maxLength={900} rows={3} />
          <ErrorAlert error={triage.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={triage.isPending}>
              {t('Save triage')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function StartDialog({
  item,
  board,
  onClose,
}: {
  item: EdBoardItem | null;
  board: Board;
  onClose: () => void;
}) {
  const user = useUser();
  const start = useEdMutation(
    (doctorId: string) => ({ path: `/ed/visits/${item!.id}/start`, body: { doctorId } }),
    onClose,
  );
  const defaultDoctor = board.doctors.some((d) => d.id === user.id) ? user.id : '';
  return (
    <Dialog open={Boolean(item)} onClose={onClose} title={t('Start treatment')}>
      {item && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start.mutate(String(new FormData(e.currentTarget).get('doctorId')));
          }}
        >
          <p>
            <strong>{edPatientName(item.patient)}</strong>
          </p>
          {board.doctors.length === 0 ? (
            <Alert
              tone="warning"
              title={t('No doctors are assigned to the emergency department')}
            />
          ) : (
            <SelectField
              label={t('Treating doctor')}
              name="doctorId"
              required
              defaultValue={defaultDoctor}
              placeholder={t('Choose a doctor')}
              options={board.doctors.map((d) => ({ value: d.id, label: d.fullName }))}
            />
          )}
          <ErrorAlert error={start.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={start.isPending} disabled={!board.doctors.length}>
              {t('Start treatment')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

interface Unit {
  id: string;
  name: string;
  code: string;
  type: string;
  beds: { id: string; label: string; status: string }[];
  occupied: number;
  total: number;
}

function AdmitDialog({ item, onClose }: { item: EdBoardItem | null; onClose: () => void }) {
  const user = useUser();
  const [unitId, setUnitId] = useState('');
  const units = useQuery({
    queryKey: ['hospital', 'units', 'admit'],
    queryFn: () =>
      api<{ items: Unit[] }>('/hospital/units', {
        query: { type: 'GENERAL_WARD,SURGICAL_WARD,ICU,PAEDIATRIC,MATERNITY' },
      }).then((r) => r.items),
    enabled: Boolean(item),
  });
  const colleagues = useQuery({
    queryKey: ['cover', 'colleagues'],
    queryFn: () =>
      api<{ items: { id: string; fullName: string }[] }>('/cover/colleagues').then((r) => r.items),
    enabled: Boolean(item),
  });
  const admit = useEdMutation(
    (body: Record<string, unknown>) => ({ path: '/hospital/admissions', body }),
    () => {
      setUnitId('');
      onClose();
    },
  );
  const unit = units.data?.find((u) => u.id === unitId);
  const freeBeds = unit?.beds.filter((b) => b.status === 'AVAILABLE') ?? [];
  const doctors = [{ id: user.id, fullName: user.fullName }, ...(colleagues.data ?? [])];

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const bedId = String(f.get('bedId') ?? '');
    admit.mutate({
      patientId: item!.patient.id,
      unitId,
      ...(bedId ? { bedId } : {}),
      attendingDoctorId: String(f.get('attendingDoctorId')),
      source: 'EMERGENCY',
      reason: String(f.get('reason') ?? '').trim(),
      edVisitId: item!.id,
    });
  }

  return (
    <Dialog open={Boolean(item)} onClose={onClose} title={t('Admit to a ward')} wide>
      {item && (
        <form onSubmit={onSubmit}>
          <p>
            <strong>{edPatientName(item.patient)}</strong> · {item.chiefComplaint}
          </p>
          <QueryView query={units}>
            {(list) =>
              list.length === 0 ? (
                <Alert tone="warning" title={t('No wards are set up at this facility')} />
              ) : (
                <div className="form-grid">
                  <SelectField
                    label={t('Ward')}
                    required
                    value={unitId}
                    onChange={(e) => setUnitId(e.target.value)}
                    placeholder={t('Choose a ward')}
                    options={list.map((u) => ({
                      value: u.id,
                      label: t('{name} – {free} of {total} beds free', {
                        name: u.name,
                        free: u.beds.filter((b) => b.status === 'AVAILABLE').length,
                        total: u.total,
                      }),
                    }))}
                  />
                  <SelectField
                    label={t('Bed')}
                    name="bedId"
                    disabled={!unit}
                    placeholder={freeBeds.length ? t('Assign later') : t('No free bed')}
                    options={freeBeds.map((b) => ({ value: b.id, label: b.label }))}
                  />
                  <SelectField
                    label={t('Attending doctor')}
                    name="attendingDoctorId"
                    required
                    defaultValue={user.id}
                    options={doctors.map((d) => ({ value: d.id, label: d.fullName }))}
                  />
                </div>
              )
            }
          </QueryView>
          <TextAreaField
            label={t('Reason for admission')}
            name="reason"
            required
            minLength={3}
            maxLength={500}
            rows={2}
            defaultValue={item.chiefComplaint}
          />
          <ErrorAlert error={admit.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={admit.isPending} disabled={!unitId}>
              {t('Admit')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function DepartDialog({ item, onClose }: { item: EdBoardItem | null; onClose: () => void }) {
  const user = useUser();
  const depart = useEdMutation(
    (body: Record<string, unknown>) => ({ path: `/ed/visits/${item!.id}/depart`, body }),
    onClose,
  );
  const statuses =
    user.role === 'DOCTOR'
      ? (['DISCHARGED', 'TRANSFERRED', 'LEFT_WITHOUT_BEING_SEEN'] as const)
      : (['LEFT_WITHOUT_BEING_SEEN'] as const);
  return (
    <Dialog open={Boolean(item)} onClose={onClose} title={t('Departure')}>
      {item && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            depart.mutate({
              status: f.get('status'),
              note: String(f.get('note') ?? '').trim() || null,
            });
          }}
        >
          <p>
            <strong>{edPatientName(item.patient)}</strong> ·{' '}
            {tn(
              item.minutesInDepartment,
              '{count} minute in the department',
              '{count} minutes in the department',
            )}
          </p>
          <SelectField
            label={t('Outcome')}
            name="status"
            required
            defaultValue={statuses[0]}
            options={statuses.map((s) => ({ value: s, label: edStatusLabel(s) }))}
            hint={
              user.role === 'DOCTOR'
                ? t('To admit the patient to a ward, use “Admit”.')
                : t('Only a doctor discharges or transfers a patient.')
            }
          />
          <TextAreaField
            label={t('Note')}
            name="note"
            maxLength={1000}
            rows={3}
            hint={t('Advice given, destination of a transfer, or why the patient left.')}
          />
          <ErrorAlert error={depart.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={depart.isPending}>
              {t('Confirm departure')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
