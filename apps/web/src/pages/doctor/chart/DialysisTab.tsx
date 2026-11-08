import { useState } from 'react';
import {
  accessLabel,
  complicationLabel,
  endReasonLabel,
  usePatientDialysis,
  type Schedule,
  type Session,
} from '../../../api/dialysis';
import { useUser } from '../../../auth/AuthContext';
import { LineChart } from '../../../components/charts';
import {
  Badge,
  Button,
  Card,
  DefinitionList,
  EmptyState,
  Grid,
  QueryView,
  Table,
} from '../../../components/ui';
import { formatDate, formatMonth, formatNumber } from '../../../format';
import { t } from '../../../i18n';
import {
  AdequacyText,
  bp,
  EndScheduleDialog,
  kg,
  scheduleText,
  ScheduleDialog,
  SessionDialog,
  SessionStatusBadge,
  WarningList,
} from '../../dialysis/DialysisComponents';

const SHOWN = 15;

/**
 * The patient's haemodialysis: the schedule, recent sessions with weights, blood pressure and
 * warnings, weight and blood pressure trends and the monthly adequacy (URR, Kt/V).
 */
export function DialysisTab({ patientId }: { patientId: string }) {
  const user = useUser();
  const query = usePatientDialysis(patientId);
  const [starting, setStarting] = useState(false);
  const [changing, setChanging] = useState<Schedule | null>(null);
  const [ending, setEnding] = useState<Schedule | null>(null);
  const [urea, setUrea] = useState<Session | null>(null);
  const [all, setAll] = useState(false);
  return (
    <QueryView query={query}>
      {(data) => {
        const active = data.schedules.find((s) => s.status === 'ACTIVE') ?? null;
        const ended = data.schedules.filter((s) => s.status === 'ENDED');
        const completed = data.sessions
          .filter((s) => s.status === 'COMPLETED')
          .slice(0, 12)
          .reverse();
        const sessions = all ? data.sessions : data.sessions.slice(0, SHOWN);
        const isDoctor = user.role === 'DOCTOR';
        return (
          <div className="stack">
            <Card
              title={t('Dialysis')}
              actions={
                isDoctor &&
                (active ? (
                  <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <Button size="sm" variant="secondary" onClick={() => setChanging(active)}>
                      {t('Change the schedule')}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setEnding(active)}>
                      {t('End dialysis')}
                    </Button>
                  </span>
                ) : (
                  data.canSchedule &&
                  data.units.length > 0 && (
                    <Button size="sm" onClick={() => setStarting(true)}>
                      {t('Start dialysis')}
                    </Button>
                  )
                ))
              }
            >
              {active ? (
                <DefinitionList
                  items={[
                    [t('Dialysis unit'), active.unitName ?? '—'],
                    [t('Schedule'), scheduleText(active)],
                    [t('Target (dry) weight'), kg(active.targetWeightKg)],
                    [t('Vascular access'), accessLabel(active.vascularAccess)],
                    [t('Since'), formatDate(active.startedOn)],
                  ]}
                />
              ) : (
                <EmptyState title={t('Not on dialysis')}>
                  {isDoctor && data.units.length === 0
                    ? t('Your facility has no dialysis unit in Pacient.')
                    : t('A doctor starts dialysis by choosing a unit, days and shift.')}
                </EmptyState>
              )}
              {ended.length > 0 && (
                <p className="muted">
                  {ended
                    .map(
                      (s) =>
                        `${s.unitName ?? ''} ${formatDate(s.startedOn)}–${formatDate(s.endedOn)}: ${
                          s.endReason ? endReasonLabel(s.endReason) : '—'
                        }`,
                    )
                    .join(' · ')}
                </p>
              )}
            </Card>

            {completed.length > 1 && (
              <Grid min={300}>
                <Card title={t('Weight after dialysis')}>
                  <LineChart
                    title={t('Weight after dialysis')}
                    data={completed
                      .filter((s) => s.postWeightKg !== null)
                      .map((s) => ({ label: formatDate(s.sessionDate), value: s.postWeightKg! }))}
                    formatValue={(n) => `${formatNumber(n)} kg`}
                  />
                </Card>
                <Card title={t('Weight gain between sessions')}>
                  <LineChart
                    title={t('Weight gain between sessions')}
                    data={completed
                      .filter((s) => s.interdialyticGainKg !== null)
                      .map((s) => ({
                        label: formatDate(s.sessionDate),
                        value: s.interdialyticGainKg!,
                      }))}
                    formatValue={(n) => `${formatNumber(n)} kg`}
                  />
                </Card>
                <Card title={t('Systolic pressure before dialysis')}>
                  <LineChart
                    title={t('Systolic pressure before dialysis')}
                    data={completed
                      .filter((s) => s.preSystolic !== null)
                      .map((s) => ({ label: formatDate(s.sessionDate), value: s.preSystolic! }))}
                    formatValue={(n) => `${formatNumber(n)} mmHg`}
                  />
                </Card>
              </Grid>
            )}

            <Card title={t('Adequacy by month')}>
              <p className="muted">
                {t(
                  'Target Kt/V ≥ {ktv} (Daugirdas), or URR ≥ {urr}% when Kt/V cannot be computed. Illustrative targets – follow the unit’s protocol.',
                  { ...data.targets },
                )}
              </p>
              {data.monthlyAdequacy.length === 0 ? (
                <EmptyState title={t('No urea measurements yet')} />
              ) : (
                <Table caption={t('Adequacy by month')}>
                  <thead>
                    <tr>
                      <th>{t('Month')}</th>
                      <th>{t('Session')}</th>
                      <th>{t('Adequacy')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.monthlyAdequacy].reverse().map((m) => (
                      <tr key={m.month}>
                        <td>{formatMonth(m.month)}</td>
                        <td>{formatDate(m.sessionDate)}</td>
                        <td>
                          <AdequacyText a={m} targets={data.targets} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <Card
              title={t('Sessions')}
              actions={
                data.sessions.length > SHOWN && (
                  <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
                    {all ? t('Show fewer') : t('Show all')}
                  </Button>
                )
              }
            >
              {data.sessions.length === 0 ? (
                <EmptyState title={t('No dialysis sessions')} />
              ) : (
                <Table caption={t('Sessions')}>
                  <thead>
                    <tr>
                      <th>{t('Date')}</th>
                      <th>{t('Status')}</th>
                      <th>{t('Weight before / after')}</th>
                      <th>{t('Blood pressure before / after')}</th>
                      <th>{t('Ultrafiltration')}</th>
                      <th>{t('Adequacy')}</th>
                      <th>{t('Complications and warnings')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <td>
                          {formatDate(s.sessionDate)}
                          {s.machine && <div className="muted">{s.machine}</div>}
                        </td>
                        <td>
                          <SessionStatusBadge status={s.status} />
                          {s.missedReason && <div className="muted">{s.missedReason}</div>}
                        </td>
                        <td>
                          {kg(s.preWeightKg)} / {kg(s.postWeightKg)}
                        </td>
                        <td>
                          {bp(s.preSystolic, s.preDiastolic)} /{' '}
                          {bp(s.postSystolic, s.postDiastolic)}
                        </td>
                        <td>
                          {s.ultrafiltrationMl === null
                            ? '—'
                            : `${formatNumber(s.ultrafiltrationMl)} ml`}
                        </td>
                        <td>{s.status === 'COMPLETED' ? <AdequacyText a={s.adequacy} /> : '—'}</td>
                        <td>
                          {s.complications.length > 0 && (
                            <div style={{ marginBottom: '0.25rem' }}>
                              {s.complications.map((c) => (
                                <Badge key={c} tone="warning">
                                  {complicationLabel(c)}
                                </Badge>
                              ))}
                            </div>
                          )}
                          <WarningList warnings={s.warnings} />
                          {s.notes && <div className="muted">{s.notes}</div>}
                        </td>
                        <td>
                          {s.status === 'COMPLETED' && s.preUrea === null && (
                            <Button size="sm" variant="secondary" onClick={() => setUrea(s)}>
                              {t('Add urea')}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>

            <ScheduleDialog
              open={starting}
              onClose={() => setStarting(false)}
              patientId={patientId}
              units={data.units}
            />
            {changing && (
              <ScheduleDialog
                open
                onClose={() => setChanging(null)}
                patientId={patientId}
                units={data.units}
                schedule={changing}
              />
            )}
            <EndScheduleDialog schedule={ending} onClose={() => setEnding(null)} />
            <SessionDialog
              session={urea}
              kind={urea ? 'urea' : null}
              onClose={() => setUrea(null)}
            />
          </div>
        );
      }}
    </QueryView>
  );
}
