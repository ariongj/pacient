import { useState, type FormEvent } from 'react';
import {
  episodeStatusLabel,
  PROGRAMME_TESTS,
  programmeAudience,
  programmeLabel,
  RESULT_TONE,
  resultLabel,
  STATE_TONE,
  stateLabel,
  testLabel,
  useCease,
  useEpisodeAction,
  useInvite,
  usePatientScreening,
  useStaffOptOut,
  type Episode,
  type PatientScreening,
  type ProgrammeCode,
  type ProgrammeStatus,
  type ScreeningResult,
} from '../../../api/screening';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  Grid,
  QueryView,
  SelectField,
  Table,
  TextField,
} from '../../../components/ui';
import { formatDate, formatDateTime } from '../../../format';
import { t } from '../../../i18n';

type DialogKind =
  | { kind: 'book' | 'test' | 'result' | 'decline' | 'close' | 'referral'; episode: Episode }
  | { kind: 'cease' | 'optOut'; programme: ProgrammeCode };

const localNow = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const toIso = (local: string) => new Date(local).toISOString();

function ActionDialog({
  patientId,
  data,
  dialog,
  onClose,
}: {
  patientId: string;
  data: PatientScreening;
  dialog: DialogKind;
  onClose: () => void;
}) {
  const action = useEpisodeAction(patientId, onClose);
  const cease = useCease(patientId, onClose);
  const optOut = useStaffOptOut(patientId, onClose);
  const [result, setResult] = useState<ScreeningResult>('NORMAL');
  const [routine, setRoutine] = useState('yes');
  const pending = action.isPending || cease.isPending || optOut.isPending;
  const error = action.error ?? cease.error ?? optOut.error;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '').trim();
    if (!('episode' in dialog)) {
      if (dialog.kind === 'cease')
        cease.mutate({ programme: dialog.programme, reason: get('reason') });
      else optOut.mutate({ programme: dialog.programme, reason: get('reason') || undefined });
      return;
    }
    const episodeId = dialog.episode.id;
    switch (dialog.kind) {
      case 'book':
        action.mutate({ episodeId, action: 'book', body: { bookedFor: toIso(get('bookedFor')) } });
        break;
      case 'test':
        action.mutate({
          episodeId,
          action: 'test',
          body: { screenedAt: toIso(get('screenedAt')), testType: get('testType') },
        });
        break;
      case 'result':
        action.mutate({
          episodeId,
          action: 'result',
          body: {
            result,
            resultDetail: get('resultDetail') || null,
            referralId: get('referralId') || null,
            ...(dialog.episode.screenedAt
              ? {}
              : { screenedAt: toIso(get('screenedAt')), testType: get('testType') }),
          },
        });
        break;
      case 'decline':
        action.mutate({ episodeId, action: 'decline', body: { reason: get('reason') } });
        break;
      case 'close':
        action.mutate({
          episodeId,
          action: 'close',
          body: {
            nextDueDate: routine === 'yes' ? get('nextDueDate') : null,
            note: get('note') || undefined,
          },
        });
        break;
      case 'referral':
        action.mutate({ episodeId, action: 'referral', body: { referralId: get('referralId') } });
        break;
    }
  }

  const programme = 'episode' in dialog ? dialog.episode.programme : dialog.programme;
  const tests = PROGRAMME_TESTS[programme].map((x) => ({ value: x, label: testLabel(x) }));
  const referralOptions = data.referrals.map((r) => ({
    value: r.id,
    label: `${formatDate(r.createdAt)} · ${r.specialty} · ${r.toFacilityName}`,
  }));
  const title = {
    book: t('Book the screening appointment'),
    test: t('Record the screening test'),
    result: t('Record the screening result'),
    decline: t('The patient declined this round'),
    close: t('Close the follow-up'),
    referral: t('Link the follow-up referral'),
    cease: t('Programme no longer applicable'),
    optOut: t('Record an opt-out'),
  }[dialog.kind];

  return (
    <Dialog open onClose={onClose} title={`${title} – ${programmeLabel(programme)}`}>
      <form onSubmit={onSubmit}>
        {dialog.kind === 'book' && (
          <TextField
            label={t('Appointment')}
            name="bookedFor"
            type="datetime-local"
            required
            defaultValue={localNow()}
          />
        )}
        {(dialog.kind === 'test' || (dialog.kind === 'result' && !dialog.episode.screenedAt)) && (
          <div className="form-grid">
            <TextField
              label={t('Test date|screening')}
              name="screenedAt"
              type="datetime-local"
              required
              defaultValue={localNow()}
              max={localNow()}
            />
            <SelectField
              label={t('Test')}
              name="testType"
              required
              defaultValue={dialog.episode.testType ?? tests[0]?.value}
              options={tests}
            />
          </div>
        )}
        {dialog.kind === 'result' && (
          <>
            <SelectField
              label={t('Result')}
              name="result"
              value={result}
              onChange={(e) => setResult(e.currentTarget.value as ScreeningResult)}
              options={(['NORMAL', 'INADEQUATE', 'ABNORMAL'] as const).map((r) => ({
                value: r,
                label: resultLabel(r),
              }))}
            />
            <TextField
              label={t('Result details|screening')}
              name="resultDetail"
              maxLength={300}
              hint={t('e.g. NILM, BI-RADS 2, FIT negative')}
            />
            {result === 'ABNORMAL' && (
              <>
                <Alert tone="warning" title={t('Follow-up')}>
                  {t(
                    'The patient’s doctor receives an urgent task. Record the referral now or link it later.',
                  )}
                </Alert>
                {referralOptions.length > 0 && (
                  <SelectField
                    label={t('Referral')}
                    name="referralId"
                    placeholder={t('Not yet referred')}
                    options={referralOptions}
                  />
                )}
              </>
            )}
          </>
        )}
        {(dialog.kind === 'decline' || dialog.kind === 'cease') && (
          <TextField
            label={t('Reason')}
            name="reason"
            required
            minLength={3}
            maxLength={300}
            hint={
              dialog.kind === 'cease'
                ? t(
                    'e.g. total hysterectomy, bilateral mastectomy, colectomy, specialist surveillance',
                  )
                : undefined
            }
          />
        )}
        {dialog.kind === 'cease' && (
          <p className="muted">
            {t(
              'No invitations are sent while the programme is not applicable. Inviting the patient again reinstates it.',
            )}
          </p>
        )}
        {dialog.kind === 'optOut' && (
          <>
            <p className="muted">
              {t(
                'The patient chose not to be invited. They can opt back in at any time, here or in the portal.',
              )}
            </p>
            <TextField label={t('Reason (optional)')} name="reason" maxLength={300} />
          </>
        )}
        {dialog.kind === 'close' && (
          <>
            <SelectField
              label={t('After the follow-up')}
              name="routine"
              value={routine}
              onChange={(e) => setRoutine(e.currentTarget.value)}
              options={[
                { value: 'yes', label: t('Return to routine screening') },
                { value: 'no', label: t('No further routine invitations') },
              ]}
            />
            {routine === 'yes' && (
              <TextField
                label={t('Next routine test from')}
                name="nextDueDate"
                type="date"
                required
              />
            )}
            <TextField label={t('Outcome note')} name="note" maxLength={300} />
          </>
        )}
        {dialog.kind === 'referral' &&
          (referralOptions.length ? (
            <SelectField
              label={t('Referral')}
              name="referralId"
              required
              options={referralOptions}
            />
          ) : (
            <p className="muted">
              {t('The patient has no referrals yet. Refer the patient first.')}
            </p>
          ))}
        <ErrorAlert error={error} />
        <div className="form-actions">
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            type="submit"
            loading={pending}
            disabled={dialog.kind === 'referral' && !referralOptions.length}
          >
            {t('Save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ProgrammeCard({
  status,
  data,
  patientId,
  open,
}: {
  status: ProgrammeStatus;
  data: PatientScreening;
  patientId: string;
  open: (d: DialogKind) => void;
}) {
  const invite = useInvite(patientId);
  const optOut = useStaffOptOut(patientId);
  const ep = status.openEpisode;
  const canInvite =
    data.canRecord &&
    !ep &&
    !status.optOut &&
    status.inPopulation &&
    !data.person.deceased &&
    status.state !== 'NOT_IN_POPULATION';
  return (
    <Card
      title={programmeLabel(status.programme)}
      actions={<Badge tone={STATE_TONE[status.state]}>{stateLabel(status.state)}</Badge>}
    >
      <p className="muted">{programmeAudience(status.programme)}</p>
      <dl className="dl">
        {status.inPopulation && (
          <div>
            <dt>{t('Test offered|screening')}</dt>
            <dd>{testLabel(status.testOffered)}</dd>
          </div>
        )}
        <div>
          <dt>{t('Last test|screening')}</dt>
          <dd>
            {status.lastScreenedAt ? formatDate(status.lastScreenedAt) : t('Never')}
            {status.lastResult && (
              <>
                {' '}
                <Badge tone={RESULT_TONE[status.lastResult]}>
                  {resultLabel(status.lastResult)}
                </Badge>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('Next due|screening')}</dt>
          <dd>{status.nextDueDate ? formatDate(status.nextDueDate) : '—'}</dd>
        </div>
        {ep && (
          <div>
            <dt>{t('Current round|screening')}</dt>
            <dd>
              {episodeStatusLabel(ep.status)}
              {ep.invitedAt && (
                <div className="muted">
                  {t('Invited {date}', { date: formatDate(ep.invitedAt) })}
                </div>
              )}
              {ep.bookedFor && (
                <div className="muted">
                  {t('Booked for {date}', { date: formatDateTime(ep.bookedFor) })}
                </div>
              )}
            </dd>
          </div>
        )}
      </dl>
      {status.invitationOverdue && (
        <Alert tone="warning" title={t('Invitation not taken up')}>
          {t('The patient was invited more than 12 weeks ago. Please remind them.')}
        </Alert>
      )}
      {status.state === 'FOLLOW_UP' && (
        <Alert tone="danger" title={t('Abnormal result under follow-up')}>
          {ep?.referralId
            ? t('A referral is recorded. Close the follow-up when it is complete.')
            : status.followUpOverdue
              ? t('No referral recorded more than 14 days after the result.')
              : t('No referral recorded yet.')}
        </Alert>
      )}
      {status.optOut && (
        <p className="muted">
          {t('Opted out on {date}', { date: formatDate(status.optOut.createdAt) })}
          {status.optOut.reason ? ` – ${status.optOut.reason}` : ''}
        </p>
      )}
      {data.canRecord && (
        <div className="form-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
          {canInvite && (
            <Button
              size="sm"
              loading={invite.isPending}
              onClick={() => invite.mutate({ programme: status.programme })}
            >
              {status.state === 'CEASED' ? t('Reinstate and invite') : t('Invite now|screening')}
            </Button>
          )}
          {ep && ['INVITED', 'BOOKED'].includes(ep.status) && (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => open({ kind: 'book', episode: ep })}
              >
                {t('Book|action')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => open({ kind: 'test', episode: ep })}
              >
                {t('Record the test')}
              </Button>
            </>
          )}
          {ep && ['INVITED', 'BOOKED', 'SCREENED'].includes(ep.status) && (
            <Button size="sm" onClick={() => open({ kind: 'result', episode: ep })}>
              {t('Record the result')}
            </Button>
          )}
          {ep && ['INVITED', 'BOOKED'].includes(ep.status) && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => open({ kind: 'decline', episode: ep })}
            >
              {t('Declined')}
            </Button>
          )}
          {ep?.status === 'REFERRED' && data.canDecide && (
            <>
              {!ep.referralId && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => open({ kind: 'referral', episode: ep })}
                >
                  {t('Link referral')}
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => open({ kind: 'close', episode: ep })}
              >
                {t('Close the follow-up')}
              </Button>
            </>
          )}
          {data.canDecide &&
            status.inPopulation &&
            status.state !== 'CEASED' &&
            status.state !== 'FOLLOW_UP' &&
            ep?.status !== 'SCREENED' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => open({ kind: 'cease', programme: status.programme })}
              >
                {t('Not applicable')}
              </Button>
            )}
          {status.optOut ? (
            <Button
              size="sm"
              variant="secondary"
              loading={optOut.isPending}
              onClick={() => optOut.mutate({ programme: status.programme, withdraw: true })}
            >
              {t('Opt back in|screening')}
            </Button>
          ) : (
            status.inPopulation && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => open({ kind: 'optOut', programme: status.programme })}
              >
                {t('Record opt-out')}
              </Button>
            )
          )}
        </div>
      )}
      <ErrorAlert error={invite.error ?? optOut.error} />
    </Card>
  );
}

/** Programmes outside the person's age and sex range without any history are listed, not shown. */
const relevant = (data: PatientScreening, s: ProgrammeStatus) =>
  s.state !== 'NOT_IN_POPULATION' || data.history.some((h) => h.programme === s.programme);
const shown = (data: PatientScreening) => data.programmes.filter((s) => relevant(data, s));
const hidden = (data: PatientScreening) => data.programmes.filter((s) => !relevant(data, s));

/** Cancer screening in the chart: programmes, the current round with its actions, history. */
export function ScreeningTab({ patientId }: { patientId: string }) {
  const query = usePatientScreening(patientId);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  return (
    <QueryView query={query}>
      {(data) => (
        <div className="stack">
          <p className="muted">
            {t(
              'Age ranges, intervals and tests are illustrative until confirmed by the national cancer control programme.',
            )}
          </p>
          <Grid min={300}>
            {shown(data).map((s) => (
              <ProgrammeCard
                key={s.programme}
                status={s}
                data={data}
                patientId={patientId}
                open={setDialog}
              />
            ))}
          </Grid>
          {hidden(data).length > 0 && (
            <p className="muted">
              {t('Not in the age or sex range of: {programmes}', {
                programmes: hidden(data)
                  .map((s) => programmeLabel(s.programme))
                  .join(', '),
              })}
            </p>
          )}
          <Card title={t('Screening history')}>
            {data.history.length === 0 ? (
              <EmptyState title={t('No screening recorded')} />
            ) : (
              <Table caption={t('Screening history')}>
                <thead>
                  <tr>
                    <th>{t('Programme|screening')}</th>
                    <th>{t('Status')}</th>
                    <th>{t('Test')}</th>
                    <th>{t('Result')}</th>
                    <th>{t('Next due|screening')}</th>
                    <th>{t('Facility')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((h) => (
                    <tr key={h.id}>
                      <td>
                        {programmeLabel(h.programme)}
                        <div className="muted">{formatDate(h.invitedAt ?? h.createdAt)}</div>
                      </td>
                      <td>
                        {episodeStatusLabel(h.status)}
                        {(h.status === 'DECLINED' || h.status === 'NOT_ELIGIBLE') &&
                          h.resultDetail && <div className="muted">{h.resultDetail}</div>}
                      </td>
                      <td>
                        {h.testType ? testLabel(h.testType) : '—'}
                        {h.screenedAt && <div className="muted">{formatDate(h.screenedAt)}</div>}
                      </td>
                      <td>
                        {h.result ? (
                          <>
                            <Badge tone={RESULT_TONE[h.result]}>{resultLabel(h.result)}</Badge>
                            {h.resultDetail && <div className="muted">{h.resultDetail}</div>}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>{h.nextDueDate ? formatDate(h.nextDueDate) : '—'}</td>
                      <td>
                        {h.facilityName}
                        {h.recordedBy && <div className="muted">{h.recordedBy}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          {dialog && (
            <ActionDialog
              patientId={patientId}
              data={data}
              dialog={dialog}
              onClose={() => setDialog(null)}
            />
          )}
        </div>
      )}
    </QueryView>
  );
}
