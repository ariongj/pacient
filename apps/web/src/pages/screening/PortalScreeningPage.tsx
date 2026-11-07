import { useState, type FormEvent } from 'react';
import {
  programmeAudience,
  programmeLabel,
  STATE_TONE,
  stateLabel,
  testLabel,
  useMyOptOut,
  useMyScreening,
  type MyScreening,
  type ProgrammeCode,
  type ScreeningResult,
} from '../../api/screening';
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
  Table,
  TextField,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';
import { t } from '../../i18n';

type Programme = MyScreening['programmes'][number];

/** Results in plain words for the person (no medical jargon, no alarm). */
function plainResult(r: ScreeningResult): string {
  return {
    NORMAL: t('Normal – no changes were found.'),
    INADEQUATE: t(
      'The sample could not be read. The test needs to be repeated; this is not a sign of illness.',
    ),
    ABNORMAL: t('A further check is needed.'),
  }[r];
}

function explanation(p: Programme): string {
  switch (p.state) {
    case 'DUE':
      return t(
        'You are due for this screening. Please contact your family medicine centre to book an appointment.',
      );
    case 'IN_PROGRESS': {
      const ep = p.openEpisode!;
      if (ep.screenedAt) {
        return t('Your test was taken on {date}. You will be told when the result is ready.', {
          date: formatDate(ep.screenedAt),
        });
      }
      if (ep.bookedFor) {
        return t('Your appointment is on {date}.', { date: formatDateTime(ep.bookedFor) });
      }
      return t('You were invited on {date}. Please contact your family medicine centre to book.', {
        date: formatDate(ep.invitedAt),
      });
    }
    case 'UP_TO_DATE':
      return p.nextDueDate
        ? t('You are up to date. Your next test is due from {date}; we will invite you.', {
            date: formatDate(p.nextDueDate),
          })
        : t('You are up to date.');
    case 'FOLLOW_UP':
      return t(
        'Your last result needs a further check. This is common, and most people who have one do not have cancer. Your doctor will contact you – if you have not heard from them, please call your family medicine centre.',
      );
    case 'LEFT':
      return t('You will not be invited again for this programme because of your age.');
    case 'CEASED':
      return t('Your doctor recorded that this programme no longer applies to you.');
    case 'OPTED_OUT':
      return t('You chose not to be invited. You can opt back in at any time.');
    case 'NOT_IN_POPULATION':
      return t('This programme is not for your age group at the moment.');
  }
}

function OptOutDialog({ programme, onClose }: { programme: ProgrammeCode; onClose: () => void }) {
  const optOut = useMyOptOut(onClose);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    optOut.mutate({ programme, reason: reason || undefined });
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('Stop invitations: {programme}', { programme: programmeLabel(programme) })}
    >
      <form onSubmit={onSubmit}>
        <p>
          {t(
            'Screening can find changes early, when they are easier to treat. If you stop the invitations, you will not be invited until you opt back in. Your doctor can still talk to you about screening.',
          )}
        </p>
        <TextField label={t('Reason (optional)')} name="reason" maxLength={300} />
        <ErrorAlert error={optOut.error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button type="submit" variant="danger" loading={optOut.isPending}>
            {t('Stop invitations')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ProgrammeCard({ p, onOptOut }: { p: Programme; onOptOut: () => void }) {
  const optIn = useMyOptOut();
  return (
    <Card
      title={programmeLabel(p.programme)}
      actions={<Badge tone={STATE_TONE[p.state]}>{stateLabel(p.state)}</Badge>}
    >
      <p className="muted">{programmeAudience(p.programme)}</p>
      {p.state === 'FOLLOW_UP' ? (
        <Alert tone="warning" title={t('A further check is needed')}>
          {explanation(p)}
        </Alert>
      ) : (
        <p>{explanation(p)}</p>
      )}
      {p.lastScreenedAt && p.lastResult && p.state !== 'FOLLOW_UP' && (
        <p className="muted">
          {t('Last test on {date}: {result}', {
            date: formatDate(p.lastScreenedAt),
            result: plainResult(p.lastResult),
          })}
        </p>
      )}
      {p.inPopulation && p.state !== 'NOT_IN_POPULATION' && (
        <p className="muted">{t('Test: {test}', { test: testLabel(p.testOffered) })}</p>
      )}
      <div className="form-actions" style={{ justifyContent: 'flex-start' }}>
        {p.optedOut ? (
          <Button
            size="sm"
            loading={optIn.isPending}
            onClick={() => optIn.mutate({ programme: p.programme, withdraw: true })}
          >
            {t('Opt back in|screening')}
          </Button>
        ) : (
          p.inPopulation &&
          p.state !== 'FOLLOW_UP' && (
            <Button size="sm" variant="secondary" onClick={onOptOut}>
              {t('Stop invitations')}
            </Button>
          )
        )}
      </div>
      <ErrorAlert error={optIn.error} />
    </Card>
  );
}

/** The person's cancer screening programmes, results in plain words and their choices. */
export function PortalScreeningPage() {
  const query = useMyScreening();
  const [optOut, setOptOut] = useState<ProgrammeCode | null>(null);
  return (
    <>
      <PageHeader
        title={t('My screening')}
        subtitle={t(
          'Free screening tests that look for early signs of cervical, breast and bowel cancer in people without symptoms.',
        )}
      />
      <QueryView query={query}>
        {(data) => {
          const relevant = data.programmes.filter(
            (p) => p.inPopulation || p.state !== 'NOT_IN_POPULATION' || p.lastScreenedAt,
          );
          return (
            <div className="stack">
              <Alert tone="info" title={t('If you have symptoms')}>
                {t(
                  'Screening is for people without symptoms. If you notice a change in your body, do not wait for an invitation – see your doctor.',
                )}
              </Alert>
              {relevant.length === 0 ? (
                <EmptyState title={t('No screening programme for your age group yet')}>
                  {t('We will invite you when you reach the age for a programme.')}
                </EmptyState>
              ) : (
                <Grid min={300}>
                  {relevant.map((p) => (
                    <ProgrammeCard
                      key={p.programme}
                      p={p}
                      onOptOut={() => setOptOut(p.programme)}
                    />
                  ))}
                </Grid>
              )}
              {data.history.some((h) => h.screenedAt) && (
                <Card title={t('My screening tests')}>
                  <Table caption={t('My screening tests')}>
                    <thead>
                      <tr>
                        <th>{t('Date')}</th>
                        <th>{t('Programme|screening')}</th>
                        <th>{t('Test')}</th>
                        <th>{t('Result')}</th>
                        <th>{t('Facility')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.history
                        .filter((h) => h.screenedAt)
                        .map((h) => (
                          <tr key={h.id}>
                            <td>{formatDate(h.screenedAt)}</td>
                            <td>{programmeLabel(h.programme)}</td>
                            <td>{h.testType ? testLabel(h.testType) : '—'}</td>
                            <td>
                              {h.result ? plainResult(h.result) : t('Result awaited|screening')}
                            </td>
                            <td>{h.facilityName}</td>
                          </tr>
                        ))}
                    </tbody>
                  </Table>
                </Card>
              )}
              <p className="muted">
                {t(
                  'Age ranges, intervals and tests are illustrative until confirmed by the national cancer control programme.',
                )}
              </p>
            </div>
          );
        }}
      </QueryView>
      {optOut && <OptOutDialog programme={optOut} onClose={() => setOptOut(null)} />}
    </>
  );
}
