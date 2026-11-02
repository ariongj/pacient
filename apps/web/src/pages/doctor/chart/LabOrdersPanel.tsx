import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { formatDateTime } from '../../../format';
import { EncounterSelect, useChartMutation, useChartRole } from './shared';
import { useSection } from './useSection';

const STEPS: LabOrder['status'][] = ['ORDERED', 'RECEIVED', 'IN_PROGRESS', 'RESULTED'];

/** Where an order is in its journey to and from the laboratory. */
function OrderProgress({ order }: { order: LabOrder }) {
  if (order.status === 'CANCELLED') return <StatusBadge value="CANCELLED" />;
  const at = STEPS.indexOf(order.status);
  return (
    <ol className="lab-progress" aria-label={`Order status: ${order.status.toLowerCase()}`}>
      {STEPS.map((s, i) => (
        <li
          key={s}
          className={i <= at ? 'done' : undefined}
          aria-current={i === at ? 'step' : undefined}
        >
          {s === 'IN_PROGRESS' ? 'In lab' : s.charAt(0) + s.slice(1).toLowerCase()}
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

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    create.mutate(compact(formValues(e.currentTarget)));
  }

  const test = catalog.data?.find((t) => t.code === selected);
  const active = (orders.data ?? []).filter(
    (o) => o.status !== 'RESULTED' && o.status !== 'CANCELLED',
  );

  return (
    <Card
      title={
        <>
          Laboratory orders{' '}
          {active.length > 0 && <Badge tone="info">{active.length} pending</Badge>}
        </>
      }
      actions={
        isDoctor ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            Order test
          </Button>
        ) : undefined
      }
    >
      <ErrorAlert error={cancel.error} />
      <QueryView query={orders}>
        {(items) =>
          items.length === 0 ? (
            <EmptyState title="No laboratory orders">
              Orders are sent to the connected laboratory and results come back here automatically.
            </EmptyState>
          ) : (
            <Table caption="Laboratory orders">
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Priority</th>
                  <th>Progress</th>
                  <th>Ordered</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((o) => (
                  <tr key={o.id}>
                    <td>
                      <strong>{o.testName}</strong>
                      <div className="muted">
                        LOINC {o.testCode} · {o.specimen ?? 'specimen n/a'} ·{' '}
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
                        <div className="muted">Lab ref. {o.fillerOrderNumber}</div>
                      )}
                    </td>
                    <td>
                      {formatDateTime(o.createdAt)}
                      <div className="muted">{o.orderedBy}</div>
                    </td>
                    <td>
                      {isDoctor && (o.status === 'ORDERED' || o.status === 'RECEIVED') && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={cancel.isPending && cancel.variables === o.id}
                          onClick={() => {
                            if (window.confirm(`Cancel the ${o.testName} order?`))
                              cancel.mutate(o.id);
                          }}
                        >
                          Cancel
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
      <Dialog open={open} onClose={() => setOpen(false)} title="Order laboratory test" wide>
        <form onSubmit={onSubmit}>
          <div className="form-grid">
            <SelectField
              label="Test"
              name="testCode"
              required
              placeholder={catalog.isLoading ? 'Loading tests…' : 'Choose a test'}
              value={selected}
              onChange={(e) => setSelected(e.currentTarget.value)}
              options={(catalog.data ?? []).map((t) => ({
                value: t.code,
                label: `${t.name} (${t.code})`,
              }))}
            />
            <SelectField
              label="Priority"
              name="priority"
              required
              defaultValue="ROUTINE"
              options={[
                { value: 'ROUTINE', label: 'Routine' },
                { value: 'URGENT', label: 'Urgent' },
                { value: 'STAT', label: 'STAT (immediately)' },
              ]}
            />
          </div>
          {test && (
            <p className="muted">
              Specimen: {test.specimen} · Reference range: {test.referenceRange} {test.unit}
            </p>
          )}
          <TextAreaField
            label="Clinical information for the laboratory"
            name="clinicalNotes"
            maxLength={1000}
            rows={3}
            hint="Relevant symptoms or medication, e.g. “on diuretics”."
          />
          <EncounterSelect encounters={encounters} />
          <ErrorAlert error={create.error ?? catalog.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Send order
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
