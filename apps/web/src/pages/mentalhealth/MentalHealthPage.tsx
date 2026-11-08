import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  kindLabel,
  RESTRICTIVE_KINDS,
  stepLabel,
  stepStatusLabel,
  stepTone,
  useMentalHealthBoard,
  useMentalHealthStats,
  useOversight,
  usePatientMentalHealth,
  type MentalHealthBoard,
  type StepState,
} from '../../api/mentalhealth';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Grid,
  PageHeader,
  QueryView,
  Stat,
  Table,
} from '../../components/ui';
import { formatDate, formatDateTime, formatMonth, fullName } from '../../format';
import { t } from '../../i18n';
import {
  InvoluntaryPanel,
  ObservationClock,
  RestrictivePanel,
  relative,
  useNow,
} from './MentalHealthComponents';

const chartLink = (role: string, patientId: string) =>
  `${role === 'NURSE' ? '/nurse' : '/doctor'}/patients/${patientId}?tab=mentalhealth`;

/** The row a notification pointed to. */
const HIGHLIGHT = { outline: '2px solid currentColor', outlineOffset: '-2px' } as const;

const ILLUSTRATIVE = () =>
  t(
    'The time limits are illustrative until confirmed by legal counsel and the Ministry of Health.',
  );

/** The most urgent step not yet done: overdue first, then the earliest due. */
function nextStep(steps: StepState[]) {
  const open = steps.filter(
    (s) => s.status === 'OVERDUE' || s.status === 'DUE_SOON' || s.status === 'PENDING',
  );
  const rank = { OVERDUE: 0, DUE_SOON: 1, PENDING: 2 } as Record<string, number>;
  return open.sort(
    (a, b) =>
      rank[a.status]! - rank[b.status]! ||
      new Date(a.dueAt ?? 0).getTime() - new Date(b.dueAt ?? 0).getTime(),
  )[0];
}

function NextStepCell({ steps }: { steps: StepState[] }) {
  const now = useNow();
  const next = nextStep(steps);
  if (!next) return <Badge tone="success">{t('All steps done')}</Badge>;
  return (
    <span className="stack" style={{ gap: '0.15rem' }}>
      <span>
        <Badge tone={stepTone(next.status)}>{stepStatusLabel(next.status)}</Badge>{' '}
        {stepLabel(next.step)}
      </span>
      {next.dueAt && <small className="muted">{relative(next.dueAt, now)}</small>}
    </span>
  );
}

/** The dialog opened from the board: the legal steps or the intervention, without the chart. */
function BoardDialog({
  patientId,
  kind,
  id,
  onClose,
}: {
  patientId: string;
  kind: 'ia' | 'ri';
  id: string;
  onClose: () => void;
}) {
  const user = useUser();
  const q = usePatientMentalHealth(patientId);
  return (
    <Dialog open onClose={onClose} wide title={t('Mental health safeguards')}>
      <QueryView query={q}>
        {(data) => {
          if (kind === 'ia') {
            const ia = data.involuntary.find((x) => x.id === id);
            return ia ? (
              <InvoluntaryPanel
                ia={ia}
                patientId={patientId}
                maxDays={data.maxAuthorisationDays}
                showAssessment={false}
              />
            ) : (
              <EmptyState title={t('No longer in force')} />
            );
          }
          const r = data.restrictive.find((x) => x.id === id);
          return r ? (
            <RestrictivePanel r={r} patientId={patientId} canAct />
          ) : (
            <EmptyState title={t('Not found')} />
          );
        }}
      </QueryView>
      <p>
        <Link to={chartLink(user.role, patientId)}>{t('Open the chart')}</Link>
      </p>
    </Dialog>
  );
}

const where = (p: MentalHealthBoard['involuntary'][number]['patient']) =>
  p ? `${p.unitName ?? '—'}${p.bedLabel ? `, ${t('bed {bed}', { bed: p.bedLabel })}` : ''}` : '—';

function Board() {
  const user = useUser();
  const board = useMentalHealthBoard();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState<{ patientId: string; kind: 'ia' | 'ri'; id: string } | null>(
    null,
  );
  const highlighted = params.get('ia');
  return (
    <>
      <PageHeader
        title={t('Mental health safeguards')}
        subtitle={t(
          'Involuntary admissions and restrictive interventions for the patients you are responsible for. Each patient shown here is recorded in their access log.',
        )}
      />
      <QueryView query={board}>
        {(data) => (
          <div className="stack">
            <Grid min={180}>
              <Stat
                label={t('Legal steps overdue')}
                value={data.counts.overdueLegalSteps}
                tone={data.counts.overdueLegalSteps ? 'danger' : 'success'}
              />
              <Stat label={t('Involuntary admissions in force')} value={data.counts.involuntary} />
              <Stat
                label={t('Observations overdue')}
                value={data.counts.observationOverdue}
                tone={data.counts.observationOverdue ? 'danger' : 'success'}
              />
              <Stat
                label={t('Restrictive interventions in progress')}
                value={data.counts.restrictiveActive}
              />
              <Stat
                label={t('Debriefs overdue')}
                value={data.counts.debriefOverdue}
                tone={data.counts.debriefOverdue ? 'warning' : 'success'}
              />
            </Grid>
            <Card title={t('Involuntary admissions')}>
              {data.involuntary.length === 0 ? (
                <EmptyState title={t('No involuntary admissions in force')} />
              ) : (
                <Table caption={t('Involuntary admissions in force')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Patient')}</th>
                      <th scope="col">{t('Where')}</th>
                      <th scope="col">{t('Since')}</th>
                      <th scope="col">{t('Next legal step')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.involuntary.map((i) => (
                      <tr key={i.id} style={highlighted === i.id ? HIGHLIGHT : undefined}>
                        <td>
                          <Link to={chartLink(user.role, i.patientId)}>
                            {i.patient ? fullName(i.patient) : '—'}
                          </Link>
                        </td>
                        <td>{where(i.patient)}</td>
                        <td>{formatDateTime(i.startedAt)}</td>
                        <td>
                          <NextStepCell steps={i.steps} />
                        </td>
                        <td>
                          <Button
                            size="sm"
                            variant={i.overdueSteps.length ? 'primary' : 'secondary'}
                            onClick={() =>
                              setOpen({ patientId: i.patientId, kind: 'ia', id: i.id })
                            }
                          >
                            {t('Legal steps')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            <Card title={t('Restrictive interventions')}>
              {data.restrictive.length === 0 ? (
                <EmptyState title={t('Nothing in progress or waiting for a debrief.')} />
              ) : (
                <Table
                  caption={t('Restrictive interventions in progress or waiting for a debrief')}
                >
                  <thead>
                    <tr>
                      <th scope="col">{t('Patient')}</th>
                      <th scope="col">{t('Where')}</th>
                      <th scope="col">{t('Type')}</th>
                      <th scope="col">{t('Started')}</th>
                      <th scope="col">{t('Status')}</th>
                      <th scope="col">
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.restrictive.map((r) => (
                      <tr key={r.id}>
                        <td>
                          <Link to={chartLink(user.role, r.patientId)}>
                            {r.patient ? fullName(r.patient) : '—'}
                          </Link>
                        </td>
                        <td>{where(r.patient)}</td>
                        <td>{kindLabel(r.kind)}</td>
                        <td>{formatDateTime(r.startedAt)}</td>
                        <td>
                          <ObservationClock r={r} />
                        </td>
                        <td>
                          <Button
                            size="sm"
                            variant={r.observationOverdue ? 'primary' : 'secondary'}
                            onClick={() =>
                              setOpen({ patientId: r.patientId, kind: 'ri', id: r.id })
                            }
                          >
                            {r.endedAt ? t('Record the debrief') : t('Add an observation')}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            {highlighted && !data.involuntary.some((i) => i.id === highlighted) && (
              <Alert tone="info" title={t('This involuntary admission is no longer in force')}>
                {t('It has ended, or you are no longer responsible for the patient.')}
              </Alert>
            )}
            <p className="muted">{ILLUSTRATIVE()}</p>
            {open && (
              <BoardDialog
                {...open}
                onClose={() => {
                  setOpen(null);
                  if (highlighted) {
                    params.delete('ia');
                    params.delete('step');
                    params.delete('until');
                    setParams(params, { replace: true });
                  }
                }}
              />
            )}
          </div>
        )}
      </QueryView>
    </>
  );
}

/** Director: the facility's legal deadlines, with names but no clinical detail. */
function Oversight() {
  const q = useOversight();
  const [params] = useSearchParams();
  const highlighted = params.get('ia');
  return (
    <>
      <PageHeader
        title={t('Mental health safeguards')}
        subtitle={t(
          'Legal deadlines of involuntary admissions at your facility. You see names because the director is responsible for these deadlines; clinical details stay with the care team. Each patient listed is recorded in their access log.',
        )}
      />
      <QueryView query={q}>
        {(d) => (
          <div className="stack">
            <Grid min={180}>
              <Stat
                label={t('Legal steps overdue')}
                value={d.overdueLegalSteps}
                tone={d.overdueLegalSteps ? 'danger' : 'success'}
              />
              <Stat label={t('Involuntary admissions in force')} value={d.involuntary.length} />
              <Stat
                label={t('Restrictive interventions in progress')}
                value={d.restrictiveActive}
              />
              <Stat
                label={t('Debriefs overdue')}
                value={d.debriefOverdue}
                tone={d.debriefOverdue ? 'warning' : 'success'}
              />
            </Grid>
            <Card title={t('Involuntary admissions in force')}>
              {d.involuntary.length === 0 ? (
                <EmptyState title={t('No involuntary admissions in force')} />
              ) : (
                <Table caption={t('Legal steps of involuntary admissions in force')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Patient')}</th>
                      <th scope="col">{t('Ward')}</th>
                      <th scope="col">{t('Since')}</th>
                      <th scope="col">{t('Decided by')}</th>
                      <th scope="col">{t('Legal steps')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.involuntary.map((i) => (
                      <tr key={i.id} style={highlighted === i.id ? HIGHLIGHT : undefined}>
                        <td>{fullName(i.patient)}</td>
                        <td>{i.unitName}</td>
                        <td>{formatDateTime(i.startedAt)}</td>
                        <td>{i.decidedBy ?? '—'}</td>
                        <td>
                          <ul
                            className="stack"
                            style={{ listStyle: 'none', padding: 0, margin: 0, gap: '0.15rem' }}
                          >
                            {i.steps.map((s) => (
                              <li key={s.step}>
                                <Badge tone={stepTone(s.status)}>{stepStatusLabel(s.status)}</Badge>{' '}
                                {stepLabel(s.step)}
                                {s.step === 'AUTHORISATION_REVIEW' && i.authorisedUntil
                                  ? ` (${formatDate(i.authorisedUntil)})`
                                  : !s.doneAt && s.dueAt && s.status !== 'NOT_APPLICABLE'
                                    ? ` (${t('due {time}', { time: formatDateTime(s.dueAt) })})`
                                    : ''}
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            <Card title={t('Restrictive interventions in the last 30 days')}>
              <Grid min={160}>
                {RESTRICTIVE_KINDS.map((k) => (
                  <Stat key={k} label={kindLabel(k)} value={d.restrictiveLast30Days[k]} />
                ))}
              </Grid>
            </Card>
            <p className="muted">{ILLUSTRATIVE()}</p>
          </div>
        )}
      </QueryView>
    </>
  );
}

const shown = (v: number | null) => (v === null ? t('Too few to show') : v);
const pct = (v: number | null) => (v === null ? t('Too few to show') : `${v}%`);

/** Ministry: national aggregates only. */
function Statistics() {
  const q = useMentalHealthStats();
  return (
    <>
      <PageHeader
        title={t('Mental health safeguards')}
        subtitle={t(
          'Involuntary admissions and restrictive interventions by facility over the last 12 months (no names).',
        )}
      />
      <QueryView query={q}>
        {(d) => (
          <div className="stack">
            <Card title={t('By facility')}>
              {d.facilities.length === 0 ? (
                <EmptyState title={t('No records yet')} />
              ) : (
                <Table caption={t('Mental health safeguards by facility')}>
                  <thead>
                    <tr>
                      <th scope="col">{t('Facility')}</th>
                      <th scope="col" className="num">
                        {t('Involuntary admissions')}
                      </th>
                      <th scope="col" className="num">
                        {t('Court notified within 48 hours')}
                      </th>
                      <th scope="col" className="num">
                        {t('Restraint per 1,000 bed-days')}
                      </th>
                      <th scope="col" className="num">
                        {t('Seclusion per 1,000 bed-days')}
                      </th>
                      <th scope="col" className="num">
                        {t('Rapid tranquillisation per 1,000 bed-days')}
                      </th>
                      <th scope="col" className="num">
                        {t('Median duration')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.facilities.map((f) => (
                      <tr key={f.facilityId}>
                        <td>{f.facilityName}</td>
                        <td className="num">{shown(f.involuntary)}</td>
                        <td className="num">{pct(f.courtOnTimePct)}</td>
                        <td className="num">{shown(f.per1000BedDays.restraint)}</td>
                        <td className="num">{shown(f.per1000BedDays.seclusion)}</td>
                        <td className="num">{shown(f.per1000BedDays.rapidTranquillisation)}</td>
                        <td className="num">
                          {f.medianDurationMinutes === null
                            ? t('Too few to show')
                            : t('{minutes} min', { minutes: f.medianDurationMinutes })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            <Card title={t('By month')}>
              <Table caption={t('Mental health safeguards by month')}>
                <thead>
                  <tr>
                    <th scope="col">{t('Month')}</th>
                    <th scope="col" className="num">
                      {t('Involuntary admissions')}
                    </th>
                    <th scope="col" className="num">
                      {t('Restrictive interventions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {d.months.map((m) => (
                    <tr key={m.month}>
                      <td>{formatMonth(m.month)}</td>
                      <td className="num">{shown(m.involuntary)}</td>
                      <td className="num">{shown(m.restrictive)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <p className="muted">
              {t(
                'Counts from 1 to {max} are hidden, and rates, shares and medians are shown only when at least {count} cases are behind them.',
                { max: d.smallCellThreshold - 1, count: d.smallCellThreshold },
              )}{' '}
              {t('Median duration covers restraint and seclusion.')}
            </p>
          </div>
        )}
      </QueryView>
    </>
  );
}

export function MentalHealthPage() {
  const user = useUser();
  if (user.role === 'MINISTRY') return <Statistics />;
  if (user.role === 'DIRECTOR') return <Oversight />;
  return <Board />;
}
