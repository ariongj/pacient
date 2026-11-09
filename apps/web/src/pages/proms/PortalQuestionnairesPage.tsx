import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DUE_TONE,
  dueLabel,
  frequencyLabel,
  instrumentName,
  severityLabel,
  useInstruments,
  useMyProms,
  type Instrument,
  type SubmitResult,
} from '../../api/proms';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  QueryView,
  Table,
} from '../../components/ui';
import { formatDate } from '../../format';
import { t } from '../../i18n';
import {
  AdviceAlert,
  ChangeText,
  QuestionnaireForm,
  scoreText,
  ScoreTrend,
  SeverityBadge,
  TranslationNote,
} from './PromsComponents';

/**
 * Portal: questionnaires the care team asked for (due, overdue or upcoming), a form to answer
 * them with immediate advice, and the person's own scores over time. A guardian acting for a
 * child sees only non-sensitive questionnaires (the young person answers the others themselves).
 */
export function PortalQuestionnairesPage() {
  const [params] = useSearchParams();
  const mine = useMyProms(params.get('for'));
  const defs = useInstruments();
  const [open, setOpen] = useState<string | null>(params.get('assignment'));
  const [result, setResult] = useState<SubmitResult | null>(null);
  const byCode = new Map<string, Instrument>(
    (defs.data?.instruments ?? []).map((i) => [i.code, i]),
  );

  return (
    <>
      <PageHeader
        title={t('My questionnaires')}
        subtitle={t('Short questionnaires from your care team about how you are feeling.')}
      />
      <QueryView query={mine}>
        {(data) => {
          const active = data.assignments;
          const answered = new Set(data.responses.map((r) => r.instrument));
          return (
            <div className="stack">
              {result && (
                <div aria-live="assertive" className="stack">
                  <AdviceAlert advice={result.advice} careTeamNotified={result.careTeamNotified} />
                  <Alert tone="success" title={t('Thank you – your answers have been sent')}>
                    {t('{name}: {score} – {severity}.', {
                      name: instrumentName(result.response.instrument),
                      score: scoreText(
                        byCode.get(result.response.instrument),
                        result.response.score,
                      ),
                      severity: severityLabel(result.response.severity),
                    })}{' '}
                    {result.change && <ChangeText change={result.change} />}
                  </Alert>
                </div>
              )}
              {data.acting && (
                <Alert tone="info">
                  {t(
                    'Some questionnaires are answered only by the young person in their own account, so you do not see them here.',
                  )}
                </Alert>
              )}
              <Card title={t('Questionnaires for you')}>
                {active.length === 0 ? (
                  <EmptyState title={t('No questionnaires at the moment')}>
                    {t('When your care team asks you to fill in a questionnaire, it appears here.')}
                  </EmptyState>
                ) : (
                  <div className="stack">
                    {active.map((a) => {
                      const inst = byCode.get(a.instrument);
                      return (
                        <section key={a.id} className="card" style={{ margin: 0 }}>
                          <div className="card-header">
                            <h3 style={{ margin: 0 }}>{instrumentName(a.instrument)}</h3>
                            <Badge tone={DUE_TONE[a.due]}>{dueLabel(a.due)}</Badge>
                          </div>
                          <p className="muted">
                            {[
                              frequencyLabel(a.frequency),
                              a.nextDueAt && t('next: {date}', { date: formatDate(a.nextDueAt) }),
                              t('asked by {name}', { name: a.assignedBy }),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                          {open === a.id && inst ? (
                            <QuestionnaireForm
                              instrument={inst}
                              assignmentId={a.id}
                              onDone={(r) => {
                                setResult(r);
                                setOpen(null);
                                window.scrollTo({ top: 0, behavior: 'smooth' });
                              }}
                              onCancel={() => setOpen(null)}
                            />
                          ) : (
                            <div className="row">
                              <Button
                                variant={a.due === 'UPCOMING' ? 'secondary' : 'primary'}
                                onClick={() => {
                                  setResult(null);
                                  setOpen(a.id);
                                }}
                              >
                                {a.due === 'UPCOMING'
                                  ? t('Answer now anyway')
                                  : t('Fill in the questionnaire')}
                              </Button>
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>
                )}
                <p className="muted">
                  {t(
                    'Your answers are read by your care team during working hours. If you feel unsafe or very unwell, call 112.',
                  )}
                </p>
                <TranslationNote />
              </Card>
              {[...answered].map((code) => {
                const inst = byCode.get(code);
                const rows = data.responses.filter((r) => r.instrument === code);
                return (
                  <Card key={code} title={instrumentName(code)}>
                    {inst && <ScoreTrend instrument={inst} responses={rows} />}
                    <Table caption={t('My answers: {name}', { name: instrumentName(code) })}>
                      <thead>
                        <tr>
                          <th>{t('Date')}</th>
                          <th>{t('Score')}</th>
                          <th>{t('Result|questionnaire')}</th>
                          <th>{t('Change')}</th>
                          <th>{t('Seen by the care team')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.id}>
                            <td>{formatDate(r.submittedAt)}</td>
                            <td>{scoreText(inst, r.score)}</td>
                            <td>
                              <SeverityBadge severity={r.severity} />
                            </td>
                            <td>
                              <ChangeText change={r.change} />
                            </td>
                            <td>
                              {r.reviewedAt
                                ? t('Yes, {date}', { date: formatDate(r.reviewedAt) })
                                : t('Not yet')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </Card>
                );
              })}
            </div>
          );
        }}
      </QueryView>
    </>
  );
}
