import { t } from '../../i18n';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  CONSENT_LABELS,
  DECISION_LABELS,
  decisionTone,
  METHOD_LABELS,
  useConsents,
  useRecordConsent,
  type ConsentText,
  type CurrentConsent,
} from '../../api/consent';
import {
  KIND_LABELS,
  STATUS_LABELS,
  statusTone,
  useCreateMyRequest,
  useMyRequests,
  type RequestKind,
} from '../../api/privacy';
import { useAuth, useUser } from '../../auth/AuthContext';
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  TextAreaField,
  formValues,
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';

/** Privacy & consent: the patient (or a full-scope guardian) manages sharing and research use. */
export function PortalConsents() {
  const user = useUser();
  const { acting } = useAuth();
  const patientId = acting?.patientId ?? user.patientId;
  const q = useConsents(patientId);

  return (
    <>
      <PageHeader
        title={t('Privacy & consent')}
        subtitle={
          acting
            ? t('How {name}’s health information may be used, and the decisions recorded.', {
                name: acting.firstName,
              })
            : t('How your health information may be used, and the decisions recorded.')
        }
      />
      {acting && (
        <Alert tone="info">
          {t(
            'You are deciding on behalf of your child, {name}. Your decisions are recorded as made by you as their guardian.',
            { name: acting.firstName },
          )}
        </Alert>
      )}
      {!patientId ? (
        <EmptyState title={t('No health record linked to this account')} />
      ) : (
        <QueryView query={q}>
          {(d) => (
            <div className="stack">
              {d.current.map((c) => {
                const text = d.texts.find((x) => x.type === c.type);
                return text ? (
                  <ConsentCard
                    key={c.type}
                    patientId={patientId}
                    current={c}
                    text={text}
                    forChild={Boolean(acting)}
                  />
                ) : null;
              })}

              <Card title={t('Treatment and procedures')}>
                <p className="muted">
                  {t(d.texts.find((x) => x.type === 'TREATMENT')?.summary ?? '')}{' '}
                  {acting
                    ? t('To change a decision, talk to the doctor.')
                    : t('To change a decision, talk to your doctor.')}
                </p>
                {d.treatment.length === 0 ? (
                  <EmptyState title={t('No treatment consent recorded')} />
                ) : (
                  <ul className="list">
                    {d.treatment.map((tr) => (
                      <li key={tr.id} className="row-between">
                        <span>
                          <strong>{tr.procedure}</strong>
                          <span className="muted" style={{ display: 'block' }}>
                            {t('{method} with {name}', {
                              method: tr.method ? METHOD_LABELS[tr.method] : '',
                              name: tr.recordedBy,
                            })}{' '}
                            · {formatDate(tr.recordedAt)}
                          </span>
                        </span>
                        <Badge tone={decisionTone(tr.decision)}>
                          {DECISION_LABELS[tr.decision]}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card title={t('History of decisions')}>
                {d.history.length === 0 ? (
                  <EmptyState title={t('No decisions recorded yet')}>
                    {t('The defaults described above apply until a decision is made.')}
                  </EmptyState>
                ) : (
                  <ul className="list">
                    {d.history.map((h) => (
                      <li key={h.id}>
                        <strong>
                          {h.recordedById === user.id
                            ? t('You')
                            : h.recordedByRole === 'DOCTOR'
                              ? t('{name} (doctor)', { name: h.recordedBy })
                              : h.recordedBy}{' '}
                          {verb(h.decision)}
                        </strong>{' '}
                        {h.type === 'TREATMENT'
                          ? t('consent to {procedure}', { procedure: h.procedure })
                          : CONSENT_LABELS[h.type].toLowerCase()}
                        <span className="muted" style={{ display: 'block' }}>
                          {formatDateTime(h.createdAt)} · {METHOD_LABELS[h.method]} ·{' '}
                          {t('wording {version}', { version: h.wordingVersion })}
                          {h.onBehalfGuardianshipId ? ` · ${t('by a guardian')}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <DataRightsCard forChild={Boolean(acting)} />
            </div>
          )}
        </QueryView>
      )}
    </>
  );
}

const verb = (d: string) =>
  d === 'GRANTED' ? t('agreed to') : d === 'REFUSED' ? t('refused') : t('withdrew');

function ConsentCard({
  patientId,
  current,
  text,
  forChild,
}: {
  patientId: string;
  current: CurrentConsent;
  text: ConsentText;
  forChild: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const record = useRecordConsent(patientId, () => setConfirm(false));
  const granted = current.decision === 'GRANTED';
  const next = granted ? 'WITHDRAWN' : 'GRANTED';
  const actionLabel = granted ? t('Withdraw consent') : t('Give consent');
  const title = t(text.title);

  return (
    <Card
      title={
        <span className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          {title}
          <Badge tone={decisionTone(current.decision)}>
            {granted ? t('On') : t('Off')}
            {current.isDefault ? ` ${t('(default)')}` : ''}
          </Badge>
        </span>
      }
    >
      {forChild && <p className="muted">{t('This decision applies to your child’s record.')}</p>}
      <p>{t(text.summary)}</p>
      <ul className="muted">
        {text.details.map((line) => (
          <li key={line}>{t(line)}</li>
        ))}
      </ul>
      <div className="row-between" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        <small className="muted">
          {current.isDefault
            ? t('No decision recorded – the default applies.')
            : t('{decision} on {date} ({method})', {
                decision: DECISION_LABELS[current.decision],
                date: formatDate(current.recordedAt),
                method: current.method ? METHOD_LABELS[current.method] : '',
              })}
        </small>
        <Button
          size="sm"
          variant={granted ? 'secondary' : 'primary'}
          onClick={() => setConfirm(true)}
        >
          {actionLabel}
        </Button>
      </div>
      {record.isSuccess && <Alert tone="success" title={t('Your decision was recorded')} />}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={actionLabel}>
        <div className="stack">
          <p>
            {granted
              ? t('You are withdrawing consent for: {what}.', { what: title.toLowerCase() })
              : t('You are agreeing to: {what}.', { what: title.toLowerCase() })}
          </p>
          {text.type === 'CROSS_FACILITY_SHARING' && granted && (
            <Alert tone="warning">
              {t(
                'Your doctor will need to talk to you before referring you to another facility. This can delay a referral. Emergency care at your own facility is not affected.',
              )}
            </Alert>
          )}
          <p className="muted">
            {t('You can change this again at any time. Wording {version}.', {
              version: text.version,
            })}
          </p>
          <ErrorAlert error={record.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t('Cancel')}
            </Button>
            <Button
              loading={record.isPending}
              onClick={() => record.mutate({ type: text.type, decision: next })}
            >
              {actionLabel}
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

const REQUESTABLE: RequestKind[] = ['RESTRICTION', 'OBJECTION', 'ERASURE'];

/** Rights under the data protection law; the copy and correction rights reuse existing tools. */
function DataRightsCard({ forChild }: { forChild: boolean }) {
  const q = useMyRequests();
  const [kind, setKind] = useState<RequestKind | null>(null);
  const create = useCreateMyRequest(() => setKind(null));
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e.currentTarget);
    create.mutate({ kind: v.kind as RequestKind, details: v.details || undefined });
  };

  return (
    <Card title={forChild ? t('Your child’s data rights') : t('Your data rights')}>
      <p className="muted">
        {t(
          'Under the Law on Protection of Personal Data you can get a copy of your data, have it corrected, restrict or object to its use, and ask for erasure. We answer within 30 days.',
        )}
      </p>
      <ul className="list">
        <li className="row-between">
          <span>
            <strong>{t('Get a copy of my data')}</strong>
            <span className="muted" style={{ display: 'block' }}>
              {t('Download your record, also in the FHIR format other systems can read.')}
            </span>
          </span>
          <Link className="btn btn-secondary btn-sm" to="/portal/account">
            {t('Download')}
          </Link>
        </li>
        <li className="row-between">
          <span>
            <strong>{t('Correct my data')}</strong>
            <span className="muted" style={{ display: 'block' }}>
              {t('Ask for a mistake in your record to be corrected.')}
            </span>
          </span>
          <Link className="btn btn-secondary btn-sm" to="/portal/account">
            {t('Request a correction')}
          </Link>
        </li>
        {REQUESTABLE.map((k) => (
          <li key={k} className="row-between">
            <span>
              <strong>{KIND_LABELS[k]}</strong>
              <span className="muted" style={{ display: 'block' }}>
                {k === 'RESTRICTION'
                  ? t('Ask us to limit how your data is used while a question is resolved.')
                  : k === 'OBJECTION'
                    ? t('Object to a use of your data, for example reminders or research.')
                    : t('Ask for data to be erased.')}
              </span>
            </span>
            <Button size="sm" variant="secondary" onClick={() => setKind(k)}>
              {t('Make a request')}
            </Button>
          </li>
        ))}
      </ul>

      <QueryView query={q}>
        {(d) =>
          d.items.length === 0 ? null : (
            <>
              <h3>{t('Your requests')}</h3>
              <ul className="list">
                {d.items.map((r) => (
                  <li key={r.id}>
                    <span className="row-between">
                      <strong>{KIND_LABELS[r.kind]}</strong>
                      <Badge tone={statusTone(r.status, r.overdue)}>
                        {STATUS_LABELS[r.status]}
                      </Badge>
                    </span>
                    <span className="muted" style={{ display: 'block' }}>
                      {t('Sent {date} · answer due by {due}', {
                        date: formatDate(r.receivedAt),
                        due: formatDate(r.dueAt),
                      })}
                    </span>
                    {r.outcome && <p>{r.outcome}</p>}
                  </li>
                ))}
              </ul>
            </>
          )
        }
      </QueryView>

      <Dialog
        open={kind !== null}
        onClose={() => setKind(null)}
        title={t('Data protection request')}
      >
        {kind && (
          <form className="stack" onSubmit={submit}>
            <SelectField
              label={t('Type of request')}
              name="kind"
              defaultValue={kind}
              options={REQUESTABLE.map((k) => ({ value: k, label: KIND_LABELS[k] }))}
            />
            {kind === 'ERASURE' && (
              <Alert tone="warning">
                {t(
                  'Health records must be kept for the period the law requires, so they cannot be erased during that time. We can erase other data, such as delivery logs, and you can add a statement to your record.',
                )}
              </Alert>
            )}
            <TextAreaField
              label={t('Describe your request')}
              name="details"
              required
              maxLength={2000}
              hint={t('Please do not include health details.')}
            />
            <ErrorAlert error={create.error} />
            <div className="form-actions">
              <Button variant="secondary" onClick={() => setKind(null)}>
                {t('Cancel')}
              </Button>
              <Button type="submit" loading={create.isPending}>
                {t('Send request')}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      {create.isSuccess && (
        <Alert tone="success" title={t('Your request was sent. We will answer within 30 days.')} />
      )}
    </Card>
  );
}
