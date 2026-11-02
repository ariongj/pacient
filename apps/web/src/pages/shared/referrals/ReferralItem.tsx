import { Link } from 'react-router-dom';
import type { Referral, Role } from '../../../api/types';
import { Badge, Button, StatusBadge } from '../../../components/ui';
import { age, formatDate, formatDateTime, humanize } from '../../../format';
import { t } from '../../../i18n';

export type ReferralAction = 'accept' | 'accept-assign' | 'decline' | 'complete' | 'cancel';

/** Which actions the current user may take; mirrors the server's rules in referrals.routes.ts. */
export function availableActions(
  r: Referral,
  me: { id: string; role: Role; facilityId: string | null },
): ReferralAction[] {
  const incoming = r.toFacilityId === me.facilityId;
  const out: ReferralAction[] = [];
  if (r.status === 'PENDING' && incoming) {
    if (me.role === 'DOCTOR' && (!r.toDoctorId || r.toDoctorId === me.id))
      out.push('accept', 'decline');
    if (me.role === 'DIRECTOR') out.push('accept-assign', 'decline');
  }
  if (r.status === 'ACCEPTED' && me.role === 'DOCTOR' && r.toDoctorId === me.id)
    out.push('complete');
  if (r.status === 'PENDING' && me.role === 'DOCTOR' && r.fromDoctorId === me.id)
    out.push('cancel');
  return out;
}

const ACTION_LABEL: Record<ReferralAction, string> = {
  accept: 'Accept (I will see this patient)',
  'accept-assign': 'Accept and assign',
  decline: 'Decline',
  complete: 'Mark completed',
  cancel: 'Cancel referral',
};

export function ReferralItem({
  referral: r,
  actions,
  busy,
  canOpenRecord,
  onAction,
}: {
  referral: Referral;
  actions: ReferralAction[];
  busy: boolean;
  canOpenRecord: boolean;
  onAction: (action: ReferralAction) => void;
}) {
  return (
    <li>
      <div className="row-between">
        <span className="row">
          {r.priority === 'URGENT' ? (
            <Badge tone="danger">{t('Urgent')}</Badge>
          ) : (
            <Badge tone="neutral">{t('Routine')}</Badge>
          )}
          <StatusBadge value={r.status} />
          <strong>{r.specialty}</strong>
        </span>
        <span className="muted">{t('Sent {date}', { date: formatDateTime(r.createdAt) })}</span>
      </div>
      <p style={{ margin: '0.4rem 0' }}>
        <strong>{r.patientName}</strong> · {t('{age} y', { age: age(r.patientDateOfBirth) })} ·{' '}
        {humanize(r.patientSex)}
        {' — '}
        {r.reason}
      </p>
      <div className="muted">
        {t('From {doctor} ({facility})', {
          doctor: r.fromDoctorName,
          facility: r.fromFacilityName,
        })}{' '}
        → {r.toFacilityName}
        {r.toDoctorName ? `, ${r.toDoctorName}` : ` ${t('(no doctor assigned yet)')}`}
        {r.respondedAt ? ` · ${t('updated {date}', { date: formatDate(r.respondedAt) })}` : ''}
      </div>
      <details style={{ marginTop: '0.4rem' }}>
        <summary>
          {r.responseNote ? t('Clinical summary and response') : t('Clinical summary')}
        </summary>
        <div className="note">{r.clinicalSummary}</div>
        {r.responseNote && (
          <div className="addendum">
            <strong>{t('Response:')}</strong> {r.responseNote}
          </div>
        )}
      </details>
      {(actions.length > 0 || canOpenRecord) && (
        <div className="row" style={{ marginTop: '0.5rem' }}>
          {canOpenRecord && (
            <Link className="btn btn-secondary btn-sm" to={`/doctor/patients/${r.patientId}`}>
              {t('Open patient record')}
            </Link>
          )}
          {actions.map((a) => (
            <Button
              key={a}
              size="sm"
              variant={a === 'decline' || a === 'cancel' ? 'secondary' : 'primary'}
              disabled={busy}
              onClick={() => onAction(a)}
            >
              {t(ACTION_LABEL[a])}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}
