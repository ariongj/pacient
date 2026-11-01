import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import type { EmergencyAccessEvent, ReviewOutcome } from '../../api/types';
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
  TabPanel,
  Table,
  Tabs,
  TextAreaField,
  type Tone,
} from '../../components/ui';
import { formatDateTime } from '../../format';

type Filter = 'unreviewed' | 'reviewed' | 'all';

export const OUTCOME_LABEL: Record<ReviewOutcome, string> = {
  APPROPRIATE: 'Appropriate',
  INAPPROPRIATE: 'Inappropriate',
  NEEDS_FOLLOW_UP: 'Needs follow-up',
};
const OUTCOME_TONE: Record<ReviewOutcome, Tone> = {
  APPROPRIATE: 'success',
  INAPPROPRIATE: 'danger',
  NEEDS_FOLLOW_UP: 'warning',
};
const OUTCOME_HELP: Record<ReviewOutcome, string> = {
  APPROPRIATE: 'Appropriate — a genuine emergency justified opening the record.',
  INAPPROPRIATE:
    'Inappropriate — the access was not justified; follow your disciplinary and breach procedures.',
  NEEDS_FOLLOW_UP:
    'Needs follow-up — unclear; further investigation or a conversation is required.',
};

function ReviewDialog({ event, onClose }: { event: EmergencyAccessEvent; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [outcome, setOutcome] = useState<ReviewOutcome>('APPROPRIATE');
  const mutation = useMutation({
    mutationFn: (body: { outcome: ReviewOutcome; notes: string }) =>
      api(`/emergency-access/${event.id}/review`, { method: 'POST', body }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['emergency-access'] });
      queryClient.invalidateQueries({ queryKey: ['stats'] });
      onClose();
    },
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    mutation.mutate({ outcome, notes: String(f.get('notes') ?? '').trim() });
  }

  return (
    <form onSubmit={onSubmit}>
      <p>
        <strong>{event.doctorName}</strong> opened the record of{' '}
        <strong>{event.patientName}</strong> on {formatDateTime(event.createdAt)}.
      </p>
      <p className="muted">Stated reason: “{event.reason}”</p>
      <p className="muted">
        During the access window: {event.recordViews} record view(s), {event.recordChanges} clinical
        change(s).
      </p>
      <SelectField
        label="Outcome"
        name="outcome"
        required
        value={outcome}
        onChange={(e) => setOutcome(e.target.value as ReviewOutcome)}
        options={(Object.keys(OUTCOME_LABEL) as ReviewOutcome[]).map((o) => ({
          value: o,
          label: OUTCOME_LABEL[o],
        }))}
        hint={OUTCOME_HELP[outcome]}
      />
      <TextAreaField
        label="Review notes"
        name="notes"
        required
        minLength={5}
        maxLength={2000}
        hint="Record what you checked (e.g. ward log, conversation with the doctor)."
      />
      <ErrorAlert error={mutation.error} />
      <div className="form-actions">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" loading={mutation.isPending}>
          Save review
        </Button>
      </div>
    </form>
  );
}

function EventsTable({
  events,
  onReview,
}: {
  events: EmergencyAccessEvent[];
  onReview: (e: EmergencyAccessEvent) => void;
}) {
  if (!events.length) return <EmptyState title="No emergency access events" />;
  return (
    <Table caption="Emergency access events">
      <thead>
        <tr>
          <th>When</th>
          <th>Doctor</th>
          <th>Patient</th>
          <th>Stated reason</th>
          <th>Activity in window</th>
          <th>Review</th>
        </tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <td>
              {formatDateTime(e.createdAt)}
              <div className="muted">until {formatDateTime(e.expiresAt)}</div>
            </td>
            <td>
              <strong>{e.doctorName}</strong>
              {e.doctorSpecialty && <div className="muted">{e.doctorSpecialty}</div>}
            </td>
            <td>{e.patientName}</td>
            <td style={{ maxWidth: 280 }}>{e.reason}</td>
            <td>
              {e.recordViews} view(s)
              <div className="muted">{e.recordChanges} change(s)</div>
            </td>
            <td>
              {e.reviewedAt && e.reviewOutcome ? (
                <>
                  <Badge tone={OUTCOME_TONE[e.reviewOutcome]}>
                    {OUTCOME_LABEL[e.reviewOutcome]}
                  </Badge>
                  <div className="muted">
                    {e.reviewedBy ?? 'Reviewer'}, {formatDateTime(e.reviewedAt)}
                  </div>
                  {e.reviewNotes && <div>{e.reviewNotes}</div>}
                </>
              ) : (
                <div className="stack" style={{ gap: '0.4rem' }}>
                  <Badge tone="warning">Awaiting review</Badge>
                  <Button size="sm" onClick={() => onReview(e)}>
                    Review
                  </Button>
                </div>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function EmergencyReviewPage() {
  const [tab, setTab] = useState<Filter>('unreviewed');
  const [reviewing, setReviewing] = useState<EmergencyAccessEvent | null>(null);
  const q = useQuery({
    queryKey: ['emergency-access', tab],
    queryFn: () =>
      api<{ items: EmergencyAccessEvent[] }>('/emergency-access', { query: { status: tab } }),
  });
  const unreviewed = useQuery({
    queryKey: ['emergency-access', 'unreviewed'],
    queryFn: () =>
      api<{ items: EmergencyAccessEvent[] }>('/emergency-access', {
        query: { status: 'unreviewed' },
      }),
  });

  return (
    <>
      <PageHeader
        title="Emergency access review"
        subtitle="Retrospective review of break-glass access by doctors at your facility"
      />
      <Alert tone="info">
        Every emergency access must be reviewed. Check that a genuine emergency justified opening
        the record. Events not reviewed within 7 days appear as overdue to the Ministry. Detailed
        activity is available in the{' '}
        <Link to="/director/audit?action=patient.record.viewed">audit review</Link>.
      </Alert>
      <Card>
        <Tabs
          label="Emergency access filter"
          active={tab}
          onChange={setTab}
          tabs={[
            { id: 'unreviewed', label: 'Awaiting review', count: unreviewed.data?.items.length },
            { id: 'reviewed', label: 'Reviewed' },
            { id: 'all', label: 'All' },
          ]}
        />
        <TabPanel id={tab}>
          <QueryView query={q}>
            {(d) => <EventsTable events={d.items} onReview={setReviewing} />}
          </QueryView>
        </TabPanel>
      </Card>
      <Dialog
        open={reviewing !== null}
        onClose={() => setReviewing(null)}
        title="Review emergency access"
      >
        {reviewing && <ReviewDialog event={reviewing} onClose={() => setReviewing(null)} />}
      </Dialog>
    </>
  );
}
