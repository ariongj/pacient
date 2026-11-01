import { useState, type FormEvent } from 'react';
import type { Allergy, Encounter, Prescription } from '../../../api/types';
import {
  Alert,
  Button,
  Card,
  compact,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  QueryView,
  StatusBadge,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDate } from '../../../format';
import { EncounterSelect, useChartMutation } from './shared';
import { useSection } from './useSection';

export function MedicationsTab({
  patientId,
  encounters,
  allergies,
}: {
  patientId: string;
  encounters: Encounter[];
  allergies: Allergy[];
}) {
  const list = useSection<Prescription>(patientId, 'prescriptions');
  const [open, setOpen] = useState(false);
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/prescriptions', method: 'POST', body }),
    () => setOpen(false),
  );
  const update = useChartMutation(patientId, ({ id, status }: { id: string; status: string }) => ({
    path: `/prescriptions/${id}`,
    method: 'PATCH',
    body: { status },
  }));
  const activeAllergies = allergies.filter(
    (a) => a.verificationStatus === 'CONFIRMED' || a.verificationStatus === 'UNCONFIRMED',
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    create.mutate(compact(formValues(e.currentTarget)));
  }

  return (
    <Card
      title="Medications"
      actions={
        <Button size="sm" onClick={() => setOpen(true)}>
          Prescribe
        </Button>
      }
    >
      <ErrorAlert error={update.error} />
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title="No prescriptions" />
          ) : (
            <Table caption="Prescriptions">
              <thead>
                <tr>
                  <th>Medication</th>
                  <th>Dose & frequency</th>
                  <th>Period</th>
                  <th>Prescriber</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <strong>{p.medication}</strong>
                      <div className="muted">{p.route}</div>
                      {p.instructions && <div className="muted">{p.instructions}</div>}
                    </td>
                    <td>
                      {p.dosage} · {p.frequency}
                    </td>
                    <td>
                      {formatDate(p.startDate)} – {p.endDate ? formatDate(p.endDate) : 'ongoing'}
                    </td>
                    <td>{p.doctorName}</td>
                    <td>
                      <StatusBadge value={p.status} />
                    </td>
                    <td>
                      {p.status === 'ACTIVE' && (
                        <div className="row">
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={update.isPending}
                            onClick={() => update.mutate({ id: p.id, status: 'COMPLETED' })}
                          >
                            Complete
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={update.isPending}
                            onClick={() => update.mutate({ id: p.id, status: 'CANCELLED' })}
                          >
                            Stop
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title="New prescription" wide>
        <form onSubmit={onSubmit}>
          {activeAllergies.length > 0 && (
            <Alert tone="danger" title="Recorded allergies">
              {activeAllergies
                .map((a) => `${a.substance} (${a.severity.toLowerCase().replace('_', ' ')})`)
                .join(', ')}
            </Alert>
          )}
          <div className="form-grid">
            <TextField
              label="Medication"
              name="medication"
              required
              minLength={2}
              maxLength={200}
            />
            <TextField label="Dosage" name="dosage" required maxLength={100} hint="e.g. 5 mg" />
            <TextField
              label="Frequency"
              name="frequency"
              required
              maxLength={100}
              hint="e.g. once daily"
            />
            <TextField label="Route" name="route" defaultValue="oral" maxLength={50} />
            <TextField
              label="Start date"
              name="startDate"
              type="date"
              required
              defaultValue={new Date().toISOString().slice(0, 10)}
            />
            <TextField label="End date" name="endDate" type="date" />
          </div>
          <EncounterSelect encounters={encounters} />
          <TextAreaField
            label="Instructions for the patient"
            name="instructions"
            maxLength={2000}
            rows={3}
          />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Prescribe
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
