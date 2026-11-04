import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import {
  bedStatusLabel,
  unitTypeLabel,
  useHospitalMutation,
  useUnits,
  WARD_TYPES,
  type Person,
  type StaffMember,
  type Unit,
  type UnitType,
} from '../../api/hospital';
import {
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
  TextField,
} from '../../components/ui';
import { formatDate, humanize } from '../../format';
import { t } from '../../i18n';
import '../hospital/hospital.css';

const ALL_TYPES: UnitType[] = [
  ...WARD_TYPES,
  'EMERGENCY',
  'RADIOLOGY',
  'OPERATING_THEATRE',
  'BLOOD_BANK',
  'NUTRITION',
];

function NewUnitDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useHospitalMutation(
    (body: Record<string, unknown>) => api('/hospital/units', { method: 'POST', body }),
    { onDone: onClose },
  );
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    create.mutate({
      name: String(f.get('name')).trim(),
      code: String(f.get('code')).trim(),
      type: String(f.get('type')),
    });
  }
  return (
    <Dialog open={open} onClose={onClose} title={t('New unit')}>
      <form onSubmit={onSubmit} className="stack">
        <TextField label={t('Name')} name="name" required minLength={2} maxLength={120} />
        <div className="form-grid">
          <TextField
            label={t('Code')}
            name="code"
            required
            maxLength={20}
            pattern="[A-Za-z0-9_\-]+"
            hint={t('Short code, e.g. INT-B')}
          />
          <SelectField
            label={t('Type')}
            name="type"
            required
            options={ALL_TYPES.map((v) => ({ value: v, label: unitTypeLabel(v) }))}
          />
        </div>
        <p className="muted">
          {t(
            'Staff assigned to a unit can open the records of the patients who are currently in it – admitted to the ward, waiting in emergency or awaiting imaging.',
          )}
        </p>
        <ErrorAlert error={create.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {t('Create unit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddBedsForm({ unit }: { unit: Unit }) {
  const add = useHospitalMutation((body: Record<string, unknown>) =>
    api(`/hospital/units/${unit.id}/beds`, { method: 'POST', body }),
  );
  return (
    <form
      className="search-bar"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        add.mutate({
          prefix: String(f.get('prefix') ?? '').trim(),
          from: Number(f.get('from')),
          to: Number(f.get('to')),
        });
      }}
    >
      <TextField
        label={t('Prefix')}
        name="prefix"
        maxLength={10}
        defaultValue={unit.code.slice(0, 1)}
      />
      <TextField
        label={t('From')}
        name="from"
        type="number"
        min={0}
        max={999}
        required
        defaultValue={unit.total + 1}
      />
      <TextField
        label={t('To')}
        name="to"
        type="number"
        min={0}
        max={999}
        required
        defaultValue={unit.total + 4}
      />
      <Button type="submit" variant="secondary" loading={add.isPending}>
        {t('Add beds')}
      </Button>
      <ErrorAlert error={add.error} />
    </form>
  );
}

function StaffPanel({ unit }: { unit: Unit }) {
  const staff = useQuery({
    queryKey: ['hospital', 'units', unit.id, 'staff'],
    queryFn: () =>
      api<{ items: StaffMember[] }>(`/hospital/units/${unit.id}/staff`).then((r) => r.items),
  });
  const candidates = useQuery({
    queryKey: ['hospital', 'assignable-staff'],
    queryFn: () => api<{ items: Person[] }>('/hospital/assignable-staff').then((r) => r.items),
    staleTime: 60_000,
  });
  const [userId, setUserId] = useState('');
  const assign = useHospitalMutation(
    (id: string) =>
      api(`/hospital/units/${unit.id}/staff`, { method: 'POST', body: { userId: id } }),
    { onDone: () => setUserId('') },
  );
  const remove = useHospitalMutation((id: string) =>
    api(`/hospital/units/${unit.id}/staff/${id}`, { method: 'DELETE' }),
  );
  const assigned = new Set((staff.data ?? []).map((s) => s.userId));
  return (
    <div className="stack" style={{ gap: '0.5rem' }}>
      <h3 style={{ margin: 0, fontSize: '1rem' }}>{t('Staff of this unit')}</h3>
      <QueryView query={staff}>
        {(items) =>
          items.length === 0 ? (
            <p className="muted">{t('Nobody is assigned yet.')}</p>
          ) : (
            <ul className="list">
              {items.map((s) => (
                <li key={s.userId} className="row-between">
                  <span>
                    <strong>{s.fullName}</strong>{' '}
                    <span className="muted">
                      {humanize(s.role)}
                      {s.specialty ? ` · ${t(s.specialty)}` : ''} ·{' '}
                      {t('since {date}', { date: formatDate(s.assignedAt) })}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={remove.isPending && remove.variables === s.userId}
                    onClick={() => remove.mutate(s.userId)}
                  >
                    {t('Remove')}
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </QueryView>
      <form
        className="search-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (userId) assign.mutate(userId);
        }}
      >
        <SelectField
          label={t('Assign staff')}
          value={userId}
          onChange={(e) => setUserId(e.currentTarget.value)}
          placeholder={t('Choose a person')}
          options={(candidates.data ?? [])
            .filter((c) => !assigned.has(c.id))
            .map((c) => ({
              value: c.id,
              label: `${c.fullName} · ${humanize(c.role ?? '')}${c.specialty ? ` · ${t(c.specialty)}` : ''}`,
            }))}
        />
        <Button type="submit" variant="secondary" disabled={!userId} loading={assign.isPending}>
          {t('Assign')}
        </Button>
      </form>
      <ErrorAlert error={assign.error ?? remove.error} />
    </div>
  );
}

function UnitCard({ unit }: { unit: Unit }) {
  const [open, setOpen] = useState(false);
  const toggle = useHospitalMutation((isActive: boolean) =>
    api(`/hospital/units/${unit.id}`, { method: 'PATCH', body: { isActive } }),
  );
  const isWard = (WARD_TYPES as string[]).includes(unit.type);
  return (
    <Card
      title={
        <>
          {unit.name} <span className="muted">· {unit.code}</span>{' '}
          {!unit.isActive && <Badge tone="neutral">{t('Closed')}</Badge>}
        </>
      }
      actions={
        <>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
          >
            {open ? t('Hide details') : t('Beds & staff')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={toggle.isPending}
            onClick={() => {
              if (window.confirm(unit.isActive ? t('Close this unit?') : t('Reopen this unit?')))
                toggle.mutate(!unit.isActive);
            }}
          >
            {unit.isActive ? t('Close unit') : t('Reopen')}
          </Button>
        </>
      }
    >
      <p className="muted" style={{ marginTop: 0 }}>
        {unitTypeLabel(unit.type)} ·{' '}
        {isWard
          ? t('{total} beds, {occupied} occupied, {available} free', {
              total: unit.total,
              occupied: unit.occupied,
              available: unit.available,
            })
          : t('No beds')}{' '}
        · {t('{count} staff', { count: unit.staff })}
      </p>
      <ErrorAlert error={toggle.error} />
      {open && (
        <div className="stack">
          {isWard && (
            <>
              <div className="row" style={{ flexWrap: 'wrap', gap: '0.35rem' }}>
                {unit.beds.map((b) => (
                  <Badge
                    key={b.id}
                    tone={
                      b.status === 'AVAILABLE'
                        ? 'success'
                        : b.status === 'OCCUPIED'
                          ? 'info'
                          : 'warning'
                    }
                  >
                    {b.label} · {bedStatusLabel(b.status)}
                  </Badge>
                ))}
              </div>
              <AddBedsForm unit={unit} />
            </>
          )}
          <StaffPanel unit={unit} />
        </div>
      )}
    </Card>
  );
}

/** Director: wards, emergency, radiology and other units, their beds and staff. */
export function UnitsPage() {
  const units = useUnits(undefined, true);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title={t('Wards & units')}
        subtitle={t(
          'Configure the wards, beds and departments of your facility and who works in them.',
        )}
        actions={<Button onClick={() => setCreating(true)}>{t('New unit')}</Button>}
      />
      <QueryView query={units}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No units yet')}>
              {t('Create the first ward to start using the bed board.')}
            </EmptyState>
          ) : (
            <div className="stack">
              <Card title={t('Overview')}>
                <Table caption={t('Units')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Unit')}</th>
                      <th scope="col">{t('Type')}</th>
                      <th scope="col" className="num">
                        {t('Beds')}
                      </th>
                      <th scope="col" className="num">
                        {t('Occupied')}
                      </th>
                      <th scope="col" className="num">
                        {t('Free')}
                      </th>
                      <th scope="col" className="num">
                        {t('Staff')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((u) => (
                      <tr key={u.id}>
                        <td>
                          {u.name} {!u.isActive && <Badge tone="neutral">{t('Closed')}</Badge>}
                        </td>
                        <td>{unitTypeLabel(u.type)}</td>
                        <td className="num">{u.total}</td>
                        <td className="num">{u.occupied}</td>
                        <td className="num">{u.available}</td>
                        <td className="num">{u.staff}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
              {items.map((u) => (
                <UnitCard key={u.id} unit={u} />
              ))}
            </div>
          )
        }
      </QueryView>
      <NewUnitDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
