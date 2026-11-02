import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { DirectoryEntry, Page, PatientListItem } from '../../api/types';
import {
  Button,
  Dialog,
  ErrorAlert,
  SelectField,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { age, formatDate } from '../../format';

const DURATIONS = [10, 15, 20, 30, 45, 60];

/** Local "YYYY-MM-DDTHH:mm" for datetime-local inputs. */
function localInput(d: Date) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export interface PatientRef {
  id: string;
  name: string;
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
      onDone();
    },
  });

  const min = localInput(new Date(Date.now() + 5 * 60_000));
  const defaultTime = new Date(Date.now() + 60 * 60_000);
  defaultTime.setMinutes(defaultTime.getMinutes() < 30 ? 30 : 60, 0, 0);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!patient) return;
    const f = new FormData(e.currentTarget);
    mutation.mutate({
      patientId: patient.id,
      doctorId: f.get('doctorId'),
      scheduledAt: new Date(String(f.get('scheduledAt'))).toISOString(),
      durationMinutes: Number(f.get('durationMinutes')),
      reason: String(f.get('reason') ?? '').trim(),
    });
  }

  return (
    <div className="stack">
      {patient ? (
        <div className="row-between">
          <span>
            Patient: <strong>{patient.name}</strong>
          </span>
          {!initialPatient && (
            <Button variant="ghost" size="sm" onClick={() => setPatient(null)}>
              Change
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
              label="Find patient"
              hint="Name or national ID (at least 2 characters)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              minLength={2}
            />
            <Button type="submit" variant="secondary">
              Search
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
                        {age(p.dateOfBirth)} y)
                      </div>
                    </span>
                    <Button
                      size="sm"
                      onClick={() => setPatient({ id: p.id, name: `${p.firstName} ${p.lastName}` })}
                    >
                      Select
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No patients found at your facility.</p>
            ))}
        </div>
      )}

      <form onSubmit={onSubmit}>
        <div className="form-grid">
          <SelectField
            label="Doctor"
            name="doctorId"
            required
            placeholder={doctors.isPending ? 'Loading…' : 'Choose a doctor'}
            options={(doctors.data?.items ?? []).map((d) => ({
              value: d.id,
              label: `${d.fullName}${d.specialty ? ` — ${d.specialty}` : ''}`,
            }))}
          />
          <TextField
            label="Date and time"
            name="scheduledAt"
            type="datetime-local"
            min={min}
            defaultValue={localInput(defaultTime)}
            required
          />
          <SelectField
            label="Duration"
            name="durationMinutes"
            defaultValue="20"
            options={DURATIONS.map((d) => ({ value: String(d), label: `${d} minutes` }))}
          />
        </div>
        <TextAreaField
          label="Reason for the visit"
          name="reason"
          required
          minLength={2}
          maxLength={500}
          rows={2}
        />
        <ErrorAlert error={mutation.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending} disabled={!patient}>
            Book appointment
          </Button>
        </div>
      </form>
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
    <Dialog open={open} onClose={onClose} title="Book appointment" wide>
      <BookingForm key={patient?.id ?? 'any'} initialPatient={patient} onDone={onClose} />
    </Dialog>
  );
}
