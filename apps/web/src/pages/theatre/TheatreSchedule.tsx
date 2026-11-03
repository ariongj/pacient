import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ANAESTHESIA_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  patientLabel,
  procedureLabel,
  useTheatreRequests,
  useTheatreSchedule,
  type ChecklistStep,
  type SurgicalCase,
} from '../../api/theatre';
import { useUser } from '../../auth/AuthContext';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  PageHeader,
  QueryView,
} from '../../components/ui';
import { age, formatDateTime, formatTime, formatFullDate } from '../../format';
import { t, tn } from '../../i18n';
import { ChecklistDialog, CompleteDialog, NoteView, ReasonDialog, ScheduleDialog } from './dialogs';
import './theatre.css';

const isoDay = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Belgrade' }).format(d);
const shiftDay = (day: string, by: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};

const STEPS: ChecklistStep[] = ['signIn', 'timeOut', 'signOut'];
const STEP_SHORT: Record<ChecklistStep, () => string> = {
  signIn: () => t('WHO sign in'),
  timeOut: () => t('WHO time out'),
  signOut: () => t('WHO sign out'),
};

function Progress({ c }: { c: SurgicalCase }) {
  return (
    <ol className="ot-steps" aria-label={t('WHO checklist')}>
      {STEPS.map((s) => (
        <li key={s} className={c.progress[s] ? 'done' : undefined}>
          {c.progress[s] ? '✓ ' : ''}
          {STEP_SHORT[s]()}
        </li>
      ))}
    </ol>
  );
}

const priorityTone = (p: SurgicalCase['priority']) =>
  p === 'EMERGENCY' ? 'danger' : p === 'URGENT' ? 'warning' : 'neutral';

/** Operating theatre lists for one day, the WHO checklist and the operation note. */
export function TheatreSchedule() {
  const user = useUser();
  const [day, setDay] = useState(() => isoDay(new Date()));
  const schedule = useTheatreSchedule(day);
  const requests = useTheatreRequests();
  const [scheduling, setScheduling] = useState<SurgicalCase | null>(null);
  const [checklist, setChecklist] = useState<{ item: SurgicalCase; step: ChecklistStep } | null>(
    null,
  );
  const [completing, setCompleting] = useState<SurgicalCase | null>(null);
  const [reason, setReason] = useState<{ item: SurgicalCase; kind: 'postpone' | 'cancel' } | null>(
    null,
  );
  const [viewing, setViewing] = useState<SurgicalCase | null>(null);
  const chartBase = user.role === 'NURSE' ? '/nurse' : '/doctor';
  const staff = schedule.data?.isTheatreStaff ?? false;
  const isTeam = (c: SurgicalCase) =>
    [c.primarySurgeonId, c.assistantId, c.anaesthetistId].includes(user.id);
  const canAct = (c: SurgicalCase) => staff || isTeam(c);
  const isSurgeon = (c: SurgicalCase) =>
    c.primarySurgeonId === user.id || c.assistantId === user.id;

  function actions(c: SurgicalCase) {
    if (!canAct(c)) return null;
    const next = STEPS.find((s) => !c.progress[s]);
    return (
      <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
        {c.status === 'SCHEDULED' && (
          <>
            <Button size="sm" onClick={() => setChecklist({ item: c, step: 'signIn' })}>
              {t('WHO sign in')}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setScheduling(c)}>
              {t('Reschedule')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReason({ item: c, kind: 'postpone' })}
            >
              {t('Postpone')}
            </Button>
          </>
        )}
        {c.status === 'IN_THEATRE' && next && (
          <Button size="sm" onClick={() => setChecklist({ item: c, step: next })}>
            {STEP_SHORT[next]()}
          </Button>
        )}
        {c.status === 'IN_THEATRE' && !next && isSurgeon(c) && (
          <Button size="sm" onClick={() => setCompleting(c)}>
            {t('Write and sign the operation note')}
          </Button>
        )}
        {c.status === 'IN_THEATRE' && !next && !isSurgeon(c) && (
          <span className="muted">{t('Waiting for the surgeon’s operation note')}</span>
        )}
        {c.status === 'COMPLETED' && c.operationNote !== undefined && (
          <Button size="sm" variant="secondary" onClick={() => setViewing(c)}>
            {t('Operation note')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={t('Operating theatres')}
        subtitle={formatFullDate(new Date(`${day}T12:00:00`))}
        actions={
          <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
            <Button variant="secondary" onClick={() => setDay(shiftDay(day, -1))}>
              ← {t('Previous day')}
            </Button>
            <input
              type="date"
              aria-label={t('Date')}
              value={day}
              onChange={(e) => e.target.value && setDay(e.target.value)}
              style={{ width: 'auto' }}
            />
            <Button variant="secondary" onClick={() => setDay(isoDay(new Date()))}>
              {t('Today')}
            </Button>
            <Button variant="secondary" onClick={() => setDay(shiftDay(day, 1))}>
              {t('Next day')} →
            </Button>
          </div>
        }
      />

      <QueryView query={requests}>
        {(items) =>
          items.length === 0 ? null : (
            <Card
              title={
                <>
                  {t('Waiting for a theatre')} <Badge tone="warning">{items.length}</Badge>
                </>
              }
            >
              <ul className="ot-list">
                {items.map((c) => (
                  <li key={c.id} className={`ot-case ot-priority-${c.priority.toLowerCase()}`}>
                    <div className="ot-case-main">
                      <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                        <Badge tone={priorityTone(c.priority)}>
                          {PRIORITY_LABELS[c.priority]()}
                        </Badge>
                        <Badge tone={STATUS_TONES[c.status]}>{STATUS_LABELS[c.status]()}</Badge>
                        {!c.consentRecordId && (
                          <Badge tone="warning">{t('No treatment consent recorded')}</Badge>
                        )}
                      </div>
                      <strong>{procedureLabel(c)}</strong>
                      <div>
                        <Link to={`${chartBase}/patients/${c.patientId}?tab=surgery`}>
                          {patientLabel(c)}
                        </Link>{' '}
                        <span className="muted">
                          · {t('{age} y', { age: age(c.patientDateOfBirth) })} ·{' '}
                          {t('Surgeon: {name}', { name: c.surgeon })} ·{' '}
                          {tn(c.estimatedMinutes, '{count} minute', '{count} minutes')}
                        </span>
                      </div>
                      {c.indication && <div className="muted">{c.indication}</div>}
                      <div className="muted">
                        {t('Requested {date}', { date: formatDateTime(c.createdAt) })}
                      </div>
                    </div>
                    {canAct(c) && (
                      <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                        <Button size="sm" onClick={() => setScheduling(c)}>
                          {t('Schedule operation')}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setReason({ item: c, kind: 'cancel' })}
                        >
                          {t('Cancel operation')}
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )
        }
      </QueryView>

      <QueryView query={schedule}>
        {(data) =>
          data.theatres.length === 0 ? (
            <EmptyState title={t('No operating theatres are set up at this facility')}>
              {t('The director adds theatres under Wards & units (type: operating theatre).')}
            </EmptyState>
          ) : (
            <div className="ot-grid">
              {data.theatres.map((th) => {
                const cases = data.items.filter((c) => c.theatreUnitId === th.id);
                const booked = cases
                  .filter((c) => c.status !== 'CANCELLED' && c.status !== 'POSTPONED')
                  .reduce((a, c) => a + c.estimatedMinutes, 0);
                return (
                  <Card
                    key={th.id}
                    title={
                      <>
                        {th.name}{' '}
                        <span className="muted" style={{ fontWeight: 400 }}>
                          {t('{hours} h booked', { hours: Math.round((booked / 60) * 10) / 10 })}
                        </span>
                      </>
                    }
                  >
                    {cases.length === 0 ? (
                      <EmptyState title={t('No operations on this day')} />
                    ) : (
                      <ul className="ot-list">
                        {cases.map((c) => {
                          const start = c.scheduledStart ? new Date(c.scheduledStart) : null;
                          const end = start
                            ? new Date(start.getTime() + c.estimatedMinutes * 60_000)
                            : null;
                          return (
                            <li
                              key={c.id}
                              className={`ot-case ot-status-${c.status.toLowerCase()}`}
                            >
                              <div className="ot-time">
                                {start && end
                                  ? `${formatTime(start.toISOString())}–${formatTime(end.toISOString())}`
                                  : '—'}
                              </div>
                              <div className="ot-case-main">
                                <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
                                  <Badge tone={STATUS_TONES[c.status]}>
                                    {STATUS_LABELS[c.status]()}
                                  </Badge>
                                  {c.priority !== 'ELECTIVE' && (
                                    <Badge tone={priorityTone(c.priority)}>
                                      {PRIORITY_LABELS[c.priority]()}
                                    </Badge>
                                  )}
                                </div>
                                <strong>{procedureLabel(c)}</strong>
                                <div>
                                  {user.role === 'DOCTOR' || user.role === 'NURSE' ? (
                                    <Link to={`${chartBase}/patients/${c.patientId}?tab=surgery`}>
                                      {patientLabel(c)}
                                    </Link>
                                  ) : (
                                    patientLabel(c)
                                  )}{' '}
                                  <span className="muted">
                                    · {t('{age} y', { age: age(c.patientDateOfBirth) })}
                                  </span>
                                </div>
                                <div className="muted">
                                  {[
                                    t('Surgeon: {name}', { name: c.surgeon }),
                                    c.assistant
                                      ? t('Assistant: {name}', { name: c.assistant })
                                      : null,
                                    c.anaesthetist
                                      ? t('Anaesthetist: {name}', { name: c.anaesthetist })
                                      : null,
                                    c.anaesthesiaType
                                      ? ANAESTHESIA_LABELS[c.anaesthesiaType]()
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </div>
                                {c.indication && <div className="muted">{c.indication}</div>}
                                {(c.status === 'IN_THEATRE' || c.status === 'COMPLETED') && (
                                  <Progress c={c} />
                                )}
                                {c.status === 'CANCELLED' && c.cancelReason && (
                                  <div className="muted">
                                    {t('Cancelled: {reason}', { reason: c.cancelReason })}
                                  </div>
                                )}
                              </div>
                              {actions(c)}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </Card>
                );
              })}
            </div>
          )
        }
      </QueryView>

      <ScheduleDialog item={scheduling} defaultDate={day} onClose={() => setScheduling(null)} />
      <ChecklistDialog
        item={checklist?.item ?? null}
        step={checklist?.step ?? null}
        onClose={() => setChecklist(null)}
      />
      <CompleteDialog item={completing} onClose={() => setCompleting(null)} />
      <ReasonDialog
        item={reason?.item ?? null}
        kind={reason?.kind ?? null}
        onClose={() => setReason(null)}
      />
      <Dialog
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={viewing ? procedureLabel(viewing) : ''}
        wide
      >
        {viewing && <NoteView item={viewing} />}
      </Dialog>
    </>
  );
}
