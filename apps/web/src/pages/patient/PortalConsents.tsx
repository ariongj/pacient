import { useState } from 'react';
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
} from '../../components/ui';
import { formatDate, formatDateTime } from '../../format';

/** Privacy & consent: the patient (or a full-scope guardian) manages sharing and research use. */
export function PortalConsents() {
  const user = useUser();
  const { acting } = useAuth();
  const patientId = acting?.patientId ?? user.patientId;
  const q = useConsents(patientId);
  const whose = acting ? `${acting.firstName}’s` : 'your';

  return (
    <>
      <PageHeader
        title="Privacy & consent"
        subtitle={`How ${whose} health information may be used, and the decisions recorded.`}
      />
      {acting && (
        <Alert tone="info">
          You are deciding on behalf of your child, {acting.firstName}. Your decisions are recorded
          as made by you as their guardian.
        </Alert>
      )}
      {!patientId ? (
        <EmptyState title="No health record linked to this account" />
      ) : (
        <QueryView query={q}>
          {(d) => (
            <div className="stack">
              {d.current.map((c) => {
                const text = d.texts.find((t) => t.type === c.type);
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

              <Card title="Treatment and procedures">
                <p className="muted">
                  {d.texts.find((t) => t.type === 'TREATMENT')?.summary} To change a decision, talk
                  to {acting ? 'the' : 'your'} doctor.
                </p>
                {d.treatment.length === 0 ? (
                  <EmptyState title="No treatment consent recorded" />
                ) : (
                  <ul className="list">
                    {d.treatment.map((t) => (
                      <li key={t.id} className="row-between">
                        <span>
                          <strong>{t.procedure}</strong>
                          <span className="muted" style={{ display: 'block' }}>
                            {t.method ? METHOD_LABELS[t.method] : ''} with {t.recordedBy} ·{' '}
                            {formatDate(t.recordedAt)}
                          </span>
                        </span>
                        <Badge tone={decisionTone(t.decision)}>{DECISION_LABELS[t.decision]}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card title="History of decisions">
                {d.history.length === 0 ? (
                  <EmptyState title="No decisions recorded yet">
                    The defaults described above apply until a decision is made.
                  </EmptyState>
                ) : (
                  <ul className="list">
                    {d.history.map((h) => (
                      <li key={h.id}>
                        <strong>
                          {h.recordedById === user.id
                            ? 'You'
                            : `${h.recordedBy}${h.recordedByRole === 'DOCTOR' ? ' (doctor)' : ''}`}{' '}
                          {verb(h.decision)}
                        </strong>{' '}
                        {h.type === 'TREATMENT'
                          ? `consent to ${h.procedure}`
                          : CONSENT_LABELS[h.type].toLowerCase()}
                        <span className="muted" style={{ display: 'block' }}>
                          {formatDateTime(h.createdAt)} · {METHOD_LABELS[h.method]} · wording{' '}
                          {h.wordingVersion}
                          {h.onBehalfGuardianshipId ? ' · by a guardian' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          )}
        </QueryView>
      )}
    </>
  );
}

const verb = (d: string) =>
  d === 'GRANTED' ? 'agreed to' : d === 'REFUSED' ? 'refused' : 'withdrew';

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
  const actionLabel = granted ? 'Withdraw consent' : 'Give consent';

  return (
    <Card
      title={
        <span className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          {text.title}
          <Badge tone={decisionTone(current.decision)}>
            {granted ? 'On' : 'Off'}
            {current.isDefault ? ' (default)' : ''}
          </Badge>
        </span>
      }
    >
      {forChild && <p className="muted">This decision applies to your child’s record.</p>}
      <p>{text.summary}</p>
      <ul className="muted">
        {text.details.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="row-between" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
        <small className="muted">
          {current.isDefault
            ? 'No decision recorded – the default applies.'
            : `${DECISION_LABELS[current.decision]} on ${formatDate(current.recordedAt)} (${
                current.method ? METHOD_LABELS[current.method] : ''
              })`}
        </small>
        <Button
          size="sm"
          variant={granted ? 'secondary' : 'primary'}
          onClick={() => setConfirm(true)}
        >
          {actionLabel}
        </Button>
      </div>
      {record.isSuccess && <Alert tone="success" title="Your decision was recorded" />}
      <Dialog open={confirm} onClose={() => setConfirm(false)} title={actionLabel}>
        <div className="stack">
          <p>
            {granted
              ? `You are withdrawing consent for: ${text.title.toLowerCase()}.`
              : `You are agreeing to: ${text.title.toLowerCase()}.`}
          </p>
          {text.type === 'CROSS_FACILITY_SHARING' && granted && (
            <Alert tone="warning">
              Your doctor will need to talk to you before referring you to another facility. This
              can delay a referral. Emergency care at your own facility is not affected.
            </Alert>
          )}
          <p className="muted">You can change this again at any time. Wording {text.version}.</p>
          <ErrorAlert error={record.error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Cancel
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
