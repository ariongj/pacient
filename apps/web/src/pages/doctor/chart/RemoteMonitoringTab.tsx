import { useState } from 'react';
import {
  kindLabel,
  limitLabel,
  readingValue,
  useEndPlan,
  useEnrolPlan,
  usePatientMonitoring,
  useUpdatePlan,
  type Reading,
} from '../../../api/remote';
import { registerLabel } from '../../../api/registers';
import {
  Alert,
  Button,
  Card,
  DefinitionList,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  Table,
  TextAreaField,
} from '../../../components/ui';
import { formatDate, formatDateTime, formatNumber } from '../../../format';
import { t } from '../../../i18n';
import {
  FlagBadge,
  PlanForm,
  Reasons,
  ReviewDialog,
  TrendChart,
} from '../../remote/RemoteComponents';

/**
 * Chart tab: the patient's home monitoring plan (enrol, edit, end), trends against the personal
 * limits and the readings with their review status. Home readings are patient-entered and are
 * shown here only – they are not copied into the clinic's vital signs.
 */
export function RemoteMonitoringTab({ patientId }: { patientId: string }) {
  const data = usePatientMonitoring(patientId);
  const enrol = useEnrolPlan(patientId);
  const update = useUpdatePlan();
  const end = useEndPlan();
  const [dialog, setDialog] = useState<'enrol' | 'edit' | 'end' | null>(null);
  const [reviewing, setReviewing] = useState<Reading | null>(null);
  const [showAll, setShowAll] = useState(false);

  return (
    <QueryView query={data}>
      {(d) => (
        <div className="stack">
          <Alert tone="info">
            {t(
              'Home readings are entered by the patient (or a guardian) and are not verified clinic measurements; they are kept apart from vital signs.',
            )}
          </Alert>
          {d.plan ? (
            <Card
              title={t('Home monitoring plan')}
              actions={
                d.canEnrol && (
                  <div className="row">
                    <Button size="sm" variant="secondary" onClick={() => setDialog('edit')}>
                      {t('Edit plan')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setDialog('end')}>
                      {t('End plan')}
                    </Button>
                  </div>
                )
              }
            >
              <DefinitionList
                items={[
                  [t('Measurements'), d.plan.kinds.map(kindLabel).join(', ')],
                  [t('How often'), d.plan.frequency],
                  [t('Enrolled by'), `${d.plan.enrolledBy} · ${formatDate(d.plan.createdAt)}`],
                  [
                    t('Personal alert limits'),
                    Object.entries(d.plan.limits)
                      .map(([k, v]) => `${limitLabel(k)}: ${formatNumber(v!)}`)
                      .join(' · '),
                  ],
                ]}
              />
              {d.plan.instructions && (
                <p style={{ whiteSpace: 'pre-line' }}>{d.plan.instructions}</p>
              )}
            </Card>
          ) : (
            <Card title={t('Home monitoring plan')}>
              <EmptyState title={t('Not enrolled in home monitoring')}>
                {d.suggestion
                  ? t('Suggested for patients in the {registers} register: {kinds}.', {
                      registers: d.suggestion.registers.map(registerLabel).join(', '),
                      kinds: d.suggestion.kinds.map(kindLabel).join(', '),
                    })
                  : t('Patients can enter readings in the portal even without a plan.')}
              </EmptyState>
              {d.canEnrol && (
                <div className="row">
                  <Button onClick={() => setDialog('enrol')}>
                    {t('Enrol in home monitoring')}
                  </Button>
                </div>
              )}
            </Card>
          )}

          {(d.plan?.kinds ?? [...new Set(d.readings.map((r) => r.kind))]).map((k) => (
            <Card key={k} title={kindLabel(k)}>
              <TrendChart kind={k} readings={d.readings} limits={d.plan?.limits ?? {}} />
            </Card>
          ))}

          <Card title={t('Home readings')}>
            {d.readings.length === 0 ? (
              <EmptyState title={t('No readings yet')} />
            ) : (
              <>
                <Table caption={t('Home readings')}>
                  <thead>
                    <tr>
                      <th>{t('Measured')}</th>
                      <th>{t('Measurement')}</th>
                      <th>{t('Value')}</th>
                      <th>{t('Result|reading')}</th>
                      <th>{t('Review')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(showAll ? d.readings : d.readings.slice(0, 30)).map((r) => (
                      <tr key={r.id}>
                        <td>{formatDateTime(r.measuredAt)}</td>
                        <td>{kindLabel(r.kind)}</td>
                        <td>
                          {readingValue(r.kind, r.values)}
                          {r.note && <div className="muted">“{r.note}”</div>}
                        </td>
                        <td>
                          <FlagBadge flag={r.flag} />
                          <Reasons reasons={r.reasons} />
                        </td>
                        <td>
                          {r.reviewedAt ? (
                            <>
                              {t('Reviewed by {name}, {date}', {
                                name: r.reviewedBy ?? '—',
                                date: formatDateTime(r.reviewedAt),
                              })}
                              {r.reviewNote && <div className="muted">{r.reviewNote}</div>}
                            </>
                          ) : r.flag !== 'NORMAL' && d.canReview ? (
                            <Button size="sm" onClick={() => setReviewing(r)}>
                              {t('Review')}
                            </Button>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {d.readings.length > 30 && (
                  <Button variant="ghost" size="sm" onClick={() => setShowAll((s) => !s)}>
                    {showAll
                      ? t('Show fewer')
                      : t('Show all {count}', { count: d.readings.length })}
                  </Button>
                )}
              </>
            )}
          </Card>

          {d.history.length > 0 && (
            <Card title={t('Earlier plans')}>
              <ul>
                {d.history.map((p) => (
                  <li key={p.id}>
                    {p.kinds.map(kindLabel).join(', ')} · {formatDate(p.createdAt)} –{' '}
                    {formatDate(p.endedAt)}
                    {p.endReason && <span className="muted"> · {p.endReason}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Dialog
            open={dialog === 'enrol' || dialog === 'edit'}
            onClose={() => setDialog(null)}
            title={
              dialog === 'edit' ? t('Edit home monitoring plan') : t('Enrol in home monitoring')
            }
            wide
          >
            {dialog === 'edit' && d.plan ? (
              <PlanForm
                initial={d.plan}
                onSubmit={(input) =>
                  update.mutate({ id: d.plan!.id, ...input }, { onSuccess: () => setDialog(null) })
                }
                pending={update.isPending}
                error={update.error}
                submitLabel={t('Save changes')}
              />
            ) : (
              <PlanForm
                suggestedKinds={d.suggestion?.kinds}
                onSubmit={(input) => enrol.mutate(input, { onSuccess: () => setDialog(null) })}
                pending={enrol.isPending}
                error={enrol.error}
                submitLabel={t('Enrol')}
              />
            )}
          </Dialog>

          <Dialog
            open={dialog === 'end'}
            onClose={() => setDialog(null)}
            title={t('End home monitoring')}
          >
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
                end.mutate({ id: d.plan!.id, reason }, { onSuccess: () => setDialog(null) });
              }}
            >
              <TextAreaField
                name="reason"
                label={t('Reason')}
                required
                minLength={3}
                maxLength={300}
                placeholder={t('e.g. values stable for six months')}
              />
              <ErrorAlert error={end.error} />
              <div className="row">
                <Button type="submit" variant="danger" loading={end.isPending}>
                  {t('End plan')}
                </Button>
              </div>
            </form>
          </Dialog>

          <ReviewDialog reading={reviewing} onClose={() => setReviewing(null)} />
        </div>
      )}
    </QueryView>
  );
}
