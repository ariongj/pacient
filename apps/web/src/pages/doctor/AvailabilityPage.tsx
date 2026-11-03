import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import {
  addDays,
  localDateOf,
  noonOf,
  todayLocal,
  useAvailability,
  useSlots,
  weekdayName,
  weekdayShort,
  type AvailabilityBlock,
} from '../../api/scheduling';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  Table,
  TextField,
} from '../../components/ui';
import { formatDateTime, formatDayHeading } from '../../format';
import { t, tn } from '../../i18n';

/** Monday first, as in Kosovo calendars. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const SLOT_LENGTHS = [10, 15, 20, 30, 45, 60];

const blank = (weekday: number): AvailabilityBlock => ({
  weekday,
  startTime: '08:00',
  endTime: '12:00',
  slotMinutes: 20,
  portalBookable: true,
  validFrom: null,
  validUntil: null,
});

function WeeklyEditor({ doctorId, initial }: { doctorId: string; initial: AvailabilityBlock[] }) {
  const qc = useQueryClient();
  const [blocks, setBlocks] = useState<AvailabilityBlock[]>(initial);
  const [saved, setSaved] = useState(false);
  useEffect(() => setBlocks(initial), [initial]);
  const save = useMutation({
    mutationFn: () =>
      api(`/scheduling/doctors/${doctorId}/availability`, {
        method: 'PUT',
        body: {
          blocks: blocks.map((b) => ({
            weekday: b.weekday,
            startTime: b.startTime,
            endTime: b.endTime,
            slotMinutes: b.slotMinutes,
            portalBookable: b.portalBookable,
            validFrom: b.validFrom || null,
            validUntil: b.validUntil || null,
          })),
        },
      }),
    onSuccess: () => {
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['scheduling'] });
    },
  });
  const update = (i: number, patch: Partial<AvailabilityBlock>) => {
    setSaved(false);
    setBlocks((all) => all.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  };

  return (
    <Card
      title={t('Weekly consulting hours')}
      actions={
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          {t('Save hours')}
        </Button>
      }
    >
      <p className="muted">
        {t(
          'Bookable times are generated from these hours. Patients can book "online" blocks themselves in the portal; other blocks are for bookings by the facility. Existing appointments are not changed.',
        )}
      </p>
      <div className="stack">
        {WEEK.map((weekday) => {
          const rows = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.weekday === weekday);
          return (
            <fieldset key={weekday} className="stack" style={{ gap: '0.5rem' }}>
              <legend>
                <strong>{weekdayName(weekday)}</strong>
                {rows.length === 0 && <span className="muted"> · {t('no consulting hours')}</span>}
              </legend>
              {rows.map(({ b, i }) => (
                <div key={i} className="form-grid" style={{ alignItems: 'end' }}>
                  <TextField
                    label={t('From')}
                    type="time"
                    value={b.startTime}
                    onChange={(e) => update(i, { startTime: e.target.value })}
                    required
                  />
                  <TextField
                    label={t('Until')}
                    type="time"
                    value={b.endTime}
                    onChange={(e) => update(i, { endTime: e.target.value })}
                    required
                  />
                  <SelectField
                    label={t('Slot length')}
                    value={String(b.slotMinutes)}
                    onChange={(e) => update(i, { slotMinutes: Number(e.target.value) })}
                    options={SLOT_LENGTHS.map((m) => ({
                      value: String(m),
                      label: t('{count} minutes', { count: m }),
                    }))}
                  />
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={b.portalBookable}
                      onChange={(e) => update(i, { portalBookable: e.target.checked })}
                    />
                    <span>{t('Patients can book online')}</span>
                  </label>
                  <TextField
                    label={t('Valid from (optional)')}
                    type="date"
                    value={b.validFrom ?? ''}
                    onChange={(e) => update(i, { validFrom: e.target.value || null })}
                  />
                  <TextField
                    label={t('Valid until (optional)')}
                    type="date"
                    value={b.validUntil ?? ''}
                    onChange={(e) => update(i, { validUntil: e.target.value || null })}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSaved(false);
                      setBlocks((all) => all.filter((_, j) => j !== i));
                    }}
                    aria-label={t('Remove block on {day}', { day: weekdayName(weekday) })}
                  >
                    {t('Remove')}
                  </Button>
                </div>
              ))}
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setSaved(false);
                    setBlocks((all) => [...all, blank(weekday)]);
                  }}
                >
                  {t('Add hours on {day}', { day: weekdayName(weekday) })}
                </Button>
              </div>
            </fieldset>
          );
        })}
      </div>
      <ErrorAlert error={save.error} />
      {saved && <Alert tone="success" title={t('Consulting hours saved')} />}
    </Card>
  );
}

function Exceptions({
  doctorId,
  items,
}: {
  doctorId: string;
  items: { id: string; startsAt: string; endsAt: string; reason: string | null }[];
}) {
  const qc = useQueryClient();
  const [result, setResult] = useState<number | null>(null);
  const add = useMutation({
    mutationFn: (body: object) =>
      api<{ affectedAppointments: number }>(`/scheduling/doctors/${doctorId}/exceptions`, {
        method: 'POST',
        body,
      }),
    onSuccess: (r) => {
      setResult(r.affectedAppointments);
      void qc.invalidateQueries({ queryKey: ['scheduling'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/scheduling/doctors/${doctorId}/exceptions/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['scheduling'] }),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const from = String(f.get('from'));
    const until = String(f.get('until'));
    add.mutate({
      startsAt: new Date(`${from}T00:00`).toISOString(),
      // Whole days: until the end of the last day.
      endsAt: new Date(`${addDays(until, 1)}T00:00`).toISOString(),
      reason: String(f.get('reason') ?? '').trim() || undefined,
    });
    e.currentTarget.reset();
  }

  return (
    <Card title={t('Leave and other absences')}>
      <p className="muted">
        {t('No times are offered on these days. Appointments already booked stay as they are.')}
      </p>
      {items.length === 0 ? (
        <EmptyState title={t('No absences planned')} />
      ) : (
        <Table caption={t('Absences')}>
          <thead>
            <tr>
              <th>{t('From')}</th>
              <th>{t('Until')}</th>
              <th>{t('Reason')}</th>
              <th>
                <span className="sr-only">{t('Actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.id}>
                <td>{formatDateTime(x.startsAt)}</td>
                <td>{formatDateTime(x.endsAt)}</td>
                <td>{x.reason ?? '—'}</td>
                <td>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={remove.isPending && remove.variables === x.id}
                    onClick={() => remove.mutate(x.id)}
                  >
                    {t('Remove')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form onSubmit={onSubmit} className="form-grid" style={{ alignItems: 'end' }}>
        <TextField label={t('First day')} name="from" type="date" min={todayLocal()} required />
        <TextField label={t('Last day')} name="until" type="date" min={todayLocal()} required />
        <TextField label={t('Reason (optional)')} name="reason" maxLength={200} />
        <Button type="submit" variant="secondary" loading={add.isPending}>
          {t('Add absence')}
        </Button>
      </form>
      <ErrorAlert error={add.error ?? remove.error} />
      {result !== null && result > 0 && (
        <Alert tone="warning">
          {tn(
            result,
            '{count} booked appointment falls in this period – please rebook it.',
            '{count} booked appointments fall in this period – please rebook them.',
          )}
        </Alert>
      )}
    </Card>
  );
}

function Preview({ doctorId }: { doctorId: string }) {
  const from = todayLocal();
  const to = addDays(from, 13);
  const slots = useSlots(doctorId, from, to);
  const days = useMemo(() => {
    const m = new Map<string, { total: number; online: number }>();
    for (const s of slots.data?.items ?? []) {
      const d = localDateOf(s.start);
      const v = m.get(d) ?? { total: 0, online: 0 };
      v.total++;
      if (s.portalBookable) v.online++;
      m.set(d, v);
    }
    return m;
  }, [slots.data]);
  return (
    <Card title={t('Free times in the next 14 days')}>
      <QueryView query={slots}>
        {() => (
          <Table caption={t('Free times in the next 14 days')}>
            <thead>
              <tr>
                <th>{t('Day')}</th>
                <th>{t('Free times')}</th>
                <th>{t('Bookable online')}</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: 14 }, (_, i) => addDays(from, i)).map((d) => {
                const v = days.get(d);
                return (
                  <tr key={d}>
                    <td>
                      <span className="sr-only">{formatDayHeading(noonOf(d))}</span>
                      <span aria-hidden="true">
                        {weekdayShort(noonOf(d).getUTCDay())} {Number(d.slice(8))}.
                        {Number(d.slice(5, 7))}.
                      </span>
                    </td>
                    <td>{v?.total ?? 0}</td>
                    <td>{v?.online ? <Badge tone="success">{v.online}</Badge> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </QueryView>
    </Card>
  );
}

/** A doctor's consulting hours: weekly blocks, absences and a preview of the free times. */
export function AvailabilityPage() {
  const user = useUser();
  const availability = useAvailability(user.id);
  return (
    <>
      <PageHeader
        title={t('My consulting hours')}
        subtitle={t('When patients and the front desk can book appointments with you.')}
      />
      <QueryView query={availability}>
        {(a) => (
          <div className="stack">
            <WeeklyEditor doctorId={user.id} initial={a.blocks} />
            <Exceptions doctorId={user.id} items={a.exceptions} />
            <Preview doctorId={user.id} />
          </div>
        )}
      </QueryView>
    </>
  );
}
