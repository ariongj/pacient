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
import { LabOrdersPanel } from './LabOrdersPanel';
import { EncounterSelect, useChartMutation, useChartRole } from './shared';
import { useSection } from './useSection';
import { t } from '../../../i18n';
import { RecordHistory } from '../../history/RecordHistory';

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
    <div className="stack">
      <LabOrdersPanel patientId={patientId} encounters={encounters} />
      <Card
        title={t('Test results')}
        actions={
          isDoctor ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              {t('Add manual result')}
            </Button>
          ) : undefined
        }
      >
        <p className="muted">
          {t(
            'Follow-up is closed only when a result is acknowledged. Patients see a result in their portal after it has been acknowledged and released; preliminary results cannot be released.',
          )}
        </p>
        <ErrorAlert error={acknowledge.error ?? release.error} />
        <QueryView query={list}>
          {(items) =>
            items.length === 0 ? (
              <EmptyState title={t('No results')} />
            ) : (
              <Table caption={t('Test results')}>
                <thead>
                  <tr>
                    <th>{t('Test')}</th>
                    <th>{t('Value')}</th>
                    <th>{t('Reference')}</th>
                    <th>{t('Flag')}</th>
                    <th>{t('Status')}</th>
                    <th>{t('Collected')}</th>
                    <th>{t('Follow-up')}</th>
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
                          <div className="muted">
                            {t('Ordered by {name}', { name: r.orderedBy })}
                          </div>
                          {r.source === 'LIS' && (
                            <Badge tone="info">{t('From laboratory system')}</Badge>
                          )}
                          <div>
                            <RecordHistory
                              patientId={patientId}
                              table="lab_results"
                              resourceId={r.id}
                              label={r.testName}
                            />
                          </div>
                        </td>
                        <td>
                          {r.value} {r.unit ?? ''}
                          {r.previousValue != null && (
                            <div className="muted">
                              {t('Corrected · was')} <s>{r.previousValue}</s>
                            </div>
                          )}
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
                                {t('Reviewed {date}', { date: formatDateTime(r.acknowledgedAt) })}
                              </Badge>
                            ) : !isDoctor ? (
                              <Badge tone="warning">{t('Awaiting doctor review')}</Badge>
                            ) : (
                              <Button
                                size="sm"
                                loading={acknowledge.isPending && acknowledge.variables === r.id}
                                onClick={() => acknowledge.mutate(r.id)}
                              >
                                {t('Acknowledge')}
                              </Button>
                            )}
                            {r.releasedAt ? (
                              <Badge tone="info">{t('Released to patient')}</Badge>
                            ) : !isDoctor ? null : (
                              <Button
                                size="sm"
                                variant="secondary"
                                disabled={!canRelease}
                                loading={release.isPending && release.variables === r.id}
                                onClick={() => release.mutate(r.id)}
                                title={
                                  !r.acknowledgedAt
                                    ? t('Acknowledge the result first')
                                    : r.status === 'PRELIMINARY'
                                      ? t('Preliminary results cannot be released')
                                      : undefined
                                }
                              >
                                {t('Release to patient')}
                              </Button>
                            )}
                            {!r.releasedAt && !canRelease && (
                              <small className="muted">
                                {!r.acknowledgedAt
                                  ? t('Acknowledge before release')
                                  : t('Preliminary — not releasable')}
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
        <Dialog open={open} onClose={() => setOpen(false)} title={t('Add result')} wide>
          <form onSubmit={onSubmit}>
            <div className="form-grid">
              <TextField
                label={t('Test name')}
                name="testName"
                required
                minLength={2}
                maxLength={200}
              />
              <TextField label={t('Value')} name="value" required maxLength={100} />
              <TextField label={t('Unit')} name="unit" maxLength={40} />
              <TextField label={t('Reference range')} name="referenceRange" maxLength={100} />
              <SelectField
                label={t('Flag')}
                name="flag"
                options={enumOptions(['NORMAL', 'LOW', 'HIGH', 'CRITICAL'])}
              />
              <SelectField
                label={t('Status')}
                name="status"
                options={enumOptions(['FINAL', 'PRELIMINARY', 'CORRECTED'])}
              />
              <TextField
                label={t('Collected')}
                name="collectedAt"
                type="datetime-local"
                hint={t('Defaults to now')}
              />
            </div>
            <EncounterSelect encounters={encounters} />
            <ErrorAlert error={create.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={create.isPending}>
                {t('Add result')}
              </Button>
            </div>
          </form>
        </Dialog>
      </Card>
    </div>
  );
}
