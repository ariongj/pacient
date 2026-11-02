import { useState, type FormEvent } from 'react';
import type { Encounter, LabResult } from '../../../api/types';
import {
  Badge,
  Button,
  Card,
  compact,
  Dialog,
  EmptyState,
  enumOptions,
  ErrorAlert,
  formValues,
  QueryView,
  SelectField,
  StatusBadge,
  Table,
  TextField,
} from '../../../components/ui';
import { formatDateTime } from '../../../format';
import { EncounterSelect, useChartMutation, useChartRole } from './shared';
import { useSection } from './useSection';

export function ResultsTab({
  patientId,
  encounters,
}: {
  patientId: string;
  encounters: Encounter[];
}) {
  const list = useSection<LabResult>(patientId, 'lab-results');
  const [open, setOpen] = useState(false);
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/lab-results', method: 'POST', body }),
    () => setOpen(false),
  );
  const acknowledge = useChartMutation(patientId, (id: string) => ({
    path: `/lab-results/${id}/acknowledge`,
    method: 'POST',
  }));
  const release = useChartMutation(patientId, (id: string) => ({
    path: `/lab-results/${id}/release`,
    method: 'POST',
  }));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate(
      compact({
        ...v,
        collectedAt: v.collectedAt ? new Date(v.collectedAt).toISOString() : undefined,
      }),
    );
  }

  const { isDoctor } = useChartRole();

  return (
    <Card
      title="Test results"
      actions={
        isDoctor ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Add result
          </Button>
        ) : undefined
      }
    >
      <p className="muted">
        Follow-up is closed only when a result is acknowledged. Patients see a result in their
        portal after it has been acknowledged and released; preliminary results cannot be released.
      </p>
      <ErrorAlert error={acknowledge.error ?? release.error} />
      <QueryView query={list}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title="No results" />
          ) : (
            <Table caption="Test results">
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Value</th>
                  <th>Reference</th>
                  <th>Flag</th>
                  <th>Status</th>
                  <th>Collected</th>
                  <th>Follow-up</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => {
                  const canRelease =
                    Boolean(r.acknowledgedAt) && !r.releasedAt && r.status !== 'PRELIMINARY';
                  return (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.testName}</strong>
                        <div className="muted">Ordered by {r.orderedBy}</div>
                      </td>
                      <td>
                        {r.value} {r.unit ?? ''}
                      </td>
                      <td>{r.referenceRange ?? '—'}</td>
                      <td>
                        <StatusBadge value={r.flag} />
                      </td>
                      <td>
                        <StatusBadge value={r.status} />
                      </td>
                      <td>{formatDateTime(r.collectedAt)}</td>
                      <td>
                        <div className="stack" style={{ gap: '0.35rem' }}>
                          {r.acknowledgedAt ? (
                            <Badge tone="success">
                              Reviewed {formatDateTime(r.acknowledgedAt)}
                            </Badge>
                          ) : !isDoctor ? (
                            <Badge tone="warning">Awaiting doctor review</Badge>
                          ) : (
                            <Button
                              size="sm"
                              loading={acknowledge.isPending && acknowledge.variables === r.id}
                              onClick={() => acknowledge.mutate(r.id)}
                            >
                              Acknowledge
                            </Button>
                          )}
                          {r.releasedAt ? (
                            <Badge tone="info">Released to patient</Badge>
                          ) : !isDoctor ? null : (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={!canRelease}
                              loading={release.isPending && release.variables === r.id}
                              onClick={() => release.mutate(r.id)}
                              title={
                                !r.acknowledgedAt
                                  ? 'Acknowledge the result first'
                                  : r.status === 'PRELIMINARY'
                                    ? 'Preliminary results cannot be released'
                                    : undefined
                              }
                            >
                              Release to patient
                            </Button>
                          )}
                          {!r.releasedAt && !canRelease && (
                            <small className="muted">
                              {!r.acknowledgedAt
                                ? 'Acknowledge before release'
                                : 'Preliminary — not releasable'}
                            </small>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add result" wide>
        <form onSubmit={onSubmit}>
          <div className="form-grid">
            <TextField label="Test name" name="testName" required minLength={2} maxLength={200} />
            <TextField label="Value" name="value" required maxLength={100} />
            <TextField label="Unit" name="unit" maxLength={40} />
            <TextField label="Reference range" name="referenceRange" maxLength={100} />
            <SelectField
              label="Flag"
              name="flag"
              options={enumOptions(['NORMAL', 'LOW', 'HIGH', 'CRITICAL'])}
            />
            <SelectField
              label="Status"
              name="status"
              options={enumOptions(['FINAL', 'PRELIMINARY', 'CORRECTED'])}
            />
            <TextField
              label="Collected"
              name="collectedAt"
              type="datetime-local"
              hint="Defaults to now"
            />
          </div>
          <EncounterSelect encounters={encounters} />
          <ErrorAlert error={create.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Add result
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
