import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { Referral, ReferralStatus } from '../../api/types';
import { useUser } from '../../auth/AuthContext';
import {
  Alert,
  Card,
  EmptyState,
  ErrorAlert,
  PageHeader,
  QueryView,
  SelectField,
  TabPanel,
  Tabs,
} from '../../components/ui';
import { humanize } from '../../format';
import { AcceptAssignDialog, ResponseNoteDialog } from './referrals/ReferralDialogs';
import { availableActions, ReferralItem, type ReferralAction } from './referrals/ReferralItem';

type Direction = 'incoming' | 'outgoing';
const STATUSES: ReferralStatus[] = ['PENDING', 'ACCEPTED', 'DECLINED', 'COMPLETED', 'CANCELLED'];

type Pending =
  | { kind: 'accept-assign'; referral: Referral }
  | { kind: 'decline' | 'complete'; referral: Referral }
  | null;

/**
 * Referrals for doctors and directors. Incoming = referrals to my facility (doctors: routed to me
 * or not yet routed); outgoing = referrals I (doctor) or my facility (director) sent.
 */
export function ReferralsPage() {
  const user = useUser();
  const qc = useQueryClient();
  const [direction, setDirection] = useState<Direction>('incoming');
  const [status, setStatus] = useState<ReferralStatus | ''>('');
  const [dialog, setDialog] = useState<Pending>(null);

  const list = useQuery({
    queryKey: ['referrals', direction, status],
    queryFn: () =>
      api<{ items: Referral[] }>('/referrals', {
        query: { direction, status: status || undefined },
      }),
  });

  const act = useMutation({
    mutationFn: ({ id, verb, body }: { id: string; verb: string; body?: object }) =>
      api<Referral>(`/referrals/${id}/${verb}`, { method: 'POST', body: body ?? {} }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['referrals'] });
      void qc.invalidateQueries({ queryKey: ['worklist'] });
      void qc.invalidateQueries({ queryKey: ['patient', r.patientId] });
      setDialog(null);
    },
  });

  const me = { id: user.id, role: user.role, facilityId: user.facility?.id ?? null };

  /** The referring doctor, and the receiving doctor once accepted, are in the care team. */
  const canOpenRecord = (r: Referral) =>
    user.role === 'DOCTOR' &&
    (r.fromDoctorId === user.id ||
      (r.toDoctorId === user.id && (r.status === 'ACCEPTED' || r.status === 'COMPLETED')));

  function onAction(r: Referral, action: ReferralAction) {
    act.reset();
    switch (action) {
      case 'accept':
        act.mutate({ id: r.id, verb: 'accept' });
        break;
      case 'cancel':
        if (window.confirm(`Cancel the referral of ${r.patientName} to ${r.toFacilityName}?`)) {
          act.mutate({ id: r.id, verb: 'cancel' });
        }
        break;
      case 'accept-assign':
        setDialog({ kind: 'accept-assign', referral: r });
        break;
      case 'decline':
      case 'complete':
        setDialog({ kind: action, referral: r });
        break;
    }
  }

  return (
    <>
      <PageHeader
        title="Referrals"
        subtitle={
          user.role === 'DIRECTOR'
            ? `Referrals to and from ${user.facility?.name ?? 'your facility'}`
            : 'Referrals you sent and referrals to your facility'
        }
      />
      <Alert tone="info">
        A pending referral shares only the referring doctor’s written summary. Accepting it gives
        the assigned doctor access to the patient’s record through the care team. Every step is
        audited and visible to the patient.
      </Alert>
      <Card>
        <div className="row-between">
          <Tabs<Direction>
            label="Referral direction"
            active={direction}
            onChange={setDirection}
            tabs={[
              { id: 'incoming', label: 'Incoming' },
              { id: 'outgoing', label: 'Outgoing' },
            ]}
          />
          <div style={{ minWidth: 200 }}>
            <SelectField
              label="Status"
              value={status}
              onChange={(e) => setStatus(e.target.value as ReferralStatus | '')}
              placeholder="All statuses"
              options={STATUSES.map((s) => ({ value: s, label: humanize(s) }))}
            />
          </div>
        </div>
        <ErrorAlert error={dialog ? null : act.error} />
        <TabPanel id={direction}>
          <QueryView query={list}>
            {(d) =>
              d.items.length === 0 ? (
                <EmptyState title={`No ${direction} referrals`}>
                  {direction === 'outgoing' && user.role === 'DOCTOR'
                    ? 'Refer a patient from their chart using the “Refer” button.'
                    : undefined}
                </EmptyState>
              ) : (
                <ul className="list">
                  {d.items.map((r) => (
                    <ReferralItem
                      key={r.id}
                      referral={r}
                      actions={availableActions(r, me)}
                      busy={act.isPending}
                      canOpenRecord={canOpenRecord(r)}
                      onAction={(a) => onAction(r, a)}
                    />
                  ))}
                </ul>
              )
            }
          </QueryView>
        </TabPanel>
      </Card>

      <AcceptAssignDialog
        referral={dialog?.kind === 'accept-assign' ? dialog.referral : null}
        busy={act.isPending}
        error={act.error}
        onClose={() => setDialog(null)}
        onSubmit={(body) => dialog && act.mutate({ id: dialog.referral.id, verb: 'accept', body })}
      />
      <ResponseNoteDialog
        referral={dialog && dialog.kind !== 'accept-assign' ? dialog.referral : null}
        kind={dialog?.kind === 'complete' ? 'complete' : 'decline'}
        busy={act.isPending}
        error={act.error}
        onClose={() => setDialog(null)}
        onSubmit={(body) =>
          dialog && act.mutate({ id: dialog.referral.id, verb: dialog.kind, body })
        }
      />
    </>
  );
}
