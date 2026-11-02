import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import type {
  PharmacyContext,
  PharmacyItem,
  PharmacyQueue as Queue,
  PharmacyStatus,
  SafetyAlert,
} from '../../api/types';
import { AnnouncementsCard } from '../../components/Announcements';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Loading,
  PageHeader,
  QueryView,
  Stat,
  StatusBadge,
  TabPanel,
  Table,
  Tabs,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { age, formatDate, formatDateTime, humanize } from '../../format';

const STATUSES: PharmacyStatus[] = ['PENDING', 'VERIFIED', 'RETURNED', 'DISPENSED'];
const TAB_LABEL: Record<PharmacyStatus, string> = {
  PENDING: 'Awaiting verification',
  VERIFIED: 'Ready to dispense',
  RETURNED: 'Returned',
  DISPENSED: 'Dispensed',
};

function waiting(since: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h} h ${mins % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

function AlertBadges({ alerts }: { alerts?: SafetyAlert[] }) {
  if (!alerts?.length) return null;
  return (
    <span className="row">
      {alerts.map((a, i) => (
        <Badge key={i} tone={a.severity === 'HIGH' ? 'danger' : 'warning'}>
          {a.kind === 'ALLERGY'
            ? 'Allergy'
            : a.kind === 'CROSS_REACTIVITY'
              ? 'Cross-reactivity'
              : 'Duplicate therapy'}
        </Badge>
      ))}
    </span>
  );
}

const ASSESSMENT_TEXT: Record<string, string> = {
  NO_KNOWN_ALLERGIES: 'No known allergies (assessed by a clinician)',
  NOT_RECORDED: 'Allergies not recorded – confirm with the patient before dispensing',
  UNKNOWN: 'Allergy status unknown',
  ALLERGIES_RECORDED: '',
};

type Action = 'verify' | 'return' | 'dispense' | null;

function ActionDialog({
  action,
  item,
  alerts,
  onClose,
}: {
  action: Action;
  item: PharmacyItem;
  alerts: SafetyAlert[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reviewed, setReviewed] = useState(false);
  const mutation = useMutation({
    mutationFn: (body: object) =>
      api(`/pharmacy/prescriptions/${item.id}/${action}`, { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pharmacy'] });
      onClose();
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const note = String(f.get('note') ?? '').trim();
    if (action === 'verify') {
      mutation.mutate({ alertsReviewed: reviewed, note: note || null });
    } else if (action === 'return') {
      mutation.mutate({ note });
    } else {
      mutation.mutate({ quantity: String(f.get('quantity') ?? '').trim(), note: note || null });
    }
  }

  const title =
    action === 'verify'
      ? 'Verify prescription'
      : action === 'return'
        ? 'Return to prescriber'
        : 'Dispense medication';
  const hasAlerts = alerts.length > 0;

  return (
    <Dialog open={action !== null} onClose={onClose} title={title}>
      <form onSubmit={onSubmit}>
        <p>
          <strong>{item.medication}</strong> {item.dosage}, {item.frequency} — {item.patientName}
        </p>
        {action === 'verify' && hasAlerts && (
          <>
            <Alert tone="danger" title="Safety alerts must be reviewed">
              <ul className="alert-list">
                {alerts.map((a, i) => (
                  <li key={i}>{a.message}</li>
                ))}
              </ul>
            </Alert>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
                required
              />
              I have reviewed the alerts and it is safe to proceed
            </label>
          </>
        )}
        {action === 'dispense' && (
          <TextField
            label="Quantity dispensed"
            name="quantity"
            required
            maxLength={100}
            placeholder="e.g. 28 tablets"
          />
        )}
        <TextAreaField
          label={
            action === 'return'
              ? 'Reason for returning'
              : action === 'verify' && hasAlerts
                ? 'Clinical justification'
                : 'Note (optional)'
          }
          name="note"
          required={action === 'return' || (action === 'verify' && hasAlerts)}
          minLength={action === 'return' || (action === 'verify' && hasAlerts) ? 5 : undefined}
          maxLength={2000}
          hint={
            action === 'return'
              ? 'The prescriber is notified and sees this note.'
              : action === 'verify' && hasAlerts
                ? 'Explain why it is safe to proceed (at least 5 characters).'
                : undefined
          }
        />
        <ErrorAlert error={mutation.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={action === 'return' ? 'danger' : 'primary'}
            loading={mutation.isPending}
            disabled={action === 'verify' && hasAlerts && !reviewed}
          >
            {action === 'verify' ? 'Verify' : action === 'return' ? 'Return' : 'Dispense'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Detail({ id }: { id: string }) {
  const [action, setAction] = useState<Action>(null);
  const q = useQuery({
    queryKey: ['pharmacy', 'rx', id],
    queryFn: () => api<PharmacyContext>(`/pharmacy/prescriptions/${id}`),
  });
  if (q.isPending) return <Loading />;
  if (q.error) return <ErrorAlert error={q.error} />;
  const c = q.data;
  const rx = c.prescription;
  return (
    <div className="stack">
      <Card
        title={
          <span>
            {rx.medication} <StatusBadge value={rx.pharmacyStatus} />
          </span>
        }
        actions={
          <div className="row">
            {rx.pharmacyStatus === 'PENDING' && (
              <Button onClick={() => setAction('verify')}>Verify</Button>
            )}
            {rx.pharmacyStatus === 'VERIFIED' && (
              <Button onClick={() => setAction('dispense')}>Dispense</Button>
            )}
            {(rx.pharmacyStatus === 'PENDING' || rx.pharmacyStatus === 'VERIFIED') && (
              <Button variant="secondary" onClick={() => setAction('return')}>
                Return to prescriber
              </Button>
            )}
          </div>
        }
      >
        <dl className="dl">
          <div>
            <dt>Patient</dt>
            <dd>
              {rx.patientName} · {age(rx.patientDateOfBirth)} y · {humanize(rx.patientSex)}
            </dd>
          </div>
          <div>
            <dt>Dose</dt>
            <dd>
              {rx.dosage}, {rx.frequency} ({rx.route})
            </dd>
          </div>
          <div>
            <dt>Period</dt>
            <dd>
              {formatDate(rx.startDate)} – {rx.endDate ? formatDate(rx.endDate) : 'ongoing'}
            </dd>
          </div>
          <div>
            <dt>Prescriber</dt>
            <dd>{rx.prescriberName}</dd>
          </div>
          <div>
            <dt>Prescribed</dt>
            <dd>
              {formatDateTime(rx.createdAt)} ({waiting(rx.createdAt)} ago)
            </dd>
          </div>
          <div>
            <dt>Latest weight</dt>
            <dd>
              {c.latestWeight
                ? `${c.latestWeight.weightKg} kg (${formatDate(c.latestWeight.recordedAt)})`
                : 'Not recorded'}
            </dd>
          </div>
        </dl>
        {rx.instructions && <p style={{ marginTop: '0.75rem' }}>Instructions: {rx.instructions}</p>}
        {rx.pharmacistNote && (
          <div className="addendum">
            <strong>Pharmacist note:</strong> {rx.pharmacistNote}
          </div>
        )}
        {rx.dispensedQuantity && (
          <p className="muted">
            Dispensed {rx.dispensedQuantity} on {formatDateTime(rx.dispensedAt)}
          </p>
        )}
      </Card>

      <Card title="Safety checks">
        <p className="muted">
          Decision support – does not replace professional judgement or a full interaction database.
        </p>
        {c.alerts.length ? (
          <ul className="alert-list">
            {c.alerts.map((a, i) => (
              <li key={i}>
                <Alert tone={a.severity === 'HIGH' ? 'danger' : 'warning'} title={humanize(a.kind)}>
                  {a.message}
                </Alert>
              </li>
            ))}
          </ul>
        ) : (
          <Alert tone="success" title="No alerts found by the automated checks" />
        )}
      </Card>

      <div className="two-col">
        <div className="stack">
          <Card title="Allergies">
            {c.allergies.length ? (
              <ul className="list">
                {c.allergies.map((a, i) => (
                  <li key={i} className="row-between">
                    <span>
                      <strong>{a.substance}</strong>
                      {a.reaction && <span className="muted"> – {a.reaction}</span>}
                    </span>
                    <span className="row">
                      <StatusBadge value={a.severity} />
                      <StatusBadge value={a.verificationStatus} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{ASSESSMENT_TEXT[c.allergyAssessment] || 'None recorded'}</p>
            )}
          </Card>
          <Card title="Other active medications">
            {c.otherActiveMedications.length ? (
              <ul className="list">
                {c.otherActiveMedications.map((m) => (
                  <li key={m.id} className="row-between">
                    <span>
                      <strong>{m.medication}</strong> {m.dosage}, {m.frequency}
                    </span>
                    <StatusBadge value={m.pharmacyStatus} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No other active medications" />
            )}
          </Card>
        </div>
        <div className="stack">
          <Card title="Active problems">
            {c.activeProblems.length ? (
              <ul className="list">
                {c.activeProblems.map((p) => (
                  <li key={p.icd10Code + p.description}>
                    <code>{p.icd10Code}</code> {p.description}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="None recorded" />
            )}
          </Card>
          <Card title="Renal function & electrolytes">
            {c.renalAndElectrolytes.length ? (
              <ul className="list">
                {c.renalAndElectrolytes.map((l, i) => (
                  <li key={i} className="row-between">
                    <span>
                      {l.testName}: <strong>{l.value}</strong> {l.unit}
                      <div className="muted">{formatDate(l.collectedAt)}</div>
                    </span>
                    <StatusBadge value={l.flag} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No recent results" />
            )}
          </Card>
        </div>
      </div>

      <ActionDialog
        key={`${rx.id}-${action}`}
        action={action}
        item={rx}
        alerts={c.alerts}
        onClose={() => setAction(null)}
      />
    </div>
  );
}

export function PharmacyQueue() {
  const [params, setParams] = useSearchParams();
  const status = (STATUSES as string[]).includes(params.get('status') ?? '')
    ? (params.get('status') as PharmacyStatus)
    : 'PENDING';
  const selected = params.get('rx');
  const q = useQuery({
    queryKey: ['pharmacy', 'queue', status],
    queryFn: () => api<Queue>('/pharmacy/queue', { query: { status } }),
  });
  const counts = q.data?.counts ?? {};

  const select = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Pharmacy verification queue"
        subtitle="Verify, dispense or return prescriptions written at your facility."
      />
      <Alert tone="info">
        You see only the medication context needed to check each prescription — not the full record.
        Every context view is logged and visible to the patient.
      </Alert>
      <div className="stack">
        <div className="kpi-grid">
          <Stat
            label="Awaiting verification"
            value={counts.PENDING ?? 0}
            tone={(counts.PENDING ?? 0) > 0 ? 'warning' : undefined}
          />
          <Stat label="Ready to dispense" value={counts.VERIFIED ?? 0} tone="info" />
          <Stat
            label="Returned to prescriber"
            value={counts.RETURNED ?? 0}
            tone={(counts.RETURNED ?? 0) > 0 ? 'danger' : undefined}
          />
          <Stat label="Dispensed" value={counts.DISPENSED ?? 0} tone="success" />
        </div>

        <Card>
          <Tabs
            label="Queue status"
            active={status}
            onChange={(s) => select({ status: s, rx: null })}
            tabs={STATUSES.map((s) => ({ id: s, label: TAB_LABEL[s], count: counts[s] ?? 0 }))}
          />
          <TabPanel id={status}>
            <QueryView query={q}>
              {(d) =>
                d.items.length === 0 ? (
                  <EmptyState title="Nothing in this queue" />
                ) : (
                  <div className="split">
                    <Table caption={TAB_LABEL[status]}>
                      <thead>
                        <tr>
                          <th>Prescription</th>
                          <th>Waiting</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.items.map((it) => (
                          <tr
                            key={it.id}
                            aria-current={selected === it.id ? 'true' : undefined}
                            style={
                              selected === it.id ? { background: 'var(--primary-soft)' } : undefined
                            }
                          >
                            <td>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                style={{ padding: 0, minHeight: 0, textAlign: 'left' }}
                                onClick={() => select({ rx: it.id })}
                              >
                                {it.patientName}
                              </button>
                              <div className="muted">
                                {age(it.patientDateOfBirth)} y · {humanize(it.patientSex)}
                              </div>
                              <div>
                                <strong>{it.medication}</strong> {it.dosage}
                              </div>
                              <div className="muted">{it.prescriberName}</div>
                              <AlertBadges alerts={it.alerts} />
                            </td>
                            <td className="num">{waiting(it.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                    <div>
                      {selected && d.items.some((i) => i.id === selected) ? (
                        <Detail id={selected} />
                      ) : (
                        <Card>
                          <EmptyState title="Select a prescription">
                            Choose an item on the left to see its medication context.
                          </EmptyState>
                        </Card>
                      )}
                    </div>
                  </div>
                )
              }
            </QueryView>
          </TabPanel>
        </Card>
        <AnnouncementsCard />
      </div>
    </>
  );
}
