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
} from '../../components/ui';
import { age, formatDate, formatDateTime, humanize } from '../../format';
import { t } from '../../i18n';
import { DispenseForm } from './DispenseForm';

const STATUSES: PharmacyStatus[] = ['PENDING', 'VERIFIED', 'RETURNED', 'DISPENSED'];
const TAB_LABEL: Record<PharmacyStatus, string> = {
  PENDING: 'Awaiting verification',
  VERIFIED: 'Ready to dispense',
  RETURNED: 'Returned',
  DISPENSED: 'Dispensed',
};
const tabLabel = (s: PharmacyStatus) => t(TAB_LABEL[s]);

function waiting(since: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 60_000));
  if (mins < 60) return t('{minutes} min', { minutes: mins });
  const h = Math.floor(mins / 60);
  if (h < 48) return t('{hours} h {minutes} min', { hours: h, minutes: mins % 60 });
  return t('{count} days', { count: Math.floor(h / 24) });
}

function AlertBadges({ alerts }: { alerts?: SafetyAlert[] }) {
  if (!alerts?.length) return null;
  return (
    <span className="row">
      {alerts.map((a, i) => (
        <Badge key={i} tone={a.severity === 'HIGH' ? 'danger' : 'warning'}>
          {a.kind === 'ALLERGY'
            ? t('Allergy')
            : a.kind === 'CROSS_REACTIVITY'
              ? t('Cross-reactivity')
              : t('Duplicate therapy')}
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
    }
  }

  const title =
    action === 'verify'
      ? t('Verify prescription')
      : action === 'return'
        ? t('Return to prescriber')
        : t('Dispense medication');
  const hasAlerts = alerts.length > 0;

  if (action === 'dispense') {
    return (
      <Dialog open onClose={onClose} title={title} wide>
        <DispenseForm item={item} onClose={onClose} />
      </Dialog>
    );
  }

  return (
    <Dialog open={action !== null} onClose={onClose} title={title}>
      <form onSubmit={onSubmit}>
        <p>
          <strong>{item.medication}</strong> {item.dosage}, {item.frequency} — {item.patientName}
        </p>
        {action === 'verify' && hasAlerts && (
          <>
            <Alert tone="danger" title={t('Safety alerts must be reviewed')}>
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
              {t('I have reviewed the alerts and it is safe to proceed')}
            </label>
          </>
        )}
        <TextAreaField
          label={
            action === 'return'
              ? t('Reason for returning')
              : action === 'verify' && hasAlerts
                ? t('Clinical justification')
                : t('Note (optional)')
          }
          name="note"
          required={action === 'return' || (action === 'verify' && hasAlerts)}
          minLength={action === 'return' || (action === 'verify' && hasAlerts) ? 5 : undefined}
          maxLength={2000}
          hint={
            action === 'return'
              ? t('The prescriber is notified and sees this note.')
              : action === 'verify' && hasAlerts
                ? t('Explain why it is safe to proceed (at least 5 characters).')
                : undefined
          }
        />
        <ErrorAlert error={mutation.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            type="submit"
            variant={action === 'return' ? 'danger' : 'primary'}
            loading={mutation.isPending}
            disabled={action === 'verify' && hasAlerts && !reviewed}
          >
            {action === 'verify' ? t('Verify') : action === 'return' ? t('Return') : t('Dispense')}
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
              <Button onClick={() => setAction('verify')}>{t('Verify')}</Button>
            )}
            {rx.pharmacyStatus === 'VERIFIED' && (
              <Button onClick={() => setAction('dispense')}>{t('Dispense')}</Button>
            )}
            {(rx.pharmacyStatus === 'PENDING' || rx.pharmacyStatus === 'VERIFIED') && (
              <Button variant="secondary" onClick={() => setAction('return')}>
                {t('Return to prescriber')}
              </Button>
            )}
          </div>
        }
      >
        <dl className="dl">
          <div>
            <dt>{t('Patient')}</dt>
            <dd>
              {rx.patientName} · {t('{age} y', { age: age(rx.patientDateOfBirth) })} ·{' '}
              {humanize(rx.patientSex)}
            </dd>
          </div>
          <div>
            <dt>{t('Dose')}</dt>
            <dd>
              {rx.dosage}, {rx.frequency} ({rx.route})
            </dd>
          </div>
          <div>
            <dt>{t('Period')}</dt>
            <dd>
              {formatDate(rx.startDate)} – {rx.endDate ? formatDate(rx.endDate) : t('ongoing')}
            </dd>
          </div>
          <div>
            <dt>{t('Prescriber')}</dt>
            <dd>{rx.prescriberName}</dd>
          </div>
          <div>
            <dt>{t('Prescribed')}</dt>
            <dd>
              {formatDateTime(rx.createdAt)} ({t('{time} ago', { time: waiting(rx.createdAt) })})
            </dd>
          </div>
          <div>
            <dt>{t('Latest weight')}</dt>
            <dd>
              {c.latestWeight
                ? `${c.latestWeight.weightKg} kg (${formatDate(c.latestWeight.recordedAt)})`
                : t('Not recorded')}
            </dd>
          </div>
        </dl>
        {rx.instructions && (
          <p style={{ marginTop: '0.75rem' }}>
            {t('Instructions:')} {rx.instructions}
          </p>
        )}
        {rx.pharmacistNote && (
          <div className="addendum">
            <strong>{t('Pharmacist note:')}</strong> {rx.pharmacistNote}
          </div>
        )}
        {rx.dispensedQuantity && (
          <p className="muted">
            {t('Dispensed {quantity} on {date}', {
              quantity: rx.dispensedQuantity,
              date: formatDateTime(rx.dispensedAt),
            })}
          </p>
        )}
      </Card>

      <Card title={t('Safety checks')}>
        <p className="muted">
          {t(
            'Decision support – does not replace professional judgement or a full interaction database.',
          )}
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
          <Alert tone="success" title={t('No alerts found by the automated checks')} />
        )}
      </Card>

      <div className="two-col">
        <div className="stack">
          <Card title={t('Allergies')}>
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
              <p className="muted">
                {ASSESSMENT_TEXT[c.allergyAssessment]
                  ? t(ASSESSMENT_TEXT[c.allergyAssessment]!)
                  : t('None recorded')}
              </p>
            )}
          </Card>
          <Card title={t('Other active medications')}>
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
              <EmptyState title={t('No other active medications')} />
            )}
          </Card>
        </div>
        <div className="stack">
          <Card title={t('Active problems')}>
            {c.activeProblems.length ? (
              <ul className="list">
                {c.activeProblems.map((p) => (
                  <li key={p.icd10Code + p.description}>
                    <code>{p.icd10Code}</code> {p.description}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={t('None recorded')} />
            )}
          </Card>
          <Card title={t('Renal function & electrolytes')}>
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
              <EmptyState title={t('No recent results')} />
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
        title={t('Pharmacy verification queue')}
        subtitle={t('Verify, dispense or return prescriptions written at your facility.')}
      />
      <Alert tone="info">
        {t(
          'You see only the medication context needed to check each prescription — not the full record. Every context view is logged and visible to the patient.',
        )}
      </Alert>
      <div className="stack">
        <div className="kpi-grid">
          <Stat
            label={t('Awaiting verification')}
            value={counts.PENDING ?? 0}
            tone={(counts.PENDING ?? 0) > 0 ? 'warning' : undefined}
          />
          <Stat label={t('Ready to dispense')} value={counts.VERIFIED ?? 0} tone="info" />
          <Stat
            label={t('Returned to prescriber')}
            value={counts.RETURNED ?? 0}
            tone={(counts.RETURNED ?? 0) > 0 ? 'danger' : undefined}
          />
          <Stat label={t('Dispensed')} value={counts.DISPENSED ?? 0} tone="success" />
        </div>

        <Card>
          <Tabs
            label={t('Queue status')}
            active={status}
            onChange={(s) => select({ status: s, rx: null })}
            tabs={STATUSES.map((s) => ({ id: s, label: tabLabel(s), count: counts[s] ?? 0 }))}
          />
          <TabPanel id={status}>
            <QueryView query={q}>
              {(d) =>
                d.items.length === 0 ? (
                  <EmptyState title={t('Nothing in this queue')} />
                ) : (
                  <div className="split">
                    <Table caption={tabLabel(status)}>
                      <thead>
                        <tr>
                          <th>{t('Prescription')}</th>
                          <th>{t('Waiting')}</th>
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
                                {t('{age} y', { age: age(it.patientDateOfBirth) })} ·{' '}
                                {humanize(it.patientSex)}
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
                          <EmptyState title={t('Select a prescription')}>
                            {t('Choose an item on the left to see its medication context.')}
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
