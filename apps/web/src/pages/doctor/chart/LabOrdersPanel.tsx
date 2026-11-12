import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../api/client';
import type { Encounter, LabOrder, LabTest } from '../../../api/types';
import {
  Badge,
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
} from '../../../components/ui';
import { formatDateTime, humanize } from '../../../format';
import { EncounterSelect, useChartMutation, useChartRole } from './shared';
import { useSection } from './useSection';
import { t } from '../../../i18n';

const STEPS: LabOrder['status'][] = ['ORDERED', 'RECEIVED', 'IN_PROGRESS', 'RESULTED'];

/** Where an order is in its journey to and from the laboratory. */
function OrderProgress({ order }: { order: LabOrder }) {
  if (order.status === 'CANCELLED') return <StatusBadge value="CANCELLED" />;
  const at = STEPS.indexOf(order.status);
  return (
    <ol
      className="lab-progress"
      aria-label={t('Order status: {status}', { status: humanize(order.status) })}
    >
      {STEPS.map((s, i) => (
        <li
          key={s}
          className={i <= at ? 'done' : undefined}
          aria-current={i === at ? 'step' : undefined}
        >
          {s === 'IN_PROGRESS' ? t('In lab') : humanize(s)}
        </li>
      ))}
    </ol>
  );
}

/**
 * Electronic laboratory orders. Orders go to the facility's connected laboratory system, which
 * reports results back automatically; they appear in "Test results" below for review.
 */
export function LabOrdersPanel({
  patientId,
  encounters,
}: {
  patientId: string;
  encounters: Encounter[];
}) {
  const { isDoctor } = useChartRole();
  const orders = useSection<LabOrder>(patientId, 'lab-orders');
  const catalog = useQuery({
    queryKey: ['lab-catalog'],
    queryFn: () => api<{ items: LabTest[] }>('/lab-catalog').then((r) => r.items),
    staleTime: 60 * 60_000,
    enabled: isDoctor,
  });
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const create = useChartMutation(
    patientId,
    (body: Record<string, unknown>) => ({ path: '/lab-orders', method: 'POST', body }),
    () => {
      setOpen(false);
      setSelected('');
    },
  );
  const cancel = useChartMutation(patientId, (id: string) => ({
    path: `/lab-orders/${id}/cancel`,
    method: 'POST',
  }));
  // Whoever draws the sample on the ward records it, so the laboratory expects it.
  const qc = useQueryClient();
  const collect = useMutation({
    mutationFn: (id: string) => api(`/lab-work/orders/${id}/collect`, { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    create.mutate(compact(formValues(e.currentTarget)));
  }

  const test = catalog.data?.find((lt) => lt.code === selected);
  const active = (orders.data ?? []).filter(
    (o) => o.status !== 'RESULTED' && o.status !== 'CANCELLED',
  );

  return (
    <Card
      title={
        <>
          {t('Laboratory orders')}{' '}
          {active.length > 0 && (
            <Badge tone="info">{t('{count} pending', { count: active.length })}</Badge>
          )}
        </>
      }
      actions={
        isDoctor ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            {t('Order test')}
          </Button>
        ) : undefined
      }
    >
      <ErrorAlert error={cancel.error} />
      <ErrorAlert error={collect.error} />
      <QueryView query={orders}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title={t('No laboratory orders')}>
              {t(
                'Orders are sent to the connected laboratory and results come back here automatically.',
              )}
            </EmptyState>
          ) : (
            <Table caption={t('Laboratory orders')}>
              <thead>
                <tr>
                  <th>{t('Test')}</th>
                  <th>{t('Priority')}</th>
                  <th>{t('Progress')}</th>
                  <th>{t('Ordered')}</th>
                  <th>
                    <span className="sr-only">{t('Actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.testName}</strong>
                      <div className="muted">
                        LOINC {o.testCode} · {o.specimen ?? t('specimen n/a')} ·{' '}
                        <span className="mono">{o.placerOrderNumber}</span>
                      </div>
                      {o.clinicalNotes && <div className="muted">“{o.clinicalNotes}”</div>}
                    </td>
                    <td>
                      <StatusBadge value={o.priority} />
                    </td>
                    <td>
                      <OrderProgress order={o} />
                      {o.fillerOrderNumber && (
                        <div className="muted">
                          {t('Lab ref. {ref}', { ref: o.fillerOrderNumber })}
                        </div>
                      )}
                    </td>
                    <td>
                      {formatDateTime(o.createdAt)}
                      <div className="muted">{o.orderedBy}</div>
                    </td>
                    <td>
                      {o.status === 'ORDERED' &&
                        (o.specimenCollectedAt ? (
                          <div className="muted">
                            {t('Specimen taken {time}', {
                              time: formatDateTime(o.specimenCollectedAt),
                            })}
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            loading={collect.isPending && collect.variables === o.id}
                            onClick={() => collect.mutate(o.id)}
                            aria-label={t('Specimen taken for {test}', { test: o.testName })}
                          >
                            {t('Specimen taken')}
                          </Button>
                        ))}{' '}
                      {isDoctor && (o.status === 'ORDERED' || o.status === 'RECEIVED') && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={cancel.isPending && cancel.variables === o.id}
                          onClick={() => {
                            if (window.confirm(t('Cancel the {test} order?', { test: o.testName })))
                              cancel.mutate(o.id);
                          }}
                        >
                          {t('Cancel')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )
        }
      </QueryView>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('Order laboratory test')} wide>
        <form onSubmit={onSubmit}>
          <div className="form-grid">
            <SelectField
              label={t('Test')}
              name="testCode"
              required
              placeholder={catalog.isLoading ? t('Loading tests…') : t('Choose a test')}
              value={selected}
              onChange={(e) => setSelected(e.currentTarget.value)}
              options={(catalog.data ?? []).map((lt) => ({
                value: lt.code,
                label: `${lt.name} (${lt.code})`,
              }))}
            />
            <SelectField
              label={t('Priority')}
              name="priority"
              required
              defaultValue="ROUTINE"
              options={[
                { value: 'ROUTINE', label: t('Routine') },
                { value: 'URGENT', label: t('Urgent') },
                { value: 'STAT', label: t('STAT (immediately)') },
              ]}
            />
          </div>
          {test && (
            <p className="muted">
              {t('Specimen: {specimen} · Reference range: {range} {unit}', {
                specimen: test.specimen,
                range: test.referenceRange,
                unit: test.unit,
              })}
            </p>
          )}
          <TextAreaField
            label={t('Clinical information for the laboratory')}
            name="clinicalNotes"
            maxLength={1000}
            rows={3}
            hint={t('Relevant symptoms or medication, e.g. “on diuretics”.')}
          />
          <EncounterSelect encounters={encounters} />
          <ErrorAlert error={create.error ?? catalog.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {t('Send order')}
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
