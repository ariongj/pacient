import { useState, type FormEvent, type ReactNode } from 'react';
import {
  BODY_MAX,
  categoryLabel,
  looksLikePersonalNumber,
  STATUS_TONE,
  statusLabel,
  type OperatorRequestDetail,
  type RequestStatus,
} from '../../api/operatorRequests';
import { Badge, Button, ErrorAlert, TextAreaField } from '../../components/ui';
import { formatDateTime } from '../../format';
import { t } from '../../i18n';

/**
 * Pieces shared by the facilities' pages (Contact the operator) and the administrators' inbox:
 * badges, the conversation and the message form with its "no patient information" check.
 */

export type Audience = 'admin' | 'facility';

export function RequestStatusBadge({
  status,
  audience,
}: {
  status: RequestStatus;
  audience: Audience;
}) {
  return <Badge tone={STATUS_TONE[status]}>{statusLabel(status, audience)}</Badge>;
}

export function PriorityBadge({ priority }: { priority: 'NORMAL' | 'HIGH' }) {
  return priority === 'HIGH' ? <Badge tone="danger">{t('High priority')}</Badge> : null;
}

/** The note every request form carries: requests are about the service, never a patient. */
export const NO_PATIENT_INFO = () =>
  t('Do not include patient information: no names, personal numbers or health details.');

/** What the server would refuse, said before sending. */
export const patientNumberProblem = (text: string) =>
  looksLikePersonalNumber(text)
    ? t(
        'This text contains a 10-digit number that looks like a personal number. Remove it: requests are never about a patient.',
      )
    : undefined;

/**
 * The conversation, oldest first. The own side (the facility's messages for the facility, the
 * operator's for an administrator) is on the right.
 */
export function Conversation({
  request,
  audience,
}: {
  request: OperatorRequestDetail;
  audience: Audience;
}) {
  return (
    <ol className="chat" aria-label={t('Conversation')} style={{ listStyle: 'none', margin: 0 }}>
      {request.messages.map((m) => {
        const mine = audience === 'admin' ? m.fromOperator : !m.fromOperator;
        const author = m.fromOperator
          ? audience === 'admin'
            ? t('{name} (operator)', { name: m.authorName ?? '' })
            : t('The operator')
          : (m.authorName ?? '—');
        return (
          <li key={m.id} className={`bubble ${mine ? 'bubble-mine' : ''}`}>
            {m.body}
            <div className="bubble-meta">
              {author} · {formatDateTime(m.createdAt)}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Details of a request for a definition list. */
export function requestFacts(r: OperatorRequestDetail, audience: Audience): [string, ReactNode][] {
  return [
    [t('Reference|request'), <code key="r">{r.reference}</code>],
    [t('Category'), categoryLabel(r.category)],
    [
      t('Status'),
      <span key="s" className="row">
        <RequestStatusBadge status={r.status} audience={audience} />
        <PriorityBadge priority={r.priority} />
      </span>,
    ],
    [t('Requested by'), r.requesterName],
    [t('Opened|request'), formatDateTime(r.createdAt)],
    [t('First answer'), r.firstResponseAt ? formatDateTime(r.firstResponseAt) : '—'],
    ...(r.resolvedAt
      ? ([[t('Resolved on'), formatDateTime(r.resolvedAt)]] as [string, ReactNode][])
      : []),
  ];
}

/**
 * A message box with the patient-information note and check; `extra` adds fields (the
 * administrator's status after sending). Cleared after a successful send.
 */
export function MessageForm({
  label,
  submitLabel,
  pending,
  error,
  hint,
  extra,
  onSend,
}: {
  label: string;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  hint?: ReactNode;
  extra?: ReactNode;
  onSend: (body: string, form: HTMLFormElement) => Promise<unknown>;
}) {
  const [body, setBody] = useState('');
  const problem = patientNumberProblem(body);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (problem || !body.trim()) return;
    try {
      await onSend(body.trim(), e.currentTarget);
      setBody('');
    } catch {
      /* shown by the error alert */
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="stack">
      <TextAreaField
        label={label}
        name="body"
        required
        minLength={2}
        maxLength={BODY_MAX}
        rows={5}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        hint={NO_PATIENT_INFO()}
        error={problem}
      />
      {hint && <p className="muted">{hint}</p>}
      {extra}
      <ErrorAlert error={error} />
      <div className="form-actions">
        <Button type="submit" loading={pending} disabled={Boolean(problem)}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
