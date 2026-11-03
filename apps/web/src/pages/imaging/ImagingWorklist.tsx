import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../api/client';
import {
  modalityLabel,
  MODALITIES,
  useImagingAction,
  type ImagingStatus,
  type Modality,
  type RadiologyWorklist,
  type WorklistItem,
} from '../../api/imaging';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Grid,
  PageHeader,
  QueryView,
  SelectField,
  Stat,
  StatusBadge,
  Table,
  TextAreaField,
  TextField,
} from '../../components/ui';
import { age, formatDateTime, humanize } from '../../format';
import { t } from '../../i18n';
import { ReportDialog, SafetyLine } from '../doctor/chart/ImagingTab';

/** Radiology unit queue: schedule, perform and report examinations. */
export function ImagingWorklist() {
  const user = useUser();
  const [status, setStatus] = useState<ImagingStatus | ''>('');
  const [modality, setModality] = useState<Modality | ''>('');
  const q = useQuery({
    queryKey: ['imaging', 'worklist', status, modality],
    queryFn: () =>
      api<RadiologyWorklist>('/imaging/worklist', {
        query: { status: status || undefined, modality: modality || undefined },
      }),
    refetchInterval: 30_000,
  });
  const [scheduling, setScheduling] = useState<WorklistItem | null>(null);
  const [reporting, setReporting] = useState<WorklistItem | null>(null);
  const [viewing, setViewing] = useState<WorklistItem | null>(null);
  const perform = useImagingAction((id: string) => ({ path: `/orders/${id}/perform` }));
  const chartBase = user.role === 'NURSE' ? '/nurse' : '/doctor';

  if (q.error instanceof ApiError && q.error.status === 403) {
    return (
      <>
        <PageHeader title={t('Radiology worklist')} />
        <Alert tone="info" title={t('For the radiology unit')}>
          {t(
            'The worklist is available to radiologists and radiographers assigned to the radiology unit. Order imaging from the patient’s chart (Imaging tab).',
          )}
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t('Radiology worklist')}
        subtitle={t('Examinations requested at your facility, most urgent first.')}
      />
      <QueryView query={q}>
        {(d) => (
          <>
            <Grid min={160}>
              <Stat label={t('Waiting')} value={d.counts.ORDERED ?? 0} />
              <Stat label={t('Scheduled')} value={d.counts.SCHEDULED ?? 0} />
              <Stat
                label={t('Awaiting report')}
                value={d.counts.PERFORMED ?? 0}
                tone={(d.counts.PERFORMED ?? 0) > 0 ? 'warning' : undefined}
              />
              <Stat
                label={t('STAT open')}
                value={
                  d.items.filter((i) => i.priority === 'STAT' && i.status !== 'REPORTED').length
                }
                tone={
                  d.items.some((i) => i.priority === 'STAT' && i.status !== 'REPORTED')
                    ? 'danger'
                    : undefined
                }
              />
            </Grid>
            <Card>
              <div className="search-bar">
                <SelectField
                  label={t('Status')}
                  value={status}
                  onChange={(e) => setStatus(e.currentTarget.value as ImagingStatus | '')}
                  placeholder={t('Open and reported today')}
                  options={(
                    ['ORDERED', 'SCHEDULED', 'PERFORMED', 'REPORTED', 'CANCELLED'] as const
                  ).map((s) => ({ value: s, label: humanize(s) }))}
                />
                <SelectField
                  label={t('Modality')}
                  value={modality}
                  onChange={(e) => setModality(e.currentTarget.value as Modality | '')}
                  placeholder={t('All modalities')}
                  options={MODALITIES.map((m) => ({ value: m, label: modalityLabel(m) }))}
                />
              </div>
              <ErrorAlert error={perform.error} />
              {d.items.length === 0 ? (
                <EmptyState title={t('No examinations in the queue')} />
              ) : (
                <Table caption={t('Radiology worklist')}>
                  <thead>
                    <tr>
                      <th>{t('Priority')}</th>
                      <th>{t('Patient')}</th>
                      <th>{t('Examination')}</th>
                      <th>{t('Status')}</th>
                      <th>{t('Requested')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.items.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <StatusBadge value={o.priority} />
                        </td>
                        <td>
                          <Link to={`${chartBase}/patients/${o.patientId}`}>{o.patientName}</Link>
                          <div className="muted">
                            {t('{age} y', { age: age(o.dateOfBirth) })} · {humanize(o.sex)} ·{' '}
                            <span className="mono">{o.nationalId}</span>
                          </div>
                        </td>
                        <td>
                          <strong>
                            {modalityLabel(o.modality)} · {o.bodyPart}
                          </strong>
                          <div className="muted">“{o.clinicalQuestion}”</div>
                          <SafetyLine checks={o.safetyChecks} />
                          <div className="muted mono">{o.accessionNumber}</div>
                        </td>
                        <td>
                          <StatusBadge value={o.status} />
                          {o.critical && <Badge tone="danger">{t('Critical finding')}</Badge>}
                          {o.scheduledAt && o.status === 'SCHEDULED' && (
                            <div className="muted">{formatDateTime(o.scheduledAt)}</div>
                          )}
                          {o.performedBy && (
                            <div className="muted">
                              {t('Performed by {name}', { name: o.performedBy })}
                            </div>
                          )}
                        </td>
                        <td>
                          {formatDateTime(o.createdAt)}
                          <div className="muted">{o.orderedBy}</div>
                        </td>
                        <td>
                          <div className="stack" style={{ gap: '0.35rem' }}>
                            {(o.status === 'ORDERED' || o.status === 'SCHEDULED') && (
                              <>
                                <Button
                                  size="sm"
                                  loading={perform.isPending && perform.variables === o.id}
                                  onClick={() => perform.mutate(o.id)}
                                >
                                  {t('Mark performed')}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => setScheduling(o)}
                                >
                                  {o.status === 'SCHEDULED' ? t('Reschedule') : t('Schedule')}
                                </Button>
                              </>
                            )}
                            {o.status === 'PERFORMED' && d.isRadiologist && (
                              <Button size="sm" onClick={() => setReporting(o)}>
                                {t('Write report')}
                              </Button>
                            )}
                            {o.status === 'PERFORMED' && !d.isRadiologist && (
                              <small className="muted">{t('Waiting for the radiologist')}</small>
                            )}
                            {o.status === 'REPORTED' && (
                              <Button size="sm" variant="ghost" onClick={() => setViewing(o)}>
                                {t('Full report')}
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          </>
        )}
      </QueryView>
      {scheduling && <ScheduleDialog order={scheduling} onClose={() => setScheduling(null)} />}
      {reporting && <ReportEditor order={reporting} onClose={() => setReporting(null)} />}
      {viewing && <ReportDialog order={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function ScheduleDialog({ order, onClose }: { order: WorklistItem; onClose: () => void }) {
  const [when, setWhen] = useState('');
  const schedule = useImagingAction(
    () => ({
      path: `/orders/${order.id}/schedule`,
      body: { scheduledAt: new Date(when).toISOString() },
    }),
    onClose,
  );
  return (
    <Dialog open onClose={onClose} title={t('Schedule examination')}>
      <p>
        {order.patientName} · {modalityLabel(order.modality)} · {order.bodyPart}
      </p>
      <TextField
        label={t('Date and time')}
        type="datetime-local"
        required
        value={when}
        onChange={(e) => setWhen(e.currentTarget.value)}
      />
      <ErrorAlert error={schedule.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          {t('Cancel')}
        </Button>
        <Button
          disabled={!when}
          loading={schedule.isPending}
          onClick={() => schedule.mutate(undefined)}
        >
          {t('Save')}
        </Button>
      </div>
    </Dialog>
  );
}

/** Report editor. Signing is final: a signed report can no longer be changed. */
function ReportEditor({ order, onClose }: { order: WorklistItem; onClose: () => void }) {
  const [findings, setFindings] = useState('');
  const [impression, setImpression] = useState('');
  const [critical, setCritical] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const sign = useImagingAction(
    () => ({ path: `/orders/${order.id}/report`, body: { findings, impression, critical } }),
    onClose,
  );
  const valid = findings.trim().length >= 10 && impression.trim().length >= 3;
  return (
    <Dialog open onClose={onClose} title={t('Write report')} wide>
      <p>
        <strong>
          {order.patientName} · {modalityLabel(order.modality)} · {order.bodyPart}
        </strong>
      </p>
      <p className="muted">“{order.clinicalQuestion}”</p>
      <SafetyLine checks={order.safetyChecks} />
      {confirming ? (
        <>
          <Alert tone={critical ? 'danger' : 'warning'} title={t('Sign the report?')}>
            {critical
              ? t(
                  'The report will be signed and cannot be changed. The ordering doctor (and their cover) will be alerted immediately about a critical finding.',
                )
              : t(
                  'The report will be signed and cannot be changed. The ordering doctor will be notified.',
                )}
          </Alert>
          <ErrorAlert error={sign.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t('Back')}
            </Button>
            <Button
              variant={critical ? 'danger' : 'primary'}
              loading={sign.isPending}
              onClick={() => sign.mutate(undefined)}
            >
              {t('Sign report')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <TextAreaField
            label={t('Findings')}
            required
            rows={8}
            maxLength={10_000}
            value={findings}
            onChange={(e) => setFindings(e.currentTarget.value)}
          />
          <TextAreaField
            label={t('Impression')}
            required
            rows={3}
            maxLength={2000}
            value={impression}
            onChange={(e) => setImpression(e.currentTarget.value)}
            hint={t('The conclusion the ordering doctor and the patient read first.')}
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={critical}
              onChange={(e) => setCritical(e.currentTarget.checked)}
            />
            <span>{t('Critical finding – alert the ordering doctor now')}</span>
          </label>
          <div className="form-actions">
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button disabled={!valid} onClick={() => setConfirming(true)}>
              {t('Review and sign')}
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
