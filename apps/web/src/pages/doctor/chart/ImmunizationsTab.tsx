import { useState, type FormEvent } from 'react';
import type { Encounter, Immunization } from '../../../api/types';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  formValues,
  QueryView,
  Table,
  TextAreaField,
  TextField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { EncounterSelect, useChartMutation } from './shared';
import { useSection } from './useSection';

/** Local "now" for a datetime-local input's max attribute. */
function localNow() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function ImmunizationsTab({
  patientId,
  encounters,
}: {
  patientId: string;
  encounters: Encounter[];
}) {
  const list = useSection<Immunization>(patientId, 'immunizations');
  const [open, setOpen] = useState(false);
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/immunizations', method: 'POST', body }),
    () => setOpen(false),
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate({
      vaccine: v.vaccine,
      ...(v.doseNumber ? { doseNumber: Number(v.doseNumber) } : {}),
      ...(v.lotNumber ? { lotNumber: v.lotNumber } : {}),
      ...(v.site ? { site: v.site } : {}),
      ...(v.administeredAt ? { administeredAt: new Date(v.administeredAt).toISOString() } : {}),
      ...(v.notes ? { notes: v.notes } : {}),
      ...(v.encounterId ? { encounterId: v.encounterId } : {}),
    });
  }

  return (
    <Card
      title="Vaccinations"
      actions={
        <Button size="sm" onClick={() => setOpen(true)}>
          Record vaccination
        </Button>
      }
    >
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title="No vaccinations recorded" />
          ) : (
            <Table caption="Vaccinations">
              <thead>
                <tr>
                  <th>Vaccine</th>
                  <th className="num">Dose</th>
                  <th>Lot</th>
                  <th>Site</th>
                  <th>Given</th>
                  <th>By / where</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>
                      <strong>{i.vaccine}</strong>
                      {i.notes && <div className="muted">{i.notes}</div>}
                    </td>
                    <td className="num">{i.doseNumber ?? '—'}</td>
                    <td>{i.lotNumber ?? '—'}</td>
                    <td>{i.site ?? '—'}</td>
                    <td>{formatDateTime(i.administeredAt)}</td>
                    <td>
                      {i.administeredBy}
                      <div className="muted">{i.facilityName}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title="Record vaccination" wide>
        <form onSubmit={onSubmit}>
          <div className="form-grid">
            <TextField label="Vaccine" name="vaccine" required minLength={2} maxLength={200} />
            <TextField label="Dose number" name="doseNumber" type="number" min={1} max={20} />
            <TextField label="Lot number" name="lotNumber" maxLength={60} />
            <TextField label="Site" name="site" maxLength={60} hint="e.g. Left deltoid" />
            <TextField
              label="Given at"
              name="administeredAt"
              type="datetime-local"
              max={localNow()}
              hint="Leave empty for now"
            />
          </div>
          <TextAreaField label="Notes" name="notes" maxLength={2000} rows={2} />
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
