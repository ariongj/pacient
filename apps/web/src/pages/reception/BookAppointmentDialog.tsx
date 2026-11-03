import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import {
  addDays,
  localDateOf,
  noonOf,
  slotTime,
  todayLocal,
  useSlots,
  weekdayShort,
  type Slot,
} from '../../api/scheduling';
import type { DirectoryEntry, Page, PatientListItem } from '../../api/types';
import {
  Alert,
  Badge,
  Button,
  Dialog,
  ErrorAlert,
  Loading,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { age, formatDate, formatDayHeading } from '../../format';
import { t, tn } from '../../i18n';
import './slots.css';

const DURATIONS = [10, 15, 20, 30, 45, 60];
const WINDOW_DAYS = 14;

/** Local "YYYY-MM-DDTHH:mm" for datetime-local inputs. */
function localInput(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export interface PatientRef {
  id: string;
  name: string;
}

/**
 * Free slots of a doctor over two weeks: a strip of days, then the free times of the chosen day.
 * Patients see only slots they may book online (from tomorrow); staff see all free slots, with
 * staff-only ones marked.
 */
export function SlotPicker({
  doctorId,
  patientMode = false,
  value,
  onChange,
}: {
  doctorId: string;
  patientMode?: boolean;
  value: Slot | null;
  onChange: (slot: Slot) => void;
}) {
  const first = patientMode ? addDays(todayLocal(), 1) : todayLocal();
  const [start, setStart] = useState(first);
  const [chosenDay, setChosenDay] = useState<string | null>(null);
  const end = addDays(start, WINDOW_DAYS - 1);
  const slots = useSlots(doctorId, start, end);

  const byDay = useMemo(() => {
    const m = new Map<string, Slot[]>();
    for (const s of slots.data?.items ?? []) {
      const d = localDateOf(s.start);
      m.set(d, [...(m.get(d) ?? []), s]);
    }
    return m;
  }, [slots.data]);
  const days = Array.from({ length: WINDOW_DAYS }, (_, i) => addDays(start, i));
  const firstWithSlots = days.find((d) => byDay.has(d)) ?? null;
  const day = chosenDay && days.includes(chosenDay) ? chosenDay : firstWithSlots;
  const lastBookable = patientMode ? addDays(todayLocal(), 60) : addDays(todayLocal(), 365);

  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      <div className="slot-nav">
        <Button
          size="sm"
          variant="ghost"
          disabled={start <= first}
          onClick={() => {
            const prev = addDays(start, -WINDOW_DAYS);
            setStart(prev < first ? first : prev);
            setChosenDay(null);
          }}
        >
          ‹ {t('Earlier')}
        </Button>
        <span className="muted">
          {formatDate(noonOf(start).toISOString())} – {formatDate(noonOf(end).toISOString())}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={addDays(start, WINDOW_DAYS) > lastBookable}
          onClick={() => {
            setStart(addDays(start, WINDOW_DAYS));
            setChosenDay(null);
          }}
        >
          {t('Later')} ›
        </Button>
      </div>
      {slots.isPending ? (
        <Loading label={t('Loading free times…')} />
      ) : slots.error ? (
        <ErrorAlert error={slots.error} />
      ) : (
        <>
          <div className="slot-days" role="group" aria-label={t('Choose a day')}>
            {days.map((d) => {
              const n = byDay.get(d)?.length ?? 0;
              return (
                <button
                  key={d}
                  type="button"
                  className="slot-day"
                  aria-pressed={d === day}
                  disabled={n === 0}
                  onClick={() => setChosenDay(d)}
                  aria-label={`${formatDayHeading(noonOf(d))} – ${tn(n, '{count} free time', '{count} free times')}`}
                >
                  {weekdayShort(noonOf(d).getUTCDay())}
                  <strong>{Number(d.slice(8))}</strong>
                  <small>{n || '–'}</small>
                </button>
              );
            })}
          </div>
          {day ? (
            <div>
              <h3 style={{ margin: '0.25rem 0' }}>{formatDayHeading(noonOf(day))}</h3>
              <div className="slot-grid" role="group" aria-label={t('Free times')}>
                {(byDay.get(day) ?? []).map((s) => (
                  <button
                    key={s.start}
                    type="button"
                    className="slot-btn"
                    aria-pressed={value?.start === s.start}
                    onClick={() => onChange(s)}
                  >
                    {slotTime(s.start)}
                    {!patientMode && !s.portalBookable && <small>{t('staff only')}</small>}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <Alert tone="info">
              {patientMode
                ? t('No free times in these two weeks. Try later dates or send a request instead.')
                : t('No free consulting hours in these two weeks.')}
            </Alert>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Warns (without blocking) when a manually typed time is not one of the doctor's free slots:
 * outside consulting hours or already taken.
 */
export function useManualTimeCheck(doctorId: string | null, manual: string) {
  const date = manual ? localDateOf(new Date(manual)) : todayLocal();
  const slots = useSlots(manual && doctorId ? doctorId : null, date, date);
  if (!manual || !doctorId || !slots.data) return null;
  const iso = new Date(manual).toISOString();
  return slots.data.items.some((s) => s.start === iso)
    ? null
    : t(
        'This time is outside the doctor’s consulting hours or already taken. You can still book it.',
      );
}

function BookingForm({
  initialPatient,
  onDone,
}: {
  initialPatient?: PatientRef;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [patient, setPatient] = useState<PatientRef | null>(initialPatient ?? null);
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [mode, setMode] = useState<'slot' | 'manual'>('slot');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [manual, setManual] = useState('');
  const [duration, setDuration] = useState('20');
  const warning = useManualTimeCheck(mode === 'manual' ? doctorId : null, manual);

  const doctors = useQuery({
    queryKey: ['directory', 'DOCTOR'],
    queryFn: () => api<{ items: DirectoryEntry[] }>('/directory', { query: { role: 'DOCTOR' } }),
  });
  const results = useQuery({
    queryKey: ['patients', 'facility', 'booking', submitted],
    queryFn: () =>
      api<Page<PatientListItem>>('/patients', {
        query: { scope: 'facility', search: submitted, pageSize: 8 },
      }),
    enabled: !patient && submitted.length >= 2,
  });
  const mutation = useMutation({
    mutationFn: (body: object) => api('/appointments', { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      queryClient.invalidateQueries({ queryKey: ['scheduling'] });
      onDone();
    },
  });

  const min = localInput(new Date(Date.now() + 5 * 60_000));
  const when = mode === 'slot' ? slot?.start : manual ? new Date(manual).toISOString() : '';

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!patient || !when) return;
    const f = new FormData(e.currentTarget);
    mutation.mutate({
      patientId: patient.id,
      doctorId,
      scheduledAt: when,
      durationMinutes: mode === 'slot' && slot ? slot.minutes : Number(duration),
      reason: String(f.get('reason') ?? '').trim(),
    });
  }

  return (
    <div className="stack">
      {patient ? (
        <div className="row-between">
          <span>
            {t('Patient:')} <strong>{patient.name}</strong>
          </span>
          {!initialPatient && (
            <Button variant="ghost" size="sm" onClick={() => setPatient(null)}>
              {t('Change')}
            </Button>
          )}
        </div>
      ) : (
        <div className="stack">
          <form
            className="search-bar"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(search.trim());
            }}
          >
            <TextField
              label={t('Find patient')}
              hint={t('Name or national ID (at least 2 characters)')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              minLength={2}
            />
            <Button type="submit" variant="secondary">
              {t('Search')}
            </Button>
          </form>
          {results.error ? <ErrorAlert error={results.error} /> : null}
          {results.data &&
            (results.data.items.length ? (
              <ul className="list">
                {results.data.items.map((p) => (
                  <li key={p.id} className="row-between">
                    <span>
                      <strong>
                        {p.firstName} {p.lastName}
                      </strong>
                      <div className="muted">
                        <span className="mono">{p.nationalId}</span> · {formatDate(p.dateOfBirth)} (
                        {t('{age} y', { age: age(p.dateOfBirth) })})
                      </div>
                    </span>
                    <Button
                      size="sm"
                      onClick={() => setPatient({ id: p.id, name: `${p.firstName} ${p.lastName}` })}
                    >
                      {t('Select')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{t('No patients found at your facility.')}</p>
            ))}
        </div>
      )}

      <form onSubmit={onSubmit} className="stack">
        <SelectField
          label={t('Doctor')}
          name="doctorId"
          required
          value={doctorId}
          onChange={(e) => {
            setDoctorId(e.target.value);
            setSlot(null);
          }}
          placeholder={doctors.isPending ? t('Loading…') : t('Choose a doctor')}
          options={(doctors.data?.items ?? []).map((d) => ({
            value: d.id,
            label: `${d.fullName}${d.specialty ? ` — ${d.specialty}` : ''}`,
          }))}
        />
        {doctorId && (
          <TimeChooser
            doctorId={doctorId}
            mode={mode}
            setMode={setMode}
            slot={slot}
            setSlot={setSlot}
            manual={manual}
            setManual={setManual}
            min={min}
            warning={warning}
            duration={duration}
            setDuration={setDuration}
          />
        )}
        <TextAreaField
          label={t('Reason for the visit')}
          name="reason"
          required
          minLength={2}
          maxLength={500}
          rows={2}
        />
        <ErrorAlert error={mutation.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onDone}>
            {t('Cancel')}
          </Button>
          <Button
            type="submit"
            loading={mutation.isPending}
            disabled={!patient || !doctorId || !when}
          >
            {t('Book appointment')}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Free-slot picker with a fallback to typing any time (with a non-blocking warning). */
export function TimeChooser({
  doctorId,
  mode,
  setMode,
  slot,
  setSlot,
  manual,
  setManual,
  min,
  warning,
  duration,
  setDuration,
}: {
  doctorId: string;
  mode: 'slot' | 'manual';
  setMode: (m: 'slot' | 'manual') => void;
  slot: Slot | null;
  setSlot: (s: Slot | null) => void;
  manual: string;
  setManual: (v: string) => void;
  min?: string;
  warning: string | null;
  duration: string;
  setDuration: (v: string) => void;
}) {
  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      <div className="row" role="group" aria-label={t('How to choose the time')}>
        <Button
          size="sm"
          variant={mode === 'slot' ? 'primary' : 'secondary'}
          onClick={() => setMode('slot')}
          aria-pressed={mode === 'slot'}
        >
          {t('Free slots')}
        </Button>
        <Button
          size="sm"
          variant={mode === 'manual' ? 'primary' : 'secondary'}
          onClick={() => setMode('manual')}
          aria-pressed={mode === 'manual'}
        >
          {t('Other time')}
        </Button>
      </div>
      {mode === 'slot' ? (
        <>
          <SlotPicker doctorId={doctorId} value={slot} onChange={setSlot} />
          {slot && (
            <p>
              {t('Selected:')}{' '}
              <Badge tone="info">
                {formatDayHeading(new Date(slot.start))} · {slotTime(slot.start)} ·{' '}
                {t('{count} minutes', { count: slot.minutes })}
              </Badge>
            </p>
          )}
        </>
      ) : (
        <div className="form-grid">
          <TextField
            label={t('Date and time')}
            name="scheduledAt"
            type="datetime-local"
            min={min}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            required
          />
          <SelectField
            label={t('Duration')}
            name="durationMinutes"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            options={DURATIONS.map((d) => ({
              value: String(d),
              label: t('{count} minutes', { count: d }),
            }))}
          />
          {warning && <Alert tone="warning">{warning}</Alert>}
        </div>
      )}
    </div>
  );
}

export function BookAppointmentDialog({
  open,
  onClose,
  patient,
}: {
  open: boolean;
  onClose: () => void;
  patient?: PatientRef;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={t('Book appointment')} wide>
      <BookingForm key={patient?.id ?? 'any'} initialPatient={patient} onDone={onClose} />
    </Dialog>
  );
}
