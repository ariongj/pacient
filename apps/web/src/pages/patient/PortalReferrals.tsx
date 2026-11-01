import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { Referral, ReferralStatus } from '../../api/types';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  QueryView,
  type Tone,
} from '../../components/ui';
import { formatDate } from '../../format';

const STATUS: Record<ReferralStatus, { tone: Tone; label: string }> = {
  PENDING: { tone: 'warning', label: 'Waiting for the receiving facility' },
  ACCEPTED: { tone: 'success', label: 'Accepted' },
  DECLINED: { tone: 'neutral', label: 'Declined' },
  COMPLETED: { tone: 'success', label: 'Completed' },
  CANCELLED: { tone: 'neutral', label: 'Cancelled' },
};

export function PortalReferrals() {
  const q = useQuery({
    queryKey: ['referrals', 'mine'],
    queryFn: () => api<{ items: Referral[] }>('/referrals'),
  });
  return (
    <>
      <PageHeader
        title="Referrals"
        subtitle="When your doctor sends you to another facility or specialist."
      />
      <Alert tone="info">
        When you are referred, the receiving facility sees the summary your doctor wrote. They can
        open your full record only after accepting the referral, and every access is shown under{' '}
        <strong>Who viewed my record</strong>.
      </Alert>
      <QueryView query={q}>
        {(d) =>
          d.items.length ? (
            <div className="stack">
              {d.items.map((r) => (
                <Card
                  key={r.id}
                  title={r.specialty}
                  actions={
                    <span className="row">
                      {r.priority === 'URGENT' && <Badge tone="danger">Urgent</Badge>}
                      <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                    </span>
                  }
                >
                  <p>
                    <strong>From</strong> {r.fromDoctorName}, {r.fromFacilityName}
                    <br />
                    <strong>To</strong> {r.toFacilityName}
                    {r.toDoctorName ? ` — ${r.toDoctorName}` : ''}
                  </p>
                  <p>
                    <strong>Reason:</strong> {r.reason}
                  </p>
                  <details>
                    <summary>Summary sent by your doctor</summary>
                    <div className="note">{r.clinicalSummary}</div>
                  </details>
                  {r.responseNote && (
                    <div className="addendum">
                      <strong>Response from the receiving facility:</strong> {r.responseNote}
                    </div>
                  )}
                  <p className="muted" style={{ fontSize: '0.85rem' }}>
                    Referred {formatDate(r.createdAt)}
                    {r.respondedAt ? ` · updated ${formatDate(r.respondedAt)}` : ''}
                  </p>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState title="You have no referrals" />
            </Card>
          )
        }
      </QueryView>
    </>
  );
}
