import { useState, type FormEvent } from 'react';
import type {
  AdministrationStatus,
  MedicationAdministration,
  Prescription,
} from '../../../api/types';
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
  SelectField,
  StatusBadge,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { useChartMutation } from './shared';
import { useSection } from './useSection';

const STATUS_OPTIONS: { value: AdministrationStatus; label: string }[] = [
  { value: 'GIVEN', label: 'Given' },
  { value: 'WITHHELD', label: 'Withheld (clinical decision)' },
  { value: 'REFUSED', label: 'Refused by patient' },
  { value: 'OMITTED', label: 'Omitted (missed / unavailable)' },
];

/**
 * Medication administration record. Every dose – given or not – is recorded explicitly with its
 * author; administration is never assumed from a prescription or a dispense.
 */
export function MarTab({ patientId }: { patientId: string }) {
  const rx = useSection<Prescription>(patientId, 'prescriptions');
  const mar = useSection<MedicationAdministration>(patientId, 'medication-administrations');
  const [recording, setRecording] = useState<Prescription | null>(null);
  const [status, setStatus] = useState<AdministrationStatus>('GIVEN');
  const record = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({
      path: '/medication-administrations',
      method: 'POST',
      body,
    }),
    () => setRecording(null),
  );

  const administrable = (rx.data ?? []).filter(
    (p) =>
      p.status === 'ACTIVE' &&
      (p.pharmacyStatus === 'VERIFIED' || p.pharmacyStatus === 'DISPENSED'),
  );
  const awaiting = (rx.data ?? []).filter(
    (p) =>
      p.status === 'ACTIVE' && (p.pharmacyStatus === 'PENDING' || p.pharmacyStatus === 'RETURNED'),
  );

  function open(p: Prescription) {
    setStatus('GIVEN');
    setRecording(p);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = compact(formValues(e.currentTarget));
    record.mutate({
      ...v,
      prescriptionId: recording!.id,
      administeredAt: v.administeredAt ? new Date(v.administeredAt).toISOString() : undefined,
    });
  }

  return (
    <div className="stack">
      <Card title="Active medicines">
        <p className="muted">
          Only prescriptions verified by the pharmacy can be administered. Record every dose
          explicitly – including doses withheld, refused or omitted, with the reason.
        </p>
        <QueryView query={rx}>
          {() =>
            administrable.length === 0 ? (
              <EmptyState title="No pharmacy-verified medicines to administer" />
            ) : (
              <ul className="list">
                {administrable.map((p) => (
                  <li key={p.id} className="row-between">
                    <span>
                      <strong>{p.medication}</strong> {p.dosage} · {p.frequency}{' '}
                      <span className="muted">({p.route})</span>
                      {p.instructions && <div className="muted">{p.instructions}</div>}
                    </span>
                    <span className="row">
                      <StatusBadge value={p.pharmacyStatus} />
                      <Button size="sm" onClick={() => open(p)}>
                        Record dose
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryView>
        {awaiting.length > 0 && (
          <Alert tone="warning" title="Awaiting pharmacy">
            {awaiting.map((p) => `${p.medication} (${p.pharmacyStatus.toLowerCase()})`).join(', ')}{' '}
            cannot be administered until verified.
          </Alert>
        )}
      </Card>

      <Card title="Administration record">
        <QueryView query={mar}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState title="No doses recorded" />
            ) : (
              <Table caption="Medication administration record">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Medicine</th>
                    <th>Outcome</th>
                    <th>Dose / reason</th>
                    <th>Recorded by</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((a) => (
                    <tr key={a.id}>
                      <td>{formatDateTime(a.administeredAt)}</td>
                      <td>
                        {a.medication}
                        <div className="muted">Prescribed: {a.dosage}</div>
                      </td>
                      <td>
                        <StatusBadge value={a.status} />
                      </td>
                      <td>
                        {a.doseGiven && <div>{a.doseGiven}</div>}
                        {a.reason && <div>{a.reason}</div>}
                        {a.notes && <div className="muted">{a.notes}</div>}
                      </td>
                      <td>{a.recordedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryView>
      </Card>

      <Dialog open={recording !== null} onClose={() => setRecording(null)} title="Record dose">
        {recording && (
          <form onSubmit={onSubmit}>
            <p>
              <strong>{recording.medication}</strong> — {recording.dosage}, {recording.frequency}
            </p>
            <SelectField
              label="Outcome"
              name="status"
              value={status}
              onChange={(e) => setStatus(e.target.value as AdministrationStatus)}
              options={STATUS_OPTIONS}
            />
            <div className="form-grid">
              <TextField
                label="Dose given"
                name="doseGiven"
                defaultValue={status === 'GIVEN' ? recording.dosage : ''}
                maxLength={100}
                disabled={status !== 'GIVEN'}
              />
              <TextField
                label="Time"
                name="administeredAt"
                type="datetime-local"
                hint="Leave empty for now"
              />
            </div>
            {status !== 'GIVEN' && (
              <TextAreaField
                label="Reason"
                name="reason"
                required
                minLength={3}
                maxLength={500}
                rows={2}
                hint="Required when a dose is not given, e.g. “BP 92/60 – doctor informed”."
              />
            )}
            <TextAreaField label="Notes" name="notes" maxLength={2000} rows={2} />
            <ErrorAlert error={record.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setRecording(null)}>
                Cancel
              </Button>
              <Button type="submit" loading={record.isPending}>
                Save to record
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </div>
  );
}
