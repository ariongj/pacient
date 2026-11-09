import { useState, type FormEvent } from 'react';
import {
  DUE_TONE,
  dueLabel,
  FREQUENCIES,
  frequencyLabel,
  instrumentName,
  useAssign,
  useChangeFrequency,
  useEndAssignment,
  useInstruments,
  usePatientProms,
  type Assignment,
  type Frequency,
  type Instrument,
  type InstrumentCode,
  type Response,
} from '../../../api/proms';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  QueryView,
  SelectField,
  Table,
  TextField,
} from '../../../components/ui';
import { formatDate, formatDateTime } from '../../../format';
import { t } from '../../../i18n';
import {
  AnswersList,
  ChangeText,
  ReviewDialog,
  scoreText,
  ScoreTrend,
  SeverityBadge,
  TranslationNote,
} from '../../proms/PromsComponents';

/** Chart: questionnaires asked of the patient, their scores over time and item answers. */
export function PromsTab({ patientId }: { patientId: string }) {
  const q = usePatientProms(patientId);
  const defs = useInstruments();
  const [reviewing, setReviewing] = useState<Response | null>(null);
  const [ending, setEnding] = useState<Assignment | null>(null);
  const byCode = new Map<string, Instrument>(
    (defs.data?.instruments ?? []).map((i) => [i.code, i]),
  );
  return (
    <QueryView query={q}>
      {(data) => {
        const active = data.assignments.filter((a) => a.status === 'ACTIVE');
        const instruments = [...new Set(data.responses.map((r) => r.instrument))];
        return (
          <div className="stack">
            <Card title={t('Questionnaires asked for')}>
              {active.length === 0 ? (
                <EmptyState title={t('No questionnaires asked for')} />
              ) : (
                <Table caption={t('Questionnaires asked for')}>
                  <thead>
                    <tr>
                      <th>{t('Questionnaire')}</th>
                      <th>{t('How often')}</th>
                      <th>{t('Next due')}</th>
                      <th>{t('Asked by')}</th>
                      <th>
                        <span className="sr-only">{t('Actions')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.map((a) => (
                      <AssignmentRow
                        key={a.id}
                        a={a}
                        canChange={data.canAssign}
                        onEnd={() => setEnding(a)}
                      />
                    ))}
                  </tbody>
                </Table>
              )}
              {data.canAssign && defs.data && (
                <AssignForm
                  patientId={patientId}
                  instruments={defs.data.instruments}
                  active={active.map((a) => a.instrument)}
                />
              )}
            </Card>
            {instruments.map((code) => {
              const inst = byCode.get(code);
              const rows = data.responses.filter((r) => r.instrument === code);
              return (
                <Card key={code} title={instrumentName(code)}>
                  {inst && <ScoreTrend instrument={inst} responses={rows} />}
                  <Table caption={t('Answers: {name}', { name: instrumentName(code) })}>
                    <thead>
                      <tr>
                        <th>{t('Date')}</th>
                        <th>{t('Score')}</th>
                        <th>{t('Result|questionnaire')}</th>
                        <th>{t('Change')}</th>
                        <th>{t('Reviewed')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>{formatDateTime(r.submittedAt)}</td>
                          <td>{scoreText(inst, r.score)}</td>
                          <td>
                            <SeverityBadge severity={r.severity} />
                            {r.safetyFlag && (
                              <div>
                                <Badge tone="danger">{t('Safety flag')}</Badge>
                              </div>
                            )}
                            {inst && (
                              <details>
                                <summary>{t('Answers')}</summary>
                                <AnswersList instrument={inst} answers={r.answers} />
                              </details>
                            )}
                          </td>
                          <td>
                            <ChangeText change={r.change} />
                          </td>
                          <td>
                            {r.reviewedAt ? (
                              <>
                                {formatDate(r.reviewedAt)}
                                {r.reviewedBy && <div className="muted">{r.reviewedBy}</div>}
                                {r.reviewNote && <div className="muted">“{r.reviewNote}”</div>}
                              </>
                            ) : data.canReview ? (
                              <Button
                                size="sm"
                                variant={r.safetyFlag ? 'danger' : 'secondary'}
                                onClick={() => setReviewing(r)}
                              >
                                {t('Review')}
                              </Button>
                            ) : (
                              t('Not yet')
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  {inst && (
                    <p className="muted" style={{ fontSize: '0.85rem' }}>
                      {inst.mcid !== null &&
                        t('A change of {n} points or more is clinically meaningful.', {
                          n: inst.mcid,
                        })}{' '}
                      {inst.source}
                    </p>
                  )}
                </Card>
              );
            })}
            {data.assignments.some((a) => a.status === 'ENDED') && (
              <Card title={t('Earlier requests')}>
                <ul>
                  {data.assignments
                    .filter((a) => a.status === 'ENDED')
                    .map((a) => (
                      <li key={a.id}>
                        {instrumentName(a.instrument)} · {frequencyLabel(a.frequency)} ·{' '}
                        {t('{from} to {to}', {
                          from: formatDate(a.createdAt),
                          to: a.endedAt ? formatDate(a.endedAt) : '—',
                        })}
                        {a.endReason && (
                          <span className="muted">
                            {' '}
                            – {a.endReason === 'Completed' ? t('Completed') : a.endReason}
                          </span>
                        )}
                      </li>
                    ))}
                </ul>
              </Card>
            )}
            <TranslationNote />
            <ReviewDialog
              item={reviewing}
              instrument={reviewing ? byCode.get(reviewing.instrument) : undefined}
              onClose={() => setReviewing(null)}
            />
            <EndDialog assignment={ending} onClose={() => setEnding(null)} />
          </div>
        );
      }}
    </QueryView>
  );
}

function AssignmentRow({
  a,
  canChange,
  onEnd,
}: {
  a: Assignment;
  canChange: boolean;
  onEnd: () => void;
}) {
  const change = useChangeFrequency();
  return (
    <tr>
      <td>{instrumentName(a.instrument)}</td>
      <td>
        {canChange ? (
          <select
            aria-label={t('How often: {name}', { name: instrumentName(a.instrument) })}
            value={a.frequency}
            disabled={change.isPending}
            onChange={(e) =>
              change.mutate({ id: a.id, frequency: e.currentTarget.value as Frequency })
            }
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {frequencyLabel(f)}
              </option>
            ))}
          </select>
        ) : (
          frequencyLabel(a.frequency)
        )}
        <ErrorAlert error={change.error} />
      </td>
      <td>
        {a.nextDueAt ? formatDate(a.nextDueAt) : '—'}{' '}
        <Badge tone={DUE_TONE[a.due]}>{dueLabel(a.due)}</Badge>
      </td>
      <td>
        {a.assignedBy}
        <div className="muted">{formatDate(a.createdAt)}</div>
      </td>
      <td>
        {canChange && (
          <Button size="sm" variant="secondary" onClick={onEnd}>
            {t('Stop asking')}
          </Button>
        )}
      </td>
    </tr>
  );
}

function AssignForm({
  patientId,
  instruments,
  active,
}: {
  patientId: string;
  instruments: Instrument[];
  active: string[];
}) {
  const assign = useAssign(patientId);
  const free = instruments.filter((i) => !active.includes(i.code));
  const [instrument, setInstrument] = useState<InstrumentCode | ''>('');
  const current = instrument && free.some((i) => i.code === instrument) ? instrument : '';
  const sensitive = instruments.find((i) => i.code === current)?.sensitive;
  if (!free.length) return null;
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const first = String(form.get('firstDueAt') ?? '');
    if (!current) return;
    assign.mutate(
      {
        instrument: current,
        frequency: String(form.get('frequency')) as Frequency,
        firstDueAt: first ? new Date(`${first}T08:00:00`).toISOString() : undefined,
      },
      { onSuccess: () => setInstrument('') },
    );
  }
  return (
    <form className="stack" onSubmit={onSubmit} style={{ marginTop: '1rem' }}>
      <h3 style={{ margin: 0 }}>{t('Ask for a questionnaire')}</h3>
      <div className="form-grid">
        <SelectField
          label={t('Questionnaire')}
          value={current}
          required
          onChange={(e) => setInstrument(e.currentTarget.value as InstrumentCode)}
          options={[
            { value: '', label: t('Choose…') },
            ...free.map((i) => ({ value: i.code, label: instrumentName(i.code) })),
          ]}
        />
        <SelectField
          name="frequency"
          label={t('How often')}
          defaultValue="MONTHLY"
          options={FREQUENCIES.map((f) => ({ value: f, label: frequencyLabel(f) }))}
        />
        <TextField name="firstDueAt" type="date" label={t('First due (optional)')} />
      </div>
      {sensitive && (
        <p className="muted">
          {t(
            'Guardians never see this questionnaire or its answers; a young person answers it in their own portal account.',
          )}
        </p>
      )}
      <ErrorAlert error={assign.error} />
      <div className="row">
        <Button type="submit" loading={assign.isPending} disabled={!current}>
          {t('Ask the patient')}
        </Button>
      </div>
    </form>
  );
}

function EndDialog({
  assignment,
  onClose,
}: {
  assignment: Assignment | null;
  onClose: () => void;
}) {
  const end = useEndAssignment();
  return (
    <Dialog open={!!assignment} onClose={onClose} title={t('Stop asking for this questionnaire')}>
      {assignment && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
            end.mutate({ id: assignment.id, reason }, { onSuccess: onClose });
          }}
        >
          <p>{instrumentName(assignment.instrument)}</p>
          <TextField name="reason" label={t('Reason')} required minLength={3} maxLength={300} />
          <ErrorAlert error={end.error} />
          <div className="row">
            <Button type="submit" variant="danger" loading={end.isPending}>
              {t('Stop asking')}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              {t('Cancel')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
