import { useState, type FormEvent } from 'react';
import type { Encounter, Vitals } from '../../../api/types';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  QueryView,
  Table,
  TextField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { EncounterSelect, numbers, useChartMutation } from './shared';
import { useSection } from './useSection';

const FIELDS = [
  'systolic',
  'diastolic',
  'heartRate',
  'temperatureC',
  'respiratoryRate',
  'oxygenSaturation',
  'weightKg',
  'heightCm',
];

export function VitalsTab({
  patientId,
  encounters,
}: {
  patientId: string;
  encounters: Encounter[];
}) {
  const list = useSection<Vitals>(patientId, 'vitals');
  const [open, setOpen] = useState(false);
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/vitals', method: 'POST', body }),
    () => setOpen(false),
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate({
      ...numbers(v, FIELDS),
      ...(v.encounterId ? { encounterId: v.encounterId } : {}),
    });
  }

  return (
    <Card
      title="Vital signs"
      actions={
        <Button size="sm" onClick={() => setOpen(true)}>
          Record vitals
        </Button>
      }
    >
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title="No vital signs recorded" />
          ) : (
            <Table caption="Vital signs">
              <thead>
                <tr>
                  <th>Recorded</th>
                  <th className="num">BP (mmHg)</th>
                  <th className="num">HR (bpm)</th>
                  <th className="num">Temp (°C)</th>
                  <th className="num">RR</th>
                  <th className="num">SpO₂ (%)</th>
                  <th className="num">Weight (kg)</th>
                  <th className="num">Height (cm)</th>
                </tr>
              </thead>
              <tbody>
                {items.map((v) => (
                  <tr key={v.id}>
                    <td>
                      {formatDateTime(v.recordedAt)}
                      <div className="muted">{v.recordedBy}</div>
                    </td>
                    <td className="num">
                      {v.systolic ? `${v.systolic}/${v.diastolic ?? '—'}` : '—'}
                    </td>
                    <td className="num">{v.heartRate ?? '—'}</td>
                    <td className="num">{v.temperatureC ?? '—'}</td>
                    <td className="num">{v.respiratoryRate ?? '—'}</td>
                    <td className="num">{v.oxygenSaturation ?? '—'}</td>
                    <td className="num">{v.weightKg ?? '—'}</td>
                    <td className="num">{v.heightCm ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title="Record vital signs" wide>
        <form onSubmit={onSubmit}>
          <p className="muted">Enter at least one measurement.</p>
          <div className="form-grid">
            <TextField label="Systolic (mmHg)" name="systolic" type="number" min={40} max={300} />
            <TextField label="Diastolic (mmHg)" name="diastolic" type="number" min={20} max={200} />
            <TextField label="Heart rate (bpm)" name="heartRate" type="number" min={20} max={300} />
            <TextField
              label="Temperature (°C)"
              name="temperatureC"
              type="number"
              step="0.1"
              min={25}
              max={45}
            />
            <TextField
              label="Respiratory rate"
              name="respiratoryRate"
              type="number"
              min={4}
              max={80}
            />
            <TextField label="SpO₂ (%)" name="oxygenSaturation" type="number" min={30} max={100} />
            <TextField
              label="Weight (kg)"
              name="weightKg"
              type="number"
              step="0.1"
              min={0.3}
              max={500}
            />
            <TextField
              label="Height (cm)"
              name="heightCm"
              type="number"
              step="0.1"
              min={20}
              max={260}
            />
          </div>
          <EncounterSelect encounters={encounters} />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
